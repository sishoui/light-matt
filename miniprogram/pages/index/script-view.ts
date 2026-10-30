/**
 * 剧本编辑器（#32）的纯逻辑与 UI 派生。
 *
 * 为什么单独一层：剧本是一个 4 阶段 × N 段的本地草稿，页面只应持有状态与
 * 转发事件；「怎么增删段、怎么生成行视图、怎么把草稿变成 ScriptConfig」
 * 全是可测的纯函数。
 *
 * 与设备的分工：
 *  - 草稿在本地（用户正在编，设备不知道）；
 *  - 点「下发」才展开成命令流（utils/control/script-plan.ts）；
 *  - 设备是权威：连上后 State 的 script_id / stage_index / playback_state
 *    决定面板上显示的播放状态，不用本地猜测覆盖。
 */

import {
  MAX_SCRIPTS,
  MAX_STAGES,
  MAX_STAGE_MS,
  PLAYBACK,
  SEGMENT_TYPE,
} from "../../utils/protocol/constants";
import type { ScriptConfig, ScriptStageConfig } from "../../utils/control/script-plan";
import type { SegmentConfig } from "../../utils/protocol/types";

/** 草稿里的一个阶段（与 ScriptStageConfig 同构，但允许空时段用于编辑）。 */
export interface ScriptStageDraft {
  /** 编辑器里的时长输入原样保存成字符串，避免输入中间态被抹掉。 */
  durationInput: string;
  segments: SegmentConfig[];
}

/** 一套剧本草稿。 */
export interface ScriptDraft {
  scriptId: number;
  stages: ScriptStageDraft[];
}

/** 阶段行的视图。 */
export interface ScriptStageRow {
  index: number;
  /** 行标题，如「阶段 1」。 */
  title: string;
  /** 时长展示 / 输入值。 */
  duration: string;
  /** 段数 + 类型摘要。 */
  segmentText: string;
  /** 是否当前编辑阶段。 */
  active: boolean;
  /** 该阶段有非法字段（时长为空 / 0 / 越界）。 */
  invalid: boolean;
}

/** 新建草稿：默认 4 个阶段（票面要求的最小可用形状），各 1000ms、无段。 */
export function createScriptDraft(scriptId = 0): ScriptDraft {
  const stages: ScriptStageDraft[] = [];
  for (let i = 0; i < 4; i += 1) {
    stages.push({ durationInput: "1000", segments: [] });
  }
  return { scriptId: clampScriptId(scriptId), stages };
}

export function clampScriptId(scriptId: number): number {
  if (!Number.isInteger(scriptId) || scriptId < 0) {
    return 0;
  }
  return scriptId >= MAX_SCRIPTS ? MAX_SCRIPTS - 1 : scriptId;
}

/** 解析时长输入：空串 / 非整数 / 0 / 越界都判非法（设备会拒 0）。 */
export function parseStageDuration(text: string): { ok: boolean; value: number } {
  const raw = String(text).trim();
  if (raw === "") {
    return { ok: false, value: 0 };
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > MAX_STAGE_MS) {
    return { ok: false, value: 0 };
  }
  return { ok: true, value };
}

/** 段类型的中文名（UI 用；未知类型原样给 hex）。 */
export function typeName(type: number): string {
  switch (type) {
    case SEGMENT_TYPE.STATIC:
      return "静态";
    case SEGMENT_TYPE.BREATHING:
      return "呼吸";
    case SEGMENT_TYPE.RAINBOW:
      return "彩虹";
    case SEGMENT_TYPE.COMET:
      return "流光";
    default:
      return `0x${type.toString(16).padStart(2, "0")}`;
  }
}

/** 一个段的单行摘要：「2 段 · 静态 [0-9]、呼吸 [10-29]」。 */
export function stageSegmentText(segments: SegmentConfig[]): string {
  if (segments.length === 0) {
    return "无段（该阶段灯带全灭）";
  }
  const parts = [...segments]
    .sort((a, b) => a.stripId - b.stripId || a.segId - b.segId)
    .map((seg) => `${typeName(seg.type)} [${seg.start}-${seg.end}]`);
  return `${segments.length} 段 · ${parts.join("、")}`;
}

/** 生成阶段行视图。activeStage 是当前正在编辑的阶段下标。 */
export function buildScriptStageRows(
  draft: ScriptDraft,
  activeStage: number,
): ScriptStageRow[] {
  return draft.stages.map((stage, index) => ({
    index,
    title: `阶段 ${index + 1}`,
    duration: stage.durationInput,
    segmentText: stageSegmentText(stage.segments),
    active: index === activeStage,
    invalid: !parseStageDuration(stage.durationInput).ok,
  }));
}

/** 追加 / 替换同一槽位的段。返回新数组（不改入参，便于 setData 比较）。 */
export function upsertStageSegment(
  segments: SegmentConfig[],
  segment: SegmentConfig,
): SegmentConfig[] {
  const next = segments.filter((item) => item.segId !== segment.segId);
  next.push(segment);
  next.sort((a, b) => a.stripId - b.stripId || a.segId - b.segId);
  return next;
}

/** 删掉一个槽位的段；不存在时返回原数组。 */
export function removeStageSegment(
  segments: SegmentConfig[],
  segId: number,
): SegmentConfig[] {
  const next = segments.filter((item) => item.segId !== segId);
  return next.length === segments.length ? segments : next;
}

/** 某个阶段已占用的槽位（用于给新段挑一个空闲 seg_id）。 */
export function usedSegIds(segments: SegmentConfig[]): number[] {
  return segments.map((seg) => seg.segId);
}

/** 增加一个阶段（上限 8）。返回新草稿；到上限时返回原对象。 */
export function addStage(draft: ScriptDraft): ScriptDraft {
  if (draft.stages.length >= MAX_STAGES) {
    return draft;
  }
  return {
    ...draft,
    stages: [...draft.stages, { durationInput: "1000", segments: [] }],
  };
}

/** 删除一个阶段（至少保留 1 个）。 */
export function removeStage(draft: ScriptDraft, index: number): ScriptDraft {
  if (draft.stages.length <= 1 || index < 0 || index >= draft.stages.length) {
    return draft;
  }
  return { ...draft, stages: draft.stages.filter((_, i) => i !== index) };
}

/** 改某阶段的时长输入。 */
export function setStageDuration(
  draft: ScriptDraft,
  index: number,
  text: string,
): ScriptDraft {
  if (index < 0 || index >= draft.stages.length) {
    return draft;
  }
  const stages = draft.stages.map((stage, i) =>
    i === index ? { ...stage, durationInput: text } : stage,
  );
  return { ...draft, stages };
}

/** 改某阶段的段列表。 */
export function setStageSegments(
  draft: ScriptDraft,
  index: number,
  segments: SegmentConfig[],
): ScriptDraft {
  if (index < 0 || index >= draft.stages.length) {
    return draft;
  }
  const stages = draft.stages.map((stage, i) => (i === index ? { ...stage, segments } : stage));
  return { ...draft, stages };
}

/**
 * 草稿 → ScriptConfig（下发的输入）。
 *
 * 时长非法时用 0，让 validateScript 给出具体原因（而不是在这里静默改成 1000：
 * 静默修正会让用户以为下发的是自己填的值）。
 */
export function draftToScriptConfig(draft: ScriptDraft, stripCount: number): ScriptConfig {
  const stages: ScriptStageConfig[] = draft.stages.map((stage) => ({
    durationMs: parseStageDuration(stage.durationInput).value,
    segments: stage.segments.map((seg) => ({ ...seg })),
  }));
  return {
    scriptId: draft.scriptId,
    stripCount: Math.max(1, stripCount),
    stages,
  };
}

/** 该草稿是否至少有一处非法时长（用于按钮禁用与提示）。 */
export function draftInvalidStageCount(draft: ScriptDraft): number {
  return draft.stages.filter((stage) => !parseStageDuration(stage.durationInput).ok).length;
}

/** 播放状态展示（State 字节 12 是权威）。 */
export interface PlaybackView {
  /** 0 停止 / 1 播放 / 2 暂停。 */
  state: number;
  /** 「停止」/「播放中」/「已暂停」。 */
  text: string;
  /** 「阶段 3 / 4」；无剧本时为「无激活剧本」。 */
  stageText: string;
  /** 是否循环（State.flags bit0）。 */
  loop: boolean;
  /** 有激活剧本（State.flags bit1）。 */
  active: boolean;
}

export function playbackView(
  playbackState: number,
  stageIndex: number,
  flags: number,
  scriptId: number,
  totalStages: number,
): PlaybackView {
  const active = scriptId !== 0xff && (flags & 0x02) !== 0;
  let text = "停止";
  if (playbackState === PLAYBACK.PLAYING) {
    text = "播放中";
  } else if (playbackState === PLAYBACK.PAUSED) {
    text = "已暂停";
  }
  const stageText = active
    ? `阶段 ${Math.min(stageIndex + 1, Math.max(totalStages, 1))} / ${Math.max(totalStages, 1)}`
    : "无激活剧本";
  return { state: playbackState, text, stageText, loop: (flags & 0x01) !== 0, active };
}

/** 下发进度文案：「下发中 4/15 · 阶段 2 时长 1500ms」。 */
export function downloadProgressText(label: string, done: number, total: number): string {
  return `下发中 ${done}/${total} · ${label}`;
}
