/**
 * 帧编解码（纯函数，不依赖 wx.*，可在 node 里单测）。
 *
 * 字节级契约见 docs/protocol-v3.md §3；测试向量见
 * docs/protocol-testvectors-v3.json（两端共用同一份文件）。
 *
 * v3 信封：magic(1) version(1) command(1) seq(1) length(2 LE) payload crc16(2 LE)。
 * CRC16 覆盖 magic 到 payload 末字节（前 6 + length 字节）。
 */

import {
  FRAME_OVERHEAD,
  HEADER_BYTES,
  MAGIC,
  MAX_FRAME_BYTES,
  MAX_PAYLOAD_BYTES,
  PROTOCOL_VERSION,
} from "./constants";

/** encode 结果超过 240 字节或 payload 超过 232 字节时抛出，绝不截断。 */
export class FrameTooLongError extends Error {
  readonly payloadLength: number;
  readonly frameLength: number;

  constructor(payloadLength: number, frameLength: number) {
    super(
      `协议帧超长：payload ${payloadLength} 字节，整帧 ${frameLength} 字节（上限 ${MAX_FRAME_BYTES}）`,
    );
    this.name = "FrameTooLongError";
    this.payloadLength = payloadLength;
    this.frameLength = frameLength;
  }
}

export type DecodeFailureReason = "short" | "magic" | "version" | "length" | "crc";

export type DecodeResult =
  | { ok: true; command: number; seq: number; payload: Uint8Array }
  | { ok: false; reason: DecodeFailureReason };

/**
 * CRC16 CCITT-FALSE：多项式 0x1021、初值 0xFFFF、不反转、无末尾异或（§3.4）。
 *
 * 标准校验值 `"123456789"` → `0x29B1`（测试里锁死这一条，防止位序写反）。
 */
export function crc16(bytes: Uint8Array | readonly number[]): number {
  let crc = 0xffff;
  for (let i = 0; i < bytes.length; i += 1) {
    crc ^= (bytes[i] & 0xff) << 8;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc & 0x8000) !== 0 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc;
}

/**
 * 编码一条完整逻辑帧（不含分片头；分片由 chunk.ts 负责）。
 *
 * command / seq 按 0xFF 掩码（回绕由调用方负责），不做业务校验——
 * 字节层必须能编码出测试向量里的未知命令、保留命令与非法取值帧。
 */
export function encodeFrame(
  command: number,
  seq: number,
  payload: Uint8Array | readonly number[] = new Uint8Array(0),
): Uint8Array {
  const payloadLength = payload.length;
  const frameLength = FRAME_OVERHEAD + payloadLength;
  if (payloadLength > MAX_PAYLOAD_BYTES || frameLength > MAX_FRAME_BYTES) {
    throw new FrameTooLongError(payloadLength, frameLength);
  }

  const frame = new Uint8Array(frameLength);
  frame[0] = MAGIC;
  frame[1] = PROTOCOL_VERSION;
  frame[2] = command & 0xff;
  frame[3] = seq & 0xff;
  frame[4] = payloadLength & 0xff;
  frame[5] = (payloadLength >> 8) & 0xff;
  for (let i = 0; i < payloadLength; i += 1) {
    frame[HEADER_BYTES + i] = payload[i] & 0xff;
  }
  const crc = crc16(frame.slice(0, HEADER_BYTES + payloadLength));
  frame[HEADER_BYTES + payloadLength] = crc & 0xff;
  frame[HEADER_BYTES + payloadLength + 1] = (crc >> 8) & 0xff;
  return frame;
}

/**
 * 解码一条完整逻辑帧。检查顺序与协议 §5 一致：
 * 短帧 → magic → version → length（声明值 + 实际长度） → CRC16。
 *
 * 后续的 command / payload 语义由命令层负责，这里只交信封。
 */
export function decodeFrame(input: Uint8Array | ArrayBuffer): DecodeResult {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);

  if (bytes.length < FRAME_OVERHEAD) {
    return { ok: false, reason: "short" };
  }
  if (bytes[0] !== MAGIC) {
    return { ok: false, reason: "magic" };
  }
  if (bytes[1] !== PROTOCOL_VERSION) {
    return { ok: false, reason: "version" };
  }

  const declared = bytes[4] | (bytes[5] << 8);
  if (declared > MAX_PAYLOAD_BYTES || FRAME_OVERHEAD + declared > MAX_FRAME_BYTES) {
    return { ok: false, reason: "length" };
  }
  if (bytes.length !== FRAME_OVERHEAD + declared) {
    return { ok: false, reason: "length" };
  }

  const covered = HEADER_BYTES + declared;
  const expected = bytes[covered] | (bytes[covered + 1] << 8);
  if (expected !== crc16(bytes.slice(0, covered))) {
    return { ok: false, reason: "crc" };
  }

  // 复制 payload，避免把底层 ArrayBuffer 的生命周期泄漏给调用方。
  const payload = bytes.slice(HEADER_BYTES, HEADER_BYTES + declared);
  return { ok: true, command: bytes[2], seq: bytes[3], payload };
}
