/**
 * #101 跨灯组串扰的修复：下发前补齐其它灯组切片。
 *
 * 锁四件票面要求的事：
 *  1. 补齐后不再出现空切片（每个可见灯组在每一步都有内容）；
 *  2. 只改当前灯组时，其它灯组切片逐字节不变；
 *  3. 读回失败时不下发（候选草稿为 null）；
 *  4. 三灯组设备上，任意一条上编排都不影响另外两条。
 */

import { describe, expect, it } from "vitest";
import {
  EMPTY_STRIP_FALLBACK,
  fillOtherStrips,
  missingSlices,
  missingSlicesText,
} from "../utils/control/plan-fill";
import type { ScriptDraft } from "../utils/control/script-view";
import type { SegmentSpec } from "../utils/protocol/types";
import { NO_EFFECT, SEGMENT_TYPE } from "../utils/protocol/constants";

function zone(overrides: Partial<SegmentSpec> & { stripId: number; segId: number }): SegmentSpec {
  return {
    start: 0,
    end: 9,
    blend: 0,
    layer0: { type: SEGMENT_TYPE.STATIC, hue: 1000, sat: 200, periodMs: 0, p5: 0, flags: 0, level: 100 },
    layer1: { type: NO_EFFECT, hue: 0, sat: 0, periodMs: 0, p5: 0, flags: 0, level: 0 },
    ...overrides,
  } as SegmentSpec;
}

function draft(stages: Array<SegmentSpec[]>): ScriptDraft {
  return {
    scriptId: 0,
    stages: stages.map((segments) => ({ durationInput: "1000", segments })),
  };
}

describe("补齐其它灯组切片", () => {
  it("只改当前灯组时，其它灯组补进草稿（不再出现空切片）", () => {
    const input = draft([
      [zone({ stripId: 0, segId: 0 })],
      [zone({ stripId: 0, segId: 0 })],
    ]);
    /* 设备上灯组 1 有内容（两步各一段）。 */
    const slices = new Map([
      [1, [[zone({ stripId: 1, segId: 0, start: 0, end: 19 })], [zone({ stripId: 1, segId: 0, start: 0, end: 19 })]]],
    ]);
    const { draft: merged, filled } = fillOtherStrips({
      draft: input,
      targetStripId: 0,
      slices,
    });
    expect(filled).toEqual([1]);
    expect(merged.stages.length).toBe(2);
    /* 每一步都有灯组 1 的切片。 */
    for (const stage of merged.stages) {
      expect(stage.segments.some((segment) => segment.stripId === 1)).toBe(true);
    }
  });

  it("其它灯组切片逐字节不变（补进来的是副本）", () => {
    const other = zone({ stripId: 1, segId: 2, start: 5, end: 12, blend: 2 });
    const slices = new Map([[1, [[other]]]]);
    const { draft: merged } = fillOtherStrips({
      draft: draft([[zone({ stripId: 0, segId: 0 })]]),
      targetStripId: 0,
      slices,
    });
    const copied = merged.stages[0].segments.find((segment) => segment.stripId === 1)!;
    expect(copied).toEqual(other);
    /* 是副本，不是同一个对象：改草稿不会改设备切片。 */
    expect(copied).not.toBe(other);
  });

  it("当前灯组永远不被补齐（用户的编排原样保留）", () => {
    const input = draft([[zone({ stripId: 0, segId: 0, start: 0, end: 3 })]]);
    const slices = new Map([[0, [[zone({ stripId: 0, segId: 5, start: 0, end: 29 })]]]]);
    const { draft: merged } = fillOtherStrips({ draft: input, targetStripId: 0, slices });
    expect(merged.stages[0].segments).toEqual(input.stages[0].segments);
  });

  it("设备上也没有内容的灯组补一条熄灭（「不被方案接管」）", () => {
    const slices = new Map<number, Array<readonly SegmentSpec[]>>([[1, [[]]]]);
    const { draft: merged, filled } = fillOtherStrips({
      draft: draft([[zone({ stripId: 0, segId: 0 })]]),
      targetStripId: 0,
      slices,
      ledCounts: new Map([[1, 20]]),
    });
    expect(filled).toEqual([1]);
    const fallback = merged.stages[0].segments.find((segment) => segment.stripId === 1)!;
    expect(fallback.layer0.type).toBe(EMPTY_STRIP_FALLBACK);
    expect(fallback.start).toBe(0);
    expect(fallback.end).toBe(19);
  });

  it("可以关掉「空白也补」（fillBlank=false）", () => {
    const slices = new Map<number, Array<readonly SegmentSpec[]>>([[1, [[]]]]);
    const { draft: merged, filled } = fillOtherStrips({
      draft: draft([[zone({ stripId: 0, segId: 0 })]]),
      targetStripId: 0,
      slices,
      fillBlank: false,
    });
    expect(filled).toEqual([]);
    expect(merged.stages[0].segments.some((segment) => segment.stripId === 1)).toBe(false);
  });

  it("已有该灯组切片的步骤不重复补（幂等）", () => {
    const existing = zone({ stripId: 1, segId: 0 });
    const input = draft([[zone({ stripId: 0, segId: 0 }), existing]]);
    const slices = new Map([[1, [[zone({ stripId: 1, segId: 7 })]]]]);
    const { draft: merged, filled } = fillOtherStrips({ draft: input, targetStripId: 0, slices });
    const strip1 = merged.stages[0].segments.filter((segment) => segment.stripId === 1);
    expect(strip1.length).toBe(1);
    expect(strip1[0].segId).toBe(0);
    expect(filled).toEqual([]);
  });

  it("多步骤：每一步各自补对应步骤的切片", () => {
    const slices = new Map([
      [
        1,
        [
          [zone({ stripId: 1, segId: 0, start: 0, end: 4 })],
          [zone({ stripId: 1, segId: 0, start: 5, end: 9 })],
        ],
      ],
    ]);
    const { draft: merged } = fillOtherStrips({
      draft: draft([[zone({ stripId: 0, segId: 0 })], [zone({ stripId: 0, segId: 0 })]]),
      targetStripId: 0,
      slices,
    });
    expect(merged.stages[0].segments.find((s) => s.stripId === 1)!.start).toBe(0);
    expect(merged.stages[1].segments.find((s) => s.stripId === 1)!.start).toBe(5);
  });

  it("三灯组设备：在任意一条上编排都不影响另外两条", () => {
    for (const target of [0, 1, 2]) {
      const others = [0, 1, 2].filter((id) => id !== target);
      const slices = new Map(
        others.map((id) => [
          id,
          [[zone({ stripId: id, segId: 0, start: id * 3, end: id * 3 + 2 })]],
        ]),
      );
      const { draft: merged, filled } = fillOtherStrips({
        draft: draft([[zone({ stripId: target, segId: 0 })]]),
        targetStripId: target,
        slices,
      });
      expect(filled, `target=${target}`).toEqual(others);
      for (const id of others) {
        const copy = merged.stages[0].segments.find((segment) => segment.stripId === id)!;
        expect(copy.start).toBe(id * 3);
        expect(copy.end).toBe(id * 3 + 2);
      }
      /* 当前灯组没有被污染。 */
      const own = merged.stages[0].segments.filter((segment) => segment.stripId === target);
      expect(own.length).toBe(1);
    }
  });

  it("单灯组设备不需要补齐（原样返回）", () => {
    const input = draft([[zone({ stripId: 0, segId: 0 })]]);
    const { draft: merged, filled } = fillOtherStrips({
      draft: input,
      targetStripId: 0,
      slices: new Map(),
    });
    expect(filled).toEqual([]);
    expect(merged).toEqual(input);
  });
});

describe("读回失败时不下发", () => {
  it("缺失的灯组号被列出来", () => {
    const slices = new Map([[1, []]]);
    expect(missingSlices([0, 1, 2], 0, slices)).toEqual([2]);
    expect(missingSlices([0, 1, 2], 1, new Map())).toEqual([0, 2]);
    /* 当前灯组不算缺失。 */
    expect(missingSlices([0], 0, new Map())).toEqual([]);
  });

  it("失败文案说明「这次没有下发」与原因", () => {
    const text = missingSlicesText([1, 2]);
    expect(text).toContain("灯组 2");
    expect(text).toContain("灯组 3");
    expect(text).toContain("没有下发");
    expect(missingSlicesText([])).toBe("");
  });
});
