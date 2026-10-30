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
  draftInvalidStageCount,
  draftToScriptConfig,
  downloadProgressText,
  parseStageDuration,
  playbackView,
  removeStage,
  removeStageSegment,
  setStageDuration,
  setStageSegments,
  stageSegmentText,
  typeName,
  upsertStageSegment,
} from "../pages/index/script-view";
import { staticSegment, breathingSegment } from "../utils/protocol/commands";
import { MAX_STAGES, PLAYBACK, SEGMENT_TYPE } from "../utils/protocol/constants";

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

    expect(removeStageSegment(segments, 0).map((s) => s.segId)).toEqual([2]);
    /* 删不存在的槽位返回原数组。 */
    expect(removeStageSegment(segments, 7)).toBe(segments);
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
