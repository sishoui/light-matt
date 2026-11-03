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
  EFFECT_TYPE_NAMES,
  MAX_SCRIPTS,
  MAX_STAGES,
  MAX_STAGE_MS,
  PLAYBACK,
} from "../protocol/constants";
import type { ScriptConfig, ScriptSegment, ScriptStageConfig } from "./script-plan";
import { estimateScriptsTotalBytes } from "./script-plan";
import type { ScriptSummary } from "../protocol/commands";

/** 草稿里的一个阶段（与 ScriptStageConfig 同构，但允许空时段用于编辑）。 */
export interface ScriptStageDraft {
  /** 编辑器里的时长输入原样保存成字符串，避免输入中间态被抹掉。 */
  durationInput: string;
  /**
   * 段的草稿形状：扁平（层 0）或两层 `SegmentSpec` 都允许。
   * 槽位唯一性按 `(stripId, segId)` 计——每条灯带各 8 个槽位。
   */
  segments: ScriptSegment[];
}

/** 一套剧本草稿。 */
export interface ScriptDraft {
  scriptId: number;
  stages: ScriptStageDraft[];
}

/** 一阶段 × 一条灯带的段数摘要（时间轴上的跨带预览）。 */
export interface StageStripSummary {
  stripId: number;
  /** 「带 1」。 */
  label: string;
  count: number;
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
  /** 跨带预览：「带 1×3 · 带 3×1」；无段时为「无段」。 */
  stripText: string;
  /** 该阶段覆盖的灯带号（升序，去重）。 */
  strips: number[];
  /** 是否当前编辑阶段。 */
  active: boolean;
  /** 是否首 / 末阶段（重排按钮据此禁用）。 */
  first: boolean;
  last: boolean;
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

/**
 * 4 个槽位各一份独立草稿（#45 验收：「4 套剧本各自独立编辑、下发、激活，
 * 互不覆盖」）。
 *
 * 为什么必须分开：早期实现只有一个草稿对象，切 id 只是改 `scriptId` 字段，
 * 于是编辑第 2 套会覆盖第 1 套的本地内容——用户切回去看到的是别人的阶段。
 * 下标 = scriptId，数组长度恒为 MAX_SCRIPTS。
 */
export function createScriptDrafts(): ScriptDraft[] {
  const drafts: ScriptDraft[] = [];
  for (let scriptId = 0; scriptId < MAX_SCRIPTS; scriptId += 1) {
    drafts.push(createScriptDraft(scriptId));
  }
  return drafts;
}

/** 取某个槽位的草稿；非法 id 钳到 0（页面不会给非法 id，这里只兜底）。 */
export function scriptDraftOf(drafts: ScriptDraft[], scriptId: number): ScriptDraft {
  return drafts[clampScriptId(scriptId)] ?? createScriptDraft(scriptId);
}

/**
 * 把编辑后的草稿写回槽位数组（按 `draft.scriptId` 定位）。
 *
 * 返回新数组：页面的 setData 依赖引用变化，原地改会让视图漏刷新。
 */
export function replaceScriptDraft(drafts: ScriptDraft[], draft: ScriptDraft): ScriptDraft[] {
  const next = drafts.slice();
  next[draft.scriptId] = draft;
  return next;
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

/**
 * 段类型的中文名（UI 用；未知类型原样给 hex）。
 *
 * 名字表来自 `protocol/constants.EFFECT_TYPE_NAMES`——曾经这里自己 switch 四种
 * 类型，#74 加爆闪 / 心跳 / 熄灭后没跟上，摘要会把新灯效显示成 `0x04`。
 */
export function typeName(type: number): string {
  return EFFECT_TYPE_NAMES[type] ?? `0x${type.toString(16).padStart(2, "0")}`;
}

/** 一个段的单行摘要：「2 段 · 静态 [0-9]、呼吸 [10-29]」。 */
export function stageSegmentText(segments: ScriptSegment[]): string {
  if (segments.length === 0) {
    return "无段（该阶段灯带全灭）";
  }
  const parts = [...segments]
    .sort((a, b) => a.stripId - b.stripId || a.segId - b.segId)
    .map((seg) => `${typeName(segmentLayerType(seg))} [${seg.start}-${seg.end}]`);
  return `${segments.length} 段 · ${parts.join("、")}`;
}

/**
 * 段的层 0 类型（两层段取 layer0，扁平段取 type）。
 *
 * UI 摘要只描述「这段主要是什么灯效」，层 1 的存在由 `segmentHasSecondLayer`
 * 单独标注，避免摘要里塞两层类型名后读不出去。
 */
function segmentLayerType(segment: ScriptSegment): number {
  return "layer0" in segment ? segment.layer0.type : segment.type;
}

/** 段是否叠了第二层（时间轴上标「+叠」）。 */
export function segmentHasSecondLayer(segment: ScriptSegment): boolean {
  return "layer0" in segment && segment.layer1.type !== 0xff;
}

/**
 * 一阶段的跨带摘要（§「跨带预览」）：只给每带段数，不逐颗预览像素。
 *
 * 按灯带号升序，只列有段的灯带。
 */
export function stageStripSummary(segments: ScriptSegment[]): StageStripSummary[] {
  const counts = new Map<number, number>();
  for (const seg of segments) {
    counts.set(seg.stripId, (counts.get(seg.stripId) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([stripId, count]) => ({ stripId, label: `带 ${stripId + 1}`, count }));
}

/** 跨带预览的一行文本：「带 1×3 · 带 3×1」；无段时「无段」。 */
export function stageStripText(segments: ScriptSegment[]): string {
  const summary = stageStripSummary(segments);
  if (summary.length === 0) {
    return "无段";
  }
  return summary.map((item) => `${item.label}×${item.count}`).join(" · ");
}

/** 生成阶段行视图。activeStage 是当前正在编辑的阶段下标。 */
export function buildScriptStageRows(
  draft: ScriptDraft,
  activeStage: number,
): ScriptStageRow[] {
  const last = draft.stages.length - 1;
  return draft.stages.map((stage, index) => ({
    index,
    title: `阶段 ${index + 1}`,
    duration: stage.durationInput,
    segmentText: stageSegmentText(stage.segments),
    stripText: stageStripText(stage.segments),
    strips: stageStripSummary(stage.segments).map((item) => item.stripId),
    active: index === activeStage,
    first: index === 0,
    last: index === last,
    invalid: !parseStageDuration(stage.durationInput).ok,
  }));
}

/**
 * 追加 / 替换同一槽位的段。
 *
 * 键是 `(stripId, segId)`：v3 的槽位是**每条灯带各自 8 个**，所以带 0 段 3
 * 与带 1 段 3 是两条不同的段。早期实现只按 segId 去重，跨带剧本里后一条会
 * 静默覆盖前一条。返回新数组（不改入参，便于 setData 比较）。
 */
export function upsertStageSegment(
  segments: ScriptSegment[],
  segment: ScriptSegment,
): ScriptSegment[] {
  const next = segments.filter(
    (item) => !(item.stripId === segment.stripId && item.segId === segment.segId),
  );
  next.push(segment);
  next.sort((a, b) => a.stripId - b.stripId || a.segId - b.segId);
  return next;
}

/** 删掉一个 `(strip, seg)` 槽位的段；不存在时返回原数组。 */
export function removeStageSegment(
  segments: ScriptSegment[],
  stripId: number,
  segId: number,
): ScriptSegment[] {
  const next = segments.filter(
    (item) => !(item.stripId === stripId && item.segId === segId),
  );
  return next.length === segments.length ? segments : next;
}

/** 某个阶段某条灯带已占用的槽位（给新段挑空闲 seg_id 用）。 */
export function usedSegIds(segments: ScriptSegment[], stripId: number): number[] {
  return segments.filter((seg) => seg.stripId === stripId).map((seg) => seg.segId);
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
  segments: ScriptSegment[],
): ScriptDraft {
  if (index < 0 || index >= draft.stages.length) {
    return draft;
  }
  const stages = draft.stages.map((stage, i) => (i === index ? { ...stage, segments } : stage));
  return { ...draft, stages };
}

/**
 * 把阶段移动到 `delta`（-1 上移 / +1 下移）。
 *
 * 重排改的是**设备上的播放顺序**，所以草稿数组顺序就是真相；越界或非法
 * delta 返回原对象（页面据此不刷新）。
 */
export function moveStage(draft: ScriptDraft, index: number, delta: number): ScriptDraft {
  const target = index + delta;
  if (
    !Number.isInteger(delta) ||
    delta === 0 ||
    index < 0 ||
    index >= draft.stages.length ||
    target < 0 ||
    target >= draft.stages.length
  ) {
    return draft;
  }
  const stages = [...draft.stages];
  const [moved] = stages.splice(index, 1);
  stages.splice(target, 0, moved);
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
    /* 深拷贝层对象：草稿随后还会被编辑，下发命令流不能跟着变。 */
    segments: stage.segments.map(copySegment),
  }));
  return {
    scriptId: draft.scriptId,
    stripCount: Math.max(1, stripCount),
    stages,
  };
}

/** 段草稿的深拷贝（两层段复制 layer0/layer1，扁平段逐字段复制）。 */
function copySegment(segment: ScriptSegment): ScriptSegment {
  if ("layer0" in segment) {
    return {
      stripId: segment.stripId,
      segId: segment.segId,
      start: segment.start,
      end: segment.end,
      blend: segment.blend,
      layer0: { ...segment.layer0 },
      layer1: { ...segment.layer1 },
    };
  }
  return { ...segment };
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

/* ---------------- 设备摘要读回（v3 只有摘要） ---------------- */

/**
 * 一套剧本在设备上的摘要视图（QueryScript 0x85 的 4 字节）。
 *
 * **v3 没有「读回整份剧本」的命令**：QueryScript 只回 `script_id,
 * stage_count, flags, active`，拿不到阶段时长、段区间与灯效参数。所以：
 *  - stageCount 是设备权威（重连后据此知道「这套在设备上有几个阶段」）；
 *  - 本地草稿与设备内容不保证一致，**编辑后必须重新下发**才会改到设备；
 *  - 界面必须把这个限制说清楚，不能让用户以为「点一下就读回来了」。
 */
export interface ScriptSummaryRow {
  scriptId: number;
  /** 「剧本 1」。 */
  title: string;
  /** 设备上已提交（stage_count ≥ 1）。 */
  committed: boolean;
  /** 是否当前激活剧本（0x85 的 active 位）。 */
  active: boolean;
  /** 是否循环（0x85 的 flags bit0，只对激活剧本有意义）。 */
  loop: boolean;
  /** 摘要文本：「已提交 · 4 阶段 · 循环」/「未提交」。 */
  text: string;
}

/** 一套剧本的摘要 → 行视图。 */
export function scriptSummaryRow(summary: ScriptSummary): ScriptSummaryRow {
  const committed = summary.stageCount >= 1;
  /* 同一条 0x85 只报激活剧本的 loop（未激活时 bit0 = 0，不代表「不循环」）。 */
  const loop = committed && summary.active && (summary.flags & 0x01) !== 0;
  const parts: string[] = [];
  parts.push(committed ? `已提交 · ${summary.stageCount} 阶段` : "未提交");
  if (committed) {
    parts.push(summary.active ? "激活中" : "未激活");
    if (loop) {
      parts.push("循环");
    }
  }
  return {
    scriptId: summary.scriptId,
    title: `剧本 ${summary.scriptId + 1}`,
    committed,
    active: summary.active,
    loop,
    text: parts.join(" · "),
  };
}

/**
 * 摘要读回的固定说明：v3 只能读摘要，不能读整份内容。
 *
 * 页面把它放在摘要列表下面，作为「为什么本地草稿与设备可能不一致」的解释。
 */
export const SUMMARY_ONLY_NOTE =
  "只能从设备读回摘要（是否已提交 / 阶段数 / 是否激活）；阶段时长与段内容无法读回，编辑后需重新下发才会生效。";

/** 摘要读回失败时的一行提示（保留原文，不吞原因）。 */
export function summaryReadErrorText(reason: string): string {
  return `读取设备剧本摘要失败：${reason}`;
}

/**
 * 容量预检要比较的「下发后设备上会有的那几套」。
 *
 * 为什么需要这一层：§10.4 的 16KB 是**4 个槽位共享**的，单套最大只有
 * 9835 字节，所以「超限」只可能来自多套合计。但设备不让我们读回其它槽位的
 * 内容（只有 4 字节摘要），App 唯一能用的替代是**本地草稿**——App 是剧本的
 * 唯一写入方，所以「设备上已提交的槽位 ≈ 本机最后一次下发的草稿」。
 *
 * 只把 `committedIds` 里的槽位算进去：未提交槽位在设备上只占 1 字节，
 * 若把用户编了一半、从没下发的草稿也算进来，会在完全合法的情况下误拦。
 */
export function scriptCapacitySlots(
  drafts: readonly ScriptDraft[],
  committedIds: readonly number[],
  stripCount: number,
): ScriptConfig[] {
  const wanted = new Set(committedIds);
  const slots: ScriptConfig[] = [];
  for (const draft of drafts) {
    if (!wanted.has(draft.scriptId)) {
      continue;
    }
    slots.push(draftToScriptConfig(draft, stripCount));
  }
  return slots;
}

/**
 * 当前草稿 + 设备上其它已提交槽位的合计预估。
 *
 * 页面用它同时驱动「预估字节」展示与下发前的拦截；两者必须同源，否则会
 * 出现「显示超了但按钮能点」或反之。
 */
export function draftCapacityBytes(
  drafts: readonly ScriptDraft[],
  committedIds: readonly number[],
  scriptId: number,
  stripCount: number,
): number {
  const slots = scriptCapacitySlots(drafts, committedIds, stripCount);
  /* 当前草稿一定参与——即使设备还没提交它（下发后就是它占位）。 */
  if (!slots.some((slot) => slot.scriptId === scriptId)) {
    slots.push(draftToScriptConfig(scriptDraftOf([...drafts], scriptId), stripCount));
  }
  return estimateScriptsTotalBytes(slots);
}
