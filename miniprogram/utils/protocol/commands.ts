/**
 * 命令构造器与载荷解析（纯函数）。业务范围校验在构造器里做，
 * 字节布局严格按 docs/protocol.md §6/§7/§8。
 *
 * #8 只用到 cmdSetPower / parseAck / parseState；其余构造器一并写好，
 * 后续票（#9 亮度、#10 颜色、#12 灯珠数量、#13 自检）直接复用。
 */

import { MAX_LEDS, MIN_LEDS } from "./constants";
import type { AckResult, CommandRequest, DeviceState, RGB } from "./types";

function assertByte(value: number, field: string): number {
  if (!Number.isInteger(value) || value < 0 || value > 255) {
    throw new RangeError(`${field} 必须是 0-255 的整数，收到 ${value}`);
  }
  return value;
}

export function cmdSetPower(on: boolean): CommandRequest {
  return { command: 0x01, payload: new Uint8Array([on ? 1 : 0]) };
}

export function cmdSetBrightness(brightness: number): CommandRequest {
  return { command: 0x02, payload: new Uint8Array([assertByte(brightness, "brightness")]) };
}

export function cmdSetColor(rgb: RGB): CommandRequest {
  return {
    command: 0x03,
    payload: new Uint8Array([
      assertByte(rgb.r, "r"),
      assertByte(rgb.g, "g"),
      assertByte(rgb.b, "b"),
    ]),
  };
}

/** 一次设全部：载荷顺序固定 [power, brightness, R, G, B]，整帧原子生效。 */
export function cmdSetAll(power: 0 | 1, brightness: number, rgb: RGB): CommandRequest {
  if (power !== 0 && power !== 1) {
    throw new RangeError(`power 必须是 0 或 1，收到 ${power}`);
  }
  return {
    command: 0x04,
    payload: new Uint8Array([
      power,
      assertByte(brightness, "brightness"),
      assertByte(rgb.r, "r"),
      assertByte(rgb.g, "g"),
      assertByte(rgb.b, "b"),
    ]),
  };
}

export function cmdQueryState(): CommandRequest {
  return { command: 0x05, payload: new Uint8Array(0) };
}

/** 灯珠数量：2 字节小端，1-64。非整数或越界直接抛错，不发帧。 */
export function cmdSetLedCount(count: number): CommandRequest {
  if (!Number.isInteger(count) || count < MIN_LEDS || count > MAX_LEDS) {
    throw new RangeError(`灯珠数量必须是 ${MIN_LEDS}-${MAX_LEDS} 的整数，收到 ${count}`);
  }
  return { command: 0x06, payload: new Uint8Array([count & 0xff, (count >> 8) & 0xff]) };
}

export function cmdSelfTest(): CommandRequest {
  return { command: 0x07, payload: new Uint8Array(0) };
}

/**
 * 解析 8 字节 State（State read 与 StateReport 共用）。
 * 长度不符视为协议不匹配，不「尽量解析」。
 */
export function parseState(payload: Uint8Array): DeviceState {
  if (payload.length !== 8) {
    throw new RangeError(`State 必须是 8 字节，收到 ${payload.length}`);
  }
  const power = payload[0];
  if (power !== 0 && power !== 1) {
    throw new RangeError(`State.power 必须是 0/1，收到 ${power}`);
  }
  return {
    power,
    brightness: payload[1],
    r: payload[2],
    g: payload[3],
    b: payload[4],
    ledCount: payload[5] | (payload[6] << 8),
    maxBrightness: payload[7],
  };
}

/** ACK 载荷固定 [原命令字, 结果码]。 */
export function parseAck(payload: Uint8Array, seq: number): AckResult {
  if (payload.length !== 2) {
    throw new RangeError(`ACK 载荷必须是 2 字节，收到 ${payload.length}`);
  }
  return {
    seq,
    command: payload[0],
    resultCode: payload[1],
    ok: payload[1] === 0x00,
  };
}
