/** 命令构造器与载荷解析。 */

import { describe, expect, it } from "vitest";

import { bytesToCompactHex, hexToBytes } from "../utils/protocol/hex";
import {
  cmdQueryState,
  cmdSelfTest,
  cmdSetAll,
  cmdSetBrightness,
  cmdSetColor,
  cmdSetLedCount,
  cmdSetPower,
  parseAck,
  parseState,
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

  it("SetColor 载荷顺序 R,G,B（不做 gamma、不乘亮度）", () => {
    expect(bytesToCompactHex(cmdSetColor({ r: 255, g: 0, b: 0 }).payload)).toBe("FF0000");
    expect(bytesToCompactHex(cmdSetColor({ r: 255, g: 180, b: 120 }).payload)).toBe("FFB478");
    expect(() => cmdSetColor({ r: 256, g: 0, b: 0 })).toThrow(RangeError);
  });

  it("SetAll 载荷顺序 power,brightness,R,G,B", () => {
    expect(bytesToCompactHex(cmdSetAll(1, 128, { r: 255, g: 180, b: 120 }).payload)).toBe(
      "0180FFB478",
    );
    expect(bytesToCompactHex(cmdSetAll(0, 128, { r: 255, g: 180, b: 120 }).payload)).toBe(
      "0080FFB478",
    );
    expect(() => cmdSetAll(2 as 0 | 1, 128, { r: 0, g: 0, b: 0 })).toThrow(RangeError);
  });

  it("QueryState / SelfTest 无载荷", () => {
    expect(cmdQueryState().payload.length).toBe(0);
    expect(cmdSelfTest().payload.length).toBe(0);
  });

  it("SetLedCount 小端 2 字节，1-64", () => {
    expect(bytesToCompactHex(cmdSetLedCount(30).payload)).toBe("1E00");
    expect(bytesToCompactHex(cmdSetLedCount(64).payload)).toBe("4000");
    expect(() => cmdSetLedCount(0)).toThrow(RangeError);
    expect(() => cmdSetLedCount(65)).toThrow(RangeError);
    expect(() => cmdSetLedCount(1.2)).toThrow(RangeError);
  });
});

describe("载荷解析", () => {
  it("parseState 读 8 字节，ledCount 小端，maxBrightness 进 UI", () => {
    const bytes = hexToBytes("0180FFB4781E00FF") as Uint8Array;
    expect(parseState(bytes)).toEqual({
      power: 1,
      brightness: 128,
      r: 255,
      g: 180,
      b: 120,
      ledCount: 30,
      maxBrightness: 255,
    });
  });

  it("parseState 只接受 8 字节，不尽量解析", () => {
    expect(() => parseState(new Uint8Array(7))).toThrow(RangeError);
    expect(() => parseState(new Uint8Array(9))).toThrow(RangeError);
  });

  it("parseState 拒绝非法 power", () => {
    const bytes = hexToBytes("0280FFB4781E00FF") as Uint8Array;
    expect(() => parseState(bytes)).toThrow(RangeError);
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
