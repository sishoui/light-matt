/**
 * 协议日志：200 帧环形缓冲。
 *
 * 这是唯一的帧日志来源：console 镜像与（#13 的）日志面板都消费同一份
 * FrameLogEntry，不要各自重新格式化。
 *
 * 开发版每帧把 hex 打到 console（spec §11）。版本判断由调用方传入
 * mirrorToConsole（index.ts 用 wx.getAccountInfoSync 的 envVersion）。
 */

import { commandName } from "../protocol/constants";

export type FrameDirection = "tx" | "rx";

export interface FrameLogEntry {
  id: number;
  ts: number;
  dir: FrameDirection;
  /** 大写、空格分隔。 */
  hex: string;
  command?: number;
  commandName?: string;
  seq?: number;
  /** 人可读的解析结果。 */
  parsed: string;
  ok?: boolean;
}

export interface FrameLogOptions {
  capacity?: number;
  mirrorToConsole?: boolean;
}

const DEFAULT_CAPACITY = 200;

export class FrameLog {
  readonly capacity: number;
  private readonly mirrorToConsole: boolean;
  private readonly entries: FrameLogEntry[] = [];
  private readonly listeners: Array<(entry: FrameLogEntry) => void> = [];
  private nextId = 1;

  constructor(opts: FrameLogOptions = {}) {
    this.capacity = opts.capacity ?? DEFAULT_CAPACITY;
    this.mirrorToConsole = opts.mirrorToConsole ?? false;
  }

  push(entry: Omit<FrameLogEntry, "id">): FrameLogEntry {
    const full: FrameLogEntry = { ...entry, id: this.nextId };
    this.nextId += 1;
    this.entries.push(full);
    if (this.entries.length > this.capacity) {
      this.entries.splice(0, this.entries.length - this.capacity);
    }

    if (this.mirrorToConsole) {
      const arrow = full.dir === "tx" ? "->" : "<-";
      const name = full.command === undefined ? "?" : commandName(full.command);
      console.log(
        `[lumen][${full.dir}] ${arrow} ${full.hex} | ${name}` +
          (full.seq === undefined ? "" : ` seq=${full.seq}`) +
          ` | ${full.parsed}`,
      );
    }

    for (const fn of this.listeners.slice()) {
      try {
        fn(full);
      } catch {
        /* 监听者异常不能影响协议路径 */
      }
    }
    return full;
  }

  /** 旧 → 新。 */
  snapshot(): FrameLogEntry[] {
    return this.entries.slice();
  }

  clear(): void {
    this.entries.length = 0;
  }

  onAppend(fn: (entry: FrameLogEntry) => void): () => void {
    this.listeners.push(fn);
    return () => {
      const index = this.listeners.indexOf(fn);
      if (index >= 0) {
        this.listeners.splice(index, 1);
      }
    };
  }
}
