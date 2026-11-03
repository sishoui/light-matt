/**
 * 「我的」页（tab 2）：本机身份 + 外观 + 演示设备 + 我的设备 + 版本号。
 *
 * 这些设置项全部从旧发现页搬来（裁决：发现页缩成扫描入口，设置归「我的」），
 * 外加全新的本机身份（头像 / 昵称）。
 *
 * ## 头像与昵称只存本机
 *
 * `wx.getUserProfile` 已下线，拿不到真实资料。头像走
 * `<button open-type="chooseAvatar">`（临时路径 → `saveFile` 落盘），
 * 昵称走 `<input type="nickname">`。两者都只写 `lumen.profile.v1`，
 * **不上传后端**（见 `utils/control/profile.ts`）。
 *
 * ## 演示设备开关为什么要重建会话
 *
 * 会话在构造时就绑定了传输层，并且只读一次 `recentDevices`；换一批设备数据
 * 不可能在原地完成。重建会断开当前连接——可接受（演示模式本身就是空状态
 * 切换）。旧会话的监听随 destroy 失效，所以必须重新订阅。
 *
 * ## 删除设备只解除登记
 *
 * 设备本体不受影响：它仍会出现在扫描结果里，点一下就能重新连上并重新登记。
 */

import { errorText } from "../../utils/ble/errors";
import type { LogPanelRow } from "../../utils/ble/log-panel";
import { createWxStorage } from "../../utils/control/device-cache";
import { buildMyDevices } from "../../utils/control/device-list";
import {
  loadRegistry,
  removeDevice,
  type DeviceRegistry,
} from "../../utils/control/device-registry";
import { getDeviceApi } from "../../utils/control/device-api-singleton";
import { DeviceSync, syncApiOf } from "../../utils/control/device-sync";
import { formatWhen } from "../../utils/control/home-view";
import { LogPanelView } from "../../utils/control/log-panel-view";
import { setMockMode } from "../../utils/control/mock-mode";
import { clearPlanDraftsForDevice } from "../../utils/control/plan-drafts";
import {
  DEFAULT_NICKNAME,
  loadProfile,
  saveAvatarFile,
  saveProfile,
  type Profile,
} from "../../utils/control/profile";
import type { ControlSession } from "../../utils/control/session";
import { getSession, isMockSession, reloadSession } from "../../utils/control/session-singleton";
import {
  loadTheme,
  saveTheme,
  THEME_OPTIONS,
  type ThemeMode,
} from "../../utils/control/theme";
import { pageThemeData, syncTabBarTheme } from "../../utils/control/page-theme";
import type { DeviceState } from "../../utils/protocol/types";

/** 「我的设备」的展示行：名称 + 最近使用时间 + 是否当前连接。 */
interface DeviceRowView {
  /** 列表 key（hardwareId 优先），wx:key 用它——deviceId 在 iOS 上会变。 */
  key: string;
  deviceId: string;
  hardwareId: string;
  label: string;
  whenText: string;
  current: boolean;
}

Page({
  data: {
    themeClass: "",
    /** 实际深色（含「跟随系统」解析）。 */
    dark: false,
    /** 原生 slider / switch 的激活色（不读 CSS 变量）。 */
    accentColor: "",

    /* 本机身份（只写本机存储，不上传）。 */
    avatarFile: "",
    nickname: DEFAULT_NICKNAME,
    nicknameInput: DEFAULT_NICKNAME,
    profileBusy: false,

    /* 外观：浅色 / 深色 / 跟随系统。 */
    themeOptions: THEME_OPTIONS,
    themeMode: "system" as ThemeMode,

    /* 演示设备。 */
    mock: false,

    /* 我的设备。 */
    myDevices: [] as DeviceRowView[],

    /* 页脚 + 隐藏协议日志面板（连点 5 次版本号）。 */
    version: "0.3.0",
    logVisible: false,
    logPaused: false,
    logRows: [] as LogPanelRow[],
    logCount: 0,
    logHint: "",
    logScrollTarget: "",
  },

  session: null as ControlSession | null,
  logView: null as LogPanelView | null,
  registry: null as DeviceRegistry | null,
  sync: null as DeviceSync | null,
  profile: { nickname: DEFAULT_NICKNAME } as Profile,
  unsubscribers: [] as Array<() => void>,

  onLoad() {
    /* 私有字段必须在这里显式兜底：Page() 只保证 data 里的字段出现在
     * this.data，写在对象字面量上的其它字段运行时是 undefined。漏掉会
     * 在 onShow 的调用链上抛错并中断整页事件绑定。 */
    this.unsubscribers = [];
    this.registry = null;
    this.sync = null;
    this.logView = null;
    this.session = null;
    this.profile = { nickname: DEFAULT_NICKNAME };

    const storage = createWxStorage();
    this.profile = loadProfile(storage);
    this.registry = this.loadRegistry();
    this.session = getSession();
    this.sync = new DeviceSync({ api: syncApiOf(getDeviceApi()), storage });
    this.logView = new LogPanelView(this.session.log, {
      setData: (patch) => this.setData(patch),
    });
    const mode = loadTheme(storage);
    this.setData({
      ...pageThemeData(storage),
      themeMode: mode,
      mock: isMockSession(),
      avatarFile: this.profile.avatarFile ?? "",
      nickname: this.profile.nickname,
      nicknameInput: this.profile.nickname,
    });
    this.refreshDevices();
  },

  onShow() {
    /* 会话可能在别处被重建（`reloadSession`）；单例换实例后本页的监听与
     * 日志源都失效，必须重新取一次并重新订阅。 */
    const current = getSession();
    if (current !== this.session) {
      this.unsubscribe();
      this.session = current;
      this.logView?.destroy();
      this.logView = new LogPanelView(current.log, {
        setData: (patch) => this.setData(patch),
      });
    }
    this.subscribe();
    this.registry = this.loadRegistry();
    this.profile = loadProfile(createWxStorage());
    const mode = loadTheme(createWxStorage());
    /* 输入框只在「没有未落盘的改动」时回填：用户正在打字时切走再回来
     * 不该把他刚敲的字冲掉。 */
    const pending = this.data.nicknameInput !== this.data.nickname;
    this.setData({
      ...pageThemeData(createWxStorage()),
      themeMode: mode,
      mock: isMockSession(),
      avatarFile: this.profile.avatarFile ?? "",
      nickname: this.profile.nickname,
      nicknameInput: pending ? this.data.nicknameInput : this.profile.nickname,
    });
    this.refreshDevices();
    this.syncTabBar();
  },

  onHide() {
    this.unsubscribe();
  },

  onUnload() {
    this.unsubscribe();
    this.logView?.destroy();
    this.logView = null;
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
      /* 连接 / 断开都会改「最近连过」，列表与选中态要跟着重画。 */
      session.onLink(() => this.refreshDevices()),
      session.onState(() => this.refreshDevices()),
      session.onDeviceConfig(() => this.refreshDevices()),
      session.log.onAppend(() => this.logView?.onAppend()),
    ];
  },

  unsubscribe() {
    for (const off of this.unsubscribers ?? []) {
      off();
    }
    this.unsubscribers = [];
  },

  /** 自定义 tabBar 的选中态（索引与 app.json 的 tabBar.list 一致）。 */
  syncTabBar() {
    const tabBar = this.getTabBar?.();
    if (tabBar !== undefined && tabBar !== null) {
      tabBar.setData({ selected: 1 });
    }
  },

  // ---------------- 本机身份：头像 + 昵称 ----------------

  /** 头像选择回调（`<button open-type="chooseAvatar">`）：只落本机。 */
  async onChooseAvatar(e: WechatMiniprogram.CustomEvent<{ avatarUrl?: string }>) {
    const temp = String(e.detail?.avatarUrl ?? "");
    if (temp.length === 0 || this.data.profileBusy) {
      return;
    }
    this.setData({ profileBusy: true });
    try {
      const previous = this.profile.avatarFile ?? "";
      const saved = await saveAvatarFile(temp, previous);
      if (saved === null) {
        wx.showToast({ title: "头像保存失败", icon: "none" });
        return;
      }
      this.profile = saveProfile(createWxStorage(), { avatarFile: saved });
      this.setData({ avatarFile: this.profile.avatarFile ?? "" });
    } catch (err) {
      wx.showToast({ title: errorText(err), icon: "none" });
    } finally {
      this.setData({ profileBusy: false });
    }
  },

  onNicknameInput(e: WechatMiniprogram.Input) {
    this.setData({ nicknameInput: String(e.detail.value ?? "") });
  },

  /** 失焦 / 键盘完成都落盘：用户改完就该持久化，不用再点保存。 */
  onNicknameBlur() {
    this.commitNickname();
  },

  onNicknameConfirm() {
    this.commitNickname();
  },

  /** 空输入回落默认昵称（`saveProfile` 负责），并回填输入框。 */
  commitNickname() {
    try {
      this.profile = saveProfile(createWxStorage(), { nickname: this.data.nicknameInput });
      this.setData({
        nickname: this.profile.nickname,
        nicknameInput: this.profile.nickname,
      });
    } catch (err) {
      wx.showToast({ title: errorText(err), icon: "none" });
    }
  },

  // ---------------- 外观 ----------------

  onThemeTap(e: WechatMiniprogram.TouchEvent) {
    const value = String(e.currentTarget.dataset.value ?? "");
    if (value !== "light" && value !== "dark" && value !== "system") {
      return;
    }
    saveTheme(createWxStorage(), value);
    this.applyThemeView();
  },

  /** 主题：页面根节点的 class + 选择器选中态 + 通知 tabBar 重算。 */
  applyThemeView() {
    const storage = createWxStorage();
    const mode = loadTheme(storage);
    this.setData({
      ...pageThemeData(storage),
      themeMode: mode,
      mock: isMockSession(),
    });
    /* tabBar 在页面外层，是全局单例，attached 只跑一次：切完主题必须主动
     * 让它重算（`refreshTheme` 会自己解析「跟随系统」）。 */
    syncTabBarTheme(this.getTabBar?.(), mode);
  },

  // ---------------- 演示设备 ----------------

  /**
   * 演示模式开关：把演示设备播种 / 清除，然后**重建会话**。
   *
   * 只写开关，让 `reconcileMockMode` 在重建会话时统一播种 / 清理。
   */
  async onToggleMock(e: WechatMiniprogram.SwitchChange) {
    const enabled = Boolean(e.detail.value);
    const storage = createWxStorage();
    setMockMode(storage, enabled);
    this.unsubscribe();
    reloadSession();
    /* 旧会话的日志源随 destroy 失效，面板控制器必须换一个新的。 */
    this.logView?.destroy();
    this.session = getSession();
    this.logView = new LogPanelView(this.session.log, {
      setData: (patch) => this.setData(patch),
    });
    this.subscribe();
    this.registry = this.loadRegistry();
    this.setData({ mock: isMockSession() });
    this.refreshDevices();
    wx.showToast({
      title: enabled ? "已打开演示设备" : "已关闭演示设备",
      icon: "none",
    });
  },

  // ---------------- 我的设备 ----------------

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

  /** 本机记录（登记表 ∪ 最近连过）→ 列表行，按最近使用时间降序。 */
  refreshDevices() {
    const session = this.session;
    const registry = this.registry ?? { devices: [] };
    const current = session?.transport.currentDeviceId ?? "";
    const rows = buildMyDevices({
      recent: session?.recentDevices ?? [],
      registry: registry.devices,
      backend: null,
      live: this.liveFacts(),
    }).map<DeviceRowView>((row) => ({
      key: row.key,
      deviceId: row.deviceId ?? "",
      hardwareId: row.hardwareId ?? "",
      label: row.name,
      whenText: row.lastSeenAt > 0 ? formatWhen(new Date(row.lastSeenAt)) : "未连接",
      current: row.deviceId !== null && row.deviceId === current,
    }));
    this.setData({ myDevices: rows });
  },

  /**
   * 删除设备：解除后端关联 + 删本机记录。
   *
   * 设备本体不受任何影响：它仍会出现在扫描结果里，点一下就能重新连上并
   * 重新登记。
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

    /* 先本地：删除后列表立刻不再显示它（列表的数据源包含「最近连过」，
     * 只删登记表不够）。 */
    try {
      const hardwareId = row.hardwareId.length > 0 ? row.hardwareId : undefined;
      if (row.deviceId.length > 0) {
        this.registry = removeDevice(createWxStorage(), row.deviceId);
      }
      this.session?.forgetRecent(row.deviceId, hardwareId);
      /* 方案草稿是本机数据，**只在这里清**：断线 / 切页都不清（那是「内容只
       * 存在本机」这句承诺的另一半）。键可能是 hardwareId 或 deviceId，两个都清。 */
      const storage = createWxStorage();
      if (hardwareId !== undefined) {
        clearPlanDraftsForDevice(storage, hardwareId);
      }
      if (row.deviceId.length > 0) {
        clearPlanDraftsForDevice(storage, row.deviceId);
      }
    } catch (err) {
      wx.showToast({ title: errorText(err), icon: "none" });
      return;
    }
    this.refreshDevices();

    /* 同步是旁路：失败只意味着下次拉列表它又出现（后端还在）。 */
    void this.sync?.unlink(backendId);
    wx.showToast({ title: "已删除", icon: "none" });
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
