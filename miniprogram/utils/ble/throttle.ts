/**
 * 单通道 20Hz latest-wins 节流。
 *
 * 语义：
 *  - 任意 50ms 窗口内最多调用一次 sink；
 *  - sink 未完成时新值只覆盖 pending，完成后再按最小间隔发最新值；
 *  - 永不排队中间值（连续量不重传旧值）。
 *
 * 本票（#8）开关走离散路径，不使用节流；本类先建好接口并单测，
 * #9 亮度、#10 颜色直接复用同一个实例（避免两个通道叠成 40Hz）。
 *
 * 计时器可注入，便于测试里替换（spec 允许的唯一假件之一是计时器）。
 */

import { CONTINUOUS_INTERVAL_MS } from "../protocol/constants";

export interface TimerApi {
  setTimeout: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimeout: (handle: ReturnType<typeof setTimeout>) => void;
}

const defaultTimer: TimerApi = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle),
};

export interface ThrottleOptions {
  intervalMs?: number;
  timer?: TimerApi;
}

export class LatestWinsThrottle<T> {
  private readonly sink: (value: T) => void | Promise<void>;
  private readonly intervalMs: number;
  private readonly timer: TimerApi;
  private pending: T | undefined;
  private hasPending = false;
  private timerHandle: ReturnType<typeof setTimeout> | null = null;
  private lastSentAt = 0;
  private sending = false;

  constructor(sink: (value: T) => void | Promise<void>, opts: ThrottleOptions = {}) {
    this.sink = sink;
    this.intervalMs = opts.intervalMs ?? CONTINUOUS_INTERVAL_MS;
    this.timer = opts.timer ?? defaultTimer;
  }

  push(value: T): void {
    this.pending = value;
    this.hasPending = true;
    this.schedule();
  }

  /** 松手时尽快发，但仍遵守最小间隔。 */
  flush(): void {
    this.schedule();
  }

  cancel(): void {
    this.hasPending = false;
    this.pending = undefined;
    if (this.timerHandle !== null) {
      this.timer.clearTimeout(this.timerHandle);
      this.timerHandle = null;
    }
  }

  /**
   * 丢弃满足条件的 pending 值（不取消正在飞的那一帧）。
   *
   * #10 用：用户拖色环留下一个未发出的颜色，紧接着点了预设（SetAll 离散帧）。
   * 若不丢弃，这个旧颜色会在 SetAll 之后落地，造成「旧色回跳」。
   */
  dropIf(predicate: (value: T) => boolean): void {
    if (!this.hasPending || this.pending === undefined) {
      return;
    }
    if (!predicate(this.pending)) {
      return;
    }
    this.hasPending = false;
    this.pending = undefined;
    if (this.timerHandle !== null) {
      this.timer.clearTimeout(this.timerHandle);
      this.timerHandle = null;
    }
  }

  get pendingValue(): T | undefined {
    return this.hasPending ? this.pending : undefined;
  }

  private schedule(): void {
    if (!this.hasPending || this.timerHandle !== null || this.sending) {
      return;
    }
    const now = Date.now();
    const wait = Math.max(0, this.lastSentAt + this.intervalMs - now);
    this.timerHandle = this.timer.setTimeout(() => {
      this.timerHandle = null;
      this.emit();
    }, wait);
  }

  private emit(): void {
    if (!this.hasPending) {
      return;
    }
    const value = this.pending as T;
    this.hasPending = false;
    this.pending = undefined;
    this.sending = true;
    this.lastSentAt = Date.now();

    const done = () => {
      this.sending = false;
      this.schedule();
    };

    let result: void | Promise<void>;
    try {
      result = this.sink(value);
    } catch {
      done();
      return;
    }
    if (result && typeof (result as Promise<void>).then === "function") {
      (result as Promise<void>).then(done, done);
    } else {
      done();
    }
  }
}
