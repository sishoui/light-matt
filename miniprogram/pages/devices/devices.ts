/**
 * 设备页（tab 1）：扫描 / 最近连过 / 连接 / 备注名 / 隐藏灯带 / 协议日志。
 *
 * 这一页只有「设备」这一个维度，所以它不关心当前是第几条灯带；连接成功后
 * 直接 `switchTab` 到灯光页（票面验收：连上后自动跳到灯光）。
 *
 * 状态纪律（#41 引入，所有页都遵守）：
 *  - 会话是 App 级单例（`getSession()`），页面**从不** destroy 它；
 *  - 监听在 `onShow` 订阅、`onHide` 退订（tab 页永不 unload）；
 *  - 设备是权威：连接后所有设备级数值都来自 State / Query*，不用本地缓存覆盖。
 *
 * #44 的落点：设备列表的后端同步（`POST /devices/register` 等）与 hardwareId
 * 去重都在这页展开；当前只做纯本地（device-history + device-registry）。
 */

import { errorText } from "../../utils/ble/errors";
import type { LogPanelRow } from "../../utils/ble/log-panel";
import type { LinkDetail } from "../../utils/ble/transport";
import { ControlSession, detectDevMode } from "../../utils/control/session";
import { getSession } from "../../utils/control/session-singleton";
import { statusView } from "../../utils/control/status-view";
import {
  loadRegistry,
  recordSeen,
  removeDevice,
  setRemark,
  setStripEnabled,
  stripEnabled,
  type DeviceRegistry,
} from "../../utils/control/device-registry";
import { createWxStorage } from "../../utils/control/device-cache";
import { LogPanelView } from "../../utils/control/log-panel-view";
import { MAX_STRIPS } from "../../utils/protocol/constants";
import type { DeviceState, DiscoveredDevice, LinkState } from "../../utils/protocol/types";
import { TAB_ROUTES, PAGE_ROUTES, pushTo, switchTabTo } from "../../utils/control/routes";

interface DeviceRowView {
  deviceId: string;
  /** 显示名：备注名 > 广播名 > deviceId。 */
  label: string;
  /** 副标题：deviceId / RSSI / 硬件号 / 最近连接时间。 */
  meta: string;
  /** 是否当前连接的这台。 */
  current: boolean;
}

/** 连接成功后的自动跳转：只跳一次，避免每次 onShow 都抢用户导航。 */
let autoJumpedOnce = false;

Page({
  data: {
    statusText: "未连接",
    statusSub: "点击扫描",
    statusAction: "扫描",
    linkClass: "link-idle",
    ready: false,

    // 设备列表
    currentDeviceId: "",
    currentDeviceName: "",
    recentDevices: [] as DeviceRowView[],
    nearbyDevices: [] as DeviceRowView[],
    scanHint: "",
    scanning: false,
    switchBusy: false,

    // 备注名
    remarkInput: "",

    // 灯带启用掩码（App 本地偏好，永不下发）
    stripRows: [] as Array<{ stripId: number; label: string; enabled: boolean }>,

    // 日志面板（#13）
    logVisible: false,
    logPaused: false,
    logRows: [] as LogPanelRow[],
    logCount: 0,
    logHint: "",
    logScrollTarget: "",
    version: "0.3.0",
  },

  session: null as ControlSession | null,
  logView: null as LogPanelView | null,
  registry: null as DeviceRegistry | null,
  unsubscribers: [] as Array<() => void>,

  onLoad() {
    const session = getSession();
    this.session = session;
    this.logView = new LogPanelView(session.log, {
      setData: (patch) => this.setData(patch),
    });
    this.refreshRegistry();
    console.log(
      `[lumen] 设备页就绪（开发版日志 ${detectDevMode() ? "开启" : "关闭"}）`,
    );
  },

  onShow() {
    this.subscribe();
    this.syncStatus();
    this.refreshRegistry();
  },

  onHide() {
    this.unsubscribe();
  },

  onUnload() {
    /* 二级页/非 tab 时才真正卸载；会话属于 App，绝不 destroy。 */
    this.unsubscribe();
    this.logView?.destroy();
    this.logView = null;
    this.session = null;
  },

  /** 订阅在 onShow 建立：切走再回来时链路可能已经变了，监听必须重新挂上。 */
  subscribe() {
    const session = this.session;
    if (session === null) {
      return;
    }
    this.unsubscribers = [
      session.onLink((state, detail) => this.applyLink(state, detail)),
      session.onDevices((devices) => this.applyDevices(devices)),
      session.onScanHint((hint) => this.setData({ scanHint: hint ?? "" })),
      session.onState((state) => this.applyDeviceState(state)),
      session.log.onAppend(() => this.logView?.onAppend()),
    ];
  },

  unsubscribe() {
    for (const off of this.unsubscribers) {
      off();
    }
    this.unsubscribers = [];
  },

  // ---------------- 状态条 ----------------

  syncStatus() {
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
      detail?.deviceName ?? this.data.currentDeviceName,
      detail?.message,
      session?.reconnectPending ?? false,
      (session?.cachedDevice ?? null) !== null,
    );
    const ready = state === "ready";
    this.setData({
      ...view,
      ready,
      scanning: state === "scanning",
      currentDeviceId: session?.transport.currentDeviceId ?? "",
      ...(state === "ready" && detail?.deviceName !== undefined
        ? { currentDeviceName: detail.deviceName }
        : {}),
    });
    if (state === "ready") {
      /* 票面验收：从设备页连接成功后自动跳到灯光页（整段会话只跳一次）。 */
      if (!autoJumpedOnce) {
        autoJumpedOnce = true;
        switchTabTo(TAB_ROUTES.light);
      }
    } else {
      /* 断线后允许下一次连接再次自动跳转。 */
      autoJumpedOnce = false;
    }
  },

  async onStatusTap() {
    const session = this.session;
    if (session === null) {
      return;
    }
    const state = session.linkState;
    if (state === "scanning" || state === "connecting" || state === "initializing") {
      if (state === "scanning") {
        await session.stopScan();
      }
      return;
    }
    if (state === "ready") {
      switchTabTo(TAB_ROUTES.light);
      return;
    }
    await this.startScan();
  },

  // ---------------- 扫描与连接 ----------------

  async startScan() {
    const session = this.session;
    if (session === null) {
      return;
    }
    this.setData({ scanHint: "", nearbyDevices: [] });
    try {
      await session.scan();
    } catch (err) {
      this.setData({ scanHint: errorText(err) });
    }
  },

  async onRescan() {
    await this.startScan();
  },

  async onStopScan() {
    await this.session?.stopScan();
  },

  applyDevices(devices: DiscoveredDevice[]) {
    const registry = this.registry;
    const current = this.data.currentDeviceId;
    this.setData({
      nearbyDevices: devices.map((device) => ({
        deviceId: device.deviceId,
        label: this.labelOf(registry, device.deviceId, device.name),
        meta: `${device.deviceId} · ${device.rssi} dBm`,
        current: device.deviceId === current,
      })),
    });
  },

  labelOf(registry: DeviceRegistry | null, deviceId: string, fallback: string): string {
    const entry = registry?.devices.find((item) => item.deviceId === deviceId);
    if (entry?.remark !== undefined && entry.remark.length > 0) {
      return entry.remark;
    }
    return fallback.length > 0 ? fallback : deviceId;
  },

  /** 点列表 = 连接；已连着别的设备时是**切换**（先断后连，失败不回滚）。 */
  async onDeviceTap(e: WechatMiniprogram.TouchEvent) {
    const session = this.session;
    if (session === null || this.data.switchBusy) {
      return;
    }
    const deviceId = String(e.currentTarget.dataset.deviceId ?? "");
    const name = String(e.currentTarget.dataset.name ?? "");
    if (!deviceId) {
      return;
    }
    const switching =
      session.linkState === "ready" && session.transport.currentDeviceId !== deviceId;
    this.setData({ switchBusy: true, scanHint: "" });
    try {
      if (switching) {
        await session.switchTo(deviceId, name);
      } else {
        await session.connect(deviceId, name);
      }
      await session.stopScan().catch(() => undefined);
      this.recordConnection(deviceId);
      this.setData({ currentDeviceId: deviceId, currentDeviceName: name });
    } catch (err) {
      this.setData({ scanHint: errorText(err) });
    } finally {
      this.setData({ switchBusy: false });
    }
  },

  /**
   * 连上后记一次「见过」。
   *
   * 只更新时间戳：**不**把广播名写进备注名——广播名（`Lumen-XXXX`）不是用户
   * 起的名，写进去会让「用户改过名没有」这个判断失真，还会在设备改名后留下
   * 一条陈旧记录。备注名只由用户在输入框里设置。
   */
  recordConnection(deviceId: string) {
    try {
      const storage = createWxStorage();
      this.refreshRegistryFrom(recordSeen(storage, deviceId, Date.now()));
    } catch (err) {
      console.warn(`[lumen] 记录设备失败：${errorText(err)}`);
    }
  },

  remarkOf(deviceId: string): string | null {
    const entry = this.registry?.devices.find((item) => item.deviceId === deviceId);
    return entry?.remark ?? null;
  },

  // ---------------- 备注名 ----------------

  onRemarkInput(e: WechatMiniprogram.Input) {
    this.setData({ remarkInput: String(e.detail.value ?? "") });
  },

  async onSaveRemark() {
    const deviceId = this.data.currentDeviceId;
    if (!deviceId) {
      wx.showToast({ title: "先连接一台设备", icon: "none" });
      return;
    }
    try {
      const storage = createWxStorage();
      const registry = setRemark(storage, deviceId, this.data.remarkInput);
      this.refreshRegistryFrom(registry);
      this.setData({ currentDeviceName: this.data.remarkInput.trim() });
      wx.showToast({ title: "备注名已保存", icon: "none" });
    } catch (err) {
      wx.showToast({ title: errorText(err), icon: "none" });
    }
  },

  // ---------------- 灯带启用掩码（App 本地） ----------------

  /**
   * 本地偏好，**永不下发**：WS2812B 无法回报物理接线，设备判断不了某条带
   * 是否真的插着。隐藏只从切换器里去掉，设备上的段配置一个字节都不动。
   */
  async onTrimStrip(e: WechatMiniprogram.SwitchChange) {
    const deviceId = this.data.currentDeviceId;
    const stripId = Number(e.currentTarget.dataset.stripId ?? -1);
    if (!deviceId || stripId < 0) {
      return;
    }
    try {
      const storage = createWxStorage();
      const registry = setStripEnabled(storage, deviceId, stripId, Boolean(e.detail.value));
      this.refreshRegistryFrom(registry);
    } catch (err) {
      wx.showToast({ title: errorText(err), icon: "none" });
    }
  },

  refreshRegistryFrom(registry: DeviceRegistry) {
    this.registry = registry;
    this.applyRegistryView();
  },

  refreshRegistry() {
    try {
      this.registry = loadRegistry(createWxStorage());
    } catch {
      this.registry = { devices: [] };
    }
    this.applyRegistryView();
  },

  applyRegistryView() {
    const registry = this.registry ?? { devices: [] };
    const deviceId = this.data.currentDeviceId;
    const session = this.session;
    const state = session?.deviceState ?? null;
    /* 条数以设备 State 为准；未连接时按 8 条展示，方便提前配置偏好。 */
    const stripCount = Math.max(1, Math.min(MAX_STRIPS, state?.stripCount ?? MAX_STRIPS));
    const stripRows: Array<{ stripId: number; label: string; enabled: boolean }> = [];
    for (let stripId = 0; stripId < stripCount; stripId += 1) {
      stripRows.push({
        stripId,
        label: `灯带 ${stripId + 1}`,
        /* 没有 deviceId（还没连过）时按默认全启用显示。 */
        enabled: deviceId.length === 0 ? true : stripEnabled(registry, deviceId, stripId),
      });
    }
    this.setData({
      stripRows,
      remarkInput: deviceId.length > 0 ? this.remarkOf(deviceId) ?? "" : "",
      recentDevices: this.buildRecentRows(registry),
    });
  },

  /** 「最近连过」来自 device-history（会话已按时间排序）；显示名叠加备注名。 */
  buildRecentRows(registry: DeviceRegistry): DeviceRowView[] {
    const session = this.session;
    const current = this.data.currentDeviceId;
    return (session?.recentDevices ?? []).map((entry) => {
      const meta = registry.devices.find((item) => item.deviceId === entry.deviceId);
      const when = new Date(entry.lastConnectedAt);
      return {
        deviceId: entry.deviceId,
        label: this.labelOf(registry, entry.deviceId, entry.name ?? ""),
        meta: `${entry.deviceId} · ${formatWhen(when)}${
          meta?.hardwareId !== undefined ? ` · ${meta.hardwareId}` : ""
        }`,
        current: entry.deviceId === current,
      };
    });
  },

  async onForgetDevice(e: WechatMiniprogram.TouchEvent) {
    const deviceId = String(e.currentTarget.dataset.deviceId ?? "");
    if (!deviceId) {
      return;
    }
    const confirmed = await showConfirm("忘记这台设备？", "只会删除本机记录，不影响设备上的灯光配置。");
    if (!confirmed) {
      return;
    }
    try {
      this.refreshRegistryFrom(removeDevice(createWxStorage(), deviceId));
    } catch (err) {
      wx.showToast({ title: errorText(err), icon: "none" });
    }
  },

  // ---------------- 设备状态（只用于显示当前连接与灯珠数） ----------------

  applyDeviceState(state: DeviceState) {
    /* 设备页不展示具体灯光，只更新「当前设备 / 条数」派生视图。 */
    void state;
    this.setData({ ready: true });
    this.applyRegistryView();
  },

  onOpenDeviceInfo() {
    const session = this.session;
    if (session === null || session.linkState !== "ready") {
      wx.showToast({ title: "先连接设备", icon: "none" });
      return;
    }
    /* 二级页：push 进入，返回键回到本页（不要 switchTab 覆盖返回路径）。 */
    pushTo(PAGE_ROUTES.deviceInfo);
  },

  // ---------------- 隐藏协议日志面板（#13） ----------------

  onVersionTap() {
    this.logView?.onVersionTap(Date.now());
  },

  onLogPauseTap() {
    this.logView?.onPauseTap();
  },

  onLogClearTap() {
    this.logView?.onClearTap();
  },

  onLogCopyTap() {
    this.logView?.onCopyTap();
  },

  onLogCloseTap() {
    this.logView?.onCloseTap();
  },

  /** catchtap 占位：阻止面板内部点击穿透到遮罩。 */
  noop() {
    /* 空实现 */
  },
});

/** 「上次连接」的可读时间：今天只显示时分，更早显示月日。 */
function formatWhen(date: Date): string {
  if (Number.isNaN(date.getTime())) {
    return "未知时间";
  }
  const now = new Date();
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();
  const hh = String(date.getHours()).padStart(2, "0");
  const mm = String(date.getMinutes()).padStart(2, "0");
  if (sameDay) {
    return `今天 ${hh}:${mm}`;
  }
  return `${date.getMonth() + 1}月${date.getDate()}日`;
}

function showConfirm(title: string, content: string): Promise<boolean> {
  return new Promise((resolve) => {
    wx.showModal({
      title,
      content,
      confirmText: "删除",
      cancelText: "取消",
      success: (res) => resolve(res.confirm),
      fail: () => resolve(false),
    });
  });
}
