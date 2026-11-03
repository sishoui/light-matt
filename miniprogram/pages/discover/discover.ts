/**
 * 发现页（二级页）：清单式扫描 + 「添加设备」表单弹层（#92）。
 *
 * ## 为什么点一行不再直接连
 *
 * 旧行为是「点一下就连上并离开」，用户没有任何机会先起名字、选封面——只能
 * 事后再去设备信息页改名，封面还要在首页大卡上找按钮。现在点一行从底部
 * 升起表单：名称（预填）+ 封面（可选）+「添加并连接」。
 *
 * ## 页面结构
 *
 * 灰底搜索条 → 分组标题（「附近的设备」+ 台数）→ 每行（封面缩略图 / 名称 /
 * 信号说明 / 四格信号条）→ 底部「重新扫描」文字按钮。没有设备时是空态文案，
 * 不是一条孤零零的灰条。
 *
 * ## 表单关掉之后扫描要继续
 *
 * 关表单只关弹层，**不停扫描**——用户改变主意再点别的设备时不用白等一轮。
 *
 * ## 名称与封面的写入路径（后面 #93 / #94 复用）
 *
 * - 名称 → 设备备注（`setRemark`，备注名优先显示），再走既有云端同步旁路
 *   （`DeviceSync.pushRemark`）；
 * - 封面 → 封面存储（`setDevicePhoto`，按 deviceKey = hardwareId 优先）。
 */

import { errorText } from "../../utils/ble/errors";
import type { LinkDetail } from "../../utils/ble/transport";
import { ConnectCancelledError } from "../../utils/ble/transport";
import {
  buildAddPrefill,
  buildDiscoverRows,
  filterScanRows,
  type DiscoverRowView,
} from "../../utils/control/add-device";
import { createWxStorage } from "../../utils/control/device-cache";
import { buildMyDevices, buildScanRows, type ScanRow } from "../../utils/control/device-list";
import { deviceKeyOf } from "../../utils/control/device-history";
import {
  loadRegistry,
  findEntry,
  setRemark,
  type DeviceRegistry,
} from "../../utils/control/device-registry";
import {
  clearDevicePhoto,
  deleteDevicePhotoFile,
  loadDevicePhotos,
  photoKeyOf,
  pickDevicePhoto,
  setDevicePhoto,
  type DevicePhotoMap,
} from "../../utils/control/device-photo";
import { getDeviceApi } from "../../utils/control/device-api-singleton";
import { DeviceSync, syncApiOf } from "../../utils/control/device-sync";
import { pageThemeData } from "../../utils/control/page-theme";
import { TAB_ROUTES, switchTabTo } from "../../utils/control/routes";
import type { ControlSession } from "../../utils/control/session";
import { getSession } from "../../utils/control/session-singleton";
import { statusView } from "../../utils/control/status-view";
import type { DeviceState, DiscoveredDevice, LinkState } from "../../utils/protocol/types";

Page({
  data: {
    themeClass: "",
    /** 实际深色（含「跟随系统」解析）。 */
    dark: false,
    /** 原生 slider / switch 的激活色（不读 CSS 变量）。 */
    accentColor: "",

    /* 连接状态（收在导航栏副标题里，不再单独占一条）。 */
    statusText: "未连接",
    statusSub: "点下面的按钮扫描附近的灯控",
    linkClass: "link-idle",
    navSubtitle: "扫描附近的 Lumen 灯控",

    /* 搜索条。 */
    query: "",

    /* 结果列表。 */
    rows: [] as DiscoverRowView[],
    total: 0,
    scanning: false,
    busy: false,
    scanLabel: "重新扫描",
    emptyText: "还没有扫描到设备",
    emptyHint: "把灯控通电，再点下面的「重新扫描」。",
    scanHint: "",

    /* 添加表单（页面内弹层，不用系统动作面板：需要输入框与相册选图）。 */
    formOpen: false,
    formName: "",
    formPhoto: "",
    formAlreadyAdded: false,
    formDeviceId: "",
    formBroadcastName: "",
  },

  session: null as ControlSession | null,
  registry: null as DeviceRegistry | null,
  photos: {} as DevicePhotoMap,
  sync: null as DeviceSync | null,
  /** 实时扫描结果（原始；派生视图每次重算）。 */
  discovered: [] as DiscoveredDevice[],
  /** 当前所有扫描行（未过滤；搜索只在视图层过滤）。 */
  allRows: [] as ScanRow[],
  unsubscribers: [] as Array<() => void>,
  /** 表单保存中（防重复提交）。 */
  formBusy: false,

  onLoad() {
    /* 私有字段必须在这里显式兜底：Page() 只保证 data 里的字段出现在
     * this.data，写在对象字面量上的其它字段运行时是 undefined。它们一旦
     * 在 onLoad 的调用链上被读，页面初始化就中断，所有 bindtap 全部失效。 */
    this.discovered = [];
    this.allRows = [];
    this.unsubscribers = [];
    this.registry = null;
    this.photos = {};
    this.formBusy = false;

    const storage = createWxStorage();
    this.session = getSession();
    this.registry = this.loadRegistry();
    this.photos = loadDevicePhotos(storage);
    this.sync = new DeviceSync({ api: syncApiOf(getDeviceApi()), storage });
    this.setData({ ...pageThemeData(storage) });
    this.applyLink(this.session.linkState);
  },

  onShow() {
    /* 会话可能在别处被重建（演示设备开关）；换了实例就重新订阅，
     * 否则扫描结果与链路状态都停在上一个实例上。 */
    const current = getSession();
    if (current !== this.session) {
      this.unsubscribe();
      this.session = current;
    }
    this.subscribe();
    this.registry = this.loadRegistry();
    this.photos = loadDevicePhotos(createWxStorage());
    this.setData({ ...pageThemeData(createWxStorage()) });
    const session = this.session;
    if (session !== null) {
      this.applyLink(session.linkState);
    }
  },

  onHide() {
    this.unsubscribe();
  },

  onUnload() {
    this.unsubscribe();
    this.session = null;
    this.sync = null;
  },

  loadRegistry(): DeviceRegistry {
    try {
      return loadRegistry(createWxStorage());
    } catch {
      return { devices: [] };
    }
  },

  subscribe() {
    const session = this.session;
    if (session === null) {
      return;
    }
    this.unsubscribers = [
      session.onLink((state, detail) => this.applyLink(state, detail)),
      session.onDevices((devices) => this.applyDevices(devices)),
      session.onScanHint((hint) => this.setData({ scanHint: hint ?? "" })),
    ];
  },

  unsubscribe() {
    for (const off of this.unsubscribers ?? []) {
      off();
    }
    this.unsubscribers = [];
  },

  // ---------------- 状态 ----------------

  applyLink(state: LinkState, detail?: LinkDetail) {
    const session = this.session;
    const view = statusView(
      state,
      detail?.deviceName ?? "",
      detail?.message,
      session?.reconnectPending ?? false,
      (session?.cachedDevice ?? null) !== null,
    );
    const busyConnect = state === "connecting" || state === "initializing";
    const scanning = state === "scanning";
    this.setData({
      statusText: view.statusText,
      statusSub: view.statusSub,
      navSubtitle: this.navSubtitleOf(state, view, detail),
      linkClass: view.linkClass,
      scanning,
      scanLabel: scanning ? "停止扫描" : busyConnect ? "取消连接" : "重新扫描",
      busy: busyConnect,
    });
    this.refreshRows();
  },

  /** 导航栏副标题承担原来的「一行连接状态」：扫描中 / 已连接 N 台 / 失败原因。 */
  navSubtitleOf(state: LinkState, view: ReturnType<typeof statusView>, detail?: LinkDetail): string {
    if (state === "scanning") {
      return "正在扫描附近的灯控…";
    }
    if (state === "connecting" || state === "initializing") {
      const name = detail?.deviceName ?? "";
      return name.length > 0 ? `正在连接 ${name}…` : "正在连接…";
    }
    if (state === "ready") {
      return this.data.total > 0 ? `已连接 · 附近 ${this.data.total} 台` : "已连接";
    }
    if (state === "failed") {
      return view.statusSub;
    }
    return "扫描附近的 Lumen 灯控";
  },

  applyDevices(devices: DiscoveredDevice[]) {
    this.discovered = devices;
    this.refreshRows();
  },

  /** 扫描结果 → 列表行（信号降序；已知设备只打徽标，不过滤）。 */
  refreshRows() {
    const session = this.session;
    const registry = this.registry ?? { devices: [] };
    const mine = buildMyDevices({
      recent: session?.recentDevices ?? [],
      registry: registry.devices,
      backend: null,
      live: this.liveFacts(),
    });
    this.allRows = buildScanRows({
      discovered: this.discovered,
      mine,
      currentDeviceId: session?.transport.currentDeviceId ?? null,
    });
    this.applyQuery();
  },

  /** 应用搜索词（只改视图，不动扫描）。 */
  applyQuery() {
    const filtered = filterScanRows(this.allRows, this.data.query);
    const rows = buildDiscoverRows({
      rows: filtered,
      photoOf: (deviceId) => this.photoOfRow(deviceId),
    });
    const searching = this.data.query.trim().length > 0;
    this.setData({
      rows,
      total: this.allRows.length,
      emptyText: searching
        ? `没有名称包含「${this.data.query.trim()}」的设备`
        : this.discovered.length > 0
          ? "附近没有更多设备"
          : this.data.scanning
            ? "正在扫描…"
            : "还没有扫描到设备",
      emptyHint: searching ? "换个关键词，或清空搜索看全部。" : "把灯控通电，再点下面的「重新扫描」。",
      navSubtitle:
        this.data.linkClass === "link-ready"
          ? `已连接 · 附近 ${this.allRows.length} 台`
          : this.data.navSubtitle,
    });
  },

  /** 每行的封面：按 deviceKey 取（hardwareId 优先，iOS 换 UUID 也认得）。 */
  photoOfRow(deviceId: string): string {
    const entry = findEntry(this.registry ?? { devices: [] }, deviceId);
    const key = deviceKeyOf({ deviceId, hardwareId: entry?.hardwareId });
    return photoKeyOf(this.photos, key);
  },

  /** 当前已连接设备的实时条数（只有它值钱，其余都是缓存）。 */
  liveFacts(): { deviceId: string; stripCount: number; firmwareVer: number | null } | null {
    const session = this.session;
    const deviceId = session?.transport.currentDeviceId ?? "";
    const state: DeviceState | null = session?.deviceState ?? null;
    if (session === null || deviceId.length === 0 || state === null) {
      return null;
    }
    return {
      deviceId,
      stripCount: state.stripCount,
      firmwareVer: session.deviceInfo?.firmwareVersion ?? null,
    };
  },

  // ---------------- 搜索 ----------------

  onQueryInput(e: WechatMiniprogram.Input) {
    this.setData({ query: String(e.detail.value ?? "") });
    this.applyQuery();
  },

  onQueryClear() {
    if (this.data.query.length === 0) {
      return;
    }
    this.setData({ query: "" });
    this.applyQuery();
  },

  // ---------------- 扫描 ----------------

  /**
   * 扫描 / 停止 / 取消连接。
   *
   * 一个按钮承担三态：空闲时扫描、扫描中停止、连接中取消。底层连接无法
   * 中断，`cancelConnect` 让这次尝试作废并把链路改回 idle。
   */
  async onScanTap() {
    const session = this.session;
    if (session === null) {
      return;
    }
    const state = session.linkState;
    if (state === "scanning") {
      await session.stopScan();
      return;
    }
    if (state === "connecting" || state === "initializing") {
      if (session.cancelConnect()) {
        wx.showToast({ title: "已取消连接", icon: "none" });
      }
      return;
    }
    await this.startScan();
  },

  async startScan() {
    const session = this.session;
    if (session === null) {
      return;
    }
    this.setData({ scanHint: "" });
    this.discovered = [];
    this.allRows = [];
    this.refreshRows();
    try {
      await session.scan();
    } catch (err) {
      this.setData({ scanHint: errorText(err) });
    }
  },

  // ---------------- 点一行 = 打开添加表单 ----------------

  onRowTap(e: WechatMiniprogram.TouchEvent) {
    const deviceId = String(e.currentTarget.dataset.deviceId ?? "");
    if (deviceId.length === 0) {
      return;
    }
    const row = this.allRows.find((item) => item.deviceId === deviceId);
    if (row === undefined) {
      return;
    }
    this.openForm(row);
  },

  /**
   * 打开添加表单。
   *
   * 已添加过的设备预填现有资料并注明「已添加过」——不覆盖用户起过的名字。
   * 扫描**不停**：关掉表单就能接着点别的。
   */
  openForm(row: ScanRow) {
    const storage = createWxStorage();
    this.registry = this.loadRegistry();
    this.photos = loadDevicePhotos(storage);
    const entry = findEntry(this.registry, row.deviceId);
    const key = deviceKeyOf({
      deviceId: row.deviceId,
      hardwareId: entry?.hardwareId,
    });
    const prefill = buildAddPrefill({
      row,
      registry: this.registry.devices,
      photo: photoKeyOf(this.photos, key),
      broadcastName: row.name,
    });
    this.setData({
      formOpen: true,
      formName: prefill.name,
      formPhoto: prefill.photo,
      formAlreadyAdded: prefill.alreadyAdded,
      formDeviceId: row.deviceId,
      formBroadcastName: row.name,
    });
  },

  onFormNameInput(e: WechatMiniprogram.Input) {
    this.setData({ formName: String(e.detail.value ?? "") });
  },

  /** 点遮罩关表单（扫描继续）。 */
  onFormMaskTap() {
    this.closeForm();
  },

  /** 点表单本体不冒泡到遮罩。 */
  onFormStopPropagation() {
    /* 空实现：只用来 catchtap 阻断冒泡。 */
  },

  closeForm() {
    if (this.formBusy) {
      return;
    }
    this.setData({ formOpen: false, formName: "", formPhoto: "", formDeviceId: "", formAlreadyAdded: false });
  },

  /** 选封面（相册）。取消 / 失败都不报错。 */
  async onFormPickPhoto() {
    if (this.formBusy) {
      return;
    }
    const deviceId = this.data.formDeviceId;
    const entry = findEntry(this.registry ?? { devices: [] }, deviceId);
    const key = deviceKeyOf({ deviceId, hardwareId: entry?.hardwareId });
    const saved = await pickDevicePhoto(key, this.data.formPhoto);
    if (saved === null) {
      return;
    }
    this.photos = setDevicePhoto(createWxStorage(), key, saved);
    this.setData({ formPhoto: saved });
  },

  /** 移除已选封面（表单内的小按钮）。 */
  onFormClearPhoto() {
    if (this.data.formPhoto.length === 0) {
      return;
    }
    const deviceId = this.data.formDeviceId;
    const entry = findEntry(this.registry ?? { devices: [] }, deviceId);
    const key = deviceKeyOf({ deviceId, hardwareId: entry?.hardwareId });
    deleteDevicePhotoFile(this.data.formPhoto);
    this.photos = clearDevicePhoto(createWxStorage(), key);
    this.setData({ formPhoto: "" });
  },

  /**
   * 「添加并连接」：写名称 + 封面，然后连接。
   *
   * 顺序刻意是「先落本机资料，再连接」：连接可能失败，但用户填的资料不该丢。
   * 名称走 `setRemark`（本机权威）并触发云端同步旁路；封面已在上一步落盘。
   */
  async onFormSubmit() {
    const session = this.session;
    const deviceId = this.data.formDeviceId;
    if (session === null || deviceId.length === 0 || this.formBusy) {
      return;
    }
    this.formBusy = true;
    const name = this.data.formName.trim();
    const storage = createWxStorage();
    try {
      if (name.length > 0) {
        this.registry = setRemark(storage, deviceId, name);
      }
      this.photos = loadDevicePhotos(storage);
    } finally {
      this.formBusy = false;
    }
    this.setData({ formOpen: false });
    await this.connectRow(deviceId, name);
  },

  // ---------------- 连接 + 返回 ----------------

  async connectRow(deviceId: string, name: string) {
    const session = this.session;
    if (session === null) {
      return;
    }
    /* 已经连着这台：不用再连，直接回来源页。 */
    if (session.linkState === "ready" && session.transport.currentDeviceId === deviceId) {
      this.afterConnect(deviceId, name);
      return;
    }
    const switching =
      session.linkState === "ready" && session.transport.currentDeviceId !== deviceId;
    this.setData({ scanHint: "" });
    try {
      if (switching) {
        await session.switchTo(deviceId, name);
      } else {
        await session.connect(deviceId, name);
      }
      await session.stopScan().catch(() => undefined);
      this.afterConnect(deviceId, name);
    } catch (err) {
      /* 用户点「取消」：不是错误，状态行已经回到「未连接」。 */
      if (err instanceof ConnectCancelledError) {
        return;
      }
      this.setData({ scanHint: errorText(err) });
      wx.showToast({ title: errorText(err), icon: "none" });
    }
  },

  /** 连接成功后：刷新本机资料、后台同步备注，再回来源页。 */
  afterConnect(deviceId: string, name: string) {
    this.registry = this.loadRegistry();
    /* 云端同步是旁路：失败不影响本地（用户已经能用了）。 */
    const hardwareId = findEntry(this.registry, deviceId)?.hardwareId ?? "";
    if (hardwareId.length > 0 && name.length > 0) {
      void this.sync?.pushRemark({ deviceId, hardwareId }).catch(() => undefined);
    }
    this.leave();
  },

  /**
   * 回到来源页。
   *
   * 栈里没有上一页时（从分享卡片直达 / 栈深为 1）`navigateBack` 不会真的
   * 返回，所以先看栈深再决定：<= 1 直接回设备 tab。绝不能 `pushTo(device)`
   * ——那会压出两层设备页。
   */
  leave() {
    const depth = getCurrentPages().length;
    if (depth <= 1) {
      switchTabTo(TAB_ROUTES.home);
      return;
    }
    wx.navigateBack({
      fail: () => switchTabTo(TAB_ROUTES.home),
    });
  },
});
