/**
 * #9 亮度端到端的小程序侧测试。
 *
 * 覆盖：
 *  1. 亮度纯函数：按设备 max_brightness 钳位、亮度 0 与开关解耦、开灯恢复；
 *  2. 节流路径：100Hz 输入 → ≤20Hz 输出、latest-wins、松手不回跳；
 *  3. 连续量不重传：写失败/ACK 超时都不重发旧亮度值；
 *  4. session 与固件语义对齐：亮度 0 只发 SetBrightness（不动 power 位）、
 *     关灯保留亮度、开灯自动恢复最近一次非 0 亮度。
 *
 * 只替换计时器与传输通道（spec 允许的两个假件），不 mock BLE 协议字节。
 */

import { describe, expect, it, vi } from "vitest";

import {
  applyLocalBrightness,
  brightnessForPowerOn,
  brightnessPercent,
  clampBrightness,
  effectiveMaxBrightness,
  isVisuallyOff,
} from "../utils/control/brightness";
import { ControlSession } from "../utils/control/session";
import type { BleTransport } from "../utils/ble/transport";
import type { CommandRequest, DeviceState } from "../utils/protocol/types";

const CMD_SET_POWER = 0x01;
const CMD_SET_BRIGHTNESS = 0x02;

/** 可控时钟 + 计时器（与 throttle.test.ts 同款，节流测试唯一假件）。 */
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
  };
}

/** 假传输通道：只记录命令与状态事件，不碰 wx / BLE。 */
class FakeTransport {
  linkState: "ready" | "idle" = "ready";
  /** 所有写尝试（含失败），按时间顺序。 */
  attempts: CommandRequest[] = [];
  /** 成功写入的命令。 */
  writes: CommandRequest[] = [];
  failNextWrites = 0;

  private readonly stateListeners: Array<(state: DeviceState) => void> = [];
  private readonly linkListeners: Array<(state: string, detail?: unknown) => void> = [];
  private seq = 1;

  /** #11 起 session 内部订阅链路状态；这里只记录，不主动触发。 */
  onLink(fn: (state: string, detail?: unknown) => void): () => void {
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

  emitState(state: DeviceState): void {
    for (const fn of this.stateListeners.slice()) {
      fn(state);
    }
  }

  async write(req: CommandRequest): Promise<{ seq: number }> {
    this.attempts.push(req);
    if (this.failNextWrites > 0) {
      this.failNextWrites -= 1;
      throw new Error("写失败");
    }
    this.writes.push(req);
    const seq = this.seq;
    this.seq = (this.seq + 1) & 0xff;
    return { seq };
  }

  async sendAndWaitAck(
    req: CommandRequest,
  ): Promise<{ seq: number; command: number; resultCode: number; ok: boolean }> {
    this.attempts.push(req);
    this.writes.push(req);
    const seq = this.seq;
    this.seq = (this.seq + 1) & 0xff;
    return { seq, command: req.command, resultCode: 0, ok: true };
  }

  async disconnect(): Promise<void> {
    /* 测试里不做连接清理 */
  }

  destroy(): void {
    this.stateListeners.length = 0;
  }
}

interface SessionHarness {
  session: ControlSession;
  transport: FakeTransport;
  clock: ReturnType<typeof fakeClock>;
}

/** 建一个接在假通道上的 session；节流计时器用可控时钟。 */
function makeSession(): SessionHarness {
  const clock = fakeClock();
  const transport = new FakeTransport();
  vi.spyOn(Date, "now").mockImplementation(() => clock.now);
  const session = new ControlSession({
    platform: "other",
    devMode: false,
    transportOverride: transport as unknown as BleTransport,
    throttleTimer: clock.timerApi,
  });
  return { session, transport, clock };
}

/** 让 async sink 的 then 回调跑完，再推进时钟。 */
async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
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

/** 取命令载荷第 1 字节（SetBrightness / SetPower 都是 1 字节载荷）。 */
function payloadByte(req: CommandRequest): number {
  return req.payload[0];
}

describe("亮度纯函数", () => {
  it("按设备 max_brightness 钳位，而不是硬编码 255", () => {
    expect(clampBrightness(255, 255)).toBe(255);
    expect(clampBrightness(255, 180)).toBe(180);
    expect(clampBrightness(200, 100)).toBe(100);
    expect(clampBrightness(-5, 255)).toBe(0);
    expect(clampBrightness(1.6, 255)).toBe(2);
    expect(clampBrightness(Number.NaN, 255)).toBe(0);
  });

  it("非法 max_brightness 回退到 255；百分比随上限变化", () => {
    expect(effectiveMaxBrightness(0)).toBe(255);
    expect(effectiveMaxBrightness(-1)).toBe(255);
    expect(effectiveMaxBrightness(undefined)).toBe(255);
    expect(effectiveMaxBrightness(180)).toBe(180);

    expect(brightnessPercent(255, 255)).toBe(100);
    expect(brightnessPercent(90, 180)).toBe(50);
  });

  it("亮度 0 视觉等于关灯，但不等于 power 位为 0", () => {
    expect(isVisuallyOff({ power: 1, brightness: 0 })).toBe(true);
    expect(isVisuallyOff({ power: 0, brightness: 128 })).toBe(true);
    expect(isVisuallyOff({ power: 1, brightness: 1 })).toBe(false);
  });

  it("本地乐观更新只改 brightness，不动 power（§7）", () => {
    const state = baseState({ power: 1, brightness: 128 });
    const next = applyLocalBrightness(state, 0);
    expect(next.brightness).toBe(0);
    expect(next.power).toBe(1);
    expect(state.brightness).toBe(128); // 不修改入参
  });

  it("开灯恢复最近一次非 0 亮度，并按上限钳位", () => {
    expect(brightnessForPowerOn(77, 255)).toBe(77);
    expect(brightnessForPowerOn(0, 255)).toBe(128);
    expect(brightnessForPowerOn(200, 180)).toBe(180);
  });
});

describe("亮度节流（100Hz → ≤20Hz，latest-wins）", () => {
  it("100Hz 拖动 1 秒：写次数 ≤20，且每次都发当时最新值", async () => {
    const { session, transport, clock } = makeSession();
    transport.emitState(baseState({ maxBrightness: 255 }));

    for (let i = 0; i < 100; i += 1) {
      session.queueBrightness(i);
      clock.advance(10);
      await settle();
    }
    clock.advance(200);
    await settle();

    expect(transport.writes.length).toBeLessThanOrEqual(20);
    expect(transport.writes.length).toBeGreaterThan(0);
    // 每次都是当时的最新值：序列严格递增，不回放旧值。
    const values = transport.writes.map(payloadByte);
    for (let i = 1; i < values.length; i += 1) {
      expect(values[i]).toBeGreaterThan(values[i - 1]);
    }
    expect(values[values.length - 1]).toBe(99);

    vi.restoreAllMocks();
  });

  it("松手 flush 只发最新值，松手后不回跳旧值", async () => {
    const { session, transport, clock } = makeSession();
    transport.emitState(baseState());

    session.queueBrightness(10);
    clock.advance(50);
    await settle();
    session.queueBrightness(200);
    clock.advance(50);
    await settle();

    const writesBeforeRelease = transport.writes.length;
    session.commitBrightness(200);
    clock.advance(50);
    await settle();

    const after = transport.writes.slice(writesBeforeRelease).map(payloadByte);
    expect(after.length).toBeLessThanOrEqual(1);
    for (const value of after) {
      expect(value).toBe(200);
    }
    // 松手后不存在任何小于 200 的写入。
    expect(transport.writes.slice(writesBeforeRelease).every((r) => payloadByte(r) === 200)).toBe(
      true,
    );

    vi.restoreAllMocks();
  });

  it("连续量不重传：写失败不触发旧值重发", async () => {
    const { session, transport, clock } = makeSession();
    transport.emitState(baseState());

    transport.failNextWrites = 1;
    session.queueBrightness(42);
    clock.advance(50);
    await settle();
    expect(transport.attempts.map(payloadByte)).toEqual([42]);

    session.queueBrightness(43);
    clock.advance(50);
    await settle();
    // 42 只尝试过一次（没有重传），接着发的是最新值 43。
    expect(transport.attempts.map(payloadByte)).toEqual([42, 43]);
    expect(transport.writes.map(payloadByte)).toEqual([43]);

    vi.restoreAllMocks();
  });

  it("滑块值按设备 max_brightness 钳位后再下发", async () => {
    const { session, transport, clock } = makeSession();
    transport.emitState(baseState({ maxBrightness: 100 }));

    session.queueBrightness(255);
    clock.advance(50);
    await settle();

    expect(transport.writes).toHaveLength(1);
    expect(payloadByte(transport.writes[0])).toBe(100);
    expect(session.deviceState?.brightness).toBe(100);

    vi.restoreAllMocks();
  });
});

describe("亮度与开关解耦", () => {
  it("亮度拖到 0 只发 SetBrightness，power 位保持为 1", async () => {
    const { session, transport, clock } = makeSession();
    transport.emitState(baseState({ power: 1, brightness: 128 }));

    session.commitBrightness(0);
    clock.advance(50);
    await settle();

    expect(transport.writes.map((r) => r.command)).toEqual([CMD_SET_BRIGHTNESS]);
    expect(payloadByte(transport.writes[0])).toBe(0);
    expect(session.deviceState?.power).toBe(1);
    expect(session.deviceState?.brightness).toBe(0);

    vi.restoreAllMocks();
  });

  it("关灯保留亮度：SetPower 0 不改本地 brightness", async () => {
    const { session, transport } = makeSession();
    transport.emitState(baseState({ power: 1, brightness: 77 }));

    const result = await session.setPower(false);
    expect(result.kind).toBe("ok");
    expect(transport.writes.map((r) => r.command)).toEqual([CMD_SET_POWER]);
    expect(payloadByte(transport.writes[0])).toBe(0);
    expect(session.deviceState?.power).toBe(0);
    expect(session.deviceState?.brightness).toBe(77);

    vi.restoreAllMocks();
  });

  it("亮度 0 时开灯：先发 SetBrightness 恢复，再发 SetPower 1", async () => {
    const { session, transport } = makeSession();
    // 先记住一次非 0 亮度（模拟关灯前的状态），再进入亮度 0 + 关灯。
    transport.emitState(baseState({ power: 1, brightness: 200 }));
    transport.emitState(baseState({ power: 0, brightness: 0 }));

    const result = await session.setPower(true);
    expect(result.kind).toBe("ok");
    expect(transport.writes.map((r) => r.command)).toEqual([CMD_SET_BRIGHTNESS, CMD_SET_POWER]);
    expect(payloadByte(transport.writes[0])).toBe(200);
    expect(payloadByte(transport.writes[1])).toBe(1);
    expect(session.deviceState?.power).toBe(1);
    expect(session.deviceState?.brightness).toBe(200);

    vi.restoreAllMocks();
  });

  it("正常关灯再开不重发亮度（brightness > 0 时不走恢复路径）", async () => {
    const { session, transport } = makeSession();
    transport.emitState(baseState({ power: 0, brightness: 90 }));

    await session.setPower(true);
    expect(transport.writes.map((r) => r.command)).toEqual([CMD_SET_POWER]);

    vi.restoreAllMocks();
  });
});
