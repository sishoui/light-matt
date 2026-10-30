/**
 * 单页控制界面（#8 开关 + #9 亮度 + #10 颜色 + #11 状态同步与回连
 * + #12 灯珠数量 + #13 隐藏日志面板与自检 + #25 分段静态灯效）。
 *
 * 页面只做 view model 与事件转发，所有 BLE 细节经 ControlSession。
 * 亮度滑块进 session 的 20Hz latest-wins 节流实例；色环拖动进另一条同节奏的
 * 段颜色闸门（写选中段的静态颜色）。
 *
 * #25：颜色不再有「整条单色」的概念，而是**每个灯珠区间一个静态颜色**。
 *  - 设备是权威：段列表由 QueryStrip(0x12) 读回（SegmentReport × N + ListEnd），
 *    连接建立后立即拉一次，不只依赖本地状态；
 *  - 新建区间走本地预检（整数、越界、重叠）+ 设备权威校验（InvalidParam）；
 *  - 重叠被设备拒绝时**不改本地列表**，只提示具体原因。
 *
 * #11：连接状态以设备为准。断线立即清空控件（不显示过期状态）；自动回连由
 * session 的 1s/2s/4s 退避负责；onShow 时静默回连（不打断扫描/手动连接）；
 * 回连成功后 transport 重新订阅 notify 并读 State，页面用新 State 全量刷新。
 *
 * 拆分的协作模块（本目录）：
 *  - view-model.ts：文案与滑块视图补丁（纯函数）；
 *  - wheel-view.ts：色环 canvas、几何与触摸换算；
 *  - segment-view.ts：分段编辑器的区间校验、槽位分配与行视图（纯函数）；
 *  - log-panel-view.ts：日志面板模型 + setData 合并计时器。
 * 本文件只保留状态持有与事件处理。
 */

import { errorText, eventText, resultText } from "../../utils/ble/errors";
import type { LogPanelRow } from "../../utils/ble/log-panel";
import {
  brightnessHintText,
  brightnessViewPatch,
  colorHintText,
  matchingPreset,
  powerLabelText,
} from "./view-model";
import {
  brightnessPercent as percentOf,
  clampBrightness,
  effectiveMaxBrightness,
} from "../../utils/control/brightness";
import {
  ControlSession,
  detectDevMode,
  detectPlatform,
  type CommandResult,
} from "../../utils/control/session";
import { statusView } from "../../utils/control/status-view";
import {
  createDefaultUsageLogger,
  type UsageLogSink,
} from "../../utils/usage";
import {
  ledCountResultHint,
  parseLedCountInput,
} from "../../utils/control/ledCount";
import {
  hsvForWheel,
  PRESETS,
  rgbToHex,
  rgbToHsv,
  segmentHueSatToRgb,
} from "../../utils/color/hsv";
import type {
  DeviceState,
  DiscoveredDevice,
  LinkState,
  RGB,
  SegmentConfig,
  SegmentReport,
  SegmentTarget,
} from "../../utils/protocol/types";
import {
  ANIMATION_MIN_PERIOD_MS,
  BREATHING_MIN_PERIOD_MS,
  MAX_PERIOD_MS,
  MAX_SCRIPTS,
  MAX_SEGMENTS,
  MAX_STAGES,
  SEGMENT_TYPE,
  WAVEFORM,
  WAVEFORM_NAMES,
} from "../../utils/protocol/constants";
import {
  breathingFlags,
  directionFlags,
  segmentReverse,
} from "../../utils/protocol/commands";
import { LogPanelView } from "./log-panel-view";
import {
  activeCount,
  breathingLabel,
  buildSegmentRows,
  cometLabel,
  firstFreeSegId,
  overlapError,
  parseRangeInput,
  rainbowLabel,
  spanText,
  tailText,
  waveformName,
  type SegmentRow,
} from "./segment-view";
import { COLOR_UI_INTERVAL_MS, WheelView } from "./wheel-view";
import {
  addStage,
  buildScriptStageRows,
  createScriptDraft,
  draftInvalidStageCount,
  draftToScriptConfig,
  downloadProgressText,
  playbackView,
  removeStage,
  removeStageSegment,
  setStageDuration,
  setStageSegments,
  upsertStageSegment,
  type ScriptDraft,
  type ScriptStageRow,
} from "./script-view";

/** 灯效模式：新段 / 当前编辑段用哪一类（#30 / #31 扩展）。 */
type SegmentMode = "static" | "breathing" | "rainbow" | "comet";

/** 模式的中文名（剧本编辑提示用；与选项表同源含义）。 */
const MODE_LABELS: Record<SegmentMode, string> = {
  static: "静态",
  breathing: "呼吸",
  rainbow: "彩虹",
  comet: "流光",
};

/** 模式切换后的提示文案（只影响下一次新建区间 / 参数区提示）。 */
const MODE_HINTS: Record<SegmentMode, string> = {
  static: "",
  breathing: "呼吸模式：划区间后即按下面的周期 / 波形 / 最暗亮度下发",
  rainbow: "彩虹模式：划区间后即按下面的周期 / 色相跨度 / 方向下发",
  comet: "流光模式：划区间后即按下面的周期 / 拖尾长度 / 方向下发",
};

/** 模块级单例：页面重入时复用同一条 BLE 会话。 */
let session: ControlSession | null = null;
/** 使用日志（#34）：未配置后端时为 null，控制路径完全不受影响。 */
let usageLogger: UsageLogSink | null = null;
let unsubscribers: Array<() => void> = [];

/** 首屏色环位置与暖白预设对齐（真值来自预设表，不另写一份）。 */
const INITIAL_HSV = rgbToHsv(PRESETS[0].rgb);

/** 新建区间时默认给一个递增的槽位（设备权威的 mask 会覆盖这个猜测）。 */
const PRIMARY_STRIP_ID = 0;

Page({
  data: {
    // 连接状态条
    statusText: "未连接",
    statusSub: "点击选择设备",
    statusAction: "扫描",
    linkClass: "link-idle",
    ready: false,

    // 开关
    power: 0 as 0 | 1,
    powerBusy: false,
    powerLabel: "已关",

    // 亮度：滑块上限取设备 State.maxBrightness（不硬编码 255）
    brightness: 0, // 绑定到 slider value，只在松手 / 设备状态更新时改
    brightnessDisplay: 0, // 拖动过程中的实时读数（不写回 slider.value）
    brightnessPercent: 0,
    maxBrightness: 255,
    brightnessHintText: "连接后可调节",

    // 颜色（#10 / #25）：色相环 + 饱和度，写入**选中段**
    presetList: PRESETS,
    colorHex: PRESETS[0].hex,
    colorHue: INITIAL_HSV.h,
    colorSaturation: Math.round(INITIAL_HSV.s * 100), // 0-100，映射到 S = 0..1
    selectedPreset: PRESETS[0].name,
    colorHintText: "连接后可调节；颜色按灯珠区间下发",

    // 分段（#25）
    segmentRows: [] as SegmentRow[],
    selectedSegId: -1,
    segmentMaxCount: MAX_SEGMENTS,
    rangeStartInput: "",
    rangeEndInput: "",
    segmentHintText: "",
    segmentBusy: false,

    // 呼吸参数（#30）：选中呼吸段时显示。
    // period 是滑块值（毫秒）；0 = 静止，其余从 334 起（3Hz 下限）。
    // segmentMode 是新段 / 当前编辑段的灯效模式：静态单色 / 呼吸 / 彩虹 / 流光。
    segmentMode: "static" as SegmentMode,
    breathingVisible: false,
    breathingPeriod: 1000,
    breathingPeriodText: "1000ms",
    breathingMinLevel: 0,
    breathingMinLevelText: "0%",
    breathingWaveform: WAVEFORM.SINE as number,
    breathingWaveformName: WAVEFORM_NAMES[WAVEFORM.SINE],
    breathingBusy: false,
    breathingHintText: "",
    breathingMinPeriod: BREATHING_MIN_PERIOD_MS,
    breathingMaxPeriod: MAX_PERIOD_MS,
    // 波形选择器的展示项（索引 = 枚举值）
    waveformOptions: [
      { value: WAVEFORM.SINE, name: WAVEFORM_NAMES[WAVEFORM.SINE] },
      { value: WAVEFORM.TRIANGLE, name: WAVEFORM_NAMES[WAVEFORM.TRIANGLE] },
      { value: WAVEFORM.SAWTOOTH, name: WAVEFORM_NAMES[WAVEFORM.SAWTOOTH] },
      { value: WAVEFORM.SQUARE, name: WAVEFORM_NAMES[WAVEFORM.SQUARE] },
    ],

    // 彩虹 / 流光参数（#31）：选中这两类段时显示。
    // period 下限 200ms（5Hz，D5），0 = 静止。
    // animP5 是「按类型解释的同一个字段」：彩虹 = span、流光 = tail（0-255）。
    animVisible: false,
    animPeriod: 1200,
    animPeriodText: "1200ms",
    animSpan: 255,
    animSpanText: "整圈",
    animTail: 64,
    animTailText: "拖尾 25%",
    animReverse: false,
    animBusy: false,
    animHintText: "",
    animMinPeriod: ANIMATION_MIN_PERIOD_MS,
    animMaxPeriod: MAX_PERIOD_MS,
    // 模式选择器（四类灯效），点选即切换下一段的类型
    segmentModeOptions: [
      { mode: "static", name: "静态单色" },
      { mode: "breathing", name: "呼吸" },
      { mode: "rainbow", name: "彩虹" },
      { mode: "comet", name: "流光" },
    ],

    // 扫描 / 设备弹层
    sheetVisible: false,
    sheetMode: "scan" as "scan" | "device",
    devices: [] as DiscoveredDevice[],
    scanHint: "" as string,
    deviceName: "",
    deviceId: "",
    selfTestBusy: false,
    // #33 设备列表：「最近连过」来自本地缓存，「附近可用」来自实时扫描
    recentDevices: [] as Array<{ deviceId: string; name?: string; lastConnectedAt: number }>,
    switchBusy: false,

    // 隐藏协议日志面板（#13）：连点版本号 5 次开启
    logVisible: false,
    logPaused: false,
    logRows: [] as LogPanelRow[],
    logCount: 0,
    logHint: "",
    logScrollTarget: "",

    // 灯珠数量（#12）：只在设备弹层里出现，是设备级低频设置
    ledCount: 0, // 设备当前生效的数量；未连接时为 0
    ledCountInput: "", // 输入框内容（字符串，避免数字输入框的中间态被 setData 抹掉）
    ledCountHintText: "",
    ledCountBusy: false,

    /*
     * 剧本（#32）。草稿在本地（用户正在编，设备不知道），下发后设备是权威：
     * 播放状态、阶段号、loop 全部取自 State 字节 10-13。
     */
    scriptIdOptions: [0, 1, 2, 3],
    scriptId: 0,
    scriptStageRows: [] as ScriptStageRow[],
    scriptActiveStage: 0,
    scriptMaxStages: MAX_STAGES,
    scriptBusy: false,
    scriptHintText: "",
    /** 下发进度：0-100；-1 = 未在下发。 */
    scriptProgressPercent: -1,
    scriptProgressText: "",
    /** 设备侧旁证（ScriptProgress 0x86）：-1 = 还没收到。 */
    scriptDeviceFrames: -1,
    // 播放控制（#32）：以设备 State 为准。
    playbackText: "停止",
    playbackStageText: "无激活剧本",
    playbackState: 0,
    playbackLoop: true,
    playbackActive: false,
    playbackBusy: false,
    // 设备配置的灯带数（State 字节 8）；剧本下发按它声明 strip_count。
    stripCountValue: 1,

    version: "0.1.0",
  },

  /** canvas 上下文与几何：非响应式，放在页面实例上（不进 data）。 */
  wheelView: null as WheelView | null,
  /** onReady 之后才允许 onShow 重建 canvas（首次 onShow 早于首次布局）。 */
  pageReady: false,
  /** 亮度读数的上次 setData 时间（与取色共用 50ms 闸门）。 */
  lastBrightnessUiAt: 0,
  /** 隐藏日志面板控制器（页面实例持有；数据源是 session 的 FrameLog）。 */
  logView: null as LogPanelView | null,
  /** 设备权威的段列表原始数据（渲染用 data.segmentRows，这里是真值）。 */
  segmentReports: [] as SegmentReport[],
  /** 剧本草稿（#32）：页面实例持有，data.scriptStageRows 是它的派生视图。 */
  scriptDraft: null as ScriptDraft | null,

  onLoad() {
    const platform = detectPlatform();
    const devMode = detectDevMode();
    // #34：未配置后端时 createDefaultUsageLogger 返回 null，logger 静默关闭。
    usageLogger = createDefaultUsageLogger();
    session = new ControlSession({
      platform,
      devMode,
      ...(usageLogger !== null ? { usageLogger } : {}),
    });
    console.log(`[lumen] 平台 ${platform}，开发版日志 ${devMode ? "开启" : "关闭"}`);

    // 面板与 console 共用 session.log 这一份 FrameLog（同源，不复制、不重格式化）。
    this.logView = new LogPanelView(session.log, {
      setData: (patch) => this.setData(patch),
    });

    // #32：剧本草稿（4 个空阶段）。设备上已提交的剧本要 QueryScript 才看得到，
    // 但草稿是「用户正在编的一套」，两者不是同一件事，所以这里不预填。
    this.scriptDraft = createScriptDraft();
    this.syncScriptRows();

    this.wheelView = new WheelView(
      {
        setData: (patch) => this.setData(patch),
        isReady: () => this.data.ready,
        hasActiveSegment: () => this.activeTarget() !== null,
        activeSegmentRange: () => this.activeTarget(),
        queueColor: (rgb) => session?.queueColor(rgb, this.activeTarget() ?? undefined),
        commitColor: (rgb) => session?.commitColor(rgb, this.activeTarget() ?? undefined),
        notifySelectSegment: () => this.showSelectSegmentNotice(),
      },
      { hue: INITIAL_HSV.h, saturation: INITIAL_HSV.s },
    );

    unsubscribers = [
      session.onLink((state, detail) => {
        // 自动回连 / 首次连接都可能由 session 发起：页面没有主动 setData 设备名，
        // 这里从链路事件补上（ready 时 detail 带 deviceName）。
        if (state === "ready" && detail?.deviceName !== undefined) {
          this.setData({ deviceName: detail.deviceName });
        }
        this.applyLink(state, detail?.message);
        if (state === "ready") {
          // 设备是权威：连上后立刻拉一次段列表（protocol §10.1 第 2 步）。
          void this.refreshSegments();
        } else if (state === "idle" || state === "failed" || state === "adapter-off") {
          this.segmentReports = [];
          this.applySegmentRows(-1);
        }
      }),
      session.onDevices((devices) => {
        this.setData({ devices });
      }),
      session.onState((state) => this.applyDeviceState(state)),
      session.onScanHint((hint) => {
        this.setData({ scanHint: hint ?? "" });
      }),
      session.onDeviceEvent((code, detail) => {
        // Event 0x81（NVS 存储失败）发生在 ACK 之后：状态已生效，只是掉电可能丢。
        // 非阻塞轻提示，不回 ACK、不改控件（设备仍是权威）。
        const text = eventText(code, detail);
        if (text !== null) {
          wx.showToast({ title: text, icon: "none" });
        }
      }),
      // 新帧到达：只在面板可见且未暂停时合并刷新（暂停时冻结视图）。
      session.log.onAppend(() => this.logView?.onAppend()),
      /*
       * #32：设备侧 ScriptProgress(0x86) 是下发进度的**旁证**（每 8 帧一条），
       * 不进进度条（权威是小程序自己数的逐帧 ACK），只作为「设备确实收到了」
       * 的额外证据显示在提示里。
       */
      session.transport.onScriptProgress((scriptId, frames) => {
        if (scriptId !== this.scriptDraft?.scriptId) {
          return;
        }
        this.setData({ scriptDeviceFrames: frames });
      }),
    ];

    void session.boot();
  },

  onReady() {
    this.pageReady = true;
    this.initWheel();
  },

  onUnload() {
    for (const off of unsubscribers) {
      off();
    }
    unsubscribers = [];
    this.wheelView = null;
    this.logView?.destroy();
    this.logView = null;
    // 页面生命周期结束，彻底断开并反注册 wx.on*（避免回调串入）。
    session?.destroy();
    session = null;
    usageLogger = null;
  },

  onShow() {
    // #34：进前台补报本地待发记录（fire-and-forget，绝不影响 BLE）。
    usageLogger?.replay();
    // #11：进前台静默回连。session 自己在内部判断是否该回连，
    // 并保证不打断正在进行的扫描 / 手动连接（扫描中、连接中直接返回）。
    if (session !== null) {
      void session.onShow();
    }
    // 首次 onShow 早于 onReady（canvas 还没布局），交给 onReady 初始化；
    // 之后回到前台时 canvas 可能被回收，补一次绘制。
    if (!this.pageReady) {
      return;
    }
    if (this.wheelView === null || !this.wheelView.canDraw) {
      this.initWheel();
    } else {
      this.wheelView.redraw();
    }
  },

  // ---------------- 状态条与弹层 ----------------

  async onStatusTap() {
    if (session === null) {
      return;
    }
    const state = session.linkState;
    if (state === "ready") {
      const ledCount = session.deviceState?.ledCount ?? this.data.ledCount;
      this.setData({
        sheetVisible: true,
        sheetMode: "device",
        deviceId: session.transport.currentDeviceId ?? "",
        deviceName: this.data.deviceName || session.cachedDevice?.name || "",
        ledCount,
        // 打开弹层时输入框对齐设备当前值；用户改动后由 onLedCountInput 接管。
        ledCountInput: ledCount > 0 ? String(ledCount) : "",
        ledCountHintText: "",
      });
      return;
    }
    if (state === "connecting" || state === "initializing") {
      return; // 连接中不重复触发扫描
    }
    if (state === "scanning") {
      // 扫描中点状态条 = 停止扫描并关弹层。
      this.closeSheet();
      return;
    }
    // 退避耗尽 / 主动断开后的手动入口：
    // 有 deviceId 缓存时直接重连（最快路径），否则回扫描。
    // #33：上一次切换失败时，主按钮是「重试」，优先执行它。
    if (session.deviceSwitch.phase === "failed") {
      await this.onSwitchRetry();
      return;
    }
    const cached = session.cachedDevice;
    if (cached !== null && (state === "failed" || state === "idle")) {
      await this.manualReconnect();
      return;
    }
    this.openScanSheet();
  },

  /** 手动重连：复用缓存的 deviceId；成功后刷新全部控件（设备权威）。 */
  async manualReconnect() {
    if (session === null) {
      return;
    }
    const cached = session.cachedDevice;
    if (cached === null) {
      this.openScanSheet();
      return;
    }
    try {
      const state = await session.connect(cached.deviceId, cached.name);
      this.applyDeviceState(state);
      this.setData({ deviceName: cached.name ?? "", deviceId: cached.deviceId });
      void this.refreshSegments();
    } catch (err) {
      wx.showToast({ title: errorText(err), icon: "none" });
    }
  },

  openScanSheet() {
    // #33：先渲染本地「最近连过」，再开扫描补「附近可用」。
    // 后端不可达时列表照常可用——这里只读本地缓存，不碰网络。
    this.setData({
      sheetVisible: true,
      sheetMode: "scan",
      scanHint: "",
      recentDevices: session?.recentDevices ?? [],
    });
    void this.startScan();
  },

  closeSheet() {
    this.setData({ sheetVisible: false, devices: [] });
    if (session !== null && session.linkState === "scanning") {
      void session.stopScan();
    }
  },

  onSheetMaskTap() {
    this.closeSheet();
  },

  /** catchtap 占位，阻止弹层内部点击穿透到遮罩。 */
  noop() {
    /* 空实现 */
  },

  // ---------------- 灯珠数量（#12，只在设备弹层里） ----------------

  /**
   * 输入变化：只记原始文本，不在输入过程中改值或报错。
   * 校验与拒绝放在「应用」时做，避免用户删到一半就被红字打断。
   */
  onLedCountInput(e: WechatMiniprogram.Input) {
    this.setData({
      ledCountInput: String(e.detail.value ?? ""),
      ledCountHintText: "",
    });
  },

  /**
   * 应用新数量：
   *   1. 前端先校验（1-64、纯整数），非法直接拒绝且不改输入框里的旧值；
   *   2. 合法则发 SetLedCount，ACK 超时 3000ms（重建句柄慢）；
   *   3. 成功刷新 ledCount；失败保留旧值并提示具体原因（Busy / InternalError）。
   */
  async onApplyLedCount() {
    if (session === null || this.data.ledCountBusy || !this.data.ready) {
      return;
    }
    const parsed = parseLedCountInput(this.data.ledCountInput);
    if (!parsed.ok) {
      // 非法输入：明确拒绝，输入框恢复成设备当前生效值（旧值不被写坏）。
      this.setData({
        ledCountHintText: parsed.message,
        ledCountInput: this.data.ledCount > 0 ? String(this.data.ledCount) : "",
      });
      wx.showToast({ title: parsed.message, icon: "none" });
      return;
    }

    // 与当前数量相同：不发帧，也不打扰设备。
    if (parsed.value === this.data.ledCount) {
      this.setData({
        ledCountHintText: `当前已是 ${parsed.value} 颗`,
        ledCountInput: String(parsed.value),
      });
      return;
    }

    this.setData({ ledCountBusy: true, ledCountHintText: "正在应用…" });
    try {
      const result = await session.setLedCount(parsed.value);
      if (result.kind === "ok") {
        this.setData({
          ledCount: result.state.ledCount,
          ledCountInput: String(result.state.ledCount),
          ledCountHintText: `已设为 ${result.state.ledCount} 颗（已保存到设备）`,
        });
        // 数量变化可能让设备裁剪越界的段（§7.2）：以设备回报为准。
        void this.refreshSegments();
        return;
      }
      if (result.kind === "ack-error") {
        // Busy(0x05) 可稍后重试；InternalError(0x09) 表示重建失败、数量未变。
        const hint = ledCountResultHint(result.ack.resultCode) || "设置失败";
        this.setData({
          ledCountHintText: hint,
          ledCountInput: this.data.ledCount > 0 ? String(this.data.ledCount) : "",
        });
        wx.showToast({ title: hint, icon: "none" });
        return;
      }
      if (result.kind === "stale") {
        // #11：旧连接上飞行的 SetLedCount 晚到，回连后的 State 才是权威。
        // 不提示、不改本地值；下一次 State 同步会带回真实数量。
        this.setData({ ledCountHintText: "" });
        return;
      }
      // 传输层异常（超时 / 断线）：旧值保留，提示原因。
      this.setData({
        ledCountHintText: result.message,
        ledCountInput: this.data.ledCount > 0 ? String(this.data.ledCount) : "",
      });
      wx.showToast({ title: result.message, icon: "none" });
    } finally {
      this.setData({ ledCountBusy: false });
    }
  },

  async startScan() {
    if (session === null) {
      return;
    }
    try {
      await session.scan();
    } catch (err) {
      this.setData({ scanHint: errorText(err) });
    }
  },

  onRescan() {
    void this.startScan();
  },

  async onDeviceTap(e: WechatMiniprogram.TouchEvent) {
    if (session === null) {
      return;
    }
    const deviceId = String(e.currentTarget.dataset.deviceId ?? "");
    const name = String(e.currentTarget.dataset.name ?? "");
    if (!deviceId) {
      return;
    }
    // #33：已连着别的设备时，点列表 = 切换，不是再连一次。
    // 切换必须先断开（设备只允许 1 个连接），且失败时不自动回滚。
    const switching = session.linkState === "ready" && session.transport.currentDeviceId !== deviceId;
    if (switching) {
      await this.runSwitch(deviceId, name);
      return;
    }
    try {
      const state = await session.connect(deviceId, name);
      this.applyDeviceState(state);
      this.setData({ sheetVisible: false, deviceName: name, deviceId, switchBusy: false });
      // connect() 内发出 ready 时页面还没拿到设备名，这里补一次状态条。
      this.applyLink("ready");
      void this.refreshSegments();
    } catch (err) {
      this.setData({ scanHint: errorText(err) });
    }
  },

  /**
   * 执行一次设备切换（#33）。切换过程中显示加载态并禁用重复点击。
   *
   * 失败时停在「未连接」并把重试入口交给状态条，**不自动回滚**：
   * 上一台此时可能也不可用，来回拨号只会让用户不知道点哪个按钮。
   */
  async runSwitch(deviceId: string, name: string) {
    if (session === null) {
      return;
    }
    this.setData({ switchBusy: true, scanHint: "", sheetVisible: true, sheetMode: "device" });
    try {
      const state = await session.switchTo(deviceId, name);
      this.applyDeviceState(state);
      // 切换成功后设备级状态全部来自新设备，标题也换掉。
      this.setData({
        sheetVisible: false,
        switchBusy: false,
        deviceName: name,
        deviceId,
      });
      this.applyLink("ready");
    } catch (err) {
      // 停在未连接：清掉所有设备级显示，只留重试入口。
      const message = errorText(err);
      this.setData({
        switchBusy: false,
        deviceName: name,
        deviceId,
        scanHint: message,
        power: 0,
        powerLabel: "已关",
        brightness: 0,
        brightnessDisplay: 0,
        brightnessPercent: 0,
        brightnessHintText: "连接后可调节",
        colorHintText: "连接后可选色",
        selectedPreset: "",
        ledCount: 0,
        ledCountInput: "",
        ledCountHintText: "",
      });
      this.applySwitchFailure(message);
    }
  },

  /** 重试上一次失败的切换（目标沿用失败时的那台）。 */
  async onSwitchRetry() {
    if (session === null) {
      return;
    }
    const target = session.deviceSwitch.target;
    if (target === null) {
      this.openScanSheet();
      return;
    }
    await this.runSwitch(target.deviceId, target.name ?? "");
  },

  async onDisconnect() {
    if (session === null) {
      return;
    }
    await session.disconnect();
    this.segmentReports = [];
    this.setData({
      sheetVisible: false,
      deviceName: "",
      deviceId: "",
      power: 0,
      powerLabel: "已关",
      brightness: 0,
      brightnessDisplay: 0,
      brightnessPercent: 0,
      brightnessHintText: "连接后可调节",
      colorHintText: "连接后可调节；颜色按灯珠区间下发",
      selectedPreset: "",
      ledCount: 0,
      ledCountInput: "",
      ledCountHintText: "",
      segmentRows: [],
      selectedSegId: -1,
      rangeStartInput: "",
      rangeEndInput: "",
      segmentHintText: "",
    });
  },

  // ---------------- 自检（#13） ----------------

  /**
   * 自检：设备按 红→绿→蓝→白 各 500ms 临时覆盖灯带，2s 后自动恢复。
   * 放在设备弹层里，不占主控制流；自检不改设备状态，因此不刷新本地 UI。
   */
  async onSelfTest() {
    if (session === null || !this.data.ready || this.data.selfTestBusy) {
      return;
    }
    this.setData({ selfTestBusy: true });
    try {
      const result = await session.selfTest();
      if (result.kind === "ok") {
        wx.showToast({ title: "自检：红 → 绿 → 蓝 → 白", icon: "none" });
      } else if (result.kind === "ack-error") {
        wx.showToast({
          title: `自检失败：${resultText(result.ack.resultCode)}`,
          icon: "none",
        });
      } else if (result.kind === "stale") {
        // #11：旧连接上飞行的 SelfTest 晚到。自检只是设备侧的一次性动作，
        // 新连接上没有可回滚的状态，什么都不提示即可。
      } else {
        wx.showToast({ title: result.message, icon: "none" });
      }
    } finally {
      this.setData({ selfTestBusy: false });
    }
  },

  // ---------------- 隐藏协议日志面板（#13） ----------------

  /** 版本号点击：2s 窗口内第 5 次切换面板可见性（spec §10）。 */
  onVersionTap() {
    this.logView?.onVersionTap(Date.now());
  },

  /** 暂停 = 冻结视图但继续记录（理由见 log-panel.ts）。 */
  onLogPauseTap() {
    this.logView?.onPauseTap();
  },

  onLogClearTap() {
    this.logView?.onClearTap();
  },

  /** 复制当前视图：暂停时复制冻结的那一段，否则复制整个环形缓冲。 */
  onLogCopyTap() {
    this.logView?.onCopyTap();
  },

  onLogCloseTap() {
    this.logView?.onCloseTap();
  },

  // ---------------- 开关 ----------------

  async onTogglePower() {
    if (session === null || !this.data.ready || this.data.powerBusy) {
      return;
    }
    const next = this.data.power === 1 ? 0 : 1;
    this.setData({ powerBusy: true });
    try {
      const result = await session.setPower(next === 1);
      this.applyCommandResult(result);
    } finally {
      this.setData({ powerBusy: false });
    }
  },

  // ---------------- 亮度（#9） ----------------

  /**
   * 拖动中（连续量）：只更新本地显示，交给 session 的 20Hz latest-wins。
   * 这是「跟手」的关键——不在这里等任何回包。
   */
  onBrightnessChanging(e: WechatMiniprogram.SliderChanging) {
    const value = Number(e.detail.value);
    if (!Number.isFinite(value)) {
      return;
    }
    // 拖动中只刷新读数，不回写 slider.value：原生滑块自己的拇指已经跟手，
    // 这时改 value 反而可能造成回跳。控制值走 session 的 20Hz 节流。
    //
    // 读数本身也按 50ms 闸门节流：原生滑块 bindchanging 可到 60Hz，
    // 每帧 setData 三个字段在真机上比颜色拖动更容易卡（颜色拖动已有同一闸门）。
    const now = Date.now();
    if (now - this.lastBrightnessUiAt >= COLOR_UI_INTERVAL_MS) {
      this.lastBrightnessUiAt = now;
      this.setBrightnessView(value, false);
    }
    session?.queueBrightness(value);
  },

  /**
   * 松手（一次最终确认）：同一值再推一次并 flush。
   * 不重传旧值——节流层只保留最新值，flush 只是把最小间隔提前。
   */
  onBrightnessChange(e: WechatMiniprogram.SliderChange) {
    const value = Number(e.detail.value);
    if (!Number.isFinite(value)) {
      return;
    }
    this.setBrightnessView(value, true);
    session?.commitBrightness(value);
  },

  // ---------------- 颜色（#10 / #25，写入选中段） ----------------

  /** 取画布节点与尺寸，按 dpr 建上下文并画一次色相环。 */
  initWheel() {
    const view = this.wheelView;
    if (view === null) {
      return;
    }
    const query = wx.createSelectorQuery();
    query
      .select("#color-wheel")
      .fields({ node: true, size: true })
      .exec((res: any[]) => {
        const node = res?.[0]?.node as WechatMiniprogram.Canvas | undefined;
        const width = Number(res?.[0]?.width ?? 0);
        view.attach(node ?? null, width, this.pixelRatio());
      });
  },

  /** 设备像素比；取不到按 2（宁可放大，不可模糊）。 */
  pixelRatio(): number {
    try {
      const info = wx.getWindowInfo?.() ?? wx.getSystemInfoSync();
      const ratio = Number((info as { pixelRatio?: number }).pixelRatio ?? 2);
      return Number.isFinite(ratio) && ratio > 0 ? ratio : 2;
    } catch {
      return 2;
    }
  },

  /** 整块重画色环与选中点（首次绘制 / 页面回前台 / 状态同步时用）。 */
  redrawWheel() {
    this.wheelView?.redraw();
  },

  /** touchstart / touchmove 共用：把触摸点换算成色相并下发（20Hz 节流在 session）。 */
  handleWheelTouch(e: WechatMiniprogram.TouchCanvas) {
    this.wheelView?.handleTouch(e);
  },

  onWheelTouchStart(e: WechatMiniprogram.TouchCanvas) {
    this.handleWheelTouch(e);
  },

  onWheelTouchMove(e: WechatMiniprogram.TouchCanvas) {
    this.handleWheelTouch(e);
  },

  /** 松手：把当前颜色再推一次并 flush，保证最终颜色落地。 */
  onWheelTouchEnd() {
    this.wheelView?.commit();
  },

  onSaturationChanging(e: WechatMiniprogram.SliderChanging) {
    this.wheelView?.applySaturation(Number(e.detail.value), false);
  },

  onSaturationChange(e: WechatMiniprogram.SliderChange) {
    this.wheelView?.applySaturation(Number(e.detail.value), true);
  },

  /**
   * 预设点击（#25）：把选中段改成该预设色并等 ACK。
   *
   * 与色环拖动不同，这是**离散**操作：有明确的成功/失败反馈。
   * 没有选中段时提示先划区间，不发帧（不能让用户以为改成功了）。
   */
  async onPresetTap(e: WechatMiniprogram.TouchEvent) {
    if (session === null || !this.data.ready) {
      return;
    }
    const index = Number(e.currentTarget.dataset.index ?? -1);
    const preset = PRESETS[index];
    if (preset === undefined) {
      return;
    }
    const target = this.activeTarget();
    if (target === null) {
      this.showSelectSegmentNotice();
      return;
    }
    const result = await session.applyPreset(preset.rgb, target);
    if (result.kind === "ok") {
      /* 设备已接受：本地只更新色环与展示，段列表以刷新后的设备回报为准。 */
      const hsv = this.wheelView?.assign(preset.rgb) ?? hsvForWheel(preset.rgb, INITIAL_HSV.h);
      this.setData({
        colorHex: preset.hex,
        colorHue: hsv.h,
        colorSaturation: Math.round(hsv.s * 100),
        selectedPreset: preset.name,
        colorHintText: colorHintText(true, target),
      });
      this.redrawWheel();
      void this.refreshSegments();
      return;
    }
    if (result.kind === "ack-error") {
      wx.showToast({
        title: `预设被拒：${resultText(result.ack.resultCode)}`,
        icon: "none",
      });
      return;
    }
    if (result.kind === "stale") {
      return;
    }
    wx.showToast({ title: result.message, icon: "none" });
  },

  // ---------------- 分段编辑器（#25） ----------------

  onRangeStartInput(e: WechatMiniprogram.Input) {
    this.setData({ rangeStartInput: String(e.detail.value ?? ""), segmentHintText: "" });
  },

  onRangeEndInput(e: WechatMiniprogram.Input) {
    this.setData({ rangeEndInput: String(e.detail.value ?? ""), segmentHintText: "" });
  },

  /** 点选某一行：把颜色控件（与呼吸参数区）切到该段。 */
  onSegmentTap(e: WechatMiniprogram.TouchEvent) {
    const segId = Number(e.currentTarget.dataset.segId ?? -1);
    const report = this.segmentReports.find((item) => item.segId === segId);
    if (report === undefined) {
      return;
    }
    this.applySegmentRows(segId);
    const rgb = segmentHueSatToRgb(report.hue, report.sat);
    const hsv = this.wheelView?.assign(rgb) ?? hsvForWheel(rgb, INITIAL_HSV.h);
    const target: SegmentTarget = {
      stripId: PRIMARY_STRIP_ID,
      segId: report.segId,
      start: report.start,
      end: report.end,
    };
    this.setData({
      colorHex: rgbToHex(rgb),
      colorHue: hsv.h,
      colorSaturation: Math.round(hsv.s * 100),
      selectedPreset: matchingPreset(rgb),
      colorHintText: colorHintText(true, target),
    });
    this.redrawWheel();
  },

  /**
   * 新建 / 更新一个区间（#25 的核心操作）。
   *
   * 校验顺序（本地预检 → 设备权威）：
   *   1. 区间输入（整数、start ≤ end、end < ledCount）；
   *   2. 与已有段不重叠（本地即时反馈，给具体冲突段）；
   *   3. 分配槽位（有空闲用空闲，否则替换当前选中段——不静默覆盖别的段）；
   *   4. 下发 SetSegment，等 ACK；InvalidParam 时**不改本地列表**并提示原因。
   */
  async onApplyRange() {
    if (session === null || this.data.segmentBusy || !this.data.ready) {
      return;
    }
    const ledCount = this.data.ledCount;
    const parsed = parseRangeInput(this.data.rangeStartInput, this.data.rangeEndInput, ledCount);
    if (!parsed.ok) {
      this.setData({ segmentHintText: parsed.message });
      wx.showToast({ title: parsed.message, icon: "none" });
      return;
    }

    /* 改当前选中段时要忽略它自己的旧区间（同 seg_id 视为替换自身）。 */
    const selected = this.data.selectedSegId;
    const conflict = overlapError(
      parsed.start,
      parsed.end,
      this.segmentReports.map((r) => ({ segId: r.segId, start: r.start, end: r.end })),
      selected >= 0 ? selected : -1,
    );
    if (conflict !== null) {
      this.setData({ segmentHintText: `与其它段冲突：${conflict}（区间不能重叠）` });
      wx.showToast({ title: conflict, icon: "none" });
      return;
    }

    /*
     * 槽位分配：有选中段就用它（改区间 = 替换自身），否则取第一个空闲槽位。
     * 绝不静默覆盖其它已存在的段。
     */
    let segId: number;
    if (selected >= 0) {
      segId = selected;
    } else {
      const used = this.segmentReports.map((r) => r.segId);
      const free = firstFreeSegId(used);
      if (free < 0) {
        /* 8 段已满：明确拒绝，不静默覆盖别人的段。 */
        const message = `最多 ${MAX_SEGMENTS} 段，请先删除一段`;
        this.setData({ segmentHintText: message });
        wx.showToast({ title: message, icon: "none" });
        return;
      }
      segId = free;
    }

    /* 新段用当前色环颜色。 */
    const rgb = this.wheelView?.rgb() ?? PRESETS[0].rgb;
    const target: SegmentTarget = {
      stripId: PRIMARY_STRIP_ID,
      segId,
      start: parsed.start,
      end: parsed.end,
    };

    this.setData({ segmentBusy: true, segmentHintText: "正在下发…" });
    try {
      if (session === null) {
        return;
      }
      /* 模式决定下发哪一类段（#30 / #31）：静态 / 呼吸 / 彩虹 / 流光。 */
      const result = await this.sendModeSegment(target, rgb, this.data.segmentMode);
      if (result.kind === "ok") {
        this.setData({
          segmentHintText: `段 ${segId} 已生效：灯珠 ${parsed.start}-${parsed.end}`,
          rangeStartInput: "",
          rangeEndInput: "",
        });
        session.setActiveSegment(target);
        await this.refreshSegments(segId);
        return;
      }
      if (result.kind === "ack-error") {
        /* 设备拒绝（重叠 / 越界 / 类型不支持）：不改本地列表，说清原因。 */
        const message = segmentRejectHint(result.ack.resultCode);
        this.setData({ segmentHintText: message });
        wx.showToast({ title: message, icon: "none" });
        return;
      }
      if (result.kind === "stale") {
        this.setData({ segmentHintText: "" });
        return;
      }
      this.setData({ segmentHintText: result.message });
      wx.showToast({ title: result.message, icon: "none" });
    } finally {
      this.setData({ segmentBusy: false });
    }
  },

  /**
   * 按模式下发一个段（#31 把这段分派从「呼吸 or 静态」的二选一扩成四选一）。
   *
   * 只做分派，参数取 data 里对应模式的滑块值；错误分诊由调用方统一做。
   */
  async sendModeSegment(
    target: SegmentTarget,
    rgb: RGB,
    mode: SegmentMode,
  ): Promise<Awaited<ReturnType<ControlSession["setSegmentColor"]>>> {
    if (session === null) {
      return { kind: "error", message: "设备未连接" };
    }
    switch (mode) {
      case "breathing":
        return session.setSegmentBreathing(
          target,
          rgb,
          this.data.breathingPeriod,
          this.data.breathingMinLevel,
          this.data.breathingWaveform,
        );
      case "rainbow":
        return session.setSegmentRainbow(
          target,
          rgb,
          this.data.animPeriod,
          this.data.animSpan,
          this.data.animReverse,
        );
      case "comet":
        return session.setSegmentComet(
          target,
          rgb,
          this.data.animPeriod,
          this.data.animTail,
          this.data.animReverse,
        );
      default:
        return session.setSegmentColor(target, rgb);
    }
  },

  /** 删除某段（ClearSegment 0x11）：该段的灯珠归入未覆盖区（熄灭）。 */
  async onSegmentDelete(e: WechatMiniprogram.TouchEvent) {
    if (session === null || this.data.segmentBusy || !this.data.ready) {
      return;
    }
    const segId = Number(e.currentTarget.dataset.segId ?? -1);
    if (segId < 0) {
      return;
    }
    this.setData({ segmentBusy: true, segmentHintText: "正在删除…" });
    try {
      const ack = await session.clearSegment(segId);
      if (!ack.ok) {
        const message = `删除失败：${resultText(ack.resultCode)}`;
        this.setData({ segmentHintText: message });
        wx.showToast({ title: message, icon: "none" });
        return;
      }
      this.setData({ segmentHintText: `段 ${segId} 已删除（其灯珠熄灭）` });
      await this.refreshSegments(this.data.selectedSegId === segId ? -1 : this.data.selectedSegId);
    } catch (err) {
      const message = errorText(err);
      this.setData({ segmentHintText: message });
      wx.showToast({ title: message, icon: "none" });
    } finally {
      this.setData({ segmentBusy: false });
    }
  },

  /** 手动重新拉取段列表（设备权威）；失败保留现有列表并提示。 */
  async onRefreshSegments() {
    await this.refreshSegments(this.data.selectedSegId >= 0 ? this.data.selectedSegId : -1);
  },

  // ---------------- 灯效模式（#30 呼吸 / #31 彩虹·流光） ----------------

  /**
   * 切换「新段灯效模式」：静态 / 呼吸 / 彩虹 / 流光（#31 从二选一扩成四选一）。
   *
   * 只影响下一次「新建区间」下发哪种类型；已有段要改类型就选中它、
   * 切模式再点参数区的「应用到选中段」。
   */
  onSegmentModeTap(e: WechatMiniprogram.TouchEvent) {
    const raw = String(e.currentTarget.dataset.mode ?? "static");
    const mode: SegmentMode =
      raw === "breathing" || raw === "rainbow" || raw === "comet" ? raw : "static";
    this.setData({
      segmentMode: mode,
      breathingVisible: mode === "breathing",
      animVisible: mode === "rainbow" || mode === "comet",
      segmentHintText: MODE_HINTS[mode],
    });
  },

  /**
   * 周期滑块（拖动中，仅更新读数，不发帧）。
   *
   * 滑块值 0 表示「静止」；其它值一律钳到 334ms 以上（3Hz 下限）。
   * 拖动中不发 SetSegment：呼吸参数是绝对值，松手才提交，避免 20Hz 级
   * 写入把 BLE 写队列塞满（连续量只有色环走节流通道）。
   */
  onBreathingPeriodChanging(e: WechatMiniprogram.SliderChange) {
    const raw = Number(e.detail.value ?? 0);
    const period = raw === 0 ? 0 : Math.max(raw, BREATHING_MIN_PERIOD_MS);
    this.setData({
      breathingPeriod: period,
      breathingPeriodText: period === 0 ? "静止" : `${period}ms`,
      breathingHintText:
        raw !== 0 && raw < BREATHING_MIN_PERIOD_MS
          ? `周期下限 ${BREATHING_MIN_PERIOD_MS}ms（约 3Hz）`
          : "",
    });
  },

  /** 周期滑块松手：提交呼吸段。 */
  async onBreathingPeriodChange(e: WechatMiniprogram.SliderChange) {
    const raw = Number(e.detail.value ?? 0);
    const period = raw === 0 ? 0 : Math.max(raw, BREATHING_MIN_PERIOD_MS);
    this.setData({
      breathingPeriod: period,
      breathingPeriodText: period === 0 ? "静止" : `${period}ms`,
    });
    await this.applyBreathing();
  },

  /** 最暗亮度滑块（0-255）：拖动中仅显示百分比。 */
  onBreathingMinLevelChanging(e: WechatMiniprogram.SliderChange) {
    const value = clampByte(Number(e.detail.value ?? 0));
    this.setData({
      breathingMinLevel: value,
      breathingMinLevelText: percentText(value),
    });
  },

  /** 最暗亮度滑块松手：提交。 */
  async onBreathingMinLevelChange(e: WechatMiniprogram.SliderChange) {
    const value = clampByte(Number(e.detail.value ?? 0));
    this.setData({
      breathingMinLevel: value,
      breathingMinLevelText: percentText(value),
    });
    await this.applyBreathing();
  },

  /** 波形选择：0 正弦 / 1 三角 / 2 锯齿 / 3 方波，点选即提交。 */
  async onBreathingWaveformTap(e: WechatMiniprogram.TouchEvent) {
    const value = Number(e.currentTarget.dataset.value ?? WAVEFORM.SINE);
    if (value < 0 || value > 3) {
      return;
    }
    this.setData({
      breathingWaveform: value,
      breathingWaveformName: WAVEFORM_NAMES[value],
    });
    await this.applyBreathing();
  },

  /**
   * 把当前选中段改成呼吸（或更新它的呼吸参数）：SetSegment type=0x01。
   *
   * 语义与颜色一致：设备是权威，成功后重新 QueryStrip 拉回并重建行视图；
   * 被拒（InvalidParam）时**不改本地列表**，提示原因。
   * 基准色用色环当前 RGB —— 呼吸只是在那个色上脉冲。
   */
  async applyBreathing() {
    if (session === null || this.data.breathingBusy || !this.data.ready) {
      return;
    }
    const target = this.activeTarget();
    if (target === null) {
      wx.showToast({ title: "先选择或新建一个灯珠区间", icon: "none" });
      return;
    }
    const rgb = this.wheelView?.rgb() ?? PRESETS[0].rgb;
    this.setData({ breathingBusy: true, breathingHintText: "正在下发…" });
    try {
      const result = await session.setSegmentBreathing(
        target,
        rgb,
        this.data.breathingPeriod,
        this.data.breathingMinLevel,
        this.data.breathingWaveform,
      );
      if (result.kind === "ok") {
        this.setData({
          breathingHintText: `已切换为呼吸：${this.data.breathingPeriod === 0 ? "静止" : `${this.data.breathingPeriod}ms`} · ${WAVEFORM_NAMES[this.data.breathingWaveform]}`,
        });
        await this.refreshSegments(target.segId);
        return;
      }
      if (result.kind === "ack-error") {
        const message = segmentRejectHint(result.ack.resultCode);
        this.setData({ breathingHintText: message });
        wx.showToast({ title: message, icon: "none" });
        return;
      }
      if (result.kind === "stale") {
        this.setData({ breathingHintText: "" });
        return;
      }
      this.setData({ breathingHintText: result.message });
      wx.showToast({ title: result.message, icon: "none" });
    } finally {
      this.setData({ breathingBusy: false });
    }
  },

  // ---------------- 彩虹 / 流光参数（#31） ----------------

  /**
   * 动画类周期滑块（拖动中，仅更新读数，不发帧）。
   *
   * 与呼吸同一条规矩：0 = 静止，其余钳到 200ms 以上（5Hz 下限，D5）。
   * 松手才提交，避免拖动期间连续写 BLE。
   */
  onAnimPeriodChanging(e: WechatMiniprogram.SliderChange) {
    const raw = Number(e.detail.value ?? 0);
    const period = raw === 0 ? 0 : Math.max(raw, ANIMATION_MIN_PERIOD_MS);
    this.setData({
      animPeriod: period,
      animPeriodText: period === 0 ? "静止" : `${period}ms`,
      animHintText:
        raw !== 0 && raw < ANIMATION_MIN_PERIOD_MS
          ? `周期下限 ${ANIMATION_MIN_PERIOD_MS}ms（5Hz）`
          : "",
    });
  },

  /** 周期滑块松手：提交当前选中段（按它现在的类型）。 */
  async onAnimPeriodChange(e: WechatMiniprogram.SliderChange) {
    const raw = Number(e.detail.value ?? 0);
    const period = raw === 0 ? 0 : Math.max(raw, ANIMATION_MIN_PERIOD_MS);
    this.setData({
      animPeriod: period,
      animPeriodText: period === 0 ? "静止" : `${period}ms`,
    });
    await this.applyAnimation();
  },

  /**
   * span（彩虹）滑块：0 = 整条同色、255 = 铺满整圈。
   * 拖动中只更新读数，松手提交。
   */
  onAnimSpanChanging(e: WechatMiniprogram.SliderChange) {
    const span = clampByte(Number(e.detail.value ?? 0));
    this.setData({ animSpan: span, animSpanText: spanText(span) });
  },

  async onAnimSpanChange(e: WechatMiniprogram.SliderChange) {
    const span = clampByte(Number(e.detail.value ?? 0));
    this.setData({ animSpan: span, animSpanText: spanText(span) });
    await this.applyAnimation();
  },

  /**
   * tail（流光）滑块：0 = 硬边无尾、255 = 整条都是尾。
   * 拖动中只更新读数，松手提交。
   */
  onAnimTailChanging(e: WechatMiniprogram.SliderChange) {
    const tail = clampByte(Number(e.detail.value ?? 0));
    this.setData({ animTail: tail, animTailText: tailText(tail) });
  },

  async onAnimTailChange(e: WechatMiniprogram.SliderChange) {
    const tail = clampByte(Number(e.detail.value ?? 0));
    this.setData({ animTail: tail, animTailText: tailText(tail) });
    await this.applyAnimation();
  },

  /** 方向开关：彩虹 = 色相递减；流光 = 反向移动。点选即提交。 */
  async onAnimReverseTap(e: WechatMiniprogram.TouchEvent) {
    const value = Number(e.currentTarget.dataset.value ?? 0) !== 0;
    this.setData({ animReverse: value });
    await this.applyAnimation();
  },

  /**
   * 把当前选中段按 `animKind` 重写为彩虹或流光：SetSegment type=0x02 / 0x03。
   *
   * 与呼吸同一条语义：设备是权威，成功后重新 QueryStrip 拉回并重建行视图；
   * 被拒（InvalidParam：周期过短 / 保留位 / 重叠）时**不改本地列表**。
   * 基准色用色环当前 RGB —— 彩虹的全部色相由它平移，流光就是亮点的颜色。
   */
  async applyAnimation(animKind?: "rainbow" | "comet") {
    if (session === null || this.data.animBusy || !this.data.ready) {
      return;
    }
    const target = this.activeTarget();
    if (target === null) {
      wx.showToast({ title: "先选择或新建一个灯珠区间", icon: "none" });
      return;
    }
    /* 不传 animKind 时按当前模式决定；模式不是这两类就按「彩虹」处理，
     * 因为只有这两类会显示参数区（按钮也只在那里出现）。 */
    const kind =
      animKind ?? (this.data.segmentMode === "comet" ? "comet" : "rainbow");
    const rgb = this.wheelView?.rgb() ?? PRESETS[0].rgb;
    this.setData({ animBusy: true, animHintText: "正在下发…" });
    try {
      const result =
        kind === "comet"
          ? await session.setSegmentComet(
              target,
              rgb,
              this.data.animPeriod,
              this.data.animTail,
              this.data.animReverse,
            )
          : await session.setSegmentRainbow(
              target,
              rgb,
              this.data.animPeriod,
              this.data.animSpan,
              this.data.animReverse,
            );
      if (result.kind === "ok") {
        const text =
          kind === "comet"
            ? `已切换为流光：${this.data.animPeriod === 0 ? "静止" : `${this.data.animPeriod}ms`} · ${tailText(this.data.animTail)}`
            : `已切换为彩虹：${this.data.animPeriod === 0 ? "静止" : `${this.data.animPeriod}ms`} · span ${spanText(this.data.animSpan)}`;
        this.setData({ animHintText: text, segmentMode: kind });
        await this.refreshSegments(target.segId);
        return;
      }
      if (result.kind === "ack-error") {
        const message = segmentRejectHint(result.ack.resultCode);
        this.setData({ animHintText: message });
        wx.showToast({ title: message, icon: "none" });
        return;
      }
      if (result.kind === "stale") {
        this.setData({ animHintText: "" });
        return;
      }
      this.setData({ animHintText: result.message });
      wx.showToast({ title: result.message, icon: "none" });
    } finally {
      this.setData({ animBusy: false });
    }
  },

  /**
   * 从设备拉取段列表（QueryStrip）并重建行视图。
   *
   * keepSegId >= 0 时保持该段选中；段已不存在则清空选择。
   * session 层已经把 stale / 传输异常区分好，这里只负责 UI 回写。
   */
  async refreshSegments(keepSegId?: number): Promise<void> {
    if (session === null || !this.data.ready) {
      return;
    }
    const result = await session.queryStrip(PRIMARY_STRIP_ID);
    if (result.kind !== "ok") {
      if (result.kind === "ack-error") {
        wx.showToast({
          title: `读取分段失败：${resultText(result.ack.resultCode)}`,
          icon: "none",
        });
      } else if (result.kind === "error") {
        this.setData({ segmentHintText: result.message });
      }
      return;
    }
    this.segmentReports = result.reports;
    const current = keepSegId !== undefined ? keepSegId : this.data.selectedSegId;
    const stillThere = result.reports.some((r) => r.segId === current);
    this.applySegmentRows(stillThere ? current : -1);
  },

  /**
   * 统一写行视图 + 选中态 + 颜色控件目标（设备权威的数据）。
   *
   * #30：选中呼吸段时同时刷新呼吸参数区（周期 / 最暗亮度 / 波形），
   * 选中静态段或没有段时隐藏该区。颜色控件对四种类型都可用（都有
   * hue+sat 基准色），但只有呼吸段显示波形等专属参数。
   */
  applySegmentRows(segId: number) {
    const rows = buildSegmentRows(this.segmentReports, segId >= 0 ? segId : null, segmentHueSatToRgb);
    const report = this.segmentReports.find((item) => item.segId === segId);
    const activeTarget: SegmentTarget | null =
      report === undefined
        ? null
        : {
            stripId: PRIMARY_STRIP_ID,
            segId: report.segId,
            start: report.start,
            end: report.end,
          };
    session?.setActiveSegment(activeTarget);

    const patch: Record<string, unknown> = {
      segmentRows: rows,
      selectedSegId: activeTarget === null ? -1 : activeTarget.segId,
      colorHintText: colorHintText(this.data.ready, activeTarget),
      segmentHintText:
        rows.length === 0
          ? "还没有段。输入起点与终点，再点「新建区间」"
          : `共 ${activeCount(rows)} / ${MAX_SEGMENTS} 段`,
    };
    if (report !== undefined && report.type === SEGMENT_TYPE.BREATHING) {
      const period = report.periodMs;
      patch.segmentMode = "breathing";
      patch.breathingVisible = true;
      patch.animVisible = false;
      patch.breathingPeriod = period;
      patch.breathingPeriodText = period === 0 ? "静止" : `${period}ms`;
      patch.breathingMinLevel = report.p5;
      patch.breathingMinLevelText = percentText(report.p5);
      patch.breathingWaveform = breathingWaveformOf(report.flags);
      patch.breathingWaveformName = waveformName(report.flags);
      patch.breathingHintText = breathingLabel(report);
      patch.animHintText = "";
    } else if (
      report !== undefined &&
      (report.type === SEGMENT_TYPE.RAINBOW || report.type === SEGMENT_TYPE.COMET)
    ) {
      /* #31：选中彩虹 / 流光段时把参数区回填成设备上的真实值（设备权威）。 */
      const isComet = report.type === SEGMENT_TYPE.COMET;
      patch.segmentMode = isComet ? "comet" : "rainbow";
      patch.breathingVisible = false;
      patch.breathingHintText = "";
      patch.animVisible = true;
      patch.animPeriod = report.periodMs;
      patch.animPeriodText = report.periodMs === 0 ? "静止" : `${report.periodMs}ms`;
      patch.animSpan = isComet ? 255 : report.p5;
      patch.animSpanText = spanText(isComet ? 255 : report.p5);
      patch.animTail = isComet ? report.p5 : 64;
      patch.animTailText = tailText(isComet ? report.p5 : 64);
      patch.animReverse = segmentReverse(report.flags);
      patch.animHintText = isComet ? cometLabel(report) : rainbowLabel(report);
    } else {
      patch.segmentMode = "static";
      patch.breathingVisible = false;
      patch.animVisible = false;
      /* 新建区间时默认值：1s、能暗到全黑、正弦（与 UI 初始值一致）。 */
      patch.breathingPeriod = 1000;
      patch.breathingPeriodText = "1000ms";
      patch.breathingMinLevel = 0;
      patch.breathingMinLevelText = "0%";
      patch.breathingWaveform = WAVEFORM.SINE;
      patch.breathingWaveformName = WAVEFORM_NAMES[WAVEFORM.SINE];
      patch.breathingHintText = "";
      patch.animHintText = "";
    }
    this.setData(patch);
  },

  /** 当前选中段（颜色控件的目标），没有则为 null。 */
  activeTarget(): SegmentTarget | null {
    const segId = this.data.selectedSegId;
    if (segId < 0) {
      return null;
    }
    const report = this.segmentReports.find((item) => item.segId === segId);
    if (report === undefined) {
      return null;
    }
    return {
      stripId: PRIMARY_STRIP_ID,
      segId: report.segId,
      start: report.start,
      end: report.end,
    };
  },

  /** 颜色手势 / 预设在没有选中段时的统一提示。 */
  showSelectSegmentNotice() {
    wx.showToast({ title: "先在上方选择或新建一个灯珠区间", icon: "none" });
  },

  // ---------------- 内部 ----------------

  /**
   * 亮度只影响 brightness：power 位不动（亮度 0 视觉等于关灯，但设备仍是「开」）。
   * bindValue 为 false 时不回写 slider.value（拖动中由原生控件跟手）。
   */
  setBrightnessView(rawValue: number, bindValue: boolean) {
    this.setData(
      brightnessViewPatch(rawValue, this.data.maxBrightness, this.data.ready, bindValue),
    );
  },

  applyLink(state: LinkState, message?: string) {
    // #11：回连进行中 / 有 deviceId 缓存，决定副标题与动作（重连 vs 扫描）。
    const reconnectPending = session?.reconnectPending ?? false;
    const hasCachedDevice = (session?.cachedDevice ?? null) !== null;
    const view = statusView(state, this.data.deviceName, message, reconnectPending, hasCachedDevice);
    const ready = state === "ready";
    this.setData({
      ...view,
      ready,
      // ready 时提示文案要反映当前亮度（连接流水线先写 state 再置 ready）。
      brightnessHintText: ready
        ? brightnessHintText(this.data.brightness, true)
        : this.data.brightnessHintText,
      colorHintText: colorHintText(ready, this.activeTarget()),
    });
    if (state !== "ready" && state !== "initializing") {
      // 断线后不显示过期设备状态（设备是权威）。
      if (state === "idle" || state === "failed" || state === "adapter-off") {
        this.setData({
          power: 0,
          powerLabel: "已关",
          brightness: 0,
          brightnessDisplay: 0,
          brightnessPercent: 0,
          brightnessHintText: "连接后可调节",
          colorHintText: "连接后可调节；颜色按灯珠区间下发",
          selectedPreset: "",
          // 设备级值不能跨连接沿用：下一台设备的 max_brightness 可能不同。
          maxBrightness: effectiveMaxBrightness(undefined),
          ledCount: 0,
          ledCountInput: "",
          ledCountHintText: "",
          segmentRows: [],
          selectedSegId: -1,
          segmentHintText: "",
          breathingVisible: false,
          breathingHintText: "",
          animVisible: false,
          animHintText: "",
        });
      }
    }
  },

  /**
   * 切换失败：状态条停在「未连接」，主按钮变成「重试」（#33）。
   * 不自动回滚——回滚只会在两台都不可用时来回震荡。
   */
  applySwitchFailure(message: string) {
    this.setData({
      statusText: "切换失败",
      statusSub: message,
      statusAction: "重试",
      linkClass: "link-idle",
      ready: false,
      maxBrightness: effectiveMaxBrightness(undefined),
    });
  },

  // ---------------- 剧本（#32） ----------------

  /** 草稿变化后统一刷新派生视图（阶段行、按钮可用性）。 */
  syncScriptRows(patch: Record<string, unknown> = {}) {
    const draft = this.scriptDraft;
    if (draft === null) {
      return;
    }
    this.setData({
      scriptStageRows: buildScriptStageRows(draft, this.data.scriptActiveStage),
      scriptId: draft.scriptId,
      ...patch,
    });
  },

  /** 切换正在编辑的剧本编号（草稿里的 id，不影响设备）。 */
  onScriptIdTap(e: WechatMiniprogram.TouchEvent) {
    if (this.scriptDraft === null) {
      return;
    }
    const scriptId = Number(e.currentTarget.dataset.scriptId ?? -1);
    if (!Number.isInteger(scriptId) || scriptId < 0 || scriptId >= MAX_SCRIPTS) {
      return;
    }
    this.scriptDraft = { ...this.scriptDraft, scriptId };
    this.syncScriptRows({ scriptHintText: "" });
  },

  /** 点选某阶段：后续「把当前段加进剧本」就加到这里。 */
  onScriptStageTap(e: WechatMiniprogram.TouchEvent) {
    const index = Number(e.currentTarget.dataset.stage ?? -1);
    if (this.scriptDraft === null || index < 0 || index >= this.scriptDraft.stages.length) {
      return;
    }
    this.setData({ scriptActiveStage: index });
    this.syncScriptRows();
  },

  /** 改某阶段的时长输入（只记文本，应用时校验）。 */
  onScriptStageDurationInput(e: WechatMiniprogram.Input) {
    if (this.scriptDraft === null) {
      return;
    }
    const index = Number(e.currentTarget.dataset.stage ?? -1);
    this.scriptDraft = setStageDuration(
      this.scriptDraft,
      index,
      String(e.detail.value ?? ""),
    );
    this.syncScriptRows({ scriptHintText: "" });
  },

  /** 加一个阶段（上限 8）。 */
  onScriptAddStage() {
    if (this.scriptDraft === null) {
      return;
    }
    const next = addStage(this.scriptDraft);
    if (next === this.scriptDraft) {
      wx.showToast({ title: `最多 ${MAX_STAGES} 个阶段`, icon: "none" });
      return;
    }
    this.scriptDraft = next;
    this.syncScriptRows({ scriptHintText: "" });
  },

  /** 删掉某阶段（至少保留 1 个）。 */
  onScriptRemoveStage(e: WechatMiniprogram.TouchEvent) {
    if (this.scriptDraft === null) {
      return;
    }
    const index = Number(e.currentTarget.dataset.stage ?? -1);
    const next = removeStage(this.scriptDraft, index);
    if (next === this.scriptDraft) {
      wx.showToast({ title: "至少保留 1 个阶段", icon: "none" });
      return;
    }
    this.scriptDraft = next;
    const active = Math.min(this.data.scriptActiveStage, next.stages.length - 1);
    this.setData({ scriptActiveStage: active });
    this.syncScriptRows({ scriptHintText: "" });
  },

  /**
   * 把「当前分段」按当前灯效模式加进正在编辑的阶段（#32 的核心编辑动作）。
   *
   * 用当前选中的段（区间 + 色环颜色 + 模式参数），占该阶段里同一个 seg_id
   * ——同一阶段同一槽位是替换，所以重复点只是更新参数，不会堆出重复段。
   */
  onScriptAddSegment() {
    const draft = this.scriptDraft;
    if (session === null || draft === null || !this.data.ready) {
      return;
    }
    const target = this.activeTarget();
    if (target === null) {
      this.showSelectSegmentNotice();
      return;
    }

    const stageIndex = this.data.scriptActiveStage;
    const stage = draft.stages[stageIndex];
    if (stage === undefined) {
      return;
    }

    const rgb = this.wheelView?.rgb() ?? PRESETS[0].rgb;
    const [hue, sat] = this.segmentHueSat(rgb);
    let segment: SegmentConfig;
    try {
      segment = this.buildModeSegment(target, hue, sat, this.data.segmentMode);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.setData({ scriptHintText: message });
      wx.showToast({ title: message, icon: "none" });
      return;
    }

    /* 同阶段同槽位是替换；提示已占用时也不静默覆盖别的槽位——这里用同一
     * segId，所以「重复点」= 更新该槽位的参数，符合用户预期。 */
    const segments = upsertStageSegment(stage.segments, segment);
    this.scriptDraft = setStageSegments(draft, stageIndex, segments);
    this.syncScriptRows({
      scriptHintText: `阶段 ${stageIndex + 1} 段 ${segment.segId} 已设为「${MODE_LABELS[this.data.segmentMode]}」`,
    });
  },

  /** 从当前阶段删掉一个段（按 seg_id）。 */
  onScriptRemoveSegment(e: WechatMiniprogram.TouchEvent) {
    if (this.scriptDraft === null) {
      return;
    }
    const segId = Number(e.currentTarget.dataset.segId ?? -1);
    const stageIndex = this.data.scriptActiveStage;
    const stage = this.scriptDraft.stages[stageIndex];
    if (stage === undefined) {
      return;
    }
    const segments = removeStageSegment(stage.segments, segId);
    if (segments === stage.segments) {
      return;
    }
    this.scriptDraft = setStageSegments(this.scriptDraft, stageIndex, segments);
    this.syncScriptRows({ scriptHintText: `已从阶段 ${stageIndex + 1} 删除段 ${segId}` });
  },

  /** 简单包装：把 activeTarget 的区间与 hue/sat 变成该模式的段配置。 */
  buildModeSegment(
    target: SegmentTarget,
    hue: number,
    sat: number,
    mode: SegmentMode,
  ): SegmentConfig {
    const base = { stripId: target.stripId, segId: target.segId, start: target.start, end: target.end, hue, sat };
    if (mode === "breathing") {
      return {
        ...base,
        type: SEGMENT_TYPE.BREATHING,
        periodMs: this.data.breathingPeriod,
        p5: this.data.breathingMinLevel,
        flags: breathingFlags(this.data.breathingWaveform),
      };
    }
    if (mode === "rainbow") {
      return {
        ...base,
        type: SEGMENT_TYPE.RAINBOW,
        periodMs: this.data.animPeriod,
        p5: this.data.animSpan,
        flags: directionFlags(this.data.animReverse),
      };
    }
    if (mode === "comet") {
      return {
        ...base,
        type: SEGMENT_TYPE.COMET,
        periodMs: this.data.animPeriod,
        p5: this.data.animTail,
        flags: directionFlags(this.data.animReverse),
      };
    }
    return { ...base, type: SEGMENT_TYPE.STATIC, periodMs: 0, p5: 0, flags: 0 };
  },

  /** 用户空间 RGB → (hue, sat)，与 session 的换算同一份（不另写一份）。 */
  segmentHueSat(rgb: RGB): [number, number] {
    const hsv = rgbToHsv(rgb);
    return [
      Math.round((hsv.h / 360) * 0x10000) & 0xffff,
      Math.round(hsv.s * 255),
    ];
  },

  /**
   * 下发草稿（Begin → Stage/Segment… → Commit → Activate）。
   *
   * 进度以**每帧 ACK** 为权威（protocol §10.4）：session 每确认一帧回一次，
   * 这里换算成百分比与当前步文案。失败时 session 会尽力 Abort，设备保留
   * 上一套可用配置（协议保证，不靠小程序兜底）。
   */
  async onScriptDownload() {
    const draft = this.scriptDraft;
    if (session === null || this.data.scriptBusy || !this.data.ready || draft === null) {
      return;
    }

    const invalidStages = draftInvalidStageCount(draft);
    if (invalidStages > 0) {
      const message = `有 ${invalidStages} 个阶段的时长非法（必须是 1-65535 的整数）`;
      this.setData({ scriptHintText: message });
      wx.showToast({ title: message, icon: "none" });
      return;
    }

    const script = draftToScriptConfig(draft, this.stripCountForScripts());
    const precheck = session.validateScriptForDevice(script);
    if (!precheck.ok) {
      this.setData({ scriptHintText: precheck.message });
      wx.showToast({ title: precheck.message, icon: "none" });
      return;
    }

    this.setData({
      scriptBusy: true,
      scriptProgressPercent: 0,
      scriptProgressText: downloadProgressText("准备下发", 0, 0),
      scriptDeviceFrames: -1,
      scriptHintText: "正在下发…",
    });

    try {
      const result = await session.downloadScript(
        script,
        { activate: true, loop: this.data.playbackLoop },
        (view) => {
          this.setData({
            scriptProgressPercent: view.percent,
            scriptProgressText: downloadProgressText(view.label, view.done, view.total),
          });
        },
      );

      if (result.kind === "ok") {
        this.setData({
          scriptProgressPercent: 100,
          scriptProgressText: "下发完成",
          scriptHintText: `剧本 ${script.scriptId} 已下发并激活`,
        });
        if (result.state !== undefined && result.state !== null) {
          this.applyDeviceState(result.state);
        } else {
          void this.refreshAfterScript();
        }
        return;
      }
      if (result.kind === "stale") {
        this.setData({ scriptHintText: "连接已切换，下发结果已丢弃" });
        return;
      }
      /* 失败：设备保留上一套配置；进度条留在失败处，用户能看到停在哪一帧。 */
      const message =
        result.kind === "ack-error"
          ? `下发被设备拒绝（${resultText(result.ack.resultCode)}），上一套剧本仍可用`
          : result.kind === "invalid"
            ? result.message
            : result.message;
      this.setData({ scriptHintText: message });
      wx.showToast({ title: message, icon: "none" });
    } finally {
      this.setData({ scriptBusy: false });
    }
  },

  /** 下发后补读一次 State（script_id / flags 已变，设备是权威）。 */
  async refreshAfterScript() {
    if (session === null) {
      return;
    }
    try {
      const state = await session.refreshState();
      this.applyDeviceState(state);
    } catch {
      /* 读失败不改变已成功的下发结果，等下一次 State read 纠正。 */
    }
  },

  /** play / pause / stop（#32）：暂停后继续从暂停点，不从头。 */
  async onPlaybackTap(e: WechatMiniprogram.TouchEvent) {
    if (session === null || this.data.playbackBusy || !this.data.ready) {
      return;
    }
    const action = Number(e.currentTarget.dataset.action ?? -1);
    if (action !== 0 && action !== 1 && action !== 2) {
      return;
    }
    this.setData({ playbackBusy: true });
    try {
      const result = await session.setPlayback(action as 0 | 1 | 2, this.data.playbackLoop);
      if (result.kind === "ok" && result.state !== undefined && result.state !== null) {
        this.applyDeviceState(result.state);
        return;
      }
      if (result.kind === "ack-error") {
        wx.showToast({ title: resultText(result.ack.resultCode), icon: "none" });
        return;
      }
      if (result.kind === "stale") {
        return;
      }
      if (result.kind === "error") {
        wx.showToast({ title: result.message, icon: "none" });
      }
    } finally {
      this.setData({ playbackBusy: false });
    }
  },

  /** loop 开关：三种 action 下都会写入；这里只改本地值，下一次操作生效。 */
  onPlaybackLoopChange(e: WechatMiniprogram.SwitchChange) {
    this.setData({ playbackLoop: Boolean(e.detail.value) });
  },

  /** 把设备上的另一套剧本设为激活（不自动播放）。 */
  async onScriptActivate() {
    if (session === null || this.data.scriptBusy || !this.data.ready) {
      return;
    }
    this.setData({ scriptBusy: true });
    try {
      const result = await session.activateScript(this.data.scriptId, this.data.playbackLoop);
      if (result.kind === "ok" && result.state !== undefined && result.state !== null) {
        this.applyDeviceState(result.state);
        this.setData({ scriptHintText: `已激活剧本 ${this.data.scriptId}` });
        return;
      }
      if (result.kind === "ack-error") {
        /* 设备未提交该 id → InvalidParam：明确告诉用户先下发。 */
        this.setData({ scriptHintText: `剧本 ${this.data.scriptId} 尚未在设备上提交，请先下发` });
        wx.showToast({ title: "该剧本需要先下发", icon: "none" });
        return;
      }
      if (result.kind === "stale") {
        return;
      }
      if (result.kind === "error") {
        wx.showToast({ title: result.message, icon: "none" });
      }
    } finally {
      this.setData({ scriptBusy: false });
    }
  },

  /** 各条灯带数的回落（State 只报 strip 0 的值）。 */
  stripCountForScripts(): number {
    return Math.max(1, this.data.stripCountValue);
  },

  applyDeviceState(state: DeviceState) {
    // 用与 session / brightness.ts 同一份「max_brightness 为 0 时按 255」规则，
    // 不要在这内联一份。设备是权威：State read / StateReport 覆盖本地值。
    const max = effectiveMaxBrightness(state.maxBrightness);
    const brightness = clampBrightness(state.brightness, max);
    const rgb: RGB = { r: state.r, g: state.g, b: state.b };
    // 色环状态先对齐（不单独 setData/重绘），下面的 setData 一次带全。
    const hsv = this.wheelView?.assign(rgb) ?? hsvForWheel(rgb, INITIAL_HSV.h);
    // #32：播放状态是设备权威（State 字节 10-13）。阶段总数取草稿的阶段数——
    // 设备只报当前阶段号，不报总数；用草稿是唯一能给出「3 / 4」的来源。
    const stageTotal = this.scriptDraft?.stages.length ?? 0;
    const playback = playbackView(
      state.playbackState,
      state.stageIndex,
      state.flags,
      state.scriptId,
      stageTotal,
    );
    this.setData({
      power: state.power,
      powerLabel: powerLabelText(state.power, brightness),
      brightness,
      brightnessDisplay: brightness,
      brightnessPercent: percentOf(brightness, max),
      maxBrightness: max,
      brightnessHintText: brightnessHintText(brightness, this.data.ready),
      // State 字节 2-4 是 seg 0 的基准色；没有段时界面显示它，有段时以段列表为准。
      colorHex: rgbToHex(rgb),
      colorHue: hsv.h,
      colorSaturation: Math.round(hsv.s * 100),
      selectedPreset: matchingPreset(rgb),
      colorHintText: colorHintText(this.data.ready, this.activeTarget()),
      // 设备权威：State read / StateReport 里的数量总是覆盖本地值。
      ledCount: state.ledCount,
      stripCountValue: state.stripCount,
      // #32：播放控制面板以设备 State 为准。
      playbackText: playback.text,
      playbackStageText: playback.stageText,
      playbackState: playback.state,
      playbackLoop: playback.loop,
      playbackActive: playback.active,
    });
    this.redrawWheel();
  },

  /** 离散命令结果：成功用设备语义刷新 UI；失败提示并回读 State（设备权威）。 */
  applyCommandResult(result: CommandResult) {
    if (result.kind === "ok") {
      this.applyDeviceState(result.state);
      return;
    }
    if (result.kind === "stale") {
      // 旧连接上飞行的命令晚到：回连后的新 State 才是权威，什么都不改。
      return;
    }
    if (result.kind === "ack-error") {
      wx.showToast({ title: resultText(result.ack.resultCode), icon: "none" });
      // 非零 ACK：设备权威，重新读一次 State（失败就等用户手动重连）。
      void session?.refreshState().then(
        (state) => this.applyDeviceState(state),
        () => undefined,
      );
      return;
    }
    wx.showToast({ title: result.message, icon: "none" });
  },
});

/** 段命令被拒时的可读原因（设备权威结果码 → 用户能懂的话）。 */
function segmentRejectHint(resultCode: number): string {
  switch (resultCode) {
    case 0x01:
      /* 呼吸下限 334ms、彩虹/流光 200ms，所以只说「周期过短」而不写具体值。 */
      return "设备拒绝：区间越界、与其它段重叠、保留了非法标志位，或周期过短";
    case 0x02:
      return "该灯效需要升级固件";
    case 0x04:
      return "协议长度不符（固件与小程序版本不一致）";
    default:
      return `设置失败：${resultText(resultCode)}`;
  }
}

/** 0-255 的整数钳位（滑块的 value 来自事件，未必是整数）。 */
function clampByte(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.min(255, Math.max(0, Math.round(value)));
}

/** p5（0-255）→ 百分比文本。 */
function percentText(value: number): string {
  return `${Math.round((clampByte(value) / 255) * 100)}%`;
}

/** flags bits1-2 → 波形枚举。 */
function breathingWaveformOf(flags: number): number {
  return (flags >> 1) & 0x03;
}
