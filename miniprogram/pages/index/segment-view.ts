/**
 * 分段编辑器的纯逻辑（#25）：区间输入校验、槽位分配、重叠预检、行视图派生。
 *
 * 无 wx.* / 无 BLE，可在 vitest 里直接测。
 *
 * 两条所有权边界：
 *  - **设备是权威**：这里的「重叠预检」只是给用户即时反馈；真正的拒绝是设备
 *    回 InvalidParam（protocol §10.3）。
 *  - **槽位是设备概念**：segId 0-7 对应设备的 8 个槽位。UI 新建段时占用一个
 *    空闲槽位；空闲与否以设备最近一次 QueryStrip 的 seg_mask 为准。
 */

import { MAX_SEGMENTS } from "../../utils/protocol/constants";
import type { RGB, SegmentReport, SegmentTarget } from "../../utils/protocol/types";
import { rgbToHex } from "../../utils/color/hsv";

/** 列表里的一行：设备权威的段 + 展示用字段。 */
export interface SegmentRow {
  segId: number;
  start: number;
  end: number;
  /** 展示色。静态段由 hue+sat 算出；动画段不参与 #25 的颜色编辑。 */
  hex: string;
  /** 区间文本，如 "0-15"。 */
  rangeText: string;
  selected: boolean;
  /** 是否是可编辑的静态段（#25 只有静态）。 */
  editable: boolean;
}

export interface RangeInputResult {
  ok: boolean;
  start: number;
  end: number;
  message: string;
}

/**
 * 解析「起点 / 终点」两个输入框。
 *
 * 只做本端能判定的检查（整数、非负、start ≤ end、end < ledCount）。
 * 重叠与槽位冲突交给 overlapsExisting 与设备。
 */
export function parseRangeInput(
  startText: string,
  endText: string,
  ledCount: number,
): RangeInputResult {
  const invalid = (message: string): RangeInputResult => ({
    ok: false,
    start: 0,
    end: 0,
    message,
  });
  if (ledCount < 1) {
    return invalid("设备灯珠数量未知，请先连接");
  }
  const startRaw = String(startText).trim();
  const endRaw = String(endText).trim();
  /* 空串必须显式拒绝：Number("") === 0 会被误判成合法起点。 */
  if (startRaw === "" || endRaw === "") {
    return invalid("起点与终点都要填");
  }
  const start = Number(startRaw);
  const end = Number(endRaw);
  if (!Number.isInteger(start) || !Number.isInteger(end)) {
    return invalid("起点与终点必须都是整数");
  }
  if (start < 0 || end < 0) {
    return invalid("起点与终点不能是负数");
  }
  if (start > end) {
    return invalid(`起点 ${start} 不能大于终点 ${end}`);
  }
  if (end >= ledCount) {
    return invalid(`终点 ${end} 超出灯珠范围（0-${ledCount - 1}）`);
  }
  return { ok: true, start, end, message: "" };
}

/** 找第一个未被占用的槽位；全部占满返回 -1。 */
export function firstFreeSegId(usedIds: readonly number[]): number {
  for (let id = 0; id < MAX_SEGMENTS; id += 1) {
    if (!usedIds.includes(id)) {
      return id;
    }
  }
  return -1;
}

/**
 * 与已存在的段是否重叠（闭区间）。
 *
 * `ignoreSegId` 用于「改某段自己的区间」：与自己的旧区间不算冲突。
 * 返回冲突段的行文本（用于提示），不冲突返回 null。
 */
export function overlapError(
  start: number,
  end: number,
  rows: readonly Pick<SegmentRow, "segId" | "start" | "end">[],
  ignoreSegId = -1,
): string | null {
  for (const row of rows) {
    if (row.segId === ignoreSegId) {
      continue;
    }
    if (!(end < row.start || row.end < start)) {
      return `与段 ${row.segId}（${row.start}-${row.end}）重叠`;
    }
  }
  return null;
}

/**
 * 把设备的 SegmentReport 列表转成行视图。
 *
 * 颜色只对静态段有意义（hue+sat → RGB）；动画段由 #30/#31 交付，这里给
 * 一个中性灰并要求固件支持后才能编辑颜色。
 */
export function buildSegmentRows(
  reports: readonly SegmentReport[],
  selectedSegId: number | null,
  hueSatToRgb: (hue: number, sat: number) => RGB,
): SegmentRow[] {
  return reports
    .slice()
    .sort((a, b) => a.segId - b.segId)
    .map((report) => {
      const editable = report.type === 0x00;
      const rgb = hueSatToRgb(report.hue, report.sat);
      return {
        segId: report.segId,
        start: report.start,
        end: report.end,
        hex: editable ? rgbToHex(rgb) : "#3A3A44",
        rangeText: `${report.start}-${report.end}`,
        selected: selectedSegId === report.segId,
        editable,
      };
    });
}

/** 从行视图里摘出目标段（颜色控件要写的位置）。 */
export function targetOf(row: SegmentRow, stripId = 0): SegmentTarget {
  return { stripId, segId: row.segId, start: row.start, end: row.end };
}

/** 某灯带的活动段数（用于「最多 8 段」提示与 State.seg_count 对照）。 */
export function activeCount(rows: readonly SegmentRow[]): number {
  return rows.length;
}
