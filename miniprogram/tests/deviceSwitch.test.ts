/**
 * #33 多设备切换的测试。
 *
 * 覆盖三块：
 *  1. device-switch 状态机（纯逻辑）—— 正常路径、失败路径、重试、不回滚；
 *  2. device-history「最近连过」列表 —— 排序、去重、上限、损坏数据、设备失效移除；
 *  3. session.switchTo 的接线 —— 先断后连、失败停在未连接、不进自动回连退避、
 *     切换后设备级状态全部刷新。
 *
 * 只替换计时器、传输通道与 storage（spec 允许的假件），不 mock 协议字节、不碰 wx.BLE。
 */

import { describe, expect, it, vi } from "vitest";

import {
  abandonSwitch,
  beginSwitch,
  initialSwitchState,
  isSwitching,
  retrySwitch,
  switchedDisconnected,
  switchedReady,
  switchFailed,
} from "../utils/control/device-switch";
import {
  MAX_RECENT_DEVICES,
  RECENT_DEVICES_KEY,
  forgetDevice,
  loadRecentDevices,
  recordConnection,
} from "../utils/control/device-history";
import { ControlSession, type SessionStorage } from "../utils/control/session";
import { WxCallError } from "../utils/ble/wx-promise";
import type { BleTransport } from "../utils/ble/transport";
import type { CommandRequest, DeviceState, LinkState } from "../utils/protocol/types";

function baseState(overrides: Partial<DeviceState> = {}): DeviceState {
  return {
    power: 1,
    brightness: 128,
    r: 255,
    g: 180,
    b: 120,
    ledCount: 30,
    maxBrightness: 255,
    ...overrides,
  };
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

function fakeClock() {
  let now = 1000;
  let nextHandle = 1;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const timerApi = {
    setTimeout: (fn: () => void, ms: number) => {
      const handle = nextHandle++;
      timers.set(handle, { at: now + ms, fn });
      return handle as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimeout: (handle: ReturnType<typeof setTimeout>) => {
      timers.delete(handle as unknown as number);
    },
  };
  return {
    timerApi,
    setNow: (value: number) => {
      now = value;
    },
    now: () => now,
    get pendingTimers() {
      return timers.size;
    },
  };
}

/**
 * 假传输：模拟「先断开再连接」的完整流水线。
 * 主动 disconnect 后链路回 idle；connect 成功回 ready。
 */
class FakeTransport {
  linkState: LinkState = "idle";
  currentDeviceId: string | null = null;
  connectCalls: Array<{ deviceId: string; name?: string }> = [];
  disconnectCalls = 0;
  readStateCalls = 0;
  connectResult: DeviceState | Error = baseState();

  private linkListeners: Array<(s: LinkState, d?: unknown) => void> = [];
  private stateListeners: Array<(s: DeviceState) => void> = [];

  onLink(fn: (s: LinkState, d?: unknown) => void): () => void {
    this.linkListeners.push(fn);
    return () => {
      const i = this.linkListeners.indexOf(fn);
      if (i >= 0) this.linkListeners.splice(i, 1);
    };
  }

  onState(fn: (s: DeviceState) => void): () => void {
    this.stateListeners.push(fn);
    return () => {
      const i = this.stateListeners.indexOf(fn);
      if (i >= 0) this.stateListeners.splice(i, 1);
    };
  }

  emitLink(state: LinkState, detail?: unknown): void {
    this.linkState = state;
    for (const fn of this.linkListeners.slice()) fn(state, detail);
  }

  async connect(deviceId: string, name?: string): Promise<DeviceState> {
    this.connectCalls.push({ deviceId, ...(name !== undefined ? { name } : {}) });
    this.emitLink("connecting", { deviceName: name });
    this.emitLink("initializing", { deviceName: name });
    const result = this.connectResult;
    if (result instanceof Error) {
      this.emitLink("failed", { message: result.message });
      throw result;
    }
    this.currentDeviceId = deviceId;
    this.readStateCalls += 1;
    this.emitLink("ready", { deviceName: name });
    return result;
  }

  readState(): Promise<DeviceState> {
    this.readStateCalls += 1;
    const value = this.connectResult;
    return value instanceof Error ? Promise.reject(value) : Promise.resolve(value);
  }

  async write(_req: CommandRequest): Promise<{ seq: number }> {
    return { seq: 1 };
  }

  sendAndWaitAck(req: CommandRequest): Promise<never> {
    return Promise.resolve({
      seq: 1,
      command: req.command,
      resultCode: 0,
      ok: true,
    }) as never;
  }

  async startScan(): Promise<void> {
    this.linkState = "scanning";
  }

  async stopScan(): Promise<void> {
    this.linkState = "idle";
  }

  async openAdapter(): Promise<void> {
    /* no-op */
  }

  async disconnect(): Promise<void> {
    this.disconnectCalls += 1;
    this.currentDeviceId = null;
    this.linkState = "idle";
    this.emitLink("idle");
  }

  destroy(): void {
    this.linkListeners.length = 0;
    this.stateListeners.length = 0;
  }
}

function makeSession(storage: SessionStorage = memoryStorage()) {
  const clock = fakeClock();
  const transport = new FakeTransport();
  vi.spyOn(Date, "now").mockImplementation(() => clock.now());
  const session = new ControlSession({
    platform: "other",
    devMode: false,
    transportOverride: transport as unknown as BleTransport,
    throttleTimer: clock.timerApi,
    reconnectTimer: clock.timerApi,
    storage,
  });
  return { session, transport, clock, storage };
}

// ------------------------------------------------------------------
// 1. 状态机
// ------------------------------------------------------------------

describe("#33 切换状态机：正常路径", () => {
  it("已连接时切换：先 disconnecting，再 connecting，最后 ready", () => {
    let s = initialSwitchState();
    s = beginSwitch(s, "DEV-B", "Lumen-B", "ready");
    expect(s.phase).toBe("disconnecting");
    expect(s.target).toEqual({ deviceId: "DEV-B", name: "Lumen-B" });

    s = switchedDisconnected(s);
    expect(s.phase).toBe("connecting");

    s = switchedReady(s);
    expect(s.phase).toBe("ready");
    expect(s.target).toBeNull();
    expect(s.error).toBeNull();
  });

  it("未连接时切换：直接进入 connecting，不需要先断开", () => {
    const s = beginSwitch(initialSwitchState(), "DEV-B", undefined, "idle");
    expect(s.phase).toBe("connecting");
    expect(s.target).toEqual({ deviceId: "DEV-B" });
  });

  it("切换中重复点同一台不重启流程（避免抖动）", () => {
    const first = beginSwitch(initialSwitchState(), "DEV-B", undefined, "ready");
    const again = beginSwitch(first, "DEV-B", undefined, "ready");
    expect(again).toBe(first);
  });

  it("isSwitching 只对中间两个阶段为真", () => {
    expect(isSwitching({ phase: "disconnecting", target: null, error: null })).toBe(true);
    expect(isSwitching({ phase: "connecting", target: null, error: null })).toBe(true);
    expect(isSwitching({ phase: "idle", target: null, error: null })).toBe(false);
    expect(isSwitching({ phase: "ready", target: null, error: null })).toBe(false);
    expect(isSwitching({ phase: "failed", target: null, error: null })).toBe(false);
  });
});

describe("#33 切换状态机：失败路径", () => {
  it("连接失败 → failed，保留目标，带原因", () => {
    let s = beginSwitch(initialSwitchState(), "DEV-B", "Lumen-B", "ready");
    s = switchedDisconnected(s);
    s = switchFailed(s, "设备不在附近");

    expect(s.phase).toBe("failed");
    // 目标必须保留：重试入口要用它。
    expect(s.target).toEqual({ deviceId: "DEV-B", name: "Lumen-B" });
    expect(s.error).toBe("设备不在附近");
  });

  it("失败后不自动回到上一台：状态里没有任何回滚目标", () => {
    let s = beginSwitch(initialSwitchState(), "DEV-B", undefined, "ready");
    s = switchedDisconnected(s);
    s = switchFailed(s, "超时");
    // 唯一的 target 是失败的那台，不是「上一台」。
    expect(s.target?.deviceId).toBe("DEV-B");
    expect(s.phase).not.toBe("ready");
  });

  it("只有切换中才接受失败事件：ready/idle 不受影响", () => {
    const ready = initialSwitchState();
    expect(switchFailed(ready, "x")).toBe(ready);
  });

  it("重试从 failed 出发，沿用原目标", () => {
    let s = beginSwitch(initialSwitchState(), "DEV-B", "Lumen-B", "ready");
    s = switchedDisconnected(s);
    s = switchFailed(s, "超时");

    const retried = retrySwitch(s, "idle");
    expect(retried.phase).toBe("connecting");
    expect(retried.target).toEqual({ deviceId: "DEV-B", name: "Lumen-B" });
    expect(retried.error).toBeNull();
  });

  it("没有失败目标时 retry 是空操作", () => {
    const idle = initialSwitchState();
    expect(retrySwitch(idle, "idle")).toBe(idle);
  });

  it("放弃切换回到 idle 且不留目标", () => {
    const s = abandonSwitch();
    expect(s.phase).toBe("idle");
    expect(s.target).toBeNull();
  });
});

// ------------------------------------------------------------------
// 2. 最近连过列表
// ------------------------------------------------------------------

describe("#33 最近连过列表", () => {
  it("按最后连接时间降序", () => {
    const storage = memoryStorage();
    recordConnection(storage, "A", "Lumen-A", 1000);
    recordConnection(storage, "B", "Lumen-B", 2000);
    recordConnection(storage, "C", "Lumen-C", 1500);

    expect(loadRecentDevices(storage).map((d) => d.deviceId)).toEqual(["B", "C", "A"]);
  });

  it("同一台重复连接只保留一条，时间与名字更新", () => {
    const storage = memoryStorage();
    recordConnection(storage, "A", "Lumen-A", 1000);
    recordConnection(storage, "A", "Lumen-A-renamed", 3000);

    const list = loadRecentDevices(storage);
    expect(list).toHaveLength(1);
    expect(list[0].name).toBe("Lumen-A-renamed");
    expect(list[0].lastConnectedAt).toBe(3000);
  });

  it("超过上限时裁剪最旧的", () => {
    const storage = memoryStorage();
    for (let i = 0; i < MAX_RECENT_DEVICES + 3; i += 1) {
      recordConnection(storage, `DEV-${i}`, `Lumen-${i}`, 1000 + i);
    }
    const list = loadRecentDevices(storage);
    expect(list).toHaveLength(MAX_RECENT_DEVICES);
    // 保留了最新的那些，最旧的 DEV-0..2 被裁掉。
    expect(list.map((d) => d.deviceId)).not.toContain("DEV-0");
    expect(list[0].deviceId).toBe(`DEV-${MAX_RECENT_DEVICES + 2}`);
  });

  it("损坏的存储不抛错，按空列表处理", () => {
    expect(loadRecentDevices(memoryStorage({ [RECENT_DEVICES_KEY]: "{{{not json" }))).toEqual([]);
    expect(loadRecentDevices(memoryStorage({ [RECENT_DEVICES_KEY]: '{"a":1}' }))).toEqual([]);
  });

  it("逐条丢弃非法条目，保留合法条目", () => {
    const raw = JSON.stringify([
      { deviceId: "GOOD", lastConnectedAt: 2000 },
      { deviceId: "", lastConnectedAt: 1000 },
      { deviceId: "NO-TIME" },
      { lastConnectedAt: 1500 },
    ]);
    const list = loadRecentDevices(memoryStorage({ [RECENT_DEVICES_KEY]: raw }));
    expect(list.map((d) => d.deviceId)).toEqual(["GOOD"]);
  });

  it("设备失效时只移除那一台，其它记录保留", () => {
    const storage = memoryStorage();
    recordConnection(storage, "A", "Lumen-A", 1000);
    recordConnection(storage, "B", "Lumen-B", 2000);

    const after = forgetDevice(storage, "A");
    expect(after.map((d) => d.deviceId)).toEqual(["B"]);
    expect(loadRecentDevices(storage).map((d) => d.deviceId)).toEqual(["B"]);
  });
});

// ------------------------------------------------------------------
// 3. session.switchTo 接线
// ------------------------------------------------------------------

describe("#33 session.switchTo 接线", () => {
  it("先断开当前设备，再连新的；成功后阶段为 ready", async () => {
    const h = makeSession();
    h.transport.connectResult = baseState();
    await h.session.connect("DEV-A", "Lumen-A");

    h.transport.connectCalls = [];
    h.transport.disconnectCalls = 0;
    h.transport.connectResult = baseState({ brightness: 42 });

    const state = await h.session.switchTo("DEV-B", "Lumen-B");

    expect(h.transport.disconnectCalls).toBe(1);
    expect(h.transport.connectCalls).toEqual([{ deviceId: "DEV-B", name: "Lumen-B" }]);
    expect(state.brightness).toBe(42);
    expect(h.session.deviceSwitch.phase).toBe("ready");
    expect(h.session.linkState).toBe("ready");
    expect(h.session.deviceState?.brightness).toBe(42);
  });

  it("切换后加载的是新设备的状态，不是上一台的残留", async () => {
    const h = makeSession();
    h.transport.connectResult = baseState({ brightness: 10, r: 1, g: 2, b: 3 });
    await h.session.connect("DEV-A", "Lumen-A");

    h.transport.connectResult = baseState({ brightness: 200, r: 9, g: 8, b: 7 });
    await h.session.switchTo("DEV-B", "Lumen-B");

    const state = h.session.deviceState;
    expect(state).not.toBeNull();
    expect(state?.brightness).toBe(200);
    expect(state?.r).toBe(9);
  });

  it("连接失败 → 停在 failed，链路是未连接，目标保留供重试", async () => {
    const h = makeSession();
    h.transport.connectResult = baseState();
    await h.session.connect("DEV-A", "Lumen-A");

    h.transport.connectResult = new Error("设备不在附近");
    await expect(h.session.switchTo("DEV-B", "Lumen-B")).rejects.toThrow("设备不在附近");

    const s = h.session.deviceSwitch;
    expect(s.phase).toBe("failed");
    expect(s.target?.deviceId).toBe("DEV-B");
    expect(s.error).toBe("设备不在附近");
    // 停在未连接：旧设备的状态不能留着。
    expect(h.session.linkState).not.toBe("ready");
    expect(h.session.deviceState).toBeNull();
  });

  it("切换失败不触发自动回连退避（不走 1s/2s/4s）", async () => {
    const h = makeSession();
    h.transport.connectResult = baseState();
    await h.session.connect("DEV-A", "Lumen-A");

    h.transport.connectResult = new Error("超时");
    await expect(h.session.switchTo("DEV-B", "Lumen-B")).rejects.toThrow("超时");

    // 失败后不应留下待执行的回连意图或退避计时器。
    expect(h.session.reconnectPending).toBe(false);
    expect(h.clock.pendingTimers).toBe(0);

    // 再让时间流逝也不会自己拨号。
    await new Promise((resolve) => setImmediate(resolve));
    expect(h.transport.connectCalls.filter((c) => c.deviceId === "DEV-B")).toHaveLength(1);
  });

  it("重试成功后阶段回到 ready", async () => {
    const h = makeSession();
    h.transport.connectResult = baseState();
    await h.session.connect("DEV-A", "Lumen-A");

    h.transport.connectResult = new Error("超时");
    await expect(h.session.switchTo("DEV-B", "Lumen-B")).rejects.toThrow();

    h.transport.connectResult = baseState({ brightness: 77 });
    const state = await h.session.retrySwitch();

    expect(state.brightness).toBe(77);
    expect(h.session.deviceSwitch.phase).toBe("ready");
  });

  it("切换中的第二次调用被拒绝，不会并发两条连接", async () => {
    const h = makeSession();
    h.transport.connectResult = baseState();
    await h.session.connect("DEV-A", "Lumen-A");

    // 让第一次切换悬停在 connecting。
    let release: (() => void) | null = null;
    const originalConnect = h.transport.connect.bind(h.transport);
    h.transport.connect = ((deviceId: string, name?: string) => {
      return new Promise<DeviceState>((resolve, reject) => {
        release = () => {
          originalConnect(deviceId, name).then(resolve, reject);
        };
      });
    }) as typeof h.transport.connect;

    const first = h.session.switchTo("DEV-B", "Lumen-B");
    await expect(h.session.switchTo("DEV-C", "Lumen-C")).rejects.toThrow("正在切换设备");

    release!();
    await first;
    expect(h.session.deviceSwitch.phase).toBe("ready");
  });

  it("单设备场景：未连接时连同一台仍是两步内完成（不退化）", async () => {
    const h = makeSession();
    h.transport.connectResult = baseState();
    // 未连接 + 直接 connect（旧快捷路径）：不应触发任何断开。
    await h.session.connect("DEV-A", "Lumen-A");
    expect(h.transport.disconnectCalls).toBe(0);
    expect(h.session.linkState).toBe("ready");
  });

  it("连接成功会记进「最近连过」，失败不记", async () => {
    const h = makeSession();
    h.transport.connectResult = baseState();
    await h.session.connect("DEV-A", "Lumen-A");
    expect(h.session.recentDevices.map((d) => d.deviceId)).toContain("DEV-A");

    h.transport.connectResult = new Error("失败");
    await expect(h.session.connect("DEV-X", "Lumen-X")).rejects.toThrow();
    expect(h.session.recentDevices.map((d) => d.deviceId)).not.toContain("DEV-X");
  });

  it("10002（设备不在附近）会把失效设备从最近列表移除", async () => {
    const h = makeSession();
    h.transport.connectResult = baseState();
    await h.session.connect("DEV-A", "Lumen-A");

    h.transport.connectResult = new WxCallError("test", { errCode: 10002, errMsg: "not found" });
    await expect(h.session.connect("DEV-A", "Lumen-A")).rejects.toThrow();
    expect(h.session.recentDevices.map((d) => d.deviceId)).not.toContain("DEV-A");
  });
});
