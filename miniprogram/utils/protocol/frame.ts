/**
 * 帧编解码（纯函数，不依赖 wx.*，可在 node 里单测）。
 *
 * 字节级契约见 docs/protocol.md §3/§10.2；测试向量见
 * docs/protocol-testvectors.json（两端共用同一份文件）。
 */

import {
  FRAME_OVERHEAD,
  HEADER_BYTES,
  MAGIC,
  MAX_FRAME_BYTES,
  MAX_PAYLOAD_BYTES,
  PROTOCOL_VERSION,
} from "./constants";

/** encode 结果超过 20 字节或 payload 超过 14 字节时抛出，绝不截断。 */
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

export type DecodeFailureReason = "short" | "magic" | "version" | "length" | "checksum";

export type DecodeResult =
  | { ok: true; command: number; seq: number; payload: Uint8Array }
  | { ok: false; reason: DecodeFailureReason };

/**
 * checksum = 对 magic 到 payload 最后一个字节求和取低 8 位，再按位取反。
 * `coveredLength` 是被覆盖的字节数（= 5 + payload 长度），不包含 checksum 自身。
 */
export function checksumOf(bytes: Uint8Array, coveredLength: number): number {
  let sum = 0;
  for (let i = 0; i < coveredLength; i += 1) {
    sum = (sum + (bytes[i] & 0xff)) & 0xff;
  }
  return ~sum & 0xff; // one's complement，不是取负
}

/**
 * 编码一条完整帧。
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
  frame[4] = payloadLength;
  for (let i = 0; i < payloadLength; i += 1) {
    frame[HEADER_BYTES + i] = payload[i] & 0xff;
  }
  frame[frameLength - 1] = checksumOf(frame, HEADER_BYTES + payloadLength);
  return frame;
}

/**
 * 解码一条完整帧。检查顺序与协议 §10.2 一致：
 * 短帧 → magic → version → length（声明值 + 实际长度） → checksum。
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

  const declared = bytes[4];
  if (declared > MAX_PAYLOAD_BYTES || FRAME_OVERHEAD + declared > MAX_FRAME_BYTES) {
    return { ok: false, reason: "length" };
  }
  if (bytes.length !== FRAME_OVERHEAD + declared) {
    return { ok: false, reason: "length" };
  }

  const covered = HEADER_BYTES + declared;
  if (bytes[covered] !== checksumOf(bytes, covered)) {
    return { ok: false, reason: "checksum" };
  }

  // 复制 payload，避免把底层 ArrayBuffer 的生命周期泄漏给调用方。
  const payload = bytes.slice(HEADER_BYTES, HEADER_BYTES + declared);
  return { ok: true, command: bytes[2], seq: bytes[3], payload };
}
