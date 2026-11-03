/**
 * #79 灯珠数滑块与「缩小不静默丢编排」的纯逻辑。
 *
 * 锁的是四件事：
 *  1. `planShrink` 对四种输入的分类（部分越界 / 完全越界 / 无越界 / 改大）；
 *  2. 受影响个数的口径（去重、与确认文案里的数字一致）；
 *  3. `shrinkDraft` 只动当前灯组那一片，其它灯组 / 其它步骤一字不改；
 *  4. 滑块值钳位与总数求和（1–100，到不了 0、超不过 100）。
 *
 * 这些规则一旦漂移，代价是**用户编排被静默截掉或整段删掉**，所以边界值
 * （`end == new-1` / `start == new`）都要写死。
 */

import { describe, expect, it } from "vitest";

import {
  affectedZoneCount,
  clampLedCount,
  draftZoneRanges,
  planShrink,
  shrinkConfirmText,
  shrinkDraft,
  shrinkDrafts,
  sumStripLeds,
} from "../utils/control/led-count-plan";
import type { ScriptDraft } from "../utils/control/script-view";
import type { ScriptSegment } from "../utils/control/script-plan";
import { BLEND, NO_EFFECT, SEGMENT_TYPE } from "../utils/protocol/constants";
import { buildZoneSpec } from "../utils/control/zone-model";

/** 一个静态分区（`SegmentSpec` 形状，`end` 是闭区间）。 */
function zone(segId: number, start: number, end: number, stripId = 0) {
  return buildZoneSpec({
    stripId,
    segId,
    start,
    end,
    blend: BLEND.OVER,
    layer0: {
      type: SEGMENT_TYPE.STATIC,
      hue: 7281,
      sat: 255,
      periodMs: 0,
      p5: 0,
      flags: 0,
      level: 100,
    },
    layer1: null,
  });
}

/** 一条段草稿（两层 spec 形状，与落盘草稿同构）。 */
function segment(stripId: number, segId: number, start: number, end: number): ScriptSegment {
  return {
    stripId,
    segId,
    start,
    end,
    blend: BLEND.OVER,
    layer0: {
      type: SEGMENT_TYPE.STATIC,
      hue: 7281,
      sat: 255,
      periodMs: 0,
      p5: 0,
      flags: 0,
      level: 100,
    },
    layer1: {
      type: NO_EFFECT,
      hue: 0,
      sat: 0,
      periodMs: 0,
      p5: 0,
      flags: 0,
      level: 0,
    },
  };
}

/** 一份两步骤草稿（第一步 2 段、第二步 1 段），可覆盖段列表。 */
function draftWith(stages: ScriptSegment[][]): ScriptDraft {
  return {
    scriptId: 0,
    stages: stages.map((segments) => ({ durationInput: "1000", segments })),
  };
}

describe("clampLedCount", () => {
  it("钳到 1–100 的整数", () => {
    expect(clampLedCount(1)).toBe(1);
    expect(clampLedCount(48)).toBe(48);
    expect(clampLedCount(100)).toBe(100);
    expect(clampLedCount(0)).toBe(1);
    expect(clampLedCount(-5)).toBe(1);
    expect(clampLedCount(101)).toBe(100);
    expect(clampLedCount(9999)).toBe(100);
  });

  it("非有限值退回下界，小数四舍五入", () => {
    expect(clampLedCount(Number.NaN)).toBe(1);
    expect(clampLedCount(Number.POSITIVE_INFINITY)).toBe(1);
    expect(clampLedCount(24.4)).toBe(24);
    expect(clampLedCount(24.6)).toBe(25);
  });
});

describe("sumStripLeds", () => {
  it("等于各灯组灯珠数之和", () => {
    expect(sumStripLeds([100, 24])).toBe(124);
    expect(sumStripLeds([30])).toBe(30);
    expect(sumStripLeds([])).toBe(0);
  });

  it("未分配的 0 与坏值按 0 计，不产生 NaN 总数", () => {
    expect(sumStripLeds([60, 0, 0])).toBe(60);
    expect(sumStripLeds([60, Number.NaN, -3, 40.9])).toBe(100);
  });
});

describe("planShrink：四种输入", () => {
  it("无越界：全部原样保留，affected 为 0", () => {
    const zones = [zone(0, 0, 9), zone(1, 10, 19)];
    const plan = planShrink(zones, 20);
    expect(plan.kept.map((item) => item.segId)).toEqual([0, 1]);
    expect(plan.clamped).toEqual([]);
    expect(plan.dropped).toEqual([]);
    expect(plan.affected).toBe(0);
  });

  it("改大：不改动任何已有分区（全部进 kept）", () => {
    const zones = [zone(0, 0, 9), zone(1, 10, 29)];
    const plan = planShrink(zones, 100);
    expect(plan.kept).toHaveLength(2);
    expect(plan.kept[1].end).toBe(29);
    expect(plan.clamped).toEqual([]);
    expect(plan.dropped).toEqual([]);
    expect(plan.affected).toBe(0);
  });

  it("部分越界：截到新末尾，层与叠加方式原样保留", () => {
    const zones = [zone(0, 0, 19), zone(1, 20, 39)];
    const plan = planShrink(zones, 30);
    expect(plan.kept.map((item) => item.segId)).toEqual([0]);
    expect(plan.clamped).toHaveLength(1);
    expect(plan.clamped[0].segId).toBe(1);
    expect(plan.clamped[0].start).toBe(20);
    expect(plan.clamped[0].end).toBe(29);
    expect(plan.clamped[0].layer0).toEqual(zones[1].layer0);
    expect(plan.clamped[0].blend).toBe(zones[1].blend);
    expect(plan.dropped).toEqual([]);
    expect(plan.affected).toBe(1);
  });

  it("完全越界：整段删除（start 已在新长度之外）", () => {
    const zones = [zone(0, 0, 9), zone(1, 30, 39)];
    const plan = planShrink(zones, 20);
    expect(plan.kept.map((item) => item.segId)).toEqual([0]);
    expect(plan.clamped).toEqual([]);
    expect(plan.dropped.map((item) => item.segId)).toEqual([1]);
    expect(plan.affected).toBe(1);
  });

  it("边界：end == new-1 保留；start == new 删除；start == new-1 截成一颗", () => {
    /* newLedCount = 30 → 最后一个合法下标是 29。 */
    const exact = planShrink([zone(0, 20, 29)], 30);
    expect(exact.kept).toHaveLength(1);
    expect(exact.affected).toBe(0);

    const out = planShrink([zone(1, 30, 39)], 30);
    expect(out.dropped).toHaveLength(1);

    const single = planShrink([zone(2, 29, 39)], 30);
    expect(single.clamped).toHaveLength(1);
    expect(single.clamped[0]).toMatchObject({ start: 29, end: 29 });
  });

  it("不改入参（截断返回新对象）", () => {
    const original = zone(1, 20, 39);
    const plan = planShrink([original], 30);
    expect(original.end).toBe(39);
    expect(plan.clamped[0]).not.toBe(original);
  });

  it("多段混合：保留 / 截断 / 删除三种同时出现", () => {
    const zones = [zone(0, 0, 9), zone(1, 10, 24), zone(2, 25, 39)];
    const plan = planShrink(zones, 20);
    expect(plan.kept.map((item) => item.segId)).toEqual([0]);
    expect(plan.clamped.map((item) => item.segId)).toEqual([1]);
    expect(plan.clamped[0].end).toBe(19);
    expect(plan.dropped.map((item) => item.segId)).toEqual([2]);
    expect(plan.affected).toBe(2);
  });

  it("钳位后的 newLedCount 生效（0 → 1 颗、101 → 100 颗）", () => {
    const zones = [zone(0, 0, 49)];
    expect(planShrink(zones, 0).clamped[0].end).toBe(0);
    expect(planShrink(zones, 101).dropped).toEqual([]);
    expect(planShrink(zones, 101).kept[0].end).toBe(49);
  });
});

describe("affectedZoneCount", () => {
  it("设备分区与草稿里同一份定义（播种副本）只算一次", () => {
    const device = [{ segId: 0, start: 0, end: 39 }];
    /* 草稿里是同一份定义（从设备播种来的）。 */
    const draftSlot = [{ segId: 0, start: 0, end: 39 }];
    expect(affectedZoneCount(device, [draftSlot], 20)).toBe(1);
  });

  it("同一槽位内的重复定义合并，不同定义分别计入", () => {
    expect(
      affectedZoneCount(
        [
          { segId: 0, start: 0, end: 39 },
          { segId: 1, start: 40, end: 59 },
        ],
        [[{ segId: 0, start: 0, end: 24 }]],
        20,
      ),
    ).toBe(3);
  });

  it("同一段定义出现在两个方案槽位里算两份编排", () => {
    const same = [{ segId: 0, start: 0, end: 39 }];
    expect(affectedZoneCount([], [same, same], 20)).toBe(2);
  });

  it("没有越界时是 0（改大也一样）", () => {
    expect(affectedZoneCount([{ segId: 0, start: 0, end: 19 }], [], 20)).toBe(0);
    expect(affectedZoneCount([{ segId: 0, start: 0, end: 19 }], [], 100)).toBe(0);
    expect(affectedZoneCount([], [], 20)).toBe(0);
  });
});

describe("shrinkConfirmText", () => {
  it("文案里带数量与新长度", () => {
    const text = shrinkConfirmText(3, 20);
    expect(text).toContain("3 个分区");
    expect(text).toContain("20 颗");
    expect(text).toContain("截到新末尾");
  });
});

describe("shrinkDraft", () => {
  it("只改当前灯组那一片，其它灯组一字不改", () => {
    const draft = draftWith([
      [segment(0, 0, 0, 39), segment(1, 0, 0, 39)],
      [segment(1, 1, 10, 29)],
    ]);
    const result = shrinkDraft(draft, 0, 20);
    expect(result.changed).toBe(true);
    expect(result.affected).toBe(1);
    /* 灯组 0 被截断。 */
    expect(result.draft.stages[0].segments.find((item) => item.stripId === 0)).toMatchObject({
      start: 0,
      end: 19,
    });
    /* 灯组 1 原样：引用都是同一个对象。 */
    expect(result.draft.stages[0].segments.find((item) => item.stripId === 1)).toBe(
      draft.stages[0].segments[1],
    );
    expect(result.draft.stages[1]).toBe(draft.stages[1]);
  });

  it("完全越界的段被删掉；其它步骤的空数组保留", () => {
    const draft = draftWith([[segment(0, 0, 30, 39)], []]);
    const result = shrinkDraft(draft, 0, 20);
    expect(result.draft.stages[0].segments).toEqual([]);
    expect(result.draft.stages[1]).toEqual(draft.stages[1]);
    expect(result.affected).toBe(1);
  });

  it("没有越界时返回原对象（引用相等 = 不用落盘）", () => {
    const draft = draftWith([[segment(0, 0, 0, 19)]]);
    const result = shrinkDraft(draft, 0, 20);
    expect(result.draft).toBe(draft);
    expect(result.changed).toBe(false);
    expect(result.affected).toBe(0);
  });

  it("改大不改任何段", () => {
    const draft = draftWith([[segment(0, 0, 0, 39)]]);
    const result = shrinkDraft(draft, 0, 100);
    expect(result.draft).toBe(draft);
    expect(result.changed).toBe(false);
  });
});

describe("shrinkDrafts", () => {
  it("给出需要落盘的槽位，未变的槽位保留原对象", () => {
    const changed = draftWith([[segment(0, 0, 0, 39)]]);
    const untouched = draftWith([[segment(0, 0, 0, 19)]]);
    const result = shrinkDrafts([changed, untouched], 0, 20);
    expect(result.changedSlots).toEqual([0]);
    expect(result.drafts[0]).not.toBe(changed);
    expect(result.drafts[1]).toBe(untouched);
    /* 去重口径：两份草稿里同一个分区只算一个。 */
    expect(result.affected).toBe(1);
  });
});

describe("draftZoneRanges", () => {
  it("只取当前灯组的区间，并按方案槽位分组", () => {
    const drafts = [
      draftWith([[segment(0, 0, 0, 39), segment(1, 0, 0, 39)]]),
      draftWith([[segment(0, 1, 40, 59)]]),
    ];
    const ranges = draftZoneRanges(drafts, 0);
    expect(ranges).toEqual([
      [{ segId: 0, start: 0, end: 39 }],
      [{ segId: 1, start: 40, end: 59 }],
    ]);
  });
});
