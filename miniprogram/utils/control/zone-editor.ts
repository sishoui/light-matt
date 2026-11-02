/**
 * 光区编辑器的纯逻辑（#55）：灯珠格、拖动划选、快捷切分、增删改。
 *
 * ## 为什么单独一层
 *
 * 自定义档的可视化编辑有三处容易出错、且只有模拟器能看出来的地方：
 *  1. **拖动划选的锚点与方向**：从右往左拖要得到 `start <= end`；
 *  2. **重叠预检**：正在划的那段与已有光区相交时必须立刻标红且**一帧不发**；
 *  3. **切分按钮**：整条 / 前半 / 后半 / 均分 2–4 必须产出互不重叠的区间。
 *
 * 它们在页面里只能靠「看着对不对」验证；抽成纯函数后可以把边界写死。
 *
 * ## 依赖方向
 *
 * 区间规则（校验 / 重叠 / 切分 / 槽位）**只有** `effect-layout` 一份实现，
 * 本模块只做「编辑态」：把一次手势 / 一次按钮点击翻译成新的光区列表。
 * 不碰 wx / BLE。
 */

import { BLEND, LAYER_LEVEL_MAX, MAX_SEGMENTS, NO_EFFECT, SEGMENT_TYPE } from "../protocol/constants";
import type { EffectLayer, SegmentReport, SegmentSpec } from "../protocol/types";
import {
  canAddZone,
  findConflict,
  nextFreeSegId,
  rangesOverlap,
  splitEvenly,
  splitPreset,
  type SplitPreset,
  type ZoneRange,
} from "./effect-layout";
import { buildZoneSpec, readZone, type ZoneView } from "./zone-model";

/** 拖动划选的锚点（按下时的灯珠下标）。 */
export interface DragState {
  /** 起点灯珠；`null` 表示没有正在进行的拖动。 */
  anchor: number | null;
  /** 当前指尖所在灯珠。 */
  cursor: number | null;
}

export const EMPTY_DRAG: DragState = { anchor: null, cursor: null };

/** 拖动 → 闭区间（自动交换方向）；没有拖动时返回 null。 */
export function dragRange(drag: DragState): { start: number; end: number } | null {
  if (drag.anchor === null || drag.cursor === null) {
    return null;
  }
  return {
    start: Math.min(drag.anchor, drag.cursor),
    end: Math.max(drag.anchor, drag.cursor),
  };
}

/**
 * 灯珠条上的第 index 格 → 灯珠下标。
 *
 * 用「按宽度比例换算」而不是读 `offsetX`：不同机型 750rpx 的实际像素宽不同，
 * 比例换算对任意宽度都成立，也不依赖 canvas。
 */
export function cellFromRatio(ratio: number, ledCount: number): number {
  const count = Math.max(0, Math.floor(ledCount));
  if (count === 0 || !Number.isFinite(ratio)) {
    return -1;
  }
  const clamped = Math.max(0, Math.min(0.9999, ratio));
  return Math.min(count - 1, Math.floor(clamped * count));
}

/**
 * 新光区的主效果默认值。
 *
 * 给一个高饱和暖色（用户一眼能看见「这里有灯」），而不是黑色——
 * 黑色在灯珠条上与「未覆盖」不可区分。
 */
export function defaultZoneLayer(seedHue = 7281): EffectLayer {
  return {
    type: SEGMENT_TYPE.STATIC,
    hue: seedHue,
    sat: 255,
    periodMs: 0,
    p5: 0,
    flags: 0,
    level: LAYER_LEVEL_MAX,
  };
}

/** 新光区的叠加方式：单层必须是覆盖（协议）。 */
export const DEFAULT_BLEND = BLEND.OVER;

/** 一帧都不发就已经能判定的非法原因（重叠 / 越界 / 满槽）。 */
export interface ZoneAddCheck {
  ok: boolean;
  message: string;
}

/**
 * 能否把区间 `[start, end]` 作为一个新光区加进去。
 *
 * 这是**下发前**的本地预检：失败时页面只提示、不发任何帧。
 * 顺序按用户最容易理解的先后来：先查数量上限，再查重叠。
 */
export function checkZoneAdd(
  zones: readonly ZoneRange[],
  start: number,
  end: number,
): ZoneAddCheck {
  if (!canAddZone(zones)) {
    return { ok: false, message: `每组最多 ${MAX_SEGMENTS} 个光区，请先删掉一个` };
  }
  if (start > end) {
    return { ok: false, message: `起点 ${start} 不能大于终点 ${end}` };
  }
  const conflict = findConflict({ start, end }, zones);
  if (conflict !== null) {
    return {
      ok: false,
      message: `与光区 ${conflict.segId + 1}（${conflict.start}–${conflict.end}）重叠，同一灯组的光区不能重叠`,
    };
  }
  return { ok: true, message: "" };
}

/**
 * 用一次切分替换该组的全部光区（快捷按钮）。
 *
 * 语义是**重建**：点「平均切 3 段」得到的就是 3 个等长光区，不做增量合并
 * （增量会让用户无法预测结果）。返回的 spec 全部是单层、覆盖叠加。
 */
export function zonesFromSplit(
  ranges: ReadonlyArray<{ start: number; end: number }>,
  stripId: number,
  existing: readonly ZoneView[] = [],
): SegmentSpec[] {
  return ranges.map((range, index) => {
    /* 尽量保留原槽位上的灯效（切分后位置对应得上时用户不必重设颜色）。 */
    const reused = existing[index];
    const layer0 = reused === undefined ? defaultZoneLayer() : { ...reused.layer0 };
    const layer1 = reused === undefined ? null : reused.hasOverlay ? { ...reused.layer1 } : null;
    return buildZoneSpec({
      stripId,
      segId: index,
      start: range.start,
      end: range.end,
      blend: reused === undefined ? DEFAULT_BLEND : reused.blend,
      layer0,
      layer1,
    });
  });
}

/** 整条 / 前半 / 后半（单个光区）。 */
export function splitWhole(
  preset: SplitPreset,
  ledCount: number,
  stripId: number,
  existing: readonly ZoneView[] = [],
): SegmentSpec[] {
  return zonesFromSplit([splitPreset(preset, ledCount)], stripId, existing);
}

/** 平均切 2–4 段。 */
export function splitParts(
  parts: number,
  ledCount: number,
  stripId: number,
  existing: readonly ZoneView[] = [],
): SegmentSpec[] {
  return zonesFromSplit(splitEvenly(ledCount, parts), stripId, existing);
}

/**
 * 在已有光区里新增一个（占用最小空闲槽位）。
 *
 * 返回 null 表示不能加（数量满 / 重叠 / 非法），调用方据此提示**并不下发**。
 */
export function addZone(
  zones: readonly SegmentSpec[],
  stripId: number,
  start: number,
  end: number,
): SegmentSpec | null {
  const ranges = zones.map((zone) => ({ segId: zone.segId, start: zone.start, end: zone.end }));
  if (!checkZoneAdd(ranges, start, end).ok) {
    return null;
  }
  const segId = nextFreeSegId(ranges);
  if (segId < 0) {
    return null;
  }
  return buildZoneSpec({
    stripId,
    segId,
    start,
    end,
    blend: DEFAULT_BLEND,
    layer0: defaultZoneLayer(),
    layer1: null,
  });
}

/** 改某个光区的区间（其余光区一字不动）。非法 / 重叠返回 null。 */
export function resizeZone(
  zones: readonly SegmentSpec[],
  segId: number,
  start: number,
  end: number,
): SegmentSpec | null {
  const target = zones.find((zone) => zone.segId === segId);
  if (target === undefined) {
    return null;
  }
  const others = zones
    .filter((zone) => zone.segId !== segId)
    .map((zone) => ({ segId: zone.segId, start: zone.start, end: zone.end }));
  if (start > end || findConflict({ start, end }, others) !== null) {
    return null;
  }
  if (start === target.start && end === target.end) {
    return null;
  }
  return { ...target, start, end, layer0: { ...target.layer0 }, layer1: { ...target.layer1 } };
}

/** 删除一个光区；不存在时返回原数组（引用不变，页面据此不刷新）。 */
export function removeZone(zones: readonly SegmentSpec[], segId: number): SegmentSpec[] {
  const next = zones.filter((zone) => zone.segId !== segId);
  return next.length === zones.length ? (zones as SegmentSpec[]) : next;
}

/** 改某个光区的主效果（只动 layer0，叠加层与叠加方式保留）。 */
export function setZoneLayer0(
  zones: readonly SegmentSpec[],
  segId: number,
  layer0: EffectLayer,
): SegmentSpec[] {
  return zones.map((zone) =>
    zone.segId === segId ? { ...zone, layer0: { ...layer0 }, layer1: { ...zone.layer1 } } : zone,
  );
}

/** 改某个光区的叠加效果 + 叠加方式（空叠加层强制覆盖，交给 zone-model 归一）。 */
export function setZoneOverlay(
  zones: readonly SegmentSpec[],
  segId: number,
  layer1: EffectLayer | null,
  blend: number,
): SegmentSpec[] {
  return zones.map((zone) => {
    if (zone.segId !== segId) {
      return zone;
    }
    return buildZoneSpec({
      stripId: zone.stripId,
      segId: zone.segId,
      start: zone.start,
      end: zone.end,
      blend: blend as SegmentSpec["blend"],
      layer0: zone.layer0,
      layer1,
    });
  });
}

/** 设备报告 → 编辑用的光区列表（叠加方式已归一）。 */
export function zonesFromReports(reports: readonly SegmentReport[]): SegmentSpec[] {
  return reports
    .slice()
    .sort((a, b) => a.segId - b.segId)
    .map((report) => buildZoneSpec(readZone(report)));
}

/** 这组光区是否有任何未覆盖灯珠（灯珠条上会显示「熄灭」段）。 */
export function hasGap(ledCount: number, zones: readonly SegmentSpec[]): boolean {
  const count = Math.max(0, Math.floor(ledCount));
  for (let index = 0; index < count; index += 1) {
    if (!zones.some((zone) => index >= zone.start && index <= zone.end)) {
      return true;
    }
  }
  return false;
}

/**
 * 拖动中的区间与已有光区是否冲突（**不下发**的判据）。
 *
 * 与 `checkZoneAdd` 分开是为了区分两件事：数量满了也非法，但拖动时用户
 * 最关心的是「我这里能不能放」。
 */
export function draftConflicts(
  zones: readonly ZoneRange[],
  range: { start: number; end: number } | null,
): boolean {
  if (range === null) {
    return false;
  }
  return zones.some((zone) => rangesOverlap(range, zone));
}

/** 空层（叠加效果的「关闭」态）。空层的 level 必须为 0（§7.1 第 3 步）。 */
export function emptyOverlayLayer(): EffectLayer {
  return { type: NO_EFFECT, hue: 0, sat: 0, periodMs: 0, p5: 0, flags: 0, level: 0 };
}
