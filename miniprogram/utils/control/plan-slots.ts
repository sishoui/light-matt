/**
 * 灯组页「方案」的按需槽位（#83）。
 *
 * ## 为什么不再固定四套
 *
 * 设备上确实有 4 个方案编号（`script_id` 0-3），但用户并不需要一进来就看到
 * 四个空的坑：早期实现顶部只有一个按钮在 ①–④ 之间轮换，空槽标「空白」，
 * 既不能新建也不能删除，四个编号永远占着界面。
 *
 * 现在方案是**按需增长**的：
 *  - 进入页面只有一套（①）；没有内容时标「空白」；
 *  - 「+ 新建方案」取**当前未被使用的最小编号**，最多四套，全满时按钮禁用；
 *  - 每套都能删；删除**不重排编号**——删掉②就剩①③④，显示的是它们各自的
 *    编号，这样设备上的其它方案不会因为删一套而整体搬家；
 *  - 删掉的编号在下一次新建时被复用。
 *
 * 这一层只做**纯算术与视图派生**：页面持有事件与 I/O（删设备上的内容要走
 * `ClearScript`），这里不碰存储、不碰 BLE，可直接单测。
 */

import { DEFAULT_STEP_MS } from "./timeline";
import { planIsEmpty } from "./plan-editor";
import type { ScriptDraft } from "./script-view";

/** 设备能存几套方案（协议：`script_id` 0-3）。 */
export const MAX_PLANS = 4;

/** 圈码（界面上只出现这个，不出现内部编号）。 */
const CIRCLED = "①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳";

/**
 * 把任意输入折成合法的编号集合：去重、只留 0..MAX_PLANS-1、升序。
 *
 * 顺序很重要：方案 tab 按编号升序排，删掉②后 ①③④ 仍然从左到右。
 */
export function normalizePlanIds(ids: readonly number[]): number[] {
  const seen = new Set<number>();
  for (const id of ids) {
    if (!Number.isInteger(id) || id < 0 || id >= MAX_PLANS) {
      continue;
    }
    seen.add(id);
  }
  return [...seen].sort((a, b) => a - b);
}

/** 进入页面时的方案表：只有一套（①）。 */
export function initialPlanIds(): number[] {
  return [0];
}

/** 当前未被使用的最小方案编号；四套都在用时返回 null。 */
export function smallestFreePlanId(ids: readonly number[]): number | null {
  const used = new Set(normalizePlanIds(ids));
  for (let id = 0; id < MAX_PLANS; id += 1) {
    if (!used.has(id)) {
      return id;
    }
  }
  return null;
}

/** 四套都在用（「+ 新建方案」据此禁用）。 */
export function plansFull(ids: readonly number[]): boolean {
  return normalizePlanIds(ids).length >= MAX_PLANS;
}

/**
 * 新建一套：占用最小空闲编号，返回新表与被选中的编号。
 *
 * 满时返回 null（页面保持原样并给出「最多四套」的提示）。
 */
export function addPlan(ids: readonly number[]): { ids: number[]; id: number } | null {
  const current = normalizePlanIds(ids);
  const id = smallestFreePlanId(current);
  if (id === null) {
    return null;
  }
  return { ids: [...current, id].sort((a, b) => a - b), id };
}

/**
 * 删掉一套：**其它方案的编号原样保留**（不重排）。
 *
 * 删不存在的编号是无操作；返回新表（不是原地修改）。
 */
export function deletePlan(ids: readonly number[], id: number): number[] {
  return normalizePlanIds(ids).filter((item) => item !== id);
}

/**
 * 删掉某套之后应该选中哪一套。
 *
 *  - 删的不是当前方案：选中不变；
 *  - 删的是当前方案：优先选它的后一个（原来在右边的），没有就回退到前一个；
 *  - 全删光：null（页面据此补一套空白方案）。
 *
 * `before` 是删除**之前**的表；先算位置再删，否则「后一个」无从判断。
 */
export function selectionAfterDelete(
  before: readonly number[],
  deletedId: number,
  selectedId: number,
): number | null {
  if (deletedId !== selectedId) {
    return selectedId;
  }
  const current = normalizePlanIds(before);
  const index = current.indexOf(deletedId);
  if (index < 0) {
    return selectedId;
  }
  const remaining = current.filter((item) => item !== deletedId);
  if (remaining.length === 0) {
    return null;
  }
  /* 后一个占住原下标的位置（删除后它左移了一位），没有就取最后一个。 */
  return remaining[Math.min(index, remaining.length - 1)];
}

/** 编号 → 圈码（①…）；越界给普通数字，不抛错。 */
export function planNumberLabel(id: number): string {
  if (!Number.isFinite(id)) {
    return "①";
  }
  const index = Math.max(0, Math.floor(id));
  return CIRCLED[index] ?? `${index + 1}`;
}

/**
 * 方案 tab 的摘要：没有内容标「空白」，有内容说「n 步」。
 *
 * 「有没有内容」看的是**光区**（`planIsEmpty`），不是步骤数：新建的方案
 * 默认就有一步（编辑器的靶子），但一步都没画光区时仍然是「空白」。
 */
export function planTabSummary(draft: ScriptDraft): string {
  if (planIsEmpty(draft)) {
    return "空白";
  }
  return `${draft.stages.length} 步`;
}

/** 只有设备摘要（步骤数）时的文案；读回 0 步就是「空白」。 */
export function planDeviceSummary(stepCount: number): string {
  const count = Number.isFinite(stepCount) ? Math.max(0, Math.floor(stepCount)) : 0;
  return count === 0 ? "空白" : `${count} 步`;
}

/** 一个方案 tab 的视图。 */
export interface PlanTabView {
  /** 设备方案编号（页面内部用，不显示）。 */
  id: number;
  /** 圈码（①）。 */
  label: string;
  /** 「空白」或「n 步」。 */
  summary: string;
  selected: boolean;
  /** 设备正在播放的就是这一套。 */
  playing: boolean;
}

/** 组装 tab 视图（页面唯一派生入口）。 */
export function buildPlanTabs(
  ids: readonly number[],
  selectedId: number,
  summaries: Readonly<Record<number, string>>,
  playingId: number | null,
): PlanTabView[] {
  return normalizePlanIds(ids).map((id) => ({
    id,
    label: planNumberLabel(id),
    summary: summaries[id] ?? "空白",
    selected: id === selectedId,
    playing: id === playingId,
  }));
}

/** 设备播放状态的形状（只取用得到的两个字段）。 */
export interface PlanPlaybackState {
  scriptId: number;
  playbackState: number;
}

/**
 * 设备现在正在播的是不是这套方案。
 *
 * `playbackState` 0 = 停止；暂停（2）仍然算「这套在播」——删除它同样要把
 * 播放停掉，否则设备会停在一个已经不存在的方案上。
 */
export function planIsPlaying(state: PlanPlaybackState | null, planId: number): boolean {
  if (state === null) {
    return false;
  }
  if (state.playbackState === 0) {
    return false;
  }
  return state.scriptId === planId;
}

/**
 * 新建方案的空草稿：**一步、没有光区**。
 *
 * 一步是编辑器的靶子（时间轴总得有一块可点），没有光区让界面如实标「空白」。
 */
export function createEmptyPlanDraft(scriptId: number): ScriptDraft {
  const id = Number.isFinite(scriptId) ? Math.floor(scriptId) : 0;
  const clamped = Math.max(0, Math.min(MAX_PLANS - 1, id));
  return {
    scriptId: clamped,
    stages: [{ durationInput: String(DEFAULT_STEP_MS), segments: [] }],
  };
}

/**
 * 由「本机草稿」与「设备摘要」推出要显示哪几套方案。
 *
 * 两边都是线索，取并集：
 *  - **本机草稿**：用户新建过的方案即使还没下发，也应该出现在 tab 上；
 *  - **设备摘要**：以前下发过、本机草稿已被清掉的方案，仍然能用（也仍然
 *    需要在删除时走设备清空）；
 *  - 两边都没有 → 一套空白方案（①），保证进入页面永远有东西可编辑。
 *
 * 删除某套之后两边同时没有它，于它自然消失——不会因为「本机没了但设备
 * 还在」而在下次进入时复活。
 *
 * **只在本机已有草稿时才看设备摘要**（见 `visiblePlanIds`）：首次进入
 * 一台从没编辑过的设备时，即使灯控上留着以前下发的方案，也只显示一套
 * （票面「进入页面只显示一个方案」）。否则清缓存后一进来就是一堆 tab。
 */
export function planIdsFromSources(
  deviceStepCounts: Readonly<Record<number, number>> | null,
  localSlotIds: readonly number[],
): number[] {
  const ids: number[] = [...localSlotIds];
  if (deviceStepCounts !== null) {
    for (const [key, count] of Object.entries(deviceStepCounts)) {
      const id = Number(key);
      if (Number.isInteger(id) && Number.isFinite(count) && count > 0) {
        ids.push(id);
      }
    }
  }
  const normalized = normalizePlanIds(ids);
  return normalized.length === 0 ? initialPlanIds() : normalized;
}

/**
 * 把新出现的方案编号并进**当前显示的**表里（页面每次刷新摘要时用）。
 *
 * 与从零推导的区别：这是在已有 tab 上做并集，**只增不减**是安全的——删除
 * 时页面会显式从表里去掉那一套，而设备侧已被清空（计数 0）、本机草稿也已
 * 删除，下一次合并不会把它加回来。
 *
 * 必须用并集（而不是重新推导），否则「新建一套」后本机只有新那套被标记为
 * 有草稿，初始的①反而从 tab 上消失。
 */
export function mergePlanIds(
  current: readonly number[],
  deviceStepCounts: Readonly<Record<number, number>> | null,
  localSlotIds: readonly number[],
): number[] {
  const merged = [...normalizePlanIds(current), ...normalizePlanIds(localSlotIds)];
  if (deviceStepCounts !== null) {
    for (const [key, count] of Object.entries(deviceStepCounts)) {
      const id = Number(key);
      if (Number.isInteger(id) && Number.isFinite(count) && count > 0) {
        merged.push(id);
      }
    }
  }
  const normalized = normalizePlanIds(merged);
  return normalized.length === 0 ? initialPlanIds() : normalized;
}

/**
 * 页面上**实际显示**的方案表（页面所有刷新都走它）。
 *
 * 两份线索合流，但**设备摘要要等本机也有草稿才采纳**：
 *  - 首次进入（本机没有任何方案草稿）只显示当前那套 → 票面「进入页面只显示
 *    一个方案」。否则清缓存 / 换手机后，一进来就是别人下发过的一堆 tab；
 *  - 用户一旦自己建过 / 改过方案（`localSlotIds` 非空），设备上的方案也一并
 *    显示——它们确实还在设备上，必须能删掉。
 *
 * `current` 是当前 tab 表：它保证屏幕上已有的那套不会因为「还没被标记为
 * 用户草稿」而被一次刷新抹掉。
 */
export function visiblePlanIds(
  current: readonly number[],
  deviceStepCounts: Readonly<Record<number, number>> | null,
  localSlotIds: readonly number[],
): number[] {
  const local = normalizePlanIds(localSlotIds);
  const device = local.length > 0 ? deviceStepCounts : null;
  return mergePlanIds(current, device, local);
}
