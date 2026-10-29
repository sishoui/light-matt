/**
 * 单页控制界面（#8 开关 + #9 亮度）。
 *
 * 页面只做 view model 与事件转发，所有 BLE 细节经 ControlSession。
 * 亮度滑块：bindchanging 连续量进 20Hz latest-wins 节流，bindchange 松手
 * 用同一个节流实例 flush 一次最终值。色环 / 预设仍是 #10 的禁用占位。
 */

import { errorText, resultText } from "../../utils/ble/errors";
import {
  brightnessPercent as percentOf,
  clampBrightness,
} from "../../utils/control/brightness";
import {
  ControlSession,
  detectDevMode,
  detectPlatform,
  type PowerResult,
} from "../../utils/control/session";
import type { DeviceState, DiscoveredDevice, LinkState } from "../../utils/protocol/types";

/** 模块级单例：页面重入时复用同一条 BLE 会话。 */
let session: ControlSession | null = null;
let unsubscribers: Array<() => void> = [];

const PRESETS = [
  { name: "暖白", hex: "#FFB478" },
  { name: "冷白", hex: "#E8F0FF" },
  { name: "红", hex: "#FF4D4D" },
  { name: "橙", hex: "#FF9A3D" },
  { name: "绿", hex: "#4DD17A" },
  { name: "青", hex: "#3DD1D1" },
  { name: "蓝", hex: "#4D7DFF" },
  { name: "紫", hex: "#A06DFF" },
];

interface StatusView {
  statusText: string;
  statusSub: string;
  statusAction: string;
  linkClass: string;
}

function statusView(state: LinkState, deviceName: string, message?: string): StatusView {
  switch (state) {
    case "ready":
      return {
        statusText: `已连接 · ${deviceName || "设备"}`,
        statusSub: "点击查看设备",
        statusAction: "设备",
        linkClass: "link-ready",
      };
    case "scanning":
      return { statusText: "扫描中…", statusSub: message ?? "正在查找 Lumen 设备", statusAction: "停止", linkClass: "link-busy" };
    case "connecting":
      return { statusText: "连接中…", statusSub: deviceName, statusAction: "取消", linkClass: "link-busy" };
    case "initializing":
      return { statusText: "同步状态…", statusSub: deviceName, statusAction: "取消", linkClass: "link-busy" };
    case "adapter-off":
      return { statusText: "请打开蓝牙", statusSub: message ?? "打开系统蓝牙后会自动继续", statusAction: "重试", linkClass: "link-warn" };
    case "failed":
      return { statusText: "未连接", statusSub: message ?? "连接失败", statusAction: "重试", linkClass: "link-error" };
    case "idle":
      return { statusText: "未连接", statusSub: message ?? "点击选择设备", statusAction: "扫描", linkClass: "link-idle" };
    default:
      return { statusText: "未连接", statusSub: "点击选择设备", statusAction: "扫描", linkClass: "link-idle" };
  }
}

Page({
  data: {
    // 连接状态条
    statusText: "未连接",
    statusSub: "点击选择设备",
    statusAction: "扫描",
    linkClass: "link-idle",
    ready: false,

    // 开关
    power: 0 as 0 | 1,
    powerBusy: false,
    powerLabel: "已关",

    // 亮度：滑块上限取设备 State.maxBrightness（不硬编码 255）
    brightness: 0, // 绑定到 slider value，只在松手 / 设备状态更新时改
    brightnessDisplay: 0, // 拖动过程中的实时读数（不写回 slider.value）
    brightnessPercent: 0,
    maxBrightness: 255,
    brightnessHintText: "连接后可调节",
    // 为 #10 预留
    colorHex: "#FFB478",
    presets: PRESETS,

    // 扫描 / 设备弹层
    sheetVisible: false,
    sheetMode: "scan" as "scan" | "device",
    devices: [] as DiscoveredDevice[],
    scanHint: "" as string,
    deviceName: "",
    deviceId: "",

    version: "0.1.0",
  },

  onLoad() {
    const platform = detectPlatform();
    const devMode = detectDevMode();
    session = new ControlSession({ platform, devMode });
    console.log(`[lumen] 平台 ${platform}，开发版日志 ${devMode ? "开启" : "关闭"}`);

    unsubscribers = [
      session.onLink((state, detail) => this.applyLink(state, detail?.message)),
      session.onDevices((devices) => {
        this.setData({ devices });
      }),
      session.onState((state) => this.applyDeviceState(state)),
      session.onScanHint((hint) => {
        this.setData({ scanHint: hint ?? "" });
      }),
      session.onDeviceEvent((code, detail) => {
        if (code === 0x01) {
          wx.showToast({ title: `保存失败（命令 0x${detail.toString(16)}）`, icon: "none" });
        }
      }),
    ];

    void session.boot();
  },

  onUnload() {
    for (const off of unsubscribers) {
      off();
    }
    unsubscribers = [];
    // 页面生命周期结束，彻底断开并反注册 wx.on*（避免回调串入）。
    session?.destroy();
    session = null;
  },

  onShow() {
    // 本票不做静默回连（#11）；回到前台只复核一次链路状态文案。
    if (session !== null) {
      this.applyLink(session.linkState);
    }
  },

  // ---------------- 状态条与弹层 ----------------

  onStatusTap() {
    if (session === null) {
      return;
    }
    const state = session.linkState;
    if (state === "ready") {
      this.setData({
        sheetVisible: true,
        sheetMode: "device",
        deviceId: session.transport.currentDeviceId ?? "",
      });
      return;
    }
    if (state === "connecting" || state === "initializing") {
      return; // 连接中不重复触发扫描
    }
    this.openScanSheet();
  },

  openScanSheet() {
    this.setData({ sheetVisible: true, sheetMode: "scan", scanHint: "" });
    void this.startScan();
  },

  closeSheet() {
    this.setData({ sheetVisible: false, devices: [] });
    if (session !== null && session.linkState === "scanning") {
      void session.stopScan();
    }
  },

  onSheetMaskTap() {
    this.closeSheet();
  },

  /** catchtap 占位，阻止弹层内部点击穿透到遮罩。 */
  noop() {
    /* 空实现 */
  },

  async startScan() {
    if (session === null) {
      return;
    }
    try {
      await session.scan();
    } catch (err) {
      this.setData({ scanHint: errorText(err) });
    }
  },

  onRescan() {
    void this.startScan();
  },

  async onDeviceTap(e: WechatMiniprogram.TouchEvent) {
    if (session === null) {
      return;
    }
    const deviceId = String(e.currentTarget.dataset.deviceId ?? "");
    const name = String(e.currentTarget.dataset.name ?? "");
    if (!deviceId) {
      return;
    }
    try {
      const state = await session.connect(deviceId, name);
      this.applyDeviceState(state);
      this.setData({ sheetVisible: false, deviceName: name, deviceId });
      // connect() 内发出 ready 时页面还没拿到设备名，这里补一次状态条。
      this.applyLink("ready");
    } catch (err) {
      this.setData({ scanHint: errorText(err) });
    }
  },

  async onDisconnect() {
    if (session === null) {
      return;
    }
    await session.disconnect();
    this.setData({
      sheetVisible: false,
      deviceName: "",
      deviceId: "",
      power: 0,
      powerLabel: "已关",
      brightness: 0,
      brightnessDisplay: 0,
      brightnessPercent: 0,
      brightnessHintText: "连接后可调节",
    });
  },

  // ---------------- 开关 ----------------

  async onTogglePower() {
    if (session === null || !this.data.ready || this.data.powerBusy) {
      return;
    }
    const next = this.data.power === 1 ? 0 : 1;
    this.setData({ powerBusy: true });
    try {
      const result: PowerResult = await session.setPower(next === 1);
      this.applyPowerResult(result);
    } finally {
      this.setData({ powerBusy: false });
    }
  },

  // ---------------- 亮度（#9） ----------------

  /**
   * 拖动中（连续量）：只更新本地显示，交给 session 的 20Hz latest-wins。
   * 这是「跟手」的关键——不在这里等任何回包。
   */
  onBrightnessChanging(e: WechatMiniprogram.SliderChanging) {
    const value = Number(e.detail.value);
    if (!Number.isFinite(value)) {
      return;
    }
    // 拖动中只刷新读数，不回写 slider.value：原生滑块自己的拇指已经跟手，
    // 这时改 value 反而可能造成回跳。控制值走 session 的 20Hz 节流。
    this.setBrightnessView(value, false);
    session?.queueBrightness(value);
  },

  /**
   * 松手（一次最终确认）：同一值再推一次并 flush。
   * 不重传旧值——节流层只保留最新值，flush 只是把最小间隔提前。
   */
  onBrightnessChange(e: WechatMiniprogram.SliderChange) {
    const value = Number(e.detail.value);
    if (!Number.isFinite(value)) {
      return;
    }
    this.setBrightnessView(value, true);
    session?.commitBrightness(value);
  },

  /**
   * 亮度只影响 brightness：power 位不动（亮度 0 视觉等于关灯，但设备仍是「开」）。
   * bindValue 为 false 时不回写 slider.value（拖动中由原生控件跟手）。
   */
  setBrightnessView(rawValue: number, bindValue: boolean) {
    const max = this.data.maxBrightness;
    const value = clampBrightness(rawValue, max);
    const patch: Record<string, unknown> = {
      brightnessDisplay: value,
      brightnessPercent: percentOf(value, max),
      brightnessHintText: this.brightnessHintText(value, this.data.ready),
    };
    if (bindValue) {
      patch.brightness = value;
    }
    this.setData(patch);
  },

  brightnessHintText(value: number, ready: boolean): string {
    if (!ready) {
      return "连接后可调节";
    }
    if (value === 0) {
      return "亮度 0 视觉上等于关灯；开关状态保持为开";
    }
    return "拖动实时跟随，松手确认";
  },

  // ---------------- 内部 ----------------

  applyLink(state: LinkState, message?: string) {
    const view = statusView(state, this.data.deviceName, message);
    const ready = state === "ready";
    this.setData({
      ...view,
      ready,
      // ready 时提示文案要反映当前亮度（连接流水线先写 state 再置 ready）。
      brightnessHintText: ready
        ? this.brightnessHintText(this.data.brightness, true)
        : this.data.brightnessHintText,
    });
    if (state !== "ready" && state !== "initializing") {
      // 断线后不显示过期设备状态（设备是权威）。
      if (state === "idle" || state === "failed" || state === "adapter-off") {
        this.setData({
          power: 0,
          powerLabel: "已关",
          brightness: 0,
          brightnessDisplay: 0,
          brightnessPercent: 0,
          brightnessHintText: "连接后可调节",
        });
      }
    }
  },

  applyDeviceState(state: DeviceState) {
    const max = state.maxBrightness > 0 ? state.maxBrightness : 255;
    const brightness = clampBrightness(state.brightness, max);
    this.setData({
      power: state.power,
      powerLabel: this.powerLabelText(state.power, brightness),
      brightness,
      brightnessDisplay: brightness,
      brightnessPercent: percentOf(brightness, max),
      maxBrightness: max,
      brightnessHintText: this.brightnessHintText(brightness, this.data.ready),
      colorHex: `#${[state.r, state.g, state.b]
        .map((v) => v.toString(16).padStart(2, "0"))
        .join("")
        .toUpperCase()}`,
    });
  },

  /** 亮度 0 且 power=1：灯是灭的但开关位仍为开，文案要如实说明（§7）。 */
  powerLabelText(power: 0 | 1, brightness: number): string {
    if (power === 0) {
      return "已关";
    }
    return brightness === 0 ? "已开 · 亮度 0" : "已开";
  },

  applyPowerResult(result: PowerResult) {
    if (result.kind === "ok") {
      this.applyDeviceState(result.state);
      return;
    }
    if (result.kind === "ack-error") {
      wx.showToast({ title: resultText(result.ack.resultCode), icon: "none" });
      // 非零 ACK：设备权威，重新读一次 State（失败就等用户手动重连）。
      void session?.refreshState().then(
        (state) => this.applyDeviceState(state),
        () => undefined,
      );
      return;
    }
    wx.showToast({ title: result.message, icon: "none" });
  },
});
