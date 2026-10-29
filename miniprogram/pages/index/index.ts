/**
 * 单页控制界面（#8 walking skeleton）。
 *
 * 页面只做 view model 与事件转发，所有 BLE 细节经 ControlSession。
 * 本票只打通「设开关」；亮度 / 色环 / 预设区域渲染为禁用占位，
 * 后续 #9 / #10 直接把控件接到 session.queueBrightness / queueColor，
 * 不需要重排页面。
 */

import { errorText, resultText } from "../../utils/ble/errors";
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

    // 为 #9 / #10 预留的状态（本票只显示，不控制）
    brightness: 0,
    brightnessPercent: 0,
    maxBrightness: 255,
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
    this.setData({ sheetVisible: false, deviceName: "", deviceId: "", power: 0, powerLabel: "已关" });
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

  // ---------------- 内部 ----------------

  applyLink(state: LinkState, message?: string) {
    const view = statusView(state, this.data.deviceName, message);
    this.setData({
      ...view,
      ready: state === "ready",
    });
    if (state !== "ready" && state !== "initializing") {
      // 断线后不显示过期设备状态（设备是权威）。
      if (state === "idle" || state === "failed" || state === "adapter-off") {
        this.setData({ power: 0, powerLabel: "已关", brightnessPercent: 0 });
      }
    }
  },

  applyDeviceState(state: DeviceState) {
    const max = state.maxBrightness > 0 ? state.maxBrightness : 255;
    this.setData({
      power: state.power,
      powerLabel: state.power === 1 ? "已开" : "已关",
      brightness: state.brightness,
      brightnessPercent: Math.round((Math.min(state.brightness, max) / max) * 100),
      maxBrightness: state.maxBrightness,
      colorHex: `#${[state.r, state.g, state.b]
        .map((v) => v.toString(16).padStart(2, "0"))
        .join("")
        .toUpperCase()}`,
    });
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
