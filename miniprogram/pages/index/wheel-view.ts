/**
 * 色环视图控制器：canvas 上下文、几何、色相/饱和度状态与触摸换算。
 *
 * 拆分前这些字段与函数散在 Page 实例上（wheel / wheelHue / wheelSaturation /
 * lastColorUiAt ...）。搬到独立类后 index.ts 只负责把页面事件转发进来、
 * 把回调里的补丁 setData 出去；绘制与节流规则不变。
 *
 * #25 起颜色真正启用：手势把「选中段的静态颜色」写进设备（SetSegment 0x10）。
 * 没有选中段时手势被忽略并提示先划区间——绝不在设备没收到命令时显示已变色。
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
  /** 是否有可写的选中段；false 时手势被忽略并提示。 */
  hasActiveSegment(): boolean;
  /** 当前选中段的展示信息（hint 文案据此切换）。 */
  activeSegmentRange(): { segId: number; start: number; end: number } | null;
  /** 拖动中（连续量）：写选中段的颜色，走 20Hz 节流。 */
  queueColor(rgb: RGB): void;
  /** 松手：写最终颜色并 flush。 */
  commitColor(rgb: RGB): void;
  /** 没有选中段时的提示。 */
  notifySelectSegment?(): void;
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
    if (!this.host.isReady()) {
      return;
    }
    if (!this.host.hasActiveSegment()) {
      // 每次手势只提示一次（touchstart），避免 touchmove 高频弹 toast。
      if (e.type === "touchstart") {
        this.host.notifySelectSegment?.();
      }
      return;
    }
    if (this.ctx === null) {
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
    if (!this.host.hasActiveSegment()) {
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
      colorHintText: colorHintText(this.host.isReady(), this.host.activeSegmentRange()),
    });
  }

  /** 饱和度（0-100）→ S=0..1；V 恒为 1（亮度独立，不折进 RGB）。 */
  applySaturation(value: number, commit: boolean): void {
    if (!this.host.hasActiveSegment()) {
      // 松手时提示一次；拖动过程中静默忽略（避免每帧弹 toast）。
      if (commit) {
        this.host.notifySelectSegment?.();
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
      colorHintText: colorHintText(this.host.isReady(), this.host.activeSegmentRange()),
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
    if (!this.host.isReady() || !this.host.hasActiveSegment()) {
      return;
    }
    this.host.commitColor(this.rgb());
  }
}
