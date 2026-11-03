/**
 * 发现页（二级页）：扫描附近的 Lumen 灯控，点一行连上并回到来源页。
 *
 * ## 只做一件事
 *
 * 本页只有一个扫描 / 停止按钮、一行连接状态、一个扫描结果列表。
 * 「我的设备」、外观、演示设备、版本号与协议日志都搬到了 `pages/me`，
 * 「显示的灯组」搬到了 `pages/device-info`——发现只是「偶发的一次扫描」，
 * 不该再承担设置入口。
 *
 * ## 点一行之后去哪（裁决 §6）
 *
 * 发现页是**二级页**：连接成功后 `navigateBack()` 回到来源页；只有栈里没有
 * 上一页（从分享卡片直达 / 栈深为 1）时才 `switchTab(home)`。
 * 绝不能 `pushTo(device)`——那会压出两层设备页。
 *
 * ## 「已知」徽标
 *
 * 结果列表**不**过滤已登记设备（本页没有「我的设备」列表，过滤掉就没法点
 * 那台设备了），只标出「这台你认识」（见 `buildScanRows`）。
 */

import { errorText } from "../../utils/ble/errors";
import type { LinkDetail } from "../../utils/ble/transport";
import { ConnectCancelledError } from "../../utils/ble/transport";
import { createWxStorage } from "../../utils/control/device-cache";
import { buildMyDevices, buildScanRows } from "../../utils/control/device-list";
import { loadRegistry, type DeviceRegistry } from "../../utils/control/device-registry";
import { TAB_ROUTES, switchTabTo } from "../../utils/control/routes";
import type { ControlSession } from "../../utils/control/session";
import { getSession } from "../../utils/control/session-singleton";
import { statusView } from "../../utils/control/status-view";
import { loadTheme, themeClass } from "../../utils/control/theme";
import type { DeviceState, DiscoveredDevice, LinkState } from "../../utils/protocol/types";

/** 扫描结果行（`buildScanRows` 的展示投影）。 */
interface ScanRowView {
  deviceId: string;
  name: string;
  rssiText: string;
  /** 已在「我的设备」里（徽标「已知」）。 */
  known: boolean;
  /** 是否就是当前连接的那台。 */
  current: boolean;
}

Page({
  data: {
    themeClass: "",

    /* 一行连接状态（文案由 statusView 给；唯一的动作按钮在下面）。 */
    statusText: "未连接",
    statusSub: "点「扫描」查找附近的灯控",
    linkClass: "link-idle",

    /* 唯一的动作按钮：扫描 / 停止 / 取消连接。 */
    scanning: false,
    busy: false,
    scanLabel: "扫描",

    /* 结果列表。 */
    scanned: [] as ScanRowView[],
    emptyText: "点上面的「扫描」查找附近设备",
    scanHint: "",
  },

  session: null as ControlSession | null,
  registry: null as DeviceRegistry | null,
  /** 实时扫描结果（原始；派生视图每次重算）。 */
  discovered: [] as DiscoveredDevice[],
  unsubscribers: [] as Array<() => void>,

  onLoad() {
    /* 私有字段必须在这里显式兜底：Page() 只保证 data 里的字段出现在
     * this.data，写在对象字面量上的其它字段运行时是 undefined。它们一旦
     * 在 onLoad 的调用链上被读，页面初始化就中断，所有 bindtap 全部失效。 */
    this.discovered = [];
    this.unsubscribers = [];
    this.registry = null;

    this.session = getSession();
    this.registry = this.loadRegistry();
    this.setData({ themeClass: themeClass(loadTheme(createWxStorage())) });
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
    const expected = themeClass(loadTheme(createWxStorage()));
    if (this.data.themeClass !== expected) {
      this.setData({ themeClass: expected });
    }
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
    /* 空闲且没有消息时给出「去按扫描」的指路，而不是 statusView 默认的
     * 「点击选择设备」——本页没有并排的设备列表可点。 */
    const idleHint = state === "idle" && (detail?.message ?? "").length === 0;
    this.setData({
      statusText: view.statusText,
      statusSub: idleHint ? "点「扫描」查找附近的灯控" : view.statusSub,
      linkClass: view.linkClass,
      scanning: state === "scanning",
      scanLabel: state === "scanning" ? "停止扫描" : busyConnect ? "取消连接" : "扫描",
    });
    this.refreshRows();
  },

  applyDevices(devices: DiscoveredDevice[]) {
    this.discovered = devices;
    this.refreshRows();
  },

  /** 扫描结果 → 列表行（信号强度降序；已知设备只打徽标，不过滤）。 */
  refreshRows() {
    const session = this.session;
    const registry = this.registry ?? { devices: [] };
    const mine = buildMyDevices({
      recent: session?.recentDevices ?? [],
      registry: registry.devices,
      backend: null,
      live: this.liveFacts(),
    });
    const scanned: ScanRowView[] = buildScanRows({
      discovered: this.discovered,
      mine,
      currentDeviceId: session?.transport.currentDeviceId ?? null,
    }).map((row) => ({
      deviceId: row.deviceId,
      name: row.name,
      rssiText: row.rssiText,
      known: row.known,
      current: row.current,
    }));
    const emptyText =
      this.discovered.length > 0
        ? "附近没有更多设备"
        : this.data.scanning
          ? "扫描中…"
          : "点上面的「扫描」查找附近设备";
    this.setData({ scanned, emptyText });
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

  // ---------------- 唯一的动作按钮 ----------------

  /**
   * 扫描 / 停止 / 取消连接。
   *
   * 一个按钮承担三态：空闲时扫描、扫描中停止、连接中取消。底层连接无法
   * 中断，`cancelConnect` 让这次尝试作废并把链路改回 idle；被打断的
   * `connect()` 抛 `ConnectCancelledError`，由 `onRowTap` 静默吞掉。
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
        this.setData({ busy: false });
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
    this.refreshRows();
    try {
      await session.scan();
    } catch (err) {
      this.setData({ scanHint: errorText(err) });
    }
  },

  // ---------------- 点一行 = 连接 + 返回 ----------------

  async onRowTap(e: WechatMiniprogram.TouchEvent) {
    const session = this.session;
    if (session === null || this.data.busy) {
      return;
    }
    const deviceId = String(e.currentTarget.dataset.deviceId ?? "");
    const name = String(e.currentTarget.dataset.name ?? "");
    if (deviceId.length === 0) {
      return;
    }
    /* 已经连着这台：不用再连，直接回来源页。 */
    if (session.linkState === "ready" && session.transport.currentDeviceId === deviceId) {
      this.leave();
      return;
    }

    const switching =
      session.linkState === "ready" && session.transport.currentDeviceId !== deviceId;
    this.setData({ busy: true, scanHint: "" });
    try {
      if (switching) {
        await session.switchTo(deviceId, name);
      } else {
        await session.connect(deviceId, name);
      }
      await session.stopScan().catch(() => undefined);
      this.registry = this.loadRegistry();
      this.leave();
    } catch (err) {
      /* 用户点「取消」：不是错误，状态行已经回到「未连接」。 */
      if (err instanceof ConnectCancelledError) {
        return;
      }
      this.setData({ scanHint: errorText(err) });
    } finally {
      this.setData({ busy: false });
    }
  },

  /**
   * 回到来源页（裁决 §6）。
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
