/**
 * 命令构造器与载荷解析（docs/protocol-v5.md §6 / §7）。
 *
 * v5 的命令面：整机 5 条 + 灯组 3 条 + 布局族 5 条 + 场景族 5 条。
 * 这里逐条断言载荷宽度、取值范围与**越界必须抛 RangeError**——
 * 构造器是本端唯一一处「提前拒绝」的机会，让用户看到原因而不是等设备回 0x01。
 */

import { describe, expect, it } from "vitest";

import {
  EMPTY_LAYER,
  breathingFlags,
  cmdActivateScene,
  cmdLayoutCommit,
  cmdLayoutPart,
  cmdLayoutSeg,
  cmdLayoutWrite,
  cmdQueryLayout,
  cmdQueryScene,
  cmdQueryState,
  cmdSceneName,
  cmdScenePart,
  cmdSceneStep,
  cmdSelfTest,
  cmdSetBrightness,
  cmdSetLedCount,
  cmdSetPower,
  cometFlags,
  cometHeads,
  cometSolidTail,
  encodeLayer,
  encodeName,
  layerParamLength,
  minPeriodMs,
  parseAck,
  parseDeviceInfoReport,
  parseLayoutListEnd,
  parseLayoutReport,
  parseLayer,
  parseSceneListEnd,
  parseScenePartReport,
  parseSceneStepReport,
  parseState,
  parseStripConfigReport,
  staticLayer,
} from "../utils/protocol/commands";
import {
  EFFECT_TYPE,
  LAYOUT_PART_BYTES,
  LAYER_LEVEL_MAX,
  MAX_LEDS,
  MAX_PARTS,
  MAX_PART_SEGS,
  MAX_SCENES,
  MAX_STEPS,
  MAX_STRIPS,
  NO_EFFECT,
  PHASE,
  SCENE_NAME_BYTES,
  SCENE_STEP_BYTES,
  STATE_BYTES,
} from "../utils/protocol/constants";

describe("整机命令", () => {
  it("SetPower / SetBrightness / QueryState / SelfTest 的载荷", () => {
    expect(Array.from(cmdSetPower(true).payload)).toEqual([1]);
    expect(Array.from(cmdSetPower(false).payload)).toEqual([0]);
    expect(Array.from(cmdSetBrightness(128).payload)).toEqual([128]);
    expect(() => cmdSetBrightness(-1)).toThrow(RangeError);
    expect(() => cmdSetBrightness(300)).toThrow(RangeError);
    expect(cmdQueryState().payload.length).toBe(0);
    expect(cmdSelfTest().payload.length).toBe(0);
    expect(cmdQueryState().command).toBe(0x05);
    expect(cmdSelfTest().command).toBe(0x07);
  });

  it("SetLedCount 是 3 字节小端，strip 与数量都要在范围内", () => {
    const req = cmdSetLedCount(3, 100);
    expect(req.command).toBe(0x06);
    expect(Array.from(req.payload)).toEqual([3, 100, 0]);
    expect(() => cmdSetLedCount(MAX_STRIPS, 10)).toThrow(RangeError);
    expect(() => cmdSetLedCount(0, 0)).toThrow(RangeError);
    expect(() => cmdSetLedCount(0, MAX_LEDS + 1)).toThrow(RangeError);
    /* 边界值合法。 */
    expect(cmdSetLedCount(0, 1).payload[1]).toBe(1);
    expect(cmdSetLedCount(0, MAX_LEDS).payload[1]).toBe(MAX_LEDS & 0xff);
  });
});

describe("层编码（9 字节定宽）", () => {
  it("静态层：type + hue2 + sat + 4 保留 0 + level", () => {
    const bytes = encodeLayer(staticLayer(0x1234, 200, 50));
    expect(Array.from(bytes)).toEqual([EFFECT_TYPE.STATIC, 0x34, 0x12, 200, 0, 0, 0, 0, 50]);
    expect(parseLayer(bytes).hue).toBe(0x1234);
    expect(parseLayer(bytes).level).toBe(50);
  });

  it("空层：type 0xFF，其余 8 字节全 0", () => {
    const bytes = encodeLayer(EMPTY_LAYER);
    expect(bytes[0]).toBe(NO_EFFECT);
    for (let i = 1; i < 9; i += 1) {
      expect(bytes[i]).toBe(0);
    }
  });

  it("空层带非零色相/饱和度/亮度一律拒绝（§7.1 第 3 步）", () => {
    expect(() => encodeLayer({ ...EMPTY_LAYER, level: 50 })).toThrow(RangeError);
    expect(() => encodeLayer({ ...EMPTY_LAYER, hue: 1 })).toThrow(RangeError);
    expect(() => encodeLayer({ ...EMPTY_LAYER, sat: 1 })).toThrow(RangeError);
  });

  it("level > 100 拒绝；未知 type 拒绝", () => {
    expect(() => encodeLayer(staticLayer(0, 255, LAYER_LEVEL_MAX + 1))).toThrow(RangeError);
    expect(() => encodeLayer({ ...EMPTY_LAYER, type: 0x09 })).toThrow(RangeError);
  });

  it("参数块长度：静态 3、其余已知类型 7、未知 0", () => {
    expect(layerParamLength(EFFECT_TYPE.STATIC)).toBe(3);
    expect(layerParamLength(EFFECT_TYPE.BREATHING)).toBe(7);
    expect(layerParamLength(EFFECT_TYPE.FLICKER)).toBe(7);
    expect(layerParamLength(0x09)).toBe(0);
  });

  it("呼吸 flags 打包 waveform（bit1-2）与方向（bit0）", () => {
    expect(breathingFlags(1, false)).toBe(0x02);
    expect(breathingFlags(3, true)).toBe(0x07);
    expect(() => breathingFlags(4)).toThrow(RangeError);
  });

  it("流星 flags 打包方向 / 实色拖尾 / 头数量（1-4）", () => {
    const flags = cometFlags(true, true, 4);
    expect(flags & 0x01).toBe(0x01);
    expect(flags & 0x02).toBe(0x02);
    expect(cometHeads(flags)).toBe(4);
    expect(cometSolidTail(flags)).toBe(true);
    expect(cometHeads(cometFlags(false, false, 1))).toBe(1);
    expect(() => cometFlags(false, false, 5)).toThrow(RangeError);
    expect(() => cometFlags(false, false, 0)).toThrow(RangeError);
  });

  it("周期的类型下限（0 = 静止，不受限）", () => {
    expect(minPeriodMs(EFFECT_TYPE.BREATHING)).toBe(334);
    expect(minPeriodMs(EFFECT_TYPE.RAINBOW)).toBe(200);
    expect(minPeriodMs(EFFECT_TYPE.COMET)).toBe(200);
    expect(minPeriodMs(EFFECT_TYPE.STROBE)).toBe(100);
    expect(minPeriodMs(EFFECT_TYPE.FLICKER)).toBe(334);
    expect(minPeriodMs(EFFECT_TYPE.HEARTBEAT)).toBe(500);
    expect(minPeriodMs(EFFECT_TYPE.STATIC)).toBe(0);
  });
});

describe("名字编解码", () => {
  it("UTF-8 编码成 24 字节（NUL 补齐），长度是字节数", () => {
    const { bytes, len } = encodeName("眼灯");
    expect(len).toBe(6);
    expect(bytes.length).toBe(24);
    expect(Array.from(bytes.slice(0, 6))).toEqual([0xe7, 0x9c, 0xbc, 0xe7, 0x81, 0xaf]);
    expect(Array.from(bytes.slice(6))).toEqual(Array(18).fill(0));
  });

  it("空名合法；超过 24 字节拒绝", () => {
    expect(encodeName("").len).toBe(0);
    expect(() => encodeName("abcdefghijklmnopqrstuvwxyz")).toThrow(RangeError);
    /* 8 个汉字 = 24 字节，正好到上限。 */
    expect(encodeName("八个汉字八个汉字").len).toBe(24);
  });
});

describe("布局族 0x20-0x24", () => {
  it("LayoutWrite 是 2 字节；partCount 0-8", () => {
    const req = cmdLayoutWrite(2, 5);
    expect(req.command).toBe(0x20);
    expect(Array.from(req.payload)).toEqual([2, 5]);
    expect(cmdLayoutWrite(0, 0).payload[1]).toBe(0);
    expect(cmdLayoutWrite(0, MAX_PARTS).payload[1]).toBe(MAX_PARTS);
    expect(() => cmdLayoutWrite(0, MAX_PARTS + 1)).toThrow(RangeError);
    expect(() => cmdLayoutWrite(MAX_STRIPS, 1)).toThrow(RangeError);
  });

  it("LayoutPart 是 29 字节：strip, part, name_len, name[24], seg_count, phase", () => {
    const req = cmdLayoutPart(1, 2, "眼灯", 3, PHASE.PER_SEGMENT);
    expect(req.command).toBe(0x21);
    expect(req.payload.length).toBe(LAYOUT_PART_BYTES);
    expect(LAYOUT_PART_BYTES).toBe(29);
    expect(req.payload[0]).toBe(1);
    expect(req.payload[1]).toBe(2);
    expect(req.payload[2]).toBe(6);
    expect(req.payload[27]).toBe(3);
    /* 相位是最后一字节（§9.2，每部位一份）。 */
    expect(req.payload[28]).toBe(PHASE.PER_SEGMENT);
    expect(() => cmdLayoutPart(0, MAX_PARTS, "", 1, PHASE.CONTINUOUS)).toThrow(RangeError);
    expect(() => cmdLayoutPart(0, 0, "", MAX_PART_SEGS + 1, PHASE.CONTINUOUS)).toThrow(RangeError);
    /* 相位越界一帧都不发。 */
    expect(() => cmdLayoutPart(0, 0, "", 1, PHASE.PER_SEGMENT + 1)).toThrow(RangeError);
  });

  it("LayoutSeg 是 5 字节；start ≤ end，下标在范围内", () => {
    const req = cmdLayoutSeg(0, 1, 2, 10, 29);
    expect(req.command).toBe(0x22);
    expect(Array.from(req.payload)).toEqual([0, 1, 2, 10, 29]);
    expect(() => cmdLayoutSeg(0, 0, 0, 30, 10)).toThrow(RangeError);
    expect(() => cmdLayoutSeg(0, 0, MAX_PART_SEGS, 0, 1)).toThrow(RangeError);
    expect(() => cmdLayoutSeg(0, MAX_PARTS, 0, 0, 1)).toThrow(RangeError);
  });

  it("LayoutCommit 无载荷；QueryLayout 是 1 字节 strip", () => {
    expect(cmdLayoutCommit().command).toBe(0x23);
    expect(cmdLayoutCommit().payload.length).toBe(0);
    expect(Array.from(cmdQueryLayout(5).payload)).toEqual([5]);
    expect(() => cmdQueryLayout(MAX_STRIPS)).toThrow(RangeError);
  });

  it("parseLayoutReport 解出名字、相位与段列表（45 字节）", () => {
    const payload = new Uint8Array(45);
    payload[0] = 0;
    payload[1] = 2;
    payload[2] = 6;
    payload.set([0xe6, 0x95, 0xa3, 0xe7, 0x83, 0xad], 3); /* 「散热」 */
    payload[27] = 2;
    payload[28] = PHASE.PER_SEGMENT;
    payload[29] = 11;
    payload[30] = 29;
    payload[31] = 40;
    payload[32] = 49;
    const report = parseLayoutReport(payload);
    expect(report.stripId).toBe(0);
    expect(report.partId).toBe(2);
    expect(report.name).toBe("散热");
    expect(report.phase).toBe(PHASE.PER_SEGMENT);
    expect(report.segs).toEqual([
      [11, 29],
      [40, 49],
    ]);
    /* 旧的 44 字节报告必须拒（宽度是契约）。 */
    expect(() => parseLayoutReport(new Uint8Array(44))).toThrow(RangeError);
  });

  it("parseLayoutListEnd 是 2 字节 [strip, mask]", () => {
    const end = parseLayoutListEnd(Uint8Array.from([3, 0x05]));
    expect(end).toEqual({ stripId: 3, partMask: 0x05 });
    expect(() => parseLayoutListEnd(Uint8Array.from([3]))).toThrow(RangeError);
  });
});

describe("场景族 0x25-0x29", () => {
  it("ScenePart 是 6 字节；step_count ≤ 8、loop ≤ 2、on ∈ {0,1}", () => {
    const req = cmdScenePart(1, 2, 3, 8, 2, true);
    expect(req.command).toBe(0x25);
    expect(Array.from(req.payload)).toEqual([1, 2, 3, 8, 2, 1]);
    expect(() => cmdScenePart(0, 0, 0, MAX_STEPS + 1, 1, true)).toThrow(RangeError);
    expect(() => cmdScenePart(0, 0, 0, 1, 3, true)).toThrow(RangeError);
    expect(() => cmdScenePart(MAX_SCENES, 0, 0, 1, 1, true)).toThrow(RangeError);
  });

  it("SceneStep 是 24 字节：前缀 6 + 两层各 9", () => {
    const req = cmdSceneStep({
      sceneId: 0,
      stripId: 1,
      partId: 2,
      stepIndex: 3,
      durationMs: 1500,
      layer0: staticLayer(0, 255, 100),
      layer1: EMPTY_LAYER,
    });
    expect(req.command).toBe(0x26);
    expect(req.payload.length).toBe(SCENE_STEP_BYTES);
    expect(Array.from(req.payload.slice(0, 6))).toEqual([0, 1, 2, 3, 1500 & 0xff, 1500 >> 8]);
    expect(req.payload[6]).toBe(EFFECT_TYPE.STATIC);
    expect(req.payload[15]).toBe(NO_EFFECT);
  });

  it("SceneStep 的时长区间 100-60000", () => {
    const build = (durationMs: number) =>
      cmdSceneStep({
        sceneId: 0,
        stripId: 0,
        partId: 0,
        stepIndex: 0,
        durationMs,
        layer0: staticLayer(0, 255, 100),
        layer1: EMPTY_LAYER,
      });
    expect(build(100).payload.length).toBeGreaterThan(0);
    expect(build(60000).payload.length).toBeGreaterThan(0);
    expect(() => build(99)).toThrow(RangeError);
    expect(() => build(0)).toThrow(RangeError);
    expect(() => build(60001)).toThrow(RangeError);
  });

  it("SceneName 是 26 字节；name_len ≤ 24", () => {
    const req = cmdSceneName(1, "待机");
    expect(req.command).toBe(0x27);
    expect(req.payload.length).toBe(SCENE_NAME_BYTES);
    expect(req.payload[0]).toBe(1);
    expect(req.payload[1]).toBe(6);
    expect(() => cmdSceneName(0, "abcdefghijklmnopqrstuvwxyz")).toThrow(RangeError);
  });

  it("ActivateScene / QueryScene 是 1 字节 scene", () => {
    expect(Array.from(cmdActivateScene(2).payload)).toEqual([2]);
    expect(Array.from(cmdQueryScene(0).payload)).toEqual([0]);
    expect(() => cmdActivateScene(MAX_SCENES)).toThrow(RangeError);
    expect(() => cmdQueryScene(MAX_SCENES)).toThrow(RangeError);
  });

  it("parseSceneStepReport 与 SceneStep 同构", () => {
    const payload = new Uint8Array(SCENE_STEP_BYTES);
    payload[0] = 1;
    payload[1] = 2;
    payload[2] = 3;
    payload[3] = 4;
    payload[4] = 0xe8;
    payload[5] = 0x03;
    payload.set([EFFECT_TYPE.STATIC, 0, 0, 255, 0, 0, 0, 0, 100], 6);
    payload[15] = NO_EFFECT;
    const report = parseSceneStepReport(payload);
    expect(report.sceneId).toBe(1);
    expect(report.durationMs).toBe(1000);
    expect(report.layer0.type).toBe(EFFECT_TYPE.STATIC);
    expect(report.layer1.type).toBe(NO_EFFECT);
  });

  it("parseScenePartReport 是 6 字节", () => {
    const report = parseScenePartReport(Uint8Array.from([0, 1, 2, 3, 2, 1]));
    expect(report).toEqual({
      sceneId: 0,
      stripId: 1,
      partId: 2,
      stepCount: 3,
      loop: 2,
      on: true,
    });
  });

  it("parseSceneListEnd 是 26 字节", () => {
    const payload = new Uint8Array(SCENE_NAME_BYTES);
    payload[0] = 2;
    payload[1] = 6;
    payload.set([0xe5, 0xbe, 0x85, 0xe6, 0x9c, 0xba], 2); /* 「待机」 */
    expect(parseSceneListEnd(payload)).toEqual({ sceneId: 2, nameLen: 6, name: "待机" });
  });
});

describe("parseState（v5：32 字节）", () => {
  it("逐字段解析 §7.3 的偏移", () => {
    const payload = new Uint8Array(STATE_BYTES);
    payload[0] = 1; /* power */
    payload[1] = 128; /* brightness */
    payload[2] = 200; /* maxBrightness */
    payload[3] = 3; /* stripCount */
    payload[4] = 0x07; /* stripPowerMask */
    payload[5] = 2; /* activeScene */
    payload[6] = 1; /* layoutValid */
    payload[8] = 30; /* led_count[0] */
    payload[10] = 60; /* led_count[1] */
    payload[12] = 100; /* led_count[2] */
    payload[24] = 1; /* part_count[0] */
    payload[25] = 2; /* part_count[1] */
    const state = parseState(payload);
    expect(state.power).toBe(1);
    expect(state.brightness).toBe(128);
    expect(state.maxBrightness).toBe(200);
    expect(state.stripCount).toBe(3);
    expect(state.stripPowerMask).toBe(0x07);
    expect(state.activeScene).toBe(2);
    expect(state.layoutValid).toBe(true);
    expect(state.stripLedCounts.slice(0, 3)).toEqual([30, 60, 100]);
    expect(state.partCounts.slice(0, 2)).toEqual([1, 2]);
  });

  it("长度必须精确 32（v4 的 37 字节一律拒）", () => {
    expect(() => parseState(new Uint8Array(31))).toThrow(RangeError);
    expect(() => parseState(new Uint8Array(33))).toThrow(RangeError);
    expect(() => parseState(new Uint8Array(37))).toThrow(RangeError);
  });
});

describe("StripConfigReport 0x87 / DeviceInfoReport 0x88", () => {
  it("StripConfigReport 是 8 × 3 字节，flags bit0 = 已分配", () => {
    const payload = new Uint8Array(24);
    for (let i = 0; i < 8; i += 1) {
      payload[i * 3] = i;
      payload[i * 3 + 1] = i < 3 ? [3, 10, 0][i] : 0xff;
      payload[i * 3 + 2] = i < 3 ? 0x01 : 0x00;
    }
    const config = parseStripConfigReport(payload);
    expect(config.channels.length).toBe(8);
    expect(config.channels[0]).toMatchObject({ stripId: 0, gpio: 3, assigned: true });
    expect(config.channels[7].assigned).toBe(false);
    expect(config.channels[7].gpio).toBe(0xff);
  });

  it("DeviceInfoReport 是 15 字节；v5 的五个上限与 caps", () => {
    const payload = new Uint8Array(15);
    payload[0] = 0x00;
    payload[1] = 0x05; /* version 0x0500 */
    payload.set([0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff], 2);
    payload[8] = MAX_LEDS;
    payload[9] = MAX_STRIPS;
    payload[10] = MAX_PARTS;
    payload[11] = MAX_PART_SEGS;
    payload[12] = MAX_STEPS;
    payload[13] = MAX_SCENES;
    payload[14] = 0x01;
    const info = parseDeviceInfoReport(payload);
    expect(info.firmwareMajor).toBe(5);
    expect(info.firmwareMinor).toBe(0);
    expect(info.hwId).toBe("AA:BB:CC:DD:EE:FF");
    expect(info.maxLeds).toBe(MAX_LEDS);
    expect(info.maxParts).toBe(MAX_PARTS);
    expect(info.maxPartSegs).toBe(MAX_PART_SEGS);
    expect(info.maxSteps).toBe(MAX_STEPS);
    expect(info.maxScenes).toBe(MAX_SCENES);
    expect(info.supportsTwoLayers).toBe(true);
    expect(info.fadeImplemented).toBe(false);
  });
});

describe("parseAck", () => {
  it("2 字节 [命令字, 结果码]，ok 只看结果码是否 0", () => {
    expect(parseAck(Uint8Array.from([0x26, 0x00]), 7)).toEqual({
      seq: 7,
      command: 0x26,
      resultCode: 0,
      ok: true,
    });
    expect(parseAck(Uint8Array.from([0x26, 0x06]), 8).ok).toBe(false);
    expect(() => parseAck(Uint8Array.from([0x26]), 1)).toThrow(RangeError);
  });
});

describe("v4 命令字已整体退役", () => {
  it("构造器里不存在段 / 剧本族的入口", async () => {
    const mod = (await import("../utils/protocol/commands")) as Record<string, unknown>;
    for (const name of [
      "cmdSetSegment",
      "cmdClearSegment",
      "cmdQueryStrip",
      "cmdSetPlayback",
      "cmdScriptBegin",
      "cmdScriptStage",
      "cmdScriptSegment",
      "cmdScriptCommit",
      "cmdScriptAbort",
      "cmdActivateScript",
      "cmdQueryScript",
      "cmdClearScript",
      "parseSegmentPayload",
      "parseSegmentReport",
      "parseSegmentListEnd",
      "parseScriptSummary",
      "parseScriptProgress",
    ]) {
      expect(mod[name], name).toBeUndefined();
    }
  });
});
