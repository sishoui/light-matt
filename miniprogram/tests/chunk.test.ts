/**
 * BLE 分片与重组（#40）：chunkFrame / ChunkAssembler。
 *
 * 覆盖票面验收的边界：
 *  - 恰好 179 / 180 字节（数据容量 19 / 跨 2 片）；
 *  - 跨 2 片 / 跨 3 片；
 *  - MTU 未知 ⇒ 20 字节容量，功能不降级；
 *  - FIRST 重入丢弃旧缓冲（latest-wins）；
 *  - 重组超时 1000ms 丢弃；
 *  - 累计超过 240 丢弃（回 BadLength）。
 *
 * ctrl 头语义见 docs/protocol-v3.md §3.2。
 */

import { describe, expect, it } from "vitest";

import {
  chunkCapacityForMtu,
  chunkDataCapacity,
  chunkFrame,
  ChunkAssembler,
  normalizeChunkCapacity,
} from "../utils/protocol/chunk";
import { bytesToCompactHex } from "../utils/protocol/hex";
import {
  ASSEMBLY_TIMEOUT_MS,
  CHUNK_FIRST,
  CHUNK_LAST,
  DEFAULT_CHUNK_CAPACITY,
  MAX_CHUNK_CAPACITY,
  MAX_CHUNK_DATA,
  MAX_FRAME_BYTES,
} from "../utils/protocol/constants";

function bytes(length: number, fill = 0x5a): Uint8Array {
  return new Uint8Array(length).fill(fill);
}

describe("分片容量换算（§2.1）", () => {
  it("MTU 未知按 23（容量 20），数据 19 字节", () => {
    expect(chunkCapacityForMtu(null)).toBe(DEFAULT_CHUNK_CAPACITY);
    expect(chunkCapacityForMtu(undefined)).toBe(DEFAULT_CHUNK_CAPACITY);
    expect(chunkCapacityForMtu(Number.NaN)).toBe(DEFAULT_CHUNK_CAPACITY);
    expect(chunkDataCapacity(null)).toBe(19);
  });

  it("MTU 23 / 185 / 247 分别推出 20 / 180（钳位）/ 180（钳位）", () => {
    expect(chunkCapacityForMtu(23)).toBe(20);
    expect(chunkCapacityForMtu(185)).toBe(180);
    expect(chunkCapacityForMtu(247)).toBe(MAX_CHUNK_CAPACITY);
  });

  it("容量下限 20、上限 180（越界值被钳住，不会切出 0 长度数据）", () => {
    expect(normalizeChunkCapacity(0)).toBe(20);
    expect(normalizeChunkCapacity(3)).toBe(20);
    expect(normalizeChunkCapacity(1000)).toBe(MAX_CHUNK_CAPACITY);
    expect(chunkDataCapacity(MAX_CHUNK_CAPACITY)).toBe(MAX_CHUNK_DATA);
  });
});

describe("chunkFrame", () => {
  it("单分片：ctrl = FIRST|LAST = 0xC0，数据原样", () => {
    const frame = bytes(9, 0xa6);
    const chunks = chunkFrame(frame, 180);
    expect(chunks).toHaveLength(1);
    expect(chunks[0][0]).toBe(CHUNK_FIRST | CHUNK_LAST);
    expect(bytesToCompactHex(chunks[0].subarray(1))).toBe(bytesToCompactHex(frame));
  });

  it("恰好 19 字节：仍是一片（数据容量 19）", () => {
    const chunks = chunkFrame(bytes(19), 20);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].length).toBe(20);
  });

  it("恰好 20 字节：跨 2 片（19 + 1），首片 FIRST、次片 LAST", () => {
    const chunks = chunkFrame(bytes(20), 20);
    expect(chunks).toHaveLength(2);
    expect(chunks[0][0]).toBe(CHUNK_FIRST | 0);
    expect(chunks[0].length).toBe(20);
    expect(chunks[1][0]).toBe(CHUNK_LAST | 1);
    expect(chunks[1].length).toBe(2);
  });

  it("179 字节：跨 10 片，最后一片序号 9 且带 LAST", () => {
    const chunks = chunkFrame(bytes(179), 20);
    expect(chunks).toHaveLength(10);
    expect(chunks[0][0]).toBe(CHUNK_FIRST);
    expect(chunks[9][0]).toBe(CHUNK_LAST | 9);
    expect(chunks.slice(0, 9).every((c) => c.length === 20)).toBe(true);
    expect(chunks[9].length).toBe(1 + (179 - 9 * 19));
  });

  it("恰好 179 字节（= 单次写数据上限，cap 180）：一片装下", () => {
    const chunks = chunkFrame(bytes(179), 180);
    expect(chunks).toHaveLength(1);
    expect(chunks[0][0]).toBe(CHUNK_FIRST | CHUNK_LAST);
    expect(chunks[0].length).toBe(180);
    expect(MAX_CHUNK_DATA).toBe(179);
  });

  it("跨 2 片与跨 3 片（cap 180）", () => {
    const two = chunkFrame(bytes(179 + 1), 180);
    expect(two).toHaveLength(2);
    expect(two[1][0]).toBe(CHUNK_LAST | 1);

    const three = chunkFrame(bytes(179 * 2 + 1), 180);
    expect(three).toHaveLength(3);
    expect(three[2][0]).toBe(CHUNK_LAST | 2);
  });

  it("180 字节（cap 180，数据上限 179）：跨 2 片 179 + 1", () => {
    const chunks = chunkFrame(bytes(180), 180);
    expect(chunks).toHaveLength(2);
    expect(chunks[0].length).toBe(180);
    expect(chunks[1].length).toBe(2);
    expect(chunks[1][0]).toBe(CHUNK_LAST | 1);
  });

  it("240 字节（整帧上限，cap 180）：跨 2 片 179 + 61", () => {
    const chunks = chunkFrame(bytes(MAX_FRAME_BYTES), 180);
    expect(chunks).toHaveLength(2);
    expect(chunks[0].length).toBe(180);
    expect(chunks[1].length).toBe(1 + (240 - 179));
    expect(chunks[1][0]).toBe(CHUNK_LAST | 1);
  });

  it("240 字节在 MTU 23 下分 13 片（数据 19）", () => {
    const chunks = chunkFrame(bytes(MAX_FRAME_BYTES), 20);
    expect(chunks).toHaveLength(Math.ceil(240 / 19));
    expect(chunks[chunks.length - 1][0]).toBe(CHUNK_LAST | (chunks.length - 1));
  });

  it("空帧也产出 1 片（不允许 0 片，否则 ACK 永远等不到）", () => {
    const chunks = chunkFrame(new Uint8Array(0), 20);
    expect(chunks).toHaveLength(1);
    expect(chunks[0][0]).toBe(CHUNK_FIRST | CHUNK_LAST);
    expect(chunks[0].length).toBe(1);
  });

  it("序号按 6 位回绕（64 片后从 0 重新计）", () => {
    /* 64 × 19 = 1216 字节，超过帧上限也没关系：chunkFrame 只负责切。 */
    const chunks = chunkFrame(bytes(64 * 19 + 19), 20);
    expect(chunks).toHaveLength(65);
    expect(chunks[63][0] & 0x3f).toBe(63);
    expect(chunks[64][0] & 0x3f).toBe(0);
  });
});

describe("ChunkAssembler", () => {
  it("逐片拼回原始字节（跨 3 片）", () => {
    const frame = bytes(45, 0xa6);
    const assembler = new ChunkAssembler();
    let result = assembler.push(chunkFrame(frame, 20)[0]);
    expect(result.kind).toBe("incomplete");
    result = assembler.push(chunkFrame(frame, 20)[1]);
    expect(result.kind).toBe("incomplete");
    result = assembler.push(chunkFrame(frame, 20)[2]);
    expect(result.kind).toBe("frame");
    if (result.kind === "frame") {
      expect(bytesToCompactHex(result.frame)).toBe(bytesToCompactHex(frame));
    }
    expect(assembler.pending).toBe(false);
  });

  it("单分片（FIRST|LAST）立即交出", () => {
    const frame = bytes(9, 0x11);
    const assembler = new ChunkAssembler();
    const result = assembler.push(chunkFrame(frame, 180)[0]);
    expect(result.kind).toBe("frame");
    if (result.kind === "frame") {
      expect(result.frame.length).toBe(9);
    }
  });

  it("FIRST 重入丢弃旧缓冲（latest-wins）", () => {
    const assembler = new ChunkAssembler();
    const first = bytes(30, 0x01);
    const second = bytes(30, 0x02);
    assembler.push(chunkFrame(first, 20)[0]); /* 半个旧帧 */
    expect(assembler.size).toBe(19);
    const result = assembler.push(chunkFrame(second, 20)[0]);
    expect(result.kind).toBe("incomplete");
    /* 旧缓冲已被丢弃，只剩新帧的首片。 */
    expect(assembler.size).toBe(19);
  });

  it("没有 FIRST 的续片被丢弃（orphan），不拼出可疑帧", () => {
    const assembler = new ChunkAssembler();
    const result = assembler.push(new Uint8Array([CHUNK_LAST | 1, 0xa6, 0x03]));
    expect(result.kind).toBe("error");
    if (result.kind === "error") expect(result.reason).toBe("orphan");
    expect(assembler.pending).toBe(false);
  });

  it("累计超过 240 字节 → overflow（对应 BadLength），并清空缓冲", () => {
    const assembler = new ChunkAssembler();
    /* 13 片 × 19 = 247 > 240。 */
    const frame = bytes(247);
    const chunks = chunkFrame(frame, 20);
    let overflow = false;
    for (const chunk of chunks) {
      const result = assembler.push(chunk);
      if (result.kind === "error") {
        expect(result.reason).toBe("overflow");
        overflow = true;
        break;
      }
    }
    expect(overflow).toBe(true);
    expect(assembler.pending).toBe(false);
  });

  it("恰好 240 字节不触发 overflow", () => {
    const assembler = new ChunkAssembler();
    let last: ReturnType<ChunkAssembler["push"]> | null = null;
    for (const chunk of chunkFrame(bytes(MAX_FRAME_BYTES), 20)) {
      last = assembler.push(chunk);
    }
    expect(last?.kind).toBe("frame");
  });

  it("超时（> 1000ms）丢弃旧缓冲，后续续片被当成 orphan", () => {
    let now = 0;
    const assembler = new ChunkAssembler({ now: () => now });
    /* 30 字节 = 首片 19 + 次片 11（次片带 LAST）。 */
    const chunks = chunkFrame(bytes(30), 20);

    assembler.push(chunks[0]);
    now += ASSEMBLY_TIMEOUT_MS - 1;
    /* 仍在超时窗口内：续片正常收尾。 */
    const withinWindow = assembler.push(chunks[1]);
    expect(withinWindow.kind).toBe("frame");

    /* 再来一次：这次跨过超时点，旧缓冲被丢弃。 */
    now += ASSEMBLY_TIMEOUT_MS + 1;
    assembler.push(chunks[0]);
    now += ASSEMBLY_TIMEOUT_MS + 1;
    const afterTimeout = assembler.push(new Uint8Array([CHUNK_LAST | 1, 0x01]));
    expect(afterTimeout.kind).toBe("error");
    if (afterTimeout.kind === "error") expect(afterTimeout.reason).toBe("orphan");
  });

  it("超时后新的 FIRST 正常开始（旧缓冲已清空）", () => {
    let now = 0;
    const assembler = new ChunkAssembler({ now: () => now });
    assembler.push(chunkFrame(bytes(30), 20)[0]);
    now += ASSEMBLY_TIMEOUT_MS + 1;
    const frame = bytes(10);
    const result = assembler.push(chunkFrame(frame, 180)[0]);
    expect(result.kind).toBe("frame");
  });

  it("空分片报错并清空", () => {
    const assembler = new ChunkAssembler();
    assembler.push(chunkFrame(bytes(30), 20)[0]);
    const result = assembler.push(new Uint8Array(0));
    expect(result.kind).toBe("error");
    if (result.kind === "error") expect(result.reason).toBe("empty");
    expect(assembler.pending).toBe(false);
  });

  it("reset 清空缓冲（断线 / 销毁路径）", () => {
    const assembler = new ChunkAssembler();
    assembler.push(chunkFrame(bytes(30), 20)[0]);
    expect(assembler.pending).toBe(true);
    assembler.reset();
    expect(assembler.pending).toBe(false);
    expect(assembler.size).toBe(0);
  });
});
