/**
 * 单页控制界面（#8 开关 + #9 亮度 + #10 颜色与预设）。
 *
 * 页面只做 view model 与事件转发，所有 BLE 细节经 ControlSession。
 * 亮度滑块与色环都进 session 里**同一个** 20Hz latest-wins 节流实例；
 * 预设用一条 SetAll（开关 + 亮度 + RGB）原子下发。
 *
 * 色环用单块 2D canvas：色相环画一次，拖动时只擦/画选中点所在的小块并补回
 * 该角区间的环弧（见 utils/color/wheel.ts）。setData 的取色读数按 20Hz 更新，
 * 与 BLE 节流同一个节奏。
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
  type CommandResult,
} from "../../utils/control/session";
import {
  hsvForWheel,
  hsvToRgb,
  normalizeHue,
  PRESETS,
  rgbToHex,
  rgbToHsv,
} from "../../utils/color/hsv";
import {
  drawWheel,
  hueAtPoint,
  moveWheelMarker,
  wheelGeometry,
  type WheelContext2D,
  type WheelGeometry,
} from "../../utils/color/wheel";
import type { DeviceState, DiscoveredDevice, LinkState, RGB } from "../../utils/protocol/types";

/** 模块级单例：页面重入时复用同一条 BLE 会话。 */
let session: ControlSession | null = null;
let unsubscribers: Array<() => void> = [];

/** 页面取色读数的刷新间隔：与 BLE 20Hz 对齐，避免每个 touchmove 都 setData。 */
const COLOR_UI_INTERVAL_MS = 50;

/** 首屏色环位置与暖白预设对齐（真值来自预设表，不另写一份）。 */
const INITIAL_HSV = rgbToHsv(PRESETS[0].rgb);

interface WheelCtx {
  ctx: WheelContext2D;
  geometry: WheelGeometry;
  dpr: number;
}

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

    // 颜色（#10）：色相环 + 饱和度滑块；RGB 始终是用户空间值（不做 gamma）
    presetList: PRESETS,
    colorHex: PRESETS[0].hex,
    colorHue: INITIAL_HSV.h,
    colorSaturation: Math.round(INITIAL_HSV.s * 100), // 0-100，映射到 S = 0..1
    selectedPreset: PRESETS[0].name,
    colorHintText: "连接后可选色",

    // 扫描 / 设备弹层
    sheetVisible: false,
    sheetMode: "scan" as "scan" | "device",
    devices: [] as DiscoveredDevice[],
    scanHint: "" as string,
    deviceName: "",
    deviceId: "",

    version: "0.1.0",
  },

  /** canvas 上下文与几何：非响应式，放在页面实例上（不进 data）。 */
  wheel: null as WheelCtx | null,
  /** onReady 之后才允许 onShow 重建 canvas（首次 onShow 早于首次布局）。 */
  pageReady: false,
  /** 色环状态：唯一真相；data 里的 colorHue / colorSaturation 只是显示镜像。 */
  wheelHue: INITIAL_HSV.h,
  wheelSaturation: INITIAL_HSV.s,
  /** 取色读数的上次 setData 时间。 */
  lastColorUiAt: 0,
  /** 预设请求序号：只让最新一次预设的结果回写 UI，避免旧色回跳。 */
  presetToken: 0,

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

  onReady() {
    this.pageReady = true;
    this.initWheel();
  },

  onUnload() {
    for (const off of unsubscribers) {
      off();
    }
    unsubscribers = [];
    this.wheel = null;
    // 页面生命周期结束，彻底断开并反注册 wx.on*（避免回调串入）。
    session?.destroy();
    session = null;
  },

  onShow() {
    // 本票不做静默回连（#11）；回到前台只复核一次链路状态文案。
    if (session !== null) {
      this.applyLink(session.linkState);
    }
    // 首次 onShow 早于 onReady（canvas 还没布局），交给 onReady 初始化；
    // 之后回到前台时 canvas 可能被回收，补一次绘制。
    if (!this.pageReady) {
      return;
    }
    if (this.wheel === null) {
      this.initWheel();
    } else {
      this.redrawWheel();
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
      colorHintText: "连接后可选色",
      selectedPreset: "",
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
      const result = await session.setPower(next === 1);
      this.applyCommandResult(result);
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

  // ---------------- 颜色（#10） ----------------

  /** 取画布节点与尺寸，按 dpr 建上下文并画一次色相环。 */
  initWheel() {
    const query = wx.createSelectorQuery();
    query
      .select("#color-wheel")
      .fields({ node: true, size: true })
      .exec((res: any[]) => {
        const node = res?.[0]?.node as WechatMiniprogram.Canvas | undefined;
        const width = Number(res?.[0]?.width ?? 0);
        if (!node || width <= 0) {
          console.warn("[lumen] 取不到色环 canvas 节点，颜色只能靠预设");
          return;
        }

        const dpr = this.pixelRatio();
        // 物理像素 = CSS 像素 × dpr；绘制时统一 setTransform(dpr,...)。
        node.width = Math.round(width * dpr);
        node.height = Math.round(width * dpr);

        this.wheel = {
          ctx: node.getContext("2d") as unknown as WheelContext2D,
          geometry: wheelGeometry(width),
          dpr,
        };
        this.redrawWheel();
      });
  },

  /** 设备像素比；取不到按 2（宁可放大，不可模糊）。 */
  pixelRatio(): number {
    try {
      const info = wx.getWindowInfo?.() ?? wx.getSystemInfoSync();
      const ratio = Number((info as { pixelRatio?: number }).pixelRatio ?? 2);
      return Number.isFinite(ratio) && ratio > 0 ? ratio : 2;
    } catch {
      return 2;
    }
  },

  /** 整块重画色环与选中点（首次绘制 / 页面回前台 / 状态同步时用）。 */
  redrawWheel() {
    if (this.wheel === null) {
      return;
    }
    const { ctx, geometry, dpr } = this.wheel;
    drawWheel(ctx, geometry, dpr, this.wheelHue, rgbToHex(this.wheelRgb()));
  },

  /** 色环 + 饱和度对应的用户空间 RGB（V 恒为 1，亮度由滑块负责）。 */
  wheelRgb(): RGB {
    return hsvToRgb(this.wheelHue, this.wheelSaturation, 1);
  },

  /** touchstart / touchmove 共用：把触摸点换算成色相并下发（20Hz 节流在 session）。 */
  handleWheelTouch(e: WechatMiniprogram.TouchCanvas) {
    if (this.wheel === null || !this.data.ready) {
      return;
    }
    // 多指触摸容易误判，只处理单指。
    if (Array.isArray(e.touches) && e.touches.length > 1) {
      return;
    }
    const touch = e.touches?.[0];
    if (!touch) {
      return;
    }
    const hue = hueAtPoint(touch.x, touch.y, this.wheel.geometry);
    if (hue === null) {
      // 点在环内空白或环外：忽略，避免手指划过中心时颜色乱跳。
      return;
    }
    this.applyHue(hue);
  },

  onWheelTouchStart(e: WechatMiniprogram.TouchCanvas) {
    this.handleWheelTouch(e);
  },

  onWheelTouchMove(e: WechatMiniprogram.TouchCanvas) {
    this.handleWheelTouch(e);
  },

  /** 松手：把当前颜色再推一次并 flush，保证最终颜色落地。 */
  onWheelTouchEnd() {
    if (!this.data.ready) {
      return;
    }
    session?.commitColor(this.wheelRgb());
  },

  /** 色相变化：marker 立即重画；读数 setData 与 BLE 都按 20Hz 节流。 */
  applyHue(hue: number) {
    const previousHue = this.wheelHue;
    this.wheelHue = normalizeHue(hue);
    const rgb = this.wheelRgb();
    const hex = rgbToHex(rgb);
    if (this.wheel !== null) {
      moveWheelMarker(
        this.wheel.ctx,
        this.wheel.geometry,
        this.wheel.dpr,
        this.wheelHue,
        hex,
        previousHue,
      );
    }
    session?.queueColor(rgb);

    const now = Date.now();
    if (now - this.lastColorUiAt < COLOR_UI_INTERVAL_MS) {
      return;
    }
    this.lastColorUiAt = now;
    this.setData({
      colorHue: this.wheelHue,
      colorHex: hex,
      selectedPreset: "",
      colorHintText: this.colorHintText(this.data.ready),
    });
  },

  onSaturationChanging(e: WechatMiniprogram.SliderChanging) {
    this.applySaturation(Number(e.detail.value), false);
  },

  onSaturationChange(e: WechatMiniprogram.SliderChange) {
    this.applySaturation(Number(e.detail.value), true);
  },

  /** 饱和度（0-100）→ S=0..1；V 恒为 1（亮度独立，不折进 RGB）。 */
  applySaturation(value: number, commit: boolean) {
    if (!Number.isFinite(value)) {
      return;
    }
    this.wheelSaturation = Math.min(100, Math.max(0, Math.round(value))) / 100;
    const rgb = this.wheelRgb();
    const hex = rgbToHex(rgb);
    if (this.wheel !== null) {
      /* 饱和度只改 marker 的填充色，位置（色相）不变；走局部擦补比重画整环便宜。 */
      moveWheelMarker(
        this.wheel.ctx,
        this.wheel.geometry,
        this.wheel.dpr,
        this.wheelHue,
        hex,
        this.wheelHue,
      );
    }
    this.setData({
      colorSaturation: Math.round(this.wheelSaturation * 100),
      colorHex: hex,
      selectedPreset: "",
      colorHintText: this.colorHintText(this.data.ready),
    });
    if (commit) {
      session?.commitColor(rgb);
    } else {
      session?.queueColor(rgb);
    }
  },

  /**
   * 预设点击：一次 SetAll（开关=1、亮度=当前、RGB=预设）原子下发。
   *
   * 快速连点不同预设时，只有最后一次请求的结果回写 UI（presetToken），
   * 避免先发出的请求晚返回把颜色改回旧的。SetAll 是绝对值命令，FIFO 顺序
   * 保证设备最终状态 = 最后一次点击。
   */
  async onPresetTap(e: WechatMiniprogram.TouchEvent) {
    if (session === null || !this.data.ready) {
      return;
    }
    const index = Number(e.currentTarget.dataset.index ?? -1);
    const preset = PRESETS[index];
    if (preset === undefined) {
      return;
    }

    const token = ++this.presetToken;
    // 先本地切换 UI：预设是离散动作，期望「点下即变」；ACK 回来后再按设备语义校准。
    this.setData({
      power: 1,
      powerLabel: "已开",
      colorHex: preset.hex,
      selectedPreset: preset.name,
      colorHintText: this.colorHintText(true),
    });
    this.syncWheelToRgb(preset.rgb);

    const result = await session.applyPreset(preset.rgb);
    if (token !== this.presetToken) {
      return; // 已有更新的一次预设请求，丢弃这次结果
    }
    this.applyCommandResult(result);
  },

  /** 把设备/预设颜色反推回色环位置与饱和度（灰阶时保留当前色相）。 */
  syncWheelToRgb(rgb: RGB) {
    const hsv = hsvForWheel(rgb, this.wheelHue);
    this.wheelHue = hsv.h;
    this.wheelSaturation = hsv.s;
    this.setData({
      colorHue: hsv.h,
      colorSaturation: Math.round(hsv.s * 100),
    });
    this.redrawWheel();
  },

  colorHintText(ready: boolean): string {
    if (!ready) {
      return "连接后可选色";
    }
    return "拖动色环实时跟随；预设一次原子切换";
  },

  // ---------------- 内部 ----------------

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
      colorHintText: this.colorHintText(ready),
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
          colorHintText: "连接后可选色",
          selectedPreset: "",
        });
      }
    }
  },

  applyDeviceState(state: DeviceState) {
    const max = state.maxBrightness > 0 ? state.maxBrightness : 255;
    const brightness = clampBrightness(state.brightness, max);
    const rgb: RGB = { r: state.r, g: state.g, b: state.b };
    const hsv = hsvForWheel(rgb, this.wheelHue);
    this.wheelHue = hsv.h;
    this.wheelSaturation = hsv.s;
    this.setData({
      power: state.power,
      powerLabel: this.powerLabelText(state.power, brightness),
      brightness,
      brightnessDisplay: brightness,
      brightnessPercent: percentOf(brightness, max),
      maxBrightness: max,
      brightnessHintText: this.brightnessHintText(brightness, this.data.ready),
      colorHex: rgbToHex(rgb),
      colorHue: hsv.h,
      colorSaturation: Math.round(hsv.s * 100),
      selectedPreset: this.matchingPreset(rgb),
      colorHintText: this.colorHintText(this.data.ready),
    });
    this.redrawWheel();
  },

  /** 当前 RGB 与哪个预设完全一致（用于高亮）；都不匹配返回空串。 */
  matchingPreset(rgb: RGB): string {
    for (const preset of PRESETS) {
      if (preset.rgb.r === rgb.r && preset.rgb.g === rgb.g && preset.rgb.b === rgb.b) {
        return preset.name;
      }
    }
    return "";
  },

  /** 亮度 0 且 power=1：灯是灭的但开关位仍为开，文案要如实说明（§7）。 */
  powerLabelText(power: 0 | 1, brightness: number): string {
    if (power === 0) {
      return "已关";
    }
    return brightness === 0 ? "已开 · 亮度 0" : "已开";
  },

  /** 离散命令结果：成功用设备语义刷新 UI；失败提示并回读 State（设备权威）。 */
  applyCommandResult(result: CommandResult) {
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
