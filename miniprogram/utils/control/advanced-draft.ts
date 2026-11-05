/**
 * 进阶档的本地草稿（#65 时间轴 + #66 分区轴）。
 *
 * ## 为什么要有这一层
 *
 * 进阶档同时有两条轴：时间（步骤）与空间（分区）。两条轴共享同一份数据：
 * **每个步骤 × 每个灯组各有一片分区**。这份形状协议里已经有了（`ScriptDraft`
 * 的 4 套方案 × 8 步骤 × 若干分区），所以不再新造一套，只补「按当前灯组取
 * 切片」的派生与写入。
 *
 * 三条不变量：
 *
 *  1. **写入只替换「当前步骤 × 当前灯组」那一片**（`replaceStepZones`），其它
 *     灯组、其它步骤一字不动——多灯组设备上编辑第 1 组不能清掉第 2 组；
 *  2. **时间轴的缩略色带与分区轴来自同一份草稿**，不会出现「轴上三段、缩略
 *     色带两段」的两套真相；
 *  3. 步骤时长在草稿里是**字符串**（`ScriptStageDraft.durationInput`，与
 *     #67 写入路径同形），界面上的人话「1 秒」由 `timeline.ts` 换算。
 *
 * 纯函数、不碰 wx / BLE。
 */

import type { SegmentReport, SegmentSpec } from "../protocol/types";
import { replaceStepZones, zonesOfStep } from "./plan-editor";
import { clampScriptId, createScriptDraft, parseStageDuration, type ScriptDraft } from "./script-view";
import { zonesFromReports } from "./zone-editor";
import { axisColorMap } from "./zone-axis";
import {
  clampDuration,
  DEFAULT_STEP_COUNT,
  DEFAULT_STEP_MS,
  MAX_STEPS,
  type TimelineStep,
} from "./timeline";

/** 4 个方案槽位各一份进阶草稿（与 `createScriptDrafts` 同构，只用 2 个步骤起步）。 */
export function createAdvancedDrafts(): ScriptDraft[] {
  const drafts: ScriptDraft[] = [];
  for (let scriptId = 0; scriptId < 4; scriptId += 1) {
    const base = createScriptDraft(scriptId);
    drafts.push({ ...base, stages: base.stages.slice(0, DEFAULT_STEP_COUNT) });
  }
  return drafts;
}

/** 取某个槽位的草稿（越界钳到最后一套，与 `clampScriptId` 一致）。 */
export function advancedDraftOf(drafts: readonly ScriptDraft[], planId: number): ScriptDraft {
  return drafts[clampScriptId(planId)] ?? createAdvancedDrafts()[0];
}

/** 草稿里的步骤数。 */
export function advancedStepCount(draft: ScriptDraft): number {
  return draft.stages.length;
}

/** 一个步骤的时长（已钳位，界面只认这个）。 */
export function stageDurationMs(stage: { durationInput: string } | undefined): number {
  if (stage === undefined) {
    return DEFAULT_STEP_MS;
  }
  const parsed = parseStageDuration(stage.durationInput);
  return clampDuration(parsed.ok ? parsed.value : DEFAULT_STEP_MS);
}

/**
 * 草稿 → 时间轴视图（`layoutBlocks` 的输入）。
 *
 * 每个块的缩略色带只画**当前灯组**的分区：正在编辑别的组时，时间轴上显示
 * 的也应该是那一条灯组的样子。
 */
export function timelineStepsOf(draft: ScriptDraft, stripId: number): TimelineStep[] {
  return draft.stages.map((stage) => {
    const zones = zonesOfStep(stage, stripId);
    const colors = axisColorMap(zones);
    return {
      durationMs: stageDurationMs(stage),
      zones: zones.map((zone) => ({
        start: zone.start,
        end: zone.end,
        hex: colors.get(zone.segId) ?? "",
      })),
    };
  });
}

/** 某一步里当前灯组的分区（按槽位排序）。 */
export function stepZonesOf(draft: ScriptDraft, stepIndex: number, stripId: number): SegmentSpec[] {
  const stage = draft.stages[stepIndex];
  return stage === undefined ? [] : zonesOfStep(stage, stripId);
}

/**
 * 写入某一步里当前灯组的分区（**只替换这一片**）。
 *
 * 步骤下标非法时原样返回（引用不变，页面据此不刷新）。
 */
export function writeStepZones(
  draft: ScriptDraft,
  stepIndex: number,
  stripId: number,
  zones: readonly SegmentSpec[],
): ScriptDraft {
  if (stepIndex < 0 || stepIndex >= draft.stages.length) {
    return draft;
  }
  return replaceStepZones(draft, stepIndex, stripId, zones);
}

/**
 * 用设备读回的当前灯组分区填进某一步（仅当该步这一组还是空的）。
 *
 * 用于「刚进进阶档时，让用户从灯控现在的样子开始改」，不会覆盖已有草稿。
 */
export function seedStepFromReports(
  draft: ScriptDraft,
  stepIndex: number,
  stripId: number,
  reports: readonly SegmentReport[],
): ScriptDraft {
  if (stepZonesOf(draft, stepIndex, stripId).length > 0) {
    return draft;
  }
  const zones = zonesFromReports(reports.filter((report) => report.stripId === stripId));
  if (zones.length === 0) {
    return draft;
  }
  return writeStepZones(draft, stepIndex, stripId, zones);
}

/**
 * 改某一步的时长（钳到 0.5–30 秒；下标非法 / 无变化时返回原对象）。
 */
export function setStageDurationMs(
  draft: ScriptDraft,
  stepIndex: number,
  durationMs: number,
): ScriptDraft {
  const stage = draft.stages[stepIndex];
  if (stage === undefined) {
    return draft;
  }
  const next = clampDuration(durationMs);
  if (next === stageDurationMs(stage)) {
    return draft;
  }
  const stages = draft.stages.map((item, index) =>
    index === stepIndex ? { ...item, durationInput: String(next) } : item,
  );
  return { ...draft, stages };
}

/** 加一个步骤（默认 1 秒、没有分区）；到 8 个返回原对象（引用不变）。 */
export function addStepStage(draft: ScriptDraft, durationMs: number = DEFAULT_STEP_MS): ScriptDraft {
  if (draft.stages.length >= MAX_STEPS) {
    return draft;
  }
  /*
   * #133：新步骤**继承上一步的画面**，而不是留成空的。
   *
   * 空步骤下发到设备就是一个零分区的阶段——轮到它时整组黑一帧再回来。
   * 用户点的是「加一步」，看到的是「灯闪灭」。继承上一段的复制品，
   * 加完先是一片没变化的画面，用户再去改它。
   *
   * 整份方案还没有任何内容时，新步骤仍然是空的（没有可继承的东西）。
   */
  /* 往前找最近一个**有内容**的步骤，而不是只看紧邻的那一个：
   * 上一步本身可能就是空的（用户先加了两步还没画），继承空步骤没有意义。 */
  let source: ScriptDraft["stages"][number] | undefined;
  for (let i = draft.stages.length - 1; i >= 0; i -= 1) {
    if (draft.stages[i].segments.length > 0) {
      source = draft.stages[i];
      break;
    }
  }
  const inherited = source === undefined ? [] : source.segments.map((segment) => ({ ...segment }));
  return {
    ...draft,
    stages: [
      ...draft.stages,
      { durationInput: String(clampDuration(durationMs)), segments: inherited },
    ],
  };
}

/** 删一个步骤（至少留一个）；越界 / 只剩一个时返回原对象。 */
export function removeStepStage(draft: ScriptDraft, stepIndex: number): ScriptDraft {
  if (draft.stages.length <= 1 || stepIndex < 0 || stepIndex >= draft.stages.length) {
    return draft;
  }
  return {
    ...draft,
    stages: draft.stages.filter((_, index) => index !== stepIndex),
  };
}

/**
 * 把 `from` 挪到 `to`（拖动重排）。
 *
 * 越界与自身移动是无操作、**返回同一个对象**——页面靠引用相等判断「没挪」。
 */
export function moveStepStage(draft: ScriptDraft, from: number, to: number): ScriptDraft {
  const count = draft.stages.length;
  if (!Number.isInteger(from) || !Number.isInteger(to) || from === to) {
    return draft;
  }
  if (from < 0 || to < 0 || from >= count || to >= count) {
    return draft;
  }
  const stages = draft.stages.slice();
  const [moved] = stages.splice(from, 1);
  stages.splice(to, 0, moved);
  return { ...draft, stages };
}

/** 步骤数上限（8），界面据此禁用「+ 加步骤」。 */
export function canAddStepStage(draft: ScriptDraft): boolean {
  return draft.stages.length < MAX_STEPS;
}
