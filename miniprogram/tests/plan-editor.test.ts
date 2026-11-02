/**
 * 灯效方案的编辑模型（#55 / #56）。
 *
 * 锁住四件事：
 *  1. **多灯组隔离**：替换当前组的光区时，别组的光区一个字节都不能动
 *     （这是自定义档最容易丢配置的地方）；
 *  2. 方案槽位与步骤下标的钳位（换方案 / 删步骤后仍可安全渲染）；
 *  3. 扁平段与两层 spec 混在草稿里时都能正确读成光区；
 *  4. 人话时长档位的最近匹配（界面不出现「毫秒」）。
 */

import { describe, expect, it } from "vitest";
import {
  clampPlan,
  createPlanState,
  currentPlanDraft,
  currentStep,
  DEFAULT_STEP_MS,
  MAX_PLAN_STEPS,
  nearestDurationLabel,
  planIsEmpty,
  replaceStepZones,
  stepFromDeviceZones,
  stripsOfStep,
  zoneCountOfStep,
  zonesOfStep,
  type PlanState,
} from "../utils/control/plan-editor";
import { createScriptDrafts } from "../utils/control/script-view";
import { buildZoneSpec } from "../utils/control/zone-model";
import { BLEND, NO_EFFECT, SEGMENT_TYPE } from "../utils/protocol/constants";
import type { EffectLayer, SegmentSpec } from "../utils/protocol/types";

function layer(type: number, overrides: Partial<EffectLayer> = {}): EffectLayer {
  return { type, hue: 1000, sat: 255, periodMs: 0, p5: 0, flags: 0, ...overrides };
}

function zone(stripId: number, segId: number, start: number, end: number): SegmentSpec {
  return buildZoneSpec({
    stripId,
    segId,
    start,
    end,
    blend: BLEND.OVER,
    layer0: layer(SEGMENT_TYPE.STATIC),
    layer1: null,
  });
}

function state(): PlanState {
  return createPlanState(createScriptDrafts());
}

describe("方案状态", () => {
  it("新建状态编辑第 1 套方案的第 1 步", () => {
    const s = state();
    expect(s.planId).toBe(0);
    expect(s.stepIndex).toBe(0);
    expect(currentPlanDraft(s)).not.toBeNull();
    expect(currentStep(s)).not.toBeNull();
  });

  it("4 个槽位各自独立（改 A 不影响 B）", () => {
    const s = state();
    const draft0 = currentPlanDraft(s)!;
    const withZone = replaceStepZones(draft0, 0, 0, [zone(0, 0, 0, 9)]);
    const drafts = s.drafts.slice();
    drafts[0] = withZone;
    const next: PlanState = { ...s, drafts, planId: 1 };
    expect(currentPlanDraft(next)!.stages[0].segments).toEqual([]);
    expect(currentPlanDraft({ ...s, drafts })!.stages[0].segments).toHaveLength(1);
  });

  it("方案号越界被钳到最后一槽", () => {
    const s = clampPlan({ ...state(), planId: 99, stepIndex: 0 });
    expect(s.planId).toBe(3);
  });

  it("步骤下标越界被钳到最后一个步骤", () => {
    const clamped = clampPlan({ ...state(), stepIndex: 99 });
    expect(clamped.stepIndex).toBe(clamped.drafts[0].stages.length - 1);
  });

  it("负数下标钳到 0", () => {
    const clamped = clampPlan({ ...state(), planId: -3, stepIndex: -1 });
    expect(clamped.planId).toBe(0);
    expect(clamped.stepIndex).toBe(0);
  });
});

describe("步骤 × 灯组切片", () => {
  it("只读当前灯组的光区，并按槽位排序", () => {
    const s = state();
    const draft = replaceStepZones(
      currentPlanDraft(s)!,
      0,
      0,
      [zone(0, 2, 20, 29), zone(0, 0, 0, 9)],
    );
    const step = draft.stages[0];
    expect(zonesOfStep(step, 0).map((z) => z.segId)).toEqual([0, 2]);
    expect(zonesOfStep(step, 1)).toEqual([]);
  });

  it("替换当前组的光区时，别组原样保留（关键）", () => {
    const s = state();
    /* 先给第 0、1 组都放光区。 */
    let draft = replaceStepZones(currentPlanDraft(s)!, 0, 0, [zone(0, 0, 0, 9)]);
    draft = replaceStepZones(draft, 0, 1, [zone(1, 0, 0, 14)]);
    expect(draft.stages[0].segments).toHaveLength(2);

    /* 只改第 0 组：第 1 组必须一字不动。 */
    const next = replaceStepZones(draft, 0, 0, [zone(0, 0, 0, 4), zone(0, 1, 5, 9)]);
    const strip1 = next.stages[0].segments.filter((seg) => seg.stripId === 1);
    expect(strip1).toHaveLength(1);
    expect(strip1[0]).toMatchObject({ start: 0, end: 14 });
    expect(next.stages[0].segments.filter((seg) => seg.stripId === 0)).toHaveLength(2);
  });

  it("清空当前组时别组仍在（用户点「整组熄灭」不能连累别组）", () => {
    let draft = replaceStepZones(currentPlanDraft(state())!, 0, 0, [zone(0, 0, 0, 9)]);
    draft = replaceStepZones(draft, 0, 2, [zone(2, 0, 0, 5)]);
    const cleared = replaceStepZones(draft, 0, 0, []);
    expect(cleared.stages[0].segments).toHaveLength(1);
    expect(cleared.stages[0].segments[0].stripId).toBe(2);
  });

  it("替换的是指定步骤，别的步骤不受影响", () => {
    const s = state();
    let draft = replaceStepZones(currentPlanDraft(s)!, 1, 0, [zone(0, 0, 0, 9)]);
    draft = replaceStepZones(draft, 2, 0, [zone(0, 0, 0, 3)]);
    expect(draft.stages[1].segments).toHaveLength(1);
    expect(draft.stages[2].segments).toHaveLength(1);
    expect(draft.stages[0].segments).toHaveLength(0);
  });

  it("步骤下标不存在时返回原对象（不崩）", () => {
    const draft = currentPlanDraft(state())!;
    expect(replaceStepZones(draft, 99, 0, [zone(0, 0, 0, 1)])).toBe(draft);
  });

  it("读取时会深拷贝层（改返回值不污染草稿）", () => {
    let draft = replaceStepZones(currentPlanDraft(state())!, 0, 0, [zone(0, 0, 0, 9)]);
    const read = zonesOfStep(draft.stages[0], 0)[0];
    read.layer0.hue = 60000;
    expect(draft.stages[0].segments[0]).not.toBe(read);
  });

  it("扁平段也能读成光区（老草稿兼容）", () => {
    const draft = currentPlanDraft(state())!;
    const withFlat = {
      ...draft,
      stages: draft.stages.map((stage, index) =>
        index === 0
          ? {
              ...stage,
              segments: [
                {
                  stripId: 0,
                  segId: 0,
                  start: 0,
                  end: 4,
                  type: SEGMENT_TYPE.BREATHING,
                  hue: 2000,
                  sat: 255,
                  periodMs: 1000,
                  p5: 100,
                  flags: 0,
                },
              ],
            }
          : stage,
      ),
    };
    const zones = zonesOfStep(withFlat.stages[0], 0);
    expect(zones).toHaveLength(1);
    expect(zones[0].layer0.type).toBe(SEGMENT_TYPE.BREATHING);
    expect(zones[0].layer1.type).toBe(NO_EFFECT);
    expect(zones[0].blend).toBe(BLEND.OVER);
  });

  it("步骤摘要：灯组列表与各组光区数", () => {
    let draft = replaceStepZones(currentPlanDraft(state())!, 0, 0, [zone(0, 0, 0, 9)]);
    draft = replaceStepZones(draft, 0, 0, [zone(0, 0, 0, 4), zone(0, 1, 5, 9)]);
    draft = replaceStepZones(draft, 0, 3, [zone(3, 0, 0, 2)]);
    expect(stripsOfStep(draft.stages[0])).toEqual([0, 3]);
    expect(zoneCountOfStep(draft.stages[0], 0)).toBe(2);
    expect(zoneCountOfStep(draft.stages[0], 3)).toBe(1);
    expect(zoneCountOfStep(draft.stages[0], 5)).toBe(0);
  });
});

describe("空态与时长档位", () => {
  it("新方案没有任何光区", () => {
    expect(planIsEmpty(currentPlanDraft(state()))).toBe(true);
    const draft = replaceStepZones(currentPlanDraft(state())!, 0, 0, [zone(0, 0, 0, 1)]);
    expect(planIsEmpty(draft)).toBe(false);
  });

  it("null 草稿视为空", () => {
    expect(planIsEmpty(null)).toBe(true);
  });

  it("时长档位取最近的那一档（不把 1 秒说成毫秒）", () => {
    expect(nearestDurationLabel(1000)).toBe("1 秒");
    expect(nearestDurationLabel(980)).toBe("1 秒");
    expect(nearestDurationLabel(480)).toBe("半秒");
    expect(nearestDurationLabel(4800)).toBe("5 秒");
    /* 设备读回一个离谱的值也不抛错。 */
    expect(nearestDurationLabel(0)).toBeTypeOf("string");
  });

  it("由设备光区初始化步骤时沿用默认时长", () => {
    const step = stepFromDeviceZones([zone(0, 0, 0, 9)]);
    expect(step.durationInput).toBe(String(DEFAULT_STEP_MS));
    expect(step.segments).toHaveLength(1);
  });

  it("步骤上限是协议的 8", () => {
    expect(MAX_PLAN_STEPS).toBe(8);
  });
});
