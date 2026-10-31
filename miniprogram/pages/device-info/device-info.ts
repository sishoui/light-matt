/**
 * 设备详情页（二级页）：GPIO / 灯珠数 / 自检 / 固件版本 / 断开。
 *
 * 数据全部来自设备（§9.1）：
 *  - `State`：逐带灯珠数、开关位；
 *  - `QueryStripConfig` 0x87：GPIO（只读，来自构建期 Kconfig）；
 *  - `QueryDeviceInfo` 0x88：固件版本、hw_id、能力上限。
 *
 * 灯珠数与 GPIO 都是**逐带**的：本页显示全部 8 路（含未分配的），
 * 不要拿 strip 0 的值去填别的带——那正是 v2 的缺陷。
 *
 * #44 的落点：hardwareId 写入 device-registry、后端登记与「仅本机可见」提示。
 * 当前只把 hw_id 显示出来并补进本地登记表。
 */

import { errorText, resultText } from "../../utils/ble/errors";
import { createWxStorage } from "../../utils/control/device-cache";
import { loadRegistry, removeDevice, setHardwareId } from "../../utils/control/device-registry";
import { parseLedCountInput, ledCountResultHint } from "../../utils/control/ledCount";
import { ControlSession } from "../../utils/control/session";
import { getSession } from "../../utils/control/session-singleton";
import { MAX_STRIPS } from "../../utils/protocol/constants";
import type { DeviceInfo, StripConfig } from "../../utils/protocol/types";

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
  },

  session: null as ControlSession | null,

  onLoad() {
    this.session = getSession();
    void this.reload();
  },

  onShow() {
    void this.reload();
  },

  onUnload() {
    /* 会话属于 App：本页只丢自己的引用。 */
    this.session = null;
  },

  /** 读 State + 引脚表 + 设备身份（都是设备权威，失败只是缺一栏）。 */
  async reload() {
    const session = this.session;
    if (session === null) {
      return;
    }
    const ready = session.linkState === "ready";
    this.setData({
      ready,
      deviceId: session.transport.currentDeviceId ?? "",
      deviceName: session.cachedDevice?.name ?? "",
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

    const state = session.deviceState;
    const stripCount = Math.max(1, Math.min(MAX_STRIPS, state?.stripCount ?? 1));
    const registry = loadRegistry(createWxStorage());
    const deviceId = this.data.deviceId;

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
        label: `灯带 ${stripId + 1}`,
        ledCount: state?.stripCounts[stripId] ?? 0,
        gpioText,
        visible: this.visibleInApp(registry, deviceId, stripId),
      });
      ledStripOptions.push({ stripId, label: `灯带 ${stripId + 1}` });
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
          : `灯珠 ${info.maxLeds} · 灯带 ${info.maxStrips} · 段 ${info.maxSegments} · 阶段 ${info.maxStages} · 剧本 ${info.maxScripts}`,
    });

    /* #44 的接缝：拿到 hwId 就补进本地登记表（不覆盖备注与掩码）。 */
    if (info !== null && info.hwId.length > 0 && deviceId.length > 0) {
      try {
        setHardwareId(createWxStorage(), deviceId, info.hwId);
      } catch (err) {
        console.warn(`[lumen] 记录 hwId 失败：${errorText(err)}`);
      }
    }
  },

  /** 该带是否在本机界面可见（App 本地偏好，永不下发）。 */
  visibleInApp(
    registry: ReturnType<typeof loadRegistry>,
    deviceId: string,
    stripId: number,
  ): boolean {
    if (deviceId.length === 0) {
      return true;
    }
    const entry = registry.devices.find((item) => item.deviceId === deviceId);
    if (entry === undefined) {
      return true;
    }
    return (entry.stripMask & (1 << stripId)) !== 0;
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
          ledCountHint: `灯带 ${stripId + 1} 已设为 ${result.state.stripCounts[stripId] ?? parsed.value} 颗`,
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

  // ---------------- 断开 / 忘记 ----------------

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

  async onForget() {
    const deviceId = this.data.deviceId;
    if (!deviceId) {
      return;
    }
    const confirmed = await showConfirm("忘记这台设备？", "只删除本机记录（备注 / 灯带显示偏好），设备配置不受影响。");
    if (!confirmed) {
      return;
    }
    try {
      removeDevice(createWxStorage(), deviceId);
      wx.showToast({ title: "已忘记", icon: "none" });
    } catch (err) {
      wx.showToast({ title: errorText(err), icon: "none" });
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
