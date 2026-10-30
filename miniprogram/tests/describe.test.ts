/** 帧解析文本：面板、console、复制共用同一套描述（#13）。 */

import { describe, expect, it } from "vitest";

import {
  describeAck,
  describeCommand,
  describeEvent,
  describeState,
  describeStateRead,
  deviceCommandName,
} from "../utils/protocol/describe";
import { cmdSetAll, cmdSetBrightness, cmdSetColor, cmdSetLedCount, cmdSetPower } from "../utils/protocol/commands";
import { CMD, DEVICE_CMD } from "../utils/protocol/constants";

describe("describeCommand", () => {
  it("从载荷解析出命令名与参数", () => {
    expect(describeCommand(CMD.SET_POWER, cmdSetPower(true).payload)).toBe("SetPower power=1");
    expect(describeCommand(CMD.SET_BRIGHTNESS, cmdSetBrightness(128).payload)).toBe(
      "SetBrightness brightness=128",
    );
    expect(describeCommand(CMD.SET_COLOR, cmdSetColor({ r: 255, g: 180, b: 120 }).payload)).toBe(
      "SetColor rgb=255,180,120",
    );
    expect(
      describeCommand(CMD.SET_ALL, cmdSetAll(1, 128, { r: 255, g: 180, b: 120 }).payload),
    ).toBe("SetAll power=1 brightness=128 rgb=255,180,120");
    expect(describeCommand(CMD.SET_LED_COUNT, cmdSetLedCount(30).payload)).toBe(
      "SetLedCount count=30",
    );
    expect(describeCommand(CMD.QUERY_STATE, new Uint8Array(0))).toBe("QueryState");
    expect(describeCommand(CMD.SELF_TEST, new Uint8Array(0))).toBe("SelfTest");
  });

  it("载荷长度不符时保留命令名与原始 hex，不丢证据", () => {
    expect(describeCommand(CMD.SET_POWER, new Uint8Array([0, 1]))).toBe("SetPower 00 01");
    expect(describeCommand(CMD.SET_COLOR, new Uint8Array([1]))).toBe("SetColor 01");
    expect(describeCommand(0x7f, new Uint8Array([0xde]))).toBe("0x7F DE");
  });

  it("设备命令名覆盖 ACK / Event / StateReport", () => {
    expect(deviceCommandName(DEVICE_CMD.ACK)).toBe("ACK");
    expect(deviceCommandName(DEVICE_CMD.EVENT)).toBe("Event");
    expect(deviceCommandName(DEVICE_CMD.STATE_REPORT)).toBe("StateReport");
  });
});

describe("describeAck / describeState / describeEvent", () => {
  it("ACK 带原命令字、结果码与成败", () => {
    expect(describeAck({ seq: 3, command: CMD.SET_POWER, resultCode: 0, ok: true })).toBe(
      "ACK SetPower cmd=0x01 result=0x00 OK",
    );
    expect(describeAck({ seq: 9, command: CMD.SET_LED_COUNT, resultCode: 5, ok: false })).toBe(
      "ACK SetLedCount cmd=0x06 result=0x05 FAIL",
    );
  });

  it("State 字段与协议 §7 顺序一致", () => {
    expect(
      describeState({
        power: 1,
        brightness: 128,
        r: 255,
        g: 180,
        b: 120,
        ledCount: 30,
        maxBrightness: 255,
      }),
    ).toBe("State power=1 brightness=128 rgb=255,180,120 leds=30 max=255");
  });

  it("State read 与 StateReport 用同一组字段但前缀不同", () => {
    const state = {
      power: 0 as const,
      brightness: 0,
      r: 0,
      g: 0,
      b: 0,
      ledCount: 30,
      maxBrightness: 255,
    };
    expect(describeStateRead(state)).toBe(
      "State read power=0 brightness=0 rgb=0,0,0 leds=30 max=255",
    );
  });

  it("存储失败 Event 指明原命令字", () => {
    expect(describeEvent(0x01, CMD.SET_ALL)).toBe(
      "Event storage_failed(0x01) cmd=SetAll(0x04) detail=0x04",
    );
    expect(describeEvent(0x02, 0x07)).toBe("Event 0x02 detail=0x07");
  });
});
