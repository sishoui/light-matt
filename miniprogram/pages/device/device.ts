/**
 * 设备详情页（二级页）：从首页大卡进入，**只管设备级**。
 *
 * ## 本页的职责边界（#63）
 *
 * 设备页只回答三个问题：
 *  1. 这台设备开着没有？整台亮度多少？（总开关 + 全局亮度）
 *  2. 它有哪些灯组、各自亮着什么？（两列灯组卡片 + 每组自己的开关）
 *  3. 这台设备本身是什么？（固件 / 硬件号 / 灯组数 / 灯珠总数，只读）
 *
 * **任何灯效编辑都不在本页**：效果卡、参数、光区、步骤、方案都搬到
 * `pages/strip/strip`（#64–#67 逐票实现）。协议也没有「逐灯组亮度」——
 * 只有全局 brightness 与逐组 strip_power_mask，所以本页不画逐组亮度。
 *
 * ## 进入时的连接语义
 *
 * 首页只负责「浏览」，所以本页必须自己把目标设备连上：
 *  - 已连着它 → 什么都不做；
 *  - 连着别的设备 → `switchTo`（主动切换，失败停在未连接并给重试）；
 *  - 没连着 → `connect`。
 *
 * ## 关键不变量
 *
 *  - **灯珠数逐组真实**：卡片用 `State.stripCounts[stripId]`，绝不拿
 *    `State.ledCount`（按协议它只是 strip 0 的派生值）；
 *  - **组开关是一条 O(1) 命令**：只翻 `strip_power_mask` 的一位，其他组继续运行；
 *  - **启用掩码只过滤显示**：被隐藏的灯组不出现，但绝不因此下发任何配置；
 *  - **点卡片开关不导航**：开关包在 `catchtap` 里，抢掉卡片主体的点击。
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
import { layerModeNameOf } from "../../utils/control/effect-view";
import { PAGE_ROUTES, pushTo, queryText } from "../../utils/control/routes";
import { ControlSession } from "../../utils/control/session";
import { getSession, isMockSession } from "../../utils/control/session-singleton";
import { statusView } from "../../utils/control/status-view";
import { deviceKeyOf } from "../../utils/control/device-history";
import {
  resolveStripMetas,
  setStripName,
  setStripPhoto,
  type ResolvedStripMeta,
} from "../../utils/control/strip-meta";
import { deleteDevicePhotoFile, pickDevicePhoto } from "../../utils/control/device-photo";
import type { ThemeMode } from "../../utils/control/theme";
import { pageThemeData } from "../../utils/control/page-theme";
import {
  BRIGHTNESS_UI_INTERVAL_MS,
  brightnessHintText,
  brightnessViewPatch,
  powerLabelText,
} from "../../utils/control/view-model";
import { MAX_STRIPS, NO_EFFECT } from "../../utils/protocol/constants";
import type { DeviceState, LinkState, SegmentReport } from "../../utils/protocol/types";

/** 一张灯组卡片（WXML 直接渲染）。 */
interface StripCardView {
  /** 灯组号 0-7；既是导航参数也是开关命令的参数。 */
  stripId: number;
  /** 展示名：用户起的名字，或默认「灯组 N」（#94）。 */
  label: string;
  /** 展示封面：用户选的图，或按灯组号固定分配的占位图（#94）。 */
  photo: string;
  /** 封面是不是用户选的（决定长按菜单里「更换封面」的文案）。 */
  photoIsCustom: boolean;
  /** 该组真实灯珠数（`State.stripCounts[stripId]`）。 */
  ledCount: number;
  /** 当前效果摘要（设备读回的光区派生，不是本地草稿）。 */
  summary: string;
  /** 该组自己的开关位（`State.stripPowerMask`）。 */
  on: boolean;
  /** 该组当前有动画类光区（`State.stripAnimMask`，只作显示提示）。 */
  animating: boolean;
  /** 这一组的开关命令还在路上。 */
  busy: boolean;
}

Page({
  data: {
    themeClass: "",
    /** 实际深色（含「跟随系统」解析）。 */
    dark: false,
    /** 原生 slider / switch 的激活色（不读 CSS 变量）。 */
    accentColor: "",
    mock: false,

    /* ---- 连接 ---- */
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

    /**
     * 标题下的副标题（#94）：连接状态收在这里，不再单独占一条状态栏。
     * 点它可重连（未连接 / 连接失败时）。
     */
    navSubtitle: "未连接",

    /* 右上角下拉菜单（#61）：nav-bar 没有 slot，菜单在本页自建。 */
    menuOpen: false,
    /** 菜单面板的 top（px）= 状态栏高度 + nav-bar 的 44px 标题行。 */
    menuTop: 88,

    /* ---- 总开关 ---- */
    power: 0 as 0 | 1,
    powerBusy: false,
    powerLabel: "已关",

    /* ---- 整台设备的亮度（协议只有全局亮度） ---- */
    brightness: 0,
    brightnessDisplay: 0,
    brightnessPercent: 0,
    maxBrightness: 255,
    brightnessHintText: "连接后可调节",

    /* ---- 灯组卡片 ---- */
    stripCards: [] as StripCardView[],

    /* ---- 灯组长按菜单（#94） ---- */
    stripMenuOpen: false,
    /** 菜单当前针对的灯组号（-1 表示没有）。 */
    stripMenuId: -1,
    stripMenuName: "",
    stripMenuPhotoIsCustom: false,

    /* ---- 只读设备摘要 ---- */
    firmwareText: "—",
    hwId: "—",
    stripCount: 0,
    ledTotal: 0,
  },

  session: null as ControlSession | null,
  registry: null as DeviceRegistry | null,
  storage: null as SessionStorage | null,
  unsubscribers: [] as Array<() => void>,
  /** 从首页带过来的设备 key（hardwareId 优先，空表示「连当前已连接的」）。 */
  targetKey: "",
  themeMode: "system" as ThemeMode,
  /** 是否已经为这台设备发起过连接（避免 onShow 重复连接）。 */
  autoConnectTried: false,
  /** 亮度拖动的界面节流时间戳（避免每帧 setData）。 */
  lastBrightnessUiAt: 0,
  /** 菜单里的断开连接正在进行（防重复点击）。 */
  menuBusy: false,
  /** 灯组长按 / 改名 / 换封面进行中（防重复提交）。 */
  stripMetaBusy: false,
  /** 每条灯组的当前效果摘要（设备读回，按灯组缓存）。 */
  stripSummaries: new Map<number, string>(),
  /** 摘要刷新代次：并发刷新时旧一轮静默退出，不覆盖新一轮。 */
  summaryEpoch: 0,
  /** 正在下发组开关命令的灯组号（防重复点击）。 */
  stripBusyIds: new Set<number>(),

  onLoad(options: Record<string, string | undefined>) {
    /* 页面私有状态（不进 data）。Page() 不保证对象字面量字段会被复制到
     * 实例上，所以在这里显式兜底——漏掉会让 onLoad / onUnload 抛
     * TypeError 并中断整页的事件绑定。 */
    this.unsubscribers = [];
    this.session = null;
    this.registry = null;
    this.storage = null;
    this.targetKey = "";
    this.themeMode = "system";
    this.autoConnectTried = false;
    this.lastBrightnessUiAt = 0;
    this.menuBusy = false;
    this.stripMetaBusy = false;
    this.stripSummaries = new Map<number, string>();
    this.summaryEpoch = 0;
    this.stripBusyIds = new Set<number>();

    const storage = createWxStorage();
    this.storage = storage;
    const theme = pageThemeData(storage);
    this.themeMode = theme.themeClass === "theme-dark" ? "dark" : theme.themeClass === "theme-light" ? "light" : "system";
    this.registry = loadRegistry(storage);
    this.targetKey = queryText(options, "key", "");

    this.session = getSession();

    this.setData({
      ...theme,
      mock: isMockSession(),
      menuTop: this.navBottom(),
    });

    this.applyTargetName();
  },

  /** nav-bar 的下边界（px）= 状态栏高度 + 44px 标题行；菜单贴着它展开。 */
  navBottom(): number {
    let statusBarHeight = 44;
    try {
      const info = wx.getWindowInfo?.() ?? wx.getSystemInfoSync();
      const height = Number((info as { statusBarHeight?: number }).statusBarHeight);
      if (Number.isFinite(height) && height > 0) {
        statusBarHeight = height;
      }
    } catch {
      /* 取不到就用兜底值：与 nav-bar 组件的兜底一致。 */
    }
    return statusBarHeight + 44;
  },

  onShow() {
    /* 本页原来**完全**不刷新主题（#90 断点之二）：从「我的」页切完深色进来
     * 仍是旧配色。现在每次显示都重读。 */
    this.setData({ ...pageThemeData(this.storage ?? createWxStorage()) });
    this.subscribe();
    /* `syncFromSession` → `applyLink` 里会铺状态，并在 ready 时重读各灯组的
     * 效果摘要（用户可能在灯组页改过效果，返回本页要看到新的）。 */
    this.syncFromSession();
    void this.session?.onShow();
    void this.ensureConnected();
  },

  onHide() {
    this.unsubscribe();
    /* 离开页面时收起菜单：否则返回时遮罩还在，第一下点击会被它吃掉。 */
    if (this.data.menuOpen) {
      this.setData({ menuOpen: false });
    }
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
      /* 固件版本 / 硬件号由会话在 ready 后异步补齐：到位后重画摘要与标题。 */
      session.onDeviceConfig(() => {
        this.applyDeviceSummary();
        this.applyTargetName();
      }),
    ];
  },

  unsubscribe() {
    for (const off of this.unsubscribers ?? []) {
      off();
    }
    this.unsubscribers = [];
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

  /** 手动重试连接（提示条 / 状态条点击；已连接时什么也不做）。 */
  async onRetryConnect() {
    if (this.data.ready) {
      return;
    }
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
    this.setData({
      ...view,
      ready,
      /* #94：连接状态收进副标题，不再单独占一条状态栏。 */
      navSubtitle: this.navSubtitleOf(state, view, detail),
    });
    if (!ready) {
      this.clearDeviceViews();
      if (state === "idle" && !this.autoConnectTried) {
        void this.ensureConnected();
      }
      return;
    }
    this.applyTargetName();
    const current = session?.deviceState;
    if (current !== null && current !== undefined) {
      this.applyDeviceState(current);
    }
    /* 刚连上：光区列表由页面按需读（每条灯组一次），读回来才有「效果摘要」。 */
    void this.refreshStripSummaries();
  },

  /** 设备权威的 State → 总开关 / 全局亮度 / 灯组卡片 / 只读摘要。 */
  applyDeviceState(state: DeviceState) {
    const max = effectiveMaxBrightness(state.maxBrightness);
    const brightness = clampBrightness(state.brightness, max);
    const ready = this.data.ready;
    this.setData({
      power: state.power,
      powerLabel: powerLabelText(state.power, brightness),
      brightness,
      brightnessDisplay: brightness,
      brightnessPercent: percentOf(brightness, max),
      maxBrightness: max,
      brightnessHintText: brightnessHintText(brightness, ready),
      /* 未连接时不画卡片与摘要：`clearDeviceViews` 已经清空，连接过程中设备
       * 会先报几帧 State，这里不能把「上一次连接」的画面又填回来。 */
      stripCards: ready ? this.buildStripCards(state) : [],
      ...(ready ? { navSubtitle: this.navSubtitleOf("ready", statusView("ready", "", undefined, false, this.data.ready), undefined, state.power) } : {}),
      ...(ready
        ? this.deviceSummaryPatch(state)
        : { firmwareText: "—", hwId: "—", stripCount: 0, ledTotal: 0 }),
    });
  },

  /** 只读摘要（固件 / 硬件号 / 灯组数 / 灯珠总数）；设备信息可能还没读到。 */
  applyDeviceSummary(): void {
    this.setData(this.deviceSummaryPatch(this.session?.deviceState ?? null));
  },

  /**
   * 只读摘要的 data 片段。
   *
   * 灯组数与灯珠总数是**设备级事实**：按 `State.stripCount` 与逐组灯珠数求和，
   * 不受本机启用掩码影响（隐藏一组不等于设备上没有这一组）。
   */
  deviceSummaryPatch(state: DeviceState | null): Record<string, unknown> {
    const info = this.session?.deviceInfo ?? null;
    const stripCount = state === null ? 0 : Math.max(0, Math.min(MAX_STRIPS, state.stripCount));
    let ledTotal = 0;
    for (let stripId = 0; stripId < stripCount; stripId += 1) {
      ledTotal += state?.stripCounts[stripId] ?? 0;
    }
    return {
      firmwareText:
        info === null ? "—" : `v${info.firmwareMajor}.${info.firmwareMinor}`,
      hwId: info !== null && info.hwId.length > 0 ? info.hwId : "—",
      stripCount,
      ledTotal,
    };
  },

  /** 可见的灯组号：`State.stripCount` 截断后套用 App 本地启用掩码。 */
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

  /**
   * 当前设备的稳定标识（灯组元数据的存储键前缀）。
   *
   * hardwareId 优先（#94）：iOS 换 UUID 后灯组名与封面仍跟着走。
   */
  deviceKey(): string {
    const deviceId = this.session?.transport.currentDeviceId ?? "";
    const info = this.session?.deviceInfo ?? null;
    const hardwareId =
      info !== null && info.hwId.length > 0
        ? info.hwId
        : this.data.hwId !== "—"
          ? this.data.hwId
          : "";
    return deviceKeyOf({ deviceId, hardwareId });
  },

  /** 灯组元数据的解析结果（名字 + 封面），按当前可见灯组一次算好。 */
  stripMetaOf(stripIds: readonly number[]): Map<number, ResolvedStripMeta> {
    const key = this.deviceKey();
    const map = new Map<number, ResolvedStripMeta>();
    if (key.length === 0 || this.storage === null) {
      return map;
    }
    for (const meta of resolveStripMetas(this.storage, key, stripIds)) {
      map.set(meta.stripId, meta);
    }
    return map;
  },

  /** 按 State + 启用掩码生成灯组卡片（顺序 = 灯组号升序）。 */
  buildStripCards(state: DeviceState): StripCardView[] {
    const cards: StripCardView[] = [];
    const ids = this.visibleStripIds(state);
    const metas = this.stripMetaOf(ids);
    for (const stripId of ids) {
      const ledCount = state.stripCounts[stripId] ?? 0;
      const cached = this.stripSummaries.get(stripId);
      const meta = metas.get(stripId);
      cards.push({
        stripId,
        label: meta?.name ?? `灯组 ${stripId + 1}`,
        photo: meta?.photo ?? "",
        photoIsCustom: meta?.photoIsCustom ?? false,
        ledCount,
        summary:
          cached ??
          this.summaryOfReports(
            this.session?.segmentsOf(stripId) ?? [],
            ledCount,
          ),
        on: (state.stripPowerMask & (1 << stripId)) !== 0,
        animating: (state.stripAnimMask & (1 << stripId)) !== 0,
        busy: this.stripBusyIds.has(stripId),
      });
    }
    return cards;
  },

  /** 只重画卡片（组开关的 busy 态 / 摘要刷新用，不动亮度与摘要区）。 */
  renderStripCards(): void {
    const state = this.session?.deviceState ?? null;
    this.setData({ stripCards: state === null ? [] : this.buildStripCards(state) });
  },

  /**
   * 从设备读回**每一条可见灯组**的光区，刷新卡片上的效果摘要。
   *
   * 光区不在 State 里，设备也不会主动上报，所以只能逐组 `QueryStrip`。
   * 顺序发送（并发多帧重组会交错），并用代次号让旧一轮在 await 后静默退出。
   */
  async refreshStripSummaries(): Promise<void> {
    const session = this.session;
    const state = session?.deviceState ?? null;
    if (session === null || state === null || !this.data.ready) {
      return;
    }
    this.summaryEpoch += 1;
    const epoch = this.summaryEpoch;
    const ids = this.visibleStripIds(state);
    const next = new Map<number, string>();
    for (const stripId of ids) {
      const ledCount = state.stripCounts[stripId] ?? 0;
      const result = await session.queryStrip(stripId);
      if (epoch !== this.summaryEpoch) {
        return;
      }
      if (result.kind === "ok") {
        next.set(
          stripId,
          this.summaryOfReports(
            result.reports.filter((report) => report.stripId === stripId),
            ledCount,
          ),
        );
      } else {
        /* 读失败：保留会话镜像（可能是上次读到的好值），不编造效果名。 */
        next.set(stripId, this.summaryOfReports(session.segmentsOf(stripId), ledCount));
      }
    }
    if (epoch !== this.summaryEpoch) {
      return;
    }
    this.stripSummaries = next;
    this.renderStripCards();
  },

  /**
   * 一组光区 → 卡片上的一行效果摘要。
   *
   * 单光区覆盖整组时只说效果名（最常见）；只覆盖一段时带区间；
   * 多个光区时只说数量（卡片太窄，列不完）。
   *
   * 区间按**用户视角从 1 编号**（`1–15`），与灯组页的光区轴一致：协议里从 0
   * 编号只出现在灯珠弹窗的提示里一次，卡片上出现 `0–29` 会让人以为少了一颗。
   */
  summaryOfReports(reports: readonly SegmentReport[], ledCount: number): string {
    if (reports.length === 0) {
      return "未设置灯效";
    }
    if (reports.length > 1) {
      return `${reports.length} 个光区`;
    }
    const only = reports[0];
    const base = modeNameOf(only.layer0.type);
    const name = only.layer1.type === NO_EFFECT ? base : `${base} + 叠加`;
    const coversWhole = only.start === 0 && only.end >= Math.max(0, ledCount - 1);
    return coversWhole ? name : `${name} · ${only.start + 1}–${only.end + 1}`;
  },

  clearDeviceViews() {
    this.stripSummaries = new Map<number, string>();
    this.summaryEpoch += 1;
    this.stripBusyIds = new Set<number>();
    this.setData({
      power: 0,
      powerLabel: "已关",
      brightness: 0,
      brightnessDisplay: 0,
      brightnessPercent: 0,
      brightnessHintText: "连接后可调节",
      maxBrightness: effectiveMaxBrightness(undefined),
      stripCards: [],
      firmwareText: "—",
      hwId: "—",
      stripCount: 0,
      ledTotal: 0,
    });
  },

  /**
   * 副标题的文案（#94）：连接状态收在这里。
   *
   * 未连接 / 连接中 / 已连接·灯光打开 / 已连接·灯光关闭 / 连接失败。
   * 点副标题可重连——所以它就是「状态 + 重试入口」，不额外占一条状态栏。
   */
  navSubtitleOf(
    state: LinkState,
    view: ReturnType<typeof statusView>,
    detail?: LinkDetail,
    power?: 0 | 1,
  ): string {
    if (state === "connecting" || state === "initializing") {
      const name = detail?.deviceName ?? "";
      return name.length > 0 ? `正在连接 ${name}…` : "正在连接…";
    }
    if (state === "scanning") {
      return "正在扫描…";
    }
    if (state === "ready") {
      const on = (power ?? this.data.power) === 1;
      return on ? "已连接 · 灯光打开" : "已连接 · 灯光关闭";
    }
    if (state === "failed") {
      return view.statusSub.length > 0 ? `连接失败 · ${view.statusSub}` : "连接失败";
    }
    return "未连接 · 点这里重连";
  },

  /** 点副标题（nav-bar 的 subtitle 不可点，这里用页面内的状态条承接）。 */
  onSubtitleTap() {
    if (this.data.ready) {
      return;
    }
    void this.onRetryConnect();
  },

  // ---------------- 灯组卡片 ----------------

  /** 点卡片主体 → 进灯组页（带上灯组号）。 */
  onStripCardTap(e: WechatMiniprogram.TouchEvent) {
    const stripId = Number(e.currentTarget.dataset.stripId ?? -1);
    if (!Number.isInteger(stripId) || stripId < 0 || stripId >= MAX_STRIPS) {
      return;
    }
    if (!this.data.ready) {
      wx.showToast({ title: "先连接设备", icon: "none" });
      return;
    }
    this.session?.setActiveStripId(stripId);
    pushTo(PAGE_ROUTES.strip, { strip: stripId });
  },

  /** 长按灯组卡片：弹出改名 / 换封面菜单（#94）。 */
  onStripCardLongPress(e: WechatMiniprogram.TouchEvent) {
    const stripId = Number(e.currentTarget.dataset.stripId ?? -1);
    const card = this.data.stripCards.find((item) => item.stripId === stripId);
    if (card === undefined) {
      return;
    }
    wx.vibrateShort?.({ type: "light", fail: () => undefined });
    this.setData({
      stripMenuOpen: true,
      stripMenuId: stripId,
      stripMenuName: card.label,
      stripMenuPhotoIsCustom: card.photoIsCustom,
    });
  },

  onStripMenuClose() {
    if (!this.data.stripMenuOpen) {
      return;
    }
    this.setData({ stripMenuOpen: false });
  },

  /** 灯组菜单：改名。 */
  async onStripMenuRename() {
    const stripId = this.data.stripMenuId;
    if (stripId < 0 || this.stripMetaBusy) {
      return;
    }
    this.setData({ stripMenuOpen: false });
    const current = this.data.stripCards.find((item) => item.stripId === stripId)?.label ?? "";
    const name = await this.promptText({
      title: "灯组名称",
      value: current,
      placeholder: "例如：书桌",
      maxlength: 16,
    });
    if (name === null) {
      return;
    }
    this.applyStripName(stripId, name);
  },

  /** 灯组菜单：换封面（相册）。 */
  async onStripMenuPickPhoto() {
    const stripId = this.data.stripMenuId;
    if (stripId < 0 || this.stripMetaBusy || this.storage === null) {
      return;
    }
    this.setData({ stripMenuOpen: false });
    this.stripMetaBusy = true;
    try {
      const key = this.deviceKey();
      const previous = this.data.stripCards.find((item) => item.stripId === stripId)?.photo ?? "";
      const saved = await pickDevicePhoto(`${key}#strip${stripId}`, previous);
      if (saved === null) {
        return;
      }
      setStripPhoto(this.storage, key, stripId, saved);
      this.renderStripCards();
      wx.showToast({ title: "封面已更新", icon: "none" });
    } finally {
      this.stripMetaBusy = false;
    }
  },

  /** 灯组菜单：移除封面，回到默认占位图。 */
  onStripMenuClearPhoto() {
    const stripId = this.data.stripMenuId;
    /* 没有自定义封面时这一项是置灰的：点击直接忽略（WXML 里不能用动态
     * 事件名——微信不支持，且会让整张菜单的绑定失效）。 */
    if (stripId < 0 || this.storage === null || !this.data.stripMenuPhotoIsCustom) {
      return;
    }
    const key = this.deviceKey();
    const previous = this.data.stripCards.find((item) => item.stripId === stripId)?.photo ?? "";
    if (this.data.stripMenuPhotoIsCustom) {
      deleteDevicePhotoFile(previous);
    }
    setStripPhoto(this.storage, key, stripId, null);
    this.setData({ stripMenuOpen: false });
    this.renderStripCards();
    wx.showToast({ title: "已恢复默认封面", icon: "none" });
  },

  /** 灯组改名落盘并重绘（单独拆出来，便于测试与复用）。 */
  applyStripName(stripId: number, name: string): void {
    if (this.storage === null) {
      return;
    }
    setStripName(this.storage, this.deviceKey(), stripId, name);
    this.renderStripCards();
  },

  /**
   * 跨端一致的文本输入框。
   *
   * `wx.showModal` 的 `editable` 在部分基础库上不可用，所以优先用它；
   * 不可用时退回一个「提示 + 默认值」的确认框（至少不会静默失败）。
   */
  promptText(input: {
    title: string;
    value: string;
    placeholder: string;
    maxlength: number;
  }): Promise<string | null> {
    return new Promise((resolve) => {
      type EditableModal = typeof wx.showModal;
      const modal = wx.showModal as unknown as EditableModal & {
        (options: {
          title: string;
          editable?: boolean;
          placeholderText?: string;
          content?: string;
          confirmText?: string;
          cancelText?: string;
          success?: (res: { confirm: boolean; content?: string }) => void;
          fail?: () => void;
        }): void;
      };
      try {
        modal({
          title: input.title,
          editable: true,
          placeholderText: input.placeholder,
          content: input.value,
          confirmText: "保存",
          cancelText: "取消",
          success: (res) => {
            if (!res.confirm) {
              resolve(null);
              return;
            }
            const text = String(res.content ?? "").slice(0, input.maxlength).trim();
            /* 空串是「恢复默认名」，不是取消：允许通过。 */
            resolve(text);
          },
          fail: () => resolve(null),
        });
      } catch {
        resolve(null);
      }
    });
  },

  /**
   * 卡片内开关的 `catchtap`：只负责**拦住冒泡**，不触发导航。
   *
   * 开关自己的状态变化走 `bindchange`（`onStripPowerChange`）。没有这一层，
   * 点开关会同时翻状态并进入灯组页。
   */
  onStripSwitchBlock() {
    /* 故意为空：catchtap 的目的就是阻止卡片主体的点击。 */
  },

  /**
   * 某一条灯组的独立开关（SetStripPower 0x1B）。
   *
   * 只改这一条灯组的掩码位；其他灯组继续运行（协议就这么定义，不需要重发别的命令）。
   */
  async onStripPowerChange(e: WechatMiniprogram.SwitchChange) {
    const stripId = Number(
      (e.currentTarget.dataset as { stripId?: number | string } | undefined)?.stripId ?? -1,
    );
    const on = Boolean(e.detail.value);
    const session = this.session;
    if (
      session === null ||
      !Number.isInteger(stripId) ||
      stripId < 0 ||
      !this.data.ready ||
      this.stripBusyIds.has(stripId)
    ) {
      return;
    }
    this.stripBusyIds.add(stripId);
    this.renderStripCards();
    try {
      const result = await session.setStripPower(stripId, on);
      if (result.kind === "ok") {
        this.applyDeviceState(result.state);
        return;
      }
      if (result.kind === "ack-error") {
        wx.showToast({ title: resultText(result.ack.resultCode), icon: "none" });
        /* 设备拒绝了：把界面拉回设备真实掩码，别让开关停在假状态上。 */
        this.resyncFromState();
        return;
      }
      if (result.kind === "error") {
        wx.showToast({ title: result.message, icon: "none" });
        this.resyncFromState();
      }
    } finally {
      this.stripBusyIds.delete(stripId);
      this.renderStripCards();
    }
  },

  /** 用会话里的 State 重铺一次开关视图（写失败时纠正假状态）。 */
  resyncFromState() {
    const state = this.session?.deviceState ?? null;
    if (state !== null) {
      this.applyDeviceState(state);
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
        this.setData({
          navSubtitle: this.navSubtitleOf(
            "ready",
            statusView("ready", "", undefined, false, true),
            undefined,
            result.state.power,
          ),
        });
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

  // ---------------- 整台设备的亮度 ----------------

  onBrightnessChanging(e: WechatMiniprogram.SliderChanging) {
    const value = Number(e.detail.value);
    if (!Number.isFinite(value)) {
      return;
    }
    const now = Date.now();
    if (now - this.lastBrightnessUiAt >= BRIGHTNESS_UI_INTERVAL_MS) {
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

  // ---------------- 右上角菜单（#61） ----------------

  /**
   * 点导航栏右侧「菜单」：展开 / 收起。
   *
   * 遮罩的 z-index 低于 nav-bar（90），所以按钮永远不会被遮罩挡住——
   * 「再次点按钮收起」不会变成「先点遮罩」。
   */
  onMenuTap() {
    this.setData({ menuOpen: !this.data.menuOpen, menuTop: this.navBottom() });
  },

  /** 点遮罩：收起。 */
  onMenuClose() {
    if (!this.data.menuOpen) {
      return;
    }
    this.setData({ menuOpen: false });
  },

  /** 遮罩上的 touchmove：吞掉滚动，避免底层页面跟着动。 */
  onMenuNoop() {
    /* 故意为空：catchtouchmove 的目的就是阻止滚动穿透。 */
  },

  /** 设备信息（未连接时给出提示，不压一个空页面上去）。 */
  onMenuDeviceInfo() {
    this.setData({ menuOpen: false });
    this.onGoDeviceInfo();
  },

  /**
   * 断开连接：未连接时不可用（WXML 置灰，这里再兜一次）。
   *
   * 断开后会话进入 `idle`，本页由 `applyLink` 清空设备视图并显示提示条；
   * 不走 `navigateBack`——用户可能想就地在同一页重新连。
   */
  async onMenuDisconnect() {
    const session = this.session;
    if (!this.data.ready || session === null || this.menuBusy) {
      return;
    }
    this.menuBusy = true;
    this.setData({ menuOpen: false });
    /* 断开后不自动重连：`disconnect` 会同步发出 idle 事件，`applyLink` 的
     * idle 分支看到 autoConnectTried 为假就会立刻连回去。标记必须在 await
     * 之前立起来，否则用户看到的是「点了没反应」。 */
    this.autoConnectTried = true;
    try {
      await session.disconnect();
      this.setData({ connectHint: "已断开，点这里重新连接" });
      wx.showToast({ title: "已断开", icon: "none" });
    } finally {
      this.menuBusy = false;
    }
  },

  /** 进设备信息页（身份 / 固件 / 自检 / 改名 / 删除）。 */
  onGoDeviceInfo() {
    if (!this.data.ready) {
      wx.showToast({ title: "先连接设备", icon: "none" });
      return;
    }
    pushTo(PAGE_ROUTES.deviceInfo);
  },
});

/**
 * 灯效类型 → 用户看到的名称。
 *
 * 名字表与 `layerModeOf` 一起放在 `effect-view`（单一来源）：这里自己写一份
 * switch 时，新增类型（0x04 爆闪 / 0x05 心跳 / 0x06 熄灭）会静默落进
 * 默认分支，卡片上把正在爆闪的灯组写成「静态」。
 */
function modeNameOf(type: number): string {
  return layerModeNameOf(type);
}
