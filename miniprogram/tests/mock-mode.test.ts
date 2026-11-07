/**
 * 演示传输层（`utils/ble/mock-transport.ts`）与演示数据播种。
 *
 * 这两块是「首页在没有真机时也有内容」的地基，必须证明它们**与真机同构**：
 *  - 连接后真的走 ready，State 的形状与真机一致（32 字节解析出来的那些字段）；
 *  - 写命令真的改内部状态，readState 读回新值（不是写死的假数据）；
 *  - QueryLayout / QueryScene / QueryStripConfig / QueryDeviceInfo 都给出设备权威形状；
 *  - 播种写进的是真实存储键，关闭后能干净移除。
 */

import { describe, expect, it } from "vitest";
import { MockTransport } from "../utils/ble/mock-transport";
import { MOCK_DEVICES, mockSpecOf } from "../utils/control/mock-devices";
import {
  clearMockDevices,
  hasRealDevices,
  isMockDeviceId,
  MOCK_PREF_KEY,
  mockModeEnabled,
  seedMockDevices,
  setMockMode,
} from "../utils/control/mock-mode";
import { loadRecentDevices, RECENT_DEVICES_KEY } from "../utils/control/device-history";
import { DEVICE_REGISTRY_KEY, loadRegistry } from "../utils/control/device-registry";
import { createSessionStorage } from "./helpers/storage";
import {
  cmdLayoutCommit,
  cmdLayoutPart,
  cmdLayoutSeg,
  cmdLayoutWrite,
  cmdSceneStep,
  cmdSetBrightness,
  cmdSetPower,
} from "../utils/protocol/commands";
import { MAX_STRIPS, PHASE } from "../utils/protocol/constants";

const FIRST = MOCK_DEVICES[0].deviceId;

async function connected(): Promise<MockTransport> {
  const transport = new MockTransport();
  await transport.connect(FIRST, "书桌");
  return transport;
}

describe("MockTransport：与真机同形", () => {
  it("连接后进入 ready，并且 State 字段齐全", async () => {
    const transport = await connected();
    expect(transport.linkState).toBe("ready");
    expect(transport.currentDeviceId).toBe(FIRST);
    const state = await transport.readState();
    const spec = mockSpecOf(FIRST)!;
    expect(state.stripCount).toBe(2);
    expect(state.stripLedCounts[0]).toBe(spec.stripCounts[0]);
    expect(state.maxBrightness).toBe(spec.maxBrightness);
    expect(state.stripLedCounts).toHaveLength(MAX_STRIPS);
    expect(state.partCounts).toHaveLength(MAX_STRIPS);
    expect(state.power).toBe(1);
    /* 出厂布局就是「有部位」，所以 layoutValid 为真（§7.3 字节 6）。 */
    expect(state.layoutValid).toBe(true);
  });

  it("SetBrightness 真的改状态（readState 读回新值）", async () => {
    const transport = await connected();
    const ack = await transport.sendAndWaitAck(cmdSetBrightness(42));
    expect(ack.ok).toBe(true);
    expect((await transport.readState()).brightness).toBe(42);
  });

  it("亮度按设备 maxBrightness 钳位", async () => {
    const transport = await connected();
    await transport.sendAndWaitAck(cmdSetBrightness(255));
    expect((await transport.readState()).brightness).toBe(200);
  });

  it("SetPower 改开关位", async () => {
    const transport = await connected();
    await transport.sendAndWaitAck(cmdSetPower(false));
    expect((await transport.readState()).power).toBe(0);
  });

  it("QueryDeviceInfo 给出 hwId 与能力位", async () => {
    const transport = await connected();
    const info = await transport.queryDeviceInfo();
    expect(info.hwId).toBe(mockSpecOf(FIRST)!.hwId);
    expect(info.supportsTwoLayers).toBe(true);
    /* v5 的演示设备报 0x0500（§4）。 */
    expect(info.firmwareVersion).toBe(0x0500);
    expect(info.maxParts).toBe(8);
    expect(info.maxScenes).toBe(3);
  });

  it("QueryStripConfig 给出 8 路，已分配的带 flags bit0", async () => {
    const transport = await connected();
    const config = await transport.queryStripConfig();
    expect(config.channels).toHaveLength(MAX_STRIPS);
    expect(config.channels[0].assigned).toBe(true);
    expect(config.channels[0].gpio).toBe(3);
    /* 该书桌设备只有 2 条带：第 3 路未分配。 */
    expect(config.channels[2].assigned).toBe(false);
    expect(config.channels[2].gpio).toBe(0xff);
  });

  it("QueryLayout 读回部位，形状与 LayoutReport 一致", async () => {
    const transport = await connected();
    const result = await transport.queryLayout(0);
    /* 书桌的 strip 0 出厂有两个部位（前半 / 后半）。 */
    expect(result.reports).toHaveLength(2);
    expect(result.end.stripId).toBe(0);
    expect(result.end.partMask).toBe(0b11);
    const first = result.reports[0];
    expect(first.partId).toBe(0);
    expect(first.name).toBe("前半");
    expect(first.segs).toEqual([[0, 13]]);
  });

  it("QueryScene 读回三个片段：部位头 / 每步 / 收尾", async () => {
    const transport = await connected();
    const report = await transport.queryScene(0);
    expect(report.sceneId).toBe(0);
    /* 书桌出厂每个部位 1 步常亮。 */
    expect(report.parts.length).toBe(report.steps.length);
    expect(report.parts[0].stepCount).toBe(1);
    expect(report.steps[0].layer0.type).toBe(0x00);
    expect(report.end.name).toBe("场景 1");
  });

  it("LayoutWrite + LayoutPart + LayoutSeg 之后再读回新布局", async () => {
    const transport = await connected();
    expect((await transport.sendAndWaitAck(cmdLayoutWrite(1, 1))).ok).toBe(true);
    expect((await transport.sendAndWaitAck(cmdLayoutPart(1, 0, "整条", 1, PHASE.CONTINUOUS))).ok).toBe(true);
    expect((await transport.sendAndWaitAck(cmdLayoutSeg(1, 0, 0, 0, 17))).ok).toBe(true);
    expect((await transport.sendAndWaitAck(cmdLayoutCommit())).ok).toBe(true);
    const result = await transport.queryLayout(1);
    expect(result.reports).toHaveLength(1);
    expect(result.reports[0].name).toBe("整条");
    expect(result.reports[0].segs).toEqual([[0, 17]]);
  });

  it("越界段被设备拒绝（end >= 灯珠数）", async () => {
    const transport = await connected();
    /* 书桌的 strip 1 只有 18 颗灯：end=20 越界。 */
    expect((await transport.sendAndWaitAck(cmdLayoutWrite(1, 1))).ok).toBe(true);
    expect((await transport.sendAndWaitAck(cmdLayoutPart(1, 0, "", 1, PHASE.CONTINUOUS))).ok).toBe(true);
    const ack = await transport.sendAndWaitAck(cmdLayoutSeg(1, 0, 0, 0, 20));
    expect(ack.ok).toBe(false);
    expect(ack.resultCode).toBe(0x01);
  });

  it("同链跨部位重叠被拒（一颗灯珠只属一个部位，S3）", async () => {
    const transport = await connected();
    /* strip 0 已有 0-13 与 14-29；给部位 1 写 5-10 会压到部位 0。 */
    const ack = await transport.sendAndWaitAck(cmdLayoutSeg(0, 1, 0, 5, 10));
    expect(ack.ok).toBe(false);
    expect(ack.resultCode).toBe(0x01);
  });

  it("SceneStep 之后 QueryScene 能读回这一步", async () => {
    const transport = await connected();
    const ack = await transport.sendAndWaitAck(
      cmdSceneStep({
        sceneId: 0,
        stripId: 0,
        partId: 0,
        stepIndex: 0,
        durationMs: 1234,
        layer0: {
          type: 0x00,
          hue: 1000,
          sat: 200,
          periodMs: 0,
          p5: 0,
          flags: 0,
          level: 100,
        },
        layer1: { type: 0xff, hue: 0, sat: 0, periodMs: 0, p5: 0, flags: 0, level: 0 },
      }),
    );
    expect(ack.ok).toBe(true);
    const report = await transport.queryScene(0);
    const step = report.steps.find((item) => item.stripId === 0 && item.partId === 0);
    expect(step?.durationMs).toBe(1234);
    expect(step?.layer0.hue).toBe(1000);
  });

  it("未知 deviceId 连接失败并进入 failed", async () => {
    const transport = new MockTransport();
    await expect(transport.connect("DE:AD:BE:EF:00:99")).rejects.toThrow();
    expect(transport.linkState).toBe("failed");
  });

  it("扫描会给出三台演示设备，并标出附近的新设备", async () => {
    const transport = new MockTransport();
    await transport.openAdapter();
    const seen: string[][] = [];
    transport.onDevices((list) => seen.push(list.map((device) => device.deviceId)));
    await transport.startScan();
    /* 第一批：三台已知设备。 */
    expect(seen[0]).toHaveLength(3);
    await new Promise((resolve) => setTimeout(resolve, 700));
    /* 第二批：多一台「附近未登记」。 */
    expect(seen[seen.length - 1]).toHaveLength(4);
    await transport.stopScan();
    expect(transport.linkState).toBe("idle");
  });

  it("未连接时写命令直接报错（不静默成功）", async () => {
    const transport = new MockTransport();
    await expect(transport.sendAndWaitAck(cmdSetPower(true))).rejects.toThrow("未连接");
    await expect(transport.readState()).rejects.toThrow("未连接");
  });

  it("disconnect 回到 idle，且读 State 失败", async () => {
    const transport = await connected();
    await transport.disconnect();
    expect(transport.linkState).toBe("idle");
    await expect(transport.readState()).rejects.toThrow();
  });
});

describe("演示数据播种（mock-mode）", () => {
  it("没有任何记录时，模拟器默认开启演示模式", () => {
    const storage = createSessionStorage();
    expect(mockModeEnabled(storage, { platform: "devtools" })).toBe(true);
    expect(hasRealDevices(storage)).toBe(false);
  });

  /*
   * 回归：真机默认**必须**关。若真机也自动开启，MockTransport 不会去扫
   * 真实蓝牙 → 永远没有真机记录 → 自动开启条件永远成立 → 死循环，
   * 表现就是「手机上预览搜不到设备」（扫的是假设备）。
   */
  it("没有任何记录时，真机默认关闭演示模式（否则会死循环）", () => {
    for (const platform of ["android", "ios", "windows", "mac", ""]) {
      const storage = createSessionStorage();
      expect(mockModeEnabled(storage, { platform })).toBe(false);
    }
  });

  it("有真机记录时任何环境都关闭", () => {
    for (const platform of ["devtools", "android", "ios"]) {
      const storage = createSessionStorage({
        [RECENT_DEVICES_KEY]: JSON.stringify([
          { deviceId: "REAL:01", lastConnectedAt: 1000 },
        ]),
      });
      expect(mockModeEnabled(storage, { platform })).toBe(false);
      expect(hasRealDevices(storage)).toBe(true);
    }
  });

  it("真机上用户仍可显式打开演示模式", () => {
    const storage = createSessionStorage();
    setMockMode(storage, true);
    expect(mockModeEnabled(storage, { platform: "android" })).toBe(true);
  });

  it("用户显式开关优先于自动判断", () => {
    const storage = createSessionStorage({
      [RECENT_DEVICES_KEY]: JSON.stringify([
        { deviceId: "REAL:01", lastConnectedAt: 1000 },
      ]),
    });
    setMockMode(storage, true);
    expect(mockModeEnabled(storage)).toBe(true);
    expect(storage.get(MOCK_PREF_KEY)).toBe("1");
    setMockMode(storage, false);
    expect(mockModeEnabled(storage)).toBe(false);
  });

  it("播种写进真实的 recent / registry 存储键", () => {
    const storage = createSessionStorage();
    seedMockDevices(storage, 1_000_000);
    const recent = loadRecentDevices(storage);
    expect(recent).toHaveLength(MOCK_DEVICES.length);
    expect(recent[0].deviceId).toBe(MOCK_DEVICES[0].deviceId);
    expect(recent[0].hardwareId).toBe(MOCK_DEVICES[0].hwId);
    const registry = loadRegistry(storage);
    expect(registry.devices).toHaveLength(MOCK_DEVICES.length);
    expect(registry.devices[0].remark).toBe(MOCK_DEVICES[0].remark);
  });

  it("重复播种不会重复插入、也不改时间戳", () => {
    const storage = createSessionStorage();
    seedMockDevices(storage, 1_000_000);
    const before = loadRecentDevices(storage).map((entry) => entry.lastConnectedAt);
    seedMockDevices(storage, 9_999_999);
    const after = loadRecentDevices(storage);
    expect(after).toHaveLength(MOCK_DEVICES.length);
    expect(after.map((entry) => entry.lastConnectedAt)).toEqual(before);
  });

  it("清除演示设备时真机记录一条不动", () => {
    const storage = createSessionStorage();
    seedMockDevices(storage, 1_000_000);
    const real = { deviceId: "REAL:01", hardwareId: "11:22:33:44:55:66", lastConnectedAt: 5 };
    storage.set(
      RECENT_DEVICES_KEY,
      JSON.stringify([...loadRecentDevices(storage), real]),
    );
    clearMockDevices(storage);
    const recent = loadRecentDevices(storage);
    expect(recent).toHaveLength(1);
    expect(recent[0].deviceId).toBe("REAL:01");
    expect(loadRegistry(storage).devices.some((entry) => isMockDeviceId(entry.deviceId))).toBe(
      false,
    );
  });

  it("演示设备 id 清单与 spec 一致", () => {
    for (const spec of MOCK_DEVICES) {
      expect(isMockDeviceId(spec.deviceId)).toBe(true);
    }
    expect(isMockDeviceId("REAL:01")).toBe(false);
    expect(storageKeys()).toContain(RECENT_DEVICES_KEY);
    expect(storageKeys()).toContain(DEVICE_REGISTRY_KEY);
  });
});

function storageKeys(): string[] {
  return [RECENT_DEVICES_KEY, DEVICE_REGISTRY_KEY];
}

describe("reconcileMockMode：开关与存储收敛", () => {
  it("自动开启时播种演示设备", async () => {
    const { reconcileMockMode } = await import("../utils/control/mock-mode");
    const storage = createSessionStorage();
    expect(reconcileMockMode(storage, 1000, { platform: "devtools" })).toBe(true);
    expect(loadRecentDevices(storage)).toHaveLength(MOCK_DEVICES.length);
  });

  it("真机首次启动：不播种演示设备，直接走真实蓝牙", async () => {
    const { reconcileMockMode } = await import("../utils/control/mock-mode");
    const storage = createSessionStorage();
    expect(reconcileMockMode(storage, 1000, { platform: "android" })).toBe(false);
    expect(loadRecentDevices(storage)).toHaveLength(0);
  });

  it("有真机记录且用户没显式关过：清掉残留的演示设备", async () => {
    const { reconcileMockMode } = await import("../utils/control/mock-mode");
    const storage = createSessionStorage();
    seedMockDevices(storage, 1000);
    /* 用户后来连上了真机（真机记录 + 演示设备共存）。 */
    storage.set(
      RECENT_DEVICES_KEY,
      JSON.stringify([
        ...loadRecentDevices(storage),
        { deviceId: "REAL:01", lastConnectedAt: 9999 },
      ]),
    );
    expect(reconcileMockMode(storage, 2000)).toBe(false);
    const recent = loadRecentDevices(storage);
    expect(recent).toHaveLength(1);
    expect(recent[0].deviceId).toBe("REAL:01");
  });

  it("用户显式关闭时也清掉演示设备", async () => {
    const { reconcileMockMode } = await import("../utils/control/mock-mode");
    const storage = createSessionStorage();
    seedMockDevices(storage, 1000);
    setMockMode(storage, false);
    expect(reconcileMockMode(storage, 2000)).toBe(false);
    expect(loadRecentDevices(storage)).toHaveLength(0);
  });

  it("用户显式打开时即使有真机记录也播种", async () => {
    const { reconcileMockMode } = await import("../utils/control/mock-mode");
    const storage = createSessionStorage({
      [RECENT_DEVICES_KEY]: JSON.stringify([{ deviceId: "REAL:01", lastConnectedAt: 1 }]),
    });
    setMockMode(storage, true);
    expect(reconcileMockMode(storage, 1000)).toBe(true);
    expect(loadRecentDevices(storage)).toHaveLength(MOCK_DEVICES.length + 1);
  });
});
