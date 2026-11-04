/**
 * #95 灯组页头部的纯逻辑：固定三套方案 + 灯珠数拨盘。
 *
 * ## 为什么方案只剩三套
 *
 * 协议仍有四个槽位，但界面上「四套方案 + 新建 + 删除」让用户越想越乱：
 * 空位占着位置，删一套还要担心编号搬家。现在固定 ① ② ③，没有新增 / 删除，
 * 第四个槽位的旧草稿在进页面时直接清掉（当前测试阶段不做兼容迁移）。
 *
 * ## 拨盘
 *
 * 灯珠数不再是页面里一块独立滑块，而是标题右侧的胶囊；长按弹出圆盘，
 * 转动调数量、松手下发。圆盘的刻度规则（每 10 颗一条长刻度）是纯算术，
 * 放在这里可单测。
 */

import { MAX_LEDS, MIN_LEDS } from "../protocol/constants";

/** 界面上的方案数量（协议槽位仍是 4）。 */
export const VISIBLE_PLAN_COUNT = 3;

/** 界面使用的方案编号（固定 0/1/2）。 */
export function visiblePlanIds(): number[] {
  return Array.from({ length: VISIBLE_PLAN_COUNT }, (_, index) => index);
}

/** 被界面丢弃的槽位编号（协议仍有，但不再用于编辑）。 */
export const DROPPED_PLAN_ID = 3;

/**
 * 圆盘刻度的一条。
 *
 * `major` 是「每 10 颗一条长刻度」；0 与边界也画长刻度，方便对齐。
 */
export interface DialTick {
  value: number;
  major: boolean;
  /** 长刻度上的数字标签；短刻度为空串（避免 100 个数字糊在一起）。 */
  label: string;
}

/** 每几颗一条长刻度。 */
export const DIAL_MAJOR_STEP = 10;

/**
 * 生成拨盘刻度（1..maxLed 全部有刻度，方便「转一格 = 一颗」）。
 *
 * 刻度值从 `min` 到 `max` 连续；`major` 的判定用绝对值的倍数关系，
 * 所以 10/20/…/100 在任何范围下都对齐。
 */
export function buildDialTicks(minLed: number = MIN_LEDS, maxLed: number = MAX_LEDS): DialTick[] {
  const lo = Math.max(MIN_LEDS, Math.floor(minLed));
  const hi = Math.min(MAX_LEDS, Math.floor(maxLed));
  if (hi < lo) {
    return [];
  }
  const ticks: DialTick[] = [];
  for (let value = lo; value <= hi; value += 1) {
    const major = value % DIAL_MAJOR_STEP === 0 || value === lo || value === hi;
    ticks.push({ value, major, label: major ? String(value) : "" });
  }
  return ticks;
}

/** 把任意拖动值钳到合法灯珠数（整数、1..100）。 */
export function clampDialValue(value: number, minLed: number = MIN_LEDS, maxLed: number = MAX_LEDS): number {
  const lo = Math.max(MIN_LEDS, Math.floor(minLed));
  const hi = Math.min(MAX_LEDS, Math.floor(maxLed));
  if (!Number.isFinite(value)) {
    return lo;
  }
  return Math.max(lo, Math.min(hi, Math.round(value)));
}

/**
 * 拖动位移 → 灯珠数。
 *
 * 圆盘的交互是「绕中心转」：一圈转多少颗由 `degreesPerLed` 决定。这里用
 * **角度差**而不是横坐标差——横坐标在圆盘边缘会让前半圈和后半圈灵敏度差
 * 几倍，用户会觉得「转到下面就不动了」。
 */
export function dialValueFromAngle(input: {
  startAngleDeg: number;
  currentAngleDeg: number;
  startValue: number;
  degreesPerLed?: number;
  minLed?: number;
  maxLed?: number;
}): number {
  const per = input.degreesPerLed !== undefined && input.degreesPerLed > 0 ? input.degreesPerLed : 4;
  /* 处理 ±180° 的环绕：顺时针与逆时针都取最短弧。 */
  let delta = input.currentAngleDeg - input.startAngleDeg;
  while (delta > 180) delta -= 360;
  while (delta < -180) delta += 360;
  const value = input.startValue + delta / per;
  return clampDialValue(value, input.minLed, input.maxLed);
}

/** 点相对圆心的角度（度，0 = 正上方，顺时针为正）。 */
export function angleOfPoint(input: { x: number; y: number; centerX: number; centerY: number }): number {
  const dx = input.x - input.centerX;
  const dy = input.y - input.centerY;
  if (dx === 0 && dy === 0) {
    return 0;
  }
  return (Math.atan2(dx, -dy) * 180) / Math.PI;
}

/** 胶囊文案：「64 颗」。 */
export function ledCapsuleText(ledCount: number): string {
  if (!Number.isFinite(ledCount) || ledCount <= 0) {
    return "— 颗";
  }
  return `${Math.round(ledCount)} 颗`;
}

/**
 * 缩小灯珠数是否会裁掉已有分区。
 *
 * 与 `led-count-plan` 的越界检查同源：任何分区的终点 ≥ 新灯珠数就会被裁。
 * 这里只回答「要不要先问一句」，具体裁剪由既有逻辑做。
 */
export function willTrimZones(
  zones: ReadonlyArray<{ start: number; end: number }>,
  nextLedCount: number,
): boolean {
  if (!Number.isFinite(nextLedCount) || nextLedCount <= 0) {
    return zones.length > 0;
  }
  return zones.some((zone) => zone.end >= nextLedCount);
}

/**
 * 方案按钮的展示形态（圆形数字）。
 *
 * `hasContent` 决定点击时是否写设备：空方案点了不写，避免把设备刷成空白。
 */
export interface PlanCircleView {
  id: number;
  /** 圆里的数字（1 起，用户视角）。 */
  label: string;
  selected: boolean;
  /** 有内容（本机草稿或设备摘要）。 */
  hasContent: boolean;
  /** 正在播放。 */
  playing: boolean;
  /** 摘要（「3 步」/「空白」）。 */
  summary: string;
}

export function buildPlanCircles(input: {
  selectedId: number;
  summaries: Readonly<Record<number, string>>;
  /** 哪些编号有内容（末尾为 true 的集合）。 */
  withContent: readonly number[];
  playingId: number | null;
}): PlanCircleView[] {
  const content = new Set(input.withContent);
  return visiblePlanIds().map((id) => ({
    id,
    label: String(id + 1),
    selected: id === input.selectedId,
    hasContent: content.has(id),
    playing: input.playingId === id,
    summary: input.summaries[id] ?? "空白",
  }));
}
