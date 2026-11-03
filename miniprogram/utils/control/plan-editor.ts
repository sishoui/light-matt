/**
 * 灯效方案的编辑模型（#55 / #56）：方案槽位 → 步骤 → 光区 三级树。
 *
 * ## 为什么不新造一套数据结构
 *
 * 设备上的「方案」就是协议里的 script（4 槽位、每套 ≤8 阶段、每阶段若干段），
 * 「步骤」是阶段、「光区」是段。`script-view` 的 `ScriptDraft` 已经把
 * 增删步骤 / 改时长 / 重排 / 槽位隔离这些规则实现并测过了，再写一套只会
 * 两处漂移（改了下发路径却忘了草稿路径——#48 就是这么丢配置的）。
 *
 * 所以本模块只补三件 `script-view` 没有、而自定义档必须有的东西：
 *  1. **按灯组切片**：自定义档一次只编辑「当前灯组」的光区，但一套方案可以
 *     跨多组；写入时必须只替换当前组、原样保留别组；
 *  2. **光区 ↔ SegmentSpec 的双向转换**（复用 `zone-editor` / `zone-model`）；
 *  3. **方案级状态**：当前方案槽位 + 当前步骤下标，以及它们的合法化。
 *
 * 纯函数、不碰 wx / BLE。
 */

import { BLEND, LAYER_LEVEL_MAX, MAX_STAGES } from "../protocol/constants";
import type { ScriptDraft, ScriptStageDraft } from "./script-view";
import type { ScriptSegment } from "./script-plan";
import type { SegmentSpec } from "../protocol/types";
import { buildZoneSpec } from "./zone-model";
import { zonesFromReports } from "./zone-editor";

/** 编辑器里的一套方案 = script-view 的草稿 + 当前步骤。 */
export interface PlanState {
  /** 4 个槽位各自的草稿（下标 = 方案号）。 */
  drafts: ScriptDraft[];
  /** 当前编辑的方案槽位（0-3）。 */
  planId: number;
  /** 当前编辑的步骤下标（0 起）。 */
  stepIndex: number;
}

/** 新建编辑状态：4 套独立草稿，默认编辑第 1 套的第 1 步。 */
export function createPlanState(drafts: ScriptDraft[]): PlanState {
  return { drafts, planId: 0, stepIndex: 0 };
}

/** 把方案号 / 步骤号钳到合法范围（设备或草稿变化后仍可安全使用）。 */
export function clampPlan(state: PlanState): PlanState {
  const planId = Math.max(0, Math.min(state.drafts.length - 1, Math.floor(state.planId)));
  const draft = state.drafts[planId];
  const steps = draft === undefined ? 1 : Math.max(1, draft.stages.length);
  const stepIndex = Math.max(0, Math.min(steps - 1, Math.floor(state.stepIndex)));
  return { ...state, planId, stepIndex };
}

/** 当前方案草稿；状态非法时返回 null（页面显示空态而不是崩）。 */
export function currentPlanDraft(state: PlanState): ScriptDraft | null {
  const clamped = clampPlan(state);
  return clamped.drafts[clamped.planId] ?? null;
}

/** 当前步骤；不存在时返回 null。 */
export function currentStep(state: PlanState): ScriptStageDraft | null {
  const draft = currentPlanDraft(state);
  if (draft === null) {
    return null;
  }
  return draft.stages[clampPlan(state).stepIndex] ?? null;
}

/** 一个 `ScriptSegment` 是否是两层 spec（而不是扁平配置）。 */
export function isZoneSpec(segment: ScriptSegment): segment is SegmentSpec {
  return "layer0" in segment;
}

/** 只保留属于某灯组的光区，并归一成 `SegmentSpec`。 */
export function zonesOfStep(
  step: ScriptStageDraft | null,
  stripId: number,
): SegmentSpec[] {
  if (step === null) {
    return [];
  }
  return step.segments
    .filter((segment) => segment.stripId === stripId)
    .map((segment) =>
      isZoneSpec(segment)
        ? buildZoneSpec({
            stripId: segment.stripId,
            segId: segment.segId,
            start: segment.start,
            end: segment.end,
            blend: segment.blend,
            layer0: segment.layer0,
            layer1: segment.layer1,
          })
        : buildZoneSpec({
            stripId: segment.stripId,
            segId: segment.segId,
            start: segment.start,
            end: segment.end,
            blend: BLEND.OVER,
            layer0: {
              type: segment.type,
              hue: segment.hue,
              sat: segment.sat,
              periodMs: segment.periodMs,
              p5: segment.p5,
              flags: segment.flags,
              /* 扁平草稿没有亮度字段：按满亮（等价 v3 行为）。 */
              level: LAYER_LEVEL_MAX,
            },
            layer1: null,
          }),
    )
    .sort((a, b) => a.segId - b.segId);
}

/**
 * 用新的光区列表替换「当前步骤 × 当前灯组」的那一片，**原样保留别组**。
 *
 * 这是自定义档最容易出错的地方：如果直接把 `step.segments` 换成新数组，
 * 用户在多灯组设备上编辑第 1 组时会把第 2、3 组的光区一起清掉。
 */
export function replaceStepZones(
  draft: ScriptDraft,
  stepIndex: number,
  stripId: number,
  zones: readonly SegmentSpec[],
): ScriptDraft {
  const step = draft.stages[stepIndex];
  if (step === undefined) {
    return draft;
  }
  const segments = replaceStepZonesInList(step.segments, stripId, zones);
  const stages = draft.stages.map((item, index) =>
    index === stepIndex ? { ...item, segments } : item,
  );
  return { ...draft, stages };
}

/**
 * 「步骤 × 灯组」替换的**列表层实现**（`replaceStepZones` 与进阶档的步骤草稿共用）。
 *
 * 进阶档（#66）只保存「每一步的光区列表」，没有完整的方案草稿；它需要的正是
 * 同一条语义：**只替换当前灯组那一片**。规则只在这里写一份，两条路径不会漂移。
 */
export function replaceStepZonesInList(
  segments: readonly ScriptSegment[],
  stripId: number,
  zones: readonly SegmentSpec[],
): ScriptSegment[] {
  const others = segments.filter((segment) => segment.stripId !== stripId);
  const next = zones.map((zone) => ({
    stripId: zone.stripId,
    segId: zone.segId,
    start: zone.start,
    end: zone.end,
    blend: zone.blend,
    layer0: { ...zone.layer0 },
    layer1: { ...zone.layer1 },
  }));
  return [...others, ...next];
}

/** 当前步骤里覆盖了哪些灯组（三级树的面包屑与摘要用）。 */
export function stripsOfStep(step: ScriptStageDraft | null): number[] {
  if (step === null) {
    return [];
  }
  return Array.from(new Set(step.segments.map((segment) => segment.stripId))).sort((a, b) => a - b);
}

/** 步骤里该灯组的光区数（步骤卡片上的摘要）。 */
export function zoneCountOfStep(step: ScriptStageDraft | null, stripId: number): number {
  return step === null ? 0 : step.segments.filter((segment) => segment.stripId === stripId).length;
}

/** 该方案是否一步都还没有光区（第一次进入自定义档时的空态判据）。 */
export function planIsEmpty(draft: ScriptDraft | null): boolean {
  if (draft === null) {
    return true;
  }
  return draft.stages.every((stage) => stage.segments.length === 0);
}

/**
 * 默认时长：一秒。步骤的时长以**毫秒**存在协议里，但界面只给三个档位
 * （见 `STEP_DURATION_OPTIONS`），不让用户看见「毫秒」这个词。
 */
export const DEFAULT_STEP_MS = 1000;

/** 人话时长档位（界面用；值是协议毫秒）。 */
export const STEP_DURATION_OPTIONS: ReadonlyArray<{ value: number; label: string }> = [
  { value: 500, label: "半秒" },
  { value: 1000, label: "1 秒" },
  { value: 2000, label: "2 秒" },
  { value: 3000, label: "3 秒" },
  { value: 5000, label: "5 秒" },
  { value: 10000, label: "10 秒" },
];

/** 最接近给定毫秒的档位（设备读回 / 老数据不一定正好落档）。 */
export function nearestDurationLabel(ms: number): string {
  let best = STEP_DURATION_OPTIONS[0];
  let bestGap = Math.abs(ms - best.value);
  for (const option of STEP_DURATION_OPTIONS) {
    const gap = Math.abs(ms - option.value);
    if (gap < bestGap) {
      best = option;
      bestGap = gap;
    }
  }
  return best.label;
}

/** 步骤数上限（协议：每套方案 ≤8 阶段）。 */
export const MAX_PLAN_STEPS = MAX_STAGES;

/**
 * 由设备读回的该组光区初始化一个步骤（预览起点 = 设备真实值）。
 */
export function stepFromDeviceZones(zones: readonly SegmentSpec[]): ScriptStageDraft {
  return { durationInput: String(DEFAULT_STEP_MS), segments: zonesFromReports(zones as never) };
}

/**
 * 自定义档的「内容读不回来」说明（#56 票面要求界面如实告知）。
 *
 * v3 的查询只回 4 字节摘要（步骤数 / 是否启用 / 是否循环），拿不到步骤时长
 * 与光区内容。所以本地草稿是唯一记录——这一点必须写在界面上，否则用户会
 * 以为能「从灯控把方案拉回来改」。
 */
export const PLAN_READBACK_NOTE =
  "灯控只记得这套方案「有几个步骤、是否启用」，具体内容只存在这台手机上；换手机或清缓存后需要重新编排。";

/** 容量超限的说明（16KB 由 4 套方案共享）。 */
export const PLAN_CAPACITY_NOTE = "4 套方案共用 16KB 空间，超了要先精简再写入。";

/**
 * 把 `script-plan` / `errors` 的**旧术语**消息翻成本轮口径（#58）。
 *
 * 为什么要在页面边界翻译而不去改底层：`script-plan` 的文案是 v3 验收
 * 逐字核对过的（`docs/acceptance-v3.md` 有它的原文断言），改它要连着改
 * 验收记录；而用户看到的必须是新词（没有「剧本 / 阶段 / 毫秒」）。
 * 所以在「面向用户」的这一层做映射，底层保持协议口径。
 *
 * **这里不处理 `ms`**：`planUserMessage` 先做术语替换、再做时长换算。早期实现在
 * 这里把 `500ms` 直接换成「500 毫秒」，后面的 `durationMessageText` 就再也看不
 * 到 `ms` 了——输出里留下一个禁用词。毫秒只在 `durationMessageText` 里出现。
 */
export function planMessageText(message: string): string {
  return message
    .replace(/剧本过大/g, "这套方案太大")
    .replace(/阶段数/g, "步骤数")
    .replace(/段数/g, "光区数")
    .replace(/灯带数/g, "灯组数")
    .replace(/剧本/g, "方案")
    .replace(/阶段/g, "步骤")
    .replace(/下发/g, "写入")
    .replace(/激活/g, "启用");
}

/**
 * 把带 `ms` 的时长描述换成秒（界面不出现「毫秒」这个词）。
 *
 * 不足 1 秒一律说「不足 1 秒」——`0.001 秒` 这种数字对用户毫无意义，而「毫秒」
 * 本身是禁用词。已经是秒的文本（没有 `ms`）原样返回。
 */
export function durationMessageText(message: string): string {
  return message.replace(/(\d+(?:\.\d+)?)\s*ms\b/g, (_, raw: string) => {
    const ms = Number(raw);
    if (!Number.isFinite(ms) || ms <= 0) {
      return "不足 1 秒";
    }
    /* 不足 1 秒时说「不足 1 秒」：0.001 秒这种数字对用户毫无意义，
     * 而「毫秒」本身是禁用词。 */
    if (ms < 1000) {
      return "不足 1 秒";
    }
    const seconds = ms / 1000;
    return `${Number.isInteger(seconds) ? String(seconds) : seconds.toFixed(1)} 秒`;
  });
}

/**
 * 面向用户的方案校验消息：换术语 + 把毫秒换成秒。
 *
 * 顺序是硬要求：**先换术语，再换时长**。反过来（或在前一步就吃掉 `ms`）
 * 会让「1ms」变成「1 毫秒」，界面就出现了禁用词。
 */
export function planUserMessage(message: string): string {
  return durationMessageText(planMessageText(message));
}
