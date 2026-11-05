/**
 * 首页（tab 1）：大设备卡 + 下方设备小图。
 *
 * ## 交互契约（刻意区分「浏览」与「操作」）
 *
 * - **点小图** = 只切换大卡展示哪台设备，**不发起 BLE 连接**。小程序只有一条
 *   连接，用户点一下缩略图就被迫断开当前设备是很糟的体验。
 * - **点大卡** = 进设备详情页（`pages/device`），那里才有真正的控制面板；
 *   若该设备还没连接，详情页会负责连上。
 * - **点大卡上的电源键**（catchtap，不冒泡）= 快捷开关。它必须先确保连上
 *   那台设备：未连接时先 `session.connect`，已连接别的设备时走 `switchTo`。
 *
 * ## 数据来源
 *
 * 列表来自 `session.recentDevices` + 设备登记表（与发现页同一套合并逻辑，
 * 见 `utils/control/home-view.ts`），状态来自 `session.deviceState`。
 * 演示模式下这些数据由 `utils/ble/mock-transport.ts` 真实产出。
 */

import { errorText, resultText } from "../../utils/ble/errors";
import type { LinkDetail } from "../../utils/ble/transport";
import { ConnectCancelledError } from "../../utils/ble/transport";
import { createWxStorage } from "../../utils/control/device-cache";
import { loadRegistry, type DeviceRegistry } from "../../utils/control/device-registry";
import {
  buildHomeView,
  glowStyle,
  thumbnailsOf,
  type DeviceCard,
} from "../../utils/control/home-view";
import { isMockSession } from "../../utils/control/session-singleton";
import {
  clearDevicePhoto,
  deleteDevicePhotoFile,
  loadDevicePhotos,
  pickDevicePhoto,
  photoKeyOf,
  setDevicePhoto,
  type DevicePhotoMap,
} from "../../utils/control/device-photo";
import { getSession } from "../../utils/control/session-singleton";
import type { ThemeMode } from "../../utils/control/theme";
import { pageThemeData, syncTabBarTheme } from "../../utils/control/page-theme";
import {
  BRIGHTNESS_DEBOUNCE_MS,
  brightnessDragPercent,
  buildHomeMenu,
  buildSearchView,
  createDebouncer,
  type Debouncer,
  type HomeMenuAction,
  type HomeMenuItem,
} from "../../utils/control/home-actions";
import { deleteDeviceFully } from "../../utils/control/delete-device";
import { setRemark } from "../../utils/control/device-registry";
import type { ControlSession } from "../../utils/control/session";
import { PAGE_ROUTES, pushTo } from "../../utils/control/routes";
import { statusView } from "../../utils/control/status-view";
import type { LinkState } from "../../utils/protocol/types";

/** 大卡 + 小图都要的额外展示字段（inline style 在 JS 里算，避免 WXML 里拼字符串）。 */
interface CardView extends DeviceCard {
  glowStyle: string;
}

Page({
  data: {
    themeClass: "",
    /** 实际深色（含「跟随系统」解析）。 */
    dark: false,
    /** 原生 slider / switch 的激活色（不读 CSS 变量）。 */
    accentColor: "",
    mock: false,

    // 连接状态条
    statusText: "未连接",
    statusSub: "点「发现」查找设备",
    statusAction: "发现",
    linkClass: "link-idle",
    ready: false,
    connectingName: "",
    busy: false,

    // 顶部「+」下拉菜单（本轮只有「添加设备」，结构上留出后续加项的位置）
    plusOpen: false,
    plusTop: 88,

    // 搜索：为空时保持「大卡 + 小图」，有关键字时整页变成一列结果
    query: "",
    searching: false,
    searchResults: [] as CardView[],
    searchEmpty: "",

    // 大卡亮度滑块（可拖）
    brightnessSlider: 0,
    brightnessMax: 255,
    brightnessPercent: 0,
    brightnessDragging: false,
    brightnessDraggable: false,
    brightnessHint: "连接后可调节",

    /** 电源键的就地反馈（#91）：不再静默返回。 */
    powerHint: "",

    // 长按菜单
    menuOpen: false,
    menuItems: [] as HomeMenuItem[],

    // 设备卡
    cards: [] as CardView[],
    current: null as CardView | null,
    thumbnails: [] as CardView[],
    empty: true,
    emptyHint: "还没有设备。点「发现」扫描附近的 Lumen 灯控。",
  },

  session: null as ControlSession | null,
  registry: null as DeviceRegistry | null,
  /** 用户选中的设备 key（跨页保留，但不落盘：重开小程序回到「当前连接的」）。 */
  selectedKey: "",
  /** 用户自选的封面（deviceKey → 本地文件路径）。 */
  photos: {} as DevicePhotoMap,
  /** 正在保存封面（避免重复弹相册）。 */
  photoBusy: false,
  unsubscribers: [] as Array<() => void>,
  themeMode: "system" as ThemeMode,
  /** 亮度落地的防抖器（拖动期间只改本地，停手下发最后一个值）。 */
  brightnessDebouncer: null as Debouncer<number> | null,
  /** 长按菜单当前针对的设备 key。 */
  menuKey: "",
  /** 改名 / 换封面进行中（防重复提交）。 */
  menuBusy: false,
  /**
   * 电源键这一次点击还在处理中（#130）。
   *
   * 与 `data.busy` 分开：`busy` 是**链路态**的投影（连接中就忙），
   * 这个只表示「用户刚点了一下，命令还没回来」。混成一个字段就会重演
   * 自动回连之后电源键永久失效——那次是链路态留下的 `true` 没人清。
   */
  powerBusy: false,

  onLoad() {
    /* 页面私有状态必须在这里显式初始化：Page() 不保证对象字面量字段被复制
     * 到实例上，漏掉会让 onShow 的调用链抛错并中断整页事件绑定。 */
    this.unsubscribers = [];
    this.selectedKey = "";
    this.photos = {};
    this.photoBusy = false;
    this.registry = null;
    this.brightnessDebouncer = null;
    this.menuKey = "";
    this.menuBusy = false;
    this.powerBusy = false;

    const storage = createWxStorage();
    const theme = pageThemeData(storage);
    this.themeMode = theme.themeClass === "theme-dark" ? "dark" : theme.themeClass === "theme-light" ? "light" : "system";

    this.session = getSession();
    this.registry = loadRegistry(storage);
    this.photos = loadDevicePhotos(storage);
    this.setData({
      ...theme,
      mock: isMockSession(),
    });
    this.brightnessDebouncer = createDebouncer<number>(
      (value) => {
        this.session?.commitBrightness(value);
        this.setData({ brightnessDragging: false });
      },
      { delayMs: BRIGHTNESS_DEBOUNCE_MS },
    );
    this.refresh();
  },

  onShow() {
    /* #62：演示设备开关在「我的」页，它会**重建会话**（`reloadSession`）。
     * 本页在 onLoad 里抓的实例已经 destroy，监听全失效、列表也停在旧数据上
     * （用户关掉演示设备后首页仍显示三台占位设备）。所以每次显示都重新取
     * 单例——`getSession()` 在没重建时返回同一个实例，代价只是一次判断。 */
    const current = getSession();
    if (current !== this.session) {
      this.unsubscribe();
      this.session = current;
    }
    this.subscribe();
    /* 从详情页/发现页回来：设备可能刚连上或刚被删除，全部重算一次。
     * 登记表也要重读（备注名可能改了）。 */
    this.registry = loadRegistry(createWxStorage());
    this.photos = loadDevicePhotos(createWxStorage());
    /* **显示时**重读主题：在「我的」页切完后回到本页必须已经是新色
     * （onLoad 缓存的模式值永远不会更新——#90 的断点之一）。 */
    const theme = pageThemeData(createWxStorage());
    this.themeMode = theme.themeClass === "theme-dark" ? "dark" : theme.themeClass === "theme-light" ? "light" : "system";
    if (
      this.data.themeClass !== theme.themeClass ||
      this.data.dark !== theme.dark ||
      this.data.accentColor !== theme.accentColor
    ) {
      this.setData({ ...theme });
    }
    /* 演示模式在「我的」页切换（会话重建），提示条也要跟着走。 */
    if (this.data.mock !== isMockSession()) {
      this.setData({ mock: isMockSession() });
    }
    this.syncFromSession();
    this.refresh();
    this.syncTabBar();
    /* 回到首页时让会话复核一次链路（不打断扫描 / 手动连接）。 */
    void this.session?.onShow();
  },

  onHide() {
    this.unsubscribe();
    /* 离开页面时把还没落地的亮度结算掉：用户拖完立刻切页也不该丢这个值。 */
    this.brightnessDebouncer?.flush();
    this.setData({ menuOpen: false, plusOpen: false });
  },

  onUnload() {
    this.unsubscribe();
    this.brightnessDebouncer?.flush();
    this.brightnessDebouncer = null;
    this.session = null;
  },

  subscribe() {
    const session = this.session;
    if (session === null) {
      return;
    }
    this.unsubscribers = [
      session.onLink((state, detail) => this.applyLink(state, detail)),
      session.onState(() => this.refresh()),
      session.onDeviceConfig(() => this.refresh()),
    ];
  },

  unsubscribe() {
    for (const off of this.unsubscribers ?? []) {
      off();
    }
    this.unsubscribers = [];
  },

  /** 自定义 tabBar 的选中态 + 主题（索引与 app.json 顺序一致）。 */
  syncTabBar() {
    const tabBar = this.getTabBar?.();
    if (tabBar !== undefined && tabBar !== null) {
      tabBar.setData({ selected: 0 });
      syncTabBarTheme(tabBar, this.themeMode);
    }
  },

  // ---------------- 状态 ----------------

  syncFromSession() {
    const session = this.session;
    if (session === null) {
      return;
    }
    this.applyLink(session.linkState);
  },

  applyLink(state: LinkState, detail?: LinkDetail) {
    const session = this.session;
    const view = statusView(
      state,
      detail?.deviceName ?? session?.cachedDevice?.name ?? "",
      detail?.message,
      session?.reconnectPending ?? false,
      (session?.cachedDevice ?? null) !== null,
      /* #131：已连接时扫描不拆链路，但状态条必须说「停止」。 */
      session?.transport.scanningOverLink ?? false,
    );
    const ready = state === "ready";
    const connecting = state === "connecting" || state === "initializing";
    this.setData({
      ...view,
      ready,
      linkClass: view.linkClass,
      /* #130：`busy` 只由**链路态**派生。以前写成 `connecting || this.data.busy`，
       * 于是自动回连期间置上的 `true` 永远没人清——回连成功后 `connecting` 变假，
       * 但 `this.data.busy` 自己已经是 true，或运算把它留住了。电源键在
       * `busy` 为真时静默 return，用户看到「已连接」却点不动开关。
       * 现在每一次链路事件都重算：连接的几秒里为真，进 ready / failed / idle 立刻为假。 */
      busy: connecting || this.powerBusy,
      connectingName: connecting ? detail?.deviceName ?? "" : "",
    });
    this.refresh();
  },

  /** 重算设备卡（唯一的数据派生入口）。 */
  refresh() {
    const session = this.session;
    const currentDeviceId = session?.transport.currentDeviceId ?? "";
    const view = buildHomeView({
      recent: session?.recentDevices ?? [],
      registry: (this.registry ?? { devices: [] }).devices,
      currentDeviceId,
      state: session?.deviceState ?? null,
      selectedKey: this.selectedKey,
      photos: this.photos,
    });
    const cards: CardView[] = view.cards.map((card) => ({
      ...card,
      glowStyle: glowStyle(card),
    }));
    this.selectedKey = view.selectedKey;
    const current = cards.find((card) => card.key === view.selectedKey) ?? null;
    const search = buildSearchView(cards, this.data.query);
    this.setData({
      cards,
      current,
      thumbnails: thumbnailsOf(cards),
      empty: view.empty,
      searching: search.searching,
      searchResults: search.results,
      searchEmpty: search.emptyText,
      ...this.brightnessPatch(current),
    });
  },

  /**
   * 大卡亮度滑块的 data 片段。
   *
   * 拖动期间**不覆盖**本地值（否则设备 20Hz 的 State 会把滑块拽回原处，
   * 手指底下的条会跳）。未连接时不显示滑条。
   */
  brightnessPatch(card: CardView | null): Record<string, unknown> {
    const session = this.session;
    const connected = card !== null && card.connected;
    const max = session?.maxBrightness ?? 255;
    const state = session?.deviceState ?? null;
    if (!connected || state === null) {
      return {
        brightnessDraggable: false,
        brightnessSlider: 0,
        brightnessMax: max,
        brightnessPercent: 0,
        brightnessHint: "连接后可调节",
      };
    }
    if (this.data.brightnessDragging) {
      /* 拖动中：只更新上限，值保持用户手指的位置。 */
      return { brightnessDraggable: true, brightnessMax: max };
    }
    const value = state.brightness;
    return {
      brightnessDraggable: true,
      brightnessSlider: value,
      brightnessMax: max,
      brightnessPercent: brightnessDragPercent(value, max),
      brightnessHint: `拖动调节，松手生效 · 上限 ${max}`,
    };
  },

  // ---------------- 交互 ----------------

  /** 点小图：只切换大卡，不连接。 */
  onThumbTap(e: WechatMiniprogram.TouchEvent) {
    const key = String(e.currentTarget.dataset.key ?? "");
    if (key.length === 0 || key === this.selectedKey) {
      return;
    }
    this.selectedKey = key;
    this.refresh();
  },

  /** 点大卡：进设备详情页（连接在那里发生）。 */
  onCardTap() {
    const card = this.data.current;
    if (card === null) {
      pushTo(PAGE_ROUTES.discover);
      return;
    }
    pushTo(PAGE_ROUTES.device, { key: card.key });
  },

  /** 点状态条：已连接进详情，否则去发现页。 */
  /**
   * 点状态条：**行为必须与那条右侧文案一致**（#131）。
   *
   * 文案是 `statusAction`，由 `statusView` 按链路态派生：连接中是「取消」、
   * 扫描中是「停止」、已连接是「设备」、其余是「发现」。以前这里只判
   * `ready`，于是扫描中点写着「停止」的状态条会切到发现页，扫描照旧在跑——
   * 文案承诺一个动作，代码做的是另一个。
   */
  onStatusTap() {
    const session = this.session;
    const action = this.data.statusAction;
    if (action === "停止") {
      void session?.stopScan();
      return;
    }
    if (action === "取消") {
      session?.cancelConnect();
      return;
    }
    if (this.data.ready && this.data.current !== null) {
      pushTo(PAGE_ROUTES.device, { key: this.data.current.key });
      return;
    }
    pushTo(PAGE_ROUTES.discover);
  },

  /**
   * 大卡上的电源键：快捷开关。
   *
   * 未连接 → 先连上；连着别的设备 → 先切换。连接期间禁用重复点击。
   * 这里**不**自动跳详情页——用户点的是「开关」，意图是就地开关，不是导航。
   */
  async onPowerTap() {
    const card = this.data.current;
    const session = this.session;
    if (card === null || session === null || this.data.busy || this.powerBusy) {
      return;
    }
    /* #91 第一条静默返回：只有云端记录的设备本机没有连接标识，点电源键
     * 以前什么都不发生。现在明确说清楚该怎么办。 */
    if (card.deviceId.length === 0) {
      this.setData({ powerHint: "这台设备只有云端记录，需要先扫描添加后才能直接开关" });
      wx.showToast({ title: "需要先扫描添加这台设备", icon: "none" });
      return;
    }
    this.powerBusy = true;
    this.setData({ busy: true, powerHint: "" });
    try {
      if (!card.connected) {
        const switching = session.linkState === "ready";
        /* #91 第二条静默返回：连接的几秒里没有任何提示。 */
        this.setData({ powerHint: switching ? `正在切换到 ${card.name}…` : `正在连接 ${card.name}…` });
        if (switching) {
          await session.switchTo(card.deviceId, card.name);
        } else {
          await session.connect(card.deviceId, card.name);
        }
        this.refresh();
      }
      const state = session.deviceState;
      /* #91 第三条静默返回：刚连上、State 还没到时直接 return。 */
      if (state === null) {
        this.setData({ powerHint: "已连上，正在读取设备状态…" });
        /* 等第一帧 State 到位（最多 3 秒），再决定开还是关。 */
        const ready = await this.waitForDeviceState(3000);
        if (!ready) {
          this.setData({ powerHint: "读不到设备状态，请稍后再点一次" });
          return;
        }
      }
      const latest = session.deviceState;
      if (latest === null) {
        this.setData({ powerHint: "读不到设备状态，请稍后再点一次" });
        return;
      }
      this.setData({ powerHint: latest.power === 1 ? "正在关灯…" : "正在开灯…" });
      const result = await session.setPower(latest.power !== 1);
      if (result.kind === "ok") {
        this.refresh();
        this.setData({ powerHint: result.state.power === 1 ? "灯光已打开" : "灯光已关闭" });
        /* 触感反馈（不支持时静默）。 */
        wx.vibrateShort?.({ type: "light", fail: () => undefined });
        return;
      }
      if (result.kind === "ack-error") {
        this.setData({ powerHint: `切换失败：${resultText(result.ack.resultCode)}` });
        wx.showToast({ title: resultText(result.ack.resultCode), icon: "none" });
        return;
      }
      if (result.kind === "error") {
        this.setData({ powerHint: `切换失败：${result.message}` });
        wx.showToast({ title: result.message, icon: "none" });
      }
    } catch (err) {
      if (err instanceof ConnectCancelledError) {
        this.setData({ powerHint: "已取消连接" });
        return;
      }
      this.setData({ powerHint: `连接失败：${errorText(err)}` });
      wx.showToast({ title: errorText(err), icon: "none" });
    } finally {
      this.powerBusy = false;
      /* 收尾按链路态重算，而不是硬写 false：这一步可能刚把连接建起来，
       * 此刻 busy 应该仍为真（connecting）。 */
      this.applyLink(session.linkState);
    }
  },

  /**
   * 等第一帧设备状态到位（电源键的第三条静默返回）。
   *
   * 返回 false 表示超时。期间订阅 `onState`，拿到就 resolve，立刻退订。
   */
  waitForDeviceState(timeoutMs: number): Promise<boolean> {
    const session = this.session;
    if (session === null) {
      return Promise.resolve(false);
    }
    if (session.deviceState !== null) {
      return Promise.resolve(true);
    }
    return new Promise((resolve) => {
      let off: (() => void) | null = null;
      const timer = setTimeout(() => {
        off?.();
        resolve(false);
      }, timeoutMs);
      off = session.onState(() => {
        clearTimeout(timer);
        off?.();
        resolve(true);
      });
    });
  },

  // ---------------- 搜索（#93） ----------------

  onQueryInput(e: WechatMiniprogram.Input) {
    const query = String(e.detail.value ?? "");
    this.setData({ query });
    this.applySearch();
  },

  onQueryClear() {
    if (this.data.query.length === 0) {
      return;
    }
    this.setData({ query: "" });
    this.applySearch();
  },

  /** 应用搜索词：有关键字时整页变成一列设备卡。 */
  applySearch() {
    const view = buildSearchView(this.data.cards, this.data.query);
    this.setData({
      searching: view.searching,
      searchResults: view.results,
      searchEmpty: view.emptyText,
    });
  },

  /**
   * 点搜索结果：只做「选中为大卡」并清空搜索，**不发起连接**。
   *
   * 延续「浏览不等于操作」的既有契约（点小图也不连接）。
   */
  onSearchResultTap(e: WechatMiniprogram.TouchEvent) {
    const key = String(e.currentTarget.dataset.key ?? "");
    if (key.length === 0) {
      return;
    }
    this.selectedKey = key;
    this.setData({ query: "" });
    this.refresh();
  },

  // ---------------- 右上角「+」下拉菜单（#93） ----------------

  onPlusTap() {
    this.setData({ plusOpen: !this.data.plusOpen, plusTop: this.navBottom() });
  },

  onPlusClose() {
    if (!this.data.plusOpen) {
      return;
    }
    this.setData({ plusOpen: false });
  },

  onPlusNoop() {
    /* catchtouchmove：阻止滚动穿透。 */
  },

  /** 下拉里唯一的项：添加设备（去发现页）。 */
  onPlusAddDevice() {
    this.setData({ plusOpen: false });
    pushTo(PAGE_ROUTES.discover);
  },

  /** nav-bar 下边界（px）：菜单贴着它展开。 */
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

  // ---------------- 大卡亮度滑块（#93） ----------------

  /** 滑条区域的 catchtap：只拦冒泡，不触发「进详情」。 */
  onHeroSliderBlock() {
    /* 故意为空。 */
  },

  onBrightnessChanging(e: WechatMiniprogram.SliderChanging) {
    const value = Number(e.detail.value);
    if (!Number.isFinite(value) || !this.data.brightnessDraggable) {
      return;
    }
    /* 拖动中只改本地显示 + 推给防抖器（不立即下发）。 */
    this.setData({
      brightnessSlider: value,
      brightnessPercent: brightnessDragPercent(value, this.data.brightnessMax),
      brightnessDragging: true,
      brightnessHint: "松手后生效",
    });
    this.brightnessDebouncer?.push(value);
  },

  onBrightnessChange(e: WechatMiniprogram.SliderChange) {
    const value = Number(e.detail.value);
    if (!Number.isFinite(value) || !this.data.brightnessDraggable) {
      return;
    }
    /* 松手：立即结算最后一个值（防抖器保证拖动期间没有下发过中间值）。 */
    this.setData({
      brightnessSlider: value,
      brightnessPercent: brightnessDragPercent(value, this.data.brightnessMax),
    });
    this.brightnessDebouncer?.push(value);
    this.brightnessDebouncer?.flush();
  },

  // ---------------- 长按菜单（#93） ----------------

  /** 长按大卡或小图：弹出同一个底部菜单。 */
  onCardLongPress(e: WechatMiniprogram.TouchEvent) {
    const key = String(e.currentTarget.dataset.key ?? "") || this.selectedKey;
    const card = this.data.cards.find((item) => item.key === key);
    if (card === undefined) {
      return;
    }
    wx.vibrateShort?.({ type: "light", fail: () => undefined });
    this.menuKey = key;
    this.setData({
      menuOpen: true,
      menuItems: buildHomeMenu({
        connected: card.connected,
        photoIsUserPicked: card.photoIsUserPicked,
      }),
    });
  },

  onMenuClose() {
    if (!this.data.menuOpen) {
      return;
    }
    this.menuKey = "";
    this.setData({ menuOpen: false });
  },

  onMenuNoop() {
    /* catchtouchmove：阻止滚动穿透。 */
  },

  /** 菜单动作分发（WXML 用 data-action 传动作名）。 */
  async onMenuAction(e: WechatMiniprogram.TouchEvent) {
    const action = String(e.currentTarget.dataset.action ?? "") as HomeMenuAction;
    const card = this.data.cards.find((item) => item.key === this.menuKey);
    const item = this.data.menuItems.find((entry) => entry.action === action);
    if (card === undefined || item === undefined || !item.enabled) {
      return;
    }
    this.setData({ menuOpen: false });
    switch (action) {
      case "rename":
        await this.renameCard(card);
        return;
      case "pickPhoto":
        await this.pickPhotoFor(card);
        return;
      case "clearPhoto":
        await this.clearPhotoFor(card);
        return;
      case "disconnect":
        await this.disconnectCard(card);
        return;
      case "delete":
        await this.deleteCard(card);
        return;
      default:
        return;
    }
  },

  /** 改名：写本机备注（首页 / 设备页 / 发现页三处即时一致）。 */
  async renameCard(card: CardView): Promise<void> {
    if (this.menuBusy) {
      return;
    }
    const name = await this.promptText({
      title: "设备名称",
      value: card.name,
      placeholder: "例如：客厅灯带",
      maxlength: 20,
    });
    if (name === null) {
      return;
    }
    const storage = createWxStorage();
    this.registry = setRemark(storage, card.deviceId, name);
    this.refresh();
    wx.showToast({ title: "名称已更新", icon: "none" });
  },

  /** 换封面：按 deviceKey 存（hardwareId 优先）。 */
  async pickPhotoFor(card: CardView): Promise<void> {
    if (this.menuBusy) {
      return;
    }
    this.menuBusy = true;
    try {
      const previous = card.photoIsUserPicked ? card.photo : "";
      const saved = await pickDevicePhoto(card.key, previous);
      if (saved === null) {
        return;
      }
      this.photos = setDevicePhoto(createWxStorage(), card.key, saved);
      this.refresh();
      wx.showToast({ title: "封面已更新", icon: "none" });
    } finally {
      this.menuBusy = false;
    }
  },

  /** 移除封面：回到默认外观（演示图或渐变）。 */
  async clearPhotoFor(card: CardView): Promise<void> {
    if (!card.photoIsUserPicked || this.menuBusy) {
      return;
    }
    const confirmed = await new Promise<boolean>((resolve) => {
      wx.showModal({
        title: "移除封面",
        content: "只是去掉这张自定义图片，不影响设备与灯光。",
        confirmText: "移除",
        cancelText: "取消",
        success: (res) => resolve(res.confirm),
        fail: () => resolve(false),
      });
    });
    if (!confirmed) {
      return;
    }
    deleteDevicePhotoFile(photoKeyOf(this.photos, card.key));
    this.photos = clearDevicePhoto(createWxStorage(), card.key);
    this.refresh();
    wx.showToast({ title: "已移除封面", icon: "none" });
  },

  /** 断开：只断当前连接（不是删除）。 */
  async disconnectCard(card: CardView): Promise<void> {
    const session = this.session;
    if (session === null || !card.connected) {
      return;
    }
    try {
      await session.disconnect();
      this.refresh();
      wx.showToast({ title: "已断开", icon: "none" });
    } catch (err) {
      wx.showToast({ title: errorText(err), icon: "none" });
    }
  },

  /** 删除：与「我的」页 / 设备信息页走同一个实现（#91）。 */
  async deleteCard(card: CardView): Promise<void> {
    const confirmed = await new Promise<boolean>((resolve) => {
      wx.showModal({
        title: "删除这台设备？",
        content: "本机会断开连接、清掉登记与封面；设备上的灯光配置不受影响，重新扫描仍能连上。",
        confirmText: "删除",
        cancelText: "取消",
        success: (res) => resolve(res.confirm),
        fail: () => resolve(false),
      });
    });
    if (!confirmed) {
      return;
    }
    try {
      await deleteDeviceFully({
        storage: createWxStorage(),
        deviceId: card.deviceId,
        hardwareId: this.hardwareIdOf(card.deviceId),
        session: this.session,
      });
      this.registry = loadRegistry(createWxStorage());
      this.photos = loadDevicePhotos(createWxStorage());
      this.refresh();
      wx.showToast({ title: "已删除", icon: "none" });
    } catch (err) {
      wx.showToast({ title: errorText(err), icon: "none" });
    }
  },

  /** 设备自报的 hardwareId（登记表或当前设备信息）。 */
  hardwareIdOf(deviceId: string): string {
    const entry = (this.registry ?? { devices: [] }).devices.find(
      (item) => item.deviceId === deviceId,
    );
    if (entry?.hardwareId !== undefined && entry.hardwareId.length > 0) {
      return entry.hardwareId;
    }
    return this.session?.deviceInfo?.hwId ?? "";
  },

  /**
   * 文本输入框（改名用）。
   *
   * `wx.showModal` 的可编辑输入在部分基础库上不可用；失败时返回 null
   * （调用方不产生任何写入），不会静默改错东西。
   */
  promptText(input: {
    title: string;
    value: string;
    placeholder: string;
    maxlength: number;
  }): Promise<string | null> {
    return new Promise((resolve) => {
      type EditableModal = (options: {
        title: string;
        editable?: boolean;
        placeholderText?: string;
        content?: string;
        confirmText?: string;
        cancelText?: string;
        success?: (res: { confirm: boolean; content?: string }) => void;
        fail?: () => void;
      }) => void;
      const modal = wx.showModal as unknown as EditableModal;
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
            resolve(String(res.content ?? "").slice(0, input.maxlength).trim());
          },
          fail: () => resolve(null),
        });
      } catch {
        resolve(null);
      }
    });
  },

  // ---------------- 封面（用户自定义图片） ----------------
  // 选图 / 移除都走长按菜单的 `pickPhotoFor` / `clearPhotoFor`（#93 去掉了
  // 大卡上的「封面」按钮）。这里只保留空态与右上角入口。

  /** 空态：去发现页扫描。 */
  onEmptyTap() {
    pushTo(PAGE_ROUTES.discover);
  },

  /** 右上角「+」→ 添加设备（去发现页；发现页是二级页，压栈进入）。 */
  onGoDiscover() {
    pushTo(PAGE_ROUTES.discover);
  },
});

