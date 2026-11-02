/**
 * #25/#30/#31 段配置在 v3 下的形状：命令构造器 / 载荷解析 / 描述 / 扁平⇄两层。
 *
 * 字节期望值直接来自 docs/protocol-testvectors-v3.json（两端共用的唯一真相），
 * 不在这里另写一份 hex。v3 的段载荷是**固定 21 字节**（两层定宽），
 * 所以「静态 8 / 动画 12」这类 v2 断言已不存在。
 */

import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

import { bytesToCompactHex, hexToBytes } from "../utils/protocol/hex";
import {
  breathingFlags,
  breathingSegment,
  breathingWaveform,
  cmdClearSegment,
  cmdQueryStrip,
  cmdSetSegment,
  cometSegment,
  directionFlags,
  parseSegmentListEnd,
  parseSegmentPayload,
  parseSegmentReport,
  rainbowSegment,
  segmentReverse,
  staticSegment,
} from "../utils/protocol/commands";
import {
  describeSegmentListEnd,
  describeSegmentReport,
} from "../utils/protocol/describe";
import { encodeFrame } from "../utils/protocol/frame";
import {
  ANIMATION_MIN_PERIOD_MS,
  BLEND,
  BREATHING_MIN_PERIOD_MS,
  NO_EFFECT,
  SEGMENT_BYTES,
  SEGMENT_TYPE,
  WAVEFORM,
} from "../utils/protocol/constants";
import type { EffectLayer, SegmentSpec } from "../utils/protocol/types";
import { rgbToSegmentParams, segmentHueSatToRgb } from "../utils/color/hsv";
import {
  activeCount,
  breathingLabel,
  buildSegmentRows,
  cometLabel,
  firstFreeSegId,
  overlapError,
  parseRangeInput,
  rainbowLabel,
  spanText,
  tailText,
} from "../utils/control/segment-view";
import { StripQueryCollector } from "../utils/ble/strip-collector";
import {
  emptyLayer,
  isSegmentSpec,
  specFromReport,
  toFlat,
  toSpec,
} from "../utils/control/segment-model";

interface VectorCase {
  name: string;
  command?: number;
  seq?: number;
  payload_hex?: string;
  frame_hex: string;
  result_code?: number | null;
}

const vectors = JSON.parse(
  readFileSync(new URL("../../docs/protocol-testvectors-v3.json", import.meta.url), "utf8"),
) as { cases: VectorCase[] };

function vector(name: string): VectorCase {
  const found = vectors.cases.find((c) => c.name === name);
  expect(found, name).toBeDefined();
  return found as VectorCase;
}

/** 21 字节单层段（layer1 空、blend 覆盖）。 */
function singleLayer(
  stripId: number,
  segId: number,
  start: number,
  end: number,
  layer0: EffectLayer,
): SegmentSpec {
  return { stripId, segId, start, end, blend: BLEND.OVER, layer0, layer1: emptyLayer() };
}

const STATIC_RED: EffectLayer = { type: 0, hue: 0, sat: 255, periodMs: 0, p5: 0, flags: 0 };

describe("SetSegment 构造器与 v3 向量一致（21 字节定宽）", () => {
  it("单层静态逐字节复现 set_segment_single_static", () => {
    const c = vector("set_segment_single_static");
    const req = cmdSetSegment(singleLayer(0, 0, 0, 9, { ...STATIC_RED }));
    expect(req.command).toBe(0x10);
    expect(req.payload.length).toBe(SEGMENT_BYTES);
    expect(bytesToCompactHex(req.payload)).toBe(c.payload_hex);
    expect(bytesToCompactHex(encodeFrame(req.command, c.seq as number, req.payload))).toBe(
      c.frame_hex,
    );
  });

  it("单层呼吸 / 彩虹 / 流光逐字节复现", () => {
    const cases: Array<[string, SegmentSpec]> = [
      [
        "set_segment_single_breathing",
        singleLayer(1, 2, 10, 29, {
          type: SEGMENT_TYPE.BREATHING,
          hue: 0x5555,
          sat: 200,
          periodMs: 2000,
          p5: 30,
          flags: 0,
        }),
      ],
      [
        "set_segment_single_rainbow",
        singleLayer(2, 0, 0, 63, {
          type: SEGMENT_TYPE.RAINBOW,
          hue: 0,
          sat: 255,
          periodMs: 4000,
          p5: 255,
          flags: 0,
        }),
      ],
      [
        "set_segment_single_comet",
        singleLayer(3, 1, 5, 60, {
          type: SEGMENT_TYPE.COMET,
          hue: 0x7530,
          sat: 255,
          periodMs: 1200,
          p5: 8,
          flags: 1,
        }),
      ],
    ];
    for (const [name, spec] of cases) {
      const c = vector(name);
      const req = cmdSetSegment(spec);
      expect(bytesToCompactHex(req.payload), name).toBe(c.payload_hex);
    }
  });

  it("两层：静态 × 静态（相乘 / 相加）逐字节复现", () => {
    const multiply = vector("set_segment_two_static_multiply");
    const multiplyReq = cmdSetSegment({
      stripId: 0,
      segId: 1,
      start: 10,
      end: 39,
      blend: BLEND.MULTIPLY,
      layer0: STATIC_RED,
      layer1: { type: SEGMENT_TYPE.STATIC, hue: 0, sat: 0x80, periodMs: 0, p5: 0, flags: 0 },
    });
    expect(bytesToCompactHex(multiplyReq.payload)).toBe(multiply.payload_hex);

    const add = vector("set_segment_two_static_add");
    const addReq = cmdSetSegment({
      stripId: 2,
      segId: 0,
      start: 0,
      end: 63,
      blend: BLEND.ADD,
      layer0: { type: SEGMENT_TYPE.STATIC, hue: 0xaaaa, sat: 255, periodMs: 0, p5: 0, flags: 0 },
      layer1: { type: SEGMENT_TYPE.STATIC, hue: 0, sat: 255, periodMs: 0, p5: 0, flags: 0 },
    });
    expect(bytesToCompactHex(addReq.payload)).toBe(add.payload_hex);
  });

  it("两层：彩虹 + 呼吸（相乘）、流光 + 静态（覆盖）", () => {
    const rainbow = vector("set_segment_rainbow_plus_breathing_multiply");
    const req = cmdSetSegment({
      stripId: 0,
      segId: 3,
      start: 0,
      end: 63,
      blend: BLEND.MULTIPLY,
      layer0: {
        type: SEGMENT_TYPE.RAINBOW,
        hue: 0,
        sat: 255,
        periodMs: 4000,
        p5: 255,
        flags: 0,
      },
      layer1: { type: SEGMENT_TYPE.BREATHING, hue: 0, sat: 0, periodMs: 1500, p5: 20, flags: 0 },
    });
    expect(bytesToCompactHex(req.payload)).toBe(rainbow.payload_hex);

    const over = vector("set_segment_comet_plus_static_over");
    const overReq = cmdSetSegment({
      stripId: 1,
      segId: 0,
      start: 0,
      end: 31,
      blend: BLEND.OVER,
      layer0: {
        type: SEGMENT_TYPE.COMET,
        hue: 0x7530,
        sat: 255,
        periodMs: 1200,
        p5: 8,
        flags: 0,
      },
      layer1: { ...STATIC_RED },
    });
    expect(bytesToCompactHex(overReq.payload)).toBe(over.payload_hex);
  });

  it("扁平草稿（页面 API）自动补空层、blend = 覆盖", () => {
    const req = cmdSetSegment(staticSegment(0, 0, 0, 9, 0, 255));
    expect(req.payload.length).toBe(SEGMENT_BYTES);
    /* 扁平输入等价于单层 spec。 */
    expect(bytesToCompactHex(req.payload)).toBe(
      bytesToCompactHex(cmdSetSegment(singleLayer(0, 0, 0, 9, STATIC_RED)).payload),
    );
    /* layer1 区域全 0xFF 开头 + 7 个 0。 */
    expect(req.payload[13]).toBe(NO_EFFECT);
  });

  it("构造器在本端就拒绝非法 blend / 空 layer0 / 未知类型 / 区间", () => {
    /* 空 layer0。 */
    expect(() =>
      cmdSetSegment({ ...singleLayer(0, 0, 0, 5, STATIC_RED), layer0: emptyLayer() }),
    ).toThrow(RangeError);
    /* blend = 3。 */
    expect(() =>
      cmdSetSegment({
        ...singleLayer(0, 0, 0, 5, STATIC_RED),
        blend: 3 as unknown as 0 | 1 | 2,
      }),
    ).toThrow(RangeError);
    /* layer1 为空却带 blend。 */
    expect(() =>
      cmdSetSegment({ ...singleLayer(0, 0, 0, 5, STATIC_RED), blend: BLEND.ADD }),
    ).toThrow(RangeError);
    /* 未知类型。 */
    expect(() =>
      cmdSetSegment({
        ...singleLayer(0, 0, 0, 5, { ...STATIC_RED, type: 0x09 }),
      }),
    ).toThrow(RangeError);
    /* start > end / 越界 / 槽位 / 灯带号。 */
    expect(() => cmdSetSegment(singleLayer(0, 0, 10, 5, STATIC_RED))).toThrow(RangeError);
    expect(() => cmdSetSegment(singleLayer(0, 0, 0, 64, STATIC_RED))).toThrow(RangeError);
    expect(() => cmdSetSegment(singleLayer(0, 8, 0, 5, STATIC_RED))).toThrow(RangeError);
    expect(() => cmdSetSegment(singleLayer(8, 0, 0, 5, STATIC_RED))).toThrow(RangeError);
  });

  it("静态层的 period / p5 / flags 必须为 0（保留语义）", () => {
    expect(() =>
      cmdSetSegment(singleLayer(0, 0, 0, 5, { ...STATIC_RED, periodMs: 100 })),
    ).toThrow(RangeError);
    expect(() =>
      cmdSetSegment(singleLayer(0, 0, 0, 5, { ...STATIC_RED, flags: 1 })),
    ).toThrow(RangeError);
  });

  it("两层往返幂等：encode → parse → encode 字节完全相同", () => {
    const spec: SegmentSpec = {
      stripId: 4,
      segId: 6,
      start: 3,
      end: 40,
      blend: BLEND.MULTIPLY,
      layer0: {
        type: SEGMENT_TYPE.RAINBOW,
        hue: 0x1234,
        sat: 200,
        periodMs: 900,
        p5: 128,
        flags: 0,
      },
      layer1: {
        type: SEGMENT_TYPE.BREATHING,
        hue: 0x4321,
        sat: 100,
        periodMs: 1500,
        p5: 30,
        flags: breathingFlags(WAVEFORM.TRIANGLE),
      },
    };
    const first = cmdSetSegment(spec).payload;
    const parsed = parseSegmentPayload(first);
    const second = cmdSetSegment(parsed).payload;
    expect(bytesToCompactHex(second)).toBe(bytesToCompactHex(first));
    expect(parsed).toEqual(spec);
  });

  it("ClearSegment / QueryStrip 与向量一致", () => {
    const clear = vector("clear_segment");
    const clearReq = cmdClearSegment(0, 3);
    expect(bytesToCompactHex(clearReq.payload)).toBe(clear.payload_hex);
    expect(bytesToCompactHex(encodeFrame(clearReq.command, clear.seq as number, clearReq.payload))).toBe(
      clear.frame_hex,
    );

    const query = vector("query_strip_0");
    const queryReq = cmdQueryStrip(0);
    expect(bytesToCompactHex(queryReq.payload)).toBe(query.payload_hex);
    expect(
      bytesToCompactHex(encodeFrame(queryReq.command, query.seq as number, queryReq.payload)),
    ).toBe(query.frame_hex);

    const query7 = vector("query_strip_7");
    expect(bytesToCompactHex(cmdQueryStrip(7).payload)).toBe(query7.payload_hex);
  });
});

describe("SegmentReport / SegmentListEnd 解析（21 字节）", () => {
  it("静态报告：两层齐全，扁平字段是 layer0 的投影", () => {
    const report = parseSegmentReport(
      hexToBytes("0000000900000000FF00000000FF00000000000000") as Uint8Array,
    );
    expect(report.stripId).toBe(0);
    expect(report.segId).toBe(0);
    expect(report.start).toBe(0);
    expect(report.end).toBe(9);
    expect(report.blend).toBe(BLEND.OVER);
    expect(report.layer0).toEqual({ type: 0, hue: 0, sat: 255, periodMs: 0, p5: 0, flags: 0 });
    expect(report.layer1.type).toBe(NO_EFFECT);
    /* 兼容投影（#41 之前的页面直接读这些字段）。 */
    expect(report.type).toBe(report.layer0.type);
    expect(report.hue).toBe(report.layer0.hue);
    expect(report.sat).toBe(report.layer0.sat);
    expect(report.periodMs).toBe(report.layer0.periodMs);
    expect(report.p5).toBe(report.layer0.p5);
    expect(report.flags).toBe(report.layer0.flags);
  });

  it("两层报告：blend 与两层参数都保留", () => {
    const report = parseSegmentReport(
      hexToBytes("0003003F01020000FFA00FFF0001000000DC051400") as Uint8Array,
    );
    expect(report.blend).toBe(BLEND.MULTIPLY);
    expect(report.layer0.type).toBe(SEGMENT_TYPE.RAINBOW);
    expect(report.layer0.periodMs).toBe(4000);
    expect(report.layer1.type).toBe(SEGMENT_TYPE.BREATHING);
    expect(report.layer1.periodMs).toBe(1500);
    expect(report.layer1.p5).toBe(20);
    /* 扁平投影只取 layer0（#41 之前的单层 UI）。 */
    expect(report.type).toBe(SEGMENT_TYPE.RAINBOW);
  });

  it("日志描述把两层都写出来", () => {
    const report = parseSegmentReport(
      hexToBytes("0003003F01020000FFA00FFF0001000000DC051400") as Uint8Array,
    );
    const text = describeSegmentReport(report);
    expect(text).toContain("SegmentReport strip=0 seg=3 range=0-63 blend=multiply");
    expect(text).toContain("layer0=rainbow(");
    expect(text).toContain("layer1=breathing(");
  });

  it("长度不是 21 / layer0 空 / blend 越界 / start > end 都拒绝", () => {
    expect(() => parseSegmentReport(new Uint8Array(20))).toThrow(RangeError);
    expect(() => parseSegmentReport(new Uint8Array(22))).toThrow(RangeError);

    const empty0 = new Uint8Array(21);
    empty0[5] = NO_EFFECT;
    empty0[13] = NO_EFFECT;
    expect(() => parseSegmentReport(empty0)).toThrow(RangeError);

    const range = new Uint8Array(21);
    range[2] = 9;
    range[3] = 5;
    range[8] = 255;
    range[13] = NO_EFFECT;
    expect(() => parseSegmentReport(range)).toThrow(RangeError);
  });

  it("SegmentListEnd 载荷与描述", () => {
    const end = parseSegmentListEnd(hexToBytes("0007") as Uint8Array);
    expect(end).toEqual({ stripId: 0, segMask: 0x07 });
    expect(describeSegmentListEnd(end)).toBe("SegmentListEnd strip=0 mask=0x07 slots=[0,1,2]");
    expect(() => parseSegmentListEnd(new Uint8Array(3))).toThrow(RangeError);
  });
});

describe("segment-model：扁平 UI ⇄ 两层 spec", () => {
  it("toSpec：layer1 空、blend 覆盖；静态段强制 period/p5/flags 为 0", () => {
    const spec = toSpec({
      stripId: 0,
      segId: 1,
      start: 0,
      end: 9,
      type: SEGMENT_TYPE.STATIC,
      hue: 100,
      sat: 200,
      periodMs: 1234, /* 脏数据：静态段不该有周期 */
      p5: 9,
      flags: 3,
    });
    expect(spec.blend).toBe(BLEND.OVER);
    expect(spec.layer0).toEqual({ type: 0, hue: 100, sat: 200, periodMs: 0, p5: 0, flags: 0 });
    expect(spec.layer1.type).toBe(NO_EFFECT);
  });

  it("toFlat：只投影 layer0，丢弃 layer1 / blend", () => {
    const spec = singleLayer(0, 2, 10, 20, {
      type: SEGMENT_TYPE.BREATHING,
      hue: 7,
      sat: 8,
      periodMs: 900,
      p5: 9,
      flags: 2,
    });
    expect(toFlat(spec)).toEqual({
      stripId: 0,
      segId: 2,
      start: 10,
      end: 20,
      type: SEGMENT_TYPE.BREATHING,
      hue: 7,
      sat: 8,
      periodMs: 900,
      p5: 9,
      flags: 2,
    });
  });

  it("toSpec / toFlat 往返幂等（单层草稿）", () => {
    const flat = breathingSegment(0, 1, 0, 9, 0x0e10, 0xff, 500, 0x60);
    expect(toFlat(toSpec(flat))).toEqual(flat);
  });

  it("isSegmentSpec 只在带 layer0 时为真", () => {
    expect(isSegmentSpec(toSpec(staticSegment(0, 0, 0, 5, 0, 255)))).toBe(true);
    expect(isSegmentSpec(staticSegment(0, 0, 0, 5, 0, 255))).toBe(false);
  });

  it("specFromReport 丢掉扁平投影字段（读-改-写不污染载荷）", () => {
    const report = parseSegmentReport(
      hexToBytes("0003003F01020000FFA00FFF0001000000DC051400") as Uint8Array,
    );
    const spec = specFromReport(report);
    expect(Object.keys(spec).sort()).toEqual([
      "blend",
      "end",
      "layer0",
      "layer1",
      "segId",
      "start",
      "stripId",
    ]);
    const original = hexToBytes("0003003F01020000FFA00FFF0001000000DC051400") as Uint8Array;
    expect(bytesToCompactHex(cmdSetSegment(spec).payload)).toBe(bytesToCompactHex(original));
  });
});

describe("hue/sat ↔ RGB（与固件同一套扇区映射）", () => {
  it("三原色与灰阶", () => {
    expect(segmentHueSatToRgb(0, 255)).toEqual({ r: 255, g: 0, b: 0 });
    expect(segmentHueSatToRgb(21845, 255)).toEqual({ r: 0, g: 255, b: 0 });
    expect(segmentHueSatToRgb(43690, 255)).toEqual({ r: 0, g: 0, b: 255 });
    expect(segmentHueSatToRgb(1234, 0)).toEqual({ r: 255, g: 255, b: 255 });
  });

  it("RGB → 协议参数往返（允许量化误差）", () => {
    const cases = [
      { r: 255, g: 0, b: 0 },
      { r: 0, g: 255, b: 0 },
      { r: 0, g: 0, b: 255 },
      { r: 255, g: 255, b: 0 },
    ];
    for (const rgb of cases) {
      const params = rgbToSegmentParams(rgb);
      expect(params.sat).toBe(255);
      expect(segmentHueSatToRgb(params.hue, params.sat)).toEqual(rgb);
    }
    expect(rgbToSegmentParams({ r: 80, g: 80, b: 80 }).sat).toBe(0);
  });
});

describe("分段编辑器纯逻辑（页面侧不变）", () => {
  it("区间输入：整数、非负、start ≤ end、end < ledCount", () => {
    expect(parseRangeInput("0", "15", 64)).toEqual({ ok: true, start: 0, end: 15, message: "" });
    expect(parseRangeInput("40", "63", 64).ok).toBe(true);
    expect(parseRangeInput("", "15", 64).ok).toBe(false);
    expect(parseRangeInput("0", "", 64).ok).toBe(false);
    expect(parseRangeInput("1.5", "15", 64).ok).toBe(false);
    expect(parseRangeInput("-1", "15", 64).ok).toBe(false);
    expect(parseRangeInput("20", "10", 64).ok).toBe(false);
    const outOfRange = parseRangeInput("0", "64", 64);
    expect(outOfRange.ok).toBe(false);
    expect(outOfRange.message).toContain("超出灯珠范围");
    expect(parseRangeInput("0", "15", 0).ok).toBe(false);
    expect(parseRangeInput("20", "29", 30).ok).toBe(true);
    expect(parseRangeInput("20", "30", 30).ok).toBe(false);
  });

  it("槽位分配：第一个空闲槽位；8 段占满返回 -1", () => {
    expect(firstFreeSegId([])).toBe(0);
    expect(firstFreeSegId([0, 1, 2])).toBe(3);
    expect(firstFreeSegId([1, 3])).toBe(0);
    expect(firstFreeSegId([0, 1, 2, 3, 4, 5, 6, 7])).toBe(-1);
  });

  it("重叠预检：闭区间、相邻不算重叠、可忽略自身", () => {
    const rows = [
      { segId: 0, start: 0, end: 15 },
      { segId: 1, start: 40, end: 63 },
    ];
    expect(overlapError(16, 39, rows)).toBeNull();
    expect(overlapError(15, 16, rows)).not.toBeNull();
    expect(overlapError(40, 63, rows)).not.toBeNull();
    expect(overlapError(40, 63, rows, 1)).toBeNull();
    expect(overlapError(0, 15, rows, 0)).toBeNull();
    expect(overlapError(5, 45, rows)).toContain("段 0");
  });

  it("行视图：按 segId 排序、四种类型可编辑、选中态正确", () => {
    const staticReport = parseSegmentReport(
      hexToBytes("0000000900000000FF00000000FF00000000000000") as Uint8Array,
    );
    const rows = buildSegmentRows(
      [
        { ...staticReport, segId: 2, start: 40, end: 63 },
        { ...staticReport, segId: 0, start: 0, end: 15, hue: 21845 },
        {
          ...staticReport,
          segId: 1,
          start: 20,
          end: 29,
          type: SEGMENT_TYPE.BREATHING,
          layer0: { ...staticReport.layer0, type: SEGMENT_TYPE.BREATHING, periodMs: 1000 },
          periodMs: 1000,
        },
      ],
      2,
      segmentHueSatToRgb,
    );
    expect(rows.map((r) => r.segId)).toEqual([0, 1, 2]);
    expect(rows[0].hex).toBe("#00FF00"); /* hue 21845 → 纯绿 */
    expect(rows[0].editable).toBe(true);
    expect(rows[0].animated).toBe(false);
    expect(rows[0].typeText).toBe("静态");
    expect(rows[1].editable).toBe(true);
    expect(rows[1].animated).toBe(true);
    expect(rows[1].typeText).toBe("呼吸");
    expect(rows[2].selected).toBe(true);
    expect(rows[2].rangeText).toBe("40-63");
    expect(activeCount(rows)).toBe(3);
  });
});

describe("StripQueryCollector：同 seq 多帧收尾（21 字节报告）", () => {
  const report = parseSegmentReport(
    hexToBytes("0000000900000000FF00000000FF00000000000000") as Uint8Array,
  );

  it("收集 SegmentReport 并在 SegmentListEnd 兑现", async () => {
    const collector = new StripQueryCollector();
    const promise = collector.open(7, 0, 1000);

    expect(collector.report(7, { ...report, segId: 0, start: 0, end: 15 })).toBe(true);
    expect(collector.report(7, { ...report, segId: 1, start: 40, end: 63 })).toBe(true);
    expect(collector.listEnd(7, { stripId: 0, segMask: 0x03 })).toBe(true);

    const result = await promise;
    expect(result.reports).toHaveLength(2);
    expect(result.reports[1].start).toBe(40);
    expect(result.end.segMask).toBe(0x03);
    expect(collector.size).toBe(0);
  });

  it("seq 不匹配 / strip 不匹配的帧不被消费", async () => {
    const collector = new StripQueryCollector();
    const promise = collector.open(5, 0, 1000);

    expect(collector.report(6, { ...report, segId: 0, start: 0, end: 1 })).toBe(false);
    expect(collector.report(5, { ...report, stripId: 1, segId: 0, start: 0, end: 1 })).toBe(false);
    expect(collector.listEnd(5, { stripId: 1, segMask: 1 })).toBe(false);
    expect(collector.report(5, { ...report, segId: 0, start: 0, end: 1 })).toBe(true);
    collector.listEnd(5, { stripId: 0, segMask: 0x01 });
    expect((await promise).reports).toHaveLength(1);
  });

  it("超时 / reset 都会 reject（不留悬挂 Promise）", async () => {
    vi.useFakeTimers();
    const collector = new StripQueryCollector();
    const promise = collector.open(1, 0, 100);
    vi.advanceTimersByTime(200);
    await expect(promise).rejects.toBeTruthy();

    const second = collector.open(2, 0, 1000);
    collector.reset(new Error("断线"));
    await expect(second).rejects.toThrow("断线");
    expect(collector.size).toBe(0);
    vi.useRealTimers();
  });
});

describe("#30 呼吸：flags / 下限 / 波形 / 行视图", () => {
  it("flags 打包与解包（bit0 reverse，bit1-2 waveform）", () => {
    expect(breathingFlags(WAVEFORM.SINE)).toBe(0x00);
    expect(breathingFlags(WAVEFORM.TRIANGLE)).toBe(0x02);
    expect(breathingFlags(WAVEFORM.SAWTOOTH)).toBe(0x04);
    expect(breathingFlags(WAVEFORM.SQUARE)).toBe(0x06);
    expect(breathingFlags(WAVEFORM.SQUARE, true)).toBe(0x07);
    expect(breathingFlags(0x0f)).toBe(0x06);

    for (const wave of [0, 1, 2, 3]) {
      expect(breathingWaveform(breathingFlags(wave))).toBe(wave);
      expect(breathingFlags(wave) & 0xf8).toBe(0);
    }
  });

  it("set_segment_single_breathing 向量逐字节复现（21B 载荷）", () => {
    const c = vector("set_segment_single_breathing");
    const seg = breathingSegment(1, 2, 10, 29, 0x5555, 200, 2000, 30, WAVEFORM.SINE);
    const req = cmdSetSegment(seg);
    expect(req.payload.length).toBe(SEGMENT_BYTES);
    expect(bytesToCompactHex(req.payload)).toBe(c.payload_hex);
    expect(bytesToCompactHex(encodeFrame(req.command, c.seq as number, req.payload))).toBe(
      c.frame_hex,
    );
  });

  it("周期下限：333 拒绝、334 接受、0 接受、65535 接受、65536 拒绝", () => {
    expect(() =>
      cmdSetSegment(breathingSegment(0, 0, 0, 5, 0, 0xff, BREATHING_MIN_PERIOD_MS - 1, 0)),
    ).toThrow(RangeError);
    expect(() =>
      cmdSetSegment(breathingSegment(0, 0, 0, 5, 0, 0xff, BREATHING_MIN_PERIOD_MS, 0)),
    ).not.toThrow();
    expect(() => cmdSetSegment(breathingSegment(0, 0, 0, 5, 0, 0xff, 0, 0))).not.toThrow();
    expect(() => cmdSetSegment(breathingSegment(0, 0, 0, 5, 0, 0xff, 65535, 0))).not.toThrow();
    expect(() => cmdSetSegment(breathingSegment(0, 0, 0, 5, 0, 0xff, 65536, 0))).toThrow(
      RangeError,
    );
    /* flags 保留位 bit3-7 在本端就拒绝。 */
    expect(() =>
      cmdSetSegment({ ...breathingSegment(0, 1, 0, 9, 0, 0xff, 500, 0), flags: 0x08 }),
    ).toThrow(RangeError);
  });

  it("呼吸行视图：标签、波形名与最暗亮度百分比", () => {
    const report = parseSegmentReport(
      hexToBytes("000100090001100EFFE8036000FF00000000000000") as Uint8Array,
    );
    const rows = buildSegmentRows([report], 1, segmentHueSatToRgb);
    expect(rows[0].typeText).toBe("呼吸");
    expect(rows[0].animated).toBe(true);
    expect(rows[0].breathText).toContain("1000ms");
    expect(rows[0].breathText).toContain("最暗 38%");
    expect(breathingLabel(report)).toBe(rows[0].breathText);

    const still = { ...report, periodMs: 0 };
    expect(breathingLabel(still)).toBe("静止 · 最暗 38%");
  });
});

describe("#31 彩虹 / 流光：flags / 向量 / 行视图", () => {
  it("flags 只有 bit0：directionFlags 不污染保留位", () => {
    expect(directionFlags(false)).toBe(0x00);
    expect(directionFlags(true)).toBe(0x01);
    expect(segmentReverse(0x00)).toBe(false);
    expect(segmentReverse(0x01)).toBe(true);
    expect(segmentReverse(0xfe)).toBe(false);
    expect(segmentReverse(0xff)).toBe(true);
  });

  it("周期下限 200（5Hz）与 flags 保留位 bit1-7 在本端就拒绝", () => {
    expect(() =>
      cmdSetSegment(rainbowSegment(0, 0, 0, 5, 0, 0xff, ANIMATION_MIN_PERIOD_MS - 1, 128)),
    ).toThrow(RangeError);
    expect(() =>
      cmdSetSegment(rainbowSegment(0, 0, 0, 5, 0, 0xff, ANIMATION_MIN_PERIOD_MS, 128)),
    ).not.toThrow();
    expect(() => cmdSetSegment(rainbowSegment(0, 0, 0, 5, 0, 0xff, 0, 128))).not.toThrow();
    expect(() => cmdSetSegment(cometSegment(0, 0, 0, 5, 0, 0xff, 150, 64))).toThrow(RangeError);

    expect(() =>
      cmdSetSegment({ ...rainbowSegment(0, 0, 0, 5, 0, 0xff, 500, 128), flags: 0x02 }),
    ).toThrow(RangeError);
    expect(() =>
      cmdSetSegment({ ...cometSegment(0, 0, 0, 5, 0, 0xff, 500, 64), flags: 0x08 }),
    ).toThrow(RangeError);
    expect(() =>
      cmdSetSegment({ ...rainbowSegment(0, 0, 0, 5, 0, 0xff, 500, 128), flags: 0x01 }),
    ).not.toThrow();

    expect(() => cmdSetSegment(rainbowSegment(0, 0, 0, 5, 0, 0xff, 500, 256))).toThrow(
      RangeError,
    );
    expect(() => cmdSetSegment(cometSegment(0, 0, 0, 5, 0, 0xff, 500, -1))).toThrow(RangeError);
  });

  it("彩虹 / 流光行视图：类型标签与参数摘要", () => {
    const base = parseSegmentReport(
      hexToBytes("0000000900000000FF00000000FF00000000000000") as Uint8Array,
    );
    const rainbowReport = {
      ...base,
      segId: 2,
      type: SEGMENT_TYPE.RAINBOW,
      layer0: { type: SEGMENT_TYPE.RAINBOW, hue: 0, sat: 255, periodMs: 1000, p5: 0, flags: 0 },
      periodMs: 1000,
      p5: 0,
      flags: 0,
    };
    const rows = buildSegmentRows([rainbowReport], 2, segmentHueSatToRgb);
    expect(rows[0].typeText).toBe("彩虹");
    expect(rows[0].animated).toBe(true);
    expect(rows[0].breathText).toBe("");
    expect(rows[0].paramText).toBe("1000ms · 整条同色 · 正向");
    expect(rainbowLabel(rainbowReport)).toBe("1000ms · 整条同色 · 正向");

    expect(spanText(0)).toBe("整条同色");
    expect(spanText(255)).toBe("整圈");
    expect(spanText(128)).toBe("跨 50% 圈");

    const cometReport = { ...rainbowReport, type: SEGMENT_TYPE.COMET, p5: 0, flags: 0x01 };
    const cometRows = buildSegmentRows([cometReport], 2, segmentHueSatToRgb);
    expect(cometRows[0].typeText).toBe("流光");
    expect(cometRows[0].paramText).toBe("1000ms · 无拖尾 · 反向");
    expect(tailText(0)).toBe("无拖尾");
    expect(tailText(255)).toBe("整条拖尾");
    expect(tailText(128)).toBe("拖尾 50%");
    expect(rainbowLabel({ ...rainbowReport, periodMs: 0 })).toBe("静止 · 整条同色 · 正向");

    const staticRows = buildSegmentRows(
      [{ ...rainbowReport, type: SEGMENT_TYPE.STATIC, periodMs: 0, p5: 0, flags: 0 }],
      null,
      segmentHueSatToRgb,
    );
    expect(staticRows[0].paramText).toBe("");
    expect(staticRows[0].breathText).toBe("");
  });
});
