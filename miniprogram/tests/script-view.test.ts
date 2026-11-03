/**
 * #32 剧本编辑器（页面侧纯逻辑）：草稿增删改、行视图、草稿 → 下发配置、
 * 播放状态展示。
 *
 * 页面只持有状态与转发事件；所有判定都在这些纯函数里，所以这里测的就是
 * 页面真正的行为。
 */

import { describe, expect, it } from "vitest";

import {
  addStage,
  buildScriptStageRows,
  createScriptDraft,
  createScriptDrafts,
  draftCapacityBytes,
  draftInvalidStageCount,
  draftToScriptConfig,
  downloadProgressText,
  moveStage,
  parseStageDuration,
  playbackView,
  removeStage,
  removeStageSegment,
  replaceScriptDraft,
  scriptCapacitySlots,
  scriptDraftOf,
  scriptSummaryRow,
  setStageDuration,
  setStageSegments,
  stageSegmentText,
  stageStripSummary,
  stageStripText,
  SUMMARY_ONLY_NOTE,
  summaryReadErrorText,
  typeName,
  upsertStageSegment,
  usedSegIds,
} from "../utils/control/script-view";
import { staticSegment, breathingSegment } from "../utils/protocol/commands";
import { BLEND, MAX_STAGES, PLAYBACK, SEGMENT_TYPE } from "../utils/protocol/constants";
import {
  checkScriptBlobBytes,
  estimateScriptBlobBytes,
  SCRIPT_BLOB_MAX_BYTES,
} from "../utils/control/script-plan";
import type { SegmentSpec } from "../utils/protocol/types";

describe("#32 剧本草稿", () => {
  it("新建草稿默认 4 个 1000ms 的空阶段（票面要求的最小形状）", () => {
    const draft = createScriptDraft();
    expect(draft.scriptId).toBe(0);
    expect(draft.stages).toHaveLength(4);
    for (const stage of draft.stages) {
      expect(stage.durationInput).toBe("1000");
      expect(stage.segments).toEqual([]);
    }
  });

  it("script_id 被钳到 0-3", () => {
    expect(createScriptDraft(-1).scriptId).toBe(0);
    expect(createScriptDraft(99).scriptId).toBe(3);
  });

  it("4 个槽位各一份独立草稿：编辑第 2 套不覆盖第 1 套", () => {
    let drafts = createScriptDrafts();
    expect(drafts).toHaveLength(4);
    expect(drafts.map((d) => d.scriptId)).toEqual([0, 1, 2, 3]);

    const second = setStageDuration(scriptDraftOf(drafts, 1), 0, "2500");
    drafts = replaceScriptDraft(drafts, second);
    expect(scriptDraftOf(drafts, 1).stages[0].durationInput).toBe("2500");
    /* 别的槽位原样。 */
    expect(scriptDraftOf(drafts, 0).stages[0].durationInput).toBe("1000");
    expect(scriptDraftOf(drafts, 2).stages[0].durationInput).toBe("1000");

    /* 非法 id 钳到 0（只兜底，页面不会给）。 */
    expect(scriptDraftOf(drafts, 99).scriptId).toBe(3);
    expect(scriptDraftOf(drafts, -1).scriptId).toBe(0);
  });

  it("时长输入校验：空 / 0 / 越界 / 非整数都非法", () => {
    expect(parseStageDuration("1000")).toEqual({ ok: true, value: 1000 });
    expect(parseStageDuration(" 250 ")).toEqual({ ok: true, value: 250 });
    expect(parseStageDuration("").ok).toBe(false);
    expect(parseStageDuration("0").ok).toBe(false);
    expect(parseStageDuration("abc").ok).toBe(false);
    expect(parseStageDuration("1.5").ok).toBe(false);
    expect(parseStageDuration("65536").ok).toBe(false);
    expect(parseStageDuration("65535")).toEqual({ ok: true, value: 65535 });
  });

  it("加阶段上限 8；删阶段至少留 1 个", () => {
    let draft = createScriptDraft();
    for (let i = 0; i < 10; i += 1) {
      draft = addStage(draft);
    }
    expect(draft.stages).toHaveLength(MAX_STAGES);

    let trimmed = draft;
    for (let i = 0; i < 10; i += 1) {
      trimmed = removeStage(trimmed, 0);
    }
    expect(trimmed.stages).toHaveLength(1);
  });

  it("改时长 / 改段列表都是不可变更新（便于 setData 比较）", () => {
    const draft = createScriptDraft();
    const edited = setStageDuration(draft, 1, "2500");
    expect(edited).not.toBe(draft);
    expect(edited.stages[1].durationInput).toBe("2500");
    expect(draft.stages[1].durationInput).toBe("1000");

    const withSeg = setStageSegments(edited, 1, [staticSegment(0, 0, 0, 9, 0, 255)]);
    expect(withSeg.stages[1].segments).toHaveLength(1);
    expect(edited.stages[1].segments).toHaveLength(0);

    /* 下标越界不改任何东西（返回原对象）。 */
    expect(setStageDuration(draft, 99, "1")).toBe(draft);
    expect(setStageSegments(draft, -1, [])).toBe(draft);
  });

  it("同槽位是替换，不同槽位按 (strip, seg) 排序", () => {
    const a = staticSegment(0, 0, 0, 9, 0, 255);
    const b = staticSegment(0, 2, 10, 19, 0, 255);
    let segments = upsertStageSegment([], b);
    segments = upsertStageSegment(segments, a);
    expect(segments.map((s) => s.segId)).toEqual([0, 2]);

    /* 同 segId 更新参数：不新增，只替换。 */
    const a2 = breathingSegment(0, 0, 0, 9, 0, 255, 1000, 0);
    segments = upsertStageSegment(segments, a2);
    expect(segments).toHaveLength(2);
    expect(segments.find((s) => s.segId === 0)?.type).toBe(SEGMENT_TYPE.BREATHING);

    expect(removeStageSegment(segments, 0, 0).map((s) => s.segId)).toEqual([2]);
    /* 删不存在的槽位返回原数组。 */
    expect(removeStageSegment(segments, 0, 7)).toBe(segments);
  });

  it("槽位按 (stripId, segId) 计：跨带同号槽位是两条段，不互相覆盖", () => {
    const strip0 = staticSegment(0, 3, 0, 9, 0, 255);
    const strip1 = staticSegment(1, 3, 0, 9, 0, 255);
    let segments = upsertStageSegment([], strip0);
    segments = upsertStageSegment(segments, strip1);
    expect(segments).toHaveLength(2);
    expect(segments.map((s) => `${s.stripId}:${s.segId}`)).toEqual(["0:3", "1:3"]);

    /* 删除必须带 stripId：只删带 1 的那条。 */
    const afterRemove = removeStageSegment(segments, 1, 3);
    expect(afterRemove).toHaveLength(1);
    expect(afterRemove[0].stripId).toBe(0);

    /* usedSegIds 也按灯带过滤。 */
    expect(usedSegIds(segments, 0)).toEqual([3]);
    expect(usedSegIds(segments, 1)).toEqual([3]);
    expect(usedSegIds(segments, 2)).toEqual([]);
  });

  it("8 条带各自 seg_id 0 都能进同一阶段（v3 槽位维度）", () => {
    let segments: ReturnType<typeof upsertStageSegment> = [];
    for (let strip = 0; strip < 8; strip += 1) {
      segments = upsertStageSegment(segments, staticSegment(strip, 0, 0, 9, 0, 255));
    }
    expect(segments).toHaveLength(8);
  });

  it("阶段行视图带非法时长标记与当前编辑态", () => {
    let draft = createScriptDraft();
    draft = setStageDuration(draft, 2, "0");
    const rows = buildScriptStageRows(draft, 1);
    expect(rows).toHaveLength(4);
    expect(rows[1].active).toBe(true);
    expect(rows[0].active).toBe(false);
    expect(rows[2].invalid).toBe(true);
    expect(rows[0].invalid).toBe(false);
    expect(rows[0].title).toBe("阶段 1");
    expect(draftInvalidStageCount(draft)).toBe(1);
    /* 首末标记供重排按钮禁用。 */
    expect(rows[0].first).toBe(true);
    expect(rows[3].last).toBe(true);
    expect(rows[1].first).toBe(false);
  });

  it("跨带预览：每带段数摘要，不逐颗预览像素", () => {
    const rows = buildScriptStageRows(
      setStageSegments(createScriptDraft(), 0, [
        staticSegment(0, 0, 0, 9, 0, 255),
        staticSegment(0, 1, 10, 19, 0, 255),
        staticSegment(2, 0, 0, 9, 0, 255),
      ]),
      0,
    );
    expect(rows[0].stripText).toBe("带 1×2 · 带 3×1");
    expect(rows[0].strips).toEqual([0, 2]);
    expect(rows[1].stripText).toBe("无段");
    expect(stageStripSummary([])).toEqual([]);
    expect(stageStripText([staticSegment(1, 5, 0, 4, 0, 255)])).toBe("带 2×1");
  });

  it("重排阶段：上移 / 下移保持数组顺序就是播放顺序", () => {
    let draft = createScriptDraft();
    draft = setStageDuration(draft, 0, "100");
    draft = setStageDuration(draft, 1, "200");
    draft = setStageDuration(draft, 2, "300");

    const moved = moveStage(draft, 2, -1);
    expect(moved.stages.map((s) => s.durationInput)).toEqual(["100", "300", "200", "1000"]);

    const forward = moveStage(moved, 0, 1);
    expect(forward.stages.map((s) => s.durationInput)).toEqual(["300", "100", "200", "1000"]);

    /* 越界 / 非法 delta 返回原对象（页面据此不刷新）。 */
    expect(moveStage(draft, 0, -1)).toBe(draft);
    expect(moveStage(draft, 3, 1)).toBe(draft);
    expect(moveStage(draft, 0, 0)).toBe(draft);
    expect(moveStage(draft, 9, -1)).toBe(draft);
  });

  it("段摘要按类型与区间给出可读文本", () => {
    expect(stageSegmentText([])).toContain("无段");
    const text = stageSegmentText([
      staticSegment(0, 0, 0, 9, 0, 255),
      breathingSegment(0, 1, 10, 29, 0, 255, 1000, 0),
    ]);
    expect(text).toBe("2 段 · 静态 [0-9]、呼吸 [10-29]");
    expect(typeName(SEGMENT_TYPE.RAINBOW)).toBe("彩虹");
    expect(typeName(SEGMENT_TYPE.COMET)).toBe("流光");
    expect(typeName(9)).toBe("0x09");
  });

  it("草稿 → ScriptConfig：非法时长落成 0，交给 validateScript 报原因", () => {
    let draft = createScriptDraft();
    draft = setStageDuration(draft, 0, "1500");
    draft = setStageDuration(draft, 1, "bad");
    draft = setStageSegments(draft, 0, [staticSegment(0, 0, 0, 9, 0, 255)]);
    const config = draftToScriptConfig(draft, 1);
    expect(config.stages[0].durationMs).toBe(1500);
    expect(config.stages[1].durationMs).toBe(0);
    expect(config.stages[0].segments).toHaveLength(1);
    expect(config.stripCount).toBe(1);

    /* stripCount 至少 1（State 未就绪时也不能声明 0 条）。 */
    expect(draftToScriptConfig(draft, 0).stripCount).toBe(1);
  });
});

describe("#32 播放状态展示（State 字节 10-13 是权威）", () => {
  it("停止 / 播放 / 暂停的文案与阶段号", () => {
    const stopped = playbackView(PLAYBACK.STOPPED, 0, 0x02, 0, 4);
    expect(stopped).toMatchObject({ text: "停止", stageText: "阶段 1 / 4", active: true, loop: false });

    const playing = playbackView(PLAYBACK.PLAYING, 2, 0x03, 0, 4);
    expect(playing).toMatchObject({ text: "播放中", stageText: "阶段 3 / 4", loop: true });

    const paused = playbackView(PLAYBACK.PAUSED, 1, 0x02, 0, 4);
    expect(paused).toMatchObject({ text: "已暂停", stageText: "阶段 2 / 4" });
  });

  it("没有激活剧本时明确显示「无激活剧本」（不显示阶段 1 / 0）", () => {
    const view = playbackView(PLAYBACK.STOPPED, 0, 0, 0xff, 4);
    expect(view.active).toBe(false);
    expect(view.stageText).toBe("无激活剧本");
  });

  it("stage_index 超过草稿阶段数时钳住（设备与草稿可能不同步）", () => {
    const view = playbackView(PLAYBACK.PLAYING, 7, 0x02, 0, 2);
    expect(view.stageText).toBe("阶段 2 / 2");
  });
});

describe("#32 下发进度文案", () => {
  it("拼出「下发中 4/15 · <当前步>」", () => {
    expect(downloadProgressText("阶段 2 时长 1500ms", 4, 15)).toBe(
      "下发中 4/15 · 阶段 2 时长 1500ms",
    );
  });
});

describe("#45 摘要读回（v3 只有 4 字节摘要）", () => {
  it("已提交且激活的剧本：阶段数 / 激活 / 循环", () => {
    const row = scriptSummaryRow({ scriptId: 1, stageCount: 4, flags: 0x03, active: true });
    expect(row).toMatchObject({
      scriptId: 1,
      title: "剧本 2",
      committed: true,
      active: true,
      loop: true,
    });
    expect(row.text).toBe("已提交 · 4 阶段 · 激活中 · 循环");
  });

  it("已提交未激活：不臆断 loop（0x85 只对激活剧本报 bit0）", () => {
    const row = scriptSummaryRow({ scriptId: 0, stageCount: 8, flags: 0x00, active: false });
    expect(row).toMatchObject({ committed: true, active: false, loop: false });
    expect(row.text).toBe("已提交 · 8 阶段 · 未激活");
  });

  it("未提交槽位：设备回 stage_count 0", () => {
    const row = scriptSummaryRow({ scriptId: 3, stageCount: 0, flags: 0, active: false });
    expect(row).toMatchObject({ committed: false, active: false, loop: false });
    expect(row.text).toBe("未提交");
  });

  it("限制说明明确「只能读摘要、编辑后需重新下发」", () => {
    expect(SUMMARY_ONLY_NOTE).toContain("摘要");
    expect(SUMMARY_ONLY_NOTE).toContain("重新下发");
    /* 不假装有整份读回。 */
    expect(SUMMARY_ONLY_NOTE).not.toContain("完整读回");
    expect(summaryReadErrorText("超时")).toBe("读取设备剧本摘要失败：超时");
  });
});

describe("#45 两层段进草稿（页面的读-改-写形状）", () => {
  it("两层段按原样参与排序与草稿 → 配置，blend / layer1 不丢", () => {
    const spec: SegmentSpec = {
      stripId: 1,
      segId: 2,
      start: 0,
      end: 9,
      blend: BLEND.ADD,
      layer0: { type: SEGMENT_TYPE.STATIC, hue: 0, sat: 255, periodMs: 0, p5: 0, flags: 0, level: 100 },
      layer1: { type: SEGMENT_TYPE.COMET, hue: 0, sat: 255, periodMs: 1000, p5: 0, flags: 0, level: 100 },
    };
    const draft = setStageSegments(createScriptDraft(), 0, [spec]);
    const config = draftToScriptConfig(draft, 2);
    const kept = config.stages[0].segments[0] as SegmentSpec;
    expect(kept.blend).toBe(BLEND.ADD);
    expect(kept.layer1.type).toBe(SEGMENT_TYPE.COMET);

    /* 摘要只看层 0 的类型（层 1 由调用方另行标注）。 */
    expect(stageSegmentText([spec])).toBe("1 段 · 静态 [0-9]");
  });
});

describe("#45 4 槽位合计容量（§10.4 的上限是整套 blob）", () => {
  /** 8 带 × 8 阶段 × 8 段两层动画（记录 19 B），理论最坏形状。 */
  function heavyDraft(scriptId: number) {
    const segments: SegmentSpec[] = [];
    for (let strip = 0; strip < 8; strip += 1) {
      for (let seg = 0; seg < 8; seg += 1) {
        segments.push({
          stripId: strip,
          segId: seg,
          start: seg,
          end: seg,
          blend: BLEND.ADD,
          layer0: { type: SEGMENT_TYPE.BREATHING, hue: 0, sat: 255, periodMs: 1000, p5: 0, flags: 0, level: 100 },
          layer1: { type: SEGMENT_TYPE.COMET, hue: 0, sat: 255, periodMs: 1000, p5: 0, flags: 0, level: 100 },
        });
      }
    }
    let draft = createScriptDraft(scriptId);
    for (let stage = 0; stage < 8; stage += 1) {
      if (stage >= draft.stages.length) {
        draft = addStage(draft);
      }
      draft = setStageSegments(draft, stage, segments);
    }
    return draft;
  }

  it("只有已提交的槽位参与合计；从没下发的草稿不误拦", () => {
    const drafts = [heavyDraft(0), heavyDraft(1), heavyDraft(2), heavyDraft(3)];
    /* 只有 0 号已提交：合计 ≈ 单套（v4 10859 B），低于 16KB。 */
    const onlyOne = scriptCapacitySlots(drafts, [0], 8);
    expect(onlyOne.map((slot) => slot.scriptId)).toEqual([0]);
    expect(estimateScriptBlobBytes(onlyOne[0])).toBe(10859);
    /* 当前编辑的那套即使还没提交也一定参与：两套满配就已超限。 */
    const withCurrent = draftCapacityBytes(drafts, [0], 2, 8);
    expect(withCurrent).toBe(8 + 2 * (10859 - 8));
    expect(withCurrent).toBeGreaterThan(SCRIPT_BLOB_MAX_BYTES);
    expect(checkScriptBlobBytes(withCurrent).ok).toBe(false);
  });

  it("4 套都很大时合计超限（页面据此禁用下发）", () => {
    const drafts = [heavyDraft(0), heavyDraft(1), heavyDraft(2), heavyDraft(3)];
    const bytes = draftCapacityBytes(drafts, [0, 1, 2, 3], 0, 8);
    expect(bytes).toBe(43412);
    expect(bytes).toBeGreaterThan(SCRIPT_BLOB_MAX_BYTES);
    expect(checkScriptBlobBytes(bytes).ok).toBe(false);
  });

  it("1 条带 × 4 阶段 × 3 段的典型用法远低于上限", () => {
    const drafts = createScriptDrafts();
    expect(draftCapacityBytes(drafts, [0], 0, 1)).toBeLessThan(SCRIPT_BLOB_MAX_BYTES);
  });
});
