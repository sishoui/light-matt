/**
 * codec 测试：直接消费仓库里 docs/protocol-testvectors-v4.json（两端共用同一份）。
 *
 * 不复制向量、不伪造期望值：任何协议字节变化都会让这里失败。
 *
 * v4 覆盖：68 条向量（编码 / 解码两个方向）、CRC16 标准校验值、分片重组、
 * 层亮度三档（0 / 50 / 100）与越界用例，以及 232/240 的帧长上限。
 *
 * **这是跨端契约**：固件 host 测试跑同一份 JSON。这里红了就说明小程序与固件
 * 对字节的理解已经不一致。
 */

import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { bytesToCompactHex, hexToBytes } from "../utils/protocol/hex";
import { crc16, decodeFrame, encodeFrame, FrameTooLongError } from "../utils/protocol/frame";
import { chunkFrame, ChunkAssembler } from "../utils/protocol/chunk";
import { MAX_FRAME_BYTES, MAX_PAYLOAD_BYTES } from "../utils/protocol/constants";

interface VectorCase {
  name: string;
  direction: "app_to_device" | "device_to_app";
  command: number;
  command_name?: string;
  seq: number;
  payload_hex: string;
  payload_len: number;
  frame_hex: string;
  frame_len: number;
  chunks_hex: string[];
  frame_valid: boolean;
  result_code: number;
  note?: string;
  chunk_count?: number;
  chunk_capacity?: number;
}

interface VectorFile {
  protocol_version: number;
  magic: string;
  state_bytes: number;
  state_read_example_hex: string;
  cases: VectorCase[];
}

const vectors: VectorFile = JSON.parse(
  readFileSync(new URL("../../docs/protocol-testvectors-v4.json", import.meta.url), "utf8"),
);

function payloadOf(c: VectorCase): Uint8Array {
  const bytes = hexToBytes(c.payload_hex);
  expect(bytes).not.toBeNull();
  return bytes as Uint8Array;
}

/**
 * result_code → decodeFrame 的失败原因（§5 的固定校验顺序）。
 *
 * 只有**信封层**的结果码会在这里出现：0x01/0x02/0x0A 是「信封合法、语义被拒」，
 * 字节层必须接受它们（拒绝是命令层 / 设备的事）。
 */
const ENVELOPE_FAILURES: Record<number, string> = {
  0x03: "crc",
  0x04: "length",
  0x07: "version",
  0x08: "magic",
};

describe("协议测试向量（v4）", () => {
  it("向量文件本身是 v4 且包含 94 个用例（新增 blend=3 的两层向量）", () => {
    expect(vectors.protocol_version).toBe(4);
    expect(vectors.magic).toBe("0xA6");
    expect(vectors.state_bytes).toBe(37);
    expect(vectors.cases.length).toBe(94);
  });

  it("app_to_device 有效帧：encode 逐字节复现 frame_hex", () => {
    const cases = vectors.cases.filter((c) => c.direction === "app_to_device" && c.frame_valid);
    expect(cases.length).toBeGreaterThan(0);
    for (const c of cases) {
      const frame = encodeFrame(c.command, c.seq, payloadOf(c));
      expect(bytesToCompactHex(frame), c.name).toBe(c.frame_hex.toUpperCase());
      /* 整帧 = 8 + payload（16 位长度字段）。 */
      expect(frame.length, c.name).toBe(c.payload_len + 8);
      expect(frame[4] | (frame[5] << 8), c.name).toBe(c.payload_len);
    }
  });

  it("app_to_device 有效帧：decode 还原 command / seq / payload", () => {
    const cases = vectors.cases.filter((c) => c.direction === "app_to_device" && c.frame_valid);
    for (const c of cases) {
      const bytes = hexToBytes(c.frame_hex) as Uint8Array;
      const result = decodeFrame(bytes);
      expect(result.ok, c.name).toBe(true);
      if (!result.ok) continue;
      expect(result.command, c.name).toBe(c.command);
      expect(result.seq, c.name).toBe(c.seq);
      expect(bytesToCompactHex(result.payload), c.name).toBe(c.payload_hex.toUpperCase());
    }
  });

  it("信封层无效帧：decode 返回与 result_code 对应的失败原因", () => {
    const cases = vectors.cases.filter(
      (c) => c.direction === "app_to_device" && ENVELOPE_FAILURES[c.result_code] !== undefined,
    );
    expect(cases.length).toBe(4);
    /* 坏版本用例带的是非 0x04 的版本字节：decode 必须先判版本、再判 CRC（§4）。 */
    const badVersion = cases.find((c) => c.result_code === 0x07);
    expect(badVersion, "bad_version").toBeDefined();
    expect((badVersion as VectorCase).frame_hex.slice(2, 4).toUpperCase()).not.toBe("04");
    for (const c of cases) {
      const bytes = hexToBytes(c.frame_hex) as Uint8Array;
      const result = decodeFrame(bytes);
      expect(result.ok, c.name).toBe(false);
      if (result.ok) continue;
      expect(result.reason, c.name).toBe(ENVELOPE_FAILURES[c.result_code]);
    }
  });

  it("语义被拒的帧在字节层仍然合法（退役命令 / 参数越界 / 剧本过大）", () => {
    const cases = vectors.cases.filter(
      (c) =>
        c.direction === "app_to_device" &&
        !c.frame_valid &&
        ENVELOPE_FAILURES[c.result_code] === undefined,
    );
    expect(cases.length).toBeGreaterThan(0);
    for (const c of cases) {
      const result = decodeFrame(hexToBytes(c.frame_hex) as Uint8Array);
      expect(result.ok, c.name).toBe(true);
      if (result.ok) {
        expect(result.command, c.name).toBe(c.command);
        expect(bytesToCompactHex(result.payload), c.name).toBe(c.payload_hex.toUpperCase());
      }
    }
  });

  it("device_to_app 帧：decode 成功且能用同一编码器复现", () => {
    const cases = vectors.cases.filter((c) => c.direction === "device_to_app");
    expect(cases.length).toBeGreaterThan(0);
    for (const c of cases) {
      const bytes = hexToBytes(c.frame_hex) as Uint8Array;
      const result = decodeFrame(bytes);
      expect(result.ok, c.name).toBe(true);
      if (!result.ok) continue;
      expect(result.command, c.name).toBe(c.command);
      expect(result.seq, c.name).toBe(c.seq);
      expect(bytesToCompactHex(result.payload), c.name).toBe(c.payload_hex.toUpperCase());

      const reencoded = encodeFrame(result.command, result.seq, result.payload);
      expect(bytesToCompactHex(reencoded), c.name).toBe(c.frame_hex.toUpperCase());
    }
  });

  it("每条向量都被覆盖（decode 的 ok 与 frame_valid 一致）", () => {
    const appValid = vectors.cases.filter((c) => c.direction === "app_to_device" && c.frame_valid);
    const appInvalid = vectors.cases.filter((c) => c.direction === "app_to_device" && !c.frame_valid);
    const device = vectors.cases.filter((c) => c.direction === "device_to_app");
    expect(appValid.length + appInvalid.length + device.length).toBe(vectors.cases.length);

    for (const c of vectors.cases) {
      const result = decodeFrame(hexToBytes(c.frame_hex) as Uint8Array);
      /* frame_valid 表示设备是否**业务接受**；信封层只在 4 个坏帧上失败。 */
      const envelopeValid = ENVELOPE_FAILURES[c.result_code] === undefined;
      expect(result.ok, c.name).toBe(envelopeValid);
    }
  });

  it("分片：向量里的 chunks_hex 能被 chunkFrame 逐字节复现并重组回逻辑帧", () => {
    const cases = vectors.cases.filter((c) => c.chunks_hex.length > 0);
    expect(cases.length).toBe(vectors.cases.length);
    for (const c of cases) {
      const capacity = c.chunk_capacity ?? 180;
      const frame = hexToBytes(c.frame_hex) as Uint8Array;
      const chunks = chunkFrame(frame, capacity);
      expect(chunks.map((chunk) => bytesToCompactHex(chunk)), c.name).toEqual(
        c.chunks_hex.map((hex) => hex.toUpperCase()),
      );

      const assembler = new ChunkAssembler();
      let assembled: Uint8Array | null = null;
      for (const chunk of chunks) {
        const result = assembler.push(chunk);
        if (result.kind === "frame") {
          assembled = result.frame;
        }
      }
      expect(assembled, c.name).not.toBeNull();
      expect(bytesToCompactHex(assembled as Uint8Array), c.name).toBe(c.frame_hex.toUpperCase());
    }
  });

  it("坏 CRC 帧不能通过（即使 payload 完全相同）", () => {
    const good = encodeFrame(0x01, 0x01, [0x01]);
    const bad = good.slice();
    bad[bad.length - 1] ^= 0xff;
    const result = decodeFrame(bad);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("crc");
  });
});

describe("CRC16（CCITT-FALSE）", () => {
  it('标准校验值 "123456789" → 0x29B1', () => {
    const bytes = new Uint8Array(Buffer.from("123456789", "ascii"));
    expect(crc16(bytes)).toBe(0x29b1);
  });

  it("空输入返回初值 0xFFFF", () => {
    expect(crc16(new Uint8Array(0))).toBe(0xffff);
  });

  it("与协议 §3.3 的示例帧一致（SetPower(on)，seq=1 → 0x68B1）", () => {
    /* A6 04 01 01 01 00 01 的 CRC16 = 0x68B1，小端存 68 B1。 */
    const covered = hexToBytes("A6 04 01 01 01 00 01") as Uint8Array;
    expect(crc16(covered)).toBe(0x68b1);
  });

  it("CRC 覆盖 magic 到 payload 末字节（改 payload 会变）", () => {
    const a = hexToBytes("A6 04 01 01 01 00 01") as Uint8Array;
    const b = hexToBytes("A6 04 01 01 01 00 00") as Uint8Array;
    expect(crc16(a)).not.toBe(crc16(b));
  });
});

describe("encode 边界（v4：载荷 232 / 整帧 240）", () => {
  it("232 字节 payload 恰好 240 字节，不抛错且可解码", () => {
    const payload = new Uint8Array(MAX_PAYLOAD_BYTES);
    const frame = encodeFrame(0x7f, 1, payload);
    expect(frame.length).toBe(MAX_FRAME_BYTES);
    expect(frame[4] | (frame[5] << 8)).toBe(MAX_PAYLOAD_BYTES);
    expect(decodeFrame(frame).ok).toBe(true);
  });

  it("233 字节 payload 抛 FrameTooLongError，绝不截断", () => {
    let thrown: unknown = null;
    try {
      encodeFrame(0x7f, 1, new Uint8Array(MAX_PAYLOAD_BYTES + 1));
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(FrameTooLongError);
    const error = thrown as FrameTooLongError;
    expect(error.payloadLength).toBe(MAX_PAYLOAD_BYTES + 1);
    expect(error.frameLength).toBe(MAX_FRAME_BYTES + 1);
  });

  it("16 位长度字段：200 字节载荷写出 C8 00（不是单字节截断）", () => {
    const frame = encodeFrame(0x7f, 1, new Uint8Array(200));
    expect(frame.length).toBe(208);
    expect(frame[4]).toBe(0xc8);
    expect(frame[5]).toBe(0x00);
    expect(decodeFrame(frame).ok).toBe(true);
  });

  it("command / seq 按 0xFF 掩码", () => {
    const frame = encodeFrame(0x1ff, 0x101, []);
    expect(frame[2]).toBe(0xff);
    expect(frame[3]).toBe(0x01);
  });

  it("空 payload 的帧长度为 8（6 字节头 + 2 字节 CRC）", () => {
    expect(encodeFrame(0x05, 0x09).length).toBe(8);
  });

  it("短于 8 字节的输入返回 short（不是 magic）", () => {
    const result = decodeFrame(new Uint8Array([0xa6, 0x04, 0x01]));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("short");
  });
});

describe("v4 状态示例", () => {
  it("state_read_example_hex 是 37 字节且能按 v4 布局解析", async () => {
    const { parseState } = await import("../utils/protocol/commands");
    const bytes = hexToBytes(vectors.state_read_example_hex) as Uint8Array;
    expect(bytes.length).toBe(37);
    const state = parseState(bytes);
    expect(state.power).toBe(1);
    expect(state.brightness).toBe(128);
    expect(state.stripCount).toBe(2);
    expect(state.stripPowerMask).toBe(0x03);
    expect(state.stripCounts.slice(0, 2)).toEqual([30, 60]);
    expect(state.stripSegCounts.slice(0, 2)).toEqual([2, 4]);
    /* 派生字段与 strip 0 一致。 */
    expect(state.ledCount).toBe(30);
    expect(state.segCount).toBe(2);
  });
});
