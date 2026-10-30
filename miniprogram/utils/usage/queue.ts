/**
 * 使用日志的本地待补报队列（持久化到 storage，App 重启不丢）。
 *
 * ## 容量上限：50 条
 *
 * 为什么是 50：
 *  - 一条记录约 200-300 字节 JSON，50 条 < 15KB，远低于小程序单 key 1MB 的
 *    存储上限，也远低于同步存储的写入耗时警戒线；
 *  - 队列只在「后端不可达」期间增长，一次连接产生一条，50 条相当于 50 次
 *    连接——个人测试阶段够用好几周；
 *  - 溢出时**丢最旧的**：看板关心的是「最近有没有人用」，新记录比旧记录
 *    更有价值；丢弃次数记在 storage 里，便于诊断（不静默）。
 *
 * 队列顺序 = 发送顺序（先进先出）。后端按 `started_at` 给同一 (用户, 设备)
 * 的上一段会话收尾，顺序乱了会收错时间，所以必须保序。
 *
 * 所有读写都吞异常：队列是旁路，不能影响 BLE 控制。
 */

import type { UsageEvent } from "./event";
import type { UsageStorage } from "./storage";

export const USAGE_QUEUE_STORAGE_KEY = "lumen.usage.queue.v1";
export const USAGE_QUEUE_MAX = 50;
export const USAGE_QUEUE_DROPPED_STORAGE_KEY = "lumen.usage.queue.dropped.v1";

interface QueueFile {
  version: 1;
  items: UsageEvent[];
}

function isEvent(value: unknown): value is UsageEvent {
  if (typeof value !== "object" || value === null) return false;
  const e = value as Partial<UsageEvent>;
  if (typeof e.userKey !== "string" || e.userKey.length === 0) return false;
  if (typeof e.clientEventId !== "string" || e.clientEventId.length === 0) return false;
  if (typeof e.startedAt !== "number" || !Number.isFinite(e.startedAt)) return false;
  if (typeof e.device !== "object" || e.device === null) return false;
  return true;
}

export class UsageQueue {
  private readonly storage: UsageStorage;
  private readonly cap: number;
  private items: UsageEvent[];

  constructor(storage: UsageStorage, cap: number = USAGE_QUEUE_MAX) {
    this.storage = storage;
    this.cap = Math.max(1, Math.trunc(cap));
    this.items = this.load();
  }

  get size(): number {
    return this.items.length;
  }

  /** 只读快照（测试 / 诊断用）。 */
  snapshot(): UsageEvent[] {
    return this.items.map((item) => ({ ...item, device: { ...item.device } }));
  }

  /** 追加到队尾；超过上限时丢最旧的。返回是否发生了丢弃。 */
  enqueue(event: UsageEvent): boolean {
    this.items.push(event);
    let dropped = false;
    while (this.items.length > this.cap) {
      this.items.shift();
      dropped = true;
      this.noteDropped();
    }
    this.persist();
    return dropped;
  }

  /** 队头（最早的一条）；空队列返回 null。 */
  head(): UsageEvent | null {
    return this.items.length > 0 ? this.items[0] : null;
  }

  /**
   * 按 clientEventId 删除已成功上报的记录。
   * 用 clientEventId 而不是下标：即使队列在发送期间被追加，也不会删错。
   */
  remove(clientEventId: string): void {
    const before = this.items.length;
    this.items = this.items.filter((item) => item.clientEventId !== clientEventId);
    if (this.items.length !== before) {
      this.persist();
    }
  }

  clear(): void {
    this.items = [];
    this.persist();
  }

  /** 累计丢弃条数（溢出保护的可观测证据）。 */
  droppedCount(): number {
    const raw = this.storage.get(USAGE_QUEUE_DROPPED_STORAGE_KEY);
    if (raw === null) return 0;
    const value = Number.parseInt(raw, 10);
    return Number.isFinite(value) && value >= 0 ? value : 0;
  }

  private noteDropped(): void {
    this.storage.set(USAGE_QUEUE_DROPPED_STORAGE_KEY, String(this.droppedCount() + 1));
  }

  private load(): UsageEvent[] {
    const raw = this.storage.get(USAGE_QUEUE_STORAGE_KEY);
    if (raw === null) return [];
    try {
      const parsed = JSON.parse(raw) as unknown;
      const items =
        typeof parsed === "object" && parsed !== null && Array.isArray((parsed as QueueFile).items)
          ? (parsed as QueueFile).items
          : [];
      // 结构损坏的条目直接丢掉，不让一条坏数据堵死整个补报队列。
      return items.filter(isEvent).slice(-this.cap);
    } catch {
      return [];
    }
  }

  private persist(): void {
    const file: QueueFile = { version: 1, items: this.items };
    this.storage.set(USAGE_QUEUE_STORAGE_KEY, JSON.stringify(file));
  }
}
