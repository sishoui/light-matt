/**
 * #25 段配置：命令构造器 / 载荷解析 / 描述 / 分段编辑器纯逻辑 / QueryStrip 收集器。
 *
 * 字节期望值直接来自 docs/protocol-testvectors.json（两端共用的唯一真相），
 * 不在这里另写一份 hex。
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
  parseSegmentReport,
  rainbowSegment,
  segmentParamLength,
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
  BREATHING_MIN_PERIOD_MS,
  SEGMENT_TYPE,
  WAVEFORM,
} from "../utils/protocol/constants";
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
} from "../pages/index/segment-view";
import { StripQueryCollector } from "../utils/ble/strip-collector";

interface VectorCase {
  name: string;
  command?: number;
  seq?: number;
  payload_hex?: string;
  frame_hex: string;
  result_code?: number | null;
}

const vectors = JSON.parse(
  readFileSync(new URL("../../docs/protocol-testvectors.json", import.meta.url), "utf8"),
) as { cases: VectorCase[] };

function vector(name: string): VectorCase {
  const found = vectors.cases.find((c) => c.name === name);
  expect(found, name).toBeDefined();
  return found as VectorCase;
}

describe("SetSegment 构造器与向量一致", () => {
  it("静态段 8 字节载荷逐字节复现 set_segment_static", () => {
    const c = vector("set_segment_static");
    /* 向量载荷 0000001D000000FF：strip 0 / seg 0 / [0-29] / 静态 / hue 0 / sat 255 */
    const segment = staticSegment(0, 0, 0, 29, 0x0000, 0xff);
    const req = cmdSetSegment(segment);
    expect(req.command).toBe(0x10);
    expect(bytesToCompactHex(req.payload)).toBe(c.payload_hex);
    expect(bytesToCompactHex(encodeFrame(req.command, c.seq as number, req.payload))).toBe(
      c.frame_hex,
    );
  });

  it("动画段 12 字节载荷逐字节复现 set_segment_breathing", () => {
    const c = vector("set_segment_breathing");
    /*
     * 向量载荷 0001000901100EFFF4016000：
     * strip 0 / seg 1 / [0-9] / 呼吸 / hue 0x0E10 / sat 0xFF /
     * period 0x01F4 (500ms) / p5 0x60 / flags 0x00
     */
    const segment = {
      ...staticSegment(0, 1, 0, 9, 0x0e10, 0xff),
      type: SEGMENT_TYPE.BREATHING,
      periodMs: 0x01f4,
      p5: 0x60,
      flags: 0x00,
    };
    const req = cmdSetSegment(segment);
    expect(bytesToCompactHex(req.payload)).toBe(c.payload_hex);
    expect(bytesToCompactHex(encodeFrame(req.command, c.seq as number, req.payload))).toBe(
      c.frame_hex,
    );
  });

  it("ClearSegment / QueryStrip 与向量一致", () => {
    const clear = vector("clear_segment");
    const clearReq = cmdClearSegment(0, 1);
    expect(bytesToCompactHex(clearReq.payload)).toBe(clear.payload_hex);
    expect(bytesToCompactHex(encodeFrame(clearReq.command, clear.seq as number, clearReq.payload))).toBe(
      clear.frame_hex,
    );

    const query = vector("query_strip");
    const queryReq = cmdQueryStrip(0);
    expect(bytesToCompactHex(queryReq.payload)).toBe(query.payload_hex);
    expect(
      bytesToCompactHex(encodeFrame(queryReq.command, query.seq as number, queryReq.payload)),
    ).toBe(query.frame_hex);
  });

  it("构造器拒绝非法输入（越界 / start > end / 未知类型），不发帧", () => {
    /* staticSegment 只是数据装配（不校验）；校验全部在 cmdSetSegment。 */
    expect(() => cmdSetSegment(staticSegment(0, 0, 10, 5, 0, 255))).toThrow(RangeError);
    expect(() => cmdSetSegment(staticSegment(0, 0, 0, 64, 0, 255))).toThrow(RangeError);
    expect(() => cmdSetSegment(staticSegment(0, 8, 0, 5, 0, 255))).toThrow(RangeError);
    expect(() => cmdSetSegment(staticSegment(8, 0, 0, 5, 0, 255))).toThrow(RangeError);
    expect(() => cmdSetSegment(staticSegment(0, 0, 0, 5, 0xffff + 1, 255))).toThrow(RangeError);
    expect(() => cmdSetSegment(staticSegment(0, 0, 0, 5, 0, 256))).toThrow(RangeError);
    expect(() =>
      cmdSetSegment({ ...staticSegment(0, 0, 0, 5, 0, 255), type: 0x09 }),
    ).toThrow(RangeError);
    expect(() => cmdClearSegment(0, 8)).toThrow(RangeError);
    expect(() => cmdQueryStrip(8)).toThrow(RangeError);
  });

  it("参数块长度：静态 3、动画 7、未知 0", () => {
    expect(segmentParamLength(SEGMENT_TYPE.STATIC)).toBe(3);
    expect(segmentParamLength(SEGMENT_TYPE.BREATHING)).toBe(7);
    expect(segmentParamLength(SEGMENT_TYPE.RAINBOW)).toBe(7);
    expect(segmentParamLength(SEGMENT_TYPE.COMET)).toBe(7);
    expect(segmentParamLength(0x42)).toBe(0);
  });
});

describe("SegmentReport / SegmentListEnd 解析", () => {
  it("静态 SegmentReport 与向量载荷一致", () => {
    const c = vector("segment_report_static");
    const report = parseSegmentReport(hexToBytes(c.payload_hex) as Uint8Array);
    expect(report).toEqual({
      stripId: 0,
      segId: 0,
      start: 0,
      end: 29,
      type: SEGMENT_TYPE.STATIC,
      hue: 0,
      sat: 255,
      periodMs: 0,
      p5: 0,
      flags: 0,
    });
    expect(describeSegmentReport(report)).toBe(
      "SegmentReport strip=0 seg=0 range=0-29 type=0x00 hue=0 sat=255",
    );
  });

  it("动画 SegmentReport 带周期 / p5 / flags", () => {
    const c = vector("segment_report_breathing");
    const report = parseSegmentReport(hexToBytes(c.payload_hex) as Uint8Array);
    expect(report.type).toBe(SEGMENT_TYPE.BREATHING);
    expect(report.hue).toBe(0x0e10);
    expect(report.sat).toBe(0xff);
    expect(report.periodMs).toBe(0x01f4);
    expect(report.p5).toBe(0x60);
    expect(report.flags).toBe(0x00);
  });

  it("#31 彩虹 / 流光的 SegmentReport：p5 与 flags 原样解析，日志按类型解释", () => {
    const rainbow = parseSegmentReport(
      hexToBytes(vector("segment_report_rainbow").payload_hex) as Uint8Array,
    );
    expect(rainbow.type).toBe(SEGMENT_TYPE.RAINBOW);
    expect(rainbow.periodMs).toBe(1000);
    expect(rainbow.p5).toBe(128); /* span */
    expect(rainbow.flags).toBe(0x00);
    expect(describeSegmentReport(rainbow)).toBe(
      "SegmentReport strip=0 seg=1 range=0-9 type=0x02 hue=3600 sat=255 " +
        "period=1000 span=128 reverse=0 flags=0x00",
    );

    const comet = parseSegmentReport(
      hexToBytes(vector("segment_report_comet").payload_hex) as Uint8Array,
    );
    expect(comet.type).toBe(SEGMENT_TYPE.COMET);
    expect(comet.periodMs).toBe(800);
    expect(comet.p5).toBe(64); /* tail */
    expect(comet.flags).toBe(0x01);
    expect(describeSegmentReport(comet)).toBe(
      "SegmentReport strip=0 seg=1 range=0-9 type=0x03 hue=3600 sat=255 " +
        "period=800 tail=64 reverse=1 flags=0x01",
    );
  });

  it("长度与 type 不符 / 类型未知 / start > end 都拒绝", () => {
    /* 静态却给了 12 字节。 */
    expect(() => parseSegmentReport(new Uint8Array(12))).toThrow(RangeError);
    /* 只有 4 字节，连 type 都读不到。 */
    expect(() => parseSegmentReport(new Uint8Array(4))).toThrow(RangeError);
    /* 未知 type 0x09。 */
    expect(() => parseSegmentReport(new Uint8Array([0, 0, 0, 5, 0x09, 0, 0, 0]))).toThrow(
      RangeError,
    );
    /* start > end。 */
    expect(() => parseSegmentReport(new Uint8Array([0, 0, 9, 5, 0, 0, 0, 255]))).toThrow(
      RangeError,
    );
  });

  it("SegmentListEnd 与向量一致", () => {
    const c = vector("segment_list_end");
    const end = parseSegmentListEnd(hexToBytes(c.payload_hex) as Uint8Array);
    expect(end).toEqual({ stripId: 0, segMask: 0x07 });
    expect(describeSegmentListEnd(end)).toBe("SegmentListEnd strip=0 mask=0x07 slots=[0,1,2]");
    expect(() => parseSegmentListEnd(new Uint8Array(3))).toThrow(RangeError);
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
    /* 灰阶：sat 0，hue 无定义按 0。 */
    expect(rgbToSegmentParams({ r: 80, g: 80, b: 80 }).sat).toBe(0);
  });
});

describe("分段编辑器纯逻辑", () => {
  it("区间输入：整数、非负、start ≤ end、end < ledCount", () => {
    expect(parseRangeInput("0", "15", 64)).toEqual({ ok: true, start: 0, end: 15, message: "" });
    expect(parseRangeInput("40", "63", 64).ok).toBe(true);

    expect(parseRangeInput("", "15", 64).ok).toBe(false);
    expect(parseRangeInput("0", "", 64).ok).toBe(false);
    expect(parseRangeInput("1.5", "15", 64).ok).toBe(false);
    expect(parseRangeInput("-1", "15", 64).ok).toBe(false);
    expect(parseRangeInput("20", "10", 64).ok).toBe(false);
    /* end >= ledCount：64 灯时终点 64 越界。 */
    const outOfRange = parseRangeInput("0", "64", 64);
    expect(outOfRange.ok).toBe(false);
    expect(outOfRange.message).toContain("超出灯珠范围");
    /* 未连接（ledCount 0）。 */
    expect(parseRangeInput("0", "15", 0).ok).toBe(false);

    /* 30 灯时 29 合法、30 越界。 */
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
    /* 紧邻 16 起点、39 终点：不重叠。 */
    expect(overlapError(15, 16, rows)).not.toBeNull(); /* 15 被段 0 占着 */
    expect(overlapError(40, 63, rows)).not.toBeNull();
    expect(overlapError(40, 63, rows, 1)).toBeNull(); /* 改自己 */
    expect(overlapError(0, 15, rows, 0)).toBeNull();
    const conflict = overlapError(5, 45, rows);
    expect(conflict).toContain("段 0");
  });

  it("行视图：按 segId 排序、静态段可编辑、选中态正确", () => {
    const rows = buildSegmentRows(
      [
        { stripId: 0, segId: 2, start: 40, end: 63, type: 0, hue: 0, sat: 255, periodMs: 0, p5: 0, flags: 0 },
        { stripId: 0, segId: 0, start: 0, end: 15, type: 0, hue: 21845, sat: 255, periodMs: 0, p5: 0, flags: 0 },
        { stripId: 0, segId: 1, start: 20, end: 29, type: 1, hue: 0, sat: 0, periodMs: 1000, p5: 0, flags: 0 },
      ],
      2,
      segmentHueSatToRgb,
    );
    expect(rows.map((r) => r.segId)).toEqual([0, 1, 2]);
    expect(rows[0].hex).toBe("#00FF00");
    expect(rows[0].editable).toBe(true);
    expect(rows[0].animated).toBe(false);
    expect(rows[0].typeText).toBe("静态");
    /* #30：动画段（呼吸）也可选中编辑，色块用它的 hue+sat 基色。 */
    expect(rows[1].editable).toBe(true);
    expect(rows[1].animated).toBe(true);
    expect(rows[1].typeText).toBe("呼吸");
    expect(rows[2].selected).toBe(true);
    expect(rows[2].rangeText).toBe("40-63");
    expect(activeCount(rows)).toBe(3);
  });
});

describe("StripQueryCollector：同 seq 多帧收尾", () => {
  it("收集 SegmentReport 并在 SegmentListEnd 兑现", async () => {
    const collector = new StripQueryCollector();
    const promise = collector.open(7, 0, 1000);

    const base = { stripId: 0, type: 0, hue: 0, sat: 255, periodMs: 0, p5: 0, flags: 0 };
    expect(collector.report(7, { ...base, segId: 0, start: 0, end: 15 })).toBe(true);
    expect(collector.report(7, { ...base, segId: 1, start: 40, end: 63 })).toBe(true);
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
    const base = { type: 0, hue: 0, sat: 255, periodMs: 0, p5: 0, flags: 0 };

    expect(collector.report(6, { ...base, stripId: 0, segId: 0, start: 0, end: 1 })).toBe(false);
    expect(collector.report(5, { ...base, stripId: 1, segId: 0, start: 0, end: 1 })).toBe(false);
    expect(collector.listEnd(5, { stripId: 1, segMask: 1 })).toBe(false);
    expect(collector.report(5, { ...base, stripId: 0, segId: 0, start: 0, end: 1 })).toBe(true);
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

describe("#30 呼吸：flags / 构造器下限 / 波形 / 行视图", () => {
  it("flags 打包与解包（bit0 reverse，bit1-2 waveform）", () => {
    expect(breathingFlags(WAVEFORM.SINE)).toBe(0x00);
    expect(breathingFlags(WAVEFORM.TRIANGLE)).toBe(0x02);
    expect(breathingFlags(WAVEFORM.SAWTOOTH)).toBe(0x04);
    expect(breathingFlags(WAVEFORM.SQUARE)).toBe(0x06);
    expect(breathingFlags(WAVEFORM.SQUARE, true)).toBe(0x07);
    /* 波形只有 2 位：越界值被掩掉，不会污染保留位。 */
    expect(breathingFlags(0x0f)).toBe(0x06);

    for (const wave of [0, 1, 2, 3]) {
      expect(breathingWaveform(breathingFlags(wave))).toBe(wave);
      /* 保留位 bit3-7 恒为 0。 */
      expect(breathingFlags(wave) & 0xf8).toBe(0);
    }
  });

  it("set_segment_breathing 向量逐字节复现（12B 载荷）", () => {
    const c = vector("set_segment_breathing");
    /* 向量载荷 0001000901100EFFF4016000：
     * strip 0 / seg 1 / [0-9] / 呼吸 / hue 0x0E10 / sat 0xFF /
     * period 500 / min_level 0x60 / flags 0x00（正弦） */
    const seg = breathingSegment(0, 1, 0, 9, 0x0e10, 0xff, 500, 0x60, WAVEFORM.SINE);
    const req = cmdSetSegment(seg);
    expect(req.payload.length).toBe(12);
    expect(bytesToCompactHex(req.payload)).toBe(c.payload_hex);
    expect(bytesToCompactHex(encodeFrame(req.command, c.seq as number, req.payload))).toBe(
      c.frame_hex,
    );
  });

  it("新增呼吸向量：周期过短 / 保留位 / 共存 / 周期 0 / 上限 65535", () => {
    const checks: Array<[string, ReturnType<typeof breathingSegment>]> = [
      ["set_segment_breathing_period_too_short", breathingSegment(0, 1, 0, 9, 0x0e10, 0xff, 333, 0x60)],
      ["set_segment_breathing_period_max", breathingSegment(0, 1, 0, 9, 0x0e10, 0xff, 65535, 0x00)],
      ["set_segment_breathing_with_static", breathingSegment(0, 1, 0, 9, 0x0e10, 0xff, 500, 0x60)],
    ];
    for (const [name, seg] of checks) {
      if (name === "set_segment_breathing_period_too_short") {
        /* 构造器在本端就拒绝 < 334 的周期（不等设备回 InvalidParam）。 */
        expect(() => cmdSetSegment(seg)).toThrow(RangeError);
        continue;
      }
      const c = vector(name);
      const req = cmdSetSegment(seg);
      expect(bytesToCompactHex(req.payload)).toBe(c.payload_hex);
      expect(bytesToCompactHex(encodeFrame(req.command, c.seq as number, req.payload))).toBe(
        c.frame_hex,
      );
    }

    /* period = 0 是合法的「静止」。 */
    const zero = vector("set_segment_breathing_period_zero");
    const zeroReq = cmdSetSegment(breathingSegment(0, 1, 0, 9, 0x0e10, 0xff, 0, 0x01));
    expect(bytesToCompactHex(zeroReq.payload)).toBe(zero.payload_hex);
    expect(bytesToCompactHex(encodeFrame(zeroReq.command, zero.seq as number, zeroReq.payload))).toBe(
      zero.frame_hex,
    );

    /* flags 保留位：构造器拒绝 bit3。 */
    expect(() =>
      cmdSetSegment({ ...breathingSegment(0, 1, 0, 9, 0, 0xff, 500, 0), flags: 0x08 }),
    ).toThrow(RangeError);
  });

  it("周期下限边界：333 拒绝、334 接受、0 接受", () => {
    expect(() =>
      cmdSetSegment(breathingSegment(0, 0, 0, 5, 0, 0xff, BREATHING_MIN_PERIOD_MS - 1, 0)),
    ).toThrow(RangeError);
    expect(() =>
      cmdSetSegment(breathingSegment(0, 0, 0, 5, 0, 0xff, BREATHING_MIN_PERIOD_MS, 0)),
    ).not.toThrow();
    expect(() => cmdSetSegment(breathingSegment(0, 0, 0, 5, 0, 0xff, 0, 0))).not.toThrow();
    /* 上限 65535（相位天花板）。 */
    expect(() => cmdSetSegment(breathingSegment(0, 0, 0, 5, 0, 0xff, 65535, 0))).not.toThrow();
    expect(() => cmdSetSegment(breathingSegment(0, 0, 0, 5, 0, 0xff, 65536, 0))).toThrow(
      RangeError,
    );
  });

  it("呼吸行视图：标签、波形名与最暗亮度百分比", () => {
    const report = {
      stripId: 0,
      segId: 1,
      start: 0,
      end: 9,
      type: SEGMENT_TYPE.BREATHING,
      hue: 0,
      sat: 255,
      periodMs: 1000,
      p5: 64,
      flags: breathingFlags(WAVEFORM.TRIANGLE),
    };
    const rows = buildSegmentRows([report], 1, segmentHueSatToRgb);
    expect(rows[0].typeText).toBe("呼吸");
    expect(rows[0].animated).toBe(true);
    expect(rows[0].breathText).toBe("三角 · 1000ms · 最暗 25%");
    expect(breathingLabel(report)).toBe("三角 · 1000ms · 最暗 25%");

    /* period = 0 → 「静止」，不显示 0ms（避免用户以为没生效）。 */
    const still = { ...report, periodMs: 0 };
    expect(breathingLabel(still)).toBe("静止 · 最暗 25%");
  });
});

describe("#31 彩虹 / 流光：构造器 / 向量 / 行视图", () => {
  it("flags 只有 bit0：directionFlags 不污染保留位", () => {
    expect(directionFlags(false)).toBe(0x00);
    expect(directionFlags(true)).toBe(0x01);
    expect(segmentReverse(0x00)).toBe(false);
    expect(segmentReverse(0x01)).toBe(true);
    /* bit1-7 是保留位：即便传进来也不被当作反向。 */
    expect(segmentReverse(0xfe)).toBe(false);
    expect(segmentReverse(0xff)).toBe(true);
  });

  it("set_segment_rainbow 向量逐字节复现（12B 载荷，span=128）", () => {
    const c = vector("set_segment_rainbow");
    const seg = rainbowSegment(0, 1, 0, 9, 0x0e10, 0xff, 1000, 128);
    const req = cmdSetSegment(seg);
    expect(req.payload.length).toBe(12);
    expect(bytesToCompactHex(req.payload)).toBe(c.payload_hex);
    expect(bytesToCompactHex(encodeFrame(req.command, c.seq as number, req.payload))).toBe(
      c.frame_hex,
    );
  });

  it("set_segment_comet 向量逐字节复现（12B 载荷，tail=64）", () => {
    const c = vector("set_segment_comet");
    const seg = cometSegment(0, 1, 0, 9, 0x0e10, 0xff, 800, 64);
    const req = cmdSetSegment(seg);
    expect(bytesToCompactHex(req.payload)).toBe(c.payload_hex);
    expect(bytesToCompactHex(encodeFrame(req.command, c.seq as number, req.payload))).toBe(
      c.frame_hex,
    );
  });

  it("边界向量：span=0 / span=255 / tail=0 / tail=255 / reverse", () => {
    const checks: Array<[string, ReturnType<typeof rainbowSegment>]> = [
      ["set_segment_rainbow_span_zero", rainbowSegment(0, 1, 0, 9, 0x0e10, 0xff, 600, 0)],
      ["set_segment_rainbow_span_full", rainbowSegment(0, 1, 0, 9, 0x0e10, 0xff, 200, 255)],
      ["set_segment_rainbow_reverse", rainbowSegment(0, 1, 0, 9, 0x0e10, 0xff, 800, 255, true)],
    ];
    for (const [name, seg] of checks) {
      const c = vector(name);
      const req = cmdSetSegment(seg);
      expect(bytesToCompactHex(req.payload), name).toBe(c.payload_hex);
      expect(bytesToCompactHex(encodeFrame(req.command, c.seq as number, req.payload)), name).toBe(
        c.frame_hex,
      );
    }

    const cometChecks: Array<[string, ReturnType<typeof cometSegment>]> = [
      ["set_segment_comet_tail_zero", cometSegment(0, 1, 0, 9, 0x0e10, 0xff, 800, 0)],
      ["set_segment_comet_tail_full", cometSegment(0, 1, 0, 9, 0x0e10, 0xff, 500, 255)],
      ["set_segment_comet_reverse", cometSegment(0, 1, 0, 9, 0x0e10, 0xff, 800, 128, true)],
    ];
    for (const [name, seg] of cometChecks) {
      const c = vector(name);
      const req = cmdSetSegment(seg);
      expect(bytesToCompactHex(req.payload), name).toBe(c.payload_hex);
      expect(bytesToCompactHex(encodeFrame(req.command, c.seq as number, req.payload)), name).toBe(
        c.frame_hex,
      );
    }
  });

  it("周期下限 200（5Hz）与 flags 保留位 bit1-7 在本端就拒绝", () => {
    /* 199 拒绝、200 接受、0 接受（静止）。 */
    expect(() =>
      cmdSetSegment(rainbowSegment(0, 0, 0, 5, 0, 0xff, ANIMATION_MIN_PERIOD_MS - 1, 128)),
    ).toThrow(RangeError);
    expect(() =>
      cmdSetSegment(rainbowSegment(0, 0, 0, 5, 0, 0xff, ANIMATION_MIN_PERIOD_MS, 128)),
    ).not.toThrow();
    expect(() => cmdSetSegment(rainbowSegment(0, 0, 0, 5, 0, 0xff, 0, 128))).not.toThrow();
    expect(() => cmdSetSegment(cometSegment(0, 0, 0, 5, 0, 0xff, 150, 64))).toThrow(RangeError);

    /* 彩虹 / 流光：bit1 起全部保留（与呼吸不同，没有 waveform 位可借）。 */
    expect(() =>
      cmdSetSegment({ ...rainbowSegment(0, 0, 0, 5, 0, 0xff, 500, 128), flags: 0x02 }),
    ).toThrow(RangeError);
    expect(() =>
      cmdSetSegment({ ...cometSegment(0, 0, 0, 5, 0, 0xff, 500, 64), flags: 0x08 }),
    ).toThrow(RangeError);
    /* bit0 reverse 合法。 */
    expect(() =>
      cmdSetSegment({ ...rainbowSegment(0, 0, 0, 5, 0, 0xff, 500, 128), flags: 0x01 }),
    ).not.toThrow();

    /* span / tail 仍是 0-255 的字节。 */
    expect(() => cmdSetSegment(rainbowSegment(0, 0, 0, 5, 0, 0xff, 500, 256))).toThrow(
      RangeError,
    );
    expect(() => cmdSetSegment(cometSegment(0, 0, 0, 5, 0, 0xff, 500, -1))).toThrow(RangeError);
  });

  it("彩虹 / 流光行视图：类型标签与参数摘要", () => {
    const rainbowReport = {
      stripId: 0,
      segId: 2,
      start: 0,
      end: 15,
      type: SEGMENT_TYPE.RAINBOW,
      hue: 0,
      sat: 255,
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

    /* span = 255 → 「整圈」；中间值按百分比描述。 */
    expect(spanText(0)).toBe("整条同色");
    expect(spanText(255)).toBe("整圈");
    expect(spanText(128)).toBe("跨 50% 圈");

    const cometReport = {
      ...rainbowReport,
      type: SEGMENT_TYPE.COMET,
      p5: 0,
      flags: 0x01,
    };
    const cometRows = buildSegmentRows([cometReport], 2, segmentHueSatToRgb);
    expect(cometRows[0].typeText).toBe("流光");
    expect(cometRows[0].paramText).toBe("1000ms · 无拖尾 · 反向");
    expect(tailText(0)).toBe("无拖尾");
    expect(tailText(255)).toBe("整条拖尾");
    expect(tailText(128)).toBe("拖尾 50%");

    /* period = 0 是「静止」，与呼吸同一条文案规则。 */
    expect(rainbowLabel({ ...rainbowReport, periodMs: 0 })).toBe("静止 · 整条同色 · 正向");

    /* 静态段没有参数摘要（paramText 为空串）。 */
    const staticRows = buildSegmentRows(
      [{ ...rainbowReport, type: SEGMENT_TYPE.STATIC, periodMs: 0, p5: 0, flags: 0 }],
      null,
      segmentHueSatToRgb,
    );
    expect(staticRows[0].paramText).toBe("");
    expect(staticRows[0].breathText).toBe("");
  });
});
