/**
 * 色环视图控制器：canvas 上下文、几何、色相/饱和度状态与触摸换算。
 *
 * 拆分前这些字段与函数散在 Page 实例上（wheel / wheelHue / wheelSaturation /
 * lastColorUiAt ...）。搬到独立类后 index.ts 只负责把页面事件转发进来、
 * 把回调里的补丁 setData 出去；绘制与节流规则不变。
 *
 * 只依赖 utils/color（纯函数），不直接接触 wx 页面 API——canvas 节点由宿主
 * 通过 init() 传进来，setData 也由宿主回调完成。
 */

import {
  hsvForWheel,
  hsvToRgb,
  normalizeHue,
  rgbToHex,
} from "../../utils/color/hsv";
import {
  drawWheel,
  hueAtPoint,
  moveWheelMarker,
  wheelGeometry,
  type WheelContext2D,
  type WheelGeometry,
} from "../../utils/color/wheel";
import type { RGB } from "../../utils/protocol/types";
import { colorHintText } from "./view-model";

/**
 * v2（#21）：颜色下发路径暂时禁用。
 *
 * SetColor 0x03 / SetAll 0x04 已退役，单色概念改由段配置承担。这里保留控件
 * （不静默删功能），但**不修改任何状态**：设备没收到命令，界面就不能显示
 * 已经变色。手势只弹一次提示。
 *
 * TODO(#25)：分段界面落地后删掉这个开关。
 */
const COLOR_CONTROLS_ENABLED = false;

interface WheelCtx {
  ctx: WheelContext2D;
  geometry: WheelGeometry;
  dpr: number;
}

export interface WheelHost {
  /** 页面 setData 的薄封装。 */
  setData(patch: Record<string, unknown>): void;
  /** 页面是否已就绪（ready）。 */
  isReady(): boolean;
  /** 当前 ready 位的展示用快照（hint 文案据此切换）。 */
  queueColor(rgb: RGB): void;
  commitColor(rgb: RGB): void;
  /**
   * v2（#21）：颜色下发禁用期间，手势结束时由宿主弹一次「该功能在 v2 分段
   * 界面中提供（#25）」。可选，缺省时静默。TODO(#25)
   */
  notifySegmentsNotice?(): void;
}

/** 取色读数的刷新间隔：与 BLE 20Hz 对齐，避免每个 touchmove 都 setData。 */
export const COLOR_UI_INTERVAL_MS = 50;

export class WheelView {
  private ctx: WheelCtx | null = null;
  /** 色环状态：唯一真相；data 里的 colorHue / colorSaturation 只是显示镜像。 */
  private hue: number;
  private saturation: number;
  /** 取色读数的上次 setData 时间。 */
  private lastColorUiAt = 0;
  private readonly host: WheelHost;

  constructor(host: WheelHost, initial: { hue: number; saturation: number }) {
    this.host = host;
    this.hue = initial.hue;
    this.saturation = initial.saturation;
  }

  get hueValue(): number {
    return this.hue;
  }

  get saturationValue(): number {
    return this.saturation;
  }

  /** 点/画布是否已经建好。 */
  get canDraw(): boolean {
    return this.ctx !== null;
  }

  /** 拿到 canvas 节点后建立上下文并画一次色相环。node 为 null 表示取不到。 */
  attach(node: WechatMiniprogram.Canvas | null, width: number, dpr: number): void {
    if (!node || width <= 0) {
      console.warn("[lumen] 取不到色环 canvas 节点，颜色只能靠预设");
      return;
    }
    // 物理像素 = CSS 像素 × dpr；绘制时统一 setTransform(dpr,...)。
    node.width = Math.round(width * dpr);
    node.height = Math.round(width * dpr);

    this.ctx = {
      ctx: node.getContext("2d") as unknown as WheelContext2D,
      geometry: wheelGeometry(width),
      dpr,
    };
    this.redraw();
  }

  /** 色环 + 饱和度对应的用户空间 RGB（V 恒为 1，亮度由滑块负责）。 */
  rgb(): RGB {
    return hsvToRgb(this.hue, this.saturation, 1);
  }

  /** 整块重画色环与选中点（首次绘制 / 页面回前台 / 状态同步时用）。 */
  redraw(): void {
    if (this.ctx === null) {
      return;
    }
    const { ctx, geometry, dpr } = this.ctx;
    drawWheel(ctx, geometry, dpr, this.hue, rgbToHex(this.rgb()));
  }

  /**
   * touchstart / touchmove 共用：把触摸点换算成色相并下发（20Hz 节流在 session）。
   * 多指 / 环外点击都忽略（避免手指划过中心时颜色乱跳）。
   */
  handleTouch(e: WechatMiniprogram.TouchCanvas): void {
    if (!COLOR_CONTROLS_ENABLED) {
      // 每次手势只提示一次（touchstart），避免 touchmove 高频弹 toast。
      if (e.type === "touchstart") {
        this.host.notifySegmentsNotice?.();
      }
      return;
    }
    if (this.ctx === null || !this.host.isReady()) {
      return;
    }
    if (Array.isArray(e.touches) && e.touches.length > 1) {
      return;
    }
    const touch = e.touches?.[0];
    if (!touch) {
      return;
    }
    const hue = hueAtPoint(touch.x, touch.y, this.ctx.geometry);
    if (hue === null) {
      return;
    }
    this.applyHue(hue);
  }

  /** 色相变化：marker 立即重画；读数 setData 与 BLE 都按 20Hz 节流。 */
  applyHue(hue: number): void {
    if (!COLOR_CONTROLS_ENABLED) {
      return;
    }
    const previousHue = this.hue;
    this.hue = normalizeHue(hue);
    const rgb = this.rgb();
    const hex = rgbToHex(rgb);
    if (this.ctx !== null) {
      moveWheelMarker(
        this.ctx.ctx,
        this.ctx.geometry,
        this.ctx.dpr,
        this.hue,
        hex,
        previousHue,
      );
    }
    this.host.queueColor(rgb);

    const now = Date.now();
    if (now - this.lastColorUiAt < COLOR_UI_INTERVAL_MS) {
      return;
    }
    this.lastColorUiAt = now;
    this.host.setData({
      colorHue: this.hue,
      colorHex: hex,
      selectedPreset: "",
      colorHintText: colorHintText(this.host.isReady()),
    });
  }

  /** 饱和度（0-100）→ S=0..1；V 恒为 1（亮度独立，不折进 RGB）。 */
  applySaturation(value: number, commit: boolean): void {
    if (!COLOR_CONTROLS_ENABLED) {
      // 松手时提示一次；拖动过程中静默忽略（避免每帧弹 toast）。
      if (commit) {
        this.host.notifySegmentsNotice?.();
      }
      return;
    }
    if (!Number.isFinite(value)) {
      return;
    }
    this.saturation = Math.min(100, Math.max(0, Math.round(value))) / 100;
    const rgb = this.rgb();
    const hex = rgbToHex(rgb);
    if (this.ctx !== null) {
      /* 饱和度只改 marker 的填充色，位置（色相）不变；走局部擦补比重画整环便宜。 */
      moveWheelMarker(
        this.ctx.ctx,
        this.ctx.geometry,
        this.ctx.dpr,
        this.hue,
        hex,
        this.hue,
      );
    }
    this.host.setData({
      colorSaturation: Math.round(this.saturation * 100),
      colorHex: hex,
      selectedPreset: "",
      colorHintText: colorHintText(this.host.isReady()),
    });
    if (commit) {
      this.host.commitColor(rgb);
    } else {
      this.host.queueColor(rgb);
    }
  }

  /**
   * 记录色相/饱和度但不 setData、不重绘（applyDeviceState 要把它们并进
   * 同一次 setData，保持拆分前「一次 setData + 一次整环重绘」的节奏）。
   */
  assign(rgb: RGB): { h: number; s: number } {
    const hsv = hsvForWheel(rgb, this.hue);
    this.hue = hsv.h;
    this.saturation = hsv.s;
    return { h: hsv.h, s: hsv.s };
  }

  /** 把设备/预设颜色反推回色环位置与饱和度（灰阶时保留当前色相）。 */
  syncToRgb(rgb: RGB): void {
    const hsv = hsvForWheel(rgb, this.hue);
    this.hue = hsv.h;
    this.saturation = hsv.s;
    this.host.setData({
      colorHue: hsv.h,
      colorSaturation: Math.round(hsv.s * 100),
    });
    this.redraw();
  }

  /** 松手：把当前颜色再推一次并 flush，保证最终颜色落地。 */
  commit(): void {
    if (!this.host.isReady()) {
      return;
    }
    this.host.commitColor(this.rgb());
  }
}
