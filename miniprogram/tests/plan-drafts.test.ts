/**
 * 进阶档方案草稿的落盘（`lumen.planDrafts.v1`）。
 *
 * 锁的是「内容只存在本机」这句承诺：草稿必须活过断线、切页与重启，
 * 只在用户显式删除设备时才消失。同时锁住坏数据的容忍策略——损坏的条目
 * 逐条丢弃，不整表失败、不把脏结构写进下发帧。
 *
 * #75 起草稿是**设备级**的：方案属于设备（4 个固定 `script_id`），灯组只是
 * 编辑视角。所以键里不再有灯组维度，同一套方案里各灯组的分区切片共存。
 * 旧键（`deviceKey#stripId#slot`）在第一次读取时一次性迁移：同一槽位取
 * 灯组号最小的那份，其余丢弃。
 */

import { describe, expect, it } from "vitest";

import {
  clearPlanDrafts,
  clearPlanDraftsForDevice,
  loadPlanDrafts,
  migrateLegacyDrafts,
  PLAN_DRAFTS_KEY,
  planDraftKey,
  removePlanDraft,
  savePlanDraft,
  savePlanDrafts,
} from "../utils/control/plan-drafts";
import { createAdvancedDrafts, stepZonesOf, writeStepZones } from "../utils/control/advanced-draft";
import type { ScriptDraft } from "../utils/control/script-view";
import type { ScriptSegment } from "../utils/control/script-plan";
import { buildZoneSpec } from "../utils/control/zone-model";
import { BLEND, NO_EFFECT, SEGMENT_TYPE } from "../utils/protocol/constants";
import { createSessionStorage } from "./helpers/storage";

/** 一条两层的段草稿（`stripId` 决定它属于哪条灯组）。 */
function segment(stripId: number, segId: number, hue: number, start = 0, end = 9): ScriptSegment {
  return {
    stripId,
    segId,
    start,
    end,
    blend: BLEND.OVER,
    layer0: {
      type: SEGMENT_TYPE.STATIC,
      hue,
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

/** 一个分区（给 `writeStepZones` 用）。 */
function zone(stripId: number, segId: number, hue: number) {
  return buildZoneSpec({
    stripId,
    segId,
    start: 0,
    end: 9,
    blend: BLEND.OVER,
    layer0: {
      type: SEGMENT_TYPE.STATIC,
      hue,
      sat: 255,
      periodMs: 0,
      p5: 0,
      flags: 0,
      level: 100,
    },
    layer1: null,
  });
}

/**
 * `steps` 个步骤的草稿；第一步带一条分区（`hue === 0` 时不留分区）。
 *
 * `stripId` 决定那条分区属于哪条灯组——迁移用例靠它区分来源。
 */
function draftWithStep(steps: number, hue = 1000, stripId = 0): ScriptDraft {
  const segments = hue === 0 ? [] : [segment(stripId, 0, hue)];
  return {
    scriptId: 0,
    stages: Array.from({ length: steps }, (_, index) => ({
      durationInput: index === 0 ? "1500" : "1000",
      segments: index === 0 ? segments : [],
    })),
  };
}

/** 读存储里的整张表（断言键形状用）。 */
function storedTable(storage: ReturnType<typeof createSessionStorage>): Record<string, unknown> {
  const raw = storage.map.get(PLAN_DRAFTS_KEY);
  return raw === undefined ? {} : (JSON.parse(raw) as Record<string, unknown>);
}

describe("草稿键", () => {
  it("键是「设备 + 槽位」，不含灯组维度", () => {
    expect(planDraftKey("DEV-A", 0)).toBe("DEV-A#0");
    expect(planDraftKey("DEV-A", 3)).toBe("DEV-A#3");
  });

  it("同一设备同一槽位得到同一个键", () => {
    expect(planDraftKey("DEV-A", 0)).toBe(planDraftKey("DEV-A", 0));
  });

  it("设备 / 槽位任一不同就是不同的键（防串号）", () => {
    const base = planDraftKey("DEV-A", 0);
    expect(planDraftKey("DEV-B", 0)).not.toBe(base);
    expect(planDraftKey("DEV-A", 1)).not.toBe(base);
  });
});

describe("读写（设备级）", () => {
  it("没有落盘时返回 null（页面据此保留默认草稿）", () => {
    expect(loadPlanDrafts(createSessionStorage(), "DEV-A")).toBeNull();
  });

  it("写入单个槽位后能原样读回（含步骤时长与层亮度）", () => {
    const storage = createSessionStorage();
    savePlanDraft(storage, "DEV-A", 2, draftWithStep(3));

    const drafts = loadPlanDrafts(storage, "DEV-A");
    expect(drafts).not.toBeNull();
    expect(drafts).toHaveLength(4);
    expect(drafts![2]?.stages).toHaveLength(3);
    expect(drafts![2]?.stages[0].durationInput).toBe("1500");
    expect(drafts![2]?.stages[0].segments).toHaveLength(1);
    /* 没写过的槽位是 null，不是空草稿。 */
    expect(drafts![0]).toBeNull();
    expect(drafts![3]).toBeNull();
  });

  it("整组写入 4 套后每套各自独立", () => {
    const storage = createSessionStorage();
    savePlanDrafts(storage, "DEV-A", [
      draftWithStep(1, 1000),
      draftWithStep(2, 2000),
      draftWithStep(3, 3000),
      draftWithStep(4, 4000),
    ]);
    const drafts = loadPlanDrafts(storage, "DEV-A");
    expect(drafts!.map((draft) => draft?.stages.length)).toEqual([1, 2, 3, 4]);
  });

  it("一套方案只占一个键（不再是每组一份）", () => {
    const storage = createSessionStorage();
    savePlanDraft(storage, "DEV-A", 0, draftWithStep(1, 1000, 0));
    /* 同一键再写（内容里含两条灯组）也只是覆盖这一个键。 */
    const both = draftWithStep(1, 2000, 0);
    both.stages[0].segments.push(segment(1, 0, 3000));
    savePlanDraft(storage, "DEV-A", 0, both);
    expect(Object.keys(storedTable(storage))).toEqual(["DEV-A#0"]);
    expect(loadPlanDrafts(storage, "DEV-A")![0]!.stages[0].segments).toHaveLength(2);
  });

  it("不同设备互不影响", () => {
    const storage = createSessionStorage();
    savePlanDraft(storage, "DEV-A", 0, draftWithStep(1));
    savePlanDraft(storage, "DEV-B", 0, draftWithStep(7));
    expect(loadPlanDrafts(storage, "DEV-A")![0]?.stages).toHaveLength(1);
    expect(loadPlanDrafts(storage, "DEV-B")![0]?.stages).toHaveLength(7);
  });

  it("草稿的 scriptId 以槽位为准（键是唯一真相）", () => {
    const storage = createSessionStorage();
    const wrongId = { ...draftWithStep(1), scriptId: 3 };
    savePlanDraft(storage, "DEV-A", 1, wrongId);
    expect(loadPlanDrafts(storage, "DEV-A")![1]!.scriptId).toBe(1);
  });

  it("空 deviceKey 不写也不读（没有身份就不落盘）", () => {
    const storage = createSessionStorage();
    savePlanDraft(storage, "", 0, draftWithStep(2));
    savePlanDrafts(storage, "", [draftWithStep(2)]);
    expect(storage.map.has(PLAN_DRAFTS_KEY)).toBe(false);
    expect(loadPlanDrafts(storage, "")).toBeNull();
  });
});

describe("多灯组切片（#75 的靶心）", () => {
  it("两条灯组编辑同一方案的同一步互不覆盖", () => {
    const storage = createSessionStorage();

    /* 灯组 0 先编辑方案① 的第 1 步。 */
    const byStripA = writeStepZones(createAdvancedDrafts()[0], 0, 0, [zone(0, 0, 1000)]);
    savePlanDraft(storage, "DEV-A", 0, byStripA);

    /* 灯组 1 打开同一个方案、编辑同一步；它读到的是设备级草稿（含灯组 0 的切片）。 */
    const opened = loadPlanDrafts(storage, "DEV-A")![0]!;
    expect(stepZonesOf(opened, 0, 0)).toHaveLength(1);
    const byStripB = writeStepZones(opened, 0, 1, [zone(1, 0, 2000)]);
    savePlanDraft(storage, "DEV-A", 0, byStripB);

    /* 从存储再读：两条灯组都在，灯组 0 的内容没有被灯组 1 的写入覆盖。 */
    const final = loadPlanDrafts(storage, "DEV-A")![0]!;
    expect(stepZonesOf(final, 0, 0).map((item) => item.layer0.hue)).toEqual([1000]);
    expect(stepZonesOf(final, 0, 1).map((item) => item.layer0.hue)).toEqual([2000]);

    /* 反过来再写灯组 0，也不影响灯组 1。 */
    const again = writeStepZones(final, 0, 0, [zone(0, 5, 3000)]);
    savePlanDraft(storage, "DEV-A", 0, again);
    const last = loadPlanDrafts(storage, "DEV-A")![0]!;
    expect(stepZonesOf(last, 0, 0).map((item) => item.segId)).toEqual([5]);
    expect(stepZonesOf(last, 0, 1).map((item) => item.layer0.hue)).toEqual([2000]);
  });

  it("灯组 0 编辑方案① 后，灯组 1 在方案① 里看到的是自己的（空）切片", () => {
    const storage = createSessionStorage();
    savePlanDraft(
      storage,
      "DEV-A",
      0,
      writeStepZones(createAdvancedDrafts()[0], 0, 0, [zone(0, 0, 1000)]),
    );
    const draft = loadPlanDrafts(storage, "DEV-A")![0]!;
    expect(stepZonesOf(draft, 0, 1)).toEqual([]);
  });

  it("编辑一个槽位不会动到同设备其它槽位", () => {
    const storage = createSessionStorage();
    savePlanDraft(storage, "DEV-A", 0, draftWithStep(1));
    savePlanDraft(storage, "DEV-A", 1, draftWithStep(5));
    savePlanDraft(storage, "DEV-A", 0, draftWithStep(2));
    const drafts = loadPlanDrafts(storage, "DEV-A")!;
    expect(drafts[0]!.stages).toHaveLength(2);
    expect(drafts[1]!.stages).toHaveLength(5);
  });
});

describe("旧键迁移（一次性）", () => {
  it("migrateLegacyDrafts 是纯函数：不改入参、不碰存储", () => {
    const table = {
      "DEV-A#2#0": draftWithStep(2),
      "DEV-A#0#0": draftWithStep(1),
      "DEV-B#0#0": draftWithStep(5),
    };
    const before = JSON.parse(JSON.stringify(table)) as typeof table;
    const { table: next, changed } = migrateLegacyDrafts("DEV-A", table);
    expect(changed).toBe(true);
    expect(table).toEqual(before);
    expect(next).not.toBe(table);
    expect(Object.keys(next).sort()).toEqual(["DEV-A#0", "DEV-B#0#0"]);
    /* 没有旧键时原样返回同一个对象（避免无谓落盘）。 */
    const clean = { "DEV-A#0": draftWithStep(1) };
    expect(migrateLegacyDrafts("DEV-A", clean)).toEqual({ table: clean, changed: false });
  });

  it("同一槽位有多组旧草稿时取灯组号最小的那份，其余丢弃", () => {
    const storage = createSessionStorage({
      [PLAN_DRAFTS_KEY]: JSON.stringify({
        "DEV-A#3#0": draftWithStep(3),
        "DEV-A#1#0": draftWithStep(1),
        "DEV-A#2#0": draftWithStep(2),
        "DEV-A#0#1": draftWithStep(4),
      }),
    });
    const drafts = loadPlanDrafts(storage, "DEV-A")!;
    expect(drafts[0]!.stages).toHaveLength(1);
    expect(drafts[1]!.stages).toHaveLength(4);
    expect(drafts[2]).toBeNull();
    expect(drafts[3]).toBeNull();
  });

  it("迁移后旧键从存储里消失（不做长期双读）", () => {
    const storage = createSessionStorage({
      [PLAN_DRAFTS_KEY]: JSON.stringify({
        "DEV-A#2#0": draftWithStep(2),
        "DEV-A#0#0": draftWithStep(1),
      }),
    });
    loadPlanDrafts(storage, "DEV-A");
    expect(Object.keys(storedTable(storage))).toEqual(["DEV-A#0"]);
  });

  it("迁移不碰别的设备的旧键", () => {
    const storage = createSessionStorage({
      [PLAN_DRAFTS_KEY]: JSON.stringify({
        "DEV-A#1#0": draftWithStep(2),
        "DEV-B#1#0": draftWithStep(6),
      }),
    });
    const drafts = loadPlanDrafts(storage, "DEV-A")!;
    expect(drafts[0]!.stages).toHaveLength(2);
    expect(Object.keys(storedTable(storage)).sort()).toEqual(["DEV-A#0", "DEV-B#1#0"]);
    /* 另一台设备轮到自己时也能迁移。 */
    expect(loadPlanDrafts(storage, "DEV-B")![0]!.stages).toHaveLength(6);
    expect(Object.keys(storedTable(storage)).sort()).toEqual(["DEV-A#0", "DEV-B#0"]);
  });

  it("坏掉的旧条目跳过，顺延到下一个灯组号", () => {
    const storage = createSessionStorage({
      [PLAN_DRAFTS_KEY]: JSON.stringify({
        "DEV-A#0#0": "garbage",
        "DEV-A#1#0": { scriptId: 0, stages: [] },
        "DEV-A#2#0": draftWithStep(3),
      }),
    });
    const drafts = loadPlanDrafts(storage, "DEV-A")!;
    expect(drafts[0]!.stages).toHaveLength(3);
    expect(Object.keys(storedTable(storage))).toEqual(["DEV-A#0"]);
  });

  it("旧键全是坏数据时清掉它们并返回 null（不当成「有草稿」）", () => {
    const storage = createSessionStorage({
      [PLAN_DRAFTS_KEY]: JSON.stringify({ "DEV-A#0#0": "garbage" }),
    });
    expect(loadPlanDrafts(storage, "DEV-A")).toBeNull();
    expect(storedTable(storage)).toEqual({});
  });

  it("新键已存在时以新键为准，旧键仍被清掉", () => {
    const storage = createSessionStorage({
      [PLAN_DRAFTS_KEY]: JSON.stringify({
        "DEV-A#0": draftWithStep(7),
        "DEV-A#0#0": draftWithStep(1),
      }),
    });
    const drafts = loadPlanDrafts(storage, "DEV-A")!;
    expect(drafts[0]!.stages).toHaveLength(7);
    expect(Object.keys(storedTable(storage))).toEqual(["DEV-A#0"]);
  });

  it("迁移后草稿的 scriptId 以槽位为准", () => {
    const storage = createSessionStorage({
      [PLAN_DRAFTS_KEY]: JSON.stringify({
        "DEV-A#0#2": { ...draftWithStep(1), scriptId: 0 },
      }),
    });
    expect(loadPlanDrafts(storage, "DEV-A")![2]!.scriptId).toBe(2);
  });

  it("槽位越界的旧键不迁移（协议只有 4 套），随旧键一起清掉", () => {
    const storage = createSessionStorage({
      [PLAN_DRAFTS_KEY]: JSON.stringify({
        "DEV-A#0#9": draftWithStep(2),
        "DEV-A#0#1": draftWithStep(3),
      }),
    });
    const drafts = loadPlanDrafts(storage, "DEV-A")!;
    expect(drafts[1]!.stages).toHaveLength(3);
    expect(drafts.filter((draft) => draft !== null)).toHaveLength(1);
    expect(Object.keys(storedTable(storage))).toEqual(["DEV-A#1"]);
  });

  it("迁移只发生一次：第二次读不写存储", () => {
    const storage = createSessionStorage({
      [PLAN_DRAFTS_KEY]: JSON.stringify({ "DEV-A#1#0": draftWithStep(2) }),
    });
    loadPlanDrafts(storage, "DEV-A");
    const afterFirst = storage.map.get(PLAN_DRAFTS_KEY);
    loadPlanDrafts(storage, "DEV-A");
    expect(storage.map.get(PLAN_DRAFTS_KEY)).toBe(afterFirst);
  });
});

describe("删除", () => {
  it("删设备时按前缀清掉全部槽位与残留旧键", () => {
    const storage = createSessionStorage();
    savePlanDraft(storage, "DEV-A", 0, draftWithStep(1));
    savePlanDraft(storage, "DEV-A", 3, draftWithStep(3));
    const table = storedTable(storage);
    table["DEV-A#1#2"] = draftWithStep(9); /* 没迁移过的旧键 */
    storage.set(PLAN_DRAFTS_KEY, JSON.stringify(table));
    savePlanDraft(storage, "DEV-B", 0, draftWithStep(4));

    expect(clearPlanDraftsForDevice(storage, "DEV-A")).toBe(3);
    expect(loadPlanDrafts(storage, "DEV-A")).toBeNull();
    /* 别的设备不动。 */
    expect(loadPlanDrafts(storage, "DEV-B")![0]?.stages).toHaveLength(4);
  });

  it("删设备不会误删前缀相同的另一台（DEV-A vs DEV-AB）", () => {
    const storage = createSessionStorage();
    savePlanDraft(storage, "DEV-A", 0, draftWithStep(1));
    savePlanDraft(storage, "DEV-AB", 0, draftWithStep(2));
    clearPlanDraftsForDevice(storage, "DEV-A");
    expect(loadPlanDrafts(storage, "DEV-A")).toBeNull();
    expect(loadPlanDrafts(storage, "DEV-AB")![0]?.stages).toHaveLength(2);
  });

  it("按设备清 4 套草稿（含旧键形态）", () => {
    const storage = createSessionStorage();
    savePlanDraft(storage, "DEV-A", 0, draftWithStep(1));
    savePlanDraft(storage, "DEV-A", 2, draftWithStep(2));
    const table = storedTable(storage);
    table["DEV-A#1#0"] = draftWithStep(3);
    storage.set(PLAN_DRAFTS_KEY, JSON.stringify(table));
    savePlanDraft(storage, "DEV-B", 0, draftWithStep(4));

    expect(clearPlanDrafts(storage, "DEV-A")).toBe(3);
    expect(loadPlanDrafts(storage, "DEV-A")).toBeNull();
    expect(loadPlanDrafts(storage, "DEV-B")![0]?.stages).toHaveLength(4);
  });

  it("没有可删的条目时返回 0（不写空表）", () => {
    const storage = createSessionStorage();
    expect(clearPlanDraftsForDevice(storage, "DEV-X")).toBe(0);
    expect(clearPlanDrafts(storage, "DEV-X")).toBe(0);
    expect(storage.map.has(PLAN_DRAFTS_KEY)).toBe(false);
  });
});

describe("删除单套方案草稿（#83）", () => {
  it("只删这一套，别的方案与编号原样保留", () => {
    const storage = createSessionStorage();
    savePlanDraft(storage, "DEV-A", 0, draftWithStep(1));
    savePlanDraft(storage, "DEV-A", 1, draftWithStep(2));
    savePlanDraft(storage, "DEV-A", 3, draftWithStep(4));

    expect(removePlanDraft(storage, "DEV-A", 1)).toBe(true);
    const drafts = loadPlanDrafts(storage, "DEV-A")!;
    expect(drafts[0]?.stages).toHaveLength(1);
    /* 删掉②之后 ③ 仍在**它自己的编号**上，没有搬到 ②。 */
    expect(drafts[1]).toBeNull();
    expect(drafts[3]?.stages).toHaveLength(4);
  });

  it("没存过的槽位返回 false（不写空表、不误报）", () => {
    const storage = createSessionStorage();
    savePlanDraft(storage, "DEV-A", 0, draftWithStep(1));
    const before = storage.map.get(PLAN_DRAFTS_KEY);
    expect(removePlanDraft(storage, "DEV-A", 2)).toBe(false);
    expect(storage.map.get(PLAN_DRAFTS_KEY)).toBe(before);
  });

  it("设备键为空时什么都不做", () => {
    const storage = createSessionStorage();
    savePlanDraft(storage, "DEV-A", 0, draftWithStep(1));
    expect(removePlanDraft(storage, "", 0)).toBe(false);
    expect(loadPlanDrafts(storage, "DEV-A")![0]?.stages).toHaveLength(1);
  });

  it("删掉后再新建同一个编号能正常落盘（复用的键不残留旧内容）", () => {
    const storage = createSessionStorage();
    savePlanDraft(storage, "DEV-A", 1, draftWithStep(5));
    expect(removePlanDraft(storage, "DEV-A", 1)).toBe(true);
    savePlanDraft(storage, "DEV-A", 1, draftWithStep(1));
    expect(loadPlanDrafts(storage, "DEV-A")![1]?.stages).toHaveLength(1);
  });

  it("只删本机这套，别的设备完全不受影响", () => {
    const storage = createSessionStorage();
    savePlanDraft(storage, "DEV-A", 0, draftWithStep(2));
    savePlanDraft(storage, "DEV-B", 0, draftWithStep(3));
    removePlanDraft(storage, "DEV-A", 0);
    expect(loadPlanDrafts(storage, "DEV-A")).toBeNull();
    expect(loadPlanDrafts(storage, "DEV-B")![0]?.stages).toHaveLength(3);
  });
});

describe("坏数据容忍", () => {
  it("整表 JSON 损坏 → 当空表（不抛错）", () => {
    const storage = createSessionStorage({ [PLAN_DRAFTS_KEY]: "{not json" });
    expect(loadPlanDrafts(storage, "DEV-A")).toBeNull();
    /* 仍能写入（覆盖掉坏表）。 */
    savePlanDraft(storage, "DEV-A", 0, draftWithStep(1));
    expect(loadPlanDrafts(storage, "DEV-A")![0]?.stages).toHaveLength(1);
  });

  it("条目结构不对 → 丢弃该槽位，不影响其它槽位", () => {
    const storage = createSessionStorage({
      [PLAN_DRAFTS_KEY]: JSON.stringify({
        [planDraftKey("DEV-A", 0)]: { scriptId: 0, stages: [] },
        [planDraftKey("DEV-A", 1)]: "garbage",
        [planDraftKey("DEV-A", 2)]: draftWithStep(2),
      }),
    });
    const drafts = loadPlanDrafts(storage, "DEV-A");
    expect(drafts![0]).toBeNull();
    expect(drafts![1]).toBeNull();
    expect(drafts![2]?.stages).toHaveLength(2);
  });

  it("坏分区被丢弃，但整步仍能读回（不因为一条坏段丢掉整个方案）", () => {
    const good = draftWithStep(1);
    const storage = createSessionStorage({
      [PLAN_DRAFTS_KEY]: JSON.stringify({
        [planDraftKey("DEV-A", 0)]: {
          scriptId: 0,
          stages: [
            {
              durationInput: "1000",
              segments: [
                { stripId: 0, segId: 0, start: 5, end: 1 }, /* start > end：坏 */
                { stripId: 0, segId: 1, start: 0, end: 3, layer0: { type: 0 }, layer1: { type: 255 } },
              ],
            },
          ],
        },
      }),
    });
    const draft = loadPlanDrafts(storage, "DEV-A")![0];
    expect(draft?.stages).toHaveLength(1);
    expect(draft?.stages[0].segments).toHaveLength(1);
    expect(draft?.stages[0].segments[0].segId).toBe(1);
    /* 顺手确认好草稿本身是可解析的（对照）。 */
    expect(good.stages).toHaveLength(1);
  });

  it("读回的形状只含已知字段（脏字段不流进下发帧）", () => {
    const storage = createSessionStorage({
      [PLAN_DRAFTS_KEY]: JSON.stringify({
        [planDraftKey("DEV-A", 0)]: {
          scriptId: 0,
          evil: "ignore me",
          stages: [
            {
              durationInput: "1000",
              extra: true,
              segments: [
                {
                  stripId: 0,
                  segId: 0,
                  start: 0,
                  end: 3,
                  blend: 0,
                  junk: 42,
                  layer0: { type: 0, hue: 5, sat: 255, periodMs: 0, p5: 0, flags: 0, level: 100 },
                  layer1: { type: 255, hue: 0, sat: 0, periodMs: 0, p5: 0, flags: 0, level: 0 },
                },
              ],
            },
          ],
        },
      }),
    });
    const draft = loadPlanDrafts(storage, "DEV-A")![0]!;
    expect(draft).not.toHaveProperty("evil");
    expect(draft.stages[0]).not.toHaveProperty("extra");
    expect(draft.stages[0].segments[0]).not.toHaveProperty("junk");
  });
});
