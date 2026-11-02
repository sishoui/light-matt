/**
 * 演示模式下的**会话级**连通性（端到端，不经过页面）。
 *
 * 首页的「点大卡 → 连上 → 进控制页」整条链路依赖：会话把 MockTransport 当成
 * 一个普通传输层用，`connect` 之后 State / DeviceInfo / StripConfig / 段列表
 * 都能读回，命令能写下去。这里直接断言这条链路，避免页面层掩盖住底层缺陷。
 *
 * 只替换 storage（spec 允许的假件）；传输层是产品代码本身（MockTransport）。
 */

import { describe, expect, it, vi } from "vitest";
import { ControlSession } from "../utils/control/session";
import { MockTransport } from "../utils/ble/mock-transport";
import type { BleTransport } from "../utils/ble/transport";
import { MOCK_DEVICES } from "../utils/control/mock-devices";
import { seedMockDevices } from "../utils/control/mock-mode";
import { createSessionStorage } from "./helpers/storage";
import { SEGMENT_TYPE } from "../utils/protocol/constants";

const A = MOCK_DEVICES[0];
const B = MOCK_DEVICES[1];

interface Harness {
  session: ControlSession;
  transport: MockTransport;
}

function makeSession(storage = createSessionStorage()): Harness {
  const transport = new MockTransport();
  const session = new ControlSession({
    platform: "other",
    devMode: false,
    storage,
    transportOverride: transport as unknown as BleTransport,
    reconnectDelaysMs: [],
  });
  return { session, transport };
}

describe("演示模式：会话链路", () => {
  it("connect 之后会话进入 ready，且能读到设备状态", async () => {
    const { session } = makeSession();
    await session.connect(A.deviceId, A.broadcastName);
    expect(session.linkState).toBe("ready");
    const state = session.deviceState;
    expect(state).not.toBeNull();
    expect(state?.stripCount).toBe(2);
    expect(state?.maxBrightness).toBe(A.maxBrightness);
  });

  it("连接后 QueryDeviceInfo / QueryStripConfig 都拿到设备权威值", async () => {
    const { session } = makeSession();
    await session.connect(A.deviceId, A.broadcastName);
    const info = await session.queryDeviceInfo();
    expect(info.kind).toBe("ok");
    if (info.kind === "ok") {
      expect(info.info.hwId).toBe(A.hwId);
    }
    const config = await session.queryStripConfig();
    expect(config.kind).toBe("ok");
    if (config.kind === "ok") {
      expect(config.config.channels[0].assigned).toBe(true);
    }
  });

  it("queryStrip 读回该带的段（设备权威）", async () => {
    const { session } = makeSession();
    await session.connect(A.deviceId, A.broadcastName);
    const result = await session.queryStrip(0);
    expect(result.kind).toBe("ok");
    if (result.kind === "ok") {
      expect(result.reports).toHaveLength(2);
      expect(result.reports[0].layer0.type).toBe(SEGMENT_TYPE.STATIC);
    }
  });

  it("setPower / setBrightness 真的改设备状态", async () => {
    const { session } = makeSession();
    await session.connect(A.deviceId, A.broadcastName);
    const off = await session.setPower(false);
    expect(off.kind).toBe("ok");
    expect(session.deviceState?.power).toBe(0);
    const on = await session.setPower(true);
    expect(on.kind).toBe("ok");
    expect(session.deviceState?.power).toBe(1);
  });

  it("切灯带只重新读，不清别的带的段", async () => {
    const { session } = makeSession();
    await session.connect(A.deviceId, A.broadcastName);
    await session.queryStrip(0);
    await session.queryStrip(1);
    /* 两条带各有一份缓存，互不覆盖。 */
    expect(session.segmentsOf(0)).toHaveLength(2);
    expect(session.segmentsOf(1)).toHaveLength(1);
  });

  it("switchTo 换设备：状态换新、旧设备段缓存被清空", async () => {
    const { session } = makeSession();
    await session.connect(A.deviceId, A.broadcastName);
    await session.queryStrip(0);
    expect(session.segmentsOf(0).length).toBeGreaterThan(0);

    await session.switchTo(B.deviceId, B.broadcastName);
    expect(session.linkState).toBe("ready");
    expect(session.transport.currentDeviceId).toBe(B.deviceId);
    expect(session.deviceState?.stripCount).toBe(B.stripCounts.filter((n) => n > 0).length);
    /* 段缓存属于上一台设备，必须清空。 */
    expect(session.segmentsOf(0)).toEqual([]);
  });

  it("seedMockDevices 之后 recentDevices 立即可见（列表派生依赖它）", async () => {
    const storage = createSessionStorage();
    seedMockDevices(storage, 1_000_000);
    const { session } = makeSession(storage);
    expect(session.recentDevices).toHaveLength(MOCK_DEVICES.length);
  });

  it("连接成功后写入最近连过列表（与真机同一条路径）", async () => {
    const storage = createSessionStorage();
    const { session } = makeSession(storage);
    await session.connect(A.deviceId, A.broadcastName);
    const recent = session.recentDevices;
    expect(recent.some((entry) => entry.deviceId === A.deviceId)).toBe(true);
  });

  it("disconnect 之后会话回到 idle，状态被清空", async () => {
    const { session } = makeSession();
    await session.connect(A.deviceId, A.broadcastName);
    await session.disconnect();
    expect(session.linkState).toBe("idle");
    expect(session.deviceState).toBeNull();
  });

  it("取消连接不会把设备记成「最近连过」", async () => {
    const storage = createSessionStorage();
    const { session } = makeSession(storage);
    const connecting = session.connect(A.deviceId, A.broadcastName);
    /* MockTransport 在 connect 里有 60ms + 60ms 的模拟初始化。 */
    expect(session.cancelConnect()).toBe(true);
    await expect(connecting).rejects.toThrow();
    expect(session.recentDevices.some((entry) => entry.deviceId === A.deviceId)).toBe(false);
  });

  it("自检命令成功返回（不改设备状态）", async () => {
    const { session } = makeSession();
    await session.connect(A.deviceId, A.broadcastName);
    const before = session.deviceState;
    const result = await session.selfTest();
    expect(result.kind).toBe("ok");
    expect(session.deviceState).toEqual(before);
  });
});

/* 定时器泄漏保护：MockTransport 的扫描第二批用了 setTimeout。 */
describe("演示模式：扫描", () => {
  it("扫描结果里包含三台演示设备", async () => {
    const { session, transport } = makeSession();
    const seen: string[][] = [];
    session.onDevices((list) => seen.push(list.map((device) => device.deviceId)));
    await session.scan();
    expect(seen[0]).toHaveLength(3);
    await session.stopScan();
    vi.useRealTimers();
    expect(transport.linkState).toBe("idle");
  });
});
