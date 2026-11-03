/**
 * 光区布局（自定义档的「多分段」逻辑，纯函数）。
 *
 * 一个灯组是一条连续灯珠，用户把它切成若干**光区**，每个光区有自己的
 * 主效果 / 叠加效果。协议要求**同一灯组内的光区不能重叠**（设备会回
 * InvalidParam），所以重叠必须在本地就拦住——一帧都不发。
 *
 * ## 单一真相（#53）
 *
 * 「区间」这一维的实现只在本模块存在一份。上层模块（`segment-editor`、
 * `segment-view`、将来的自定义档）一律**委托**到这里，不再各写一套：
 *
 *  - 区间校验：[`parseRangeText`] / [`checkRange`]
 *  - 重叠判定：[`rangesOverlap`] / [`findConflict`] / [`findConflictInList`]
 *  - 槽位分配：[`firstFreeSlot`] / [`nextFreeSegId`]
 *  - 逐灯珠归属：[`scanLedOwnership`]（`buildZoneCells` / `buildLedCells` 的共用核心）
 *
 * 依赖方向是**单向**的：本模块不 import 任何上层控制模块；灯效参数校验
 * 留在 `segment-editor`，两者互不反向依赖。
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
    return invalid("起点与终点必须都是整数");
  }
  if (start < 0 || end < 0) {
    return invalid("起点与终点不能是负数");
  }
  if (start > end) {
    return invalid(`起点 ${start} 不能大于终点 ${end}`);
  }
  const limit = Math.min(ledCount, MAX_LEDS) - 1;
  if (end > limit) {
    return invalid(`终点 ${end} 超出灯珠范围（0-${limit}）`);
  }
  return { ok: true, start, end, message: "" };
}

/**
 * 校验两个输入框的原文（先把文本解析成整数，再走 `checkRange`）。
 *
 * 空串必须**显式拒绝**：`Number("") === 0` 会把「没填」误判成合法起点。
 * 失败时 `start` / `end` 为 -1（不给调用方「半成品」区间）。
 */
export function parseRangeText(startText: string, endText: string, ledCount: number): RangeResult {
  if (!Number.isInteger(ledCount) || ledCount < 1) {
    return { ok: false, start: -1, end: -1, message: "灯组灯珠数量未知，请先连接" };
  }
  const startRaw = String(startText).trim();
  const endRaw = String(endText).trim();
  if (startRaw === "" || endRaw === "") {
    return { ok: false, start: -1, end: -1, message: "起点与终点都要填" };
  }
  const start = Number(startRaw);
  const end = Number(endRaw);
  if (!Number.isInteger(start) || !Number.isInteger(end)) {
    return { ok: false, start: -1, end: -1, message: "起点与终点必须都是整数" };
  }
  return checkRange(start, end, ledCount);
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

/**
 * 跨灯组列表的重叠判定：先按 `stripId` 过滤，再比区间。
 *
 * 段区间是「每带独立」的——编辑第 3 条带时，第 1、2 条带的段与它毫无关系，
 * 算进来会误拒。返回带 `stripId` 的那一条原文（调用方要用它的号码写提示）。
 */
export function findStripConflict<T extends { stripId: number; segId: number; start: number; end: number }>(
  range: { start: number; end: number },
  items: readonly T[],
  stripId: number,
  ignoreSegId = -1,
): T | null {
  for (const item of items) {
    if (item.stripId !== stripId) {
      continue;
    }
    if (item.segId === ignoreSegId) {
      continue;
    }
    if (rangesOverlap(range, item)) {
      return item;
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

/**
 * 已占用槽位列表 → 第一个空闲槽位；占满返回 -1。
 *
 * 槽位是**设备概念**（每灯组 8 个），新建光区时占用最小空闲槽位，
 * 绝不静默覆盖别人的段。
 */
export function firstFreeSlot(usedSegIds: readonly number[]): number {
  for (let id = 0; id < MAX_SEGMENTS; id += 1) {
    if (!usedSegIds.includes(id)) {
      return id;
    }
  }
  return -1;
}

/** 下一个空闲槽位；已满返回 -1。 */
export function nextFreeSegId(zones: readonly ZoneRange[]): number {
  return firstFreeSlot(zones.map((zone) => zone.segId));
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

/**
 * 逐灯珠归属的**共用核心**（`buildZoneCells` / `buildLedCells` 都走它）。
 *
 * 输入的 `items` 必须已经按灯组过滤好：这里只认槽位与区间，不认 `stripId`
 * ——「哪一条带」是调用方（页面）显式给出的，本模块不替它猜。
 *
 * `draft` 是**正在划的那一段**（可能非法 → 传 null）。它优先于已有归属，
 * 这样「正在划的这段」永远看得见；与已有光区相交的部分标 `conflict`
 * （提交前就标出来，不发一帧必定被设备拒绝的配置）。
 */
export interface OwnershipItem {
  segId: number;
  start: number;
  end: number;
}

export interface OwnershipScan {
  /** 逐颗灯珠的归属槽位；-1 = 未覆盖。 */
  owners: number[];
  /** 逐颗灯珠是否落在草稿区间内。 */
  inDraft: boolean[];
  /** 逐颗灯珠是否「草稿 ∩ 已有归属」= 冲突。 */
  conflicts: boolean[];
}

export function scanLedOwnership(
  ledCount: number,
  items: readonly OwnershipItem[],
  draft: { start: number; end: number } | null,
  ignoreSegId = -1,
): OwnershipScan {
  const count = Math.max(0, Math.min(ledCount, MAX_LEDS));
  const owners: number[] = [];
  const inDraft: boolean[] = [];
  const conflicts: boolean[] = [];
  const draftValid = draft !== null && draft.end >= draft.start;
  for (let index = 0; index < count; index += 1) {
    let ownerSegId = -1;
    for (const item of items) {
      if (item.segId === ignoreSegId) {
        continue;
      }
      if (index >= item.start && index <= item.end) {
        ownerSegId = item.segId;
        break;
      }
    }
    const edited = draftValid && index >= draft!.start && index <= draft!.end;
    owners.push(ownerSegId);
    inDraft.push(edited);
    conflicts.push(edited && ownerSegId >= 0);
  }
  return { owners, inDraft, conflicts };
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
  const scan = scanLedOwnership(ledCount, zones, draft, ignoreSegId);
  return scan.owners.map((ownerSegId, index) => {
    const editing = scan.inDraft[index];
    return {
      index,
      ownerSegId: editing ? ignoreSegId : ownerSegId,
      hex: colors.get(editing ? ignoreSegId : ownerSegId) ?? "",
      editing,
      conflict: scan.conflicts[index],
    };
  });
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
