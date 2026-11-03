/**
 * #98 协议扩展的编解码：流光密度 / 实色拖尾、随机闪烁、循环三值。
 *
 * 这里只测「字节」与「拒绝规则」——固件的像素数学另有 host 测试。
 * 关键不变量：
 *   - 流光与随机闪烁**都不扩宽层编码**（仍是 9 字节 / 段仍 23、25 字节）；
 *   - 循环三值 0/1/2 合法、3 拒绝，旧布尔写法仍可用；
 *   - State / ScriptSummary 的循环位走同一张位表。
 */

import { describe, expect, it } from "vitest";

import {
  cmdActivateScript,
  cmdSetPlayback,
  cmdSetSegment,
  cmdScriptSegment,
  cometFlags,
  cometHeads,
  cometSolidTail,
  loopFlags,
  loopModeFromFlags,
  parseScriptSummary,
  parseSegmentPayload,
  parseState,
  stateLoop,
  stateLoopMode,
} from "../utils/protocol/commands";
import { describeLayer, describeScriptSummary } from "../utils/protocol/describe";
import {
  COMET_FLAG,
  COMET_FLAGS_RESERVED,
  FLICKER_MIN_PERIOD_MS,
  LOOP,
  PLAYBACK_FLAG,
  SEGMENT_TYPE,
} from "../utils/protocol/constants";
import { bytesToCompactHex, hexToBytes } from "../utils/protocol/hex";
import { baseState } from "./helpers/state";
import type { EffectLayer, SegmentSpec } from "../utils/protocol/types";

/** 一层流光 / 随机闪烁的便捷构造（level 满亮）。 */
function layer(type: number, overrides: Partial<EffectLayer> = {}): EffectLayer {
  return {
    type,
    hue: 7281,
    sat: 255,
    periodMs: 1000,
    p5: 64,
    flags: 0,
    level: 100,
    ...overrides,
  };
}

function spec(layer0: EffectLayer): SegmentSpec {
  return {
    stripId: 0,
    segId: 0,
    start: 0,
    end: 9,
    blend: 0,
    layer0,
    layer1: { type: 0xff, hue: 0, sat: 0, periodMs: 0, p5: 0, flags: 0, level: 0 },
  };
}

describe("#98 流光：密度与实色拖尾都进 flags 字节", () => {
  it("头数量 1-4 编码到 bit2-3，且能解回", () => {
    for (let heads = 1; heads <= 4; heads += 1) {
      const flags = cometFlags(heads);
      /* 头数量绝不碰保留位，也绝不碰 direction / 拖尾位。 */
      expect(flags & COMET_FLAGS_RESERVED).toBe(0);
      expect(flags & 0x03).toBe(0);
      expect(cometHeads(flags)).toBe(heads);
    }
    expect(cometFlags(1)).toBe(0x00);
    expect(cometFlags(2)).toBe(0x04);
    expect(cometFlags(3)).toBe(0x08);
    expect(cometFlags(4)).toBe(0x0c);
  });

  it("实色拖尾是 bit1、反向是 bit0，两者可与密度叠加", () => {
    expect(cometFlags(1, { solidTail: true })).toBe(COMET_FLAG.SOLID_TAIL);
    expect(cometSolidTail(cometFlags(1, { solidTail: true }))).toBe(true);
    expect(cometSolidTail(cometFlags(1))).toBe(false);
    expect(cometFlags(4, { solidTail: true, reverse: true })).toBe(0x0f);
    expect(cometHeads(0x0f)).toBe(4);
  });

  it("头数量越界直接抛错（不静默钳位）", () => {
    expect(() => cometFlags(0)).toThrow(RangeError);
    expect(() => cometFlags(5)).toThrow(RangeError);
    expect(() => cometFlags(2.5)).toThrow(RangeError);
  });

  it("段载荷仍是 23 字节，flags 原样落到第 7 个参数字节", () => {
    const payload = cmdSetSegment(
      spec(layer(SEGMENT_TYPE.COMET, { flags: cometFlags(4, { solidTail: true }) })),
    ).payload;
    expect(payload.length).toBe(23);
    expect(payload[5]).toBe(SEGMENT_TYPE.COMET);
    expect(payload[5 + 7]).toBe(0x0e); /* flags：2 个头位全满 + 实色 */
    /* 读回后头数量与拖尾形状不变。 */
    const parsed = parseSegmentPayload(payload);
    expect(cometHeads(parsed.layer0.flags)).toBe(4);
    expect(cometSolidTail(parsed.layer0.flags)).toBe(true);
  });

  it("bit4-7 保留位非 0 → 本端就拒绝（写入与解析两侧）", () => {
    expect(() =>
      cmdSetSegment(spec(layer(SEGMENT_TYPE.COMET, { flags: 0x10 }))),
    ).toThrow(RangeError);
    const payload = cmdSetSegment(spec(layer(SEGMENT_TYPE.COMET, { flags: 0 }))).payload;
    const tampered = new Uint8Array(payload);
    tampered[5 + 7] = 0x10;
    expect(() => parseSegmentPayload(tampered)).toThrow(RangeError);
  });

  it("周期下限仍是 200ms（流光属于空间移动）", () => {
    expect(() =>
      cmdSetSegment(spec(layer(SEGMENT_TYPE.COMET, { periodMs: 199 }))),
    ).toThrow(RangeError);
    expect(() =>
      cmdSetSegment(spec(layer(SEGMENT_TYPE.COMET, { periodMs: 200 }))),
    ).not.toThrow();
  });

  it("日志描述写头数量与实色拖尾（不是只写 reverse）", () => {
    const text = describeLayer(
      layer(SEGMENT_TYPE.COMET, { flags: cometFlags(3, { solidTail: true }), p5: 64 }),
    );
    expect(text).toContain("heads=3");
    expect(text).toContain("solid=1");
    expect(text).toContain("tail=64");
  });
});

describe("#98 随机闪烁 0x07：新类型，参数块不变", () => {
  it("层仍是 9 字节、段仍是 23 / 25 字节", () => {
    const payload = cmdSetSegment(
      spec(layer(SEGMENT_TYPE.FLICKER, { p5: 128 })),
    ).payload;
    expect(payload.length).toBe(23);
    const scriptPayload = cmdScriptSegment(0, 0, spec(layer(SEGMENT_TYPE.FLICKER))).payload;
    expect(scriptPayload.length).toBe(25);
    expect(scriptPayload[2 + 5]).toBe(SEGMENT_TYPE.FLICKER);
  });

  it("p5 是同时亮着的比例，原样落到参数块", () => {
    const payload = cmdSetSegment(spec(layer(SEGMENT_TYPE.FLICKER, { p5: 200 }))).payload;
    expect(payload[5 + 6]).toBe(200);
    expect(parseSegmentPayload(payload).layer0.p5).toBe(200);
  });

  it("flags 必须为 0、周期 0 或 ≥ 334ms", () => {
    expect(() =>
      cmdSetSegment(spec(layer(SEGMENT_TYPE.FLICKER, { flags: 0x01 }))),
    ).toThrow(RangeError);
    expect(() =>
      cmdSetSegment(spec(layer(SEGMENT_TYPE.FLICKER, { periodMs: 333 }))),
    ).toThrow(RangeError);
    expect(() =>
      cmdSetSegment(spec(layer(SEGMENT_TYPE.FLICKER, { periodMs: FLICKER_MIN_PERIOD_MS }))),
    ).not.toThrow();
    expect(() =>
      cmdSetSegment(spec(layer(SEGMENT_TYPE.FLICKER, { periodMs: 0 }))),
    ).not.toThrow();
  });

  it("解析侧用同一条规则（读回坏配置不静默接受）", () => {
    const payload = cmdSetSegment(spec(layer(SEGMENT_TYPE.FLICKER))).payload;
    const badPeriod = new Uint8Array(payload);
    badPeriod[5 + 4] = 333 & 0xff;
    badPeriod[5 + 5] = 333 >> 8;
    expect(() => parseSegmentPayload(badPeriod)).toThrow(RangeError);

    const badFlags = new Uint8Array(payload);
    badFlags[5 + 7] = 0x01;
    expect(() => parseSegmentPayload(badFlags)).toThrow(RangeError);
  });

  it("可以作为叠加层（layer1）", () => {
    const payload = cmdSetSegment({
      ...spec(layer(SEGMENT_TYPE.STATIC, { periodMs: 0, p5: 0 })),
      blend: 1,
      layer1: layer(SEGMENT_TYPE.FLICKER),
    }).payload;
    expect(payload.length).toBe(23);
    expect(parseSegmentPayload(payload).layer1.type).toBe(SEGMENT_TYPE.FLICKER);
  });

  it("旧固件的未知类型行为：0x07 在旧类型表之外（本端现在是已知类型）", () => {
    /* 这条只是把「0x07 曾被当作未知值」的历史钉住：现在它合法，
     * 而第一个真正未知的洞是 0x08。 */
    const payload = cmdSetSegment(spec(layer(SEGMENT_TYPE.FLICKER))).payload;
    expect(payload[5]).toBe(0x07);
    expect(() =>
      cmdSetSegment(spec(layer(0x08, { periodMs: 1000 }))),
    ).toThrow(RangeError);
  });
});

describe("#98 循环三值", () => {
  it("SetPlayback / ActivateScript 接受 0/1/2", () => {
    expect(bytesToCompactHex(cmdSetPlayback(1, LOOP.NONE).payload)).toBe("0100");
    expect(bytesToCompactHex(cmdSetPlayback(1, LOOP.ALL).payload)).toBe("0101");
    expect(bytesToCompactHex(cmdSetPlayback(1, LOOP.LAST).payload)).toBe("0102");
    expect(bytesToCompactHex(cmdActivateScript(0, LOOP.LAST).payload)).toBe("0002");
  });

  it("旧的布尔写法仍然可用（true = 全部循环、false = 不循环）", () => {
    expect(bytesToCompactHex(cmdSetPlayback(1, true).payload)).toBe("0101");
    expect(bytesToCompactHex(cmdSetPlayback(1, false).payload)).toBe("0100");
    expect(bytesToCompactHex(cmdActivateScript(2, true).payload)).toBe("0201");
  });

  it("3 越界，本端直接抛错（不静默钳位成 1）", () => {
    expect(() => cmdSetPlayback(1, 3)).toThrow(RangeError);
    expect(() => cmdActivateScript(0, 3)).toThrow(RangeError);
    expect(() => cmdSetPlayback(1, -1)).toThrow(RangeError);
    expect(() => cmdActivateScript(0, 1.5)).toThrow(RangeError);
  });

  it("位表：bit0 循环中（旧语义）、bit2 最后一步循环", () => {
    expect(loopFlags(LOOP.NONE)).toBe(0);
    expect(loopFlags(LOOP.ALL)).toBe(PLAYBACK_FLAG.LOOP);
    expect(loopFlags(LOOP.LAST)).toBe(
      PLAYBACK_FLAG.LOOP | PLAYBACK_FLAG.LOOP_LAST,
    );
    /* bit0 仍是「在循环」：旧读者看 bit0 不会误判。 */
    expect(loopFlags(LOOP.LAST) & 0x01).toBe(0x01);

    for (const mode of [LOOP.NONE, LOOP.ALL, LOOP.LAST]) {
      expect(loopModeFromFlags(loopFlags(mode))).toBe(mode);
    }
    /* 矛盾组合（bit2 无 bit0）按不循环处理。 */
    expect(loopModeFromFlags(PLAYBACK_FLAG.LOOP_LAST)).toBe(LOOP.NONE);
  });

  it("State 里循环位可读成三值，stateLoop 保持旧的布尔语义", () => {
    expect(stateLoopMode(baseState({ flags: 0x00 }))).toBe(LOOP.NONE);
    expect(stateLoopMode(baseState({ flags: 0x01 }))).toBe(LOOP.ALL);
    expect(stateLoopMode(baseState({ flags: 0x05 }))).toBe(LOOP.LAST);
    expect(stateLoop(baseState({ flags: 0x05 }))).toBe(true);
    expect(stateLoop(baseState({ flags: 0x00 }))).toBe(false);

    /* 真实 37 字节 State 的字节 10 也走同一套解析。 */
    const bytes = hexToBytes(
      "0180FFB478C8020001000703011E003C000000000000000000000000000204000000000000",
    ) as Uint8Array;
    const state = parseState(bytes);
    expect(state.flags).toBe(0x07);
    expect(stateLoopMode(state)).toBe(LOOP.LAST);
    expect(stateLoop(state)).toBe(true);
  });

  it("ScriptSummary 的 flags 与 State 同一张位表", () => {
    const summary = parseScriptSummary(new Uint8Array([0, 4, 0x07, 1]));
    expect(summary.loopMode).toBe(LOOP.LAST);
    expect(describeScriptSummary(summary)).toBe(
      "ScriptSummary script=0 stages=4 loop=2 active=1",
    );
    expect(parseScriptSummary(new Uint8Array([0, 2, 0x00, 0])).loopMode).toBe(LOOP.NONE);
    expect(parseScriptSummary(new Uint8Array([0, 2, 0x03, 1])).loopMode).toBe(LOOP.ALL);
  });
});
