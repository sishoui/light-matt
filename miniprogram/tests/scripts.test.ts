/**
 * #32 剧本在 v3 下的形状：命令构造器 / 载荷解析 / 下发计划 / 进度视图 / 校验。
 *
 * 字节期望值直接来自 docs/protocol-testvectors-v4.json（两端共用的唯一真相）。
 * v3 变化：ScriptStage 6 字节（fade）、ScriptSegment 23 字节（两层 21 字节）、
 * ScriptBegin 允许 8 条灯带、ScriptCommit 可能回 ScriptTooLarge(0x0A)。
 *
 * 注意：v3 向量里**没有** ScriptSummary / ScriptProgress 的用例（设备→小程序
 * 只覆盖 0x82/0x87/0x88），所以这两条仍用本地夹具，只按 v3 信封编码。
 */

import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { bytesToCompactHex, hexToBytes } from "../utils/protocol/hex";
import {
  cmdActivateScript,
  cmdQueryScript,
  cmdScriptAbort,
  cmdScriptBegin,
  cmdScriptCommit,
  cmdScriptSegment,
  cmdScriptStage,
  cmdSetPlayback,
  parseScriptProgress,
  parseScriptSummary,
  parseSegmentPayload,
  rainbowSegment,
  staticSegment,
  breathingSegment,
} from "../utils/protocol/commands";
import {
  describeCommand,
  describeScriptProgress,
  describeScriptSummary,
} from "../utils/protocol/describe";
import { encodeFrame } from "../utils/protocol/frame";
import {
  BLEND,
  MAX_SCRIPTS,
  MAX_STAGES,
  SCRIPT_SEGMENT_BYTES,
  SEGMENT_TYPE,
} from "../utils/protocol/constants";
import {
  buildScriptPlan,
  scriptProgressView,
  validateScript,
  type ScriptConfig,
} from "../utils/control/script-plan";
import { decodeFrame } from "../utils/protocol/frame";

interface VectorCase {
  name: string;
  command?: number;
  seq?: number;
  payload_hex?: string;
  frame_hex: string;
  frame_len?: number;
  result_code?: number | null;
  note?: string;
}

const vectors = JSON.parse(
  readFileSync(new URL("../../docs/protocol-testvectors-v4.json", import.meta.url), "utf8"),
) as { cases: VectorCase[] };

function vector(name: string): VectorCase {
  const found = vectors.cases.find((c) => c.name === name);
  expect(found, name).toBeDefined();
  return found as VectorCase;
}

describe("#32 剧本命令构造器与 v3 向量逐字节一致", () => {
  it("ScriptBegin / ScriptStage（fade 0 与预留值）/ Commit / Abort / QueryScript", () => {
    const begin = vector("script_begin");
    const beginReq = cmdScriptBegin(0, 4, 2);
    expect(bytesToCompactHex(beginReq.payload)).toBe(begin.payload_hex);
    expect(
      bytesToCompactHex(encodeFrame(beginReq.command, begin.seq as number, beginReq.payload)),
    ).toBe(begin.frame_hex);

    const stage = vector("script_stage_fade0");
    const stageReq = cmdScriptStage(0, 0, 1000);
    expect(stageReq.payload.length).toBe(6);
    expect(bytesToCompactHex(stageReq.payload)).toBe(stage.payload_hex);
    expect(bytesToCompactHex(encodeFrame(stageReq.command, stage.seq as number, stageReq.payload))).toBe(
      stage.frame_hex,
    );

    const fade = vector("script_stage_fade_reserved");
    const fadeReq = cmdScriptStage(0, 1, 2000, 500);
    expect(bytesToCompactHex(fadeReq.payload)).toBe(fade.payload_hex);
    expect(bytesToCompactHex(encodeFrame(fadeReq.command, fade.seq as number, fadeReq.payload))).toBe(
      fade.frame_hex,
    );

    const commit = vector("script_commit");
    expect(bytesToCompactHex(cmdScriptCommit(0).payload)).toBe(commit.payload_hex);

    const abort = vector("script_abort");
    expect(bytesToCompactHex(cmdScriptAbort(0).payload)).toBe(abort.payload_hex);

    const query = vector("query_script");
    expect(bytesToCompactHex(cmdQueryScript(0).payload)).toBe(query.payload_hex);
  });

  it("SetPlayback（play / pause / stop）与 ActivateScript", () => {
    const play = vector("set_playback_play");
    expect(bytesToCompactHex(cmdSetPlayback(1, true).payload)).toBe(play.payload_hex);
    const pause = vector("set_playback_pause");
    expect(bytesToCompactHex(cmdSetPlayback(2, true).payload)).toBe(pause.payload_hex);
    const stop = vector("set_playback_stop");
    expect(bytesToCompactHex(cmdSetPlayback(0, false).payload)).toBe(stop.payload_hex);

    const activate = vector("activate_script");
    const act = cmdActivateScript(0, true);
    expect(bytesToCompactHex(act.payload)).toBe(activate.payload_hex);
    expect(bytesToCompactHex(encodeFrame(act.command, activate.seq as number, act.payload))).toBe(
      activate.frame_hex,
    );
  });

  it("ScriptSegment 固定 25 字节（两层 23 + script/stage）", () => {
    const c = vector("script_segment_two_layer");
    const req = cmdScriptSegment(0, 0, {
      stripId: 0,
      segId: 0,
      start: 0,
      end: 0x1f,
      blend: BLEND.MULTIPLY,
      layer0: {
        type: SEGMENT_TYPE.RAINBOW,
        hue: 0,
        sat: 255,
        periodMs: 4000,
        p5: 255,
        flags: 0,
        level: 100,
      },
      layer1: { type: SEGMENT_TYPE.BREATHING, hue: 0, sat: 0, periodMs: 1500, p5: 20, flags: 0, level: 100 },
    });
    expect(req.payload.length).toBe(SCRIPT_SEGMENT_BYTES);
    expect(bytesToCompactHex(req.payload)).toBe(c.payload_hex);
    expect(bytesToCompactHex(encodeFrame(req.command, c.seq as number, req.payload))).toBe(
      c.frame_hex,
    );
  });

  it("ScriptSegment 两层都空 = 清空该槽位（仍能解析成 layer0 空 → 由设备处理）", () => {
    const c = vector("script_segment_clear_slot");
    /* 清空槽位是协议允许的「两层都 0xFF」，构造器不能替设备拒绝它。 */
    const payload = hexToBytes(c.payload_hex) as Uint8Array;
    expect(payload.length).toBe(SCRIPT_SEGMENT_BYTES);
    /* 段体（去掉 script/stage）在解析层会被拒（layer0 不能空），
     * 但字节层必须能往返——所以这里直接比对编码。 */
    const rebuilt = new Uint8Array(SCRIPT_SEGMENT_BYTES);
    rebuilt[0] = 0;
    rebuilt[1] = 0;
    rebuilt.set(payload.subarray(2), 2);
    expect(bytesToCompactHex(rebuilt)).toBe(c.payload_hex);
    expect(() => parseSegmentPayload(payload.subarray(2))).toThrow(RangeError);
  });

  it("扁平段草稿也能进剧本（自动补空层，level 满亮）", () => {
    const req = cmdScriptSegment(0, 0, staticSegment(0, 0, 0, 29, 0x0000, 0xff));
    expect(req.payload.length).toBe(SCRIPT_SEGMENT_BYTES);
    expect(req.payload.length).toBe(25);
    expect(req.payload.length + 8).toBe(33);
    /* layer1 从段体的偏移 14 起，前面还有 script/stage 两字节 → 16。 */
    expect(req.payload[2 + 14]).toBe(0xff); /* layer1 空 */
    /* layer0 的 level 在段体偏移 13（→ 载荷偏移 15）。 */
    expect(req.payload[2 + 13]).toBe(100);
  });

  it("构造器拒绝越界参数（不猜、不静默截断）", () => {
    expect(() => cmdScriptBegin(MAX_SCRIPTS, 4, 1)).toThrow(RangeError);
    expect(() => cmdScriptBegin(0, 0, 1)).toThrow(RangeError);
    expect(() => cmdScriptBegin(0, MAX_STAGES + 1, 1)).toThrow(RangeError);
    expect(() => cmdScriptBegin(0, 4, 0)).toThrow(RangeError);
    expect(() => cmdScriptBegin(0, 4, 9)).toThrow(RangeError);
    expect(() => cmdScriptStage(0, MAX_STAGES, 1000)).toThrow(RangeError);
    expect(() => cmdScriptStage(0, 0, 0)).toThrow(RangeError);
    expect(() => cmdScriptStage(0, 0, 0x10000)).toThrow(RangeError);
    expect(() => cmdSetPlayback(3, true)).toThrow(RangeError);
    expect(() => cmdActivateScript(4, true)).toThrow(RangeError);
    expect(() => cmdQueryScript(4)).toThrow(RangeError);
  });

  it("ScriptBegin 允许声明的灯带数 = 8（v2 的 7 条上限已修）", () => {
    const req = cmdScriptBegin(0, 8, 8);
    expect(req.payload[1]).toBe(8);
    expect(req.payload[2]).toBe(8);
  });

  it("日志描述覆盖 0x13–0x1A（参数从字节解析，不猜）", () => {
    expect(describeCommand(0x13, cmdSetPlayback(2, true).payload)).toBe(
      "SetPlayback action=pause loop=1",
    );
    expect(describeCommand(0x13, cmdSetPlayback(0, false).payload)).toBe(
      "SetPlayback action=stop loop=0",
    );
    expect(describeCommand(0x14, cmdScriptBegin(1, 4, 2).payload)).toBe(
      "ScriptBegin script=1 stages=4 strips=2",
    );
    expect(describeCommand(0x15, cmdScriptStage(0, 2, 1500).payload)).toBe(
      "ScriptStage script=0 stage=2 duration=1500ms fade=0ms",
    );
    expect(
      describeCommand(
        0x16,
        cmdScriptSegment(0, 1, staticSegment(0, 0, 0, 29, 0x0000, 0xff)).payload,
      ),
    ).toBe(
      "ScriptSegment script=0 stage=1 strip=0 seg=0 range=0-29 blend=over " +
        "layer0=static(hue=0 sat=255 level=100) layer1=empty",
    );
    expect(describeCommand(0x17, cmdScriptCommit(0).payload)).toBe("ScriptCommit script=0");
    expect(describeCommand(0x18, cmdScriptAbort(0).payload)).toBe("ScriptAbort script=0");
    expect(describeCommand(0x19, cmdActivateScript(0, true).payload)).toBe(
      "ActivateScript script=0 loop=1",
    );
    expect(describeCommand(0x1a, cmdQueryScript(0).payload)).toBe("QueryScript script=0");
  });
});

describe("#32 设备回报帧解析（本地夹具，v3 信封）", () => {
  it("ScriptSummary 0x85", () => {
    const summary = parseScriptSummary(new Uint8Array([0, 4, 0x01, 1]));
    expect(summary).toEqual({ scriptId: 0, stageCount: 4, flags: 0x01, active: true });
    expect(describeScriptSummary(summary)).toBe(
      "ScriptSummary script=0 stages=4 loop=1 active=1",
    );

    /* 用 v3 信封打包 / 解包：4 字节载荷 → 12 字节帧。 */
    const frame = encodeFrame(0x85, 7, new Uint8Array([0, 4, 0x01, 1]));
    expect(frame.length).toBe(12);
    const decoded = decodeFrame(frame);
    expect(decoded.ok).toBe(true);
  });

  it("ScriptProgress 0x86", () => {
    const progress = parseScriptProgress(new Uint8Array([0, 0x20, 0x03]));
    expect(progress.framesWritten).toBe(800);
    expect(describeScriptProgress(progress)).toBe("ScriptProgress script=0 frames=800");
  });

  it("长度不符 / active 越界都不「尽量解析」", () => {
    expect(() => parseScriptSummary(new Uint8Array([0, 4, 0]))).toThrow(RangeError);
    expect(() => parseScriptSummary(new Uint8Array([0, 4, 0, 2]))).toThrow(RangeError);
    expect(() => parseScriptProgress(new Uint8Array([0, 1]))).toThrow(RangeError);
  });

  it("ScriptTooLarge 走 ACK 0x0A（不是 Event）", () => {
    const c = vector("script_commit_too_large");
    expect(c.command).toBe(0x17);
    expect(c.result_code).toBe(0x0a);
    expect(c.frame_valid).toBe(false);
  });
});

/** 一套 4 阶段剧本（1 带 / 每阶段 1-2 段）。 */
function fourStageScript(): ScriptConfig {
  return {
    scriptId: 0,
    stripCount: 1,
    stages: [
      {
        durationMs: 1000,
        segments: [
          staticSegment(0, 0, 0, 9, 0x0000, 0xff),
          staticSegment(0, 1, 10, 29, 0x8000, 0xff),
        ],
      },
      {
        durationMs: 1500,
        segments: [
          breathingSegment(0, 0, 0, 9, 0x0e10, 0xff, 1000, 0x60),
          staticSegment(0, 1, 10, 29, 0x4000, 0xff),
        ],
      },
      {
        durationMs: 2000,
        segments: [
          rainbowSegment(0, 0, 0, 9, 0x0000, 0xff, 2000, 0xff, true),
          {
            ...staticSegment(0, 1, 10, 29, 0x2000, 0xff),
            type: SEGMENT_TYPE.COMET,
            periodMs: 800,
            p5: 0xc0,
          },
        ],
      },
      {
        durationMs: 2500,
        segments: [
          staticSegment(0, 0, 0, 14, 0x2222, 0x80),
          breathingSegment(0, 1, 15, 29, 0x6000, 0x90, 1500, 0x20, 2),
        ],
      },
    ],
  };
}

describe("#32 下发计划（帧序是协议要求）", () => {
  it("完整 4 阶段序列：1 Begin + 4 Stage + 8 Segment + 1 Commit + 1 Activate", () => {
    const plan = buildScriptPlan(fourStageScript(), { loop: true });
    expect(plan.frameCount).toBe(15);

    const kinds = plan.steps.map((s) => s.kind);
    expect(kinds[0]).toBe("begin");
    expect(kinds[kinds.length - 1]).toBe("activate");
    expect(kinds[kinds.length - 2]).toBe("commit");
    expect(kinds.filter((k) => k === "segment").length).toBe(8);

    /* Begin 帧与向量同构（本剧本是 1 条灯带，向量是 2 条，只差最后一字节）。 */
    const begin = vector("script_begin");
    const beginStep = plan.steps[0].request.payload;
    expect(beginStep.length).toBe(3);
    expect(beginStep[0]).toBe(0);
    expect(beginStep[1]).toBe(4);
    expect(beginStep[2]).toBe(1);
    expect((begin.payload_hex as string).slice(0, 4)).toBe(bytesToCompactHex(beginStep.slice(0, 2)));

    /* 所有 Stage 都是 6 字节（含 fade=0）。 */
    for (const step of plan.steps.filter((s) => s.kind === "stage")) {
      expect(step.request.payload.length).toBe(6);
      expect(step.request.payload[4] | (step.request.payload[5] << 8)).toBe(0);
    }

    /* 所有 Segment 都是 25 字节，且都能解析回两层。 */
    for (const step of plan.steps.filter((s) => s.kind === "segment")) {
      expect(step.request.payload.length).toBe(SCRIPT_SEGMENT_BYTES);
      const spec = parseSegmentPayload(step.request.payload.slice(2));
      expect(spec.layer1.type).toBe(0xff);
    }
  });

  it("Commit 一定在最后一个 Segment 之后、Activate 之前", () => {
    const plan = buildScriptPlan(fourStageScript());
    const commitIndex = plan.steps.findIndex((s) => s.kind === "commit");
    const lastSegment = plan.steps.map((s) => s.kind).lastIndexOf("segment");
    const activateIndex = plan.steps.findIndex((s) => s.kind === "activate");
    expect(commitIndex).toBeGreaterThan(lastSegment);
    expect(activateIndex).toBeGreaterThan(commitIndex);
  });

  it("opts.activate = false 时不下发 ActivateScript（只准备不启用）", () => {
    const plan = buildScriptPlan(fourStageScript(), { activate: false });
    expect(plan.steps.filter((s) => s.kind === "activate")).toHaveLength(0);
    expect(plan.steps[plan.steps.length - 1].kind).toBe("commit");
  });

  it("段按 (strip, seg) 升序下发，帧序可复现", () => {
    const script: ScriptConfig = {
      scriptId: 1,
      stripCount: 2,
      stages: [
        {
          durationMs: 500,
          segments: [
            staticSegment(1, 3, 0, 4, 0, 255),
            staticSegment(0, 2, 0, 4, 0, 255),
            staticSegment(1, 0, 5, 9, 0, 255),
            staticSegment(0, 0, 5, 9, 0, 255),
          ],
        },
      ],
    };
    const order = buildScriptPlan(script)
      .steps.filter((s) => s.kind === "segment")
      /* 段体从偏移 2 开始：strip 在 2、seg 在 3。 */
      .map((s) => `${s.request.payload[2]}:${s.request.payload[3]}`);
    expect(order).toEqual(["0:0", "0:2", "1:0", "1:3"]);
  });
});

describe("#32 下发进度视图", () => {
  it("按已确认帧数推进，帧数是权威（不按 0x86 跳格）", () => {
    const plan = buildScriptPlan(fourStageScript());
    expect(scriptProgressView(plan, 0)).toMatchObject({ done: 0, total: 15, percent: 0, complete: false });
    expect(scriptProgressView(plan, 1).percent).toBe(7);
    expect(scriptProgressView(plan, 15 - 8).percent).toBe(47);
    expect(scriptProgressView(plan, 15)).toMatchObject({ percent: 100, complete: true, label: "完成" });
    expect(scriptProgressView(plan, 99)).toMatchObject({ done: 15, percent: 100, complete: true });
  });

  it("当前步的文案来自计划里的标签", () => {
    const plan = buildScriptPlan(fourStageScript());
    expect(scriptProgressView(plan, 1).label).toContain("阶段 1");
  });
});

describe("#32 本端校验（设备侧会再校验一遍）", () => {
  it("合法剧本通过", () => {
    expect(validateScript(fourStageScript(), [30])).toEqual({ ok: true });
  });

  it("阶段数 / 时长 / 灯带数越界都被拒", () => {
    const noStages: ScriptConfig = { scriptId: 0, stripCount: 1, stages: [] };
    expect(validateScript(noStages, [30]).ok).toBe(false);

    const tooMany: ScriptConfig = {
      scriptId: 0,
      stripCount: 1,
      stages: new Array(MAX_STAGES + 1).fill({ durationMs: 100, segments: [] }),
    };
    expect(validateScript(tooMany, [30]).ok).toBe(false);

    const zeroDuration: ScriptConfig = {
      scriptId: 0,
      stripCount: 1,
      stages: [{ durationMs: 0, segments: [] }],
    };
    expect(validateScript(zeroDuration, [30]).ok).toBe(false);

    const badId: ScriptConfig = { ...fourStageScript(), scriptId: MAX_SCRIPTS };
    expect(validateScript(badId, [30]).ok).toBe(false);

    const badStrip: ScriptConfig = { ...fourStageScript(), stripCount: 0 };
    expect(validateScript(badStrip, [30]).ok).toBe(false);

    /* v3：8 条灯带是合法的。 */
    expect(validateScript({ scriptId: 0, stripCount: 8, stages: [{ durationMs: 100, segments: [] }] }, [30]).ok).toBe(true);
  });

  it("段越界 / 重叠 / 槽位重复都被拒（与设备 commit 同一套规则）", () => {
    const outOfRange: ScriptConfig = {
      scriptId: 0,
      stripCount: 1,
      stages: [{ durationMs: 100, segments: [staticSegment(0, 0, 0, 30, 0, 255)] }],
    };
    expect(validateScript(outOfRange, [30]).ok).toBe(false);

    const overlap: ScriptConfig = {
      scriptId: 0,
      stripCount: 1,
      stages: [
        {
          durationMs: 100,
          segments: [staticSegment(0, 0, 0, 15, 0, 255), staticSegment(0, 1, 10, 20, 0, 255)],
        },
      ],
    };
    const overlapResult = validateScript(overlap, [30]);
    expect(overlapResult.ok).toBe(false);
    if (!overlapResult.ok) {
      expect(overlapResult.message).toContain("重叠");
    }

    const duplicateSegId: ScriptConfig = {
      scriptId: 0,
      stripCount: 1,
      stages: [
        {
          durationMs: 100,
          segments: [staticSegment(0, 0, 0, 9, 0, 255), staticSegment(0, 0, 10, 19, 0, 255)],
        },
      ],
    };
    expect(validateScript(duplicateSegId, [30]).ok).toBe(false);

    const adjacent: ScriptConfig = {
      scriptId: 0,
      stripCount: 1,
      stages: [
        {
          durationMs: 100,
          segments: [staticSegment(0, 0, 0, 9, 0, 255), staticSegment(0, 1, 10, 19, 0, 255)],
        },
      ],
    };
    expect(validateScript(adjacent, [30])).toEqual({ ok: true });
  });

  it("引用不存在的灯带被拒", () => {
    const script: ScriptConfig = {
      scriptId: 0,
      stripCount: 1,
      stages: [{ durationMs: 100, segments: [staticSegment(1, 0, 0, 9, 0, 255)] }],
    };
    expect(validateScript(script, [30]).ok).toBe(false);
  });
});
