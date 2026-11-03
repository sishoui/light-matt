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
import { loadTheme, themeClass, type ThemeMode } from "../../utils/control/theme";
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
    mock: false,

    // 连接状态条
    statusText: "未连接",
    statusSub: "点「发现」查找设备",
    statusAction: "发现",
    linkClass: "link-idle",
    ready: false,
    connectingName: "",
    busy: false,

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

  onLoad() {
    /* 页面私有状态必须在这里显式初始化：Page() 不保证对象字面量字段被复制
     * 到实例上，漏掉会让 onShow 的调用链抛错并中断整页事件绑定。 */
    this.unsubscribers = [];
    this.selectedKey = "";
    this.photos = {};
    this.photoBusy = false;
    this.registry = null;

    const storage = createWxStorage();
    this.themeMode = loadTheme(storage);

    this.session = getSession();
    this.registry = loadRegistry(storage);
    this.photos = loadDevicePhotos(storage);
    this.setData({
      themeClass: themeClass(this.themeMode),
      mock: isMockSession(),
    });
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
    const expectedTheme = themeClass(this.themeMode);
    if (this.data.themeClass !== expectedTheme) {
      this.setData({ themeClass: expectedTheme });
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
  },

  onUnload() {
    this.unsubscribe();
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

  /** 自定义 tabBar 的选中态（索引与 app.json 顺序一致）。 */
  syncTabBar() {
    const tabBar = this.getTabBar?.();
    if (tabBar !== undefined && tabBar !== null) {
      tabBar.setData({ selected: 0 });
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
    );
    const ready = state === "ready";
    const connecting = state === "connecting" || state === "initializing";
    this.setData({
      ...view,
      ready,
      linkClass: view.linkClass,
      busy: connecting || this.data.busy,
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
    this.setData({
      cards,
      current,
      thumbnails: thumbnailsOf(cards),
      empty: view.empty,
    });
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
  onStatusTap() {
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
    if (card === null || session === null || this.data.busy || card.deviceId.length === 0) {
      return;
    }
    this.setData({ busy: true });
    try {
      if (!card.connected) {
        const switching = session.linkState === "ready";
        if (switching) {
          await session.switchTo(card.deviceId, card.name);
        } else {
          await session.connect(card.deviceId, card.name);
        }
        this.refresh();
      }
      const state = session.deviceState;
      if (state === null) {
        return;
      }
      const result = await session.setPower(state.power !== 1);
      if (result.kind === "ok") {
        this.refresh();
        /* 触感反馈（不支持时静默）。 */
        wx.vibrateShort?.({ type: "light", fail: () => undefined });
        return;
      }
      if (result.kind === "ack-error") {
        wx.showToast({ title: resultText(result.ack.resultCode), icon: "none" });
        return;
      }
      if (result.kind === "error") {
        wx.showToast({ title: result.message, icon: "none" });
      }
    } catch (err) {
      if (err instanceof ConnectCancelledError) {
        return;
      }
      wx.showToast({ title: errorText(err), icon: "none" });
    } finally {
      this.setData({ busy: false });
    }
  },

  // ---------------- 封面（用户自定义图片） ----------------

  /**
   * 点卡片右上角的「封面」按钮：选图并保存。
   *
   * catchtap 阻止冒泡——否则会连带触发进详情页。
   * 选图失败 / 用户取消都不提示错误（取消是正常意图）。
   */
  async onPickPhoto() {
    const card = this.data.current;
    if (card === null || this.photoBusy) {
      return;
    }
    this.setData({ photoBusy: true });
    try {
      const previous = card.photoIsUserPicked ? card.photo : "";
      const saved = await pickDevicePhoto(card.key, previous);
      if (saved === null) {
        return;
      }
      const storage = createWxStorage();
      this.photos = setDevicePhoto(storage, card.key, saved);
      this.refresh();
      wx.showToast({ title: "封面已更新", icon: "none" });
    } finally {
      this.setData({ photoBusy: false });
    }
  },

  /** 长按卡片：清除自定义封面，回到默认（演示图或渐变）。 */
  async onClearPhoto() {
    const card = this.data.current;
    if (card === null || !card.photoIsUserPicked) {
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
    const storage = createWxStorage();
    deleteDevicePhotoFile(photoKeyOf(this.photos, card.key));
    this.photos = clearDevicePhoto(storage, card.key);
    this.refresh();
    wx.showToast({ title: "已移除封面", icon: "none" });
  },

  /** 空态：去发现页扫描。 */
  onEmptyTap() {
    pushTo(PAGE_ROUTES.discover);
  },

  /** 右上角动作：去发现页（发现页是二级页，压栈进入）。 */
  onGoDiscover() {
    pushTo(PAGE_ROUTES.discover);
  },
});

