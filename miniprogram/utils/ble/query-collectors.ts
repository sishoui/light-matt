/**
 * QueryLayout / QueryScene 的多帧收集器（v5）。
 *
 * - `QueryLayout(0x24)` 的响应是 **逐部位 LayoutReport(0x89) + 1 条
 *   LayoutListEnd(0x8A)**，全部回显同一个 seq（docs/protocol-v5.md §7.2 / §8）。
 * - `QueryScene(0x29)` 的响应是 **逐部位 ScenePartReport(0x8B) + 每步
 *   SceneStepReport(0x8C) + 1 条 SceneListEnd(0x8D)**，同样回显同一个 seq。
 *
 * 「同 seq 多帧」不是 ACK，ack-waiters 接不住，这里按 seq 单独收集。
 * 本收集器只做「按 seq 归集 + 收尾」，不碰 wx / BLE 状态机——与
 * ack-waiters 同层。
 */

import type {
  LayoutListEnd,
  LayoutReport,
  SceneListEnd,
  ScenePartReport,
  SceneStepReport,
} from "../protocol/types";
import { WxCallTimeoutError } from "./wx-promise";

export interface LayoutQueryResult {
  stripId: number;
  reports: LayoutReport[];
  end: LayoutListEnd;
}

export interface SceneQueryResult {
  sceneId: number;
  parts: ScenePartReport[];
  steps: SceneStepReport[];
  end: SceneListEnd;
}

interface PendingLayout {
  stripId: number;
  reports: LayoutReport[];
  resolve: (result: LayoutQueryResult) => void;
  reject: (err: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface PendingScene {
  sceneId: number;
  parts: ScenePartReport[];
  steps: SceneStepReport[];
  resolve: (result: SceneQueryResult) => void;
  reject: (err: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class LayoutQueryCollector {
  private readonly pending = new Map<number, PendingLayout>();

  /**
   * 登记一个 seq 的收集器，等到 LayoutListEnd 收尾；超时 reject。
   *
   * `stripId` 只是回执里的元信息，不参与匹配——匹配靠 seq（§8：一次只发一帧）。
   */
  open(seq: number, stripId: number, timeoutMs: number): Promise<LayoutQueryResult> {
    const promise = new Promise<LayoutQueryResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(seq);
        reject(new WxCallTimeoutError("QueryLayout", timeoutMs));
      }, timeoutMs);
      this.pending.set(seq, { stripId, reports: [], resolve, reject, timer });
    });
    promise.catch(() => undefined);
    return promise;
  }

  report(seq: number, report: LayoutReport): void {
    const pending = this.pending.get(seq);
    if (pending !== undefined) {
      pending.reports.push(report);
    }
  }

  listEnd(seq: number, end: LayoutListEnd): void {
    const pending = this.pending.get(seq);
    if (pending === undefined) {
      return;
    }
    this.pending.delete(seq);
    clearTimeout(pending.timer);
    pending.resolve({ stripId: pending.stripId, reports: pending.reports, end });
  }

  /** 丢弃某个 seq（ACK 非零 / 写失败 / 断线时调用，避免悬挂 Promise）。 */
  reset(seq?: number, reason?: unknown): void {
    const targets = seq === undefined ? [...this.pending.keys()] : [seq];
    for (const key of targets) {
      const pending = this.pending.get(key);
      if (pending === undefined) {
        continue;
      }
      this.pending.delete(key);
      clearTimeout(pending.timer);
      pending.reject(reason ?? new Error("QueryLayout 已取消"));
    }
  }
}

export class SceneQueryCollector {
  private readonly pending = new Map<number, PendingScene>();

  open(seq: number, sceneId: number, timeoutMs: number): Promise<SceneQueryResult> {
    const promise = new Promise<SceneQueryResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(seq);
        reject(new WxCallTimeoutError("QueryScene", timeoutMs));
      }, timeoutMs);
      this.pending.set(seq, { sceneId, parts: [], steps: [], resolve, reject, timer });
    });
    promise.catch(() => undefined);
    return promise;
  }

  partReport(seq: number, report: ScenePartReport): void {
    const pending = this.pending.get(seq);
    if (pending !== undefined) {
      pending.parts.push(report);
    }
  }

  stepReport(seq: number, report: SceneStepReport): void {
    const pending = this.pending.get(seq);
    if (pending !== undefined) {
      pending.steps.push(report);
    }
  }

  listEnd(seq: number, end: SceneListEnd): void {
    const pending = this.pending.get(seq);
    if (pending === undefined) {
      return;
    }
    this.pending.delete(seq);
    clearTimeout(pending.timer);
    pending.resolve({
      sceneId: pending.sceneId,
      parts: pending.parts,
      steps: pending.steps,
      end,
    });
  }

  reset(seq?: number, reason?: unknown): void {
    const targets = seq === undefined ? [...this.pending.keys()] : [seq];
    for (const key of targets) {
      const pending = this.pending.get(key);
      if (pending === undefined) {
        continue;
      }
      this.pending.delete(key);
      clearTimeout(pending.timer);
      pending.reject(reason ?? new Error("QueryScene 已取消"));
    }
  }
}
