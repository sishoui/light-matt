/** 帧解析文本：面板、console、复制共用同一套描述（#13 / #40）。 */

import { describe, expect, it } from "vitest";

import {
  describeAck,
  describeCommand,
  describeDeviceInfo,
  describeEvent,
  describeSegmentReport,
  describeState,
  describeStateRead,
  describeStateReadBytes,
  describeStripConfig,
  deviceCommandName,
} from "../utils/protocol/describe";
import {
  cmdClearSegment,
  cmdQueryDeviceInfo,
  cmdScriptBegin,
  cmdScriptStage,
  cmdSetBrightness,
  cmdSetLedCount,
  cmdSetPower,
  cmdSetStripPower,
  parseDeviceInfoReport,
  parseSegmentReport,
  parseStripConfigReport,
} from "../utils/protocol/commands";
import { CMD, DEVICE_CMD } from "../utils/protocol/constants";
import type { DeviceState } from "../utils/protocol/types";
import { hexToBytes } from "../utils/protocol/hex";
import { baseState } from "./helpers/state";

function state(overrides: Partial<DeviceState> = {}): DeviceState {
  return baseState(overrides);
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
    expect(describeCommand(CMD.QUERY_STRIP_CONFIG, new Uint8Array(0))).toBe("QueryStripConfig");
    expect(describeCommand(CMD.QUERY_DEVICE_INFO, cmdQueryDeviceInfo().payload)).toBe(
      "QueryDeviceInfo",
    );
  });

  it("v4 段命令：两层一起写出来（含各自亮度；单层也显式写 layer1=empty）", () => {
    /* 23 字节单层静态段：strip 0 / seg 0 / [0-9] / blend 0 / 静态红(level 100) / 空层。 */
    expect(
      describeCommand(
        CMD.SET_SEGMENT,
        hexToBytes("0000000900000000FF0000000064FF0000000000000000") as Uint8Array,
      ),
    ).toBe(
      "SetSegment strip=0 seg=0 range=0-9 blend=over " +
        "layer0=static(hue=0 sat=255 level=100) layer1=empty",
    );

    /* 两层：彩虹打底 + 呼吸相乘。 */
    expect(
      describeCommand(
        CMD.SET_SEGMENT,
        hexToBytes("0003003F01020000FFA00FFF006401000000DC05140064") as Uint8Array,
      ),
    ).toBe(
      "SetSegment strip=0 seg=3 range=0-63 blend=multiply " +
        "layer0=rainbow(hue=0 sat=255 level=100 period=4000 span=255 reverse=0 flags=0x00) " +
        "layer1=breathing(hue=0 sat=0 level=100 period=1500 min_level=20 waveform=正弦 flags=0x00)",
    );
  });

  it("段命令长度不符 / 解析失败时保留 hex，不猜半截参数", () => {
    expect(describeCommand(CMD.SET_SEGMENT, new Uint8Array(0))).toBe("SetSegment");
    expect(describeCommand(CMD.SET_SEGMENT, new Uint8Array([1, 2]))).toBe("SetSegment 01 02");
    expect(describeCommand(CMD.CLEAR_SEGMENT, cmdClearSegment(0, 3).payload)).toBe(
      "ClearSegment strip=0 seg=3",
    );
    expect(describeCommand(CMD.SET_STRIP_POWER, cmdSetStripPower(3, false).payload)).toBe(
      "SetStripPower strip=3 on=0",
    );
  });

  it("剧本命令：ScriptStage 带 fade", () => {
    expect(describeCommand(0x14, cmdScriptBegin(1, 4, 2).payload)).toBe(
      "ScriptBegin script=1 stages=4 strips=2",
    );
    expect(describeCommand(0x15, cmdScriptStage(0, 2, 1500).payload)).toBe(
      "ScriptStage script=0 stage=2 duration=1500ms fade=0ms",
    );
    expect(describeCommand(0x15, cmdScriptStage(0, 2, 1500, 250).payload)).toBe(
      "ScriptStage script=0 stage=2 duration=1500ms fade=250ms",
    );
  });

  it("载荷长度不符时保留命令名与原始 hex，不丢证据", () => {
    expect(describeCommand(CMD.SET_POWER, new Uint8Array([0, 1]))).toBe("SetPower 00 01");
    expect(describeCommand(CMD.SET_LED_COUNT, new Uint8Array([1]))).toBe("SetLedCount 01");
    expect(describeCommand(0x7f, new Uint8Array([0xde]))).toBe("0x7F DE");
  });

  it("设备命令名覆盖全部 v3 报告", () => {
    expect(deviceCommandName(DEVICE_CMD.ACK)).toBe("ACK");
    expect(deviceCommandName(DEVICE_CMD.EVENT)).toBe("Event");
    expect(deviceCommandName(DEVICE_CMD.STATE_REPORT)).toBe("StateReport");
    expect(deviceCommandName(DEVICE_CMD.SEGMENT_REPORT)).toBe("SegmentReport");
    expect(deviceCommandName(DEVICE_CMD.SCRIPT_PROGRESS)).toBe("ScriptProgress");
    expect(deviceCommandName(DEVICE_CMD.STRIP_CONFIG_REPORT)).toBe("StripConfigReport");
    expect(deviceCommandName(DEVICE_CMD.DEVICE_INFO_REPORT)).toBe("DeviceInfoReport");
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
    /* v3 的 ScriptTooLarge。 */
    expect(describeAck({ seq: 2, command: CMD.SCRIPT_COMMIT, resultCode: 0x0a, ok: false })).toBe(
      "ACK ScriptCommit cmd=0x17 result=0x0A FAIL",
    );
  });

  it("State 字段与 §7.3 顺序一致（含逐带摘要）", () => {
    expect(describeState(state())).toBe(
      "State power=1 brightness=128 rgb=255,180,120 leds=30 max=255 " +
        "strips=1 counts=30 segs=0 stripPower=0x01 stripAnim=0x00 " +
        "script=none play=0 flags=0x00",
    );
  });

  it("激活剧本时 script 显示 script_id/stage_index", () => {
    expect(
      describeState(
        state({ scriptId: 2, stageIndex: 5, playbackState: 1, flags: 0x03, segCount: 3 }),
      ),
    ).toBe(
      "State power=1 brightness=128 rgb=255,180,120 leds=30 max=255 " +
        "strips=1 counts=30 segs=3 stripPower=0x01 stripAnim=0x00 " +
        "script=2/5 play=1 flags=0x03",
    );
  });

  it("多灯带：counts / segs 按 strip_count 截断，掩码原样给出", () => {
    expect(
      describeState(
        state({
          stripCount: 2,
          stripCounts: [30, 60, 0, 0, 0, 0, 0, 0],
          stripSegCounts: [2, 4, 0, 0, 0, 0, 0, 0],
          stripPowerMask: 0x03,
          stripAnimMask: 0x01,
        }),
      ),
    ).toBe(
      "State power=1 brightness=128 rgb=255,180,120 leds=30 max=255 " +
        "strips=2 counts=30,60 segs=2,4 stripPower=0x03 stripAnim=0x01 " +
        "script=none play=0 flags=0x00",
    );
  });

  it("State read 与 StateReport 用同一组字段但前缀不同", () => {
    expect(describeStateRead(state({ power: 0, brightness: 0, r: 0, g: 0, b: 0 }))).toBe(
      "State read power=0 brightness=0 rgb=0,0,0 leds=30 max=255 " +
        "strips=1 counts=30 segs=0 stripPower=0x01 stripAnim=0x00 " +
        "script=none play=0 flags=0x00",
    );
  });

  it("State read 长度不是 37 时保留长度而不是瞎解析", () => {
    expect(describeStateReadBytes(new Uint8Array(14))).toBe(
      "State read（14 字节，无法解析；v4 要求 37 字节）",
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

describe("v3 新增报告的描述", () => {
  it("SegmentReport 描述含 blend 与两层", () => {
    const report = parseSegmentReport(
      hexToBytes("0003003F01020000FFA00FFF006401000000DC05140064") as Uint8Array,
    );
    expect(describeSegmentReport(report)).toContain("blend=multiply");
    expect(describeSegmentReport(report)).toContain("layer1=breathing(");
  });

  it("StripConfigReport：8 路 GPIO 与分配位", () => {
    const config = parseStripConfigReport(
      hexToBytes("000301010A0102000103FF0004FF0005FF0006FF0007FF00") as Uint8Array,
    );
    expect(describeStripConfig(config)).toBe(
      "StripConfigReport 0:gpio=3,on=1 1:gpio=10,on=1 2:gpio=0,on=1 " +
        "3:gpio=255,on=0 4:gpio=255,on=0 5:gpio=255,on=0 6:gpio=255,on=0 7:gpio=255,on=0",
    );
  });

  it("DeviceInfoReport：版本 / hw_id / 能力", () => {
    /* #72：max_leds 字节（偏移 8）现在是 0x64 = 100。 */
    const info = parseDeviceInfoReport(
      hexToBytes("0300AABBCCDDEEFF64080808040100") as Uint8Array,
    );
    expect(describeDeviceInfo(info)).toBe(
      "DeviceInfoReport fw=3.0 hw=AA:BB:CC:DD:EE:FF maxLeds=100 maxStrips=8 " +
        "maxSegments=8 maxStages=8 maxScripts=4 twoLayers=1 fade=0",
    );
  });
});
