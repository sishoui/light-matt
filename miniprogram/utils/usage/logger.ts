/**
 * 使用日志上报器（fire-and-forget，永不阻塞控制）。
 *
 * ## 职责边界
 *
 * - **写入侧只有这里**：一次成功连接 → 入队一条记录 → 立刻尝试发送；
 *   发送失败就留在本地队列，等下一次机会补报。
 * - **不在控制路径上**：`recordConnection()` 是同步返回 `void`；发送在后台
 *   Promise 里跑，任何异常（断网、超时、5xx、HTML 502、JSON 损坏）都被吞掉，
 *   只记为诊断信息，**绝不 throw、绝不给用户弹错、绝不 await**。
 * - **幂等**：`clientEventId` 在入队时生成并随队列持久化，重放永远用同一个 id，
 *   后端返回 `200 {duplicate:true}` 后本地才删除该条。重复提交不会产生重复行。
 *
 * ## 重放触发
 *
 * 1. 每次 `recordConnection()` 之后（有新记录往往也有网络）；
 * 2. 页面 `onShow()` 显式调用 `replay()`（用户从后台回来时补报）；
 * 3. 收到了一条时，flush 会顺便把整个队列按入队顺序发完。
 *
 * 不做定时器轮询：本票不需要后台保活，用户打开小程序就会触发补报。
 *
 * ## 发送顺序
 *
 * 严格先进先出。后端用「本次 startedAt」给同 (用户, 设备) 上一条未收尾的
 * 会话写 `ended_at`，顺序乱了会收错时间。
 */

import { usageLogsUrl, type UsageConfig } from "./config";
import {
  buildUsageEvent,
  createClientEventId,
  getOrCreateLocalUserKey,
  type ConnectionIdentity,
  type UsageEvent,
} from "./event";
import type { HttpFetch } from "./http";
import { UsageQueue } from "./queue";
import type { UsageStorage } from "./storage";

/** session 只依赖这个接口，不知道队列 / HTTP / storage 的存在。 */
export interface UsageLogSink {
  /** 一次成功连接（ready）。同步返回，绝不影响连接流程。 */
  recordConnection(identity: ConnectionIdentity): void;
  /** 尝试补报队列（页面 onShow 时调用）。 */
  replay(): void;
}

export interface UsageLoggerOptions {
  config: UsageConfig;
  fetch: HttpFetch;
  storage: UsageStorage;
  /** 可注入计时器：超时断言不依赖真实时间。 */
  timer?: {
    setTimeout: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
    clearTimeout: (handle: ReturnType<typeof setTimeout>) => void;
  };
  now?: () => number;
  random?: () => number;
  /** 诊断回调（默认吞掉）。永远不用于向用户报错。 */
  onDiagnostic?: (message: string) => void;
}

const defaultTimer = {
  setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
  clearTimeout: (handle: ReturnType<typeof setTimeout>) => clearTimeout(handle),
};

/** 每次 flush 最多发送的条数：一次补报不全量轰后端，剩下的下次继续。 */
export const MAX_SENDS_PER_FLUSH = 10;

type SendOutcome = "delivered" | "rejected" | "retry";

export class UsageLogger implements UsageLogSink {
  private readonly config: UsageConfig;
  private readonly fetchImpl: HttpFetch;
  private readonly storage: UsageStorage;
  private readonly timer: NonNullable<UsageLoggerOptions["timer"]>;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly diagnose: (message: string) => void;
  private readonly queue: UsageQueue;
  /** 是否真的会发请求：配置开关 + 两项必填都齐。 */
  private readonly active: boolean;
  private flushing = false;
  /** flush 进行中又被触发：结束后补跑一次，避免新记录卡到下一个触发点。 */
  private flushRequested = false;

  constructor(opts: UsageLoggerOptions) {
    this.config = opts.config;
    this.fetchImpl = opts.fetch;
    this.storage = opts.storage;
    this.timer = opts.timer ?? defaultTimer;
    this.now = opts.now ?? (() => Date.now());
    this.random = opts.random ?? Math.random;
    this.diagnose = opts.onDiagnostic ?? (() => undefined);
    this.queue = new UsageQueue(opts.storage);
    this.active =
      opts.config.enabled && opts.config.baseUrl.length > 0 && opts.config.appToken.length > 0;
  }

  /** 仅测试 / 状态展示用：当前待补报条数。 */
  get pending(): number {
    return this.queue.size;
  }

  /** 配置是否可用（未配置时日志功能整体关闭，控制不受影响）。 */
  get enabled(): boolean {
    return this.active;
  }

  /**
   * 记录一次成功连接。
   *
   * 同步入队（持久化）后立即返回；发送交给后台 flush。未配置时什么都不做。
   */
  recordConnection(identity: ConnectionIdentity): void {
    if (!this.active) {
      return;
    }
    try {
      const userKey = getOrCreateLocalUserKey(this.storage, this.random);
      const event = buildUsageEvent({
        userKey,
        startedAt: this.now(),
        clientEventId: createClientEventId(this.random),
        device: identity,
      });
      const dropped = this.queue.enqueue(event);
      if (dropped) {
        this.diagnose(`使用日志队列已满（${this.queue.size}），丢弃最旧一条`);
      }
    } catch (err) {
      // 构造理论上不会失败；真失败也不能影响连接。
      this.diagnose(`使用日志入队失败：${String(err)}`);
      return;
    }
    // 故意不返回 Promise：调用方（session）不能 await 网络。
    void this.flush();
  }

  replay(): void {
    void this.flush();
  }

  /**
   * 按入队顺序发送。成功 / 永久拒绝的从队列删除；可重试错误停下来保留。
   * 永不 reject：所有异常在下游被折成 `retry`。
   *
   * 单次最多发 `MAX_SENDS_PER_FLUSH` 条，避免一次补报把整个积压轰给后端。
   * 发送期间若又有新记录入队，本轮结束后自动再跑一轮（不丢触发）。
   */
  async flush(): Promise<void> {
    if (!this.active) {
      return;
    }
    if (this.flushing) {
      this.flushRequested = true;
      return;
    }
    this.flushing = true;
    let stoppedOnRetry = false;
    try {
      let sent = 0;
      while (sent < MAX_SENDS_PER_FLUSH) {
        const event = this.queue.head();
        if (event === null) {
          break;
        }
        const outcome = await this.sendOne(event);
        if (outcome === "retry") {
          // 后端不可达：整批留到下一个外部触发，本轮不再重试。
          stoppedOnRetry = true;
          break;
        }
        this.queue.remove(event.clientEventId);
        sent += 1;
      }
    } catch (err) {
      this.diagnose(`使用日志补报异常：${String(err)}`);
    } finally {
      this.flushing = false;
    }
    // 发送期间有新记录进来：它们没有触发到新的外部事件，这里补一轮。
    if (this.flushRequested && !stoppedOnRetry) {
      this.flushRequested = false;
      void this.flush();
    }
  }

  private async sendOne(event: UsageEvent): Promise<SendOutcome> {
    let response;
    try {
      response = await this.requestWithTimeout(event);
    } catch (err) {
      // 网络层失败 / 超时：保留记录，等下次补报。
      this.diagnose(`使用日志未送达（保留待补报）：${String(err)}`);
      return "retry";
    }

    const status = response.status;
    if (status >= 200 && status < 300) {
      return "delivered"; // 201 新建 / 200 幂等重复，都算送达
    }
    if (status === 400 || status === 413 || status === 422) {
      // 请求体被判定非法：重发永远不会成功，删掉以免堵住队列。
      this.diagnose(`使用日志被后端拒绝（${status}），丢弃该条`);
      return "rejected";
    }
    // 401/403（令牌错）/ 404/405（地址错）/ 408/429/5xx 都按可重试处理：
    // 配置修好后同一份队列还能补上。
    this.diagnose(`使用日志未能上报（HTTP ${status}），保留待补报`);
    return "retry";
  }

  private requestWithTimeout(event: UsageEvent): Promise<{ status: number; body: string }> {
    const request = this.fetchImpl({
      url: usageLogsUrl(this.config),
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-lumen-app-token": this.config.appToken,
      },
      body: JSON.stringify(event),
      timeoutMs: this.config.requestTimeoutMs,
    });
    return this.withTimeout(request, this.config.requestTimeoutMs, "usage-log");
  }

  /** 硬超时：部分平台的 wx.request 不保证回调，不能只靠它自己的 timeout。 */
  private withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const handle = this.timer.setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error(`${label} 超时 ${ms}ms`));
      }, ms);
      promise.then(
        (value) => {
          if (settled) return;
          settled = true;
          this.timer.clearTimeout(handle);
          resolve(value);
        },
        (err: unknown) => {
          if (settled) return;
          settled = true;
          this.timer.clearTimeout(handle);
          reject(err);
        },
      );
    });
  }
}
