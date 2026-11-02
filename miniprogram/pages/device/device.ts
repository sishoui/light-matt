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
import { COLOR_UI_INTERVAL_MS, WheelView } from "../../utils/control/wheel-view";
import { activeCount, buildSegmentRows, type SegmentRow } from "../../utils/control/segment-view";
import {
  buildStripChips,
  pickStripId,
  stripChipSummary,
  type StripChip,
} from "../../utils/control/strip-chips";
import { ControlSession } from "../../utils/control/session";
import { getSession, isMockSession } from "../../utils/control/session-singleton";
import { loadTheme, themeClass, type ThemeMode } from "../../utils/control/theme";
import {
  PAGE_ROUTES,
  TAB_ROUTES,
  pushTo,
  queryText,
  switchTabTo,
} from "../../utils/control/routes";
import { statusView } from "../../utils/control/status-view";
import { hsvForWheel, PRESETS, rgbToHex, segmentHueSatToRgb } from "../../utils/color/hsv";
import { MAX_SEGMENTS, MAX_STRIPS, NO_EFFECT } from "../../utils/protocol/constants";
import type {
  DeviceState,
  LinkState,
  RGB,
  SegmentReport,
  SegmentTarget,
  StripConfig,
} from "../../utils/protocol/types";

/** chip 的展示形状 = 纯视图模型 + 一行摘要文本。 */
interface StripChipView extends StripChip {
  summary: string;
}

/** 首屏色环位置与暖白预设对齐（真值来自预设表，不另写一份）。 */
const INITIAL_HSV = hsvForWheel(PRESETS[0].rgb, 0);

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

    // 段列表（设备权威）
    segmentRows: [] as SegmentRow[],
    segmentMaxCount: MAX_SEGMENTS,
    segmentHintText: "",
    segmentBusy: false,

    // 颜色 / 预设（写入选中段）
    presetList: PRESETS,
    colorHex: PRESETS[0].hex,
    colorHue: INITIAL_HSV.h,
    colorSaturation: Math.round(INITIAL_HSV.s * 100),
    selectedPreset: PRESETS[0].name,
    colorHintText: "连接后可调节",

    ledCount: 0,
    stripCount: 0,
  },

  session: null as ControlSession | null,
  wheelView: null as WheelView | null,
  pageReady: false,
  lastBrightnessUiAt: 0,
  /** 设备权威的段列表原始数据（data.segmentRows 是它的派生视图）。 */
  segmentReports: [] as SegmentReport[],
  selectedSegId: -1,
  registry: null as DeviceRegistry | null,
  storage: null as SessionStorage | null,
  unsubscribers: [] as Array<() => void>,
  /** 从首页带过来的设备 key（hardwareId 优先，空表示「连当前已连接的」）。 */
  targetKey: "",
  themeMode: "system" as ThemeMode,
  /** 是否已经为这台设备发起过连接（避免 onShow 重复连接）。 */
  autoConnectTried: false,

  onLoad(options: Record<string, string | undefined>) {
    /* 页面私有状态（不进 data）。Page() 不保证对象字面量字段会被复制到
     * 实例上，所以在这里显式兜底——漏掉会让 onLoad / onUnload 抛
     * TypeError 并中断整页的事件绑定。 */
    this.unsubscribers = [];
    this.segmentReports = [];
    this.selectedSegId = -1;
    this.pageReady = false;
    this.lastBrightnessUiAt = 0;
    this.targetKey = "";
    this.autoConnectTried = false;
    this.registry = null;

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

    this.wheelView = new WheelView(
      {
        setData: (patch) => this.setData(patch),
        isReady: () => this.data.ready,
        hasActiveSegment: () => this.currentTarget() !== null,
        activeSegmentRange: () => this.activeRange(),
        queueColor: (rgb) => this.session?.queueColor(rgb, this.currentTarget() ?? undefined),
        commitColor: (rgb) => this.session?.commitColor(rgb, this.currentTarget() ?? undefined),
        notifySelectSegment: () => this.showSelectSegmentNotice(),
      },
      { hue: INITIAL_HSV.h, saturation: INITIAL_HSV.s },
    );

    this.applyTargetName();
  },

  onReady() {
    this.pageReady = true;
    this.initWheel();
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
    if (!this.pageReady) {
      return;
    }
    if (this.wheelView === null || !this.wheelView.canDraw) {
      this.initWheel();
    } else {
      this.wheelView.redraw();
    }
  },

  onHide() {
    this.unsubscribe();
  },

  onUnload() {
    /* 二级页会被真正卸载；但会话属于 App，绝不 destroy。 */
    this.unsubscribe();
    this.wheelView = null;
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
    const rgb: RGB = { r: state.r, g: state.g, b: state.b };
    const hsv = this.wheelView?.assign(rgb) ?? hsvForWheel(rgb, INITIAL_HSV.h);
    this.setData({
      power: state.power,
      powerLabel: powerLabelText(state.power, brightness),
      brightness,
      brightnessDisplay: brightness,
      brightnessPercent: percentOf(brightness, max),
      maxBrightness: max,
      brightnessHintText: brightnessHintText(brightness, this.data.ready),
      colorHex: rgbToHex(rgb),
      colorHue: hsv.h,
      colorSaturation: Math.round(hsv.s * 100),
      ledCount: state.ledCount,
      stripCount: state.stripCount,
    });
    this.wheelView?.redraw();
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
      this.selectedSegId = -1;
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
    this.selectedSegId = -1;
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
      segmentRows: [],
      segmentHintText: "",
      stripChips: [],
      stripId: -1,
      stripTitle: "—",
      stripHint: "连接后选择灯带",
      stripOn: false,
      ledCount: 0,
      stripCount: 0,
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
    this.selectedSegId = -1;
    session.setActiveStripId(stripId);
    this.setData({
      stripId,
      segmentRows: [],
      segmentHintText: "正在读取该灯带…",
      stripTitle: `灯带 ${stripId + 1}`,
      colorHintText: "点一个段改颜色",
    });
    this.applyStripPowerView(session.deviceState);
    await this.refreshSegments();
    await this.refreshStripChips();
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

  // ---------------- 段列表（设备权威） ----------------

  /**
   * 从设备读回**当前灯带**的段列表。
   *
   * `stripId` 显式传给会话：读哪条带是本页的决定。切带后必须重读，
   * 因为主界面显示的是「这条带的段」。
   */
  async refreshSegments(keepSegId?: number): Promise<void> {
    const session = this.session;
    const stripId = this.data.stripId;
    if (session === null || !this.data.ready || stripId < 0) {
      return;
    }
    const result = await session.queryStrip(stripId);
    if (result.kind !== "ok") {
      if (result.kind === "error") {
        this.setData({ segmentHintText: result.message });
      }
      return;
    }
    /* 只保留属于这条带的报告（设备回报的 stripId 是权威，防御脏数据）。 */
    this.segmentReports = result.reports.filter((report) => report.stripId === stripId);
    const current = keepSegId !== undefined ? keepSegId : this.selectedSegId;
    const stillThere = this.segmentReports.some((report) => report.segId === current);
    this.applySegmentRows(stillThere ? current : -1);
  },

  applySegmentRows(segId: number) {
    this.selectedSegId = segId >= 0 ? segId : -1;
    const rows = buildSegmentRows(
      this.segmentReports,
      segId >= 0 ? segId : null,
      segmentHueSatToRgb,
    );
    const report = this.segmentReports.find((item) => item.segId === segId);
    /* 把「当前编辑的段」交给会话：剧本页读它来「把当前段加进阶段」。
     * 这是跨页的唯一共享状态，属于会话而不是某个页面。 */
    this.session?.setActiveSegment(this.currentTarget());
    if (report !== undefined) {
      const rgb = segmentHueSatToRgb(report.hue, report.sat);
      const hsv = this.wheelView?.assign(rgb) ?? hsvForWheel(rgb, INITIAL_HSV.h);
      /* #48：两层段要明确告诉用户「改色只改第 1 层、第 2 层与 blend 保留」，
       * 否则用户会怕点一下颜色把辛苦配好的第二层弄丢。 */
      const layered =
        report.layer1.type !== NO_EFFECT
          ? `（两层段：改色只改第 1 层颜色，第 2 层与混合方式保留）`
          : "";
      this.setData({
        segmentRows: rows,
        colorHex: rgbToHex(rgb),
        colorHue: hsv.h,
        colorSaturation: Math.round(hsv.s * 100),
        colorHintText: `正在编辑 段 ${report.segId}（灯珠 ${report.start}-${report.end}）${layered}`,
      });
      this.wheelView?.redraw();
    } else {
      this.setData({
        segmentRows: rows,
        colorHintText: this.data.ready
          ? "点一个段改颜色，或新建一个区间"
          : "连接后可调节",
      });
    }
    this.setData({
      segmentHintText:
        rows.length === 0
          ? "这条灯带还没有段。点「新建段」划一个灯珠区间。"
          : `共 ${activeCount(rows)} / ${MAX_SEGMENTS} 段`,
    });
  },

  /** 当前选中段（颜色控件要写的位置）；没有则 null。 */
  currentTarget(): SegmentTarget | null {
    const stripId = this.data.stripId;
    if (stripId < 0 || this.selectedSegId < 0) {
      return null;
    }
    const report = this.segmentReports.find((item) => item.segId === this.selectedSegId);
    if (report === undefined) {
      return null;
    }
    return { stripId, segId: report.segId, start: report.start, end: report.end };
  },

  /** 色环提示用的区间（不含 stripId，WheelHost 的形状）。 */
  activeRange(): { segId: number; start: number; end: number } | null {
    const target = this.currentTarget();
    return target === null ? null : { segId: target.segId, start: target.start, end: target.end };
  },

  onSegmentTap(e: WechatMiniprogram.TouchEvent) {
    const segId = Number(e.currentTarget.dataset.segId ?? -1);
    if (segId < 0) {
      return;
    }
    this.applySegmentRows(segId);
  },

  /** 删除某段：该段的灯珠归入未覆盖区（熄灭）。stripId 显式传。 */
  async onSegmentDelete(e: WechatMiniprogram.TouchEvent) {
    const session = this.session;
    const stripId = this.data.stripId;
    if (session === null || stripId < 0 || this.data.segmentBusy || !this.data.ready) {
      return;
    }
    const segId = Number(e.currentTarget.dataset.segId ?? -1);
    if (segId < 0) {
      return;
    }
    this.setData({ segmentBusy: true, segmentHintText: "正在删除…" });
    try {
      const ack = await session.clearSegment(stripId, segId);
      if (!ack.ok) {
        const message = `删除失败：${resultText(ack.resultCode)}`;
        this.setData({ segmentHintText: message });
        wx.showToast({ title: message, icon: "none" });
        return;
      }
      this.setData({ segmentHintText: `段 ${segId} 已删除（其灯珠熄灭）` });
      await this.refreshSegments(this.selectedSegId === segId ? -1 : this.selectedSegId);
      await this.refreshStripChips();
    } catch (err) {
      const message = errorText(err);
      this.setData({ segmentHintText: message });
      wx.showToast({ title: message, icon: "none" });
    } finally {
      this.setData({ segmentBusy: false });
    }
  },

  async onRefreshSegments() {
    await this.refreshSegments();
  },

  /** 进段编辑页：把当前灯带与选中段带过去（草稿从设备读）。 */
  onEditSegment(e: WechatMiniprogram.TouchEvent) {
    const stripId = this.data.stripId;
    if (stripId < 0) {
      wx.showToast({ title: "先选一条灯带", icon: "none" });
      return;
    }
    const segId = Number(e.currentTarget.dataset.segId ?? this.selectedSegId);
    pushTo(PAGE_ROUTES.segmentEdit, { stripId, segId });
  },

  /** 去「剧本」tab（剧本是独立编辑器）。 */
  onGoScripts() {
    switchTabTo(TAB_ROUTES.scripts);
  },

  /** 进设备信息页（身份 / 固件 / 灯珠数 / 自检 / 改名 / 断开 / 删除）。 */
  onGoDeviceInfo() {
    if (!this.data.ready) {
      wx.showToast({ title: "先连接设备", icon: "none" });
      return;
    }
    pushTo(PAGE_ROUTES.deviceInfo);
  },

  // ---------------- 颜色（写入选中段） ----------------

  initWheel() {
    const view = this.wheelView;
    if (view === null) {
      return;
    }
    const query = wx.createSelectorQuery();
    query
      .select("#color-wheel")
      .fields({ node: true, size: true })
      .exec((res: Array<{ node?: WechatMiniprogram.Canvas; width?: number }> | undefined) => {
        const node = res?.[0]?.node;
        const width = Number(res?.[0]?.width ?? 0);
        view.attach(node ?? null, width, this.pixelRatio());
      });
  },

  pixelRatio(): number {
    try {
      const info = wx.getWindowInfo?.() ?? wx.getSystemInfoSync();
      const ratio = Number((info as { pixelRatio?: number }).pixelRatio ?? 2);
      return Number.isFinite(ratio) && ratio > 0 ? ratio : 2;
    } catch {
      return 2;
    }
  },

  onWheelTouchStart(e: WechatMiniprogram.TouchCanvas) {
    this.wheelView?.handleTouch(e);
  },

  onWheelTouchMove(e: WechatMiniprogram.TouchCanvas) {
    this.wheelView?.handleTouch(e);
  },

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
   * 预设：把**选中段**改成该颜色（SetSegment 0x10），等 ACK。
   * 没有选中段时提示先选一段，绝不发帧。
   */
  async onPresetTap(e: WechatMiniprogram.TouchEvent) {
    const session = this.session;
    if (session === null || !this.data.ready) {
      return;
    }
    const index = Number(e.currentTarget.dataset.index ?? -1);
    const preset = PRESETS[index];
    if (preset === undefined) {
      return;
    }
    const target = this.currentTarget();
    if (target === null) {
      this.showSelectSegmentNotice();
      return;
    }
    const result = await session.applyPreset(preset.rgb, target);
    if (result.kind === "ok") {
      const hsv = this.wheelView?.assign(preset.rgb) ?? hsvForWheel(preset.rgb, INITIAL_HSV.h);
      this.setData({
        colorHex: preset.hex,
        colorHue: hsv.h,
        colorSaturation: Math.round(hsv.s * 100),
        selectedPreset: preset.name,
      });
      this.wheelView?.redraw();
      await this.refreshSegments(target.segId);
      return;
    }
    if (result.kind === "ack-error") {
      wx.showToast({ title: `预设被拒：${resultText(result.ack.resultCode)}`, icon: "none" });
      return;
    }
    if (result.kind === "error") {
      wx.showToast({ title: result.message, icon: "none" });
    }
  },

  showSelectSegmentNotice() {
    wx.showToast({ title: "先选一个灯珠区间", icon: "none" });
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
