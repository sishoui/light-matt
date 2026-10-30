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
import { cmdSetBrightness, cmdSetLedCount, cmdSetPower } from "../utils/protocol/commands";
import { CMD, DEVICE_CMD } from "../utils/protocol/constants";
import type { DeviceState } from "../utils/protocol/types";

function state(overrides: Partial<DeviceState> = {}): DeviceState {
  return {
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
    ...overrides,
  };
}

describe("describeCommand", () => {
  it("从载荷解析出命令名与参数", () => {
    expect(describeCommand(CMD.SET_POWER, cmdSetPower(true).payload)).toBe("SetPower power=1");
    expect(describeCommand(CMD.SET_BRIGHTNESS, cmdSetBrightness(128).payload)).toBe(
      "SetBrightness brightness=128",
    );
    expect(describeCommand(CMD.SET_LED_COUNT, cmdSetLedCount(0, 30).payload)).toBe(
      "SetLedCount strip=0 count=30",
    );
    expect(describeCommand(CMD.SET_LED_COUNT, cmdSetLedCount(3, 64).payload)).toBe(
      "SetLedCount strip=3 count=64",
    );
    expect(describeCommand(CMD.QUERY_STATE, new Uint8Array(0))).toBe("QueryState");
    expect(describeCommand(CMD.SELF_TEST, new Uint8Array(0))).toBe("SelfTest");
  });

  it("#25 段命令按载荷解析参数；长度不足时保留 hex 不猜", () => {
    /* 静态段：strip, seg, start, end, type, hue_lo, hue_hi, sat */
    expect(describeCommand(CMD.SET_SEGMENT, new Uint8Array([0, 0, 0, 29, 0, 0, 0, 255]))).toBe(
      "SetSegment strip=0 seg=0 range=0-29 type=0x00 hue=0 sat=255",
    );
    /* 动画段多 4 字节（period / p5 / flags）。 */
    expect(
      describeCommand(
        CMD.SET_SEGMENT,
        new Uint8Array([0, 1, 0, 9, 1, 0x09, 0x01, 0x60, 0x0E, 0xFF, 0xF4, 0x01]),
      ),
    ).toBe(
      "SetSegment strip=0 seg=1 range=0-9 type=0x01 hue=265 sat=96 " +
        "period=65294 min_level=244 waveform=正弦 flags=0x01",
    );
    /* 呼吸段的波形从 flags bit1-2 解出：flags=0x04 → 锯齿。 */
    expect(
      describeCommand(
        CMD.SET_SEGMENT,
        new Uint8Array([0, 1, 0, 9, 1, 0x00, 0x00, 0xFF, 0xF4, 0x01, 0x00, 0x04]),
      ),
    ).toBe(
      "SetSegment strip=0 seg=1 range=0-9 type=0x01 hue=0 sat=255 " +
        "period=500 min_level=0 waveform=锯齿 flags=0x04",
    );
    /* 长度不足只给 hex，不猜半截参数。 */
    expect(describeCommand(CMD.SET_SEGMENT, new Uint8Array(0))).toBe("SetSegment");
    expect(describeCommand(CMD.SET_SEGMENT, new Uint8Array([1, 2]))).toBe("SetSegment 01 02");
    expect(describeCommand(CMD.CLEAR_SEGMENT, new Uint8Array([0, 3]))).toBe(
      "ClearSegment strip=0 seg=3",
    );
    expect(describeCommand(CMD.QUERY_STRIP, new Uint8Array([0]))).toBe("QueryStrip strip=0");
    expect(describeCommand(CMD.QUERY_SCRIPT, new Uint8Array([0]))).toBe("QueryScript 00");
  });

  it("载荷长度不符时保留命令名与原始 hex，不丢证据", () => {
    expect(describeCommand(CMD.SET_POWER, new Uint8Array([0, 1]))).toBe("SetPower 00 01");
    expect(describeCommand(CMD.SET_LED_COUNT, new Uint8Array([1]))).toBe("SetLedCount 01");
    expect(describeCommand(0x7f, new Uint8Array([0xde]))).toBe("0x7F DE");
  });

  it("设备命令名覆盖 ACK / Event / StateReport 与 v2 新增帧", () => {
    expect(deviceCommandName(DEVICE_CMD.ACK)).toBe("ACK");
    expect(deviceCommandName(DEVICE_CMD.EVENT)).toBe("Event");
    expect(deviceCommandName(DEVICE_CMD.STATE_REPORT)).toBe("StateReport");
    expect(deviceCommandName(DEVICE_CMD.SEGMENT_REPORT)).toBe("SegmentReport");
    expect(deviceCommandName(DEVICE_CMD.SCRIPT_PROGRESS)).toBe("ScriptProgress");
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

  it("State 字段与协议 §7 顺序一致（含 v2 摘要）", () => {
    expect(
      describeState({
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
      }),
    ).toBe(
      "State power=1 brightness=128 rgb=255,180,120 leds=30 max=255 " +
        "strips=1 segs=0 script=none play=0 flags=0x00",
    );
  });

  it("激活剧本时 script 显示 script_id/stage_index", () => {
    expect(
      describeState(
        state({ scriptId: 2, stageIndex: 5, playbackState: 1, flags: 0x03, segCount: 3 }),
      ),
    ).toBe(
      "State power=1 brightness=128 rgb=255,180,120 leds=30 max=255 " +
        "strips=1 segs=3 script=2/5 play=1 flags=0x03",
    );
  });

  it("State read 与 StateReport 用同一组字段但前缀不同", () => {
    expect(describeStateRead(state({ power: 0, brightness: 0, r: 0, g: 0, b: 0 }))).toBe(
      "State read power=0 brightness=0 rgb=0,0,0 leds=30 max=255 " +
        "strips=1 segs=0 script=none play=0 flags=0x00",
    );
  });

  it("存储失败 Event 指明原命令字", () => {
    expect(describeEvent(0x01, CMD.SET_LED_COUNT)).toBe(
      "Event storage_failed(0x01) cmd=SetLedCount(0x06) detail=0x06",
    );
    expect(describeEvent(0x02, 0x03)).toBe("Event script_commit_failed(0x02) script=3");
    expect(describeEvent(0x03, 0x07)).toBe("Event 0x03 detail=0x07");
  });
});
