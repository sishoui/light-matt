/**
 * 设备详情页（二级页）：从首页大卡进入，本页承担原来的「灯光控制」。
 *
 * ## 为什么灯光并入设备详情（本轮交互改版的决定）
 *
 * 原来的 tab 结构是「设备 / 灯光 / 剧本」，用户要先在设备页连上、再切到灯光页
 * 才能控制，而「这台设备」与「它的灯光」在概念上是一件事。改版后：
 *   首页（大卡 + 小图）→ 点大卡 → 本页（这台设备的全部控制）
 * 剧本仍留在 tab 里（它是设备级但独立的编辑器）。
 *
 * ## 进入时的连接语义
 *
 * 首页只负责「浏览」，所以本页必须自己把目标设备连上：
 *  - 已连着它 → 什么都不做；
 *  - 连着别的设备 → `switchTo`（主动切换，失败停在未连接并给重试）；
 *  - 没连着 → `connect`。
 *
 * ## 关键不变量（沿用原灯光页）
 *
 *  - **灯带是显式参数**：所有设备调用都传 `data.stripId`；
 *  - **切换灯带只是重新读**：切带不清设备配置、不清登记表，只 `queryStrip(新带)`；
 *  - **每带灯珠数逐带真实**：chips 的灯珠数来自 `State.stripCounts[i]`；
 *  - 启用掩码只过滤 chips，隐藏一条带不丢它的段。
 */

import { errorText, resultText } from "../../utils/ble/errors";
import type { LinkDetail } from "../../utils/ble/transport";
import { ConnectCancelledError } from "../../utils/ble/transport";
import {
  brightnessPercent as percentOf,
  clampBrightness,
  effectiveMaxBrightness,
} from "../../utils/control/brightness";
import { createWxStorage, type SessionStorage } from "../../utils/control/device-cache";
import {
  enabledStripIds,
  loadRegistry,
  type DeviceRegistry,
} from "../../utils/control/device-registry";
import {
  brightnessHintText,
  brightnessViewPatch,
  powerLabelText,
} from "../../utils/control/view-model";
import { COLOR_UI_INTERVAL_MS } from "../../utils/control/wheel-view";
import {
  buildStripChips,
  pickStripId,
  stripChipSummary,
  type StripChip,
} from "../../utils/control/strip-chips";
import { ControlSession } from "../../utils/control/session";
import { getSession, isMockSession } from "../../utils/control/session-singleton";
import { loadTheme, themeClass, type ThemeMode } from "../../utils/control/theme";
import { PAGE_ROUTES, pushTo, queryText } from "../../utils/control/routes";
import { statusView } from "../../utils/control/status-view";
import { PRESETS, rgbToSegmentParams } from "../../utils/color/hsv";
import { MAX_STRIPS, NO_EFFECT } from "../../utils/protocol/constants";
import {
  buildQuickCardViews,
  buildQuickPanel,
  buildQuickSpec,
  inferQuickCard,
  quickCardOf,
  quickPresetFlags,
  type QuickCardView,
  type QuickParams,
  type QuickPanelView,
} from "../../utils/control/quick-effects";
import type {
  DeviceState,
  LinkState,
  SegmentReport,
  StripConfig,
} from "../../utils/protocol/types";

/** chip 的展示形状 = 纯视图模型 + 一行摘要文本。 */
interface StripChipView extends StripChip {
  summary: string;
}

Page({
  data: {
    themeClass: "",
    mock: false,

    statusText: "未连接",
    statusSub: "正在连接…",
    statusAction: "取消",
    linkClass: "link-idle",
    ready: false,
    /** 顶部标题（设备备注名 / 广播名）。 */
    deviceName: "",
    deviceId: "",
    /** 目标设备尚未连上时的提示（例如切换失败）。 */
    connectHint: "",
    connectBusy: false,

    // 灯带切换器
    stripChips: [] as StripChipView[],
    stripId: -1,
    stripTitle: "—",
    stripHint: "连接后选择灯带",

    // 总闸
    power: 0 as 0 | 1,
    powerBusy: false,
    powerLabel: "已关",

    // 选中灯带的独立开关（SetStripPower 0x1B）
    stripOn: false,
    stripPowerBusy: false,

    // 亮度
    brightness: 0,
    brightnessDisplay: 0,
    brightnessPercent: 0,
    maxBrightness: 255,
    brightnessHintText: "连接后可调节",

    ledCount: 0,
    stripCount: 0,

    /* ---------------- 灯效编辑（#54） ---------------- */
    /** 编辑档位：快捷（点结果）/ 自定义（编排）。 */
    effectMode: "quick" as "quick" | "custom",
    quickCards: [] as QuickCardView[],
    quickPanel: null as QuickPanelView | null,
    quickPresetFlags: [] as boolean[],
    quickPresets: PRESETS,
    /** 当前灯效的一行摘要（设备控制页要求：打开就知道现在亮的是什么）。 */
    effectSummary: "还没有灯效",
    /** 不做动画时（未连接 / 未选灯组）卡片区禁用并给出原因。 */
    quickDisabledReason: "",
    quickBusy: false,
    quickHint: "",
    /** 自定义档的说明行（#55/#56 会把它替换成真正的编排界面）。 */
    customHint: "自定义编排即将开放",
  },

  session: null as ControlSession | null,
  pageReady: false,
  lastBrightnessUiAt: 0,
  /** 设备权威的光区列表（当前灯组，最近一次 QueryStrip）。 */
  segmentReports: [] as SegmentReport[],
  registry: null as DeviceRegistry | null,
  storage: null as SessionStorage | null,
  unsubscribers: [] as Array<() => void>,
  /** 从首页带过来的设备 key（hardwareId 优先，空表示「连当前已连接的」）。 */
  targetKey: "",
  themeMode: "system" as ThemeMode,
  /** 是否已经为这台设备发起过连接（避免 onShow 重复连接）。 */
  autoConnectTried: false,
  /** 快捷档每张卡的参数（按灯组隔离，切带不串档）。 */
  quickParamsByStrip: new Map<number, QuickParams>(),
  /** 快捷档当前选中的卡（按灯组隔离）。 */
  quickCardByStrip: new Map<number, string>(),
  /** 300ms 防抖的定稿定时器（参数拖动时只发最后一次）。 */
  quickTimer: null as ReturnType<typeof setTimeout> | null,
  /** 防止「防抖期间又点卡片」把旧参数写出去。 */
  quickEpoch: 0,

  onLoad(options: Record<string, string | undefined>) {
    /* 页面私有状态（不进 data）。Page() 不保证对象字面量字段会被复制到
     * 实例上，所以在这里显式兜底——漏掉会让 onLoad / onUnload 抛
     * TypeError 并中断整页的事件绑定。 */
    this.unsubscribers = [];
    this.segmentReports = [];
    this.pageReady = false;
    this.lastBrightnessUiAt = 0;
    this.targetKey = "";
    this.autoConnectTried = false;
    this.registry = null;
    this.quickParamsByStrip = new Map<number, QuickParams>();
    this.quickCardByStrip = new Map<number, string>();
    this.quickTimer = null;
    this.quickEpoch = 0;

    const storage = createWxStorage();
    this.storage = storage;
    this.themeMode = loadTheme(storage);
    this.registry = loadRegistry(storage);
    this.targetKey = queryText(options, "key", "");

    this.session = getSession();

    this.setData({
      themeClass: themeClass(this.themeMode),
      mock: isMockSession(),
    });

    this.applyTargetName();
  },

  onReady() {
    this.pageReady = true;
  },

  onShow() {
    this.subscribe();
    this.syncFromSession();
    void this.session?.onShow();
    void this.ensureConnected();
    if (this.data.ready) {
      /* 段列表是设备权威、且设备不会主动上报：每次进页面重读当前带。 */
      if (this.data.stripId >= 0) {
        void this.refreshSegments();
      }
    }
  },

  onHide() {
    this.unsubscribe();
  },

  onUnload() {
    /* 二级页会被真正卸载；但会话属于 App，绝不 destroy。 */
    this.unsubscribe();
    this.session = null;
    this.storage = null;
  },

  subscribe() {
    const session = this.session;
    if (session === null) {
      return;
    }
    this.unsubscribers = [
      session.onLink((state, detail) => this.applyLink(state, detail)),
      session.onState((state) => this.applyDeviceState(state)),
      /* §9.1 的第 2、3 步由会话异步补：读完（或确认读不到）再重画 chips，
       * 不用固定延时猜 GPIO 什么时候到。 */
      session.onDeviceConfig(() => {
        void this.refreshStripChips();
        this.applyTargetName();
      }),
      /* #48：节流通道读不回完整 spec 时不会下发，但也没有 await 结果可看；
       * 会话用这条通道把原因送过来，本页弹一次提示（不假装改色成功）。 */
      session.onSegmentHint((message) => {
        this.setData({ colorHintText: message });
        wx.showToast({ title: message, icon: "none" });
      }),
    ];
  },

  unsubscribe() {
    for (const off of this.unsubscribers ?? []) {
      off();
    }
    this.unsubscribers = [];
  },

  reloadRegistry() {
    if (this.storage === null) {
      return;
    }
    this.registry = loadRegistry(this.storage);
  },

  // ---------------- 目标设备与连接 ----------------

  /**
   * 把 `key` 解析成可连接的 deviceId。
   *
   * key 是 hardwareId 优先的稳定标识（见 device-history.deviceKeyOf）；
   * 只有后端记录的设备没有本机 deviceId，本页无法连接，返回 null 并提示。
   */
  resolveTarget(): { deviceId: string; name: string } | null {
    const session = this.session;
    const registry = this.registry ?? { devices: [] };
    const key = this.targetKey;
    if (key.length === 0) {
      const deviceId = session?.transport.currentDeviceId ?? "";
      return deviceId.length > 0 ? { deviceId, name: this.data.deviceName } : null;
    }
    const recent = session?.recentDevices ?? [];
    const match =
      recent.find((entry) => entry.deviceId === key || entry.hardwareId === key) ?? null;
    if (match !== null) {
      const entry = registry.devices.find(
        (item) =>
          item.deviceId === match.deviceId ||
          (match.hardwareId !== undefined && item.hardwareId === match.hardwareId),
      );
      return {
        deviceId: match.deviceId,
        name: entry?.remark ?? match.name ?? match.deviceId,
      };
    }
    /* 登记表里只有 deviceId（没连过）的条目也认，方便从发现页直达。 */
    const entry = registry.devices.find(
      (item) => item.deviceId === key || item.hardwareId === key,
    );
    if (entry !== undefined) {
      return { deviceId: entry.deviceId, name: entry.remark ?? entry.deviceId };
    }
    return null;
  },

  /** 标题优先显示备注名（登记表），其次连接名，最后 deviceId。 */
  applyTargetName() {
    const session = this.session;
    const registry = this.registry ?? { devices: [] };
    const target = this.resolveTarget();
    const deviceId = target?.deviceId ?? session?.transport.currentDeviceId ?? "";
    const entry = registry.devices.find((item) => item.deviceId === deviceId);
    const name =
      entry?.remark ??
      target?.name ??
      session?.deviceInfo?.hwId ??
      (deviceId.length > 0 ? deviceId : "设备");
    this.setData({ deviceName: name, deviceId });
  },

  /**
   * 进入页面时确保连着目标设备。
   *
   * 只做一次：连接失败后不自动重试（避免和用户手动点重试打架），
   * 由页面上的提示条提供重试入口。
   */
  async ensureConnected() {
    const session = this.session;
    if (session === null || this.autoConnectTried) {
      return;
    }
    const target = this.resolveTarget();
    if (target === null) {
      this.setData({ connectHint: "这台设备本机没有连接记录，请到「发现」页扫描" });
      return;
    }
    this.autoConnectTried = true;
    if (session.linkState === "ready" && session.transport.currentDeviceId === target.deviceId) {
      return;
    }
    if (session.linkState === "connecting" || session.linkState === "initializing") {
      return;
    }
    this.setData({ connectBusy: true, connectHint: "" });
    try {
      if (session.linkState === "ready") {
        await session.switchTo(target.deviceId, target.name);
      } else {
        await session.connect(target.deviceId, target.name);
      }
      this.applyTargetName();
    } catch (err) {
      if (err instanceof ConnectCancelledError) {
        return;
      }
      this.setData({ connectHint: `连接失败：${errorText(err)}` });
    } finally {
      this.setData({ connectBusy: false });
    }
  },

  /** 手动重试连接（提示条点击）。 */
  async onRetryConnect() {
    this.autoConnectTried = false;
    this.setData({ connectHint: "" });
    await this.ensureConnected();
  },

  // ---------------- 状态与派生视图 ----------------

  /** 进页面时把会话已有状态铺到界面（切页回来不闪空态）。 */
  syncFromSession() {
    const session = this.session;
    if (session === null) {
      return;
    }
    this.registry = loadRegistry(createWxStorage());
    this.applyLink(session.linkState);
    const state = session.deviceState;
    if (state !== null) {
      this.applyDeviceState(state);
    }
  },

  applyLink(state: LinkState, detail?: LinkDetail) {
    const session = this.session;
    const view = statusView(
      state,
      detail?.deviceName ?? session?.cachedDevice?.name ?? this.data.deviceName,
      detail?.message,
      session?.reconnectPending ?? false,
      (session?.cachedDevice ?? null) !== null,
    );
    const ready = state === "ready";
    this.setData({ ...view, ready });
    if (!ready) {
      this.clearDeviceViews();
      if (state === "idle" && !this.autoConnectTried) {
        void this.ensureConnected();
      }
      return;
    }
    this.applyTargetName();
    /* §9.1 的引脚表由会话在 ready 时异步补齐：这里先按 State 画一版，
     * 读完时 onDeviceConfig 会再触发一次 chips 重画（GPIO 到位）。 */
    const current = session?.deviceState;
    if (current !== null && current !== undefined) {
      this.applyDeviceState(current);
    }
  },

  /** 设备权威的 State → 开关 / 亮度 / 灯带 chips / 段列表。 */
  applyDeviceState(state: DeviceState) {
    const max = effectiveMaxBrightness(state.maxBrightness);
    const brightness = clampBrightness(state.brightness, max);
    this.setData({
      power: state.power,
      powerLabel: powerLabelText(state.power, brightness),
      brightness,
      brightnessDisplay: brightness,
      brightnessPercent: percentOf(brightness, max),
      maxBrightness: max,
      brightnessHintText: brightnessHintText(brightness, this.data.ready),
      ledCount: state.ledCount,
      stripCount: state.stripCount,
    });
    this.applyStripSelection(state);
    void this.refreshStripChips();
  },

  /**
   * 按 State + 登记表算出「当前该操作哪条带」，并把界面切过去。
   *
   * 三条规则（协调者裁定）：
   *  - 当前带仍可见 → 保持（切页回来不跳带）；
   *  - 当前带被隐藏 → 退到第一条可见带；
   *  - 一条都没有 → -1，页面显示空态且不发任何写命令。
   */
  applyStripSelection(state: DeviceState) {
    const enabled = this.visibleStripIds(state);
    const next = pickStripId(state, enabled, this.data.stripId);
    const changed = next !== this.data.stripId;
    if (changed) {
        this.setData({ stripId: next });
    }
    if (next >= 0 && this.session !== null) {
      /* 会话记住选择（跨页保留），但本页所有调用仍显式传 stripId。 */
      this.session.setActiveStripId(next);
    }
    this.applyStripPowerView(state);
    this.setData({
      stripTitle: next >= 0 ? `灯带 ${next + 1}` : "无可见灯带",
      stripHint:
        next >= 0
          ? "切带只重新读设备，不会清掉任何配置"
          : "在「发现」页打开至少一条灯带的显示开关",
    });
    if (changed) {
      void this.refreshSegments();
    }
  },

  /** 可见的灯带号：`State.stripCount` 截断后套用 App 本地启用掩码。 */
  visibleStripIds(state: DeviceState | null): number[] {
    if (state === null) {
      return [];
    }
    const deviceId = this.session?.transport.currentDeviceId ?? "";
    if (deviceId.length === 0) {
      /* 还没拿到 deviceId（极短窗口）：按「全显示」处理，避免空白页。 */
      const ids: number[] = [];
      for (let id = 0; id < Math.min(state.stripCount, MAX_STRIPS); id += 1) {
        ids.push(id);
      }
      return ids;
    }
    return enabledStripIds(this.registry ?? { devices: [] }, deviceId, state.stripCount);
  },

  /** 灯带切换器：逐带真实灯珠数 / GPIO / 开关 / 段数 / 动画标记。 */
  async refreshStripChips() {
    const session = this.session;
    const state = session?.deviceState ?? null;
    if (session === null || state === null) {
      this.setData({ stripChips: [] });
      return;
    }
    const config: StripConfig | null = session.stripConfigs;
    const chips = buildStripChips({
      state,
      config,
      enabled: this.visibleStripIds(state),
      selectedStripId: this.data.stripId,
    }).map((chip) => ({ ...chip, summary: stripChipSummary(chip) }));
    this.setData({ stripChips: chips });
  },

  /** 选中灯的独立开关显示（SetStripPower 的本地镜像）。 */
  applyStripPowerView(state: DeviceState | null) {
    const stripId = this.data.stripId;
    if (state === null || stripId < 0) {
      this.setData({ stripOn: false });
      return;
    }
    this.setData({ stripOn: (state.stripPowerMask & (1 << stripId)) !== 0 });
  },

  clearDeviceViews() {
    this.segmentReports = [];
    this.setData({
      power: 0,
      powerLabel: "已关",
      brightness: 0,
      brightnessDisplay: 0,
      brightnessPercent: 0,
      brightnessHintText: "连接后可调节",
      maxBrightness: effectiveMaxBrightness(undefined),
      colorHintText: "连接后可调节",
      selectedPreset: "",
      stripChips: [],
      stripId: -1,
      stripTitle: "—",
      stripHint: "连接后选择灯带",
      stripOn: false,
      ledCount: 0,
      stripCount: 0,
      quickCards: [],
      quickPanel: null,
      quickDisabledReason: "连接灯控后才能调灯效",
      effectSummary: "还没有灯效",
    });
  },

  // ---------------- 灯带切换 ----------------

  /**
   * 点 chip 切带。
   *
   * **只重新读**：不动设备配置、不动登记表、不重置其他带的段。
   * 顺序按 §9.1：State 已有 → QueryStrip(新带)。
   */
  async onStripTap(e: WechatMiniprogram.TouchEvent) {
    const stripId = Number(e.currentTarget.dataset.stripId ?? -1);
    if (stripId < 0 || stripId === this.data.stripId) {
      return;
    }
    const session = this.session;
    if (session === null) {
      return;
    }
    session.setActiveStripId(stripId);
    this.setData({
      stripId,
      stripTitle: `灯带 ${stripId + 1}`,
      colorHintText: "点一个段改颜色",
    });
    this.applyStripPowerView(session.deviceState);
    await this.refreshSegments();
    await this.refreshStripChips();
    /* 换灯组：快捷参数按组隔离，重画一次就不会带着上一组的值。 */
    this.renderQuick({ quickHint: "" });
  },

  /** 当前灯带的设备独立开关（SetStripPower 0x1B）。 */
  async onToggleStripPower() {
    const session = this.session;
    const stripId = this.data.stripId;
    if (session === null || stripId < 0 || this.data.stripPowerBusy) {
      return;
    }
    this.setData({ stripPowerBusy: true });
    try {
      const result = await session.setStripPower(stripId, !this.data.stripOn);
      if (result.kind === "ok") {
        this.applyDeviceState(result.state);
        return;
      }
      if (result.kind === "ack-error") {
        wx.showToast({ title: resultText(result.ack.resultCode), icon: "none" });
        return;
      }
      if (result.kind === "error") {
        wx.showToast({ title: result.message, icon: "none" });
      }
    } finally {
      this.setData({ stripPowerBusy: false });
    }
  },

  // ---------------- 总闸 ----------------

  async onTogglePower() {
    const session = this.session;
    if (session === null || !this.data.ready || this.data.powerBusy) {
      return;
    }
    this.setData({ powerBusy: true });
    try {
      const result = await session.setPower(this.data.power !== 1);
      if (result.kind === "ok") {
        this.applyDeviceState(result.state);
        wx.vibrateShort?.({ type: "light", fail: () => undefined });
        return;
      }
      if (result.kind === "ack-error") {
        wx.showToast({ title: resultText(result.ack.resultCode), icon: "none" });
        void this.rereadState();
        return;
      }
      if (result.kind === "error") {
        wx.showToast({ title: result.message, icon: "none" });
      }
    } finally {
      this.setData({ powerBusy: false });
    }
  },

  // ---------------- 亮度 ----------------

  onBrightnessChanging(e: WechatMiniprogram.SliderChanging) {
    const value = Number(e.detail.value);
    if (!Number.isFinite(value)) {
      return;
    }
    const now = Date.now();
    if (now - this.lastBrightnessUiAt >= COLOR_UI_INTERVAL_MS) {
      this.lastBrightnessUiAt = now;
      this.setBrightnessView(value, false);
    }
    this.session?.queueBrightness(value);
  },

  onBrightnessChange(e: WechatMiniprogram.SliderChange) {
    const value = Number(e.detail.value);
    if (!Number.isFinite(value)) {
      return;
    }
    this.setBrightnessView(value, true);
    this.session?.commitBrightness(value);
  },

  setBrightnessView(rawValue: number, bindValue: boolean) {
    this.setData(
      brightnessViewPatch(rawValue, this.data.maxBrightness, this.data.ready, bindValue),
    );
  },

  // ---------------- 光区（设备权威，只用于摘要与快捷档反推） ----------------

  /**
   * 从设备读回**当前灯组**的光区列表。
   *
   * 收窄后的设备页不再展示光区明细，但有两件事仍然依赖它：
   *  - 「当前灯效」摘要要知道现在有几个光区 / 是不是某张快捷卡；
   *  - 自定义档的预览与恢复要以设备真实值为起点。
   *
   * `stripId` 显式传给会话：读哪条灯组是本页的决定。切组后必须重读。
   */
  async refreshSegments(): Promise<void> {
    const session = this.session;
    const stripId = this.data.stripId;
    if (session === null || !this.data.ready || stripId < 0) {
      return;
    }
    const result = await session.queryStrip(stripId);
    if (result.kind !== "ok") {
      if (result.kind === "error") {
        this.setData({ quickHint: result.message });
      }
      return;
    }
    /* 只保留属于这条灯组的报告（设备回报的 stripId 是权威，防御脏数据）。 */
    this.segmentReports = result.reports.filter((report) => report.stripId === stripId);
    this.syncQuickFromDevice();
  },

  /** 进设备信息页（身份 / 固件 / 灯珠数 / 自检 / 改名 / 断开 / 删除）。 */
  onGoDeviceInfo() {
    if (!this.data.ready) {
      wx.showToast({ title: "先连接设备", icon: "none" });
      return;
    }
    pushTo(PAGE_ROUTES.deviceInfo);
  },

  // ---------------- 编辑档位（快捷 / 自定义） ----------------

  /**
   * 切换编辑档位。
   *
   * #57 把「切走前存快照 / 切回时恢复编排」接在这里；本轮（#54）只有快捷档
   * 完整，自定义档先给出占位说明。
   */
  onModeTap(e: WechatMiniprogram.TouchEvent) {
    const mode = String(e.currentTarget.dataset.mode ?? "");
    if (mode !== "quick" && mode !== "custom") {
      return;
    }
    if (mode === this.data.effectMode) {
      return;
    }
    this.setData({ effectMode: mode, quickHint: "" });
    if (mode === "quick") {
      this.renderQuick();
      return;
    }
    this.renderCustom();
  },

  /** 「当前灯效」摘要点击：滚到编辑区（摘要本身就是入口）。 */
  onEffectSummaryTap() {
    if (!this.data.ready) {
      wx.showToast({ title: "先连接灯控", icon: "none" });
      return;
    }
    wx.pageScrollTo?.({ selector: ".mode-switch", duration: 220, fail: () => undefined });
  },

  // ---------------- 快捷档（#54） ----------------
  // 语义：点一张卡 = 整组变成该效果。所以每次下发都是「一个覆盖整组的
  // 单层光区」，`SetSegment` 是绝对值命令，重复下发只覆盖自己 → 防抖安全。

  /** 当前灯组可用的快捷参数（没有记录时用卡片默认值）。 */
  quickParamsOf(cardId: string | null): QuickParams {
    if (cardId === null) {
      return {};
    }
    return this.quickParamsByStrip.get(this.data.stripId) ?? {};
  },

  /** 自定义档的占位重画（#55/#56 接入真正的编排视图）。 */
  renderCustom(): void {
    this.setData({ customHint: "自定义编排即将开放" });
  },

  /** 重画卡片 + 参数区 + 摘要。 */  renderQuick(patch: Record<string, unknown> = {}): void {
    const cardId = this.quickCardByStrip.get(this.data.stripId) ?? null;
    const params = this.quickParamsOf(cardId);
    const disabledReason = this.quickDisabledReasonOf();
    this.setData({
      quickCards: buildQuickCardViews(cardId, params),
      quickPanel: buildQuickPanel(cardId, params),
      quickPresetFlags: quickPresetFlags(params),
      quickDisabledReason: disabledReason,
      effectSummary: this.effectSummaryText(cardId, params),
      ...patch,
    });
  },

  /** 为什么不能点（未连接 / 没有灯组 / 灯珠数未知）。 */
  quickDisabledReasonOf(): string {
    if (!this.data.ready) {
      return "连接灯控后才能调灯效";
    }
    if (this.data.stripId < 0) {
      return "先在「发现」页打开至少一条灯组";
    }
    if (this.data.ledCount < 1) {
      return "还没读到这组的灯珠数量，稍等片刻";
    }
    return "";
  },

  /** 设备控制页要显示的一行「现在亮的是什么」。 */
  effectSummaryText(cardId: string | null, params: QuickParams): string {
    if (this.data.effectMode === "custom") {
      return "自定义编排（点这里继续编辑）";
    }
    const card = cardId === null ? null : quickCardOf(cardId);
    if (card === null) {
      return this.segmentReports.length > 0 ? `${this.segmentReports.length} 个光区` : "还没有灯效";
    }
    const extra = Object.keys(params).length > 0 ? "" : "";
    return `${card.name}${extra}`;
  },

  /** 从设备读回的段推断「现在大概是哪张卡」（判断不出就不高亮）。 */
  syncQuickFromDevice(): void {
    const stripId = this.data.stripId;
    if (stripId < 0) {
      return;
    }
    /* 整组只有一个覆盖全条的光区时，才有「某张快捷卡」可言。 */
    const reports = this.segmentReports;
    if (reports.length !== 1) {
      if (!this.quickCardByStrip.has(stripId)) {
        this.quickCardByStrip.delete(stripId);
      }
      this.renderQuick();
      return;
    }
    const only = reports[0];
    const coversWhole = only.start === 0 && only.end >= Math.max(0, this.data.ledCount - 1);
    const inferred = coversWhole && only.layer1.type === NO_EFFECT ? inferQuickCard(only.layer0) : null;
    if (inferred === null) {
      this.quickCardByStrip.delete(stripId);
    } else {
      this.quickCardByStrip.set(stripId, inferred);
      /* 从设备反推时也把参数回填成设备真实值，界面不显示「默认档」骗用户。 */
      this.quickParamsByStrip.set(stripId, this.paramsFromLayer(only));
    }
    this.renderQuick();
  },

  /** 设备的一层灯效 → 快捷档参数（只取该形态能表达的档位）。 */
  paramsFromLayer(report: SegmentReport): QuickParams {
    const layer = report.layer0;
    const params: QuickParams = { hue: layer.hue, sat: layer.sat };
    return params;
  },

  onQuickCardTap(e: WechatMiniprogram.TouchEvent) {
    const cardId = String(e.currentTarget.dataset.cardId ?? "");
    const card = quickCardOf(cardId);
    if (card === null || this.quickDisabledReasonOf() !== "" || this.data.quickBusy) {
      return;
    }
    /* 换卡时参数回到该卡默认值：把「呼吸的最暗档」带进「流光」是没有意义的。 */
    this.quickCardByStrip.set(this.data.stripId, card.id);
    this.quickParamsByStrip.set(this.data.stripId, {});
    this.renderQuick({ quickHint: "" });
    this.scheduleQuickWrite(true);
  },

  /** 参数选择（三档按钮）。 */
  onQuickChoiceTap(e: WechatMiniprogram.TouchEvent) {
    const key = String(e.currentTarget.dataset.key ?? "");
    const value = String(e.currentTarget.dataset.value ?? "");
    if (key !== "speed" && key !== "level" && key !== "tail" && key !== "direction") {
      return;
    }
    const cardId = this.quickCardByStrip.get(this.data.stripId) ?? null;
    if (cardId === null || this.quickDisabledReasonOf() !== "") {
      return;
    }
    const params = { ...this.quickParamsOf(cardId), [key]: value } as QuickParams;
    this.quickParamsByStrip.set(this.data.stripId, params);
    this.renderQuick();
    this.scheduleQuickWrite(false);
  },

  /** 颜色预设（同一套色块，选中态由协议值反推）。 */
  onQuickPresetTap(e: WechatMiniprogram.TouchEvent) {
    const index = Number(e.currentTarget.dataset.index ?? -1);
    const preset = PRESETS[index];
    const cardId = this.quickCardByStrip.get(this.data.stripId) ?? null;
    if (preset === undefined || cardId === null || this.quickDisabledReasonOf() !== "") {
      return;
    }
    const converted = rgbToSegmentParams(preset.rgb);
    this.quickParamsByStrip.set(this.data.stripId, {
      ...this.quickParamsOf(cardId),
      hue: converted.hue,
      sat: converted.sat,
    });
    this.renderQuick();
    this.scheduleQuickWrite(false);
  },

  /** 彩虹饱和度（0-100 → 协议 sat 0-255）。 */
  onQuickSaturationChanging(e: WechatMiniprogram.SliderChanging) {
    this.applyQuickSaturation(Number(e.detail.value), false);
  },

  onQuickSaturationChange(e: WechatMiniprogram.SliderChange) {
    this.applyQuickSaturation(Number(e.detail.value), true);
  },

  applyQuickSaturation(percent: number, commit: boolean) {
    const cardId = this.quickCardByStrip.get(this.data.stripId) ?? null;
    if (cardId === null || !Number.isFinite(percent) || this.quickDisabledReasonOf() !== "") {
      return;
    }
    const sat = Math.max(0, Math.min(255, Math.round((percent / 100) * 255)));
    this.quickParamsByStrip.set(this.data.stripId, {
      ...this.quickParamsOf(cardId),
      sat,
    });
    this.renderQuick();
    /* 拖动期间不写设备（会连发几十帧），松手才写。 */
    if (commit) {
      this.scheduleQuickWrite(true);
    }
  },

  /**
   * 300ms 防抖写入（票面：改动后 300ms 内设备状态更新，无需按钮）。
   *
   * `immediate` 用于「点卡片 / 松手」这类离散操作：它们没有后续拖动，
   * 等 300ms 只是让界面显得迟钝，所以立刻写。
   */
  scheduleQuickWrite(immediate: boolean) {
    this.quickEpoch += 1;
    const epoch = this.quickEpoch;
    if (this.quickTimer !== null) {
      clearTimeout(this.quickTimer);
      this.quickTimer = null;
    }
    const fire = () => {
      this.quickTimer = null;
      if (epoch !== this.quickEpoch) {
        return;
      }
      void this.writeQuick();
    };
    if (immediate) {
      fire();
      return;
    }
    this.quickTimer = setTimeout(fire, 300);
  },

  /**
   * 把当前卡片 + 参数写成「整组单层光区」并发给设备。
   *
   * 两个必须做对的地方：
   *  1. **方案播放期间实时光区不可见** → 先 `SetPlayback(stop)` 并提示；
   *  2. **失败要如实** → 重新 `queryStrip` 读回设备真实值刷新界面，绝不
   *     留一个假的成功画面。
   */
  async writeQuick(): Promise<void> {
    const session = this.session;
    const stripId = this.data.stripId;
    const cardId = this.quickCardByStrip.get(stripId) ?? null;
    const card = cardId === null ? null : quickCardOf(cardId);
    if (session === null || card === null || this.quickDisabledReasonOf() !== "") {
      return;
    }
    if (this.data.quickBusy) {
      /* 正在写：让本轮防抖再来一次（不并发发帧）。 */
      this.scheduleQuickWrite(false);
      return;
    }
    this.setData({ quickBusy: true });
    try {
      /* 方案播放中：设备按 active_segments 渲染，实时光区看不见。 */
      const state = session.deviceState;
      if (state !== null && state.playbackState !== 0) {
        await session.setPlayback(0, state.flags & 0x01 ? true : false);
        this.setData({ quickHint: "已停止方案，改为实时灯效" });
        wx.showToast({ title: "已停止方案，改为实时灯效", icon: "none" });
      }
      const ledCount = this.data.ledCount > 0 ? this.data.ledCount : this.session?.stripLedCount(stripId) ?? 0;
      const spec = buildQuickSpec(card, this.quickParamsOf(cardId), stripId, ledCount);
      /*
       * 协议要求同带光区不重叠（§9.2「调用方需先清段」），而快捷档的语义是
       * 「整组变成这一个效果」。所以先清掉这条灯组上除槽位 0 以外的光区，
       * 否则多光区的灯组会被设备回 InvalidParam——用户点了卡片却毫无变化。
       */
      const others = this.segmentReports.filter(
        (report) => report.stripId === stripId && report.segId !== 0,
      );
      for (const report of others) {
        const cleared = await session.clearSegment(stripId, report.segId);
        if (!cleared.ok) {
          throw new Error(resultText(cleared.resultCode));
        }
      }
      const ack = await session.setSegment(spec);
      if (!ack.ok) {
        throw new Error(resultText(ack.resultCode));
      }
      this.setData({ quickHint: `${card.name} 已生效` });
      /* 写成功后重新读回，段列表 / 摘要以设备为准。 */
      await this.refreshSegments();
      await this.refreshStripChips();
    } catch (err) {
      /* 失败：读回真实状态并说明原因（不保留假的成功画面）。 */
      const message = errorText(err);
      this.setData({ quickHint: `写入失败：${message}` });
      wx.showToast({ title: `写入失败：${message}`, icon: "none" });
      await this.refreshSegments();
    } finally {
      this.setData({ quickBusy: false });
    }
  },

  async rereadState() {
    try {
      const state = await this.session?.refreshState();
      if (state !== undefined) {
        this.applyDeviceState(state);
      }
    } catch {
      /* 读失败等下一次 State 同步纠正。 */
    }
  },
});
