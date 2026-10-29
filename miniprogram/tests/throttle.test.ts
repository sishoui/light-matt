/**
 * 20Hz latest-wins 节流测试。只替换计时器（spec 允许的假件）。
 */

import { describe, expect, it, vi } from "vitest";

import { LatestWinsThrottle } from "../utils/ble/throttle";

/** 可控时钟 + 计时器，避免依赖真实时间。 */
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

describe("LatestWinsThrottle", () => {
  it("100Hz 输入 1 秒 → sink 最多 20 次，且最后一次是最新值", () => {
    const clock = fakeClock();
    const sent: number[] = [];
    vi.spyOn(Date, "now").mockImplementation(() => clock.now);

    const throttle = new LatestWinsThrottle<number>((value) => {
      sent.push(value);
    }, { intervalMs: 50, timer: clock.timerApi });

    for (let i = 0; i < 100; i += 1) {
      throttle.push(i);
      clock.advance(10);
    }
    clock.advance(200);

    expect(sent.length).toBeLessThanOrEqual(20);
    expect(sent.length).toBeGreaterThan(0);
    expect(sent[sent.length - 1]).toBe(99);

    vi.restoreAllMocks();
  });

  it("一次 push 多个值，只发最后一个（latest-wins，不排队）", () => {
    const clock = fakeClock();
    const sent: number[] = [];
    vi.spyOn(Date, "now").mockImplementation(() => clock.now);

    const throttle = new LatestWinsThrottle<number>((value) => {
      sent.push(value);
    }, { intervalMs: 50, timer: clock.timerApi });

    for (let i = 0; i < 100; i += 1) {
      throttle.push(i);
    }
    clock.advance(50);

    expect(sent).toEqual([99]);
    expect(throttle.pendingValue).toBeUndefined();

    vi.restoreAllMocks();
  });

  it("最小间隔：50ms 内的第二次 push 必须等窗口结束", () => {
    const clock = fakeClock();
    const sent: number[] = [];
    vi.spyOn(Date, "now").mockImplementation(() => clock.now);

    const throttle = new LatestWinsThrottle<number>((value) => {
      sent.push(value);
    }, { intervalMs: 50, timer: clock.timerApi });

    throttle.push(1);
    clock.advance(50);
    expect(sent).toEqual([1]);

    throttle.push(2);
    clock.advance(49);
    expect(sent).toEqual([1]);
    clock.advance(1);
    expect(sent).toEqual([1, 2]);

    vi.restoreAllMocks();
  });

  it("慢 sink（超过 50ms）时 pending 只保留最新值", async () => {
    const clock = fakeClock();
    const sent: number[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.spyOn(Date, "now").mockImplementation(() => clock.now);

    const throttle = new LatestWinsThrottle<number>(
      (value) => {
        sent.push(value);
        return gate;
      },
      { intervalMs: 50, timer: clock.timerApi },
    );

    throttle.push(1);
    clock.advance(50);
    expect(sent).toEqual([1]);

    // sink 未完成期间的多次 push 只覆盖 pending
    throttle.push(2);
    throttle.push(3);
    throttle.push(4);
    clock.advance(200);
    expect(sent).toEqual([1]);

    release();
    await Promise.resolve();
    clock.advance(50);
    expect(sent).toEqual([1, 4]);

    vi.restoreAllMocks();
  });

  it("cancel 丢弃 pending 并清 timer", () => {
    const clock = fakeClock();
    const sent: number[] = [];
    vi.spyOn(Date, "now").mockImplementation(() => clock.now);

    const throttle = new LatestWinsThrottle<number>((value) => {
      sent.push(value);
    }, { intervalMs: 50, timer: clock.timerApi });

    throttle.push(1);
    expect(clock.pendingTimers).toBe(1);
    throttle.cancel();
    expect(clock.pendingTimers).toBe(0);
    expect(throttle.pendingValue).toBeUndefined();
    clock.advance(100);
    expect(sent).toEqual([]);

    vi.restoreAllMocks();
  });
});
