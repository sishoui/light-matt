/** 命令构造器与载荷解析。 */

import { describe, expect, it } from "vitest";

import { bytesToCompactHex, hexToBytes } from "../utils/protocol/hex";
import {
  cmdQueryState,
  cmdSelfTest,
  cmdSetBrightness,
  cmdSetLedCount,
  cmdSetPower,
  parseAck,
  parseState,
  stateHasScript,
  stateLoop,
  stateScriptActive,
} from "../utils/protocol/commands";

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

  it("QueryState / SelfTest 无载荷", () => {
    expect(cmdQueryState().payload.length).toBe(0);
    expect(cmdSelfTest().payload.length).toBe(0);
  });

  it("SetLedCount 载荷 strip_id + 小端 2 字节数量，数量 1-64", () => {
    expect(bytesToCompactHex(cmdSetLedCount(0, 30).payload)).toBe("001E00");
    expect(bytesToCompactHex(cmdSetLedCount(0, 64).payload)).toBe("004000");
    expect(bytesToCompactHex(cmdSetLedCount(7, 1).payload)).toBe("070100");
    expect(cmdSetLedCount(0, 30).command).toBe(0x06);
    /* 数量越界 / 非整数 / strip_id 越界都直接抛错，不发帧。 */
    expect(() => cmdSetLedCount(0, 0)).toThrow(RangeError);
    expect(() => cmdSetLedCount(0, 65)).toThrow(RangeError);
    expect(() => cmdSetLedCount(0, 1.2)).toThrow(RangeError);
    expect(() => cmdSetLedCount(-1, 30)).toThrow(RangeError);
    expect(() => cmdSetLedCount(8, 30)).toThrow(RangeError);
  });

  it("编码与共用向量一致（set_led_count_30）", () => {
    expect(bytesToCompactHex(cmdSetLedCount(0, 30).payload)).toBe("001E00");
  });
});

describe("载荷解析", () => {
  it("parseState 读 14 字节，前 8 字节沿用 v1 布局", () => {
    const bytes = hexToBytes("0180FFB4781E00FF0100FF000000") as Uint8Array;
    expect(parseState(bytes)).toEqual({
      power: 1,
      brightness: 128,
      r: 255,
      g: 180,
      b: 120,
      ledCount: 30,
      maxBrightness: 255,
      stripCount: 1,
      segCount: 0,
      scriptId: 0xff,
      stageIndex: 0,
      playbackState: 0,
      flags: 0,
    });
  });

  it("parseState 读 v2 摘要字段（剧本 / 段 / 播放）", () => {
    const bytes = hexToBytes("01C800FF003C00C8010200030103") as Uint8Array;
    const state = parseState(bytes);
    expect(state.ledCount).toBe(60);
    expect(state.maxBrightness).toBe(200);
    expect(state.stripCount).toBe(1);
    expect(state.segCount).toBe(2);
    expect(state.scriptId).toBe(0);
    expect(state.stageIndex).toBe(3);
    expect(state.playbackState).toBe(1);
    expect(state.flags).toBe(0x03);
    expect(stateLoop(state)).toBe(true);
    expect(stateScriptActive(state)).toBe(true);
    expect(stateHasScript(state)).toBe(true);
  });

  it("parseState 只接受 14 字节，不尽量解析", () => {
    expect(() => parseState(new Uint8Array(8))).toThrow(RangeError);
    expect(() => parseState(new Uint8Array(13))).toThrow(RangeError);
    expect(() => parseState(new Uint8Array(15))).toThrow(RangeError);
  });

  it("parseState 拒绝非法 power / strip_count / playback_state", () => {
    const bad = hexToBytes("0280FFB4781E00FF0100FF000000") as Uint8Array;
    expect(() => parseState(bad)).toThrow(RangeError);

    const noStrip = hexToBytes("0180FFB4781E00FF0000FF000000") as Uint8Array;
    expect(() => parseState(noStrip)).toThrow(RangeError);

    const tooManyStrips = hexToBytes("0180FFB4781E00FF0900FF000000") as Uint8Array;
    expect(() => parseState(tooManyStrips)).toThrow(RangeError);

    const badPlayback = hexToBytes("0180FFB4781E00FF0100FF000300") as Uint8Array;
    expect(() => parseState(badPlayback)).toThrow(RangeError);
  });

  it("parseAck 读 [原命令字, 结果码]，ok 只在结果码为 0 时为真", () => {
    expect(parseAck(new Uint8Array([0x01, 0x00]), 1)).toEqual({
      seq: 1,
      command: 1,
      resultCode: 0,
      ok: true,
    });
    expect(parseAck(new Uint8Array([0x01, 0x01]), 13)).toEqual({
      seq: 13,
      command: 1,
      resultCode: 1,
      ok: false,
    });
    expect(() => parseAck(new Uint8Array([0x01]), 1)).toThrow(RangeError);
  });
});
