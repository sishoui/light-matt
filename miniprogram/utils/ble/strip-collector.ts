/**
 * QueryStrip 的多帧收集器：#25。
 *
 * 一条 QueryStrip(0x12) 的响应是 **seg_count 条 SegmentReport(0x83) + 1 条
 * SegmentListEnd(0x84)**，全部回显同一个 seq（docs/protocol.md §9/§10.1）。
 * 因为「同 seq 多帧」不是 ACK，ack-waiters 接不住，这里按 seq 单独收集。
 *
 * 只做「按 seq 归集 + 收尾」，不碰 wx / BLE 状态机——与 ack-waiters 同层。
 */

import type { SegmentListEnd, SegmentReport } from "../protocol/types";
import { WxCallTimeoutError } from "./wx-promise";

export interface StripQueryResult {
  stripId: number;
  reports: SegmentReport[];
  end: SegmentListEnd;
}

interface PendingQuery {
  stripId: number;
  reports: SegmentReport[];
  resolve: (result: StripQueryResult) => void;
  reject: (err: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class StripQueryCollector {
  private readonly pending = new Map<number, PendingQuery>();

  /** 登记一个 seq 的收集器，等到 SegmentListEnd 收尾；超时 reject。 */
  open(seq: number, stripId: number, timeoutMs: number): Promise<StripQueryResult> {
    const promise = new Promise<StripQueryResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(seq);
        reject(new WxCallTimeoutError("QueryStrip", timeoutMs));
      }, timeoutMs);
      this.pending.set(seq, { stripId, reports: [], resolve, reject, timer });
    });
    // 调用方可能不 await（写失败时先 throw），避免 UnhandledPromiseRejection。
    // 与 AckWaiters 保持同一处理方式。
    promise.catch(() => undefined);
    return promise;
  }

  /** 一条 SegmentReport：归到对应 seq 的收集器。返回 true 表示被消费。 */
  report(seq: number, report: SegmentReport): boolean {
    const query = this.pending.get(seq);
    if (query === undefined) {
      return false;
    }
    /* strip 不符说明 seq 撞车（理论上同连接不会），丢弃这一帧但不收尾。 */
    if (report.stripId !== query.stripId) {
      return false;
    }
    query.reports.push(report);
    return true;
  }

  /** SegmentListEnd：收尾并兑现。返回 true 表示被消费。 */
  listEnd(seq: number, end: SegmentListEnd): boolean {
    const query = this.pending.get(seq);
    if (query === undefined) {
      return false;
    }
    if (end.stripId !== query.stripId) {
      return false;
    }
    clearTimeout(query.timer);
    this.pending.delete(seq);
    query.resolve({ stripId: end.stripId, reports: query.reports, end });
    return true;
  }

  /** 断线 / 销毁：所有等待者一起 reject（沿用 ack-waiters 的语义）。 */
  reset(reason: Error): void {
    for (const query of this.pending.values()) {
      clearTimeout(query.timer);
      query.reject(reason);
    }
    this.pending.clear();
  }

  /** 没有 in-flight 查询（测试可观察）。 */
  get size(): number {
    return this.pending.size;
  }
}
