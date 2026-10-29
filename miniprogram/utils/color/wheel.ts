/**
 * 色环几何与绘制（#10）。
 *
 * 设计取舍（notes §6.4）：
 *  - MVP 用**色相环**：环上任意一点只决定 hue（S=1、V=1），亮度由独立滑块负责，
 *    饱和度用环下方单独的滑块调；不把 V 折进颜色，也不做 gamma。
 *  - 只用**一块** canvas（两层 canvas 叠放在原生组件上依赖 z-index 与命中测试，
 *    真机风险不必要）。色相环在外圈、选中点只占很小一块，所以拖动时不清整块：
 *    擦掉上一处标记矩形，重画该角区间内的几段环弧，再画新标记。
 *
 * 几何函数与绘制函数都不依赖 DOM：几何是纯函数（vitest 直接测），绘制只要求
 * 一个极简 2D 上下文接口（测试里用记录调用的假上下文）。
 */

/** 极简 2D 上下文接口：只声明本模块用到的成员，避免引入 DOM 类型。
 *  strokeStyle / fillStyle 用 unknown 接收，这样 wx 的 CanvasRenderingContext2D
 *  （属性类型是 string | CanvasGradient | CanvasPattern）也能结构兼容。 */
export interface WheelContext2D {
  setTransform(a: number, b: number, c: number, d: number, e: number, f: number): void;
  clearRect(x: number, y: number, width: number, height: number): void;
  beginPath(): void;
  arc(
    x: number,
    y: number,
    radius: number,
    startAngle: number,
    endAngle: number,
    counterclockwise?: boolean,
  ): void;
  stroke(): void;
  fill(): void;
  strokeStyle: unknown;
  fillStyle: unknown;
  lineWidth: number;
  lineCap: "butt" | "round" | "square";
}

export interface WheelGeometry {
  /** 画布边长（CSS 像素，正方形）。 */
  size: number;
  /** 圆心坐标（正方形，等于 size / 2）。 */
  center: number;
  /** 环外半径。 */
  outerRadius: number;
  /** 环内半径。 */
  innerRadius: number;
  /** 环宽。 */
  ringWidth: number;
  /** 选中点所在的半径（环中线）。 */
  markerRadius: number;
}

/** 每段弧的角度（弧度）：1°。 */
const STEP = Math.PI / 180;
/** 相邻弧首尾外扩的角度，避免抗锯齿细缝。 */
const ARC_OVERLAP = 0.35 * STEP;

/**
 * 由画布边长推导色环几何。
 *
 * 环宽取边长的 24%：420rpx 的环上约 100rpx 宽，手指按住不容易过界，
 * 内圈留出足够空白避免误触中心。触摸命中判定额外放宽 WHEEL_HIT_SLOP。
 */
export function wheelGeometry(size: number): WheelGeometry {
  /* 尺寸异常时退到 4px：保证半径不为负，几何函数永远可调用（真机上
   * 尺寸只会在节点尚未布局时取到 0）。 */
  const safeSize = Number.isFinite(size) && size > 4 ? size : 4;
  const outerRadius = Math.max(1, safeSize / 2 - 1);
  const ringWidth = safeSize * 0.24;
  const innerRadius = Math.max(0, outerRadius - ringWidth);
  return {
    size: safeSize,
    center: safeSize / 2,
    outerRadius,
    innerRadius,
    ringWidth,
    markerRadius: innerRadius + ringWidth / 2,
  };
}

/** 触摸命中的外扩容差（CSS 像素）：手指有宽度，边缘不应「打滑丢失」。 */
export const WHEEL_HIT_SLOP = 10;

/**
 * 触摸点 → 色相角（0-360）。
 *
 * 返回 null 表示点在环带之外（内圈空白或环外），调用方应忽略这次触摸，
 * 避免拖动时手指划过中心导致颜色乱跳。
 * 角度定义与绘制一致：0° 在 3 点钟方向，顺时针增加（屏幕 y 向下）。
 */
export function hueAtPoint(x: number, y: number, geometry: WheelGeometry): number | null {
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    return null;
  }
  const dx = x - geometry.center;
  const dy = y - geometry.center;
  const distance = Math.sqrt(dx * dx + dy * dy);
  if (distance < geometry.innerRadius - WHEEL_HIT_SLOP) {
    return null;
  }
  if (distance > geometry.outerRadius + WHEEL_HIT_SLOP) {
    return null;
  }
  const degrees = (Math.atan2(dy, dx) * 180) / Math.PI;
  return (degrees + 360) % 360;
}

/** 色相角 → 环中线上选中点的坐标（绘制 marker 用）。 */
export function pointForHue(hue: number, geometry: WheelGeometry): { x: number; y: number } {
  const radians = ((hue % 360) * Math.PI) / 180;
  return {
    x: geometry.center + Math.cos(radians) * geometry.markerRadius,
    y: geometry.center + Math.sin(radians) * geometry.markerRadius,
  };
}

/** 选中点的视觉半径（含 1.5px 描边余量）。 */
export function markerRadiusOf(geometry: WheelGeometry): number {
  return Math.max(6, geometry.ringWidth * 0.34);
}

/** 画一段色相弧（hueDeg 为弧中心角度）。 */
function strokeArc(ctx: WheelContext2D, geometry: WheelGeometry, hueDeg: number): void {
  const angle = hueDeg * STEP;
  ctx.beginPath();
  ctx.strokeStyle = `hsl(${hueDeg}, 100%, 50%)`;
  ctx.arc(
    geometry.center,
    geometry.center,
    geometry.markerRadius,
    angle - ARC_OVERLAP,
    angle + STEP + ARC_OVERLAP,
  );
  ctx.stroke();
}

/** 整圈色相环：360 段 1° 弧。 */
function strokeRing(ctx: WheelContext2D, geometry: WheelGeometry): void {
  ctx.lineWidth = geometry.ringWidth;
  ctx.lineCap = "butt";
  for (let hue = 0; hue < 360; hue += 1) {
    strokeArc(ctx, geometry, hue);
  }
}

/** 选中点周围的擦除矩形（含白描边余量）。 */
function markerBox(
  hue: number,
  geometry: WheelGeometry,
): { x: number; y: number; size: number } {
  const point = pointForHue(hue, geometry);
  const radius = markerRadiusOf(geometry) + 3;
  return { x: point.x - radius, y: point.y - radius, size: radius * 2 };
}

/** 标记矩形覆盖的角度半宽（弧度），按内圈半径保守放大。 */
function markerAngleHalfSpan(geometry: WheelGeometry): number {
  const radius = markerRadiusOf(geometry) + 3;
  const reference = Math.max(1, geometry.innerRadius);
  return Math.atan2(radius, reference) + 2 * STEP;
}

/** 擦掉某个标记矩形，并把该角区间内的环弧重画回来。 */
function eraseMarker(ctx: WheelContext2D, geometry: WheelGeometry, hue: number): void {
  const box = markerBox(hue, geometry);
  ctx.clearRect(box.x, box.y, box.size, box.size);

  const halfSpanDeg = (markerAngleHalfSpan(geometry) * 180) / Math.PI + 1;
  const start = Math.floor(hue - halfSpanDeg);
  const end = Math.ceil(hue + halfSpanDeg);
  ctx.lineWidth = geometry.ringWidth;
  ctx.lineCap = "butt";
  for (let deg = start; deg <= end; deg += 1) {
    strokeArc(ctx, geometry, ((deg % 360) + 360) % 360);
  }
}

/** 画选中点：实心圆 + 白色外圈 + 深色细描边，任何色相上都看得见。 */
function strokeMarker(
  ctx: WheelContext2D,
  geometry: WheelGeometry,
  hue: number,
  fillColor: string,
): void {
  const point = pointForHue(hue, geometry);
  const radius = markerRadiusOf(geometry);

  ctx.beginPath();
  ctx.fillStyle = fillColor;
  ctx.arc(point.x, point.y, radius, 0, Math.PI * 2);
  ctx.fill();

  ctx.lineWidth = 2;
  ctx.strokeStyle = "rgba(255,255,255,0.95)";
  ctx.stroke();

  ctx.beginPath();
  ctx.lineWidth = 1;
  ctx.strokeStyle = "rgba(0,0,0,0.35)";
  ctx.arc(point.x, point.y, radius + 1.5, 0, Math.PI * 2);
  ctx.stroke();
}

/** 整块重画：色相环 + 选中点（首次绘制、页面回前台、尺寸变化时用）。 */
export function drawWheel(
  ctx: WheelContext2D,
  geometry: WheelGeometry,
  dpr: number,
  hue: number,
  fillColor: string,
): void {
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, geometry.size, geometry.size);
  strokeRing(ctx, geometry);
  strokeMarker(ctx, geometry, hue, fillColor);
}

/**
 * 只重画选中点（拖动中每次 touchmove 用）。
 *
 * previousHue 是上一次标记的位置：先擦掉旧标记矩形并重画该角区间的环弧，
 * 再画新标记。新位置的环弧无需重画——新标记本来就盖在完整的环上，只有旧
 * 标记擦掉的区域需要补。工作量恒定为「一段角区间 + 一个圆点」，与拖动历史
 * 和距离无关（也比重画整环便宜一个数量级）。
 */
export function moveWheelMarker(
  ctx: WheelContext2D,
  geometry: WheelGeometry,
  dpr: number,
  hue: number,
  fillColor: string,
  previousHue: number,
): void {
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  eraseMarker(ctx, geometry, previousHue);
  strokeMarker(ctx, geometry, hue, fillColor);
}
