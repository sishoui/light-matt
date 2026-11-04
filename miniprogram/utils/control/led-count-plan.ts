/**
 * 灯珠数滑块与「缩小不静默丢编排」的纯逻辑（#79）。
 *
 * ## 为什么单独一层
 *
 * 设备信息页与灯组详情页各有一条 1–100 的滑块，语义相同：拖动只改本地值，
 * 松手才下发（SetLedCount 要重建 led_strip 句柄，ACK 上限 3000ms，不能逐帧发）。
 * 缩小灯珠数时还要先本地检查越界的分区 / 草稿，确认后才截断。
 *
 * 这些规则**两条页面都要用**，放进页面就会各写一份、迟早漂移；而且它们只有
 * 纯数据，可以直接单测（部分越界 / 完全越界 / 无越界 / 改大）。
 *
 * ## 区间语义
 *
 * 分区是**闭区间** `[start, end]`，合法灯珠下标是 `0..newLedCount-1`。所以：
 *
 *  - `end < newLedCount` → 完全在范围内，**原样保留**（改大时全部走这支）；
 *  - `start >= newLedCount` → 整段落在新长度之外，**删除**；
 *  - `start < newLedCount <= end` → 部分越界，**截到新末尾**（`end = newLedCount-1`）。
 *
 * 固件在数量变更时会 `prune` 掉所有 `end >= new_count` 的段（不自动缩短，见
 * protocol-v4 §7.2），所以部分越界的段在设备侧也会被整段删掉；页面确认后要把
 * 截断后的段重新写回去，才算「截到新末尾」。
 *
 * 纯函数、不碰 wx / BLE，可在 vitest 里直接测。
 */

import type { ScriptDraft } from "./script-view";
import type { ScriptSegment } from "./script-plan";
import type { SegmentSpec } from "../protocol/types";
import { MAX_LEDS, MIN_LEDS } from "../protocol/constants";

/** 把任意滑块值钳成合法的灯珠数（整数、1..MAX_LEDS）。 */
export function clampLedCount(value: number): number {
  if (!Number.isFinite(value)) {
    return MIN_LEDS;
  }
  const rounded = Math.round(value);
  return Math.max(MIN_LEDS, Math.min(MAX_LEDS, rounded));
}

/** 各灯组灯珠数之和（只读总数；非有限 / 非正数按 0 计）。 */
export function sumStripLeds(counts: readonly number[]): number {
  let total = 0;
  for (const count of counts) {
    if (Number.isFinite(count) && count > 0) {
      total += Math.floor(count);
    }
  }
  return total;
}

/** 一条分区在缩小到 `newLedCount` 之后的去向。 */
export interface ShrinkPlan {
  /** 完全在范围内，原样保留。 */
  kept: SegmentSpec[];
  /** 部分越界，`end` 已截到新末尾（新对象，输入不被修改）。 */
  clamped: SegmentSpec[];
  /** 整段落在新长度之外，应删除。 */
  dropped: SegmentSpec[];
  /** 受影响的分区数（= clamped + dropped，即「有 n 个分区超出新长度」）。 */
  affected: number;
}

/**
 * 计算缩小灯珠数时每条分区的去向（**纯函数**，不改入参）。
 *
 * 改大时所有 `end < newLedCount`，全部进 `kept`，`affected` 为 0——
 * 「改大不会改动任何已有分区」由此保证。
 */
export function planShrink(zones: readonly SegmentSpec[], newLedCount: number): ShrinkPlan {
  const last = clampLedCount(newLedCount) - 1;
  const kept: SegmentSpec[] = [];
  const clamped: SegmentSpec[] = [];
  const dropped: SegmentSpec[] = [];
  for (const zone of zones) {
    if (zone.start > last) {
      dropped.push(zone);
    } else if (zone.end > last) {
      clamped.push({ ...zone, end: last });
    } else {
      kept.push(zone);
    }
  }
  return { kept, clamped, dropped, affected: clamped.length + dropped.length };
}

/** 只有区间字段的东西（`SegmentSpec` / `ScriptSegment` 都满足）。 */
interface RangeLike {
  segId: number;
  start: number;
  end: number;
}

/**
 * 统计「会超出新长度」的分区数（给确认文案的数字）。
 *
 * 口径：
 *  - **设备分区**各自计数；
 *  - **草稿分区**按各槽位（方案）分别计数——同一段定义出现在两套方案里是
 *    两份编排，不该合并成一个；
 *  - 但**与设备分区完全同一定义**的草稿段不再重复计：草稿往往是从设备播种
 *    出来的同一份东西（`seedStepFromReports`），相加会把一个分区算成两个，
 *    确认文案就会吓人。
 *
 * 去重键是 `segId:start:end`（不含槽位号：同一段在方案里可以占同一个槽位）。
 */
export function affectedZoneCount(
  device: readonly RangeLike[],
  drafts: readonly (readonly RangeLike[])[],
  newLedCount: number,
): number {
  const last = clampLedCount(newLedCount) - 1;
  const deviceKeys = new Set<string>();
  for (const zone of device) {
    if (zone.end > last) {
      deviceKeys.add(zoneKey(zone));
    }
  }
  let count = deviceKeys.size;
  for (const list of drafts) {
    const seen = new Set<string>();
    for (const zone of list) {
      if (zone.end <= last) {
        continue;
      }
      const key = zoneKey(zone);
      /* 与设备那一份是同一个分区（播种来的副本）：不重复计。 */
      if (deviceKeys.has(key) || seen.has(key)) {
        continue;
      }
      seen.add(key);
      count += 1;
    }
  }
  return count;
}

/** 分区在去重口径里的身份（区间 + 槽位；不含灯组，调用方已按灯组过滤）。 */
function zoneKey(zone: RangeLike): string {
  return `${zone.segId}:${zone.start}:${zone.end}`;
}

/** 二次确认的文案：带数量、带新长度，说明截断规则。 */
export function shrinkConfirmText(affected: number, newLedCount: number): string {
  return `有 ${affected} 个分区超出新长度（${clampLedCount(newLedCount)} 颗），确认后越界部分会截到新末尾，完全越界的会被删除。`;
}

/** 一份草稿缩小后的结果。 */
export interface DraftShrink {
  /** 清理后的草稿；没有变化时**返回原对象**（引用相等 = 什么都不用存）。 */
  draft: ScriptDraft;
  /** 这条灯组受影响的分区数。 */
  affected: number;
  /** 是否真的改了（有删除或截断）。 */
  changed: boolean;
}

/**
 * 把一份（设备级）草稿里**某条灯组**的分区按新长度清理。
 *
 * 只动 `stripId` 那一片：其它灯组、其它步骤的分区一字不改（#75 的设备级草稿
 * 里各组的切片共存）。其它灯组自己的长度是它们自己的事。
 */
export function shrinkDraft(
  draft: ScriptDraft,
  stripId: number,
  newLedCount: number,
): DraftShrink {
  const last = clampLedCount(newLedCount) - 1;
  let affected = 0;
  let changed = false;
  const stages = draft.stages.map((stage) => {
    let stageChanged = false;
    const segments: ScriptSegment[] = [];
    for (const segment of stage.segments) {
      if (segment.stripId !== stripId) {
        segments.push(segment);
        continue;
      }
      if (segment.start > last) {
        /* 整段越界：直接丢。 */
        affected += 1;
        stageChanged = true;
        continue;
      }
      if (segment.end > last) {
        /* 部分越界：只改终点，层与叠加方式原样保留。 */
        affected += 1;
        stageChanged = true;
        segments.push({ ...segment, end: last });
        continue;
      }
      segments.push(segment);
    }
    if (!stageChanged) {
      return stage;
    }
    changed = true;
    return { ...stage, segments };
  });
  return {
    draft: changed ? { ...draft, stages } : draft,
    affected,
    changed,
  };
}

/** 一组草稿（4 个槽位）的清理结果。 */
export interface DraftsShrink {
  drafts: ScriptDraft[];
  /** 真正被改过的槽位下标（落盘用）。 */
  changedSlots: number[];
  /** 受影响分区总数（去重口径；见 `affectedZoneCount`）。 */
  affected: number;
}

/**
 * 清理一整组（4 槽位）草稿并给出落盘清单。
 *
 * 返回的 `drafts` 与入参同长；没变的槽位保留原对象。
 */
export function shrinkDrafts(
  drafts: readonly ScriptDraft[],
  stripId: number,
  newLedCount: number,
): DraftsShrink {
  const next: ScriptDraft[] = [];
  const changedSlots: number[] = [];
  for (let slot = 0; slot < drafts.length; slot += 1) {
    const draft = drafts[slot];
    const result = shrinkDraft(draft, stripId, newLedCount);
    next.push(result.draft);
    if (result.changed) {
      changedSlots.push(slot);
    }
  }
  return {
    drafts: next,
    changedSlots,
    affected: affectedZoneCount(
      [],
      drafts.map((draft) =>
        draft.stages.flatMap((stage) => stage.segments.filter((item) => item.stripId === stripId)),
      ),
      newLedCount,
    ),
  };}

/**
 * 草稿里某条灯组的全部分区，**按方案槽位分组**（确认文案的计数输入）。
 *
 * 分组而不是拉平：`affectedZoneCount` 只在同一槽位内去重，跨槽位的同一段
 * 定义是两份编排，要分别计。
 */
export function draftZoneRanges(
  drafts: readonly ScriptDraft[],
  stripId: number,
): Array<Array<{ segId: number; start: number; end: number }>> {
  return drafts.map((draft) => {
    const out: Array<{ segId: number; start: number; end: number }> = [];
    for (const stage of draft.stages) {
      for (const segment of stage.segments) {
        if (segment.stripId === stripId) {
          out.push({ segId: segment.segId, start: segment.start, end: segment.end });
        }
      }
    }
    return out;
  });
}
