/**
 * #32 剧本：命令构造器 / 载荷解析 / 下发计划 / 进度视图 / 校验。
 *
 * 字节期望值直接来自 docs/protocol-testvectors.json（两端共用的唯一真相）：
 * 完整 4 阶段下发序列与失败路径都在那份文件里，这里复现并断言帧序。
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
  rainbowSegment,
  segmentParams,
  staticSegment,
  breathingSegment,
} from "../utils/protocol/commands";
import {
  describeCommand,
  describeScriptProgress,
  describeScriptSummary,
} from "../utils/protocol/describe";
import { encodeFrame } from "../utils/protocol/frame";
import { MAX_SCRIPTS, MAX_STAGES, SEGMENT_TYPE } from "../utils/protocol/constants";
import {
  buildScriptPlan,
  scriptProgressView,
  validateScript,
  type ScriptConfig,
} from "../utils/control/script-plan";

interface VectorCase {
  name: string;
  command?: number;
  seq?: number;
  payload_hex?: string;
  frame_hex: string;
  result_code?: number | null;
  note?: string;
}

const vectors = JSON.parse(
  readFileSync(new URL("../../docs/protocol-testvectors.json", import.meta.url), "utf8"),
) as { cases: VectorCase[] };

function vector(name: string): VectorCase {
  const found = vectors.cases.find((c) => c.name === name);
  expect(found, name).toBeDefined();
  return found as VectorCase;
}

describe("#32 剧本命令构造器与向量逐字节一致", () => {
  it("ScriptBegin / ScriptStage / ScriptCommit / ScriptAbort / QueryScript", () => {
    const begin = vector("script_begin");
    const beginReq = cmdScriptBegin(0, 4, 1);
    expect(bytesToCompactHex(beginReq.payload)).toBe(begin.payload_hex);
    expect(bytesToCompactHex(encodeFrame(beginReq.command, begin.seq as number, beginReq.payload))).toBe(
      begin.frame_hex,
    );

    const stage = vector("script_stage");
    const stageReq = cmdScriptStage(0, 2, 1000);
    expect(bytesToCompactHex(stageReq.payload)).toBe(stage.payload_hex);

    const commit = vector("script_commit");
    expect(bytesToCompactHex(cmdScriptCommit(0).payload)).toBe(commit.payload_hex);

    const abort = vector("script_abort");
    expect(bytesToCompactHex(cmdScriptAbort(0).payload)).toBe(abort.payload_hex);

    const query = vector("query_script");
    expect(bytesToCompactHex(cmdQueryScript(0).payload)).toBe(query.payload_hex);
  });

  it("SetPlayback / ActivateScript", () => {
    const playback = vector("set_playback");
    const req = cmdSetPlayback(1, true);
    expect(bytesToCompactHex(req.payload)).toBe(playback.payload_hex);
    expect(bytesToCompactHex(encodeFrame(req.command, playback.seq as number, req.payload))).toBe(
      playback.frame_hex,
    );

    const activate = vector("activate_script");
    const act = cmdActivateScript(0, true);
    expect(bytesToCompactHex(act.payload)).toBe(activate.payload_hex);
  });

  it("ScriptSegment 静态 10 字节 / 动画 14 字节（整帧 20 字节上限）", () => {
    const staticCase = vector("script_segment_static");
    /* 向量载荷 00000000001D000000FF：script 0 / stage 0 / strip 0 / seg 0 /
     * [0-29] / 静态 / hue 0 / sat 255。 */
    const staticReq = cmdScriptSegment(0, 0, staticSegment(0, 0, 0, 29, 0x0000, 0xff));
    expect(bytesToCompactHex(staticReq.payload)).toBe(staticCase.payload_hex);
    expect(bytesToCompactHex(encodeFrame(staticReq.command, staticCase.seq as number, staticReq.payload))).toBe(
      staticCase.frame_hex,
    );

    const animCase = vector("script_segment_animation");
    /* 向量载荷 000100000009030040FF2C01C000：
     * script 0 / stage 1 / strip 0 / seg 0 / [0-9] / 流光 0x03 /
     * hue 0x4000 / sat 0xFF / period 0x012C (300ms) / tail 0xC0 / flags 0 */
    const animReq = cmdScriptSegment(
      0,
      1,
      {
        ...staticSegment(0, 0, 0, 9, 0x4000, 0xff),
        type: SEGMENT_TYPE.COMET,
        periodMs: 0x012c,
        p5: 0xc0,
        flags: 0,
      },
    );
    expect(bytesToCompactHex(animReq.payload)).toBe(animCase.payload_hex);
    expect(animReq.payload.length).toBe(14);
    expect(animReq.payload.length + 6).toBe(20); /* 整帧正好 20 字节 */
  });

  it("segmentParams 与 SetSegment 的参数块完全相同（不另写一份校验）", () => {
    const seg = breathingSegment(0, 0, 0, 9, 0x0e10, 0xff, 1000, 0x60);
    const params = segmentParams(seg);
    expect(params.length).toBe(7);
    /* 与 ScriptSegment 里 params 起始位置 7 处的内容一致。 */
    const req = cmdScriptSegment(0, 0, seg);
    expect(Array.from(req.payload.slice(7))).toEqual(Array.from(params));
  });

  it("构造器拒绝越界参数（不猜、不静默截断）", () => {
    expect(() => cmdScriptBegin(MAX_SCRIPTS, 4, 1)).toThrow(RangeError);
    expect(() => cmdScriptBegin(0, 0, 1)).toThrow(RangeError);
    expect(() => cmdScriptBegin(0, MAX_STAGES + 1, 1)).toThrow(RangeError);
    expect(() => cmdScriptBegin(0, 4, 0)).toThrow(RangeError);
    expect(() => cmdScriptStage(0, MAX_STAGES, 1000)).toThrow(RangeError);
    expect(() => cmdScriptStage(0, 0, 0)).toThrow(RangeError);
    expect(() => cmdScriptStage(0, 0, 0x10000)).toThrow(RangeError);
    expect(() => cmdSetPlayback(3, true)).toThrow(RangeError);
    expect(() => cmdActivateScript(4, true)).toThrow(RangeError);
    expect(() => cmdQueryScript(4)).toThrow(RangeError);
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
      "ScriptStage script=0 stage=2 duration=1500ms",
    );
    expect(
      describeCommand(
        0x16,
        cmdScriptSegment(0, 1, staticSegment(0, 0, 0, 29, 0x0000, 0xff)).payload,
      ),
    ).toBe("ScriptSegment script=0 stage=1 strip=0 seg=0 range=0-29 type=0x00 hue=0 sat=255");
    expect(describeCommand(0x17, cmdScriptCommit(0).payload)).toBe("ScriptCommit script=0");
    expect(describeCommand(0x18, cmdScriptAbort(0).payload)).toBe("ScriptAbort script=0");
    expect(describeCommand(0x19, cmdActivateScript(0, true).payload)).toBe(
      "ActivateScript script=0 loop=1",
    );
    expect(describeCommand(0x1a, cmdQueryScript(0).payload)).toBe("QueryScript script=0");
  });
});

describe("#32 设备回报帧解析", () => {
  it("ScriptSummary 0x85", () => {
    const c = vector("script_summary");
    const summary = parseScriptSummary(hexToBytes(c.payload_hex as string));
    expect(summary).toEqual({ scriptId: 0, stageCount: 4, flags: 0x01, active: true });
    expect(describeScriptSummary(summary)).toBe(
      "ScriptSummary script=0 stages=4 loop=1 active=1",
    );
  });

  it("ScriptProgress 0x86", () => {
    const c = vector("script_progress");
    const progress = parseScriptProgress(hexToBytes(c.payload_hex as string));
    expect(progress.framesWritten).toBe(800);
    expect(describeScriptProgress(progress)).toBe("ScriptProgress script=0 frames=800");
  });

  it("长度不符 / active 越界都不「尽量解析」", () => {
    expect(() => parseScriptSummary(new Uint8Array([0, 4, 0]))).toThrow(RangeError);
    expect(() => parseScriptSummary(new Uint8Array([0, 4, 0, 2]))).toThrow(RangeError);
    expect(() => parseScriptProgress(new Uint8Array([0, 1]))).toThrow(RangeError);
  });
});

/** 一套 4 阶段剧本（与向量里的 download 序列同构）。 */
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
          /* 与向量 script_download_segment_s3g1 同参数：呼吸 / 三角波 / 1500ms。 */
          breathingSegment(0, 1, 15, 29, 0x6000, 0x90, 1500, 0x20, 2),
        ],
      },
    ],
  };
}

describe("#32 下发计划（帧序是协议要求）", () => {
  it("完整 4 阶段序列与向量里的 script_download_* 一致", () => {
    const plan = buildScriptPlan(fourStageScript(), { loop: true });
    /* 1 Begin + 4 Stage + 8 Segment + 1 Commit + 1 Activate = 15 帧。 */
    expect(plan.frameCount).toBe(15);

    const kinds = plan.steps.map((s) => s.kind);
    expect(kinds[0]).toBe("begin");
    expect(kinds[kinds.length - 1]).toBe("activate");
    expect(kinds[kinds.length - 2]).toBe("commit");
    expect(kinds.filter((k) => k === "segment").length).toBe(8);

    /* 每一帧都必须能逐字节复现同名向量。 */
    const begin = vector("script_download_begin_4_stages");
    expect(bytesToCompactHex(plan.steps[0].request.payload)).toBe(begin.payload_hex);

    for (let stage = 0; stage < 4; stage += 1) {
      const c = vector(`script_download_stage_${stage}`);
      /* steps[1 + stage] 是第 stage 个 ScriptStage（Segment 紧跟其后）。 */
      const stageStep = plan.steps.find(
        (s) => s.kind === "stage" && s.request.payload[1] === stage,
      );
      expect(stageStep).toBeDefined();
      expect(bytesToCompactHex((stageStep as { request: { payload: Uint8Array } }).request.payload)).toBe(
        c.payload_hex as string,
      );
    }

    /* 段帧：逐个与向量对照（script_download_segment_sXgY）。 */
    for (let stage = 0; stage < 4; stage += 1) {
      for (const segId of [0, 1]) {
        const name = `script_download_segment_s${stage}g${segId}`;
        if (!vectors.cases.some((c) => c.name === name)) {
          continue;
        }
        const c = vector(name);
        const step = plan.steps.find(
          (s) =>
            s.kind === "segment" &&
            s.request.payload[1] === stage &&
            s.request.payload[3] === segId,
        );
        expect(step, name).toBeDefined();
        expect(bytesToCompactHex((step as { request: { payload: Uint8Array } }).request.payload)).toBe(
          c.payload_hex as string,
        );
      }
    }

    const commit = vector("script_download_commit");
    const commitStep = plan.steps.find((s) => s.kind === "commit");
    expect(bytesToCompactHex((commitStep as { request: { payload: Uint8Array } }).request.payload)).toBe(
      commit.payload_hex,
    );

    const activate = vector("script_download_activate_loop");
    const activateStep = plan.steps.find((s) => s.kind === "activate");
    expect(
      bytesToCompactHex((activateStep as { request: { payload: Uint8Array } }).request.payload),
    ).toBe(activate.payload_hex);
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
      .map((s) => `${s.request.payload[2]}:${s.request.payload[3]}`);
    expect(order).toEqual(["0:0", "0:2", "1:0", "1:3"]);
  });
});

describe("#32 下发进度视图", () => {
  it("按已确认帧数推进，帧数是权威（不按 0x86 跳格）", () => {
    const plan = buildScriptPlan(fourStageScript());
    expect(scriptProgressView(plan, 0)).toMatchObject({ done: 0, total: 15, percent: 0, complete: false });
    expect(scriptProgressView(plan, 1).percent).toBe(7);
    expect(scriptProgressView(plan, 15 - 8).percent).toBe(47); /* 7/15 */
    expect(scriptProgressView(plan, 15)).toMatchObject({ percent: 100, complete: true, label: "完成" });
    /* 越界的 done 被钳住（不该把进度条撑爆）。 */
    expect(scriptProgressView(plan, 99)).toMatchObject({ done: 15, percent: 100, complete: true });
  });

  it("当前步的文案来自计划里的标签", () => {
    const plan = buildScriptPlan(fourStageScript());
    const view = scriptProgressView(plan, 1);
    /* done = 1 → 正在发第 2 帧（阶段 1 的时长）。 */
    expect(view.label).toContain("阶段 1");
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

    /* 相邻区间（闭区间）不算重叠。 */
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
