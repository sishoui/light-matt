/**
 * 设备详情页（二级页）：GPIO / 灯珠数 / 自检 / 固件版本 / 改名 / 删除。
 *
 * 数据全部来自设备（§9.1），**没有一项来自后端**：
 *  - `State`（37B）：逐带灯珠数、开关位、条数；
 *  - `QueryStripConfig` 0x87：GPIO（只读，来自构建期 Kconfig）；
 *  - `QueryDeviceInfo` 0x88：固件版本、hw_id、能力上限。
 *
 * 灯珠数与 GPIO 都是**逐带**的：本页显示全部条数（含未分配的），
 * 不要拿 strip 0 的值去填别的带——那正是 v2 的缺陷。
 *
 * #44 的落点：hw_id 用于后端登记（会话在 ready 后已写入登记表），改名与删除
 * 在本地先落盘再异步同步。删除只解除登记关系：设备还在，重新扫描仍能连上。
 */

import { errorText, resultText } from "../../utils/ble/errors";
import { createWxStorage } from "../../utils/control/device-cache";
import {
  loadRegistry,
  removeDevice,
  setRemark,
  type DeviceRegistry,
} from "../../utils/control/device-registry";
import { getDeviceApi } from "../../utils/control/device-api-singleton";
import { DeviceSync, syncApiOf } from "../../utils/control/device-sync";
import { parseLedCountInput, ledCountResultHint } from "../../utils/control/ledCount";
import { ControlSession } from "../../utils/control/session";
import { getSession } from "../../utils/control/session-singleton";
import { loadTheme, themeClass } from "../../utils/control/theme";
import { MAX_STRIPS } from "../../utils/protocol/constants";
import type { DeviceInfo, DeviceState, StripConfig } from "../../utils/protocol/types";

interface StripInfoRow {
  stripId: number;
  label: string;
  ledCount: number;
  gpioText: string;
  /** 该带是否在 App 界面里可见（本地偏好，不是设备事实）。 */
  visible: boolean;
}

Page({
  data: {
    themeClass: "",
    ready: false,
    deviceName: "",
    deviceId: "",
    hwId: "—",
    firmwareText: "—",
    capsText: "—",
    limitsText: "—",
    stripRows: [] as StripInfoRow[],
    selfTestBusy: false,
    disconnectBusy: false,
    hint: "",

    // 灯珠数量（#12）：设备级低频设置，按选中带修改
    ledCountStripId: 0,
    ledCountInput: "",
    ledCountHint: "",
    ledCountBusy: false,
    ledStripOptions: [] as Array<{ stripId: number; label: string }>,

    // 改名 / 删除（#44）
    remarkInput: "",
    remarkBusy: false,
    deleteBusy: false,
    identityHint: "",
  },

  session: null as ControlSession | null,
  sync: null as DeviceSync | null,
  registry: null as DeviceRegistry | null,

  onLoad() {
    /* 页面私有状态显式兜底：Page() 不保证对象字面量字段被复制到实例上。 */
    this.registry = null;

    this.session = getSession();
    this.sync = new DeviceSync({ api: syncApiOf(getDeviceApi()), storage: createWxStorage() });
    this.reloadRegistry();
    this.setData({ themeClass: themeClass(loadTheme(createWxStorage())) });
    void this.reload();
  },

  onShow() {
    this.reloadRegistry();
    this.setData({ themeClass: themeClass(loadTheme(createWxStorage())) });
    void this.reload();
  },

  onUnload() {
    /* 会话属于 App：本页只丢自己的引用。 */
    this.session = null;
  },

  reloadRegistry() {
    try {
      this.registry = loadRegistry(createWxStorage());
    } catch {
      this.registry = { devices: [] };
    }
  },

  /** 读 State + 引脚表 + 设备身份（都是设备权威，失败只是缺一栏）。 */
  async reload() {
    const session = this.session;
    if (session === null) {
      return;
    }
    const ready = session.linkState === "ready";
    const deviceId = session.transport.currentDeviceId ?? "";
    this.setData({
      ready,
      deviceId,
      deviceName: session.cachedDevice?.name ?? "",
      remarkInput: this.remarkOf(deviceId) ?? "",
    });
    if (!ready) {
      this.setData({ hint: "设备未连接" });
      return;
    }

    /* 引脚表 / 设备身份：会话在 ready 时已补过；这里只在缺失时补读一次
     * （旧固件不支持时读失败，对应栏显示「—」，不影响其他信息）。 */
    let config: StripConfig | null = session.stripConfigs;
    if (config === null) {
      const res = await session.queryStripConfig();
      config = res.kind === "ok" ? res.config : null;
    }
    let info: DeviceInfo | null = session.deviceInfo;
    if (info === null) {
      const res = await session.queryDeviceInfo();
      info = res.kind === "ok" ? res.info : null;
    }

    const state: DeviceState | null = session.deviceState;
    const stripCount = Math.max(1, Math.min(MAX_STRIPS, state?.stripCount ?? 1));
    const registry = this.registry ?? { devices: [] };

    const stripRows: StripInfoRow[] = [];
    const ledStripOptions: Array<{ stripId: number; label: string }> = [];
    for (let stripId = 0; stripId < Math.min(stripCount, MAX_STRIPS); stripId += 1) {
      const channel = config?.channels[stripId];
      const gpioText =
        channel === undefined || !channel.assigned
          ? "未分配"
          : channel.gpio === 0xff
            ? "未分配"
            : `GPIO ${channel.gpio}`;
      stripRows.push({
        stripId,
        label: `灯组 ${stripId + 1}`,
        /* 逐带真实值：设备 State，不复制 strip 0。 */
        ledCount: state?.stripCounts[stripId] ?? 0,
        gpioText,
        visible: this.visibleInApp(registry, deviceId, stripId),
      });
      ledStripOptions.push({ stripId, label: `灯组 ${stripId + 1}` });
    }

    const selected = this.data.ledCountStripId < stripRows.length ? this.data.ledCountStripId : 0;
    const currentCount = state?.stripCounts[selected] ?? 0;

    this.setData({
      stripRows,
      ledStripOptions,
      ledCountStripId: selected,
      ledCountInput: currentCount > 0 ? String(currentCount) : "",
      hwId: info?.hwId ?? "—",
      firmwareText:
        info === null
          ? "—"
          : `v${info.firmwareMajor}.${info.firmwareMinor}（0x${info.firmwareVersion.toString(16).padStart(4, "0")}）`,
      capsText:
        info === null
          ? "—"
          : `${info.supportsTwoLayers ? "支持两层叠加" : "不支持两层"} · ${
              info.fadeImplemented ? "支持渐变" : "硬切"
            }`,
      limitsText:
        info === null
          ? "—"
          : `灯珠 ${info.maxLeds} · 灯组 ${info.maxStrips} · 光区 ${info.maxSegments} · 步骤 ${info.maxStages} · 方案 ${info.maxScripts}`,
    });

    /* hwId 由会话在 ready 后写入登记表；重读一次让备注字段反映最新记录。 */
    if (info !== null && info.hwId.length > 0 && deviceId.length > 0) {
      this.reloadRegistry();
      this.setData({ remarkInput: this.remarkOf(deviceId) ?? "" });
    }
    /* 身份提示：未配置 / 不可达时 sync 自己返回 null，这里不阻塞。 */
    void this.sync?.ensureIdentity().then(() => this.updateIdentityHint());
  },

  /** 该带是否在本机界面可见（App 本地偏好，永不下发）。 */
  visibleInApp(registry: DeviceRegistry, deviceId: string, stripId: number): boolean {
    if (deviceId.length === 0) {
      return true;
    }
    const entry = registry.devices.find((item) => item.deviceId === deviceId);
    if (entry === undefined) {
      return true;
    }
    return (entry.stripMask & (1 << stripId)) !== 0;
  },

  remarkOf(deviceId: string): string | null {
    const entry = this.registry?.devices.find((item) => item.deviceId === deviceId);
    return entry?.remark ?? null;
  },

  // ---------------- 自检 ----------------

  async onSelfTest() {
    const session = this.session;
    if (session === null || !this.data.ready || this.data.selfTestBusy) {
      return;
    }
    this.setData({ selfTestBusy: true });
    try {
      const result = await session.selfTest();
      if (result.kind === "ok") {
        wx.showToast({ title: "自检：红 → 绿 → 蓝 → 白", icon: "none" });
        return;
      }
      if (result.kind === "ack-error") {
        wx.showToast({ title: `自检失败：${resultText(result.ack.resultCode)}`, icon: "none" });
        return;
      }
      if (result.kind === "error") {
        wx.showToast({ title: result.message, icon: "none" });
      }
    } finally {
      this.setData({ selfTestBusy: false });
    }
  },

  // ---------------- 灯珠数量（按带） ----------------

  onLedStripTap(e: WechatMiniprogram.TouchEvent) {
    const stripId = Number(e.currentTarget.dataset.stripId ?? -1);
    if (stripId < 0) {
      return;
    }
    const row = this.data.stripRows.find((item) => item.stripId === stripId);
    this.setData({
      ledCountStripId: stripId,
      ledCountInput: row !== undefined && row.ledCount > 0 ? String(row.ledCount) : "",
      ledCountHint: "",
    });
  },

  onLedCountInput(e: WechatMiniprogram.Input) {
    this.setData({ ledCountInput: String(e.detail.value ?? ""), ledCountHint: "" });
  },

  async onApplyLedCount() {
    const session = this.session;
    if (session === null || !this.data.ready || this.data.ledCountBusy) {
      return;
    }
    const stripId = this.data.ledCountStripId;
    const current = this.data.stripRows.find((item) => item.stripId === stripId)?.ledCount ?? 0;
    const parsed = parseLedCountInput(this.data.ledCountInput);
    if (!parsed.ok) {
      this.setData({
        ledCountHint: parsed.message,
        ledCountInput: current > 0 ? String(current) : "",
      });
      wx.showToast({ title: parsed.message, icon: "none" });
      return;
    }
    if (parsed.value === current) {
      this.setData({
        ledCountHint: `当前已是 ${parsed.value} 颗`,
        ledCountInput: String(parsed.value),
      });
      return;
    }

    this.setData({ ledCountBusy: true, ledCountHint: "正在应用…" });
    try {
      /* stripId 显式传：改的是用户选中的那条带，不是 strip 0。 */
      const result = await session.setLedCount(parsed.value, stripId);
      if (result.kind === "ok") {
        this.setData({
          ledCountHint: `灯组 ${stripId + 1} 已设为 ${result.state.stripCounts[stripId] ?? parsed.value} 颗`,
        });
        await this.reload();
        return;
      }
      if (result.kind === "ack-error") {
        const hint = ledCountResultHint(result.ack.resultCode) || "设置失败";
        this.setData({
          ledCountHint: hint,
          ledCountInput: current > 0 ? String(current) : "",
        });
        wx.showToast({ title: hint, icon: "none" });
        return;
      }
      if (result.kind === "stale") {
        this.setData({ ledCountHint: "" });
        return;
      }
      this.setData({
        ledCountHint: result.message,
        ledCountInput: current > 0 ? String(current) : "",
      });
      wx.showToast({ title: result.message, icon: "none" });
    } finally {
      this.setData({ ledCountBusy: false });
    }
  },

  // ---------------- 改名（本地先写，后端后同步） ----------------

  onRemarkInput(e: WechatMiniprogram.Input) {
    this.setData({ remarkInput: String(e.detail.value ?? "") });
  },

  async onRename() {
    const deviceId = this.data.deviceId;
    if (!deviceId || this.data.remarkBusy) {
      return;
    }
    this.setData({ remarkBusy: true });
    try {
      const storage = createWxStorage();
      this.registry = setRemark(storage, deviceId, this.data.remarkInput);
      this.setData({
        hint: "备注名已保存（仅本机；稍后同步到后端）",
      });
      wx.showToast({ title: "已保存", icon: "none" });

      /* 同步旁路：失败只影响别的手机看不看得见，本地已生效。 */
      const hardwareId = this.hardwareIdOf(deviceId);
      if (hardwareId !== null) {
        void this.sync
          ?.pushRemark({ deviceId, hardwareId })
          .then(() => this.updateIdentityHint());
      }
    } catch (err) {
      wx.showToast({ title: errorText(err), icon: "none" });
    } finally {
      this.setData({ remarkBusy: false });
    }
  },

  hardwareIdOf(deviceId: string): string | null {
    const entry = this.registry?.devices.find((item) => item.deviceId === deviceId);
    if (entry?.hardwareId !== undefined && entry.hardwareId.length > 0) {
      return entry.hardwareId;
    }
    return this.session?.deviceInfo?.hwId ?? null;
  },

  updateIdentityHint() {
    const sync = this.sync;
    if (sync === null || !sync.enabled) {
      this.setData({ identityHint: "" });
      return;
    }
    /* #47：文案由同步层给（含「微信登录失败 / 登录已过期」的可读原因）。 */
    this.setData({ identityHint: sync.identityHint });
  },

  // ---------------- 断开 / 删除 ----------------

  async onDisconnect() {
    const session = this.session;
    if (session === null || this.data.disconnectBusy) {
      return;
    }
    this.setData({ disconnectBusy: true });
    try {
      await session.disconnect();
      wx.showToast({ title: "已断开", icon: "none" });
      setTimeout(() => {
        wx.navigateBack({ fail: () => undefined });
      }, 300);
    } finally {
      this.setData({ disconnectBusy: false });
    }
  },

  /**
   * 删除这台设备：解除后端关联 + 删本机记录。
   *
   * 设备本体不受影响（票面验收第 7 条）：它仍会出现在扫描结果里，
   * 点一下就能重新连上并重新登记。
   */
  async onDelete() {
    const deviceId = this.data.deviceId;
    if (!deviceId || this.data.deleteBusy) {
      return;
    }
    const confirmed = await showConfirm(
      "删除这台设备？",
      "只解除本机与后端的登记关系，设备上的灯光配置不受影响；重新扫描仍能连上。",
    );
    if (!confirmed) {
      return;
    }
    this.setData({ deleteBusy: true });
    try {
      const hardwareId = this.hardwareIdOf(deviceId) ?? undefined;
      const backendId =
        this.registry?.devices.find((item) => item.deviceId === deviceId)?.backendId ?? null;
      removeDevice(createWxStorage(), deviceId);
      this.session?.forgetRecent(deviceId, hardwareId);
      this.reloadRegistry();
      this.setData({ remarkInput: "", hint: "已删除本机记录" });
      /* 后端只解除关联：设备行保留，重新扫描仍可登记。 */
      void this.sync?.unlink(backendId);
      wx.showToast({ title: "已删除", icon: "none" });
    } catch (err) {
      wx.showToast({ title: errorText(err), icon: "none" });
    } finally {
      this.setData({ deleteBusy: false });
    }
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
