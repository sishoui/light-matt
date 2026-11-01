/**
 * 设备页（tab 1）：本地优先的设备列表 + 异步后端同步。
 *
 * ## 本地优先（#44 的核心约束）
 *
 * 首屏**只读本地**：`loadRecentDevices` + `loadRegistry` 立即渲染「我的设备」，
 * 一个网络字节都不等。网络只在后台补两件事：
 *  1. `POST /api/v1/session` 换取身份（`identityKind === "local"` 时提示「仅本机可见」）；
 *  2. `GET /api/v1/devices` 合并到列表（按 hardwareId 去重，**本地备注名赢**）。
 * 后端不可达时列表一行不少，只多一条顶部提示「离线，仅显示本机记录」。
 *
 * ## 同步永不阻塞控制
 *
 * 连接 / 备注 / 删除都先改本地，再 fire-and-forget 同步。任何 `{ok:false}`
 * 只会让离线提示出现，不会回滚本地、不会弹「失败」、不会影响 BLE。
 *
 * ## 状态纪律（#41 引入，所有页都遵守）
 *
 *  - 会话是 App 级单例（`getSession()`），页面**从不** destroy 它；
 *  - 监听在 `onShow` 订阅、`onHide` 退订（tab 页永不 unload）；
 *  - 设备是权威：连接后所有设备级数值都来自 State / Query*，不用缓存覆盖。
 */

import { errorText } from "../../utils/ble/errors";
import type { LogPanelRow } from "../../utils/ble/log-panel";
import type { LinkDetail } from "../../utils/ble/transport";
import { ControlSession, detectDevMode } from "../../utils/control/session";
import { getSession } from "../../utils/control/session-singleton";
import { statusView } from "../../utils/control/status-view";
import {
  loadRegistry,
  removeDevice,
  setRemark,
  setStripEnabled,
  stripEnabled,
  type DeviceRegistry,
} from "../../utils/control/device-registry";
import { createWxStorage } from "../../utils/control/device-cache";
import {
  buildMyDevices,
  buildNearby,
  type MyDeviceRow,
  type NearbyDeviceRow,
} from "../../utils/control/device-list";
import type { SyncedDevice } from "../../utils/control/device-api";
import { DeviceSync, syncApiOf } from "../../utils/control/device-sync";
import { getDeviceApi } from "../../utils/control/device-api-singleton";
import { LogPanelView } from "../../utils/control/log-panel-view";
import { MAX_STRIPS } from "../../utils/protocol/constants";
import type { DeviceState, DiscoveredDevice, LinkState } from "../../utils/protocol/types";
import { TAB_ROUTES, PAGE_ROUTES, pushTo, switchTabTo } from "../../utils/control/routes";

/** 「我的设备」的视图行 = 合并模型的展示投影（名字 / 灯带数 / 时间 / 可连性）。 */
interface DeviceRowView {
  /** 列表 key（hardwareId 优先），wx:key 用它——deviceId 在 iOS 上会变。 */
  key: string;
  deviceId: string;
  hardwareId: string;
  /** 显示名（备注 > 广播名 > hwId）。 */
  label: string;
  /** 副标题：身份 / 灯带数 / 最近连接时间。 */
  meta: string;
  /** 灯带数文本（带「上次 / 缓存」标注）。 */
  stripsText: string;
  /** 是否当前连接的这台。 */
  current: boolean;
  /** 只有后端记录：本机没连过，需要先扫到才能连。 */
  remoteOnly: boolean;
  /** 后端是否有这一行（决定是否显示「删除（解除关联）」）。 */
  linked: boolean;
  /** 灯带数来自缓存而非设备（UI 显示为弱化色）。 */
  cached: boolean;
}

interface NearbyRowView extends NearbyDeviceRow {
  rssiText: string;
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

    // 列表
    currentDeviceId: "",
    currentDeviceName: "",
    myDevices: [] as DeviceRowView[],
    nearbyDevices: [] as NearbyRowView[],
    /** 「附近设备」空态文案：区分「没扫到」与「扫到的都在我的设备里」。 */
    nearbyEmptyText: "点「扫描」开始查找",
    scanHint: "",
    scanning: false,
    switchBusy: false,

    // 同步状态（#44）
    syncHint: "",
    identityHint: "",

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
  sync: null as DeviceSync | null,
  /** 后端列表（最近一次成功拉取；失败时保留上一次成功的，不清空）。 */
  remoteDevices: [] as SyncedDevice[],
  /** 实时扫描结果（原始，派生视图每次重算）。 */
  discovered: [] as DiscoveredDevice[],
  /** 后端同步进行中：避免 onShow + 连接完成叠成两次并发。 */
  syncing: false,
  unsubscribers: [] as Array<() => void>,

  onLoad() {
    const session = getSession();
    this.session = session;
    this.logView = new LogPanelView(session.log, {
      setData: (patch) => this.setData(patch),
    });
    /* 同步层：未配置后端时为 null（功能关闭，不是错误）。 */
    this.sync = new DeviceSync({
      api: syncApiOf(getDeviceApi()),
      storage: createWxStorage(),
    });
    this.refreshLocal();
    console.log(
      `[lumen] 设备页就绪（开发版日志 ${detectDevMode() ? "开启" : "关闭"}）`,
    );
  },

  onShow() {
    this.subscribe();
    this.syncStatus();
    /* 先渲染本地（同步函数，不等待），再后台同步。 */
    this.refreshLocal();
    void this.syncFromBackend();
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
      /* 设备增强信息（hwId / 固件）读完：列表要刷新「上次」快照，
       * 并且此时才具备登记条件（后端主键是 hwId）。 */
      session.onDeviceConfig(() => {
        this.refreshLocal();
        if (session.linkState === "ready") {
          void this.syncConnected();
        }
      }),
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
      /* 连上就同步一次：登记 + seen（幂等，失败只置离线提示）。 */
      void this.syncConnected();
      this.refreshLocal();
    } else {
      /* 断线后允许下一次连接再次自动跳转。 */
      autoJumpedOnce = false;
      /* 扫描状态影响「附近设备」的空态文案。 */
      this.applyListViews();
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
    this.setData({ scanHint: "" });
    this.discovered = [];
    this.applyListViews();
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
    this.discovered = devices;
    this.applyListViews();
  },

  /** 点「我的设备」一行 = 连接（已连着别的设备时是切换）。 */
  async onDeviceTap(e: WechatMiniprogram.TouchEvent) {
    const session = this.session;
    if (session === null || this.data.switchBusy) {
      return;
    }
    const deviceId = String(e.currentTarget.dataset.deviceId ?? "");
    const remoteOnly = e.currentTarget.dataset.remoteOnly === "1";
    const name = String(e.currentTarget.dataset.name ?? "");
    if (!deviceId) {
      if (remoteOnly) {
        /* 只有后端记录：本机没见过它的 BLE deviceId，只能先扫描。 */
        wx.showToast({ title: "先扫描一次这台设备", icon: "none" });
        await this.startScan();
      }
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
      this.setData({ currentDeviceId: deviceId, currentDeviceName: name });
      this.refreshLocal();
    } catch (err) {
      this.setData({ scanHint: errorText(err) });
    } finally {
      this.setData({ switchBusy: false });
    }
  },

  // ---------------- 本地列表 ----------------

  refreshLocal() {
    try {
      this.registry = loadRegistry(createWxStorage());
    } catch {
      this.registry = { devices: [] };
    }
    this.applyListViews();
    this.applyRegistryView();
  },

  refreshLocalFrom(registry: DeviceRegistry) {
    this.registry = registry;
    this.applyListViews();
    this.applyRegistryView();
  },

  /** 设备页看到的实时事实：只有**当前已连接**那一台有 State。 */
  liveFacts(): { deviceId: string; stripCount: number; firmwareVer: number | null } | null {
    const session = this.session;
    const deviceId = session?.transport.currentDeviceId ?? "";
    const state = session?.deviceState ?? null;
    if (session === null || deviceId.length === 0 || state === null) {
      return null;
    }
    return {
      deviceId,
      stripCount: state.stripCount,
      firmwareVer: session.deviceInfo?.firmwareVersion ?? null,
    };
  },

  /** 合并本地 + 后端 → 「我的设备」；派生「附近设备」。 */
  applyListViews() {
    const session = this.session;
    const registry = this.registry ?? { devices: [] };
    const mine = buildMyDevices({
      recent: session?.recentDevices ?? [],
      registry: registry.devices,
      backend: this.remoteDevices.length > 0 ? this.remoteDevices : null,
      live: this.liveFacts(),
    });
    const current = session?.transport.currentDeviceId ?? this.data.currentDeviceId;
    const myDevices = mine.map((row) => this.toRowView(row, current));
    const nearby = buildNearby({
      discovered: this.discovered,
      mine,
      currentDeviceId: current,
    })
      /* 与本机记录是同一台（deviceId 精确命中）：上面已有可点的行，不重复列。 */
      .filter((row) => !row.duplicate)
      /* 按信号强度降序：附近列表里最强的通常就是用户要找的那台。 */
      .sort((a, b) => b.rssi - a.rssi)
      .map((row) => ({ ...row, rssiText: `${row.rssi} dBm` }));

    /* 空态要区分「没扫到任何东西」和「扫到的都是我的设备」（后者不该显示
     * 「点扫描开始查找」——用户明明刚扫过）。 */
    const nearbyEmptyText =
      this.discovered.length > 0
        ? "附近扫到的都是已登记设备（见上方）"
        : this.data.scanning
          ? "扫描中…"
          : "点「扫描」开始查找";

    this.setData({ myDevices, nearbyDevices: nearby, nearbyEmptyText });
  },

  toRowView(row: MyDeviceRow, current: string): DeviceRowView {
    const cached = row.stripCountSource !== "device";
    const stripsText =
      row.stripCount === null ? "灯带数未知" : `灯带 ${row.stripCount} 条`;
    const sourceTag =
      row.stripCountSource === "backend-cache"
        ? " · 缓存"
        : row.stripCountSource === "last-session"
          ? " · 上次"
          : "";
    const identity =
      row.hardwareId !== null ? row.hardwareId : row.deviceId !== null ? row.deviceId : "—";
    const when = row.lastSeenAt > 0 ? formatWhen(new Date(row.lastSeenAt)) : "未连接";
    return {
      key: row.key,
      deviceId: row.deviceId ?? "",
      hardwareId: row.hardwareId ?? "",
      label: row.name,
      meta: `${identity} · ${when}`,
      stripsText: `${stripsText}${sourceTag}`,
      current: row.deviceId !== null && row.deviceId === current,
      remoteOnly: row.remoteOnly,
      linked: row.backendId !== null,
      cached,
    };
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
    });
  },

  remarkOf(deviceId: string): string | null {
    const entry = this.registry?.devices.find((item) => item.deviceId === deviceId);
    return entry?.remark ?? null;
  },

  // ---------------- 后端同步（#44） ----------------

  /**
   * 后台同步：换身份 → 拉列表 → 重画。
   *
   * 一进页面就跑，但**不阻塞**任何本地行为：`refreshLocal` 已经在它之前
   * 把本地列表画好了。
   */
  async syncFromBackend() {
    const sync = this.sync;
    if (sync === null || !sync.enabled || this.syncing) {
      this.updateSyncHint();
      return;
    }
    this.syncing = true;
    try {
      /* #47：身份提示由同步层给（含「微信登录失败 / 登录已过期」的原因），
       * 页面不再自己把 kind 翻译成文案。 */
      await sync.ensureIdentity();
      this.updateSyncHint();
      const devices = await sync.refreshRemote();
      if (devices !== null) {
        this.remoteDevices = devices;
        /* 后端可能带着别的手机设置的备注名 / 上次看见时间。 */
        this.applyListViews();
      }
    } finally {
      this.syncing = false;
      this.updateSyncHint();
    }
  },

  /** 连接成功：登记 + seen（fire-and-forget，失败只置提示）。 */
  async syncConnected() {
    const sync = this.sync;
    const session = this.session;
    if (sync === null || !sync.enabled || session === null) {
      this.updateSyncHint();
      return;
    }
    const deviceId = session.transport.currentDeviceId;
    const info = session.deviceInfo;
    const state = session.deviceState;
    if (deviceId === null || info === null) {
      /* 还没读到 hwId：等 onDeviceConfig 之后再来一次。 */
      return;
    }
    const remark = this.remarkOf(deviceId);
    await sync.noteConnected({
      deviceId,
      hardwareId: info.hwId,
      displayName: remark,
      stripCount: state?.stripCount,
      ledCounts:
        state === null ? null : state.stripCounts.slice(0, Math.max(1, state.stripCount)),
      firmwareVer: info.firmwareVersion,
    });
    this.updateSyncHint();
  },

  /**
   * 顶部提示：离线 / 未配置 / 仅本机可见（含 #47 的登录回落原因）。
   *
   * 优先级：同步功能关闭 > 离线 > 身份提示。前两条都是「信息不全」，
   * 只有一次提示、不弹窗、不阻塞。
   */
  updateSyncHint() {
    const sync = this.sync;
    if (sync === null || !sync.enabled) {
      this.setData({ syncHint: "", identityHint: "" });
      return;
    }
    this.setData({
      syncHint: sync.offline ? "离线，仅显示本机记录" : "",
      identityHint: sync.identityHint,
    });
  },

  /** 手动重试同步（点顶部提示）。 */
  async onSyncRetry() {
    const sync = this.sync;
    if (sync === null) {
      return;
    }
    sync.clearOffline();
    /* #47：上次 wx.login 失败 / code 过期时，重试要重新走一遍登录，
     * 否则会一直拿着回落身份不再尝试。 */
    if (!sync.identityBackendBacked) {
      sync.forgetIdentity();
    }
    this.setData({ syncHint: "" });
    await this.syncFromBackend();
    if (this.session?.linkState === "ready") {
      await this.syncConnected();
    }
  },

  // ---------------- 备注名 ----------------

  onRemarkInput(e: WechatMiniprogram.Input) {
    this.setData({ remarkInput: String(e.detail.value ?? "") });
  },

  /**
   * 保存备注名：**先落本地**，再同步。
   *
   * 本地写入绝不会失败到影响用户（storage 异常只打日志），后端失败也不回滚
   * ——用户在这台手机上看到的名字就是他要的名字。
   */
  async onSaveRemark() {
    const deviceId = this.data.currentDeviceId;
    if (!deviceId) {
      wx.showToast({ title: "先连接一台设备", icon: "none" });
      return;
    }
    try {
      const storage = createWxStorage();
      const registry = setRemark(storage, deviceId, this.data.remarkInput);
      this.refreshLocalFrom(registry);
      this.setData({ currentDeviceName: this.data.remarkInput.trim() });
      wx.showToast({ title: "备注名已保存", icon: "none" });

      /* 同步是旁路：不 await、不提示失败（离线提示在顶部）。 */
      const hardwareId = this.hardwareIdOf(deviceId);
      if (hardwareId !== null) {
        void this.sync?.pushRemark({ deviceId, hardwareId }).then(() => this.updateSyncHint());
      }
    } catch (err) {
      wx.showToast({ title: errorText(err), icon: "none" });
    }
  },

  hardwareIdOf(deviceId: string): string | null {
    const registry = this.registry ?? loadRegistry(createWxStorage());
    const entry = registry.devices.find((item) => item.deviceId === deviceId);
    if (entry?.hardwareId !== undefined && entry.hardwareId.length > 0) {
      return entry.hardwareId;
    }
    /* 回退：本次连接的 DeviceInfo（可能还没写进登记表）。 */
    const session = this.session;
    if (session !== null && session.transport.currentDeviceId === deviceId) {
      return session.deviceInfo?.hwId ?? null;
    }
    return null;
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
      this.refreshLocalFrom(registry);
    } catch (err) {
      wx.showToast({ title: errorText(err), icon: "none" });
    }
  },

  // ---------------- 设备状态 ----------------

  applyDeviceState(state: DeviceState) {
    /* 设备页不展示具体灯光，只更新「当前设备 / 条数」派生视图。 */
    void state;
    this.setData({ ready: true });
    this.applyListViews();
    this.applyRegistryView();
  },

  // ---------------- 删除（只解除关联） ----------------

  /**
   * 删除设备：解除后端关联 + 删本机记录。
   *
   * 设备本体不受任何影响（票面验收第 7 条）：它仍会出现在扫描结果里，
   * 点一下就能重新连上并重新登记。
   */
  async onDeleteDevice(e: WechatMiniprogram.TouchEvent) {
    const key = String(e.currentTarget.dataset.key ?? "");
    const row = this.data.myDevices.find((item) => item.key === key);
    if (row === undefined) {
      return;
    }
    const confirmed = await showConfirm(
      "删除这台设备？",
      "只解除本机与后端的登记关系，设备上的灯光配置不受影响；重新扫描仍能连上。",
    );
    if (!confirmed) {
      return;
    }
    /* 后端 id 必须在删本地记录之前取：删完就查不到了。 */
    const backendId =
      this.registry?.devices.find((item) => item.deviceId === row.deviceId)?.backendId ?? null;

    /* 先本地：删除后列表立刻不再显示它（会话的「最近连过」是列表的数据源，
     * 只删登记表不够——列表仍会从 recent 里把它画出来）。 */
    try {
      const hardwareId = row.hardwareId.length > 0 ? row.hardwareId : undefined;
      if (row.deviceId.length > 0) {
        this.refreshLocalFrom(removeDevice(createWxStorage(), row.deviceId));
      }
      this.session?.forgetRecent(row.deviceId, hardwareId);
    } catch (err) {
      wx.showToast({ title: errorText(err), icon: "none" });
      return;
    }
    /* 后端列表也摘掉这一行（只有后端记录时上面没有本地记录可删）。 */
    this.remoteDevices = this.remoteDevices.filter(
      (item) => item.hardwareId !== row.hardwareId,
    );
    this.refreshLocal();

    /* 同步是旁路：失败只意味着下次拉列表它又出现（后端还在）。 */
    void this.sync?.unlink(backendId).then(() => this.updateSyncHint());
    wx.showToast({ title: "已删除", icon: "none" });
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
