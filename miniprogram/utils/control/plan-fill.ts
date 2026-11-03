/**
 * #101 修跨灯组串扰：下发方案前补齐其它灯组的切片。
 *
 * ## 根因
 *
 * 方案是**设备级**的：一套方案覆盖设备上所有灯组，下发时按设备的灯组总数
 * 提交。而草稿里通常只有当前灯组的内容，其它灯组是空的 → 固件让那些灯组
 * 退回基准单色，看起来就是「改一条串到别的灯组」。
 *
 * ## 修法
 *
 * 下发前从设备读回其它灯组的现有分区，补进草稿，使整份方案里每个可见灯组
 * 都有内容。补齐失败（读回超时 / 设备未就绪）时**不要下发**——宁可这次不发
 * 并给出原因，也不能发一份会把别的灯组刷空的方案。
 *
 * ## 纯函数
 *
 * 这一层只做「把补进来的切片合进草稿」这一件事；读设备由页面负责。
 */

import type { ScriptDraft } from "./script-view";
import type { SegmentSpec } from "../protocol/types";
import { NO_EFFECT, SEGMENT_TYPE } from "../protocol/constants";

/** 一个灯组的现有分区（读自设备）。 */
export interface StripSlice {
  stripId: number;
  zones: readonly SegmentSpec[];
}

/**
 * 补齐结果。
 *
 * `filled` 是「哪些灯组原本是空的、这次补了内容」——用于反馈与单测。
 */
export interface FillResult {
  draft: ScriptDraft;
  filled: number[];
}

/**
 * 把其它灯组的切片补进草稿的**每个步骤**。
 *
 * 补法：如果一个步骤里某条**非当前**灯组没有任何分区，就把该灯组在当前
 * 步骤的内容补上。`fillBlank` 为 true 时，设备上也没有内容的灯组补一条
 * 「熄灭」段（输出恒黑 = 「不被方案接管」的等价表达，见 `EMPTY_STRIP_FALLBACK`）。
 *
 * `targetStripId` 是当前正在编辑的灯组：它**永远不被补齐**，用户在这一组上
 * 的编排必须逐字节保留。
 */
export function fillOtherStrips(input: {
  draft: ScriptDraft;
  targetStripId: number;
  /** 其它灯组在各步骤的现有切片（下标 = 步骤下标；缺的步骤按空处理）。 */
  slices: ReadonlyMap<number, ReadonlyArray<readonly SegmentSpec[]>>;
  /** 设备上也没有内容的灯组是否补一条熄灭（默认补）。 */
  fillBlank?: boolean;
  /** 设备灯珠数（按灯组取），用于给空白灯组造整段区间。 */
  ledCounts?: ReadonlyMap<number, number>;
}): FillResult {
  const { draft, targetStripId, slices } = input;
  const fillBlank = input.fillBlank !== false;
  const filled: number[] = [];

  const stages = draft.stages.map((stage, stageIndex) => {
    const segments = [...stage.segments];
    const has = new Set<number>();
    for (const segment of segments) {
      has.add(segment.stripId);
    }
    /* 按切片表里出现的灯组补齐（排序保证结果稳定）。 */
    for (const stripId of [...slices.keys()].sort((a, b) => a - b)) {
      if (stripId === targetStripId || has.has(stripId)) {
        continue;
      }
      const perStage = slices.get(stripId);
      const zones = perStage?.[stageIndex] ?? [];
      if (zones.length > 0) {
        for (const zone of zones) {
          segments.push({
            stripId,
            segId: zone.segId,
            start: zone.start,
            end: zone.end,
            blend: zone.blend,
            layer0: { ...zone.layer0 },
            layer1:
              zone.layer1 === undefined || zone.layer1 === null
                ? { type: NO_EFFECT, hue: 0, sat: 0, periodMs: 0, p5: 0, flags: 0, level: 0 }
                : { ...zone.layer1 },
          } as SegmentSpec);
        }
        if (!filled.includes(stripId)) {
          filled.push(stripId);
        }
      } else if (fillBlank) {
        /* 设备上这组也没有内容：补一条「熄灭」整段，语义是「这条灯组不被方案
         * 接管」而不是「被方案刷成单色」。熄灭输出恒黑，与「无段」在观感上
         * 一致，但它让灯组在方案里有一条明确的记录。 */
        const ledCount = Math.max(1, input.ledCounts?.get(stripId) ?? 0);
        if (ledCount > 0) {
          segments.push({
            stripId,
            segId: 0,
            start: 0,
            end: ledCount - 1,
            blend: 0,
            layer0: {
              type: SEGMENT_TYPE.OFF,
              hue: 0,
              sat: 0,
              periodMs: 0,
              p5: 0,
              flags: 0,
              level: 0,
            },
            layer1: { type: NO_EFFECT, hue: 0, sat: 0, periodMs: 0, p5: 0, flags: 0, level: 0 },
          } as SegmentSpec);
          if (!filled.includes(stripId)) {
            filled.push(stripId);
          }
        }
      }
    }
    return { ...stage, segments };
  });

  return { draft: { ...draft, stages }, filled: filled.sort((a, b) => a - b) };
}

/**
 * 补齐前置条件：其它灯组必须全部读回成功。
 *
 * 任一条读回失败 → 不下发（票面明确：宁可这次不发并给出原因）。返回缺失的
 * 灯组号，页面据此给出一行说明。
 */
export function missingSlices(
  stripIds: readonly number[],
  targetStripId: number,
  slices: ReadonlyMap<number, unknown>,
): number[] {
  return stripIds.filter((stripId) => stripId !== targetStripId && !slices.has(stripId));
}

/** 给用户的失败说明（读回失败时）。 */
export function missingSlicesText(missing: readonly number[]): string {
  if (missing.length === 0) {
    return "";
  }
  const names = missing.map((stripId) => `灯组 ${stripId + 1}`).join("、");
  return `没能读回${names}的现有分区，这次没有下发（否则会把它们刷掉）。请稍后再试。`;
}

/**
 * 「不被方案接管」的等价表达：整段熄灭。
 *
 * 协议要求每段的背景层必须是真实灯效，所以空内容只能写成熄灭类型。
 */
export const EMPTY_STRIP_FALLBACK = SEGMENT_TYPE.OFF;
