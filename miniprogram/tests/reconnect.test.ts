/**
 * #11 状态同步与断线回连的小程序侧测试。
 *
 * 覆盖：
 *  1. 断线立即清空设备状态（UI 不保留过期状态）；
 *  2. 自动回连退避序列**精确**是 1s / 2s / 4s，最多 3 次，耗尽后停止（不无限循环）；
 *  3. 回连成功后重新走完整连接流水线（重新 notify + 读 State），以设备 State 为准；
 *  4. 前台 onShow 静默回连，但不打断扫描 / 手动连接；耗尽后不再自动重来；
 *  5. 错误分诊：10006 不重试写、10008 加间隔只重试一次、10001 非致命；
 *  6. 旧连接上飞行的 ACK 不覆盖回连后读到的新 State；
 *  7. deviceId 缓存（成功才写、失效码清缓存）；
 *  8. 状态条文案与 Event 0x81 文案（设备事件；非阻塞、不回 ACK）。
 *
 * 只替换计时器与传输通道（spec 允许的两个假件），不 mock 协议字节、不碰 wx.BLE。
 */

import { describe, expect, it, vi } from "vitest";

import { ControlSession, DEVICE_CACHE_KEY, type SessionStorage } from "../utils/control/session";
import { statusView } from "../utils/control/status-view";
import { eventText } from "../utils/ble/errors";
import { WxCallError } from "../utils/ble/wx-promise";
import type { BleTransport, LinkDetail } from "../utils/ble/transport";
import type { CommandRequest, DeviceState, LinkState } from "../utils/protocol/types";

const CMD_SET_POWER = 0x01;
/* v2 退役了 SetAll（0x04）；事件文案测试用仍然存在的命令字。 */
const CMD_SET_LED_COUNT = 0x06;

function wxErr(errCode: number): WxCallError {
  return new WxCallError("test", { errCode, errMsg: "mock" });
}

function baseState(overrides: Partial<DeviceState> = {}): DeviceState {
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

/** 可控时钟 + 计时器（与 brightness/color 测试同款）。 */
function fakeClock() {
  let now = 0;
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

  const advance = (ms: number) => {
    const target = now + ms;
    for (;;) {
      let due: { handle: number; at: number; fn: () => void } | null = null;
      for (const [handle, entry] of timers) {
        if (entry.at <= target && (due === null || entry.at < due.at)) {
          due = { handle, at: entry.at, fn: entry.fn };
        }
      }
      if (due === null) {
        break;
      }
      timers.delete(due.handle);
      now = due.at;
      due.fn();
    }
    now = target;
  };

  return {
    timerApi,
    advance,
    get now() {
      return now;
    },
    get pendingTimers() {
      return timers.size;
    },
  };
}

/** 内存版 deviceId 缓存（测试注入的存储后端，不是 BLE 假件）。 */
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

/**
 * 假传输通道：模拟 connect 的完整流水线（connecting → initializing → ready/failed）。
 *
 * 与真 transport 一致的关键点：
 *  - connect 内部会重新读一次 State 并把结果返回（回连后 notify 重新订阅的替身）；
 *  - 断线用 `emitLink("idle", { reconnectable: true })` 通知，主动断开不带该标记。
 */
class FakeTransport {
  linkState: LinkState = "ready";
  connectCalls: Array<{ deviceId: string; name?: string }> = [];
  readStateCalls = 0;
  scanCalls = 0;
  stopScanCalls = 0;
  disconnectCalls = 0;
  writes: CommandRequest[] = [];
  ackCalls: Array<{ req: CommandRequest; opts?: unknown }> = [];

  /** connect 的结果：DeviceState 成功，Error 失败。 */
  connectResult: DeviceState | Error = baseState();
  /** readState 的结果（探活用）。 */
  stateToRead: DeviceState | Error = baseState();
  /** sendAndWaitAck 的失败队列，先进先出；空则成功。 */
  ackErrors: unknown[] = [];
  /** 非空时，ACK 挂起等测试手动 resolve（模拟旧连接上的在飞命令）。 */
  pendingAck: { resolve: () => void; reject: (err: unknown) => void } | null = null;

  private readonly linkListeners: Array<(state: LinkState, detail?: LinkDetail) => void> = [];
  private readonly stateListeners: Array<(state: DeviceState) => void> = [];

  onLink(fn: (state: LinkState, detail?: LinkDetail) => void): () => void {
    this.linkListeners.push(fn);
    return () => {
      const i = this.linkListeners.indexOf(fn);
      if (i >= 0) this.linkListeners.splice(i, 1);
    };
  }

  onState(fn: (state: DeviceState) => void): () => void {
    this.stateListeners.push(fn);
    return () => {
      const i = this.stateListeners.indexOf(fn);
      if (i >= 0) this.stateListeners.splice(i, 1);
    };
  }

  emitLink(state: LinkState, detail?: LinkDetail): void {
    this.linkState = state;
    for (const fn of this.linkListeners.slice()) {
      fn(state, detail);
    }
  }

  emitState(state: DeviceState): void {
    for (const fn of this.stateListeners.slice()) {
      fn(state);
    }
  }

  async connect(deviceId: string, name?: string): Promise<DeviceState> {
    this.connectCalls.push({ deviceId, ...(name !== undefined ? { name } : {}) });
    this.emitLink("connecting", { deviceName: name });
    this.emitLink("initializing", { deviceName: name });
    const result = this.connectResult;
    if (result instanceof Error) {
      this.emitLink("failed", { message: result.message, ...(name ? { deviceName: name } : {}) });
      throw result;
    }
    // 真 transport 在 initLink 里读一次 State：回连必须重新读，不复用上次值。
    this.readStateCalls += 1;
    this.stateToRead = result;
    this.emitLink("ready", { deviceName: name });
    return result;
  }

  readState(): Promise<DeviceState> {
    this.readStateCalls += 1;
    const value = this.stateToRead;
    if (value instanceof Error) {
      return Promise.reject(value);
    }
    return Promise.resolve(value);
  }

  async write(req: CommandRequest): Promise<{ seq: number }> {
    this.writes.push(req);
    return { seq: 1 };
  }

  sendAndWaitAck(
    req: CommandRequest,
    opts?: unknown,
  ): Promise<{ seq: number; command: number; resultCode: number; ok: boolean }> {
    this.ackCalls.push({ req, opts });
    const err = this.ackErrors.shift();
    if (err !== undefined) {
      return Promise.reject(err);
    }
    const ack = { seq: 1, command: req.command, resultCode: 0, ok: true };
    if (this.pendingAck !== null) {
      return new Promise((resolve, reject) => {
        this.pendingAck = {
          resolve: () => resolve(ack),
          reject: (e: unknown) => reject(e),
        };
      });
    }
    return Promise.resolve(ack);
  }

  async startScan(): Promise<void> {
    this.scanCalls += 1;
    this.linkState = "scanning";
  }

  async stopScan(): Promise<void> {
    this.stopScanCalls += 1;
    if (this.linkState === "scanning") {
      this.linkState = "idle";
    }
  }

  async openAdapter(): Promise<void> {
    /* 测试里不做适配器初始化 */
  }

  async disconnect(): Promise<void> {
    this.disconnectCalls += 1;
    this.linkState = "idle";
  }

  destroy(): void {
    this.linkListeners.length = 0;
    this.stateListeners.length = 0;
  }
}

interface Harness {
  session: ControlSession;
  transport: FakeTransport;
  clock: ReturnType<typeof fakeClock>;
  storage: SessionStorage;
}

function makeSession(opts: { storage?: SessionStorage } = {}): Harness {
  const clock = fakeClock();
  const transport = new FakeTransport();
  const storage = opts.storage ?? memoryStorage();
  vi.spyOn(Date, "now").mockImplementation(() => clock.now);
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

/** 让所有已排队的微任务跑完（connect 是 async 的）。 */
async function settle(rounds = 6): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await Promise.resolve();
  }
}

/** 先成功连一次，把 deviceId 写进缓存（回连的前提）。 */
async function connectOnce(h: Harness): Promise<void> {
  h.transport.stateToRead = baseState();
  h.transport.connectResult = baseState();
  await h.session.connect("DEV-1", "Lumen-1234");
  h.transport.connectCalls = [];
  h.transport.readStateCalls = 0;
}

describe("#11 断线立即反映到 UI", () => {
  it("非主动断线 → 链路 idle + reconnectable，设备状态立刻清空", async () => {
    const h = makeSession();
    await connectOnce(h);
    expect(h.session.deviceState).not.toBeNull();

    h.transport.emitLink("idle", { message: "连接已断开", reconnectable: true });

    // 不保留过期状态：页面无法再读到旧 power / brightness / RGB。
    expect(h.session.deviceState).toBeNull();
    expect(h.session.linkState).toBe("idle");
    // 状态条同步显示「未连接」。
    const view = statusView(h.session.linkState, "Lumen-1234", "连接已断开", h.session.reconnectPending, true);
    expect(view.statusText).toBe("未连接");
    expect(view.linkClass).not.toBe("link-ready");
  });

  it("退避期间状态条收起动作按钮，只说明正在自动重连", () => {
    const view = statusView("idle", "Lumen-1234", undefined, true, true);
    expect(view.statusText).toBe("未连接");
    expect(view.statusAction).toBe("");
    expect(view.linkClass).toBe("link-busy");
  });

  it("退避耗尽（failed）给手动「重连」；无缓存时给「扫描」", () => {
    expect(statusView("failed", "", "连接失败", false, true).statusAction).toBe("重连");
    expect(statusView("failed", "", "连接失败", false, false).statusAction).toBe("扫描");
    // 没有任何状态条会把「未连接」显示成已连接。
    for (const state of ["idle", "failed", "adapter-off"] as LinkState[]) {
      expect(statusView(state, "", undefined, false, true).statusText).not.toContain("已连接");
    }
  });
});

describe("#11 自动回连退避 1s / 2s / 4s", () => {
  it("断线后按 1s→2s→4s 精确触发，最多 3 次后停止", async () => {
    const h = makeSession();
    await connectOnce(h);
    h.transport.connectResult = new Error("设备不在附近");

    h.transport.emitLink("idle", { message: "连接已断开", reconnectable: true });
    expect(h.clock.pendingTimers).toBe(1);

    // 1s 档
    h.clock.advance(999);
    await settle();
    expect(h.transport.connectCalls).toHaveLength(0);
    h.clock.advance(1);
    await settle();
    expect(h.transport.connectCalls).toHaveLength(1);

    // 2s 档：只有在失败后的 2s 才尝试
    expect(h.clock.pendingTimers).toBe(1);
    h.clock.advance(1999);
    await settle();
    expect(h.transport.connectCalls).toHaveLength(1);
    h.clock.advance(1);
    await settle();
    expect(h.transport.connectCalls).toHaveLength(2);

    // 4s 档
    expect(h.clock.pendingTimers).toBe(1);
    h.clock.advance(3999);
    await settle();
    expect(h.transport.connectCalls).toHaveLength(2);
    h.clock.advance(1);
    await settle();
    expect(h.transport.connectCalls).toHaveLength(3);

    // 耗尽：不再排程、不再尝试
    expect(h.clock.pendingTimers).toBe(0);
    expect(h.session.reconnectPending).toBe(false);
    h.clock.advance(600000);
    await settle();
    expect(h.transport.connectCalls).toHaveLength(3);
  });

  it("回连成功后不再继续退避", async () => {
    const h = makeSession();
    await connectOnce(h);
    const recovered = baseState({ power: 0, brightness: 40, r: 10, g: 20, b: 30 });
    h.transport.connectResult = recovered;

    h.transport.emitLink("idle", { message: "连接已断开", reconnectable: true });
    h.clock.advance(1000);
    await settle();

    expect(h.transport.connectCalls).toHaveLength(1);
    expect(h.clock.pendingTimers).toBe(0);
    expect(h.session.reconnectPending).toBe(false);
    expect(h.session.linkState).toBe("ready");

    // 后面没有任何补发的尝试
    h.clock.advance(60000);
    await settle();
    expect(h.transport.connectCalls).toHaveLength(1);
  });

  it("新手动连接重置退避计数（下一轮断线仍是 1s/2s/4s）", async () => {
    const h = makeSession();
    await connectOnce(h);
    h.transport.connectResult = new Error("失败");
    h.transport.emitLink("idle", { message: "x", reconnectable: true });
    // 消耗两次尝试
    h.clock.advance(1000);
    await settle();
    h.clock.advance(2000);
    await settle();
    expect(h.transport.connectCalls).toHaveLength(2);

    // 用户手动连接成功
    h.transport.connectResult = baseState();
    await h.session.connect("DEV-1", "Lumen-1234");
    h.transport.connectCalls = [];

    // 再次断线：仍从 1s 开始，且有完整 3 次
    h.transport.connectResult = new Error("又断了");
    h.transport.emitLink("idle", { message: "x", reconnectable: true });
    h.clock.advance(1000);
    await settle();
    expect(h.transport.connectCalls).toHaveLength(1);
    h.clock.advance(2000);
    await settle();
    expect(h.transport.connectCalls).toHaveLength(2);
    h.clock.advance(4000);
    await settle();
    expect(h.transport.connectCalls).toHaveLength(3);
  });
});

describe("#11 回连后重新订阅 notify 并读 State", () => {
  it("回连走完整 connect 流水线，控件值来自设备而非本地缓存", async () => {
    const h = makeSession();
    await connectOnce(h);
    // 断线前本地是 brightness=128 / RGB 255,180,120
    expect(h.session.deviceState?.brightness).toBe(128);

    // 断电期间设备状态被改过（例如固件上电恢复成默认值）
    const deviceNow = baseState({ power: 0, brightness: 0, r: 0, g: 0, b: 255, ledCount: 42 });
    h.transport.connectResult = deviceNow;
    h.transport.emitLink("idle", { message: "连接已断开", reconnectable: true });
    h.clock.advance(1000);
    await settle();

    expect(h.transport.connectCalls).toEqual([{ deviceId: "DEV-1", name: "Lumen-1234" }]);
    // 重新读 State（notify 重新订阅 + State read 在 connect 内完成）
    expect(h.transport.readStateCalls).toBe(1);
    expect(h.session.deviceState).toEqual(deviceNow);
  });

  it("回连后断线的旧写入不会被补发（不重传连续量）", async () => {
    const h = makeSession();
    await connectOnce(h);
    h.transport.emitLink("idle", { message: "x", reconnectable: true });
    h.transport.connectResult = baseState();
    h.clock.advance(1000);
    await settle();
    // 回连只产生一次 connect，没有任何额外写帧
    expect(h.transport.writes).toHaveLength(0);
  });
});

describe("#11 进前台静默回连", () => {
  it("有缓存且未连接：onShow 立即静默试一次", async () => {
    const h = makeSession();
    await connectOnce(h);
    h.transport.emitLink("idle", { message: "连接已断开", reconnectable: true });
    // 模拟小程序进后台：退避计时器被系统挂起，没有触发
    h.clock.pendingTimers; // 仅确认有排程
    h.transport.connectResult = baseState({ brightness: 90 });

    await h.session.onShow();
    await settle();

    expect(h.transport.connectCalls).toHaveLength(1);
    expect(h.session.deviceState?.brightness).toBe(90);
  });

  it("onShow 不打断正在进行的扫描", async () => {
    const h = makeSession();
    await connectOnce(h);
    h.transport.emitLink("scanning");

    await h.session.onShow();
    await settle();

    expect(h.transport.connectCalls).toHaveLength(0);
    expect(h.transport.scanCalls).toBe(0);
    expect(h.clock.pendingTimers).toBe(0);
    expect(h.session.linkState).toBe("scanning");
  });

  it("onShow 不打断手动连接（connecting / initializing）", async () => {
    for (const state of ["connecting", "initializing"] as LinkState[]) {
      const h = makeSession();
      await connectOnce(h);
      h.transport.emitLink(state);

      await h.session.onShow();
      await settle();

      expect(h.transport.connectCalls, state).toHaveLength(0);
      expect(h.session.linkState, state).toBe(state);
    }
  });

  it("onShow 在 ready 时只复核 State，不重连", async () => {
    const h = makeSession();
    await connectOnce(h);
    h.transport.stateToRead = baseState({ power: 0 });

    await h.session.onShow();
    await settle();

    expect(h.transport.connectCalls).toHaveLength(0);
    expect(h.transport.readStateCalls).toBe(1);
    expect(h.session.deviceState?.power).toBe(0);
  });

  it("退避已耗尽：onShow 不自动重来（只留手动入口）", async () => {
    const h = makeSession();
    await connectOnce(h);
    h.transport.connectResult = new Error("一直失败");
    h.transport.emitLink("idle", { message: "x", reconnectable: true });
    h.clock.advance(1000);
    await settle();
    h.clock.advance(2000);
    await settle();
    h.clock.advance(4000);
    await settle();
    expect(h.transport.connectCalls).toHaveLength(3);
    h.transport.connectCalls = [];

    await h.session.onShow();
    await settle();
    await h.session.onShow();
    await settle();

    expect(h.transport.connectCalls).toHaveLength(0);
    expect(h.clock.pendingTimers).toBe(0);
  });

  it("主动断开后 onShow 不擅自回连", async () => {
    const h = makeSession();
    await connectOnce(h);
    await h.session.disconnect();
    h.transport.connectCalls = [];

    await h.session.onShow();
    await settle();

    expect(h.transport.connectCalls).toHaveLength(0);
  });

  it("没有 deviceId 缓存时 onShow 不动链路", async () => {
    const h = makeSession();
    h.transport.linkState = "idle";

    await h.session.onShow();
    await settle();

    expect(h.transport.connectCalls).toHaveLength(0);
    expect(h.clock.pendingTimers).toBe(0);
  });

  it("onShow 在退避中途立即补一次（后台计时器可能被挂起）", async () => {
    const h = makeSession();
    await connectOnce(h);
    h.transport.connectResult = new Error("后台期间仍失败");
    h.transport.emitLink("idle", { message: "x", reconnectable: true });
    expect(h.clock.pendingTimers).toBe(1);

    h.transport.connectResult = baseState({ brightness: 33 });
    await h.session.onShow();
    await settle();

    // 不等 1s：回前台立刻复核并回连成功
    expect(h.transport.connectCalls).toHaveLength(1);
    expect(h.session.deviceState?.brightness).toBe(33);
    expect(h.clock.pendingTimers).toBe(0);
  });
});

describe("#11 用户操作优先于自动回连", () => {
  it("扫描取消待执行的退避，不与扫描抢链路", async () => {
    const h = makeSession();
    await connectOnce(h);
    h.transport.connectResult = new Error("失败");
    h.transport.emitLink("idle", { message: "x", reconnectable: true });
    expect(h.clock.pendingTimers).toBe(1);

    await h.session.scan();
    await settle();
    expect(h.clock.pendingTimers).toBe(0);
    expect(h.transport.scanCalls).toBe(1);
    expect(h.session.reconnectPending).toBe(false);

    // 退避时间到也不会有自动连接
    h.clock.advance(60000);
    await settle();
    expect(h.transport.connectCalls).toHaveLength(0);
  });

  it("手动连接取消退避，连接成功后不再自动重试", async () => {
    const h = makeSession();
    await connectOnce(h);
    h.transport.connectResult = new Error("失败");
    h.transport.emitLink("idle", { message: "x", reconnectable: true });

    h.transport.connectResult = baseState();
    await h.session.connect("DEV-1", "Lumen-1234");
    await settle();

    expect(h.transport.connectCalls).toHaveLength(1);
    expect(h.clock.pendingTimers).toBe(0);
    expect(h.session.reconnectPending).toBe(false);
  });

  it("主动 disconnect 不触发自动回连", async () => {
    const h = makeSession();
    await connectOnce(h);

    await h.session.disconnect();
    h.clock.advance(60000);
    await settle();

    expect(h.transport.connectCalls).toHaveLength(0);
    expect(h.clock.pendingTimers).toBe(0);
    // 缓存保留：用户下次可以一键重连，但不会自己连。
    expect(h.session.cachedDevice?.deviceId).toBe("DEV-1");
  });
});

describe("#11 错误分诊", () => {
  it("10006 不重试写，直接走重连", async () => {
    const h = makeSession();
    await connectOnce(h);
    h.transport.ackErrors = [wxErr(10006)];

    const result = await h.session.setPower(false);

    expect(result.kind).toBe("error");
    // 只尝试了一次写：10006 是链路已断，重试写没有意义（spec §9）。
    expect(h.transport.ackCalls).toHaveLength(1);
    expect(h.transport.disconnectCalls).toBe(1);
    expect(h.clock.pendingTimers).toBe(1);
  });

  it("10008 加间隔（500ms）只重试一次", async () => {
    const h = makeSession();
    await connectOnce(h);
    h.transport.ackErrors = [wxErr(10008)];

    const pending = h.session.setPower(false);
    await settle();
    expect(h.transport.ackCalls).toHaveLength(1);

    // 间隔未到：不写
    h.clock.advance(499);
    await settle();
    expect(h.transport.ackCalls).toHaveLength(1);

    // 满 500ms 才写第二次
    h.clock.advance(1);
    await settle();
    const result = await pending;

    expect(h.transport.ackCalls).toHaveLength(2);
    expect(result.kind).toBe("ok");
    // 成功重试后不进入回连
    expect(h.transport.disconnectCalls).toBe(0);
  });

  it("10008 连续两次失败：只重试一次，然后走重连", async () => {
    const h = makeSession();
    await connectOnce(h);
    h.transport.ackErrors = [wxErr(10008), wxErr(10008)];

    const pending = h.session.setPower(false);
    await settle();
    h.clock.advance(500);
    await settle();
    const result = await pending;

    expect(h.transport.ackCalls).toHaveLength(2); // 原始 + 一次重试，绝无第三次
    expect(result.kind).toBe("error");
    expect(h.transport.disconnectCalls).toBe(1);
  });

  it("10008 的重试不再继承 retryOnTimeout（避免一次重试叠成两次）", async () => {
    const h = makeSession();
    await connectOnce(h);
    h.transport.ackErrors = [wxErr(10008)];

    const pending = h.session.setPower(false); // 离散命令本带 retryOnTimeout: 1
    await settle();
    h.clock.advance(500);
    await settle();
    await pending;

    expect(h.transport.ackCalls).toHaveLength(2);
    expect(h.transport.ackCalls[0].opts).toMatchObject({ retryOnTimeout: 1 });
    expect(h.transport.ackCalls[1].opts).toMatchObject({ retryOnTimeout: 0 });
  });

  it("10001 非致命：不重试、不回连、只提示「请打开蓝牙」", async () => {
    const h = makeSession();
    await connectOnce(h);
    h.transport.ackErrors = [wxErr(10001)];

    const result = await h.session.setPower(false);

    expect(result.kind).toBe("error");
    if (result.kind === "error") {
      expect(result.message).toBe("请打开蓝牙");
    }
    expect(h.transport.ackCalls).toHaveLength(1);
    expect(h.transport.disconnectCalls).toBe(0);
    expect(h.clock.pendingTimers).toBe(0);
  });

  it("适配器关闭时不清缓存，等适配器事件恢复", async () => {
    const h = makeSession();
    await connectOnce(h);
    h.transport.emitLink("adapter-off", { message: "请打开蓝牙" });

    expect(h.session.deviceState).toBeNull();
    expect(h.session.cachedDevice?.deviceId).toBe("DEV-1");
    // 10001 非致命：不排任何回连计时器
    expect(h.clock.pendingTimers).toBe(0);
    // 状态条给「请打开蓝牙」
    expect(statusView("adapter-off", "", undefined, false, true).statusText).toBe("请打开蓝牙");
  });

  it("适配器恢复后按退避继续回连（不需要用户重启小程序）", async () => {
    const h = makeSession();
    await connectOnce(h);
    h.transport.emitLink("adapter-off", { message: "请打开蓝牙" });
    expect(h.session.reconnectPending).toBe(true);

    // 用户打开系统蓝牙：transport 把链路切回 idle
    h.transport.connectResult = baseState({ brightness: 77 });
    h.transport.emitLink("idle", { message: "蓝牙已恢复" });

    expect(h.clock.pendingTimers).toBe(1);
    h.clock.advance(1000);
    await settle();

    expect(h.transport.connectCalls).toHaveLength(1);
    expect(h.session.deviceState?.brightness).toBe(77);
  });
});

describe("#11 旧 ACK 不覆盖新 State", () => {
  it("断线前在飞的 SetPower 晚到，回连后读到的新 State 保持不变", async () => {
    const h = makeSession();
    await connectOnce(h);

    // 让第一条 SetPower 挂起（模拟旧连接上在飞）。
    // v2 没有 SetAll / SetColor 了，用仍存在的离散命令覆盖同一段逻辑。
    h.transport.pendingAck = { resolve: () => undefined, reject: () => undefined };
    const presetPromise = h.session.setPower(false);
    await settle();
    expect(h.transport.ackCalls).toHaveLength(1);

    // 断线 → 回连后设备是另一套状态
    const afterReconnect = baseState({ power: 1, brightness: 200, r: 0, g: 255, b: 0 });
    h.transport.connectResult = afterReconnect;
    h.transport.emitLink("idle", { message: "连接已断开", reconnectable: true });
    h.clock.advance(1000);
    await settle();
    expect(h.session.deviceState).toEqual(afterReconnect);

    // 旧 ACK 现在才回来
    h.transport.pendingAck?.resolve();
    const result = await presetPromise;

    expect(result.kind).toBe("stale");
    // 新 State 未被旧 ACK 覆盖（设备仍是回连后读到的那套）。
    expect(h.session.deviceState).toEqual(afterReconnect);
  });

  it("同一连接内的正常 ACK 仍然回写（不会被误判 stale）", async () => {
    const h = makeSession();
    await connectOnce(h);
    const result = await h.session.setPower(false);
    expect(result.kind).toBe("ok");
    if (result.kind === "ok") {
      expect(result.state.power).toBe(0);
    }
  });
});

describe("#11 deviceId 缓存", () => {
  it("成功连接后写入 storage，下次启动可直接回连", async () => {
    const storage = memoryStorage();
    const first = makeSession({ storage });
    await connectOnce(first);

    const raw = storage.get(DEVICE_CACHE_KEY);
    expect(raw).not.toBeNull();
    expect(JSON.parse(raw as string)).toEqual({ deviceId: "DEV-1", name: "Lumen-1234" });

    // 新 session（模拟重新打开小程序）读到缓存
    const second = makeSession({ storage });
    expect(second.session.cachedDevice).toEqual({ deviceId: "DEV-1", name: "Lumen-1234" });
  });

  it("连接失败不写缓存", async () => {
    const storage = memoryStorage();
    const h = makeSession({ storage });
    h.transport.connectResult = new Error("连不上");

    await expect(h.session.connect("DEV-9", "Lumen-9")).rejects.toThrow("连不上");
    expect(storage.get(DEVICE_CACHE_KEY)).toBeNull();
    expect(h.session.cachedDevice).toBeNull();
  });

  it("10013（deviceId 失效）清掉缓存，避免用坏 UUID 反复回连", async () => {
    const storage = memoryStorage();
    const h = makeSession({ storage });
    await connectOnce(h);
    h.transport.connectResult = wxErr(10013);

    await expect(h.session.connect("DEV-1", "Lumen-1234")).rejects.toBeInstanceOf(WxCallError);
    expect(storage.get(DEVICE_CACHE_KEY)).toBeNull();
    expect(h.session.cachedDevice).toBeNull();
  });
});

describe("#11 设备事件 Event 0x81（存储失败）", () => {
  it("0x01 映射成非阻塞警告，含原命令名", () => {
    const text = eventText(0x01, CMD_SET_LED_COUNT);
    expect(text).toContain("SetLedCount");
    expect(text).toContain("保存失败");
    expect(eventText(0x01, CMD_SET_POWER)).toContain("SetPower");
  });

  it("0x02 剧本提交失败：提示保留上一套配置", () => {
    const text = eventText(0x02, 3);
    expect(text).toContain("剧本 3");
    expect(text).toContain("上一套配置");
  });

  it("保留码不打扰用户（返回 null，只记日志）", () => {
    expect(eventText(0x03, 0)).toBeNull();
    expect(eventText(0xff, 0)).toBeNull();
  });

  it("未知原命令字按十六进制显示，不抛错", () => {
    expect(eventText(0x01, 0x7f)).toContain("0x7F");
  });
});
