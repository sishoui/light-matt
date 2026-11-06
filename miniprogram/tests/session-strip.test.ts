/**
 * #41 会话层：灯带维度必须是**显式参数**，activeStripId 只是会话自己记住的
 * 当前选择（App 级单例里跨 tab 保存）。
 *
 * v5 里对应的两条是 `setStripPower` / `queryLayout`：页面必须传它正在展示的
 * 那条带，否则用户在第 3 条带上操作会落到第 0 条。
 */

import { describe, expect, it } from "vitest";

import { ControlSession, type SessionStorage } from "../utils/control/session";
import type { BleTransport } from "../utils/ble/transport";
import { loadRegistry } from "../utils/control/device-registry";
import { loadRecentDevices } from "../utils/control/device-history";
import type {
  AckResult,
  CommandRequest,
  DeviceInfo,
  DeviceState,
  LayoutListEnd,
  LayoutReport,
  LinkState,
  SceneListEnd,
  ScenePartReport,
  SceneStepReport,
  StripConfig,
} from "../utils/protocol/types";
import { baseState } from "./helpers/state";

/** 一个部位的测试夹具（v5 的布局读回形状）。 */
const LAYOUT_PART: LayoutReport = {
  stripId: 1,
  partId: 0,
  nameLen: 0,
  name: "",
  segCount: 1,
  segs: [[0, 9]],
};

class FakeTransport {
  linkState: LinkState = "ready";
  currentDeviceId: string | null = "DEV-A";
  writes: CommandRequest[] = [];
  layoutQueries: number[] = [];
  layoutReports: LayoutReport[] = [LAYOUT_PART];
  sceneReads = 0;
  stripConfigReads = 0;
  deviceInfoReads = 0;
  failConfig = false;

  private readonly linkListeners: Array<(state: LinkState, detail?: unknown) => void> = [];
  private readonly stateListeners: Array<(state: DeviceState) => void> = [];

  onLink(fn: (state: LinkState, detail?: unknown) => void): () => void {
    this.linkListeners.push(fn);
    return () => undefined;
  }

  onState(fn: (state: DeviceState) => void): () => void {
    this.stateListeners.push(fn);
    return () => undefined;
  }

  emitLink(state: LinkState): void {
    this.linkState = state;
    for (const fn of this.linkListeners.slice()) fn(state);
  }

  emitState(state: DeviceState): void {
    for (const fn of this.stateListeners.slice()) fn(state);
  }

  sendAndWaitAck(req: CommandRequest): Promise<AckResult> {
    this.writes.push(req);
    return Promise.resolve({ seq: 1, command: req.command, resultCode: 0, ok: true });
  }

  readState(): Promise<DeviceState> {
    return Promise.resolve(baseState());
  }

  /** 连接成功但**不广播** ready：由用例决定何时发（#44 的身份补写时机）。 */
  async connect(deviceId: string): Promise<DeviceState> {
    this.currentDeviceId = deviceId;
    this.linkState = "ready";
    return baseState();
  }

  async queryLayout(stripId: number): Promise<{
    reports: LayoutReport[];
    end: LayoutListEnd;
  }> {
    this.layoutQueries.push(stripId);
    return {
      reports: this.layoutReports,
      end: { stripId, partMask: 0b1 },
    };
  }

  async queryScene(sceneId: number): Promise<{
    sceneId: number;
    parts: ScenePartReport[];
    steps: SceneStepReport[];
    end: SceneListEnd;
  }> {
    this.sceneReads += 1;
    return { sceneId, parts: [], steps: [], end: { sceneId, nameLen: 0, name: "" } };
  }

  /* 回连重建（§9.1 步骤 2/3）用的两条只读查询。 */
  async queryStripConfig(): Promise<StripConfig> {
    this.stripConfigReads += 1;
    if (this.failConfig) {
      throw new Error("引脚表读取失败");
    }
    return {
      channels: Array.from({ length: 8 }, (_, id) => ({
        stripId: id,
        gpio: 0xff,
        flags: 0,
        assigned: false,
      })),
    };
  }

  async queryDeviceInfo(): Promise<DeviceInfo> {
    this.deviceInfoReads += 1;
    if (this.failConfig) {
      throw new Error("设备信息读取失败");
    }
    return {
      firmwareVersion: 0x0300,
      firmwareMajor: 3,
      firmwareMinor: 0,
      hwId: "AA:BB:CC:DD:EE:FF",
      maxLeds: 64,
      maxStrips: 8,
      maxSegments: 8,
      maxStages: 8,
      maxScripts: 4,
      caps: 0,
      supportsTwoLayers: false,
      fadeImplemented: false,
    };
  }

  async disconnect(): Promise<void> {
    this.linkState = "idle";
  }
}

function makeSession(transport: FakeTransport): ControlSession {
  return new ControlSession({
    platform: "other",
    devMode: false,
    transportOverride: transport as unknown as BleTransport,
  });
}

function memoryStorage(seed: Record<string, string> = {}): SessionStorage {
  const map = new Map(Object.entries(seed));
  return {
    get: (key) => map.get(key) ?? null,
    set: (key, value) => {
      map.set(key, value);
    },
    remove: (key) => {
      map.delete(key);
    },
  };
}

async function settle(rounds = 12): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await Promise.resolve();
  }
}

describe("#41 stripId 是必填参数", () => {
  it("setStripPower(stripId, on) 用调用方给的带，不跟随 activeStripId", async () => {
    const transport = new FakeTransport();
    const session = makeSession(transport);
    session.setActiveStripId(0);

    const result = await session.setStripPower(3, false);
    expect(result.kind).toBe("ok");
    expect(Array.from(transport.writes[0].payload)).toEqual([3, 0]);
    /* 只是发命令：不该偷偷改会话的当前选择。 */
    expect(session.activeStripId).toBe(0);
  });

  it("queryLayout(stripId) 读调用方给的带，并缓存该带的部位", async () => {
    const transport = new FakeTransport();
    const session = makeSession(transport);

    const result = await session.queryLayout(1);
    expect(result.kind).toBe("ok");
    expect(transport.layoutQueries).toEqual([1]);
    expect(session.layoutOf(1)?.parts).toEqual(transport.layoutReports);
    /* 没读过的带不能编出数据。 */
    expect(session.layoutOf(0)).toBeNull();
    expect(session.layoutOf(2)).toBeNull();
  });

  it("断线清空逐带布局缓存（描述的是上一台 / 上一次连接）", async () => {
    const transport = new FakeTransport();
    const session = makeSession(transport);
    await session.queryLayout(0);
    expect(session.layoutOf(0)?.parts.length).toBeGreaterThan(0);

    transport.emitLink("idle");
    await session.disconnect();
    expect(session.layoutOf(0)).toBeNull();
  });

  it("activeStripId 是会话自有状态：断线重连不重置（用户的选择跨连接保留）", async () => {
    const transport = new FakeTransport();
    const session = makeSession(transport);
    session.setActiveStripId(2);

    transport.emitLink("idle");
    transport.emitLink("ready");

    expect(session.activeStripId).toBe(2);
  });

  it("setActiveStripId 越界抛 RangeError（不静默夹住）", () => {
    const session = makeSession(new FakeTransport());
    expect(() => session.setActiveStripId(8)).toThrow(RangeError);
    expect(() => session.setActiveStripId(-1)).toThrow(RangeError);
  });
});

describe("#41 连接后重建（protocol-v3 §9.1）", () => {
  it("ready 时补 QueryStripConfig 与 QueryDeviceInfo（State 已由连接流水线读过）", async () => {
    const transport = new FakeTransport();
    const session = makeSession(transport);
    expect(transport.stripConfigReads).toBe(0);
    expect(transport.deviceInfoReads).toBe(0);

    transport.emitLink("ready");
    await settle();

    expect(transport.stripConfigReads).toBe(1);
    expect(transport.deviceInfoReads).toBe(1);
    expect(session.stripConfigs).not.toBeNull();
    expect(session.deviceInfo?.hwId).toBe("AA:BB:CC:DD:EE:FF");
  });

  it("两条查询失败不改变链路状态（界面增强信息，不能降级成连接失败）", async () => {
    const transport = new FakeTransport();
    const session = makeSession(transport);
    transport.failConfig = true;

    transport.emitLink("ready");
    await settle();

    expect(session.linkState).toBe("ready");
    expect(session.stripConfigs).toBeNull();
    expect(session.deviceInfo).toBeNull();
  });

  it("onDeviceConfig 在读完（成功或失败）后各触发一次，页面据此重画 GPIO", async () => {
    const transport = new FakeTransport();
    const session = makeSession(transport);
    let calls = 0;
    const off = session.onDeviceConfig(() => {
      calls += 1;
    });

    transport.emitLink("ready");
    await settle();
    expect(calls).toBe(1);

    /* 失败也要通知：页面据此把「GPIO ?」收敛成「—」。 */
    transport.failConfig = true;
    transport.emitLink("idle");
    transport.emitLink("ready");
    await settle();
    expect(calls).toBe(2);

    off();
    transport.emitLink("idle");
    transport.emitLink("ready");
    await settle();
    expect(calls).toBe(2);
  });
});

describe("#44 设备身份与切换清理", () => {
  it("ready 后读到的 hwId 同时写进登记表与最近连过（合并，不新增记录）", async () => {
    const transport = new FakeTransport();
    transport.currentDeviceId = "DEV-A";
    const storage = memoryStorage();
    const session = new ControlSession({
      platform: "other",
      devMode: false,
      transportOverride: transport as unknown as BleTransport,
      storage,
    });

    /* 连接成功先记一条（hwId 未知）。 */
    await session.connect("DEV-A", "Lumen-A");
    expect(loadRecentDevices(storage)).toHaveLength(1);
    expect(loadRecentDevices(storage)[0].hardwareId).toBeUndefined();

    transport.emitLink("ready");
    await settle();

    expect(loadRegistry(storage).devices.find((e) => e.deviceId === "DEV-A")?.hardwareId).toBe(
      "AA:BB:CC:DD:EE:FF",
    );
    const recent = loadRecentDevices(storage);
    expect(recent).toHaveLength(1);
    expect(recent[0]).toMatchObject({
      deviceId: "DEV-A",
      hardwareId: "AA:BB:CC:DD:EE:FF",
    });
  });

  it("切换设备清空逐带段缓存与设备身份（无残留）", async () => {
    const transport = new FakeTransport();
    transport.currentDeviceId = "DEV-A";
    const session = new ControlSession({
      platform: "other",
      devMode: false,
      transportOverride: transport as unknown as BleTransport,
      storage: memoryStorage(),
    });

    /* 先连 A，读一条链的布局，并让 ready 补上 hwId。 */
    await session.connect("DEV-A", "Lumen-A");
    await session.queryLayout(1);
    expect(session.layoutOf(1)?.parts.length).toBeGreaterThan(0);
    transport.emitLink("ready");
    await settle();
    expect(session.deviceInfo?.hwId).toBe("AA:BB:CC:DD:EE:FF");

    /* 切到 B：FakeTransport 的 connect 不会重置 linkState，先回 idle 模拟真实链路。 */
    transport.layoutReports = [];
    transport.currentDeviceId = "DEV-B";
    transport.emitLink("idle");
    await session.switchTo("DEV-B", "Lumen-B");

    /* 布局缓存必须空：它描述的是 A。 */
    expect(session.layoutOf(1)).toBeNull();
    expect(session.layoutOf(0)).toBeNull();
    /* 引脚表 / 身份缓存也属于上一台。 */
    expect(session.stripConfigs).toBeNull();
    expect(session.deviceInfo).toBeNull();
  });

  it("switchTo 断开阶段即使 disconnect 抛错也清空布局缓存", async () => {
    const transport = new FakeTransport();
    transport.currentDeviceId = "DEV-A";
    const session = new ControlSession({
      platform: "other",
      devMode: false,
      transportOverride: transport as unknown as BleTransport,
      storage: memoryStorage(),
    });
    await session.connect("DEV-A", "Lumen-A");
    await session.queryLayout(0);
    expect(session.layoutOf(0)?.parts.length).toBeGreaterThan(0);

    transport.disconnect = async () => {
      throw new Error("close 失败");
    };
    transport.currentDeviceId = "DEV-B";
    await session.switchTo("DEV-B", "Lumen-B");

    expect(session.layoutOf(0)).toBeNull();
  });

  it("最近连过里已有 hardId 时，连接成功就用它记（不等 0x88）", async () => {
    const transport = new FakeTransport();
    transport.currentDeviceId = "DEV-A";
    const storage = memoryStorage({
      "lumen.recentDevices.v2": JSON.stringify([
        { deviceId: "DEV-A", hardwareId: "AA:BB:CC:DD:EE:FF", lastConnectedAt: 1000 },
      ]),
    });
    const session = new ControlSession({
      platform: "other",
      devMode: false,
      transportOverride: transport as unknown as BleTransport,
      storage,
    });
    await session.connect("DEV-A", "Lumen-A");
    const recent = loadRecentDevices(storage);
    expect(recent).toHaveLength(1);
    expect(recent[0].hardwareId).toBe("AA:BB:CC:DD:EE:FF");
  });
});

describe("#44 未连接时显示的「上次」快照", () => {
  it("ready 后把 State.stripCount 与固件版本写进最近连过（只是快照，不是权威）", async () => {
    const transport = new FakeTransport();
    transport.currentDeviceId = "DEV-A";
    const storage = memoryStorage();
    const session = new ControlSession({
      platform: "other",
      devMode: false,
      transportOverride: transport as unknown as BleTransport,
      storage,
    });
    await session.connect("DEV-A", "Lumen-A");
    transport.emitState(baseState({ stripCount: 3, stripCounts: [10, 20, 30, 0, 0, 0, 0, 0] }));
    transport.emitLink("ready");
    await settle();

    const entry = loadRecentDevices(storage)[0];
    expect(entry).toMatchObject({
      deviceId: "DEV-A",
      hardwareId: "AA:BB:CC:DD:EE:FF",
      stripCount: 3,
      firmwareVer: 0x0300,
    });
  });
});
