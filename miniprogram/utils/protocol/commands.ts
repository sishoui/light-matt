/**
 * 命令构造器与载荷解析（纯函数）。业务范围校验在构造器里做，
 * 字节布局严格按 docs/protocol.md §6/§7。
 *
 * v2（#21）变化：
 *  - SetLedCount 0x06 变成 3 字节 `strip_id, count_lo, count_hi`；
 *  - v1 的 SetColor 0x03 / SetAll 0x04 退役，构造器一并删除；
 *  - State 从 8 字节扩到 14 字节。
 *
 * 段配置 / 剧本的下发构造器由 #25 / #32 按同一份向量补齐。
 */

import { MAX_LEDS, MAX_STRIPS, MIN_LEDS, NO_SCRIPT, STATE_BYTES } from "./constants";
import type { AckResult, CommandRequest, DeviceState } from "./types";

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

export function cmdQueryState(): CommandRequest {
  return { command: 0x05, payload: new Uint8Array(0) };
}

/**
 * 灯珠数量：载荷 `strip_id, count_lo, count_hi`，数量 1-64。
 *
 * strip_id 必须先确认（0-7），数量再校验；非整数或越界直接抛错，不发帧。
 * 固件当前只接受 strip_id = 0（多灯带 #29），传其它值会得到 InvalidParam。
 */
export function cmdSetLedCount(stripId: number, count: number): CommandRequest {
  if (!Number.isInteger(stripId) || stripId < 0 || stripId >= MAX_STRIPS) {
    throw new RangeError(`strip_id 必须是 0-${MAX_STRIPS - 1} 的整数，收到 ${stripId}`);
  }
  if (!Number.isInteger(count) || count < MIN_LEDS || count > MAX_LEDS) {
    throw new RangeError(`灯珠数量必须是 ${MIN_LEDS}-${MAX_LEDS} 的整数，收到 ${count}`);
  }
  return {
    command: 0x06,
    payload: new Uint8Array([stripId, count & 0xff, (count >> 8) & 0xff]),
  };
}

export function cmdSelfTest(): CommandRequest {
  return { command: 0x07, payload: new Uint8Array(0) };
}

/**
 * 解析 14 字节 State（State read 与 StateReport 共用）。
 * 长度不符视为协议不匹配，不「尽量解析」。
 */
export function parseState(payload: Uint8Array): DeviceState {
  if (payload.length !== STATE_BYTES) {
    throw new RangeError(`State 必须是 ${STATE_BYTES} 字节，收到 ${payload.length}`);
  }
  const power = payload[0];
  if (power !== 0 && power !== 1) {
    throw new RangeError(`State.power 必须是 0/1，收到 ${power}`);
  }
  const stripCount = payload[8];
  if (stripCount < 1 || stripCount > MAX_STRIPS) {
    throw new RangeError(`State.strip_count 必须是 1-${MAX_STRIPS}，收到 ${stripCount}`);
  }
  const playbackState = payload[12];
  if (playbackState > 2) {
    throw new RangeError(`State.playback_state 必须是 0-2，收到 ${playbackState}`);
  }
  return {
    power,
    brightness: payload[1],
    r: payload[2],
    g: payload[3],
    b: payload[4],
    ledCount: payload[5] | (payload[6] << 8),
    maxBrightness: payload[7],
    stripCount,
    segCount: payload[9],
    scriptId: payload[10],
    stageIndex: payload[11],
    playbackState,
    flags: payload[13],
  };
}

/** State 里的 `script_active` 位（bit1）。 */
export function stateScriptActive(state: DeviceState): boolean {
  return (state.flags & 0x02) !== 0;
}

/** State 里的 `loop` 位（bit0）。 */
export function stateLoop(state: DeviceState): boolean {
  return (state.flags & 0x01) !== 0;
}

/** 是否有激活剧本（script_id != 0xFF）。 */
export function stateHasScript(state: DeviceState): boolean {
  return state.scriptId !== NO_SCRIPT;
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
