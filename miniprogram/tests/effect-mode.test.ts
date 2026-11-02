/**
 * 快捷 / 自定义档的切换与快照。
 *
 * 这是「切换模式丢配置」的唯一防线。快照只存在内存，所以每个用例开始前
 * 都要清空，避免用例间互相污染。
 */

import { beforeEach, describe, expect, it } from "vitest";
import {
  clearAllSnapshots,
  dropCustomSnapshot,
  hasCustomSnapshot,
  planTransition,
  saveCustomSnapshot,
  snapshotKey,
  takeCustomSnapshot,
} from "../utils/control/effect-mode";
import type { SegmentSpec } from "../utils/protocol/types";
import type { ScriptDraft } from "../utils/control/script-view";
import { NO_EFFECT, SEGMENT_TYPE } from "../utils/protocol/constants";

function spec(segId: number, start: number, end: number, hue = 1000): SegmentSpec {
  return {
    stripId: 0,
    segId,
    start,
    end,
    blend: 0,
    layer0: { type: SEGMENT_TYPE.STATIC, hue, sat: 255, periodMs: 0, p5: 0, flags: 0 },
    layer1: { type: NO_EFFECT, hue: 0, sat: 0, periodMs: 0, p5: 0, flags: 0, level: 0 },
  };
}

describe("快照键", () => {
  it("同一设备同一灯组得到同一个键", () => {
    expect(snapshotKey("DEV-A", 0)).toBe(snapshotKey("DEV-A", 0));
  });

  it("不同灯组 / 不同设备是不同的键（防串号）", () => {
    expect(snapshotKey("DEV-A", 0)).not.toBe(snapshotKey("DEV-A", 1));
    expect(snapshotKey("DEV-A", 0)).not.toBe(snapshotKey("DEV-B", 0));
  });
});

describe("保存与恢复", () => {
  beforeEach(() => clearAllSnapshots());

  it("保存后能原样取回（光区、方案、步骤）", () => {
    saveCustomSnapshot("DEV-A", 0, { zones: [spec(0, 0, 9), spec(1, 10, 19)], planId: 2, stepIndex: 1 }, 1000);
    const snap = takeCustomSnapshot("DEV-A", 0);
    expect(snap?.zones).toHaveLength(2);
    expect(snap?.zones[1].start).toBe(10);
    expect(snap?.planId).toBe(2);
    expect(snap?.stepIndex).toBe(1);
    expect(snap?.savedAt).toBe(1000);
  });

  it("没有快照时返回 null（用户可重新编排）", () => {
    expect(takeCustomSnapshot("DEV-A", 0)).toBeNull();
    expect(hasCustomSnapshot("DEV-A", 0)).toBe(false);
  });

  it("不同灯组的快照互不影响", () => {
    saveCustomSnapshot("DEV-A", 0, { zones: [spec(0, 0, 9)], planId: 0, stepIndex: 0 });
    saveCustomSnapshot("DEV-A", 1, { zones: [spec(0, 0, 29), spec(1, 30, 59)], planId: 1, stepIndex: 2 });
    expect(takeCustomSnapshot("DEV-A", 0)?.zones).toHaveLength(1);
    expect(takeCustomSnapshot("DEV-A", 1)?.zones).toHaveLength(2);
  });

  it("不同设备的快照互不影响", () => {
    saveCustomSnapshot("DEV-A", 0, { zones: [spec(0, 0, 9)], planId: 0, stepIndex: 0 });
    saveCustomSnapshot("DEV-B", 0, { zones: [spec(0, 0, 29)], planId: 3, stepIndex: 1 });
    expect(takeCustomSnapshot("DEV-A", 0)?.planId).toBe(0);
    expect(takeCustomSnapshot("DEV-B", 0)?.planId).toBe(3);
  });

  it("设备 key 为空时不保存（未连接的兜底）", () => {
    saveCustomSnapshot("", 0, { zones: [spec(0, 0, 9)], planId: 0, stepIndex: 0 });
    expect(takeCustomSnapshot("", 0)).toBeNull();
  });

  it("取回的是深拷贝：改返回值不会污染快照", () => {
    saveCustomSnapshot("DEV-A", 0, { zones: [spec(0, 0, 9)], planId: 0, stepIndex: 0 });
    const first = takeCustomSnapshot("DEV-A", 0)!;
    first.zones[0].start = 99;
    first.zones[0].layer0.hue = 12345;
    const second = takeCustomSnapshot("DEV-A", 0)!;
    expect(second.zones[0].start).toBe(0);
    expect(second.zones[0].layer0.hue).toBe(1000);
  });

  it("重复保存是覆盖（同一灯组只有最新一份）", () => {
    saveCustomSnapshot("DEV-A", 0, { zones: [spec(0, 0, 9)], planId: 0, stepIndex: 0 }, 1);
    saveCustomSnapshot("DEV-A", 0, { zones: [spec(0, 0, 29)], planId: 1, stepIndex: 3 }, 2);
    const snap = takeCustomSnapshot("DEV-A", 0);
    expect(snap?.zones[0].end).toBe(29);
    expect(snap?.planId).toBe(1);
    expect(snap?.savedAt).toBe(2);
  });
});

describe("丢弃快照", () => {
  beforeEach(() => clearAllSnapshots());

  it("丢弃后取不到", () => {
    saveCustomSnapshot("DEV-A", 0, { zones: [spec(0, 0, 9)], planId: 0, stepIndex: 0 });
    dropCustomSnapshot("DEV-A", 0);
    expect(takeCustomSnapshot("DEV-A", 0)).toBeNull();
  });

  it("只丢目标灯组，其它灯组保留", () => {
    saveCustomSnapshot("DEV-A", 0, { zones: [spec(0, 0, 9)], planId: 0, stepIndex: 0 });
    saveCustomSnapshot("DEV-A", 1, { zones: [spec(0, 0, 19)], planId: 1, stepIndex: 0 });
    dropCustomSnapshot("DEV-A", 0);
    expect(takeCustomSnapshot("DEV-A", 1)).not.toBeNull();
  });
});

describe("切换决策", () => {
  beforeEach(() => clearAllSnapshots());

  it("自定义 → 快捷：应该保存快照", () => {
    const t = planTransition("custom", "quick", "DEV-A", 0);
    expect(t).toEqual({ kind: "to-quick", shouldSave: true });
  });

  it("已经在快捷 → 快捷：不需要保存（避免覆盖掉真正的编排）", () => {
    const t = planTransition("quick", "quick", "DEV-A", 0);
    expect(t).toEqual({ kind: "to-quick", shouldSave: false });
  });

  it("快捷 → 自定义且无快照：restore 为 null（新编排）", () => {
    const t = planTransition("quick", "custom", "DEV-A", 0);
    expect(t).toEqual({ kind: "to-custom", restore: null });
  });

  it("快捷 → 自定义且有快照：带回编排", () => {
    saveCustomSnapshot("DEV-A", 0, { zones: [spec(0, 0, 9)], planId: 2, stepIndex: 1 });
    const t = planTransition("quick", "custom", "DEV-A", 0);
    expect(t.kind).toBe("to-custom");
    if (t.kind === "to-custom") {
      expect(t.restore?.zones).toHaveLength(1);
      expect(t.restore?.planId).toBe(2);
    }
  });

  it("切换往返一次后快照仍可再读（take 不删除）", () => {
    saveCustomSnapshot("DEV-A", 0, { zones: [spec(0, 0, 9)], planId: 0, stepIndex: 0 });
    planTransition("quick", "custom", "DEV-A", 0);
    planTransition("quick", "custom", "DEV-A", 0);
    expect(hasCustomSnapshot("DEV-A", 0)).toBe(true);
  });
});

/**
 * #57 追加：快照必须带上**完整的方案编排**（4 槽 × 步骤 × 光区）。
 *
 * 只存「当前步骤的光区」会让切回来之后其它方案 / 步骤变成空白——用户花
 * 十分钟搭的多步骤方案看起来就丢了。
 */
describe("完整编排快照（#57）", () => {
  beforeEach(() => clearAllSnapshots());

  function drafts(): ScriptDraft[] {
    return [
      {
        scriptId: 0,
        stages: [
          { durationInput: "1000", segments: [spec(0, 0, 9)] },
          { durationInput: "2000", segments: [spec(0, 0, 4), spec(1, 5, 9)] },
        ],
      },
      {
        scriptId: 1,
        stages: [{ durationInput: "3000", segments: [spec(0, 0, 29)] }],
      },
      { scriptId: 2, stages: [{ durationInput: "1000", segments: [] }] },
      { scriptId: 3, stages: [{ durationInput: "1000", segments: [] }] },
    ];
  }

  it("多方案 / 多步骤的编排原样取回", () => {
    saveCustomSnapshot("DEV-A", 0, { zones: [], planId: 1, stepIndex: 0, drafts: drafts() });
    const snap = takeCustomSnapshot("DEV-A", 0)!;
    expect(snap.drafts).toHaveLength(4);
    expect(snap.drafts![0].stages).toHaveLength(2);
    expect(snap.drafts![0].stages[1].segments).toHaveLength(2);
    expect(snap.drafts![1].stages[0].segments[0].end).toBe(29);
  });

  it("步骤时长输入原样保留（不把「1000」变成数字丢弃中间态）", () => {
    saveCustomSnapshot("DEV-A", 0, { zones: [], planId: 0, stepIndex: 0, drafts: drafts() });
    expect(takeCustomSnapshot("DEV-A", 0)!.drafts![0].stages[1].durationInput).toBe("2000");
  });

  it("取回的是深拷贝：改返回的草稿不会污染快照", () => {
    saveCustomSnapshot("DEV-A", 0, { zones: [], planId: 0, stepIndex: 0, drafts: drafts() });
    const first = takeCustomSnapshot("DEV-A", 0)!;
    const firstStage = first.drafts![0].stages[0];
    firstStage.durationInput = "9999";
    (firstStage.segments[0] as SegmentSpec).start = 77;
    const second = takeCustomSnapshot("DEV-A", 0)!;
    expect(second.drafts![0].stages[0].durationInput).toBe("1000");
    expect((second.drafts![0].stages[0].segments[0] as SegmentSpec).start).toBe(0);
  });

  it("没传 drafts 时快照仍是合法形状（早期调用点兼容）", () => {
    saveCustomSnapshot("DEV-A", 0, { zones: [spec(0, 0, 9)], planId: 0, stepIndex: 0 });
    const snap = takeCustomSnapshot("DEV-A", 0)!;
    expect(snap.zones).toHaveLength(1);
    expect(snap.drafts).toBeUndefined();
  });
});
