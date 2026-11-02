/**
 * 光区布局（自定义档的「多分段」逻辑，纯函数）。
 *
 * 一个灯组是一条连续灯珠，用户把它切成若干**光区**，每个光区有自己的
 * 主效果 / 叠加效果。协议要求**同一灯组内的光区不能重叠**（设备会回
 * InvalidParam），所以重叠必须在本地就拦住——一帧都不发。
 *
 * 本模块只处理「区间」这一维：切分、校验、逐灯珠归属。灯效参数在
 * `segment-editor` / `quick-effects` 里，互不依赖。
 */

import { MAX_LEDS, MAX_SEGMENTS } from "../protocol/constants";
import type { SegmentReport, SegmentSpec } from "../protocol/types";
import { rgbToHex, segmentHueSatToRgb } from "../color/hsv";

/** 一个光区的区间（闭区间）。 */
export interface ZoneRange {
  /** 槽位号 0-7（协议字段，界面显示为「光区 N」= 槽位+1）。 */
  segId: number;
  start: number;
  end: number;
}

/** 区间校验结果。 */
export interface RangeResult {
  ok: boolean;
  start: number;
  end: number;
  message: string;
}

/**
 * 校验单个区间。
 *
 * `ledCount` 是该灯组真实灯珠数（`State.stripCounts[stripId]`），
 * 不是 strip 0 的复制——多灯组设备的每组长度各不相同。
 */
export function checkRange(start: number, end: number, ledCount: number): RangeResult {
  const invalid = (message: string): RangeResult => ({ ok: false, start: -1, end: -1, message });
  if (!Number.isInteger(ledCount) || ledCount < 1) {
    return invalid("灯组灯珠数量未知，请先连接");
  }
  if (!Number.isInteger(start) || !Number.isInteger(end)) {
    return invalid("起止必须是整数");
  }
  if (start < 0 || end < 0) {
    return invalid("起止不能是负数");
  }
  if (start > end) {
    return invalid(`起点 ${start} 不能大于终点 ${end}`);
  }
  const limit = Math.min(ledCount, MAX_LEDS) - 1;
  if (end > limit) {
    return invalid(`终点 ${end} 超出范围（0-${limit}）`);
  }
  return { ok: true, start, end, message: "" };
}

/** 两个闭区间是否相交。 */
export function rangesOverlap(a: { start: number; end: number }, b: { start: number; end: number }): boolean {
  return !(a.end < b.start || b.end < a.start);
}

/**
 * 找出与给定区间冲突的其它光区（`ignoreSegId` 是正在编辑的那个，不与自己冲突）。
 *
 * 只比区间，不比灯效参数：设备只按区间判重叠。
 */
export function findConflict(
  range: { start: number; end: number },
  zones: readonly ZoneRange[],
  ignoreSegId = -1,
): ZoneRange | null {
  for (const zone of zones) {
    if (zone.segId === ignoreSegId) {
      continue;
    }
    if (rangesOverlap(range, zone)) {
      return zone;
    }
  }
  return null;
}

/** 全量校验：区间合法 + 不与他人重叠。 */
export function validateZone(
  segId: number,
  start: number,
  end: number,
  zones: readonly ZoneRange[],
  ledCount: number,
): RangeResult {
  const range = checkRange(start, end, ledCount);
  if (!range.ok) {
    return range;
  }
  const conflict = findConflict(range, zones, segId);
  if (conflict !== null) {
    return {
      ok: false,
      start: -1,
      end: -1,
      message: `与光区 ${conflict.segId + 1}（${conflict.start}-${conflict.end}）重叠，同一灯组的光区不能重叠`,
    };
  }
  return range;
}

/** 光区数量上限（协议：每灯组 8 个槽位）。 */
export function canAddZone(zones: readonly ZoneRange[]): boolean {
  return zones.length < MAX_SEGMENTS;
}

/** 下一个空闲槽位；已满返回 -1。 */
export function nextFreeSegId(zones: readonly ZoneRange[]): number {
  for (let id = 0; id < MAX_SEGMENTS; id += 1) {
    if (!zones.some((zone) => zone.segId === id)) {
      return id;
    }
  }
  return -1;
}

/**
 * 把 `0 .. ledCount-1` 按份数均分（余数给前面的块，避免最后一块特别短）。
 *
 * 用于「平均切 2/3/4 段」快捷按钮。`parts` 超出灯珠数时按灯珠数截断。
 */
export function splitEvenly(ledCount: number, parts: number): Array<{ start: number; end: number }> {
  const count = Math.max(0, Math.min(ledCount, MAX_LEDS));
  const n = Math.max(1, Math.min(Math.floor(parts), count));
  if (count === 0 || n === 0) {
    return [];
  }
  const base = Math.floor(count / n);
  const remainder = count % n;
  const out: Array<{ start: number; end: number }> = [];
  let cursor = 0;
  for (let i = 0; i < n; i += 1) {
    const size = base + (i < remainder ? 1 : 0);
    out.push({ start: cursor, end: cursor + size - 1 });
    cursor += size;
  }
  return out;
}

/** 常用切分：整条 / 前半 / 后半。 */
export type SplitPreset = "whole" | "firstHalf" | "secondHalf";

export function splitPreset(preset: SplitPreset, ledCount: number): { start: number; end: number } {
  const last = Math.max(0, Math.min(ledCount, MAX_LEDS) - 1);
  if (preset === "whole") {
    return { start: 0, end: last };
  }
  const half = Math.floor((last + 1) / 2);
  if (preset === "firstHalf") {
    return { start: 0, end: Math.max(0, half - 1) };
  }
  return { start: Math.min(half, last), end: last };
}

/** 灯珠条上的一格。 */
export interface ZoneCell {
  /** 灯珠下标。 */
  index: number;
  /** 归属的光区槽位；-1 表示未被任何光区覆盖（熄灭）。 */
  ownerSegId: number;
  /** 归属光区的展示色；无归属为空串。 */
  hex: string;
  /** 正在编辑的那一格（高亮描边）。 */
  editing: boolean;
  /** 与草稿区间冲突（标红）。 */
  conflict: boolean;
}

/**
 * 逐灯珠生成归属视图。
 *
 * `draft` 是正在编辑的区间（可能非法 → 传 null）：它优先于已有光区，
 * 使「正在划的这段」永远看得见；与已有光区相交的部分标 conflict。
 */
export function buildZoneCells(
  ledCount: number,
  zones: readonly ZoneRange[],
  colors: ReadonlyMap<number, string>,
  draft: { start: number; end: number } | null,
  ignoreSegId = -1,
): ZoneCell[] {
  const count = Math.max(0, Math.min(ledCount, MAX_LEDS));
  const cells: ZoneCell[] = [];
  for (let index = 0; index < count; index += 1) {
    let ownerSegId = -1;
    for (const zone of zones) {
      if (zone.segId === ignoreSegId) {
        continue;
      }
      if (index >= zone.start && index <= zone.end) {
        ownerSegId = zone.segId;
        break;
      }
    }
    const inDraft = draft !== null && index >= draft.start && index <= draft.end;
    cells.push({
      index,
      ownerSegId: inDraft ? ignoreSegId : ownerSegId,
      hex: inDraft ? (colors.get(ignoreSegId) ?? "") : (colors.get(ownerSegId) ?? ""),
      editing: inDraft,
      conflict: inDraft && ownerSegId >= 0,
    });
  }
  return cells;
}

/** 从设备读回的光区 → 区间列表（按槽位排序）。 */
export function zonesFromReports(reports: readonly SegmentReport[]): ZoneRange[] {
  return reports
    .map((report) => ({ segId: report.segId, start: report.start, end: report.end }))
    .sort((a, b) => a.segId - b.segId);
}

/** 光区的展示色（layer0 的色相/饱和度）。 */
export function zoneColorMap(reports: readonly SegmentReport[]): Map<number, string> {
  const map = new Map<number, string>();
  for (const report of reports) {
    map.set(report.segId, rgbToHex(segmentHueSatToRgb(report.layer0.hue, report.layer0.sat)));
  }
  return map;
}

/** 未被任何光区覆盖的灯珠数（即熄灭的灯珠）。 */
export function uncoveredCount(ledCount: number, zones: readonly ZoneRange[]): number {
  const count = Math.max(0, Math.min(ledCount, MAX_LEDS));
  let covered = 0;
  for (let index = 0; index < count; index += 1) {
    if (zones.some((zone) => index >= zone.start && index <= zone.end)) {
      covered += 1;
    }
  }
  return count - covered;
}

/** 光区摘要文案：「2 个光区 · 4 颗熄灭」。 */
export function zonesSummary(ledCount: number, zones: readonly ZoneRange[]): string {
  if (zones.length === 0) {
    return "还没有光区";
  }
  const gap = uncoveredCount(ledCount, zones);
  return gap > 0 ? `${zones.length} 个光区 · ${gap} 颗熄灭` : `${zones.length} 个光区 · 整组覆盖`;
}

/** 从一个 spec 取区间（便于把设备读回的 spec 塞进布局逻辑）。 */
export function rangeOfSpec(spec: Pick<SegmentSpec, "segId" | "start" | "end">): ZoneRange {
  return { segId: spec.segId, start: spec.start, end: spec.end };
}
