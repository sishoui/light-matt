/**
 * #99 进阶档时间轴的视图派生：步骤名 + 气泡卡片 + 循环三档。
 *
 * ## 为什么步骤名要单独一层
 *
 * 草稿里没起名时显示「第 N 步」，但**不把默认名写回草稿**：一旦写进去，
 * 插步骤、删步骤、换方案都会让名字与序号错位（用户看到的「第 2 步」其实
 * 是原来的第 3 步）。所以名字只在展示时派生。
 *
 * ## 气泡卡片
 *
 * 选中一个步骤后，它下方出现一张气泡（箭头对准选中块正中）。卡片内容：
 * 步骤名 → 副标题（时长 · 分区数）→ 时长滑轴 → 分区列表。
 */

import type { ScriptDraft, ScriptStageDraft } from "./script-view";
import { LOOP_MODE, clampLoopMode, loopLabel, type LoopMode } from "./advanced-layers";

/** 第 N 步的默认名（从 1 编号）。 */
export function defaultStepName(index: number): string {
  return `第 ${index + 1} 步`;
}

/** 步骤的展示名：用户起的名字优先，否则「第 N 步」。 */
export function stepNameOf(stage: ScriptStageDraft | undefined, index: number): string {
  const name = (stage?.name ?? "").trim();
  return name.length > 0 ? name : defaultStepName(index);
}

/** 方案草稿的循环模式（缺省 / 坏值都按「不循环」）。 */
export function draftLoop(draft: ScriptDraft | undefined): LoopMode {
  return clampLoopMode(draft?.loop ?? LOOP_MODE.NONE);
}

/** 改循环模式（返回新草稿，不可变）。 */
export function withDraftLoop(draft: ScriptDraft, mode: LoopMode): ScriptDraft {
  return { ...draft, loop: clampLoopMode(mode) };
}

/** 下一步的时长（秒，0.5 步进，0.5–30）。 */
export function stepSecondsText(ms: number): string {
  const seconds = Math.max(0, ms) / 1000;
  /* 0.5 的整数倍：整数秒不带小数点。 */
  return Number.isInteger(seconds) ? `${seconds} 秒` : `${seconds.toFixed(1)} 秒`;
}

/** 气泡副标题：「1.5 秒 · 2 个分区」。 */
export function bubbleSubtitle(durationMs: number, zoneCount: number): string {
  return `${stepSecondsText(durationMs)} · ${zoneCount} 个分区`;
}

/** 时间轴标题区的副标题（#99：「3 个步骤 · 共 4.5 秒」）。 */
export function timelineSubtitle(stepCount: number, totalMs: number): string {
  if (stepCount === 0) {
    return "还没有步骤";
  }
  return `${stepCount} 个步骤 · 共 ${stepSecondsText(totalMs)}`;
}

/** 循环选项视图（每一档 + 选中态）。 */
export interface LoopChoiceView {
  value: LoopMode;
  label: string;
  selected: boolean;
}

/** 构建循环三档的选择视图。 */
export function buildLoopChoices(
  selected: LoopMode,
  opts: { thirdDisabled?: boolean } = {},
): Array<LoopChoiceView & { disabled: boolean; hint: string }> {
  const mode = clampLoopMode(selected);
  const options: Array<{ value: LoopMode; label: string; hint: string }> = [
    { value: LOOP_MODE.NONE, label: "不循环", hint: "跑完停在最后一帧" },
    { value: LOOP_MODE.ALL, label: "全部循环", hint: "跑完回到第一步" },
    { value: LOOP_MODE.LAST, label: "最后一步循环", hint: "前几步各播一次，最后一步原地重播" },
  ];
  return options.map((option) => ({
    ...option,
    selected: option.value === mode,
    disabled: option.value === LOOP_MODE.LAST && opts.thirdDisabled === true,
  }));
}

/** 循环设置的一行摘要（标题右侧用）。 */
export function loopSummary(mode: LoopMode): string {
  return loopLabel(mode);
}

/** 分区列表的一行（气泡卡片里）。 */
export interface BubbleZoneRow {
  segId: number;
  /** 颜色点。 */
  hex: string;
  /** 「0–19 颗」。 */
  rangeText: string;
  /** 效果摘要（「呼吸」「常亮 + 流星」）。 */
  effectText: string;
  /** 是否展开（这一行显示两层的编辑位置）。 */
  expanded: boolean;
}

/** 分区区间文案（用户视角从 0 编号，与灯珠弹窗一致）。 */
export function zoneRangeText(start: number, end: number): string {
  return `${start}–${end} 颗`;
}

/** 步骤气泡的完整视图。 */
export interface StepBubbleView {
  visible: boolean;
  /** 步骤名（可直接编辑）。 */
  name: string;
  /** 「1.5 秒 · 2 个分区」。 */
  subtitle: string;
  /** 时长滑块的值（秒）。 */
  seconds: number;
  /** 分区数。 */
  zoneCount: number;
  /** 分区列表。 */
  zones: BubbleZoneRow[];
  /** 箭头在选中块正中的百分比位置（0-100）。 */
  arrowPercent: number;
}

/**
 * 计算气泡箭头应指向的位置（选中块的中点在整行里的百分比）。
 *
 * `blocks` 是每块的「起点百分比 / 宽度百分比」，由时间轴布局给出。
 */
export function arrowPercentOf(
  blocks: ReadonlyArray<{ leftPercent: number; widthPercent: number }>,
  index: number,
): number {
  const block = blocks[index];
  if (block === undefined) {
    return 50;
  }
  return Math.max(0, Math.min(100, block.leftPercent + block.widthPercent / 2));
}

/** 空气泡（没有选中步骤时）。 */
export const EMPTY_BUBBLE: StepBubbleView = {
  visible: false,
  name: "",
  subtitle: "",
  seconds: 1,
  zoneCount: 0,
  zones: [],
  arrowPercent: 50,
};
