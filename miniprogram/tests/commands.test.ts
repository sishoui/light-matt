/** 命令构造器与载荷解析（v4：23/25 字节定宽两层段 + 37 字节 State）。 */

import { describe, expect, it } from "vitest";

import { bytesToCompactHex, hexToBytes } from "../utils/protocol/hex";
import {
  cmdClearSegment,
  cmdQueryDeviceInfo,
  cmdQueryState,
  cmdQueryStrip,
  cmdQueryStripConfig,
  cmdScriptBegin,
  cmdScriptStage,
  cmdSelfTest,
  cmdSetBrightness,
  cmdSetLedCount,
  cmdSetPower,
  cmdSetStripPower,
  layerParamLength,
  parseAck,
  parseDeviceInfoReport,
  parseSegmentPayload,
  parseState,
  parseStripConfigReport,
  stateHasScript,
  stateLoop,
  stateScriptActive,
  stateStripAnimated,
  stateStripLedCount,
  stateStripPower,
} from "../utils/protocol/commands";
import { BLEND, SEGMENT_TYPE } from "../utils/protocol/constants";

describe("命令构造器", () => {
  it("SetPower 只发 1 字节 0/1", () => {
    expect(bytesToCompactHex(cmdSetPower(true).payload)).toBe("01");
    expect(bytesToCompactHex(cmdSetPower(false).payload)).toBe("00");
    expect(cmdSetPower(true).command).toBe(0x01);
  });

  it("SetBrightness 0-255，越界抛错", () => {
    expect(bytesToCompactHex(cmdSetBrightness(128).payload)).toBe("80");
    expect(bytesToCompactHex(cmdSetBrightness(0).payload)).toBe("00");
    expect(() => cmdSetBrightness(256)).toThrow(RangeError);
    expect(() => cmdSetBrightness(-1)).toThrow(RangeError);
    expect(() => cmdSetBrightness(1.5)).toThrow(RangeError);
  });

  it("QueryState / SelfTest / QueryStripConfig / QueryDeviceInfo 无载荷", () => {
    expect(cmdQueryState().payload.length).toBe(0);
    expect(cmdSelfTest().payload.length).toBe(0);
    expect(cmdQueryStripConfig().command).toBe(0x1c);
    expect(cmdQueryStripConfig().payload.length).toBe(0);
    expect(cmdQueryDeviceInfo().command).toBe(0x1d);
    expect(cmdQueryDeviceInfo().payload.length).toBe(0);
  });

  it("SetLedCount 载荷 strip_id + 小端 2 字节数量，数量 1-100（#72）", () => {
    expect(bytesToCompactHex(cmdSetLedCount(0, 30).payload)).toBe("001E00");
    expect(bytesToCompactHex(cmdSetLedCount(0, 64).payload)).toBe("004000");
    expect(bytesToCompactHex(cmdSetLedCount(0, 100).payload)).toBe("006400");
    expect(bytesToCompactHex(cmdSetLedCount(7, 1).payload)).toBe("070100");
    expect(cmdSetLedCount(0, 30).command).toBe(0x06);
    /* 数量越界 / 非整数 / strip_id 越界都直接抛错，不发帧。 */
    expect(() => cmdSetLedCount(0, 0)).toThrow(RangeError);
    expect(() => cmdSetLedCount(0, 101)).toThrow(RangeError);
    expect(() => cmdSetLedCount(0, 1.2)).toThrow(RangeError);
    expect(() => cmdSetLedCount(-1, 30)).toThrow(RangeError);
    expect(() => cmdSetLedCount(8, 30)).toThrow(RangeError);
  });

  it("SetStripPower 载荷 strip_id + on（on 只允许 0/1）", () => {
    expect(bytesToCompactHex(cmdSetStripPower(0, true).payload)).toBe("0001");
    expect(bytesToCompactHex(cmdSetStripPower(3, false).payload)).toBe("0300");
    expect(cmdSetStripPower(0, true).command).toBe(0x1b);
    expect(() => cmdSetStripPower(8, true)).toThrow(RangeError);
    expect(() => cmdSetStripPower(-1, true)).toThrow(RangeError);
  });

  it("ClearSegment / QueryStrip 载荷", () => {
    expect(bytesToCompactHex(cmdClearSegment(0, 3).payload)).toBe("0003");
    expect(bytesToCompactHex(cmdQueryStrip(7).payload)).toBe("07");
    expect(() => cmdClearSegment(0, 8)).toThrow(RangeError);
    expect(() => cmdQueryStrip(8)).toThrow(RangeError);
  });

  it("ScriptBegin 允许 strip_count = 8（v2 的 0-7 误校验已修）", () => {
    expect(cmdScriptBegin(0, 4, 8).payload[2]).toBe(8);
    expect(() => cmdScriptBegin(0, 4, 0)).toThrow(RangeError);
    expect(() => cmdScriptBegin(0, 4, 9)).toThrow(RangeError);
  });

  it("ScriptStage 是 6 字节：duration(2) + fade(2)，fade 默认 0", () => {
    expect(bytesToCompactHex(cmdScriptStage(0, 0, 1000).payload)).toBe("0000E8030000");
    expect(bytesToCompactHex(cmdScriptStage(0, 1, 2000, 500).payload)).toBe("0001D007F401");
    expect(() => cmdScriptStage(0, 0, 0)).toThrow(RangeError);
    expect(() => cmdScriptStage(0, 0, 1000, 0x10000)).toThrow(RangeError);
  });

  it("层参数有效长度：静态 3、动画 7、空层/未知 0", () => {
    expect(layerParamLength(SEGMENT_TYPE.STATIC)).toBe(3);
    expect(layerParamLength(SEGMENT_TYPE.BREATHING)).toBe(7);
    expect(layerParamLength(SEGMENT_TYPE.RAINBOW)).toBe(7);
    expect(layerParamLength(SEGMENT_TYPE.COMET)).toBe(7);
    /* #74：三种新类型复用同一个 7 字节块。 */
    expect(layerParamLength(SEGMENT_TYPE.STROBE)).toBe(7);
    expect(layerParamLength(SEGMENT_TYPE.HEARTBEAT)).toBe(7);
    expect(layerParamLength(SEGMENT_TYPE.OFF)).toBe(7);
    expect(layerParamLength(SEGMENT_TYPE.EMPTY)).toBe(0);
    expect(layerParamLength(0x42)).toBe(0);
  });
});

/**
 * #74：爆闪 / 心跳 / 熄灭的编码与解析。
 *
 * 段载荷骨架：strip(1) seg(1) start(1) end(1) blend(1) layer0(9) layer1(9)。
 * 这三个类型的参数块都是 7 字节，所以段宽仍是 23。
 */
describe("v4 新灯效类型（#74）", () => {
  const build = (
    type: number,
    hue: number,
    sat: number,
    periodMs: number,
    p5: number,
    flags: number,
  ): Uint8Array => {
    const payload = new Uint8Array(23);
    payload[3] = 9; /* end = 9 */
    payload[5] = type;
    payload[6] = hue & 0xff;
    payload[7] = (hue >> 8) & 0xff;
    payload[8] = sat;
    payload[9] = periodMs & 0xff;
    payload[10] = (periodMs >> 8) & 0xff;
    payload[11] = p5; /* 层内 param[5] → 段内偏移 5 + 6 = 11 */
    payload[12] = flags;
    payload[13] = 100; /* level */
    payload[14] = 0xff; /* layer1 空 */
    return payload;
  };

  it("三种类型的层编码逐字节往返（段宽仍是 23）", () => {
    const cases: Array<[number, number, number, number, number, number]> = [
      [SEGMENT_TYPE.STROBE, 0, 255, 100, 90, 0],
      [SEGMENT_TYPE.HEARTBEAT, 0, 255, 1000, 60, 0x01],
      [SEGMENT_TYPE.OFF, 0, 0, 0, 0, 0],
    ];
    for (const [type, hue, sat, periodMs, p5, flags] of cases) {
      const spec = parseSegmentPayload(build(type, hue, sat, periodMs, p5, flags));
      expect(spec.layer0.type, `type ${type}`).toBe(type);
      expect(spec.layer0.hue).toBe(hue);
      expect(spec.layer0.sat).toBe(sat);
      expect(spec.layer0.periodMs).toBe(periodMs);
      expect(spec.layer0.p5).toBe(p5);
      expect(spec.layer0.flags).toBe(flags);
      expect(spec.layer0.level).toBe(100);
      expect(spec.layer1.type).toBe(0xff);
    }
  });

  it("爆闪：周期 100ms 接受、99ms 拒绝；flags 必须为 0", () => {
    expect(() =>
      parseSegmentPayload(build(SEGMENT_TYPE.STROBE, 0, 255, 100, 90, 0)),
    ).not.toThrow();
    expect(() =>
      parseSegmentPayload(build(SEGMENT_TYPE.STROBE, 0, 255, 99, 90, 0)),
    ).toThrow(RangeError);
    expect(() =>
      parseSegmentPayload(build(SEGMENT_TYPE.STROBE, 0, 255, 100, 90, 0x01)),
    ).toThrow(RangeError);
    /* period = 0 是「静止不出光」，不受下限约束。 */
    expect(() =>
      parseSegmentPayload(build(SEGMENT_TYPE.STROBE, 0, 255, 0, 90, 0)),
    ).not.toThrow();
  });

  it("心跳：500 / 1500 接受、499 / 1501 拒绝；flags bit1-7 保留", () => {
    for (const period of [500, 1000, 1500]) {
      expect(() =>
        parseSegmentPayload(build(SEGMENT_TYPE.HEARTBEAT, 0, 255, period, 60, 0x01)),
        String(period),
      ).not.toThrow();
    }
    expect(() =>
      parseSegmentPayload(build(SEGMENT_TYPE.HEARTBEAT, 0, 255, 499, 60, 0x01)),
    ).toThrow(RangeError);
    expect(() =>
      parseSegmentPayload(build(SEGMENT_TYPE.HEARTBEAT, 0, 255, 1501, 60, 0x01)),
    ).toThrow(RangeError);
    expect(() =>
      parseSegmentPayload(build(SEGMENT_TYPE.HEARTBEAT, 0, 255, 1000, 60, 0x02)),
    ).toThrow(RangeError);
    /* bit0 关闭（单脉冲）合法。 */
    expect(() =>
      parseSegmentPayload(build(SEGMENT_TYPE.HEARTBEAT, 0, 255, 1000, 60, 0x00)),
    ).not.toThrow();
    /* period = 0 静止合法。 */
    expect(() =>
      parseSegmentPayload(build(SEGMENT_TYPE.HEARTBEAT, 0, 255, 0, 60, 0x01)),
    ).not.toThrow();
  });

  it("熄灭：参数全 0 才接受，任一非 0 都拒绝", () => {
    expect(() => parseSegmentPayload(build(SEGMENT_TYPE.OFF, 0, 0, 0, 0, 0))).not.toThrow();
    /* hue / sat / period / p5 / flags 各自非 0。 */
    expect(() => parseSegmentPayload(build(SEGMENT_TYPE.OFF, 1, 0, 0, 0, 0))).toThrow(RangeError);
    expect(() => parseSegmentPayload(build(SEGMENT_TYPE.OFF, 0, 1, 0, 0, 0))).toThrow(RangeError);
    expect(() => parseSegmentPayload(build(SEGMENT_TYPE.OFF, 0, 0, 1, 0, 0))).toThrow(RangeError);
    expect(() => parseSegmentPayload(build(SEGMENT_TYPE.OFF, 0, 0, 0, 1, 0))).toThrow(RangeError);
    expect(() => parseSegmentPayload(build(SEGMENT_TYPE.OFF, 0, 0, 0, 0, 1))).toThrow(RangeError);
  });
});

describe("parseState（v3：37 字节）", () => {
  it("解析全部字段，含逐带灯珠数 / 段数 / 掩码", () => {
    const bytes = hexToBytes(
      "0180FFB478C802FF00000003011E003C000000000000000000000000000204000000000000",
    ) as Uint8Array;
    const state = parseState(bytes);
    expect(state.power).toBe(1);
    expect(state.brightness).toBe(128);
    expect(state.r).toBe(255);
    expect(state.g).toBe(180);
    expect(state.b).toBe(120);
    expect(state.maxBrightness).toBe(200);
    expect(state.stripCount).toBe(2);
    expect(state.scriptId).toBe(0xff);
    expect(state.playbackState).toBe(0);
    expect(state.stripPowerMask).toBe(0x03);
    expect(state.stripAnimMask).toBe(0x01);
    expect(state.stripCounts).toHaveLength(8);
    expect(state.stripCounts.slice(0, 2)).toEqual([30, 60]);
    expect(state.stripSegCounts.slice(0, 2)).toEqual([2, 4]);
    /* 派生字段与 strip 0 一致（#41 之前页面只读这两个）。 */
    expect(state.ledCount).toBe(30);
    expect(state.segCount).toBe(2);
  });

  it("逐带便捷判定：开关位 / 动画位 / 灯珠数", () => {
    const state = parseState(
      hexToBytes("0180FFB478C802FF00000003011E003C000000000000000000000000000204000000000000") as Uint8Array,
    );
    expect(stateStripPower(state, 0)).toBe(true);
    expect(stateStripPower(state, 1)).toBe(true);
    expect(stateStripPower(state, 2)).toBe(false);
    expect(stateStripAnimated(state, 0)).toBe(true);
    expect(stateStripAnimated(state, 1)).toBe(false);
    expect(stateStripLedCount(state, 0)).toBe(30);
    expect(stateStripLedCount(state, 1)).toBe(60);
    expect(stateStripLedCount(state, 7)).toBe(0);
  });

  it("只接受 37 字节，任何其它长度都明确报错（不静默截断）", () => {
    for (const length of [0, 8, 14, 20, 36, 38, 45]) {
      expect(() => parseState(new Uint8Array(length)), String(length)).toThrow(RangeError);
    }
    /* 37 字节但字段非法仍然拒绝（长度正确不等于内容正确）。 */
    expect(() => parseState(new Uint8Array(37))).toThrow(RangeError);

    const valid = hexToBytes(
      "0180FFB478C802FF00000003011E003C000000000000000000000000000204000000000000",
    ) as Uint8Array;
    expect(valid.length).toBe(37);
    expect(() => parseState(valid)).not.toThrow();
  });

  it("拒绝非法 power / strip_count / playback_state", () => {
    const base = (overrides: Record<number, number>): Uint8Array => {
      const bytes = new Uint8Array(37);
      /* 合法骨架：power=1、brightness=128、max=200、strips=1、段数 0。 */
      bytes[0] = 1;
      bytes[1] = 128;
      bytes[5] = 200;
      bytes[6] = 1;
      bytes[7] = 0xff;
      bytes[13] = 30;
      for (const [index, value] of Object.entries(overrides)) {
        bytes[Number(index)] = value;
      }
      return bytes;
    };
    expect(() => parseState(base({ 0: 2 }))).toThrow(RangeError);
    expect(() => parseState(base({ 6: 0 }))).toThrow(RangeError);
    expect(() => parseState(base({ 6: 9 }))).toThrow(RangeError);
    expect(() => parseState(base({ 9: 3 }))).toThrow(RangeError);
  });

  it("flags 位：loop / script_active / 是否有剧本", () => {
    /* 手工构造一条 37 字节 State：脚本 0 的第 3 阶段、播放中、flags = 0b11。 */
    const bytes = new Uint8Array(37);
    bytes[0] = 1; /* power */
    bytes[1] = 200; /* brightness */
    bytes[5] = 200; /* max_brightness */
    bytes[6] = 1; /* strip_count */
    bytes[7] = 0x00; /* script_id = 0（有剧本） */
    bytes[8] = 0x03; /* stage_index */
    bytes[9] = 0x01; /* playback = playing */
    bytes[10] = 0x03; /* flags = loop | script_active */
    bytes[11] = 0x01; /* strip_power_mask */
    bytes[13] = 30; /* strip_counts[0] = 30 */

    const state = parseState(bytes);
    expect(state.scriptId).toBe(0);
    expect(state.stageIndex).toBe(3);
    expect(state.playbackState).toBe(1);
    expect(state.flags).toBe(0x03);
    expect(state.ledCount).toBe(30);
    expect(stateLoop(state)).toBe(true);
    expect(stateScriptActive(state)).toBe(true);
    expect(stateHasScript(state)).toBe(true);
  });
});

describe("段载荷解析（23 字节定宽两层）", () => {
  it("单层静态：layer1 = 空层、blend = 覆盖", () => {
    const spec = parseSegmentPayload(
      hexToBytes("0000000900000000FF0000000064FF0000000000000000") as Uint8Array,
    );
    expect(spec.stripId).toBe(0);
    expect(spec.segId).toBe(0);
    expect(spec.start).toBe(0);
    expect(spec.end).toBe(9);
    expect(spec.blend).toBe(BLEND.OVER);
    expect(spec.layer0).toEqual({
      type: 0,
      hue: 0,
      sat: 255,
      periodMs: 0,
      p5: 0,
      flags: 0,
      level: 100,
    });
    expect(spec.layer1.type).toBe(0xff);
    /* 空层的 9 字节必须全 0，所以 level 也是 0。 */
    expect(spec.layer1.level).toBe(0);
  });

  it("两层（彩虹 + 呼吸，相乘）完整还原", () => {
    const spec = parseSegmentPayload(
      hexToBytes("0003003F01020000FFA00FFF006401000000DC05140064") as Uint8Array,
    );
    expect(spec.stripId).toBe(0);
    expect(spec.segId).toBe(3);
    expect(spec.start).toBe(0);
    expect(spec.end).toBe(0x3f);
    expect(spec.blend).toBe(BLEND.MULTIPLY);
    expect(spec.layer0).toMatchObject({
      type: SEGMENT_TYPE.RAINBOW,
      periodMs: 0x0fa0,
      p5: 255,
      level: 100,
    });
    expect(spec.layer1).toMatchObject({
      type: SEGMENT_TYPE.BREATHING,
      periodMs: 1500,
      p5: 20,
      level: 100,
    });
  });

  it("长度不是 23 一律拒绝", () => {
    for (const length of [0, 8, 21, 22, 24, 25]) {
      expect(() => parseSegmentPayload(new Uint8Array(length)), String(length)).toThrow(RangeError);
    }
  });

  it("layer0 为空 / blend 越界 / layer1 为空却带 blend 都被拒", () => {
    /* 合法骨架：单层静态段 seg 0 / [0-9]，layer1 空。 */
    const base = (): Uint8Array => {
      const payload = new Uint8Array(23);
      payload[2] = 0;
      payload[3] = 9;
      payload[4] = 0;
      payload[5] = SEGMENT_TYPE.STATIC;
      payload[8] = 255;
      /* layer0 的 level（偏移 13）必须给合法值：单层段满亮。 */
      payload[13] = 100;
      payload[14] = 0xff; /* layer1 空（从 14 起，9 字节全 0） */
      return payload;
    };

    expect(() => parseSegmentPayload(base())).not.toThrow();
    expect(() => parseSegmentPayload(base())).not.toThrow();

    /* layer0 = 0xFF（空）。 */
    const empty0 = base();
    empty0[5] = 0xff;
    expect(() => parseSegmentPayload(empty0)).toThrow(RangeError);

    /* blend = 3（协议只到 2）。 */
    const badBlend = base();
    badBlend[4] = 3;
    expect(() => parseSegmentPayload(badBlend)).toThrow(RangeError);

    /* layer1 为空但 blend = 1。 */
    const empty1WithBlend = base();
    empty1WithBlend[4] = 1;
    expect(() => parseSegmentPayload(empty1WithBlend)).toThrow(RangeError);
  });

  it("静态层的保留字节必须为 0（防止旧固件静默接受漂移语义）", () => {
    const payload = new Uint8Array(23);
    payload[3] = 9;
    payload[5] = SEGMENT_TYPE.STATIC;
    payload[8] = 255;
    payload[13] = 100;
    payload[14] = 0xff;
    expect(() => parseSegmentPayload(payload)).not.toThrow();

    payload[9] = 1; /* layer0 的保留区（静态层 param[4]） */
    expect(() => parseSegmentPayload(payload)).toThrow(RangeError);
  });

  it("v4 层亮度：0 / 50 / 100 解出原值，101 与空层带非零亮度都被拒", () => {
    const make = (level: number): Uint8Array => {
      const payload = new Uint8Array(23);
      payload[3] = 9;
      payload[5] = SEGMENT_TYPE.STATIC;
      payload[8] = 255;
      payload[13] = level;
      payload[14] = 0xff;
      return payload;
    };
    for (const level of [0, 50, 100]) {
      expect(parseSegmentPayload(make(level)).layer0.level, String(level)).toBe(level);
    }
    expect(() => parseSegmentPayload(make(101))).toThrow(RangeError);

    /* 空层（layer1）带 level = 50：9 字节不全 0 → 协议不匹配。 */
    const emptyWithLevel = make(100);
    emptyWithLevel[22] = 50;
    expect(() => parseSegmentPayload(emptyWithLevel)).toThrow(RangeError);
  });

  /**
   * v4 把呼吸的 `p5`（最低亮 / 谷底）从绝对 0-255 改成**相对百分比 0-100**。
   *
   * 固件对 101-255 回 `InvalidParam`，解析层必须同样拒绝：静默钳位会让两端对
   * 同一帧给出不同结论（App 以为读回成功、设备其实根本没接受）。
   */
  it("v4 呼吸层的最暗基线是 0-100 百分比，101-255 被拒（彩虹/流光的 p5 仍到 255）", () => {
    /* 骨架：单层段，layer0 是呼吸（type 1）、参数全在偏移 5..13。 */
    const make = (type: number, p5: number): Uint8Array => {
      const payload = new Uint8Array(23);
      payload[3] = 9;
      payload[5] = type;
      payload[8] = 255;
      payload[9] = 0x10; /* period 低字节 */
      payload[10] = 0x03; /* period = 0x0310 = 784ms，高于下限 */
      payload[11] = p5; /* p5 在层内偏移 6 → 段内偏移 5+6 = 11 */
      payload[13] = 100; /* level */
      payload[14] = 0xff; /* layer1 空 */
      return payload;
    };

    for (const p5 of [0, 40, 100]) {
      expect(parseSegmentPayload(make(SEGMENT_TYPE.BREATHING, p5)).layer0.p5, String(p5)).toBe(p5);
    }
    for (const p5 of [101, 200, 255]) {
      expect(() => parseSegmentPayload(make(SEGMENT_TYPE.BREATHING, p5)), String(p5)).toThrow(
        RangeError,
      );
    }
    /* 彩虹（跨度）与流光（尾长）的 p5 不是百分比，255 仍合法。 */
    for (const type of [SEGMENT_TYPE.RAINBOW, SEGMENT_TYPE.COMET]) {
      const payload = make(type, 255);
      payload[10] = 0x00; /* 周期 0 = 静止，避开下限 */
      payload[9] = 0x00;
      expect(parseSegmentPayload(payload).layer0.p5).toBe(255);
    }
  });
});

describe("StripConfigReport 0x87 / DeviceInfoReport 0x88", () => {
  it("解析 8 路引脚分配（3 条已分配，其余 gpio = 0xFF）", () => {
    const payload = hexToBytes(
      "000301010A0102000103FF0004FF0005FF0006FF0007FF00",
    ) as Uint8Array;
    const config = parseStripConfigReport(payload);
    expect(config.channels).toHaveLength(8);
    expect(config.channels.map((c) => c.stripId)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(config.channels.slice(0, 3).map((c) => c.gpio)).toEqual([3, 10, 0]);
    expect(config.channels.slice(0, 3).every((c) => c.assigned)).toBe(true);
    expect(config.channels.slice(3).every((c) => !c.assigned)).toBe(true);
    expect(config.channels.slice(3).every((c) => c.gpio === 0xff)).toBe(true);
  });

  it("长度不符 / strip_id 乱序都拒绝", () => {
    expect(() => parseStripConfigReport(new Uint8Array(23))).toThrow(RangeError);
    const wrongOrder = new Uint8Array(24);
    wrongOrder[0] = 1; /* 第 0 条应为 strip 0 */
    expect(() => parseStripConfigReport(wrongOrder)).toThrow(RangeError);
  });

  it("解析 15 字节设备信息（版本 / MAC / 能力）", () => {
    /* #72：max_leds 字节（偏移 8）现在是 0x64 = 100。 */
    const payload = hexToBytes("0003AABBCCDDEEFF64080808040100") as Uint8Array;
    const info = parseDeviceInfoReport(payload);
    expect(info.firmwareMajor).toBe(3);
    expect(info.firmwareMinor).toBe(0);
    /* #129：版本字段是小的端在前。线上 00 03 解出 0x0300（v3.0）。 */
    expect(info.firmwareVersion).toBe(0x0300);
    expect(info.hwId).toBe("AA:BB:CC:DD:EE:FF");
    expect(info.maxLeds).toBe(100);
    expect(info.maxStrips).toBe(8);
    expect(info.maxSegments).toBe(8);
    expect(info.maxStages).toBe(8);
    expect(info.maxScripts).toBe(4);
    expect(info.caps).toBe(0x01);
    expect(info.supportsTwoLayers).toBe(true);
    expect(info.fadeImplemented).toBe(false);
    expect(() => parseDeviceInfoReport(new Uint8Array(14))).toThrow(RangeError);
  });
});

describe("parseAck", () => {
  it("读 [原命令字, 结果码]，ok 只在结果码为 0 时为真", () => {
    expect(parseAck(new Uint8Array([0x01, 0x00]), 1)).toEqual({
      seq: 1,
      command: 1,
      resultCode: 0,
      ok: true,
    });
    expect(parseAck(new Uint8Array([0x17, 0x0a]), 13)).toEqual({
      seq: 13,
      command: 0x17,
      resultCode: 0x0a,
      ok: false,
    });
    expect(() => parseAck(new Uint8Array([0x01]), 1)).toThrow(RangeError);
  });
});
