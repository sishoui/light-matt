/**
 * 进阶档方案草稿的落盘（`lumen.planDrafts.v1`）。
 *
 * 锁的是「内容只存在本机」这句承诺：草稿必须活过断线、切页与重启，
 * 只在用户显式删除设备时才消失。同时锁住坏数据的容忍策略——损坏的条目
 * 逐条丢弃，不整表失败、不把脏结构写进下发帧。
 */

import { describe, expect, it } from "vitest";

import {
  clearPlanDrafts,
  clearPlanDraftsForDevice,
  loadPlanDrafts,
  PLAN_DRAFTS_KEY,
  planDraftKey,
  savePlanDraft,
  savePlanDrafts,
} from "../utils/control/plan-drafts";
import type { ScriptDraft } from "../utils/control/script-view";
import { NO_EFFECT, SEGMENT_TYPE } from "../utils/protocol/constants";
import { createSessionStorage } from "./helpers/storage";

function draftWithStep(steps: number, hue = 1000): ScriptDraft {
  const segments =
    hue === 0
      ? []
      : [
          {
            stripId: 0,
            segId: 0,
            start: 0,
            end: 9,
            blend: 0,
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
          },
        ];
  return {
    scriptId: 0,
    stages: Array.from({ length: steps }, (_, index) => ({
      durationInput: index === 0 ? "1500" : "1000",
      segments: index === 0 ? segments : [],
    })),
  };
}

describe("草稿键", () => {
  it("同一设备同一灯组同一槽位得到同一个键", () => {
    expect(planDraftKey("DEV-A", 0, 0)).toBe(planDraftKey("DEV-A", 0, 0));
  });

  it("设备 / 灯组 / 槽位任一不同就是不同的键（防串号）", () => {
    const base = planDraftKey("DEV-A", 0, 0);
    expect(planDraftKey("DEV-B", 0, 0)).not.toBe(base);
    expect(planDraftKey("DEV-A", 1, 0)).not.toBe(base);
    expect(planDraftKey("DEV-A", 0, 1)).not.toBe(base);
  });
});

describe("读写", () => {
  it("没有落盘时返回 null（页面据此保留默认草稿）", () => {
    expect(loadPlanDrafts(createSessionStorage(), "DEV-A", 0)).toBeNull();
  });

  it("写入单个槽位后能原样读回（含步骤时长与层亮度）", () => {
    const storage = createSessionStorage();
    savePlanDraft(storage, "DEV-A", 0, 2, draftWithStep(3));

    const drafts = loadPlanDrafts(storage, "DEV-A", 0);
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
    savePlanDrafts(storage, "DEV-A", 0, [
      draftWithStep(1, 1000),
      draftWithStep(2, 2000),
      draftWithStep(3, 3000),
      draftWithStep(4, 4000),
    ]);
    const drafts = loadPlanDrafts(storage, "DEV-A", 0);
    expect(drafts!.map((draft) => draft?.stages.length)).toEqual([1, 2, 3, 4]);
  });

  it("不同灯组互不影响", () => {
    const storage = createSessionStorage();
    savePlanDraft(storage, "DEV-A", 0, 0, draftWithStep(1));
    savePlanDraft(storage, "DEV-A", 1, 0, draftWithStep(5));
    expect(loadPlanDrafts(storage, "DEV-A", 0)![0]?.stages).toHaveLength(1);
    expect(loadPlanDrafts(storage, "DEV-A", 1)![0]?.stages).toHaveLength(5);
  });

  it("不同设备互不影响", () => {
    const storage = createSessionStorage();
    savePlanDraft(storage, "DEV-A", 0, 0, draftWithStep(1));
    savePlanDraft(storage, "DEV-B", 0, 0, draftWithStep(7));
    expect(loadPlanDrafts(storage, "DEV-A", 0)![0]?.stages).toHaveLength(1);
    expect(loadPlanDrafts(storage, "DEV-B", 0)![0]?.stages).toHaveLength(7);
  });

  it("空 deviceKey 不写也不读（没有身份就不落盘）", () => {
    const storage = createSessionStorage();
    savePlanDraft(storage, "", 0, 0, draftWithStep(2));
    savePlanDrafts(storage, "", 0, [draftWithStep(2)]);
    expect(storage.map.has(PLAN_DRAFTS_KEY)).toBe(false);
    expect(loadPlanDrafts(storage, "", 0)).toBeNull();
  });
});

describe("删除", () => {
  it("删设备时按前缀清掉全部灯组与槽位", () => {
    const storage = createSessionStorage();
    savePlanDraft(storage, "DEV-A", 0, 0, draftWithStep(1));
    savePlanDraft(storage, "DEV-A", 0, 3, draftWithStep(3));
    savePlanDraft(storage, "DEV-A", 1, 1, draftWithStep(2));
    savePlanDraft(storage, "DEV-B", 0, 0, draftWithStep(4));

    expect(clearPlanDraftsForDevice(storage, "DEV-A")).toBe(3);
    expect(loadPlanDrafts(storage, "DEV-A", 0)).toBeNull();
    expect(loadPlanDrafts(storage, "DEV-A", 1)).toBeNull();
    /* 别的设备不动。 */
    expect(loadPlanDrafts(storage, "DEV-B", 0)![0]?.stages).toHaveLength(4);
  });

  it("删设备不会误删前缀相同的另一台（DEV-A vs DEV-AB）", () => {
    const storage = createSessionStorage();
    savePlanDraft(storage, "DEV-A", 0, 0, draftWithStep(1));
    savePlanDraft(storage, "DEV-AB", 0, 0, draftWithStep(2));
    clearPlanDraftsForDevice(storage, "DEV-A");
    expect(loadPlanDrafts(storage, "DEV-A", 0)).toBeNull();
    expect(loadPlanDrafts(storage, "DEV-AB", 0)![0]?.stages).toHaveLength(2);
  });

  it("只删一条灯组时保留同设备的其它灯组", () => {
    const storage = createSessionStorage();
    savePlanDraft(storage, "DEV-A", 0, 0, draftWithStep(1));
    savePlanDraft(storage, "DEV-A", 1, 0, draftWithStep(2));
    expect(clearPlanDrafts(storage, "DEV-A", 0)).toBe(1);
    expect(loadPlanDrafts(storage, "DEV-A", 0)).toBeNull();
    expect(loadPlanDrafts(storage, "DEV-A", 1)![0]?.stages).toHaveLength(2);
  });

  it("没有可删的条目时返回 0（不写空表）", () => {
    const storage = createSessionStorage();
    expect(clearPlanDraftsForDevice(storage, "DEV-X")).toBe(0);
    expect(storage.map.has(PLAN_DRAFTS_KEY)).toBe(false);
  });
});

describe("坏数据容忍", () => {
  it("整表 JSON 损坏 → 当空表（不抛错）", () => {
    const storage = createSessionStorage({ [PLAN_DRAFTS_KEY]: "{not json" });
    expect(loadPlanDrafts(storage, "DEV-A", 0)).toBeNull();
    /* 仍能写入（覆盖掉坏表）。 */
    savePlanDraft(storage, "DEV-A", 0, 0, draftWithStep(1));
    expect(loadPlanDrafts(storage, "DEV-A", 0)![0]?.stages).toHaveLength(1);
  });

  it("条目结构不对 → 丢弃该槽位，不影响其它槽位", () => {
    const storage = createSessionStorage({
      [PLAN_DRAFTS_KEY]: JSON.stringify({
        [planDraftKey("DEV-A", 0, 0)]: { scriptId: 0, stages: [] },
        [planDraftKey("DEV-A", 0, 1)]: "garbage",
        [planDraftKey("DEV-A", 0, 2)]: draftWithStep(2),
      }),
    });
    const drafts = loadPlanDrafts(storage, "DEV-A", 0);
    expect(drafts![0]).toBeNull();
    expect(drafts![1]).toBeNull();
    expect(drafts![2]?.stages).toHaveLength(2);
  });

  it("坏光区被丢弃，但整步仍能读回（不因为一条坏段丢掉整个方案）", () => {
    const good = draftWithStep(1);
    const storage = createSessionStorage({
      [PLAN_DRAFTS_KEY]: JSON.stringify({
        [planDraftKey("DEV-A", 0, 0)]: {
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
    const draft = loadPlanDrafts(storage, "DEV-A", 0)![0];
    expect(draft?.stages).toHaveLength(1);
    expect(draft?.stages[0].segments).toHaveLength(1);
    expect(draft?.stages[0].segments[0].segId).toBe(1);
    /* 顺手确认好草稿本身是可解析的（对照）。 */
    expect(good.stages).toHaveLength(1);
  });

  it("读回的形状只含已知字段（脏字段不流进下发帧）", () => {
    const storage = createSessionStorage({
      [PLAN_DRAFTS_KEY]: JSON.stringify({
        [planDraftKey("DEV-A", 0, 0)]: {
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
    const draft = loadPlanDrafts(storage, "DEV-A", 0)![0]!;
    expect(draft).not.toHaveProperty("evil");
    expect(draft.stages[0]).not.toHaveProperty("extra");
    expect(draft.stages[0].segments[0]).not.toHaveProperty("junk");
  });
});
