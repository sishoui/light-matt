/**
 * #97 分区的展示规则：预览条 + 选中态。
 *
 * ## 预览条
 *
 * 分区轴是**可编辑**的（带手柄、可点）；预览条是它的**只读聚合视图**：
 * 按每个分区的颜色画出该组每一颗灯珠，让用户一眼确认分配对不对。
 * 两者都从同一份 `zones` 派生，颜色映射只有一处。
 *
 * ## 选中态
 *
 * 选中一个分区时，属于它的灯珠**边框高亮**；选中结束节点后，那一颗
 * **背景高亮**。以前是整块描边，分不清起点终点。
 */

import type { SegmentSpec } from "../protocol/types";

/** 预览只关心「哪个槽位、从哪到哪、什么颜色」，段规范的两种形态都接受。 */
type ZoneLike = Pick<SegmentSpec, "segId" | "start" | "end" | "layer0">;
import { axisColorMap } from "./zone-axis";

/** 预览条上的一颗灯珠。 */
export interface PreviewLed {
  /** 灯珠下标（0 起）。 */
  index: number;
  /** 这一颗的颜色；空串 = 未被覆盖（画成灰格）。 */
  hex: string;
  /** 属于哪个分区（未覆盖为 -1）。 */
  segId: number;
  /** 是否是某个分区的起点 / 终点（画细描边，帮助用户核对范围）。 */
  start: boolean;
  end: boolean;
}

/**
 * 每个分区 → 颜色。
 *
 * 与分区轴同一来源（`zoneColorHex`），所以预览条与轴上的块**永远同色**。
 * 未覆盖的灯珠 `hex` 为空串。
 */
export function zoneColorsOf(zones: readonly ZoneLike[]): Map<number, string> {
  /* 与分区轴 / 灯珠弹窗**同一个色表**（`axisColorMap`），三处永远同色。 */
  return axisColorMap(zones);
}

/**
 * 生成预览条的逐颗灯珠列表。
 *
 * `ledCount` 是这一组的真实灯珠数；区间越界一律裁到范围内（设备上可能
 * 存在比当前灯珠数更长的旧分区，画出来会溢出）。
 */
export function buildPreviewLeds(zones: readonly ZoneLike[], ledCount: number): PreviewLed[] {
  const total = Math.max(0, Math.floor(ledCount));
  if (total === 0) {
    return [];
  }
  const colors = zoneColorsOf(zones);
  const leds: PreviewLed[] = [];
  for (let index = 0; index < total; index += 1) {
    leds.push({ index, hex: "", segId: -1, start: false, end: false });
  }
  for (const zone of zones) {
    const hex = colors.get(zone.segId) ?? "";
    const start = Math.max(0, Math.min(total - 1, zone.start));
    const end = Math.max(0, Math.min(total - 1, zone.end));
    for (let index = start; index <= end; index += 1) {
      leds[index] = {
        index,
        hex,
        segId: zone.segId,
        start: index === start,
        end: index === end,
      };
    }
  }
  return leds;
}

/** 预览条是否可用（有分区且有灯珠）。 */
export function previewAvailable(zones: readonly ZoneLike[], ledCount: number): boolean {
  return zones.length > 0 && ledCount > 0;
}

/** 选中分区的判定（给 WXML 用）。 */
export function isZoneSelected(segId: number, pickedSegId: number): boolean {
  return segId >= 0 && segId === pickedSegId;
}

/**
 * 「结束节点」的判定（#97：选中结束节点后那一颗背景高亮）。
 *
 * 灯珠弹窗里 `end` 为真的那一颗就是结束节点。
 */
export function isEndNode(cell: { end: boolean }): boolean {
  return cell.end === true;
}
