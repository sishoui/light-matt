/**
 * 设备详情页（二级页）：从首页大卡进入，**只管设备级**。
 *
 * ## 本页的职责边界（#63）
 *
 * 设备页回答三个问题：
 *  1. 这台设备开着没有？整台亮度多少？（总开关 + 全局亮度）
 *  2. 它有哪些灯组、各自亮着什么？（单列灯组行 + 每组的部位列表）
 *  3. 这台设备本身是什么？（固件 / 硬件号 / 灯组数 / 灯珠总数，只读）
 *
 * **v5 起灯组行就地展开**（#155）：点一行列出它的部位，点部位进
 * `pages/part/part` 编辑。以前那条「跳到一个独立的灯组详情页」的路径
 * （`pages/strip`）随 v4 的「分区 / 方案」模型一起退役。
 * 协议没有「逐灯组亮度」——只有全局 brightness 与逐组 strip_power_mask。
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
import { EFFECT_TYPE_NAMES, MAX_STRIPS, NO_EFFECT, PHASE } from "../../utils/protocol/constants";
import type {
  DeviceState,
  LayoutPart,
  LayoutReadback,
  LinkState,
  SceneReport,
} from "../../utils/protocol/types";

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
  /** 该组真实灯珠数（`State.stripLedCounts[stripId]`）。 */
  ledCount: number;
  /** 当前效果摘要（设备读回的布局 + 场景派生，不是本地草稿）。 */
  summary: string;
  /** 该组自己的开关位（`State.stripPowerMask`）。 */
  on: boolean;
  /** 这一组的开关命令还在路上。 */
  busy: boolean;
  /**
   * 就地展开（#155）：点一行展开它的部位列表，**不再 push 到另一页**。
   *
   * 同时只展开一组——多组同时展开会让「当前在编辑哪一组」变得含糊，
   * 而且窄屏上会滚不到底。
   */
  expanded: boolean;
  /** 展开后显示的部位行（未展开时为空，省不必要的渲染）。 */
  parts: PartRowView[];
  /** 该组的布局还没读到（展开瞬间的加载态）。 */
  partsLoading: boolean;
  /** 该组没有任何部位时的空态文案（null = 不是空态）。 */
  emptyHint: string | null;
}

/**
 * 展开区里的一行：一个部位（#155）。
 *
 * 点击进部位编辑器（`pages/part`）；右侧的开关是**场景里的部位开关**
 * （ScenePart 0x25 的 `on`），只灭灯、不停时钟（T8/T9）。
 */
interface PartRowView {
  stripId: number;
  partId: number;
  /** 部位名；空名按「部位 N」显示。 */
  label: string;
  /** 覆盖的灯珠描述，例如「1–15」或「1–5、20–25」。 */
  rangeText: string;
  /** 覆盖的灯珠总数。 */
  pixelCount: number;
  /** 本场景里该部位的步骤数（0 = 不演，恒黑）。 */
  stepCount: number;
  /** 本场景里的循环档位（0/1/2）。 */
  loop: number;
  /** 效果摘要（第一步的两层）。 */
  stepSummary: string;
  /** 部位开关（属于场景，不属于布局）。 */
  on: boolean;
  /** 开关命令还在路上。 */
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
  /**
   * 当前展开的灯组号（null = 全部收起）。
   *
   * **同时只展开一组**：多组同时展开会让「当前在编辑哪一组」变得含糊，
   * 窄屏上也滚不到底（#155）。
   */
  expandedStripId: null as number | null,
  /** 展开时读布局 / 场景的代次：连点两条灯组时旧一轮静默退出。 */
  partsLoadEpoch: 0,
  /** 正在读布局的灯组号（显示「读取中」而不是空态）。 */
  partsBusy: new Set<number>(),
  /** 正在下发部位开关的 `strip#part` 键（防重复点击）。 */
  partBusyKeys: new Set<string>(),
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
    this.expandedStripId = null;
    this.partsLoadEpoch = 0;
    this.partsBusy = new Set<number>();
    this.partBusyKeys = new Set<string>();
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
    /*
     * 刚连上：布局与场景都是**按需读**（§9.1 第 3/4 步）——卡片上的摘要
     * 只要有部位数就够了，明细在展开时读一次。
     */
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
      ledTotal += state?.stripLedCounts[stripId] ?? 0;
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

  /**
   * 按 State + 启用掩码生成灯组卡片（顺序 = 灯组号升序）。
   *
   * v5：卡片上的「摘要」不再是分区派生，而是**布局 + 场景**派生——
   * 「N 个部位 · 当前场景名」。真正要读明细就展开（§9.1 第 3/4 步）。
   */
  buildStripCards(state: DeviceState): StripCardView[] {
    const cards: StripCardView[] = [];
    const ids = this.visibleStripIds(state);
    const metas = this.stripMetaOf(ids);
    for (const stripId of ids) {
      const ledCount = state.stripLedCounts[stripId] ?? 0;
      const meta = metas.get(stripId);
      const layout = this.session?.layoutOf(stripId) ?? null;
      const partCount = layout?.parts.length ?? state.partCounts[stripId] ?? 0;
      const expanded = this.expandedStripId === stripId;
      const parts = expanded ? this.buildPartRows(stripId, layout, ledCount) : [];
      cards.push({
        stripId,
        label: meta?.name ?? `灯组 ${stripId + 1}`,
        photo: meta?.photo ?? "",
        photoIsCustom: meta?.photoIsCustom ?? false,
        ledCount,
        summary:
          partCount === 0
            ? "空 · 未划分部位"
            : `${partCount} 个部位 · ${sceneNameOf(this.session?.deviceState ?? null)}`,
        on: (state.stripPowerMask & (1 << stripId)) !== 0,
        busy: this.stripBusyIds.has(stripId),
        expanded,
        parts,
        partsLoading: expanded && layout === null && partCount > 0,
        emptyHint:
          expanded && partCount === 0 && !this.partsBusy.has(stripId)
            ? "这条灯组还没有部位。点 + 播种「整条 / 1 步 / 常亮」。"
            : null,
      });
    }
    return cards;
  },

  /**
   * 展开区里的一行：一个部位（#155）。
   *
   * 步骤数 / 循环 / 开关都来自**当前场景**的读回（QueryScene），区间来自布局
   * （QueryLayout）。任一读不到就退化成「未知」而不是编造——
   * 部位行上写错一个「3 步」比显示 `—` 更糟。
   */
  buildPartRows(
    stripId: number,
    layout: LayoutReadback | null,
    ledCount: number,
  ): PartRowView[] {
    if (layout === null) {
      return [];
    }
    const scene = this.session?.deviceState?.activeScene ?? 0;
    const report = this.session?.sceneOf(scene) ?? null;
    const rows: PartRowView[] = [];
    for (const part of layout.parts) {
      const scenePart = partReportOf(report, stripId, part.partId);
      rows.push({
        stripId,
        partId: part.partId,
        label: part.name.length > 0 ? part.name : `部位 ${part.partId + 1}`,
        rangeText: rangeTextOf(part, ledCount),
        pixelCount: partPixelCount(part),
        stepCount: scenePart?.stepCount ?? 0,
        loop: scenePart?.loop ?? 0,
        stepSummary: stepSummaryOf(report, stripId, part.partId),
        on: scenePart?.on ?? false,
        busy: this.partBusyKeys.has(`${stripId}#${part.partId}`),
      });
    }
    return rows;
  },

  /** 只重画卡片（组开关的 busy 态 / 展开态用，不动亮度与摘要区）。 */
  renderStripCards(): void {
    const state = this.session?.deviceState ?? null;
    this.setData({ stripCards: state === null ? [] : this.buildStripCards(state) });
  },

  /**
   * 展开一条灯组：读它的布局（§9.1 第 3 步）与当前场景（第 4 步）。
   *
   * 两条查询都是「一次一帧、串行」（§8），且用代次号让旧一轮在 await 后静默
   * 退出——连点两条灯组时，前一条的迟到结果不能覆盖后一条的展开态。
   */
  async expandStrip(stripId: number): Promise<void> {
    const session = this.session;
    if (session === null || !this.data.ready) {
      return;
    }
    if (this.expandedStripId === stripId) {
      return;
    }
    this.expandedStripId = stripId;
    this.partsBusy.add(stripId);
    this.renderStripCards();
    this.partsLoadEpoch += 1;
    const epoch = this.partsLoadEpoch;
    try {
      const layout = await session.queryLayout(stripId);
      if (epoch !== this.partsLoadEpoch) {
        return;
      }
      /* 布局读完再读场景：QueryScene 一次给整个激活场景，读一次就够。 */
      const scene = session.deviceState?.activeScene ?? 0;
      if (session.sceneOf(scene) === null) {
        await session.queryScene(scene);
      }
      if (epoch !== this.partsLoadEpoch) {
        return;
      }
      if (layout.kind !== "ok" && layout.kind !== "error") {
        return; /* stale：连接已经换了，别把旧数据画到新设备上 */
      }
    } finally {
      if (epoch === this.partsLoadEpoch) {
        this.partsBusy.delete(stripId);
        this.renderStripCards();
      }
    }
  },

  /** 收起：清掉展开态与逐部位的行缓存。 */
  collapseStrip(): void {
    if (this.expandedStripId === null) {
      return;
    }
    this.expandedStripId = null;
    this.partsLoadEpoch += 1;
    this.renderStripCards();
  },

  clearDeviceViews() {
    this.expandedStripId = null;
    this.partsLoadEpoch += 1;
    this.partsBusy = new Set<number>();
    this.partBusyKeys = new Set<string>();
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

  /**
   * 点卡片主体 → **就地展开 / 收起**（#155）。
   *
   * 以前这里是 `pushTo(PAGE_ROUTES.strip)`，跳到一个独立的灯组详情页。
   * v5 把入口收到设备页：一组只有一个部位列表那么大的信息量，跳页反而
   * 让「哪一组」需要靠标题才想得起来。
   */
  onStripCardTap(e: WechatMiniprogram.TouchEvent) {
    const stripId = Number(e.currentTarget.dataset.stripId ?? -1);
    if (!Number.isInteger(stripId) || stripId < 0 || stripId >= MAX_STRIPS) {
      return;
    }
    if (!this.data.ready) {
      wx.showToast({ title: "先连接设备", icon: "none" });
      return;
    }
    if (this.expandedStripId === stripId) {
      this.collapseStrip();
      return;
    }
    void this.expandStrip(stripId);
  },

  /**
   * 点一个部位行 → 进部位编辑器（`pages/part`）。
   *
   * 参数是 `strip` + `part`：编辑器要同时知道「哪条链」与「该链的哪个部位」。
   */
  onPartRowTap(e: WechatMiniprogram.TouchEvent) {
    const dataset = e.currentTarget.dataset as { stripId?: number | string; partId?: number | string };
    const stripId = Number(dataset.stripId ?? -1);
    const partId = Number(dataset.partId ?? -1);
    if (!Number.isInteger(stripId) || !Number.isInteger(partId) || partId < 0) {
      return;
    }
    if (!this.data.ready) {
      wx.showToast({ title: "先连接设备", icon: "none" });
      return;
    }
    pushTo(PAGE_ROUTES.part, { strip: stripId, part: partId });
  },

  /**
   * 展开区里的「点 + 播种」：整条 / 1 步 / 常亮（#155）。
   *
   * 这是**唯一**一个「从零建出可用的东西」的入口：新设备上一条链没有任何
   * 部位时，用户点一下就得到一个覆盖整条、1 步常亮、循环关闭的部位。
   * 写完整份布局（LayoutWrite → LayoutPart → LayoutSeg → LayoutCommit），
   * 因为布局是「整份替换」的语义（§6.1：LayoutWrite 会清空该链）。
   */
  async onSeedPartTap(e: WechatMiniprogram.TouchEvent) {
    const dataset = e.currentTarget.dataset as { stripId?: number | string };
    const stripId = Number(dataset.stripId ?? -1);
    const session = this.session;
    if (session === null || !Number.isInteger(stripId) || stripId < 0 || !this.data.ready) {
      return;
    }
    if (this.partsBusy.has(stripId)) {
      return;
    }
    const state = session.deviceState;
    if (state === null) {
      return;
    }
    const ledCount = state.stripLedCounts[stripId] ?? 0;
    if (ledCount < 1) {
      wx.showToast({ title: "这条灯组没有灯珠", icon: "none" });
      return;
    }
    this.partsBusy.add(stripId);
    this.renderStripCards();
    try {
      const existing = session.layoutOf(stripId);
      const parts: LayoutPart[] = existing === null ? [] : existing.parts.map((part) => ({ ...part }));
      if (parts.length >= 8) {
        wx.showToast({ title: "部位已满（最多 8 个）", icon: "none" });
        return;
      }
      const partId = parts.length;
      parts.push({
        stripId,
        partId,
        nameLen: 0,
        name: "",
        segCount: 1,
        /* 播种出来的部位用「连续」相位（S6 的默认）。 */
        phase: PHASE.CONTINUOUS,
        segs: [[0, ledCount - 1]],
      });
      const result = await session.writeLayout(stripId, parts);
      if (result.kind === "ok") {
        await session.queryLayout(stripId);
        this.renderStripCards();
        wx.showToast({ title: "已添加部位", icon: "none" });
        return;
      }
      if (result.kind === "ack-error") {
        wx.showToast({ title: resultText(result.ack.resultCode), icon: "none" });
        return;
      }
      if (result.kind === "storage") {
        wx.showToast({ title: "已生效但未保存", icon: "none" });
        return;
      }
      if (result.kind === "error") {
        wx.showToast({ title: result.message, icon: "none" });
      }
    } finally {
      this.partsBusy.delete(stripId);
      this.renderStripCards();
    }
  },

  /**
   * 展开区里某个部位的开关（ScenePart 0x25 的 `on`）。
   *
   * **只灭灯、不停时钟**（T8/T9）：关掉再打开，画面接着往下走。所以这里
   * 只改 `on` 一位，不碰 step_count / loop——`ScenePart` 同一条命令携带三者，
   * 步数不变时设备不会清空时间轴（§6.2）。
   */
  async onPartSwitchChange(e: WechatMiniprogram.SwitchChange) {
    const dataset = e.currentTarget.dataset as {
      stripId?: number | string;
      partId?: number | string;
    };
    const stripId = Number(dataset.stripId ?? -1);
    const partId = Number(dataset.partId ?? -1);
    const on = Boolean(e.detail.value);
    const session = this.session;
    if (session === null || partId < 0 || stripId < 0 || !this.data.ready) {
      return;
    }
    const key = `${stripId}#${partId}`;
    if (this.partBusyKeys.has(key)) {
      return;
    }
    const scene = session.deviceState?.activeScene ?? 0;
    const report = session.sceneOf(scene);
    const scenePart = partReportOf(report, stripId, partId);
    if (scenePart === null) {
      wx.showToast({ title: "这个部位没有时间轴", icon: "none" });
      return;
    }
    this.partBusyKeys.add(key);
    this.renderStripCards();
    try {
      const result = await session.setScenePart(
        scene,
        stripId,
        partId,
        scenePart.stepCount,
        scenePart.loop,
        on,
      );
      if (result.kind === "ok" || result.kind === "storage") {
        await session.queryScene(scene);
        this.renderStripCards();
        if (result.kind === "storage") {
          wx.showToast({ title: "已生效但未保存", icon: "none" });
        }
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
      this.partBusyKeys.delete(key);
      this.renderStripCards();
    }
  },

  /** 部位开关的 catchtap 保护（与灯组开关同理）。 */
  onPartSwitchBlock() {
    /* 故意为空：catchtap 的目的就是阻止行主体的点击。 */
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
 * 灯效类型 → 用户看到的名称（单一来源是 constants 的 EFFECT_TYPE_NAMES）。
 *
 * 自己写一份 switch 时，新增类型会静默落进默认分支，卡片上把正在爆闪的
 * 灯组写成「静态」。
 */
function modeNameOf(type: number): string {
  return EFFECT_TYPE_NAMES[type] ?? `0x${type.toString(16).toUpperCase()}`;
}

/** 当前场景名（State 只报 id；名字来自场景读回）。 */
function sceneNameOf(state: DeviceState | null): string {
  if (state === null) {
    return "未连接";
  }
  return `场景 ${state.activeScene + 1}`;
}

/** 在某份场景读回里找一个部位的时间轴头（没有则 null）。 */
function partReportOf(
  report: SceneReport | null,
  stripId: number,
  partId: number,
): { stepCount: number; loop: number; on: boolean } | null {
  if (report === null) {
    return null;
  }
  const found = report.parts.find(
    (part) => part.stripId === stripId && part.partId === partId,
  );
  return found === undefined
    ? null
    : { stepCount: found.stepCount, loop: found.loop, on: found.on };
}

/**
 * 部位覆盖的灯珠区间文案。
 *
 * 区间按**用户视角从 1 编号**（`1–15`），与灯组页的分区轴一致：协议里从 0
 * 编号只出现在灯珠弹窗的提示里一次，卡片上出现 `0–29` 会让人以为少了一颗。
 * 多段之间用「、」分隔，这也是「灰缝」在界面上的样子。
 */
function rangeTextOf(part: LayoutPart, ledCount: number): string {
  if (part.segs.length === 0) {
    return "未划灯珠";
  }
  const pieces = part.segs.map(([start, end]) => `${start + 1}–${end + 1}`);
  const text = pieces.join("、");
  /* 覆盖整条时后缀「（整条）」，比一串区间更好读。 */
  if (
    part.segs.length === 1 &&
    part.segs[0][0] === 0 &&
    part.segs[0][1] >= Math.max(0, ledCount - 1)
  ) {
    return `${text}（整条）`;
  }
  return text;
}

/** 一个部位覆盖的灯珠总数（所有段长度之和）。 */
function partPixelCount(part: LayoutPart): number {
  let total = 0;
  for (const [start, end] of part.segs) {
    if (end >= start) {
      total += end - start + 1;
    }
  }
  return total;
}

/**
 * 一个部位在本场景里的效果摘要。
 *
 * 只看**第 1 步**（列表里放不下时间轴）。0 步 = 不演；两层都有 = 「A + B」。
 * 混合方式是本地推出来的（§6.2：layer1 非空即「按亮度叠加」），不进摘要文案
 * ——列表里「常亮 + 流星」已经说明问题，再写一个 blend 名反而干扰。
 */
function stepSummaryOf(report: SceneReport | null, stripId: number, partId: number): string {
  if (report === null) {
    return "—";
  }
  const part = report.parts.find((item) => item.stripId === stripId && item.partId === partId);
  if (part === undefined || part.stepCount === 0) {
    return "不演";
  }
  const step = report.steps.find(
    (item) => item.stripId === stripId && item.partId === partId && item.stepIndex === 0,
  );
  if (step === undefined) {
    return "—";
  }
  const base = modeNameOf(step.layer0.type);
  const overlay = step.layer1.type === NO_EFFECT ? "" : ` + ${modeNameOf(step.layer1.type)}`;
  const more = part.stepCount > 1 ? ` · ${part.stepCount} 步` : "";
  return `${base}${overlay}${more}`;
}
