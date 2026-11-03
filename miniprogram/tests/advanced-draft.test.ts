/**
 * 进阶草稿（#65 时间轴 + #66 光区轴）的纯逻辑。
 *
 * 锁住三条：
 *  1. 写入只替换「当前步骤 × 当前灯组」那一片，别的灯组与别的步骤一字不动
 *     （多灯组设备上编辑第 1 组不能清掉第 2 组）；
 *  2. 时间轴的缩略色带与光区轴来自同一份草稿；
 *  3. 增删 / 重排步骤的越界与上限行为（引用不变 = 页面不刷新）。
 */

import { describe, expect, it } from "vitest";
import {
  addStepStage,
  advancedDraftOf,
  advancedStepCount,
  canAddStepStage,
  createAdvancedDrafts,
  moveStepStage,
  removeStepStage,
  seedStepFromReports,
  setStageDurationMs,
  stageDurationMs,
  stepZonesOf,
  timelineStepsOf,
  writeStepZones,
} from "../utils/control/advanced-draft";
import { BLEND, SEGMENT_TYPE } from "../utils/protocol/constants";
import type { SegmentReport, SegmentSpec } from "../utils/protocol/types";
import { buildZoneSpec } from "../utils/control/zone-model";
import { DEFAULT_STEP_COUNT, DEFAULT_STEP_MS, MAX_STEPS } from "../utils/control/timeline";

function zone(stripId: number, segId: number, start: number, end: number): SegmentSpec {
  return buildZoneSpec({
    stripId,
    segId,
    start,
    end,
    blend: BLEND.OVER,
    layer0: { type: SEGMENT_TYPE.STATIC, hue: 7281, sat: 255, periodMs: 0, p5: 0, flags: 0, level: 100 },
    layer1: null,
  });
}

function report(stripId: number, segId: number, start: number, end: number, hue = 7281): SegmentReport {
  const layer0 = { type: SEGMENT_TYPE.STATIC, hue, sat: 255, periodMs: 0, p5: 0, flags: 0 };
  const layer1 = { type: 0xff, hue: 0, sat: 0, periodMs: 0, p5: 0, flags: 0, level: 0 };
  return {
    stripId,
    segId,
    start,
    end,
    blend: BLEND.OVER,
    layer0,
    layer1,
    type: layer0.type,
    hue,
    sat: 255,
    periodMs: 0,
    p5: 0,
    flags: 0,
  };
}

describe("新建与取草稿", () => {
  it("4 个槽位各一份，默认两个步骤（看得出步骤之间的差异）", () => {
    const drafts = createAdvancedDrafts();
    expect(drafts).toHaveLength(4);
    expect(drafts.every((draft) => draft.stages.length === DEFAULT_STEP_COUNT)).toBe(true);
    expect(DEFAULT_STEP_COUNT).toBe(2);
  });

  it("按方案号取；越界钳到最后一套", () => {
    const drafts = createAdvancedDrafts();
    expect(advancedDraftOf(drafts, 2).scriptId).toBe(2);
    expect(advancedDraftOf(drafts, 99).scriptId).toBe(3);
  });

  it("步骤数", () => {
    expect(advancedStepCount(advancedDraftOf(createAdvancedDrafts(), 0))).toBe(DEFAULT_STEP_COUNT);
  });
});

describe("步骤时长", () => {
  it("草稿里的字符串时长 → 毫秒（非法回默认 1 秒）", () => {
    const draft = createAdvancedDrafts()[0];
    expect(stageDurationMs(draft.stages[0])).toBe(DEFAULT_STEP_MS);
    expect(stageDurationMs({ durationInput: "2500" })).toBe(2500);
    expect(stageDurationMs({ durationInput: "" })).toBe(DEFAULT_STEP_MS);
    expect(stageDurationMs(undefined)).toBe(DEFAULT_STEP_MS);
  });

  it("改时长会钳到 0.5–30 秒", () => {
    const draft = createAdvancedDrafts()[0];
    const fast = setStageDurationMs(draft, 0, 100);
    expect(stageDurationMs(fast.stages[0])).toBe(500);
    const slow = setStageDurationMs(draft, 0, 99999);
    expect(stageDurationMs(slow.stages[0])).toBe(30000);
  });

  it("时长没变 / 下标越界 → 同一个对象（页面据此不刷新）", () => {
    const draft = createAdvancedDrafts()[0];
    expect(setStageDurationMs(draft, 0, DEFAULT_STEP_MS)).toBe(draft);
    expect(setStageDurationMs(draft, 99, 2000)).toBe(draft);
  });
});

describe("增删与重排步骤", () => {
  it("加步骤：默认 1 秒、没有光区", () => {
    const draft = createAdvancedDrafts()[0];
    const next = addStepStage(draft);
    expect(next.stages).toHaveLength(DEFAULT_STEP_COUNT + 1);
    expect(stageDurationMs(next.stages[next.stages.length - 1])).toBe(DEFAULT_STEP_MS);
    expect(next.stages[next.stages.length - 1].segments).toEqual([]);
  });

  it("8 个步骤封顶（返回原对象）", () => {
    let draft = createAdvancedDrafts()[0];
    while (canAddStepStage(draft)) {
      draft = addStepStage(draft);
    }
    expect(draft.stages).toHaveLength(MAX_STEPS);
    expect(addStepStage(draft)).toBe(draft);
  });

  it("删步骤至少留一个（返回原对象）", () => {
    let draft = createAdvancedDrafts()[0];
    draft = removeStepStage(draft, 0);
    expect(draft.stages).toHaveLength(DEFAULT_STEP_COUNT - 1);
    expect(removeStepStage(draft, 0)).toBe(draft);
  });

  it("删越界下标 → 原对象", () => {
    const draft = createAdvancedDrafts()[0];
    expect(removeStepStage(draft, -1)).toBe(draft);
    expect(removeStepStage(draft, 99)).toBe(draft);
  });

  it("拖动重排：顺序真的变了、原对象不动", () => {
    const draft = writeStepZones(
      writeStepZones(createAdvancedDrafts()[0], 0, 0, [zone(0, 0, 0, 9)]),
      1,
      0,
      [zone(0, 0, 20, 29)],
    );
    const moved = moveStepStage(draft, 0, 1);
    expect(moved).not.toBe(draft);
    expect(stepZonesOf(moved, 0, 0)[0].start).toBe(20);
    expect(stepZonesOf(moved, 1, 0)[0].start).toBe(0);
    /* 入参没被改。 */
    expect(stepZonesOf(draft, 0, 0)[0].start).toBe(0);
  });

  it("自移 / 越界重排 → 同一个对象", () => {
    const draft = createAdvancedDrafts()[0];
    expect(moveStepStage(draft, 0, 0)).toBe(draft);
    expect(moveStepStage(draft, 0, 9)).toBe(draft);
    expect(moveStepStage(draft, -1, 0)).toBe(draft);
  });
});

describe("多灯组隔离（关键）", () => {
  it("写第 0 组不碰第 1 组", () => {
    let draft = createAdvancedDrafts()[0];
    draft = writeStepZones(draft, 0, 0, [zone(0, 0, 0, 9)]);
    draft = writeStepZones(draft, 0, 1, [zone(1, 0, 0, 14)]);

    const next = writeStepZones(draft, 0, 0, [zone(0, 0, 0, 4), zone(0, 1, 5, 9)]);
    expect(stepZonesOf(next, 0, 0)).toHaveLength(2);
    const strip1 = next.stages[0].segments.filter((segment) => segment.stripId === 1);
    expect(strip1).toHaveLength(1);
    expect(strip1[0].start).toBe(0);
    expect(strip1[0].end).toBe(14);
  });

  it("写第 0 步不碰第 1 步", () => {
    let draft = createAdvancedDrafts()[0];
    draft = writeStepZones(draft, 1, 0, [zone(0, 0, 20, 29)]);
    const next = writeStepZones(draft, 0, 0, [zone(0, 0, 0, 9)]);
    expect(stepZonesOf(next, 1, 0)[0].start).toBe(20);
  });

  it("步骤下标越界 → 原对象", () => {
    const draft = createAdvancedDrafts()[0];
    expect(writeStepZones(draft, 99, 0, [zone(0, 0, 0, 9)])).toBe(draft);
  });

  it("同一条灯组的两个步骤各存各的", () => {
    let draft = createAdvancedDrafts()[0];
    draft = writeStepZones(draft, 0, 0, [zone(0, 0, 0, 9)]);
    draft = writeStepZones(draft, 1, 0, [zone(0, 0, 10, 19)]);
    expect(stepZonesOf(draft, 0, 0)[0].end).toBe(9);
    expect(stepZonesOf(draft, 1, 0)[0].end).toBe(19);
  });
});

describe("时间轴色带来自同一份草稿", () => {
  it("每块色带按该步的光区铺，没覆盖的留白", () => {
    const draft = writeStepZones(createAdvancedDrafts()[0], 0, 0, [zone(0, 0, 0, 9)]);
    const steps = timelineStepsOf(draft, 0);
    expect(steps).toHaveLength(DEFAULT_STEP_COUNT);
    expect(steps[0].zones).toHaveLength(1);
    expect(steps[0].zones[0]).toMatchObject({ start: 0, end: 9 });
    expect(steps[0].zones[0].hex).toMatch(/^#[0-9A-F]{6}$/i);
    expect(steps[1].zones).toEqual([]);
  });

  it("写别的灯组不影响当前灯组的色带", () => {
    let draft = createAdvancedDrafts()[0];
    draft = writeStepZones(draft, 0, 0, [zone(0, 0, 0, 9)]);
    const next = writeStepZones(draft, 0, 1, [zone(1, 0, 20, 29)]);
    expect(timelineStepsOf(next, 0)[0].zones).toHaveLength(1);
    expect(timelineStepsOf(next, 1)[0].zones).toHaveLength(1);
  });
});

describe("从设备播种（seedStepFromReports）", () => {
  const reports = [report(0, 0, 0, 13), report(0, 1, 14, 29), report(1, 0, 0, 17)];

  it("空步骤被填上设备当前的该组光区", () => {
    const draft = seedStepFromReports(createAdvancedDrafts()[0], 0, 0, reports);
    expect(stepZonesOf(draft, 0, 0).map((zone) => zone.segId)).toEqual([0, 1]);
  });

  it("只取当前灯组（别的组不会串进来）", () => {
    const draft = seedStepFromReports(createAdvancedDrafts()[0], 0, 1, reports);
    expect(stepZonesOf(draft, 0, 1)).toHaveLength(1);
    expect(stepZonesOf(draft, 0, 0)).toHaveLength(0);
  });

  it("已有草稿的步骤不被覆盖（用户编过的东西不会丢）", () => {
    const draft = writeStepZones(createAdvancedDrafts()[0], 0, 0, [zone(0, 0, 5, 9)]);
    const next = seedStepFromReports(draft, 0, 0, reports);
    expect(next).toBe(draft);
    expect(stepZonesOf(next, 0, 0)[0].start).toBe(5);
  });

  it("设备上这一组没有光区 → 原对象", () => {
    const draft = createAdvancedDrafts()[0];
    expect(seedStepFromReports(draft, 0, 2, reports)).toBe(draft);
  });
});
