/**
 * 命令构造器与载荷解析（纯函数）。业务范围校验在构造器里做，
 * 字节布局严格按 docs/protocol.md §6/§7。
 *
 * v2（#21）变化：
 *  - SetLedCount 0x06 变成 3 字节 `strip_id, count_lo, count_hi`；
 *  - v1 的 SetColor 0x03 / SetAll 0x04 退役，构造器一并删除；
 *  - State 从 8 字节扩到 14 字节。
 *
 * #25 补上段配置：SetSegment 0x10 / ClearSegment 0x11 / QueryStrip 0x12，
 * 以及设备回报 SegmentReport 0x83 / SegmentListEnd 0x84 的解析。
 */

import {
  BREATHING_MIN_PERIOD_MS,
  MAX_LEDS,
  MAX_PERIOD_MS,
  MAX_SEGMENTS,
  MAX_STRIPS,
  MIN_LEDS,
  NO_SCRIPT,
  SEGMENT_TYPE,
  STATE_BYTES,
  WAVEFORM,
} from "./constants";
import type {
  AckResult,
  CommandRequest,
  DeviceState,
  SegmentConfig,
  SegmentListEnd,
  SegmentReport,
} from "./types";

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

/** 色相 0-65535 的整数校验（协议 D2：2 字节，一整圈 65536 级）。 */
function assertHue(value: number): number {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff) {
    throw new RangeError(`hue 必须是 0-65535 的整数，收到 ${value}`);
  }
  return value;
}

/** 灯珠下标（0-63 协议上限内，且必须 ≤ 255 才能进 1 字节字段）。 */
function assertLedIndex(value: number, field: string): number {
  if (!Number.isInteger(value) || value < 0 || value > MAX_LEDS - 1) {
    throw new RangeError(`${field} 必须是 0-${MAX_LEDS - 1} 的整数，收到 ${value}`);
  }
  return value;
}

function assertStripId(stripId: number): number {
  if (!Number.isInteger(stripId) || stripId < 0 || stripId >= MAX_STRIPS) {
    throw new RangeError(`strip_id 必须是 0-${MAX_STRIPS - 1} 的整数，收到 ${stripId}`);
  }
  return stripId;
}

/**
 * 段类型的参数块长度（effects-spec §2.5）：静态 3，动画 7。
 * 未知类型返回 0（构造器据此拒绝，不猜布局）。
 */
export function segmentParamLength(type: number): number {
  if (type === SEGMENT_TYPE.STATIC) {
    return 3;
  }
  if (
    type === SEGMENT_TYPE.BREATHING ||
    type === SEGMENT_TYPE.RAINBOW ||
    type === SEGMENT_TYPE.COMET
  ) {
    return 7;
  }
  return 0;
}

/**
 * SetSegment 0x10：载荷 `strip_id, seg_id, start, end, type, params(3|7)`。
 *
 * #25 交付静态单色；#30 交付呼吸（type 0x01）。彩虹 / 流光（0x02/0x03）的
 * 像素由 #31 落地，但**布局早已定稿**，构造器仍然允许构造这两类帧——
 * 协议布局是权威，UI / 日志需要能发出它们，并用 ACK 明确告诉用户
 * 「要升级固件」。固件对未实现类型回 UnknownCommand（不静默变黑）。
 *
 * 校验只做构造层能判定的部分（字节范围、start ≤ end、段类型已知、
 * 呼吸的周期下限与 flags 保留位）；「end < led_count」与「不重叠」是
 * 设备侧权威校验（§11.3 第 6/7 步），这里不做，以免 App 与设备的
 * led_count 快照不一致时误拒。
 */
export function cmdSetSegment(segment: SegmentConfig): CommandRequest {
  const stripId = assertStripId(segment.stripId);
  if (!Number.isInteger(segment.segId) || segment.segId < 0 || segment.segId >= MAX_SEGMENTS) {
    throw new RangeError(`seg_id 必须是 0-${MAX_SEGMENTS - 1} 的整数，收到 ${segment.segId}`);
  }
  const start = assertLedIndex(segment.start, "start");
  const end = assertLedIndex(segment.end, "end");
  if (start > end) {
    throw new RangeError(`start 不能大于 end，收到 ${start} > ${end}`);
  }
  const paramLen = segmentParamLength(segment.type);
  if (paramLen === 0) {
    throw new RangeError(`未知的段类型 0x${segment.type.toString(16)}`);
  }
  const hue = assertHue(segment.hue);
  const sat = assertByte(segment.sat, "sat");

  const payload = new Uint8Array(5 + paramLen);
  payload[0] = stripId;
  payload[1] = segment.segId;
  payload[2] = start;
  payload[3] = end;
  payload[4] = segment.type;
  payload[5] = hue & 0xff;
  payload[6] = (hue >> 8) & 0xff;
  payload[7] = sat;
  if (paramLen > 3) {
    const period = segment.periodMs;
    if (!Number.isInteger(period) || period < 0 || period > MAX_PERIOD_MS) {
      throw new RangeError(`period_ms 必须是 0-${MAX_PERIOD_MS} 的整数，收到 ${period}`);
    }
    const flags = assertByte(segment.flags, "flags");
    if (segment.type === SEGMENT_TYPE.BREATHING) {
      /* effects-spec §5 / protocol §11.3 第 8-9 步，在本端就拒绝：
       * period != 0 时 ≥ 334；flags bit3-7 必须为 0。 */
      if (period !== 0 && period < BREATHING_MIN_PERIOD_MS) {
        throw new RangeError(
          `呼吸周期不能短于 ${BREATHING_MIN_PERIOD_MS}ms（约 3Hz），收到 ${period}`,
        );
      }
      if ((flags & 0xf8) !== 0) {
        throw new RangeError(`呼吸 flags 的保留位 bit3-7 必须为 0，收到 0x${flags.toString(16)}`);
      }
    }
    payload[8] = period & 0xff;
    payload[9] = (period >> 8) & 0xff;
    payload[10] = assertByte(segment.p5, "p5");
    payload[11] = flags;
  }
  return { command: 0x10, payload };
}

/** 构造一个静态段（#25 的唯一可下发类型）。 */
export function staticSegment(
  stripId: number,
  segId: number,
  start: number,
  end: number,
  hue: number,
  sat: number,
): SegmentConfig {
  return { stripId, segId, start, end, type: SEGMENT_TYPE.STATIC, hue, sat, periodMs: 0, p5: 0, flags: 0 };
}

/**
 * 打呼吸的 flags 字节（effects-spec §2.2）：
 *   bit0 reverse（保留，无实际意义）、bit1-2 waveform、bit3-7 = 0。
 *
 * waveform 只有 2 位，所以先 &3 再左移——传错值也不会污染保留位。
 */
export function breathingFlags(waveform: number, reverse = false): number {
  const wave = waveform & 0x03;
  return ((wave << 1) & 0x06) | (reverse ? 0x01 : 0);
}

/** 从 flags 解出波形（bit1-2）。 */
export function breathingWaveform(flags: number): number {
  return (flags >> 1) & 0x03;
}

/**
 * 构造一个呼吸段（#30）。
 *
 * `minLevel` 是「最暗时的亮度占比」0-255（0 → 能暗到全黑，200 左右几乎不呼吸）；
 * `waveform` 取 WAVEFORM 枚举；`reverse` 写进 flags bit0（当前无视觉意义，保留）。
 *
 * 只装配数据，校验全部在 cmdSetSegment（周期下限、保留位、区间）。
 */
export function breathingSegment(
  stripId: number,
  segId: number,
  start: number,
  end: number,
  hue: number,
  sat: number,
  periodMs: number,
  minLevel: number,
  waveform: number = WAVEFORM.SINE,
  reverse = false,
): SegmentConfig {
  return {
    stripId,
    segId,
    start,
    end,
    type: SEGMENT_TYPE.BREATHING,
    hue,
    sat,
    periodMs,
    p5: minLevel,
    flags: breathingFlags(waveform, reverse),
  };
}

/** ClearSegment 0x11：载荷 `strip_id, seg_id`。 */
export function cmdClearSegment(stripId: number, segId: number): CommandRequest {
  const strip = assertStripId(stripId);
  if (!Number.isInteger(segId) || segId < 0 || segId >= MAX_SEGMENTS) {
    throw new RangeError(`seg_id 必须是 0-${MAX_SEGMENTS - 1} 的整数，收到 ${segId}`);
  }
  return { command: 0x11, payload: new Uint8Array([strip, segId]) };
}

/** QueryStrip 0x12：载荷 `strip_id`。 */
export function cmdQueryStrip(stripId: number): CommandRequest {
  return { command: 0x12, payload: new Uint8Array([assertStripId(stripId)]) };
}

/**
 * 解析 SegmentReport 0x83（与 SetSegment 载荷同构）。
 *
 * 长度必须与 type 对应的参数块一致，否则视为协议不匹配（不「尽量解析」）。
 */
export function parseSegmentReport(payload: Uint8Array): SegmentReport {
  if (payload.length < 5) {
    throw new RangeError(`SegmentReport 至少 5 字节，收到 ${payload.length}`);
  }
  const type = payload[4];
  const paramLen = segmentParamLength(type);
  if (paramLen === 0) {
    throw new RangeError(`SegmentReport 的段类型未知：0x${type.toString(16)}`);
  }
  if (payload.length !== 5 + paramLen) {
    throw new RangeError(
      `SegmentReport 长度必须是 ${5 + paramLen} 字节（type=0x${type.toString(16).padStart(2, "0")}），收到 ${payload.length}`,
    );
  }
  const report: SegmentReport = {
    stripId: payload[0],
    segId: payload[1],
    start: payload[2],
    end: payload[3],
    type,
    hue: payload[5] | (payload[6] << 8),
    sat: payload[7],
    periodMs: 0,
    p5: 0,
    flags: 0,
  };
  if (paramLen > 3) {
    report.periodMs = payload[8] | (payload[9] << 8);
    report.p5 = payload[10];
    report.flags = payload[11];
  }
  if (report.start > report.end) {
    throw new RangeError(`SegmentReport 的 start > end：${report.start} > ${report.end}`);
  }
  return report;
}

/** 解析 SegmentListEnd 0x84：载荷 `strip_id, seg_mask`。 */
export function parseSegmentListEnd(payload: Uint8Array): SegmentListEnd {
  if (payload.length !== 2) {
    throw new RangeError(`SegmentListEnd 载荷必须是 2 字节，收到 ${payload.length}`);
  }
  return { stripId: payload[0], segMask: payload[1] };
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
