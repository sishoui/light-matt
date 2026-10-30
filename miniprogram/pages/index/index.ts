/**
 * 单页控制界面（#8 开关 + #9 亮度 + #10 颜色与预设 + #11 状态同步与回连
 * + #12 灯珠数量 + #13 隐藏日志面板与自检）。
 *
 * 页面只做 view model 与事件转发，所有 BLE 细节经 ControlSession。
 * 亮度滑块进 session 的 20Hz latest-wins 节流实例。
 *
 * v2（#21）退役了 SetColor / SetAll：颜色与预设的下发路径暂时禁用，
 * 只在本地渲染一个可见的「该功能在 v2 分段界面中提供（#25）」提示。
 * 控件保留、页面照常编译渲染——**不静默删掉用户可见的功能**，
 * 只是明确告诉用户它还没接上。TODO(#25)：围绕分段重建这一区域。
 *
 * #11：连接状态以设备为准。断线立即清空控件（不显示过期状态）；自动回连由
 * session 的 1s/2s/4s 退避负责；onShow 时静默回连（不打断扫描/手动连接）；
 * 回连成功后 transport 重新订阅 notify 并读 State，页面用新 State 全量刷新。
 *
 * 色环用单块 2D canvas：色相环画一次，拖动时只擦/画选中点所在的小块并补回
 * 该角区间的环弧（见 utils/color/wheel.ts）。setData 的取色读数按 20Hz 更新，
 * 与 BLE 节流同一个节奏。
 *
 * 隐藏协议日志面板：连点版本号 5 次开启（spec §10）。面板只消费 FrameLog
 * 这一份数据（console 镜像也在 FrameLog.push 里），暂停 = 冻结视图但继续
 * 记录（理由见 utils/ble/log-panel.ts 顶部注释）。
 */

import { errorText, eventText, resultText } from "../../utils/ble/errors";
import {
  LogPanelModel,
  type LogPanelRow,
} from "../../utils/ble/log-panel";
import {
  brightnessPercent as percentOf,
  clampBrightness,
  effectiveMaxBrightness,
} from "../../utils/control/brightness";
import {
  ControlSession,
  detectDevMode,
  detectPlatform,
  SEGMENTS_UI_NOTICE,
  type CommandResult,
} from "../../utils/control/session";
import { statusView } from "../../utils/control/status-view";
import {
  ledCountResultHint,
  parseLedCountInput,
} from "../../utils/control/ledCount";
import {
  hsvForWheel,
  hsvToRgb,
  normalizeHue,
  PRESETS,
  rgbToHex,
  rgbToHsv,
} from "../../utils/color/hsv";
import {
  drawWheel,
  hueAtPoint,
  moveWheelMarker,
  wheelGeometry,
  type WheelContext2D,
  type WheelGeometry,
} from "../../utils/color/wheel";
import type { DeviceState, DiscoveredDevice, LinkState, RGB } from "../../utils/protocol/types";

/** 模块级单例：页面重入时复用同一条 BLE 会话。 */
let session: ControlSession | null = null;
let unsubscribers: Array<() => void> = [];

/** 页面取色读数的刷新间隔：与 BLE 20Hz 对齐，避免每个 touchmove 都 setData。 */
const COLOR_UI_INTERVAL_MS = 50;

/**
 * v2（#21）：颜色 / 预设的下发路径暂时禁用。
 *
 * SetColor 0x03 / SetAll 0x04 已退役，单色概念改由段配置承担。这里保留控件
 * （不静默删功能），但**不修改任何本地状态**：设备没收到命令，界面就不能
 * 显示已经变色，否则用户会以为生效了。
 *
 * TODO(#25)：`#25` 围绕分段重建这一区域后删掉这个开关。
 */
const COLOR_CONTROLS_ENABLED = false;

/** 日志面板的刷新合并间隔：帧可能以 20Hz 到达，不能每帧都 setData。 */
const LOG_PANEL_REFRESH_MS = 200;

/** 首屏色环位置与暖白预设对齐（真值来自预设表，不另写一份）。 */
const INITIAL_HSV = rgbToHsv(PRESETS[0].rgb);

interface WheelCtx {
  ctx: WheelContext2D;
  geometry: WheelGeometry;
  dpr: number;
}

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

    // 颜色（#10）：色相环 + 饱和度滑块；RGB 始终是用户空间值（不做 gamma）
    presetList: PRESETS,
    colorHex: PRESETS[0].hex,
    colorHue: INITIAL_HSV.h,
    colorSaturation: Math.round(INITIAL_HSV.s * 100), // 0-100，映射到 S = 0..1
    selectedPreset: PRESETS[0].name,
    colorHintText: "连接后可选色",

    // 扫描 / 设备弹层
    sheetVisible: false,
    sheetMode: "scan" as "scan" | "device",
    devices: [] as DiscoveredDevice[],
    scanHint: "" as string,
    deviceName: "",
    deviceId: "",
    selfTestBusy: false,

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

    version: "0.1.0",
  },

  /** canvas 上下文与几何：非响应式，放在页面实例上（不进 data）。 */
  wheel: null as WheelCtx | null,
  /** onReady 之后才允许 onShow 重建 canvas（首次 onShow 早于首次布局）。 */
  pageReady: false,
  /** 色环状态：唯一真相；data 里的 colorHue / colorSaturation 只是显示镜像。 */
  wheelHue: INITIAL_HSV.h,
  wheelSaturation: INITIAL_HSV.s,
  /** 取色读数的上次 setData 时间。 */
  lastColorUiAt: 0,
  /** 亮度读数的上次 setData 时间（与取色共用 50ms 闸门）。 */
  lastBrightnessUiAt: 0,
  /** 隐藏日志面板模型（页面实例持有；数据源是 session 的 FrameLog）。 */
  logPanel: null as LogPanelModel | null,
  /** 日志 setData 的合并计时器（20Hz 帧不能每帧都 setData）。 */
  logFlushTimer: null as ReturnType<typeof setTimeout> | null,

  onLoad() {
    const platform = detectPlatform();
    const devMode = detectDevMode();
    session = new ControlSession({ platform, devMode });
    console.log(`[lumen] 平台 ${platform}，开发版日志 ${devMode ? "开启" : "关闭"}`);

    // 面板与 console 共用 session.log 这一份 FrameLog（同源，不复制、不重格式化）。
    this.logPanel = new LogPanelModel(session.log);

    unsubscribers = [
      session.onLink((state, detail) => {
        // 自动回连 / 首次连接都可能由 session 发起：页面没有主动 setData 设备名，
        // 这里从链路事件补上（ready 时 detail 带 deviceName）。
        if (state === "ready" && detail?.deviceName !== undefined) {
          this.setData({ deviceName: detail.deviceName });
        }
        this.applyLink(state, detail?.message);
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
      session.log.onAppend(() => this.scheduleLogRefresh()),
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
    this.wheel = null;
    if (this.logFlushTimer !== null) {
      clearTimeout(this.logFlushTimer);
      this.logFlushTimer = null;
    }
    this.logPanel = null;
    // 页面生命周期结束，彻底断开并反注册 wx.on*（避免回调串入）。
    session?.destroy();
    session = null;
  },

  onShow() {
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
    if (this.wheel === null) {
      this.initWheel();
    } else {
      this.redrawWheel();
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
    } catch (err) {
      wx.showToast({ title: errorText(err), icon: "none" });
    }
  },

  openScanSheet() {
    this.setData({ sheetVisible: true, sheetMode: "scan", scanHint: "" });
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
    try {
      const state = await session.connect(deviceId, name);
      this.applyDeviceState(state);
      this.setData({ sheetVisible: false, deviceName: name, deviceId });
      // connect() 内发出 ready 时页面还没拿到设备名，这里补一次状态条。
      this.applyLink("ready");
    } catch (err) {
      this.setData({ scanHint: errorText(err) });
    }
  },

  async onDisconnect() {
    if (session === null) {
      return;
    }
    await session.disconnect();
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
      colorHintText: "连接后可选色",
      selectedPreset: "",
      ledCount: 0,
      ledCountInput: "",
      ledCountHintText: "",
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

  /**
   * 版本号点击：2s 窗口内第 5 次切换面板可见性（spec §10）。
   * 判定逻辑在 TapSequence 里，页面只负责应用结果。
   */
  onVersionTap() {
    const panel = this.logPanel;
    if (panel === null) {
      return;
    }
    if (!panel.tapVersion(Date.now())) {
      return;
    }
    const visible = panel.visible;
    this.setData({ logVisible: visible, logHint: "" });
    if (visible) {
      this.refreshLogPanel();
    }
  },

  /** 把面板模型当前视图同步到 data（行 + 计数 + 暂停态）。 */
  refreshLogPanel() {
    const panel = this.logPanel;
    if (panel === null) {
      return;
    }
    const entries = panel.entries();
    const rows = panel.rows();
    const last = rows.length > 0 ? rows[rows.length - 1] : null;
    this.setData({
      logRows: rows,
      logCount: entries.length,
      logPaused: panel.paused,
      // 跟随最新一帧；暂停时不动视图，恢复后再跳到末尾。
      logScrollTarget: !panel.paused && last !== null ? `log-row-${last.id}` : "",
    });
  },

  /** 合并刷新：20Hz 的帧不能每帧 setData；暂停/隐藏时完全不动视图。 */
  scheduleLogRefresh() {
    if (!this.data.logVisible || this.data.logPaused) {
      return;
    }
    if (this.logFlushTimer !== null) {
      return;
    }
    this.logFlushTimer = setTimeout(() => {
      this.logFlushTimer = null;
      this.refreshLogPanel();
    }, LOG_PANEL_REFRESH_MS);
  },

  /** 暂停 = 冻结视图但继续记录（理由见 log-panel.ts）。 */
  onLogPauseTap() {
    const panel = this.logPanel;
    if (panel === null) {
      return;
    }
    const paused = panel.togglePause();
    this.setData({
      logPaused: paused,
      logHint: paused ? "已暂停视图（新帧仍在记录）" : "",
    });
    this.refreshLogPanel();
  },

  onLogClearTap() {
    const panel = this.logPanel;
    if (panel === null) {
      return;
    }
    panel.clear();
    this.setData({ logHint: "" });
    this.refreshLogPanel();
  },

  /** 复制当前视图：暂停时复制冻结的那一段，否则复制整个环形缓冲。 */
  onLogCopyTap() {
    const panel = this.logPanel;
    if (panel === null) {
      return;
    }
    const text = panel.copyText();
    if (text.length === 0) {
      this.setData({ logHint: "没有可复制的帧" });
      return;
    }
    const count = panel.entries().length;
    wx.setClipboardData({
      data: text,
      success: () => this.setData({ logHint: `已复制 ${count} 帧` }),
      fail: (err) => this.setData({ logHint: `复制失败：${errorText(err)}` }),
    });
  },

  onLogCloseTap() {
    const panel = this.logPanel;
    if (panel !== null) {
      panel.setVisible(false);
    }
    this.setData({ logVisible: false });
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

  // ---------------- 颜色（#10） ----------------

  /** 取画布节点与尺寸，按 dpr 建上下文并画一次色相环。 */
  initWheel() {
    const query = wx.createSelectorQuery();
    query
      .select("#color-wheel")
      .fields({ node: true, size: true })
      .exec((res: any[]) => {
        const node = res?.[0]?.node as WechatMiniprogram.Canvas | undefined;
        const width = Number(res?.[0]?.width ?? 0);
        if (!node || width <= 0) {
          console.warn("[lumen] 取不到色环 canvas 节点，颜色只能靠预设");
          return;
        }

        const dpr = this.pixelRatio();
        // 物理像素 = CSS 像素 × dpr；绘制时统一 setTransform(dpr,...)。
        node.width = Math.round(width * dpr);
        node.height = Math.round(width * dpr);

        this.wheel = {
          ctx: node.getContext("2d") as unknown as WheelContext2D,
          geometry: wheelGeometry(width),
          dpr,
        };
        this.redrawWheel();
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
    if (this.wheel === null) {
      return;
    }
    const { ctx, geometry, dpr } = this.wheel;
    drawWheel(ctx, geometry, dpr, this.wheelHue, rgbToHex(this.wheelRgb()));
  },

  /** 色环 + 饱和度对应的用户空间 RGB（V 恒为 1，亮度由滑块负责）。 */
  wheelRgb(): RGB {
    return hsvToRgb(this.wheelHue, this.wheelSaturation, 1);
  },

  /** touchstart / touchmove 共用：把触摸点换算成色相并下发（20Hz 节流在 session）。 */
  handleWheelTouch(e: WechatMiniprogram.TouchCanvas) {
    if (this.wheel === null || !this.data.ready) {
      return;
    }
    if (!COLOR_CONTROLS_ENABLED) {
      // 每次手势只提示一次（touchstart），避免 touchmove 高频弹 toast。
      if (e.type === "touchstart") {
        this.showSegmentsNotice();
      }
      return;
    }
    // 多指触摸容易误判，只处理单指。
    if (Array.isArray(e.touches) && e.touches.length > 1) {
      return;
    }
    const touch = e.touches?.[0];
    if (!touch) {
      return;
    }
    const hue = hueAtPoint(touch.x, touch.y, this.wheel.geometry);
    if (hue === null) {
      // 点在环内空白或环外：忽略，避免手指划过中心时颜色乱跳。
      return;
    }
    this.applyHue(hue);
  },

  onWheelTouchStart(e: WechatMiniprogram.TouchCanvas) {
    this.handleWheelTouch(e);
  },

  onWheelTouchMove(e: WechatMiniprogram.TouchCanvas) {
    this.handleWheelTouch(e);
  },

  /**
   * 松手。v2 里 commitColor 是占位实现——不发帧、不改本地状态，
   * 只在手势结束时提示功能位置（#25）。
   */
  onWheelTouchEnd() {
    if (!this.data.ready || !COLOR_CONTROLS_ENABLED) {
      return;
    }
    session?.commitColor(this.wheelRgb());
  },

  /** 色相变化：marker 立即重画；读数 setData 与 BLE 都按 20Hz 节流。 */
  applyHue(hue: number) {
    if (!COLOR_CONTROLS_ENABLED) {
      return;
    }
    const previousHue = this.wheelHue;
    this.wheelHue = normalizeHue(hue);
    const rgb = this.wheelRgb();
    const hex = rgbToHex(rgb);
    if (this.wheel !== null) {
      moveWheelMarker(
        this.wheel.ctx,
        this.wheel.geometry,
        this.wheel.dpr,
        this.wheelHue,
        hex,
        previousHue,
      );
    }
    /* v2：queueColor 是占位实现（不发帧）；这里保留本地 marker 跟手，
     * 用户能立刻看到界面反馈，真正的下发在 #25。 */
    session?.queueColor(rgb);

    const now = Date.now();
    if (now - this.lastColorUiAt < COLOR_UI_INTERVAL_MS) {
      return;
    }
    this.lastColorUiAt = now;
    this.setData({
      colorHue: this.wheelHue,
      colorHex: hex,
      selectedPreset: "",
      colorHintText: this.colorHintText(this.data.ready),
    });
  },

  onSaturationChanging(e: WechatMiniprogram.SliderChanging) {
    this.applySaturation(Number(e.detail.value), false);
  },

  onSaturationChange(e: WechatMiniprogram.SliderChange) {
    this.applySaturation(Number(e.detail.value), true);
  },

  /** 饱和度（0-100）→ S=0..1；V 恒为 1（亮度独立，不折进 RGB）。 */
  applySaturation(value: number, commit: boolean) {
    if (!Number.isFinite(value)) {
      return;
    }
    if (!COLOR_CONTROLS_ENABLED) {
      // 松手时提示一次；拖动过程中静默忽略（避免每帧弹 toast）。
      if (commit) {
        this.showSegmentsNotice();
      }
      return;
    }
    this.wheelSaturation = Math.min(100, Math.max(0, Math.round(value))) / 100;
    const rgb = this.wheelRgb();
    const hex = rgbToHex(rgb);
    if (this.wheel !== null) {
      /* 饱和度只改 marker 的填充色，位置（色相）不变；走局部擦补比重画整环便宜。 */
      moveWheelMarker(
        this.wheel.ctx,
        this.wheel.geometry,
        this.wheel.dpr,
        this.wheelHue,
        hex,
        this.wheelHue,
      );
    }
    this.setData({
      colorSaturation: Math.round(this.wheelSaturation * 100),
      colorHex: hex,
      selectedPreset: "",
      colorHintText: this.colorHintText(this.data.ready),
    });
    if (commit) {
      session?.commitColor(rgb);
      this.showSegmentsNotice();
    } else {
      session?.queueColor(rgb);
    }
  },

  /**
   * 预设点击——v2 占位：不再下发 SetAll（0x04 已退役）。
   *
   * **不改任何本地状态**：设备没有收到命令，界面就不能显示「已切换」。
   * 只弹「该功能在 v2 分段界面中提供（#25）」的提示——宁可明确说没接上，
   * 也不能假装成功（#21 的取舍）。
   *
   * TODO(#25)：预设改为「写入 strip 0 / seg 0 的静态段」。
   */
  async onPresetTap(e: WechatMiniprogram.TouchEvent) {
    if (session === null || !this.data.ready) {
      return;
    }
    const index = Number(e.currentTarget.dataset.index ?? -1);
    if (PRESETS[index] === undefined) {
      return;
    }
    // 只提示，不动 UI 的颜色/开关：设备状态没变，界面也不能变。
    this.showSegmentsNotice();
  },

  /** 统一的 v2 占位提示（颜色 / 预设区域）。TODO(#25) */
  showSegmentsNotice() {
    wx.showToast({ title: SEGMENTS_UI_NOTICE, icon: "none" });
  },

  /**
   * 把设备/预设颜色反推回色环位置与饱和度（灰阶时保留当前色相）。
   *
   * v2 起预设下发路径禁用，本方法暂时没有生产调用方；保留给 #25 的分段界面
   * （选中段 → 色环定位）复用，单测里的 hsvForWheel 覆盖同一逻辑。
   * TODO(#25)
   */
  syncWheelToRgb(rgb: RGB) {
    const hsv = hsvForWheel(rgb, this.wheelHue);
    this.wheelHue = hsv.h;
    this.wheelSaturation = hsv.s;
    this.setData({
      colorHue: hsv.h,
      colorSaturation: Math.round(hsv.s * 100),
    });
    this.redrawWheel();
  },

  /**
   * 颜色区提示。v2 起颜色由段配置承担，这里始终说明功能位置，
   * 避免用户拖动后以为没生效而反复尝试。TODO(#25)
   */
  colorHintText(ready: boolean): string {
    if (!ready) {
      return `连接后可操作；${SEGMENTS_UI_NOTICE}`;
    }
    return SEGMENTS_UI_NOTICE;
  },

  // ---------------- 内部 ----------------

  /**
   * 亮度只影响 brightness：power 位不动（亮度 0 视觉等于关灯，但设备仍是「开」）。
   * bindValue 为 false 时不回写 slider.value（拖动中由原生控件跟手）。
   */
  setBrightnessView(rawValue: number, bindValue: boolean) {
    const max = this.data.maxBrightness;
    const value = clampBrightness(rawValue, max);
    const patch: Record<string, unknown> = {
      brightnessDisplay: value,
      brightnessPercent: percentOf(value, max),
      brightnessHintText: this.brightnessHintText(value, this.data.ready),
    };
    if (bindValue) {
      patch.brightness = value;
    }
    this.setData(patch);
  },

  brightnessHintText(value: number, ready: boolean): string {
    if (!ready) {
      return "连接后可调节";
    }
    if (value === 0) {
      return "亮度 0 视觉上等于关灯；开关状态保持为开";
    }
    return "拖动实时跟随，松手确认";
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
        ? this.brightnessHintText(this.data.brightness, true)
        : this.data.brightnessHintText,
      colorHintText: this.colorHintText(ready),
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
          colorHintText: "连接后可选色",
          selectedPreset: "",
          // 设备级值不能跨连接沿用：下一台设备的 max_brightness 可能不同。
          maxBrightness: effectiveMaxBrightness(undefined),
          ledCount: 0,
          ledCountInput: "",
          ledCountHintText: "",
        });
      }
    }
  },

  applyDeviceState(state: DeviceState) {
    // 用与 session / brightness.ts 同一份「max_brightness 为 0 时按 255」规则，
    // 不要在这内联一份。设备是权威：State read / StateReport 覆盖本地值。
    const max = effectiveMaxBrightness(state.maxBrightness);
    const brightness = clampBrightness(state.brightness, max);
    const rgb: RGB = { r: state.r, g: state.g, b: state.b };
    const hsv = hsvForWheel(rgb, this.wheelHue);
    this.wheelHue = hsv.h;
    this.wheelSaturation = hsv.s;
    this.setData({
      power: state.power,
      powerLabel: this.powerLabelText(state.power, brightness),
      brightness,
      brightnessDisplay: brightness,
      brightnessPercent: percentOf(brightness, max),
      maxBrightness: max,
      brightnessHintText: this.brightnessHintText(brightness, this.data.ready),
      colorHex: rgbToHex(rgb),
      colorHue: hsv.h,
      colorSaturation: Math.round(hsv.s * 100),
      selectedPreset: this.matchingPreset(rgb),
      colorHintText: this.colorHintText(this.data.ready),
      // 设备权威：State read / StateReport 里的数量总是覆盖本地值。
      ledCount: state.ledCount,
    });
    this.redrawWheel();
  },

  /** 当前 RGB 与哪个预设完全一致（用于高亮）；都不匹配返回空串。 */
  matchingPreset(rgb: RGB): string {
    for (const preset of PRESETS) {
      if (preset.rgb.r === rgb.r && preset.rgb.g === rgb.g && preset.rgb.b === rgb.b) {
        return preset.name;
      }
    }
    return "";
  },

  /** 亮度 0 且 power=1：灯是灭的但开关位仍为开，文案要如实说明（§7）。 */
  powerLabelText(power: 0 | 1, brightness: number): string {
    if (power === 0) {
      return "已关";
    }
    return brightness === 0 ? "已开 · 亮度 0" : "已开";
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
