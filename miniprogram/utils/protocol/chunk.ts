/**
 * BLE 分片与重组（纯函数/纯状态机，不依赖 wx.*，可在 node 里单测）。
 *
 * 契约见 docs/protocol-v3.md §3.2：
 *  - 每次 write / notify 都带 1 字节 ctrl 头：bit7 FIRST、bit6 LAST、bit5-0 序号；
 *  - 不分片的帧也必须带 ctrl（FIRST|LAST = 0xC0），不允许裸帧；
 *  - 数据上限 = chunk_capacity − 1（分片头占 1 字节），capacity 未知按 20；
 *  - 重组：FIRST 重入丢弃旧缓冲（latest-wins）；累计超过 240 丢弃并报错；
 *    LAST 时交出完整逻辑帧；超时 1000ms 丢弃且不回复（seq 已不可靠）。
 *
 * 这里刻意不碰「解帧」：重组只交出字节，信封校验由 frame.ts 负责，
 * 这样两端的错误码映射（BadMagic / BadCRC …）仍集中在命令层。
 */

import {
  ASSEMBLY_TIMEOUT_MS,
  CHUNK_FIRST,
  CHUNK_INDEX_MASK,
  CHUNK_LAST,
  DEFAULT_CHUNK_CAPACITY,
  MAX_CHUNK_CAPACITY,
  MAX_FRAME_BYTES,
} from "./constants";

/** capacity 归一化：未知/过小按 20，过大按 180（§2.1 的下限与上限）。 */
export function normalizeChunkCapacity(capacity: number | null | undefined): number {
  if (capacity === null || capacity === undefined || !Number.isFinite(capacity)) {
    return DEFAULT_CHUNK_CAPACITY;
  }
  const value = Math.floor(capacity);
  if (value < DEFAULT_CHUNK_CAPACITY) {
    return DEFAULT_CHUNK_CAPACITY;
  }
  return value > MAX_CHUNK_CAPACITY ? MAX_CHUNK_CAPACITY : value;
}

/** 由 ATT MTU 推出单次写上限：`chunk_capacity = min(mtu − 3, 180)`（§2.1）。 */
export function chunkCapacityForMtu(mtu: number | null | undefined): number {
  if (mtu === null || mtu === undefined || !Number.isFinite(mtu)) {
    return DEFAULT_CHUNK_CAPACITY;
  }
  return normalizeChunkCapacity(Math.floor(mtu) - 3);
}

/** 单次写的数据上限（分片头占 1 字节）。 */
export function chunkDataCapacity(capacity: number | null | undefined): number {
  return normalizeChunkCapacity(capacity) - 1;
}

/**
 * 把一条逻辑帧切成写序列。单分片时 ctrl = 0xC0。
 *
 * 序号按 6 位回绕（0-63），仅用于诊断，接收端不作连续性要求。
 */
export function chunkFrame(
  frame: Uint8Array,
  capacity: number | null | undefined,
): Uint8Array[] {
  const dataCapacity = chunkDataCapacity(capacity);
  const chunks: Uint8Array[] = [];
  const total = frame.length;
  const count = Math.max(1, Math.ceil(total / dataCapacity));
  for (let i = 0; i < count; i += 1) {
    const start = i * dataCapacity;
    const end = Math.min(start + dataCapacity, total);
    const chunk = new Uint8Array(1 + (end - start));
    let ctrl = (i & CHUNK_INDEX_MASK) & ~(CHUNK_FIRST | CHUNK_LAST);
    if (i === 0) {
      ctrl |= CHUNK_FIRST;
    }
    if (i === count - 1) {
      ctrl |= CHUNK_LAST;
    }
    chunk[0] = ctrl;
    chunk.set(frame.subarray(start, end), 1);
    chunks.push(chunk);
  }
  return chunks;
}

/** 单次 push 的判定结果：还要更多分片 / 一条完整逻辑帧 / 丢弃。 */
export type ChunkResult =
  | { kind: "incomplete" }
  | { kind: "frame"; frame: Uint8Array }
  | { kind: "error"; reason: "empty" | "orphan" | "overflow" };

export interface ChunkAssemblerOptions {
  /** 重组超时（自上一个分片起算）；默认 1000ms。 */
  timeoutMs?: number;
  /** 注入时钟（测试用）；默认 Date.now。 */
  now?: () => number;
}

/**
 * 设备 → 小程序的入站重组缓冲。
 *
 * 不是「流」而是「一问一答」：一次只有一条逻辑帧在途，所以单一缓冲足够。
 * 任何异常都清空缓冲——宁可丢一帧（等 ACK 超时重试），也不要拼接出错误帧。
 */
export class ChunkAssembler {
  private readonly timeoutMs: number;
  private readonly now: () => number;
  private buffer: number[] = [];
  private lastAt = 0;

  constructor(opts: ChunkAssemblerOptions = {}) {
    this.timeoutMs = opts.timeoutMs ?? ASSEMBLY_TIMEOUT_MS;
    this.now = opts.now ?? (() => Date.now());
  }

  /** 是否有未完成的重组（测试与日志可观察）。 */
  get pending(): boolean {
    return this.buffer.length > 0;
  }

  /** 当前缓冲长度（测试可观察）。 */
  get size(): number {
    return this.buffer.length;
  }

  /** 清空缓冲（断线 / 销毁 / 重置）。 */
  reset(): void {
    this.buffer = [];
    this.lastAt = 0;
  }

  /**
   * 喂一个分片。
   *
   * 返回 `frame` 时缓冲已清空；返回 `error` 时同样已清空（调用方按 §5 回结果码，
   * 超时则静默丢弃——两种都在这里把状态收干净）。
   */
  push(bytes: Uint8Array): ChunkResult {
    if (bytes.length === 0) {
      this.reset();
      return { kind: "error", reason: "empty" };
    }

    const now = this.now();
    /* 超时：自上一个分片起算。丢弃旧缓冲，不回复（§3.2 第 4 条）。 */
    if (this.buffer.length > 0 && now - this.lastAt > this.timeoutMs) {
      this.reset();
    }

    const ctrl = bytes[0] & 0xff;
    const isFirst = (ctrl & CHUNK_FIRST) !== 0;
    const isLast = (ctrl & CHUNK_LAST) !== 0;
    const data = bytes.subarray(1);

    if (isFirst) {
      /* FIRST 重入：已有缓冲就丢弃重新开始（latest-wins）。 */
      this.buffer = [];
    } else if (this.buffer.length === 0) {
      /* 没有 FIRST 的续片：无法拼出可信的帧，丢弃且不回复。 */
      return { kind: "error", reason: "orphan" };
    }

    for (let i = 0; i < data.length; i += 1) {
      this.buffer.push(data[i] & 0xff);
    }
    this.lastAt = now;

    if (this.buffer.length > MAX_FRAME_BYTES) {
      /* 累计超过 240：协议要求丢弃并回 BadLength（§3.2 第 2 条）。 */
      this.reset();
      return { kind: "error", reason: "overflow" };
    }

    if (!isLast) {
      return { kind: "incomplete" };
    }

    const frame = Uint8Array.from(this.buffer);
    this.reset();
    return { kind: "frame", frame };
  }
}
