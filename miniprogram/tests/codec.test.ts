/**
 * codec 测试：直接消费仓库里 docs/protocol-testvectors.json（两端共用同一份）。
 *
 * 不复制向量、不伪造期望值：任何协议字节变化都会让这里失败。
 */

import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { bytesToCompactHex, hexToBytes } from "../utils/protocol/hex";
import { checksumOf, decodeFrame, encodeFrame, FrameTooLongError } from "../utils/protocol/frame";

interface VectorCase {
  name: string;
  direction: "app_to_device" | "device_to_app";
  command?: number;
  seq?: number;
  payload_hex?: string;
  frame_hex: string;
  frame_valid: boolean;
  result_code?: number | null;
  note?: string;
}

interface VectorFile {
  protocol_version: number;
  state_read_example_hex: string;
  cases: VectorCase[];
}

const vectors: VectorFile = JSON.parse(
  readFileSync(new URL("../../docs/protocol-testvectors.json", import.meta.url), "utf8"),
);

function payloadOf(c: VectorCase): Uint8Array {
  const bytes = hexToBytes(c.payload_hex ?? "");
  expect(bytes).not.toBeNull();
  return bytes as Uint8Array;
}

describe("协议测试向量", () => {
  it("向量文件本身是 v1 且包含 37 个用例", () => {
    expect(vectors.protocol_version).toBe(1);
    expect(vectors.cases.length).toBe(37);
  });

  it("app_to_device 有效帧：encode 逐字节复现 frame_hex", () => {
    const cases = vectors.cases.filter((c) => c.direction === "app_to_device" && c.frame_valid);
    expect(cases.length).toBeGreaterThan(0);
    for (const c of cases) {
      expect(c.command, c.name).toBeTypeOf("number");
      expect(c.seq, c.name).toBeTypeOf("number");
      const frame = encodeFrame(c.command as number, c.seq as number, payloadOf(c));
      expect(bytesToCompactHex(frame), c.name).toBe(c.frame_hex.toUpperCase());
      expect(frame.length, c.name).toBe(frame[4] + 6);
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
      expect(bytesToCompactHex(result.payload), c.name).toBe((c.payload_hex ?? "").toUpperCase());
    }
  });

  it("app_to_device 无效帧：decode 返回与 result_code 对应的失败原因", () => {
    const reasonByResult: Record<number, string> = {
      3: "checksum",
      4: "length",
      8: "magic",
    };
    const cases = vectors.cases.filter((c) => c.direction === "app_to_device" && !c.frame_valid);
    expect(cases.length).toBeGreaterThan(0);
    for (const c of cases) {
      const bytes = hexToBytes(c.frame_hex) as Uint8Array;
      const result = decodeFrame(bytes);
      expect(result.ok, c.name).toBe(false);
      if (result.ok) continue;
      if (c.result_code === null || c.result_code === undefined) {
        expect(result.reason, c.name).toBe("short");
      } else {
        expect(result.reason, c.name).toBe(reasonByResult[c.result_code]);
      }
    }
  });

  it("device_to_app 帧：decode 成功，字段与向量一致", () => {
    const cases = vectors.cases.filter((c) => c.direction === "device_to_app");
    expect(cases.length).toBeGreaterThan(0);
    for (const c of cases) {
      const bytes = hexToBytes(c.frame_hex) as Uint8Array;
      const result = decodeFrame(bytes);
      expect(result.ok, c.name).toBe(true);
      if (!result.ok) continue;
      expect(result.command, c.name).toBe(c.command);
      expect(result.seq, c.name).toBe(c.seq);
      expect(bytesToCompactHex(result.payload), c.name).toBe((c.payload_hex ?? "").toUpperCase());

      // 设备→小程序帧也必须能用同一编码器逐字节复现（ACK / Event / StateReport）。
      const reencoded = encodeFrame(result.command, result.seq, result.payload);
      expect(bytesToCompactHex(reencoded), c.name).toBe(c.frame_hex.toUpperCase());
    }
  });

  it("37 条向量逐条被覆盖（每条都属于下面三类之一）", () => {
    const appValid = vectors.cases.filter(
      (c) => c.direction === "app_to_device" && c.frame_valid,
    ).length;
    const appInvalid = vectors.cases.filter(
      (c) => c.direction === "app_to_device" && !c.frame_valid,
    ).length;
    const device = vectors.cases.filter((c) => c.direction === "device_to_app").length;
    expect(appValid + appInvalid + device).toBe(vectors.cases.length);
    expect(vectors.cases.length).toBe(37);

    // 直接逐条 decode：任何一条的 ok 与 frame_valid 不符都视为失败。
    for (const c of vectors.cases) {
      const bytes = hexToBytes(c.frame_hex);
      expect(bytes, c.name).not.toBeNull();
      const result = decodeFrame(bytes as Uint8Array);
      expect(result.ok, c.name).toBe(c.frame_valid);
    }
  });

  it("坏校验帧不能通过（即使 payload 完全相同）", () => {
    const good = encodeFrame(0x01, 0x01, [0x01]);
    const bad = good.slice();
    bad[bad.length - 1] ^= 0xff;
    const result = decodeFrame(bad);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("checksum");
  });
});

describe("checksum", () => {
  it("协议文档例子：A5 01 01 01 01 01 → 0x55", () => {
    const frame = hexToBytes("A5 01 01 01 01 01") as Uint8Array;
    expect(checksumOf(frame, 6)).toBe(0x55);
  });

  it("one's complement 而不是取负：覆盖长度 0 时返回 0xFF", () => {
    const empty = new Uint8Array([0]);
    expect(checksumOf(empty, 0)).toBe(0xff);
  });
});

describe("encode 边界", () => {
  it("14 字节 payload 恰好 20 字节，不抛错", () => {
    const frame = encodeFrame(0x7f, 1, new Uint8Array(14));
    expect(frame.length).toBe(20);
    expect(frame[4]).toBe(14);
    expect(decodeFrame(frame).ok).toBe(true);
  });

  it("15 字节 payload 抛 FrameTooLongError，绝不截断", () => {
    let thrown: unknown = null;
    try {
      encodeFrame(0x7f, 1, new Uint8Array(15));
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(FrameTooLongError);
    const error = thrown as FrameTooLongError;
    expect(error.payloadLength).toBe(15);
    expect(error.frameLength).toBe(21);
  });

  it("command / seq 按 0xFF 掩码", () => {
    const frame = encodeFrame(0x1ff, 0x101, []);
    expect(frame[2]).toBe(0xff);
    expect(frame[3]).toBe(0x01);
  });

  it("空 payload 的帧长度为 6", () => {
    expect(encodeFrame(0x05, 0x09).length).toBe(6);
  });
});
