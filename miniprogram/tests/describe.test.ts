/**
 * 帧解析文本：面板、console、复制共用同一套描述（docs/protocol-v5.md §7）。
 *
 * 这些字符串是串口 / 调试面板上的唯一线索，所以断言的是「字段与名字」而不是
 * 排版：改了字段顺序或漏了字段，日志就会误导排查。
 */

import { describe, expect, it } from "vitest";

import { EMPTY_LAYER, staticLayer } from "../utils/protocol/commands";
import {
  describeAck,
  describeCommand,
  describeDeviceInfo,
  describeEvent,
  describeLayer,
  describeLayoutListEnd,
  describeLayoutReport,
  describeSceneListEnd,
  describeScenePartReport,
  describeSceneStepReport,
  describeState,
  describeStateRead,
  describeStateReadBytes,
  describeStripConfig,
  deviceCommandName,
  layerTypeName,
} from "../utils/protocol/describe";

function hex(s: string): Uint8Array {
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

describe("describeCommand", () => {
  it("整机命令的参数", () => {
    expect(describeCommand(0x01, Uint8Array.from([1]))).toBe("SetPower power=1");
    expect(describeCommand(0x02, Uint8Array.from([128]))).toBe("SetBrightness brightness=128");
    expect(describeCommand(0x05, new Uint8Array([]))).toBe("QueryState");
    expect(describeCommand(0x07, new Uint8Array([]))).toBe("SelfTest");
    expect(describeCommand(0x06, Uint8Array.from([0, 0x1e, 0]))).toBe(
      "SetLedCount strip=0 count=30",
    );
  });

  it("灯组命令", () => {
    expect(describeCommand(0x1b, Uint8Array.from([3, 1]))).toBe("SetStripPower strip=3 on=1");
    expect(describeCommand(0x1c, new Uint8Array([]))).toBe("QueryStripConfig");
    expect(describeCommand(0x1d, new Uint8Array([]))).toBe("QueryDeviceInfo");
  });

  it("布局族：写部位 / 写段 / 提交 / 查询", () => {
    expect(describeCommand(0x20, Uint8Array.from([0, 3]))).toBe("LayoutWrite strip=0 parts=3");
    /* 29 字节（#158 起最后一字节是相位模式）。 */
    const partPayload = new Uint8Array(29);
    partPayload[0] = 1;
    partPayload[1] = 2;
    partPayload[2] = 6;
    partPayload[27] = 4;
    expect(describeCommand(0x21, partPayload)).toBe("LayoutPart strip=1 part=2 name_len=6 segs=4");
    expect(describeCommand(0x22, Uint8Array.from([0, 1, 2, 10, 29]))).toBe(
      "LayoutSeg strip=0 part=1 seg=2 range=10-29",
    );
    expect(describeCommand(0x23, new Uint8Array([]))).toBe("LayoutCommit");
    expect(describeCommand(0x24, Uint8Array.from([7]))).toBe("QueryLayout strip=7");
  });

  it("场景族：部位头 / 一步的两层 / 名字 / 激活 / 查询", () => {
    expect(describeCommand(0x25, Uint8Array.from([0, 1, 2, 3, 2, 1]))).toBe(
      "ScenePart scene=0 strip=1 part=2 steps=3 loop=2 on=1",
    );
    const stepPayload = new Uint8Array(24);
    stepPayload[0] = 0;
    stepPayload[1] = 1;
    stepPayload[2] = 2;
    stepPayload[3] = 0;
    stepPayload[4] = 0xe8;
    stepPayload[5] = 0x03;
    stepPayload.set([0x00, 0, 0, 255, 0, 0, 0, 0, 100], 6);
    stepPayload[15] = 0xff;
    const text = describeCommand(0x26, stepPayload);
    expect(text).toContain("scene=0 strip=1 part=2 step=0 duration=1000ms");
    expect(text).toContain("layer0=static");
    expect(text).toContain("layer1=empty");
    const namePayload = new Uint8Array(26);
    namePayload[0] = 0;
    namePayload[1] = 6;
    expect(describeCommand(0x27, namePayload)).toBe("SceneName scene=0 name_len=6");
    expect(describeCommand(0x28, Uint8Array.from([2]))).toBe("ActivateScene scene=2");
    expect(describeCommand(0x29, Uint8Array.from([1]))).toBe("QueryScene scene=1");
  });

  it("载荷长度不符时保留命令名与原始 hex，不丢证据", () => {
    expect(describeCommand(0x20, Uint8Array.from([0]))).toBe("LayoutWrite 00");
    /* 空载荷：命令名 + 空 hex（bytesToHex 对空数组给空串）。 */
    expect(describeCommand(0x24, new Uint8Array([])).trim()).toBe("QueryLayout");
  });

  it("v4 退役命令字不再有名字（给 hex）", () => {
    expect(describeCommand(0x12, Uint8Array.from([1]))).toContain("0x12");
    expect(describeCommand(0x17, new Uint8Array([]))).toContain("0x17");
  });
});

describe("describeLayer", () => {
  it("静态层带色相 / 饱和度 / 亮度", () => {
    expect(describeLayer(staticLayer(7281, 255, 50))).toBe("static(hue=7281 sat=255 level=50)");
  });

  it("空层只说 empty（没有亮度可言）", () => {
    expect(describeLayer(EMPTY_LAYER)).toBe("empty");
  });

  it("层类型名覆盖八种 + 空层", () => {
    expect(layerTypeName(0x00)).toBe("static");
    expect(layerTypeName(0x01)).toBe("breathing");
    expect(layerTypeName(0x02)).toBe("rainbow");
    expect(layerTypeName(0x03)).toBe("comet");
    expect(layerTypeName(0x04)).toBe("strobe");
    expect(layerTypeName(0x05)).toBe("heartbeat");
    expect(layerTypeName(0x06)).toBe("off");
    expect(layerTypeName(0x07)).toBe("flicker");
    expect(layerTypeName(0xff)).toBe("empty");
    expect(layerTypeName(0x09)).toContain("type0x09");
  });
});

describe("describeAck / describeState / describeEvent", () => {
  it("ACK 带原命令字、结果码与成败", () => {
    const ok = describeAck({ seq: 1, command: 0x20, resultCode: 0, ok: true });
    expect(ok).toContain("LayoutWrite");
    expect(ok).toContain("0x20");
    expect(ok).toContain("OK");
    const bad = describeAck({ seq: 2, command: 0x20, resultCode: 0x06, ok: false });
    expect(bad).toContain("FAIL");
    expect(bad).toContain("0x06");
  });

  it("State 字段与 §7.3 一致（32 字节：无颜色 / 无播放位置）", () => {
    const text = describeState({
      power: 1,
      brightness: 128,
      maxBrightness: 200,
      stripCount: 2,
      stripPowerMask: 0x03,
      activeScene: 1,
      layoutValid: true,
      stripLedCounts: [30, 60, 0, 0, 0, 0, 0, 0],
      partCounts: [2, 1, 0, 0, 0, 0, 0, 0],
    });
    expect(text).toContain("power=1");
    expect(text).toContain("brightness=128");
    expect(text).toContain("max=200");
    expect(text).toContain("strips=2");
    expect(text).toContain("counts=30,60");
    expect(text).toContain("parts=2,1");
    expect(text).toContain("stripPower=0x03");
    expect(text).toContain("scene=1");
    expect(text).toContain("layout=1");
    /* v5 明确不含这几项。 */
    expect(text).not.toContain("rgb=");
    expect(text).not.toContain("script=");
    expect(text).not.toContain("segs=");
  });

  it("State read 与 StateReport 用同一组字段但前缀不同", () => {
    const state = {
      power: 0 as const,
      brightness: 10,
      maxBrightness: 255,
      stripCount: 1,
      stripPowerMask: 0xff,
      activeScene: 0,
      layoutValid: false,
      stripLedCounts: [30, 0, 0, 0, 0, 0, 0, 0],
      partCounts: [0, 0, 0, 0, 0, 0, 0, 0],
    };
    expect(describeState(state).startsWith("State ")).toBe(true);
    expect(describeStateRead(state).startsWith("State read ")).toBe(true);
  });

  it("State read 长度不是 32 时保留长度而不是瞎解析", () => {
    const text = describeStateReadBytes(new Uint8Array(37));
    expect(text).toContain("37");
    expect(text).toContain("v5 要求 32");
  });

  it("存储失败 Event 指明原命令字", () => {
    const text = describeEvent(0x01, 0x26);
    expect(text).toContain("storage_failed");
    expect(text).toContain("SceneStep");
  });
});

describe("v5 新报告的描述", () => {
  it("LayoutReport 含部位号 / 名字长度 / 段区间", () => {
    const text = describeLayoutReport({
      stripId: 0,
      partId: 2,
      nameLen: 6,
      name: "散热",
      segCount: 2,
      segs: [
        [11, 29],
        [40, 49],
      ],
    });
    expect(text).toContain("strip=0 part=2");
    expect(text).toContain("name_len=6");
    expect(text).toContain("segs=2");
    expect(text).toContain("11-29,40-49");
  });

  it("LayoutListEnd 把掩码展开成部位号", () => {
    expect(describeLayoutListEnd({ stripId: 1, partMask: 0x05 })).toContain("parts=[0,2]");
  });

  it("ScenePartReport 含步数 / 循环 / 开关", () => {
    const text = describeScenePartReport({
      sceneId: 2,
      stripId: 1,
      partId: 3,
      stepCount: 4,
      loop: 2,
      on: true,
    });
    expect(text).toContain("scene=2 strip=1 part=3");
    expect(text).toContain("steps=4");
    expect(text).toContain("loop=2");
    expect(text).toContain("on=1");
  });

  it("SceneStepReport 与 SceneStep 字段一致", () => {
    const text = describeSceneStepReport({
      sceneId: 0,
      stripId: 0,
      partId: 0,
      stepIndex: 1,
      durationMs: 1500,
      layer0: staticLayer(0, 255, 100),
      layer1: EMPTY_LAYER,
    });
    expect(text).toContain("step=1");
    expect(text).toContain("duration=1500ms");
    /* v5 的混合方式不在线上：按有无叠加层推出 over / luma（§6.2）。 */
    expect(text).toContain("blend=over");
    expect(text).toContain("layer1=empty");
  });

  it("SceneListEnd 含场景号与名字长度", () => {
    expect(describeSceneListEnd({ sceneId: 1, nameLen: 6, name: "待机" })).toBe(
      "SceneListEnd scene=1 name_len=6",
    );
  });

  it("StripConfigReport：8 路 GPIO 与分配位", () => {
    const text = describeStripConfig({
      channels: Array.from({ length: 8 }, (_, i) => ({
        stripId: i,
        gpio: i < 3 ? [3, 10, 0][i] : 0xff,
        flags: i < 3 ? 1 : 0,
        assigned: i < 3,
      })),
    });
    expect(text).toContain("0:gpio=3,on=1");
    expect(text).toContain("7:gpio=255,on=0");
  });

  it("DeviceInfoReport：版本 / hw_id / v5 的五个上限", () => {
    const text = describeDeviceInfo({
      firmwareVersion: 0x0500,
      firmwareMajor: 5,
      firmwareMinor: 0,
      hwId: "AA:BB:CC:DD:EE:FF",
      maxLeds: 100,
      maxStrips: 8,
      maxParts: 8,
      maxPartSegs: 8,
      maxSteps: 8,
      maxScenes: 3,
      caps: 0x01,
      supportsTwoLayers: true,
      fadeImplemented: false,
    });
    expect(text).toContain("fw=5.0");
    expect(text).toContain("hw=AA:BB:CC:DD:EE:FF");
    expect(text).toContain("maxParts=8");
    expect(text).toContain("maxScenes=3");
    expect(text).toContain("twoLayers=1");
  });
});

describe("设备命令名（v5 报告集）", () => {
  it("覆盖全部 0x80-0x8D 里仍在用的命令", () => {
    expect(deviceCommandName(0x80)).toBe("ACK");
    expect(deviceCommandName(0x81)).toBe("Event");
    expect(deviceCommandName(0x82)).toBe("StateReport");
    expect(deviceCommandName(0x87)).toBe("StripConfigReport");
    expect(deviceCommandName(0x88)).toBe("DeviceInfoReport");
    expect(deviceCommandName(0x89)).toBe("LayoutReport");
    expect(deviceCommandName(0x8a)).toBe("LayoutListEnd");
    expect(deviceCommandName(0x8b)).toBe("ScenePartReport");
    expect(deviceCommandName(0x8c)).toBe("SceneStepReport");
    expect(deviceCommandName(0x8d)).toBe("SceneListEnd");
  });

  it("v4 已删除的四条报告不再有名字", () => {
    for (const cmd of [0x83, 0x84, 0x85, 0x86]) {
      expect(deviceCommandName(cmd)).toContain("0x");
    }
  });
});
