/**
 * #45 剧本容量预检与 v3 校验修正。
 *
 * 两种口径必须同时成立，所以预估结果把它们分开暴露：
 *
 *  1. **文档表格口径**（docs/protocol-v3.md §10.4 的「单套」列）只算
 *     「段记录 + 每阶段每条灯带的 seg_mask」：8 带×8 阶段×8 段两层动画 = 9792 B。
 *     这一列是给人看预算的，省略了阶段头与槽位头。
 *  2. **与固件 encode 完全一致的总字节**（firmware/main/script_blob.c）：
 *     blob 头 8（magic 4 + version 2 + active 1 + flags 1）
 *     + 每个已提交剧本 3（committed / stage_count / strip_count）
 *     + 每阶段 4（duration 2 + fade 2）
 *     + 每阶段每条灯带 1（seg_mask）
 *     + 每条活动段 `3 + (1+paramLen(layer0)) + (1+paramLen(layer1))`。
 *
 * 预检比较的是第 2 个口径（保守，绝不放过固件会拒的剧本）；第 1 个只用于
 * 与文档表格逐字对齐。两者对四个场景的判定完全一致。
 */

import { describe, expect, it } from "vitest";

import {
  SCRIPT_BLOB_MAX_BYTES,
  SCRIPT_TOO_LARGE_HINT,
  buildScriptPlan,
  checkScriptCapacity,
  estimateScriptBlob,
  estimateScriptBlobBytes,
  estimateScriptsTotalBytes,
  validateScript,
  type ScriptConfig,
  type ScriptStageConfig,
} from "../utils/control/script-plan";
import { parseSegmentPayload, staticSegment } from "../utils/protocol/commands";
import { resultText } from "../utils/ble/errors";
import { BLEND, MAX_STRIPS, SEGMENT_TYPE } from "../utils/protocol/constants";
import type { EffectLayer, SegmentSpec } from "../utils/protocol/types";

/** 两层都是动画（呼吸 + 流光）的段：v4 记录宽度 21（3 + 9 + 9，理论最坏）。 */
function animationSegment(stripId: number, segId: number): SegmentSpec {
  const breathing: EffectLayer = {
    type: SEGMENT_TYPE.BREATHING,
    hue: 0,
    sat: 255,
    periodMs: 1000,
    p5: 0,
    flags: 0,
    level: 100,
  };
  const comet: EffectLayer = {
    type: SEGMENT_TYPE.COMET,
    hue: 0,
    sat: 255,
    periodMs: 1000,
    p5: 0,
    flags: 0,
    level: 100,
  };
  /* 每段一颗灯，槽位互不重叠。 */
  return {
    stripId,
    segId,
    start: segId,
    end: segId,
    blend: BLEND.ADD,
    layer0: breathing,
    layer1: comet,
  };
}

/** 静态层 + 动画层：记录宽度 3 + 4 + 8 = 15。 */
function mixedSegment(stripId: number, segId: number): SegmentSpec {
  return {
    stripId,
    segId,
    start: segId,
    end: segId,
    blend: BLEND.MULTIPLY,
    layer0: { type: SEGMENT_TYPE.STATIC, hue: 0, sat: 255, periodMs: 0, p5: 0, flags: 0, level: 100 },
    layer1: { type: SEGMENT_TYPE.RAINBOW, hue: 0, sat: 255, periodMs: 2000, p5: 255, flags: 0, level: 100 },
  };
}

/**
 * 一套 `strips × stages × segs` 的剧本：每个阶段、每条带都放满 `segs` 个段。
 * 段由 `make` 决定宽度（全动画 / 静态+动画）。
 */
function gridScript(
  strips: number,
  stages: number,
  segs: number,
  make: (stripId: number, segId: number) => SegmentSpec,
  scriptId = 0,
): ScriptConfig {
  const oneStage: ScriptStageConfig = { durationMs: 1000, segments: [] };
  for (let strip = 0; strip < strips; strip += 1) {
    for (let seg = 0; seg < segs; seg += 1) {
      oneStage.segments.push(make(strip, seg));
    }
  }
  const stageList: ScriptStageConfig[] = [];
  for (let i = 0; i < stages; i += 1) {
    stageList.push({ durationMs: 1000, segments: oneStage.segments.map((seg) => ({ ...seg })) });
  }
  return { scriptId, stripCount: strips, stages: stageList };
}

describe("#45 容量预估：protocol-v4.md §10.4 的四个场景（记录宽度 21）", () => {
  it("8 带 × 8 阶段 × 8 段，两层全动画：表格 10752 B / 实际 10859 B", () => {
    const estimate = estimateScriptBlob(gridScript(8, 8, 8, animationSegment));
    /* 512 条记录 × 21 B（3 + 9 + 9）；8 带 × 8 阶段 × 1 B seg_mask。 */
    expect(estimate.recordBytes).toBe(512 * 21);
    expect(estimate.maskBytes).toBe(8 * 8);
    expect(estimate.tableBytes).toBe(10816);
    /* 精确总字节 = 8 头 + 3 槽位 + 8×4 阶段头 + 64 mask + 10752 记录。 */
    expect(estimate.stageBytes).toBe(32);
    expect(estimate.total).toBe(8 + 3 + 32 + 64 + 10752);
    expect(estimate.total).toBe(10859);
    expect(estimate.overLimit).toBe(false);
    expect(estimateScriptBlobBytes(gridScript(8, 8, 8, animationSegment))).toBe(10859);
  });

  it("同样形状 ×4 套：远超 16384（单套已在 10KB 量级）", () => {
    const heavy = gridScript(8, 8, 8, animationSegment);
    /* 文档「4 套合计」= 4 × 10752（表格口径，不含 blob 头）。 */
    expect(4 * estimateScriptBlob(heavy).tableBytes).toBe(43264);

    const suites = [0, 1, 2, 3].map((id) => ({ ...heavy, scriptId: id }));
    const total = estimateScriptsTotalBytes(suites);
    /* 精确：8 头 + 4 × (3 槽位 + 32 阶段头 + 64 mask + 10752 记录)。 */
    expect(total).toBe(8 + 4 * (3 + 32 + 64 + 10752));
    expect(total).toBe(43412);
    expect(total).toBeGreaterThan(SCRIPT_BLOB_MAX_BYTES);
    expect(checkScriptCapacity(suites).ok).toBe(false);
  });

  it("2 带 × 4 阶段 × 4 段，两层全动画：表格 680 B", () => {
    const estimate = estimateScriptBlob(gridScript(2, 4, 4, animationSegment));
    expect(estimate.recordBytes).toBe(32 * 21);
    expect(estimate.maskBytes).toBe(2 * 4);
    expect(estimate.tableBytes).toBe(680);
    /* 典型用法远低于 16KB 上限。 */
    expect(estimate.overLimit).toBe(false);
  });

  it("4 带 × 8 阶段 × 8 段，两层全动画：表格 5408 B（4 套 21632 B 超限）", () => {
    const heavy = gridScript(4, 8, 8, animationSegment);
    const estimate = estimateScriptBlob(heavy);
    expect(estimate.recordBytes).toBe(256 * 21);
    expect(estimate.maskBytes).toBe(4 * 8);
    expect(estimate.tableBytes).toBe(5408);
    /* 文档「4 套合计」列：4 × 5408 = 21632（这一列没算 blob 头）。 */
    expect(4 * estimate.tableBytes).toBe(21632);
    const suites = [0, 1, 2, 3].map((id) => ({ ...heavy, scriptId: id }));
    expect(checkScriptCapacity(suites).ok).toBe(false);
  });

  it("1 带 × 4 阶段 × 3 段，一层静态一层动画：表格 208 B", () => {
    const estimate = estimateScriptBlob(gridScript(1, 4, 3, mixedSegment));
    /* 记录 3 + (1+3+1) + (1+7+1) = 17。 */
    expect(estimate.recordBytes).toBe(12 * 17);
    expect(estimate.maskBytes).toBe(4);
    /* 204 记录 + 4 mask。 */
    expect(estimate.tableBytes).toBe(208);
    expect(estimate.overLimit).toBe(false);
  });

  it("空阶段只算 4 字节阶段头 + 每带 1 字节 mask（不写任何记录）", () => {
    const empty: ScriptConfig = {
      scriptId: 0,
      stripCount: 2,
      stages: [{ durationMs: 1000, segments: [] }],
    };
    const estimate = estimateScriptBlob(empty);
    expect(estimate.recordBytes).toBe(0);
    expect(estimate.maskBytes).toBe(2);
    expect(estimate.stageBytes).toBe(4);
    expect(estimate.total).toBe(8 + 3 + 4 + 2);
  });

  it("扁平段（只设层 0）按层 0 宽度估；层 1 按空层 0 计", () => {
    const flat = estimateScriptBlob({
      scriptId: 0,
      stripCount: 1,
      stages: [{ durationMs: 1000, segments: [staticSegment(0, 0, 0, 9, 0, 255)] }],
    });
    /* 静态 + 空：3 + (1+3+1) + 1 = 9（v4 非空层多一个 level 字节）。 */
    expect(flat.recordBytes).toBe(9);
    expect(flat.tableBytes).toBe(10);
  });

  it("超限提示：明确「剧本过大」、给出减少方向、并声明未下发", () => {
    const heavy = gridScript(8, 8, 8, animationSegment);
    const suites = [0, 1, 2, 3].map((id) => ({ ...heavy, scriptId: id }));
    const check = checkScriptCapacity(suites);
    expect(check.ok).toBe(false);
    expect(check.bytes).toBeGreaterThan(check.limit);
    expect(check.limit).toBe(SCRIPT_BLOB_MAX_BYTES);
    expect(check.message).toContain(SCRIPT_TOO_LARGE_HINT);
    expect(check.message).toContain("未下发");
    expect(SCRIPT_TOO_LARGE_HINT).toBe("剧本过大，请减少阶段数/段数/灯带数");
    /* 单套也在上限内：判定按整套 blob，不是按单套。 */
    expect(checkScriptCapacity([heavy]).ok).toBe(true);
  });
});

describe("#45 校验修正：seg_id 每条灯带独立唯一", () => {
  it("8 条灯带各自用 seg_id 0 是合法的（不再按阶段全局唯一）", () => {
    const segments = [];
    for (let strip = 0; strip < MAX_STRIPS; strip += 1) {
      segments.push(staticSegment(strip, 0, 0, 9, 0, 255));
    }
    const script: ScriptConfig = {
      scriptId: 0,
      stripCount: MAX_STRIPS,
      stages: [{ durationMs: 1000, segments }],
    };
    expect(validateScript(script, new Array(MAX_STRIPS).fill(30))).toEqual({ ok: true });
  });

  it("同一条灯带内 seg_id 重复仍然被拒", () => {
    const script: ScriptConfig = {
      scriptId: 0,
      stripCount: 2,
      stages: [
        {
          durationMs: 1000,
          segments: [staticSegment(1, 3, 0, 9, 0, 255), staticSegment(1, 3, 10, 19, 0, 255)],
        },
      ],
    };
    const result = validateScript(script, [30, 30]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain("槽位重复");
    }
  });

  it("两层段的层类型也校验（未知层 / 空 layer0 被拒）", () => {
    const badLayer: ScriptConfig = {
      scriptId: 0,
      stripCount: 1,
      stages: [
        {
          durationMs: 1000,
          segments: [
            {
              stripId: 0,
              segId: 0,
              start: 0,
              end: 9,
              blend: BLEND.OVER,
              layer0: { type: 0x42, hue: 0, sat: 255, periodMs: 0, p5: 0, flags: 0, level: 100 },
              layer1: { type: 0xff, hue: 0, sat: 0, periodMs: 0, p5: 0, flags: 0, level: 0 },
            },
          ],
        },
      ],
    };
    expect(validateScript(badLayer, [30]).ok).toBe(false);

    const emptyLayer0: ScriptConfig = {
      scriptId: 0,
      stripCount: 1,
      stages: [
        {
          durationMs: 1000,
          segments: [
            {
              stripId: 0,
              segId: 0,
              start: 0,
              end: 9,
              blend: BLEND.OVER,
              layer0: { type: 0xff, hue: 0, sat: 0, periodMs: 0, p5: 0, flags: 0, level: 0 },
              layer1: { type: 0xff, hue: 0, sat: 0, periodMs: 0, p5: 0, flags: 0, level: 0 },
            },
          ],
        },
      ],
    };
    expect(validateScript(emptyLayer0, [30]).ok).toBe(false);
  });

  it("阶段时长 0 在客户端就被拦下", () => {
    const zero: ScriptConfig = {
      scriptId: 0,
      stripCount: 1,
      stages: [{ durationMs: 0, segments: [] }],
    };
    const result = validateScript(zero, [30]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain("时长");
    }
  });
});

describe("#45 下发计划仍是 Begin → Stage×N → Segment×M → Commit", () => {
  it("两层段原样进计划：25 字节，layer1 / blend / level 不丢", () => {
    const script: ScriptConfig = {
      scriptId: 2,
      stripCount: 8,
      stages: [{ durationMs: 1000, segments: [animationSegment(7, 7)] }],
    };
    const plan = buildScriptPlan(script, { activate: false });
    expect(plan.steps.map((s) => s.kind)).toEqual(["begin", "stage", "segment", "commit"]);

    const stage = plan.steps.find((s) => s.kind === "stage");
    expect(stage?.request.payload.length).toBe(6);
    /* fade_ms 恒 0（格式预留，无过渡 UI）。 */
    expect((stage?.request.payload[4] ?? 1) | ((stage?.request.payload[5] ?? 1) << 8)).toBe(0);

    const segment = plan.steps.find((s) => s.kind === "segment");
    expect(segment?.request.payload.length).toBe(25);
    expect(segment?.request.payload[2]).toBe(7); /* strip */
    expect(segment?.request.payload[3]).toBe(7); /* seg */
    const spec = parseSegmentPayload(
      (segment as { request: { payload: Uint8Array } }).request.payload.slice(2),
    );
    expect(spec.layer1.type).toBe(SEGMENT_TYPE.COMET);
    expect(spec.blend).toBe(BLEND.ADD);
    expect(spec.layer0.level).toBe(100);
    expect(spec.layer1.level).toBe(100);
  });

  it("声明 8 条灯带的 Begin 帧被接受（v2 的 7 条上限已修）", () => {
    const plan = buildScriptPlan(
      { scriptId: 0, stripCount: 8, stages: [{ durationMs: 1000, segments: [] }] },
      { activate: false },
    );
    expect(plan.steps[0].request.payload[2]).toBe(8);
  });
});

describe("#45 ScriptTooLarge (0x0A) 文案", () => {
  it("说明剧本过大、给出减少方向、并明确设备配置未改变", () => {
    const text = resultText(0x0a);
    expect(text).toContain("剧本过大");
    expect(text).toContain("设备配置未改变");
    expect(text).toContain("阶段数");
  });

  it("其它结果码不受影响", () => {
    expect(resultText(0x01)).toBe("参数非法");
    expect(resultText(0x0a)).not.toContain("0x0a");
  });
});
