/**
 * 命令构造器与载荷解析（纯函数）。业务范围校验在构造器里做，
 * 字节布局严格按 docs/protocol-v4.md §6/§7。
 *
 * v3（#40）变化：
 *  - 信封换成 16 位长度 + CRC16（frame.ts）；载荷上限 232；
 *  - 段载荷定宽两层：SetSegment 23、ScriptSegment 25、SegmentReport 23；
 *  - ScriptStage 增加 `fade_ms`（预留，恒 0）；
 *  - 新增 SetStripPower 0x1B / QueryStripConfig 0x1C / QueryDeviceInfo 0x1D；
 *  - State 从 14 字节扩到 37 字节（带每条灯带的灯珠数 / 段数 / 开关位）。
 *
 * v4（#69）变化：
 *  - 层编码 8 → **9 字节**：第 9 字节是 `level`（本层亮度 0-100）；
 *  - 段载荷 21 → 23、ScriptSegment 23 → 25、SegmentReport 21 → 23；
 *  - `level > 100` 与「空层带非零 level」在本端就拒绝（设备回 InvalidParam）。
 *
 * 扁平 vs 两层：`SegmentSpec` 是线上形状；页面沿用的 `SegmentConfig` 是
 * 「只有层 0」的 UI 草稿。两者由 protocol/segment-shapes.ts 互转，
 * 构造器两者都接受（`isSegmentSpec` 区分）。
 */

import {
  ANIMATION_MIN_PERIOD_MS,
  BLEND,
  BREATHING_MIN_PERIOD_MS,
  COMET_DENSITY_MASK,
  COMET_DENSITY_SHIFT,
  COMET_FLAG,
  COMET_FLAGS_RESERVED,
  COMET_HEADS_MAX,
  COMET_HEADS_MIN,
  DEVICE_INFO_BYTES,
  FLICKER_MIN_PERIOD_MS,
  HEARTBEAT_MAX_PERIOD_MS,
  HEARTBEAT_MIN_PERIOD_MS,
  LAYER_BYTES,
  LAYER_LEVEL_MAX,
  LOOP,
  LOOP_MAX,
  type LoopMode,
  MAX_LEDS,
  MAX_SCRIPTS,
  MAX_SEGMENTS,
  MAX_STAGES,
  MAX_STAGE_MS,
  MAX_STRIPS,
  MIN_LEDS,
  NO_EFFECT,
  NO_SCRIPT,
  PLAYBACK_FLAG,
  SCRIPT_SEGMENT_BYTES,
  SEGMENT_BYTES,
  SEGMENT_HEADER_BYTES,
  SEGMENT_TYPE,
  STATE_BYTES,
  STROBE_MIN_PERIOD_MS,
  STRIP_CONFIG_BYTES,
  STRIP_CONFIG_RECORD_BYTES,
  WAVEFORM,
  isKnownEffectType,
} from "./constants";
import { isSegmentSpec, toFlat, toSpec } from "./segment-shapes";
import type {
  AckResult,
  BlendMode,
  CommandRequest,
  DeviceInfo,
  DeviceState,
  EffectLayer,
  SegmentConfig,
  SegmentListEnd,
  SegmentReport,
  SegmentSpec,
  StripConfig,
} from "./types";

function assertByte(value: number, field: string): number {
  if (!Number.isInteger(value) || value < 0 || value > 255) {
    throw new RangeError(`${field} 必须是 0-255 的整数，收到 ${value}`);
  }
  return value;
}

function assertUint16(value: number, field: string): number {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff) {
    throw new RangeError(`${field} 必须是 0-65535 的整数，收到 ${value}`);
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
 * 灯珠数量：载荷 `strip_id, count_lo, count_hi`，数量 1-100（#72）。
 *
 * strip_id 必须先确认（0-7），数量再校验；非整数或越界直接抛错，不发帧。
 */
export function cmdSetLedCount(stripId: number, count: number): CommandRequest {
  const strip = assertStripId(stripId);
  if (!Number.isInteger(count) || count < MIN_LEDS || count > MAX_LEDS) {
    throw new RangeError(`灯珠数量必须是 ${MIN_LEDS}-${MAX_LEDS} 的整数，收到 ${count}`);
  }
  return {
    command: 0x06,
    payload: new Uint8Array([strip, count & 0xff, (count >> 8) & 0xff]),
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

/** 灯珠下标（0-99 协议上限内，#72；且必须 ≤ 255 才能进 1 字节字段）。 */
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

/** `strip_count` 是「灯带条数」1-8（与 strip_id 0-7 差一，必须分开校验）。 */
function assertStripCount(stripCount: number): number {
  if (!Number.isInteger(stripCount) || stripCount < 1 || stripCount > MAX_STRIPS) {
    throw new RangeError(`strip_count 必须是 1-${MAX_STRIPS} 的整数，收到 ${stripCount}`);
  }
  return stripCount;
}

function assertSegId(segId: number): number {
  if (!Number.isInteger(segId) || segId < 0 || segId >= MAX_SEGMENTS) {
    throw new RangeError(`seg_id 必须是 0-${MAX_SEGMENTS - 1} 的整数，收到 ${segId}`);
  }
  return segId;
}

function isKnownLayerType(type: number): boolean {
  /* 单一真相是 constants.ts 的 KNOWN_EFFECT_TYPES（#74 的教训：别在这里再抄一份）。 */
  return isKnownEffectType(type);
}

/**
 * 层类型的有效参数长度（effects-spec §2.8）：静态 3；其余六种 7；空层/未知 0。
 *
 * 层在线上是定宽 9 字节（type + 7 字节参数 + level），这里给的是**有效字节数**，
 * 只用于校验与日志，不决定编码宽度。#74 的爆闪 / 心跳 / 熄灭复用同一个 7 字节块。
 */
export function layerParamLength(type: number): number {
  if (type === SEGMENT_TYPE.STATIC) {
    return 3;
  }
  if (isKnownLayerType(type)) {
    return 7;
  }
  return 0;
}

/** v2 名字的兼容别名：扁平段类型与层类型共用同一张枚举。 */
export function segmentParamLength(type: number): number {
  return layerParamLength(type);
}

/**
 * 本层亮度 `level` 的校验（v4，§7.1）：0-100 的整数。
 *
 * 不做钳位、不做回绕——`> 100` 明确拒绝比静默改掉用户意图安全（设备同样是回
 * `InvalidParam` 而不是截断）。`level = 0` 合法，语义是「这一层不出光」。
 */
function assertLevel(value: number, field: string): number {
  if (!Number.isInteger(value) || value < 0 || value > LAYER_LEVEL_MAX) {
    throw new RangeError(`${field}.level 必须是 0-${LAYER_LEVEL_MAX} 的整数，收到 ${value}`);
  }
  return value;
}

/**
 * 校验一层并按 §7.1 的 9 字节定宽写入（type + 7 字节参数 + level）。
 *
 * 规则（顺序固定，§7.1）：
 *  - 未知 type → 拒绝（不静默降级，effects-spec D7）；
 *  - 空层（0xFF）的 8 字节参数与 level 必须全 0；
 *  - 静态层的 param[3..6] 必须全 0（防止将来语义漂移时旧固件静默接受）；
 *  - 呼吸周期 0 或 ≥ 334；**呼吸 p5 是相对百分比 0-100**（v4）；flags bit3-7 = 0；
 *  - 彩虹 / 流光周期 0 或 ≥ 200；p5 保持 0-255；flags bit1-7 = 0；
 *  - **#74 爆闪**：flags == 0、周期 0 或 ≥ 100（10Hz 上界）；
 *  - **#74 心跳**：flags bit1-7 = 0（bit0 = 双脉冲）、周期 0 或 500-1500（40-120 BPM）；
 *  - **#74 熄灭**：hue / sat / period / p5 / flags 全 0。
 */
function writeLayer(out: Uint8Array, offset: number, layer: EffectLayer, field: string): void {
  const type = layer.type;
  const level = assertLevel(layer.level, field);
  if (type === NO_EFFECT) {
    /* 空层：9 字节全 0（type 除外）。带非零 level 说明把「清槽」和「压暗」混了。 */
    if (level !== 0) {
      throw new RangeError(`${field} 是空层，level 必须为 0，收到 ${level}`);
    }
    out[offset] = NO_EFFECT;
    return;
  }
  if (!isKnownLayerType(type)) {
    throw new RangeError(`${field} 的类型未知：0x${type.toString(16)}`);
  }
  const hue = assertHue(layer.hue);
  const sat = assertByte(layer.sat, `${field}.sat`);
  const period = assertUint16(layer.periodMs, `${field}.period_ms`);
  const p5 = assertByte(layer.p5, `${field}.p5`);
  const flags = assertByte(layer.flags, `${field}.flags`);

  if (type === SEGMENT_TYPE.STATIC) {
    if (period !== 0 || p5 !== 0 || flags !== 0) {
      throw new RangeError(`${field} 是静态层，period / p5 / flags 必须为 0`);
    }
  } else if (type === SEGMENT_TYPE.BREATHING) {
    if (period !== 0 && period < BREATHING_MIN_PERIOD_MS) {
      throw new RangeError(
        `呼吸周期不能短于 ${BREATHING_MIN_PERIOD_MS}ms（约 3Hz），收到 ${period}`,
      );
    }
    /* v4：呼吸的 p5 从绝对 0-255 改为相对百分比 0-100（谷底 = level × p5%）。 */
    if (p5 > 100) {
      throw new RangeError(`呼吸的最低亮是百分比 0-100，收到 ${p5}`);
    }
    if ((flags & 0xf8) !== 0) {
      throw new RangeError(`${field} 的 flags 保留位 bit3-7 必须为 0，收到 0x${flags.toString(16)}`);
    }
  } else if (type === SEGMENT_TYPE.STROBE) {
    /* #74 爆闪（effects-spec §2.5）：没有 flags 位；周期 0 或 ≥ 100ms。 */
    if (flags !== 0) {
      throw new RangeError(`${field} 是爆闪层，flags 必须为 0，收到 0x${flags.toString(16)}`);
    }
    if (period !== 0 && period < STROBE_MIN_PERIOD_MS) {
      throw new RangeError(
        `爆闪周期不能短于 ${STROBE_MIN_PERIOD_MS}ms（10Hz 上界），收到 ${period}`,
      );
    }
  } else if (type === SEGMENT_TYPE.HEARTBEAT) {
    /* #74 心跳（effects-spec §2.6）：bit0 双脉冲、bit1-7 保留；周期 500-1500ms。 */
    if ((flags & 0xfe) !== 0) {
      throw new RangeError(
        `${field} 的 flags 保留位 bit1-7 必须为 0，收到 0x${flags.toString(16)}`,
      );
    }
    if (
      period !== 0 &&
      (period < HEARTBEAT_MIN_PERIOD_MS || period > HEARTBEAT_MAX_PERIOD_MS)
    ) {
      throw new RangeError(
        `心跳周期必须是 ${HEARTBEAT_MIN_PERIOD_MS}-${HEARTBEAT_MAX_PERIOD_MS}ms` +
          `（40-120 BPM），收到 ${period}`,
      );
    }
  } else if (type === SEGMENT_TYPE.OFF) {
    /*
     * #74 熄灭（effects-spec §2.7）：参数全 0。注意 level 不受这条约束——
     * 熄灭本来就是黑的，亮度对它没有意义（固件同样只校验 param）。
     */
    if (hue !== 0 || sat !== 0 || period !== 0 || p5 !== 0 || flags !== 0) {
      throw new RangeError(`${field} 是熄灭层，hue / sat / period / p5 / flags 必须全为 0`);
    }
  } else if (type === SEGMENT_TYPE.FLICKER) {
    /* #98 随机闪烁：没有 flags 位；周期 0 或 ≥ 334ms（与呼吸同一条安全线）。 */
    if (flags !== 0) {
      throw new RangeError(
        `${field} 是随机闪烁层，flags 必须为 0，收到 0x${flags.toString(16)}`,
      );
    }
    if (period !== 0 && period < FLICKER_MIN_PERIOD_MS) {
      throw new RangeError(
        `随机闪烁周期不能短于 ${FLICKER_MIN_PERIOD_MS}ms（约 3Hz），收到 ${period}`,
      );
    }
  } else if (type === SEGMENT_TYPE.COMET) {
    /* #98 流光：bit0-3 有含义（反向 / 实色拖尾 / 头数量），只有 bit4-7 保留。 */
    if ((flags & COMET_FLAGS_RESERVED) !== 0) {
      throw new RangeError(
        `${field} 的流光 flags 保留位 bit4-7 必须为 0，收到 0x${flags.toString(16)}`,
      );
    }
    if (period !== 0 && period < ANIMATION_MIN_PERIOD_MS) {
      throw new RangeError(
        `流光周期不能短于 ${ANIMATION_MIN_PERIOD_MS}ms（5Hz），收到 ${period}`,
      );
    }
  } else {
    if (period !== 0 && period < ANIMATION_MIN_PERIOD_MS) {
      throw new RangeError(
        `彩虹周期不能短于 ${ANIMATION_MIN_PERIOD_MS}ms（5Hz），收到 ${period}`,
      );
    }
    if ((flags & 0xfe) !== 0) {
      throw new RangeError(
        `${field} 的 flags 保留位 bit1-7 必须为 0，收到 0x${flags.toString(16)}`,
      );
    }
  }
  out[offset] = type;
  out[offset + 1] = hue & 0xff;
  out[offset + 2] = (hue >> 8) & 0xff;
  out[offset + 3] = sat;
  if (type !== SEGMENT_TYPE.STATIC) {
    out[offset + 4] = period & 0xff;
    out[offset + 5] = (period >> 8) & 0xff;
    out[offset + 6] = p5;
    out[offset + 7] = flags;
  }
  out[offset + 8] = level;
}

function assertBlend(blend: number): BlendMode {
  if (blend !== BLEND.OVER && blend !== BLEND.MULTIPLY && blend !== BLEND.ADD) {
    throw new RangeError(`blend 只允许 0(覆盖) / 1(相乘) / 2(相加)，收到 ${blend}`);
  }
  return blend;
}

/**
 * 段载荷（23 字节）的公共校验与编码：SetSegment / ScriptSegment 共用。
 *
 * 校验只做构造层能判定的部分（字节范围、start ≤ end、层类型与参数）；
 * 「end < led_count」与「不重叠」是设备侧权威校验（§9.2），这里不做，
 * 以免 App 与设备的 led_count 快照不一致时误拒。
 */
function encodeSegmentPayload(spec: SegmentSpec, allowClearSlot = false): Uint8Array {
  const stripId = assertStripId(spec.stripId);
  const segId = assertSegId(spec.segId);
  const start = assertLedIndex(spec.start, "start");
  const end = assertLedIndex(spec.end, "end");
  if (start > end) {
    throw new RangeError(`start 不能大于 end，收到 ${start} > ${end}`);
  }
  const blend = assertBlend(spec.blend);
  const layer0 = spec.layer0;
  const layer1 = spec.layer1;
  /* 清槽旁路（仅 ScriptSegment）：两层都空是合法形状，普通 SetSegment 不允许。 */
  const clearSlot =
    allowClearSlot &&
    layer0 !== undefined &&
    layer0 !== null &&
    layer0.type === NO_EFFECT &&
    layer1 !== undefined &&
    layer1 !== null &&
    layer1.type === NO_EFFECT;
  if ((layer0 === undefined || layer0 === null || layer0.type === NO_EFFECT) && !clearSlot) {
    throw new RangeError("layer0 不能为空");
  }
  if (layer1 === undefined || layer1 === null) {
    throw new RangeError("layer1 必须给出（空层用 type = 0xFF）");
  }
  if (layer1.type === NO_EFFECT && blend !== BLEND.OVER) {
    throw new RangeError(`layer1 为空时 blend 必须为 0（覆盖），收到 ${blend}`);
  }

  const payload = new Uint8Array(SEGMENT_BYTES);
  payload[0] = stripId;
  payload[1] = segId;
  payload[2] = start;
  payload[3] = end;
  payload[4] = blend;
  writeLayer(payload, SEGMENT_HEADER_BYTES, layer0, "layer0");
  writeLayer(payload, SEGMENT_HEADER_BYTES + LAYER_BYTES, layer1, "layer1");
  return payload;
}

/**
 * SetSegment 0x10：23 字节两层载荷（§7.1）。
 *
 * 接受 `SegmentSpec`（两层）或页面沿用的扁平 `SegmentConfig`（自动补空层、
 * blend = 覆盖）。扁平输入等效于「只设层 0」。
 */
export function cmdSetSegment(segment: SegmentSpec | SegmentConfig): CommandRequest {
  const spec = isSegmentSpec(segment) ? segment : toSpec(segment);
  return { command: 0x10, payload: encodeSegmentPayload(spec) };
}

/**
 * 构造一个静态层（hue 0-65535、sat 0-255、level 0-100）。
 *
 * `level` 省略时是 100（满亮，等价 v3 行为）——测试与内部装配都按这个默认走，
 * 只有真正的亮度滑块才会传其它值。
 */
export function staticLayer(hue: number, sat: number, level: number = LAYER_LEVEL_MAX): EffectLayer {
  return { type: SEGMENT_TYPE.STATIC, hue, sat, periodMs: 0, p5: 0, flags: 0, level };
}

/**
 * 构造一个静态段草稿（扁平 UI 形状）。
 *
 * 只是数据装配（不校验）；校验全部在 cmdSetSegment。
 */
export function staticSegment(
  stripId: number,
  segId: number,
  start: number,
  end: number,
  hue: number,
  sat: number,
): SegmentConfig {
  return {
    stripId,
    segId,
    start,
    end,
    type: SEGMENT_TYPE.STATIC,
    hue,
    sat,
    periodMs: 0,
    p5: 0,
    flags: 0,
  };
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
 * 构造一个呼吸段草稿。
 *
 * `minLevel` 是「最暗时的亮度占比」**百分比 0-100**（v4 起；v3 是绝对 0-255）。
 * `waveform` 取 WAVEFORM 枚举；`reverse` 写进 flags bit0（当前无视觉意义，保留）。
 *
 * 扁平草稿不带 `level`：写成线上 spec 时由 `toSpec` 补 100（满亮）。
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

/* ---------------- 彩虹 / 流光 ---------------- */

/**
 * 彩虹 / 流光的 flags 字节（effects-spec §2.3-§2.4）：
 *   bit0 reverse；**bit1-7 保留 = 0**（与呼吸不同，这里没有 waveform 位）。
 */
export function directionFlags(reverse = false): number {
  return reverse ? 0x01 : 0x00;
}

/** 从 flags 解出反向标志（bit0）。彩虹与流光共用。 */
export function segmentReverse(flags: number): boolean {
  return (flags & 0x01) !== 0;
}

/** 构造一个彩虹段草稿（`span` 0-255，见 effects-spec §2.3）。 */
export function rainbowSegment(
  stripId: number,
  segId: number,
  start: number,
  end: number,
  hue: number,
  sat: number,
  periodMs: number,
  span: number,
  reverse = false,
): SegmentConfig {
  return {
    stripId,
    segId,
    start,
    end,
    type: SEGMENT_TYPE.RAINBOW,
    hue,
    sat,
    periodMs,
    p5: span,
    flags: directionFlags(reverse),
  };
}

/**
 * 流光的 flags 字节（#98）：把「反向 / 实色拖尾 / 头数量」打包进已有的 1 字节。
 *
 * `heads` 是**同时有几个流星头**（1-4）；传错值直接抛错而不是钳位——
 * 密度是要被用户看见的意图，静默改成 4 个头比报错更难查。
 */
export function cometFlags(
  heads: number,
  options: { reverse?: boolean; solidTail?: boolean } = {},
): number {
  if (!Number.isInteger(heads) || heads < COMET_HEADS_MIN || heads > COMET_HEADS_MAX) {
    throw new RangeError(
      `流星头数量必须是 ${COMET_HEADS_MIN}-${COMET_HEADS_MAX} 的整数，收到 ${heads}`,
    );
  }
  let flags = ((heads - 1) << COMET_DENSITY_SHIFT) & COMET_DENSITY_MASK;
  if (options.reverse) {
    flags |= COMET_FLAG.REVERSE;
  }
  if (options.solidTail) {
    flags |= COMET_FLAG.SOLID_TAIL;
  }
  return flags;
}

/** 从流光 flags 解出头数量（1-4）。 */
export function cometHeads(flags: number): number {
  return ((flags & COMET_DENSITY_MASK) >> COMET_DENSITY_SHIFT) + 1;
}

/** 流光是否使用实色拖尾（flags bit1；关 = 现有的指数渐隐）。 */
export function cometSolidTail(flags: number): boolean {
  return (flags & COMET_FLAG.SOLID_TAIL) !== 0;
}

/** 构造一个流光段草稿（`tail` 0-255，见 effects-spec §2.4）。 */
export function cometSegment(
  stripId: number,
  segId: number,
  start: number,
  end: number,
  hue: number,
  sat: number,
  periodMs: number,
  tail: number,
  reverse = false,
): SegmentConfig {
  return {
    stripId,
    segId,
    start,
    end,
    type: SEGMENT_TYPE.COMET,
    hue,
    sat,
    periodMs,
    p5: tail,
    flags: directionFlags(reverse),
  };
}

/** ClearSegment 0x11：载荷 `strip_id, seg_id`。 */
export function cmdClearSegment(stripId: number, segId: number): CommandRequest {
  return { command: 0x11, payload: new Uint8Array([assertStripId(stripId), assertSegId(segId)]) };
}

/** QueryStrip 0x12：载荷 `strip_id`。 */
export function cmdQueryStrip(stripId: number): CommandRequest {
  return { command: 0x12, payload: new Uint8Array([assertStripId(stripId)]) };
}

/* ---------------- 灯带开关 / 配置查询（v3 新增） ---------------- */

/** SetStripPower 0x1B：载荷 `strip_id, on`（§9.5）。 */
export function cmdSetStripPower(stripId: number, on: boolean): CommandRequest {
  return {
    command: 0x1b,
    payload: new Uint8Array([assertStripId(stripId), on ? 1 : 0]),
  };
}

/** QueryStripConfig 0x1C：无载荷；响应 StripConfigReport 0x87（24 字节）。 */
export function cmdQueryStripConfig(): CommandRequest {
  return { command: 0x1c, payload: new Uint8Array(0) };
}

/** QueryDeviceInfo 0x1D：无载荷；响应 DeviceInfoReport 0x88（15 字节）。 */
export function cmdQueryDeviceInfo(): CommandRequest {
  return { command: 0x1d, payload: new Uint8Array(0) };
}

/* ---------------- 剧本 ---------------- */

/** script_id 必须是 0-3（MAX_SCRIPTS = 4）。 */
function assertScriptId(scriptId: number): number {
  if (!Number.isInteger(scriptId) || scriptId < 0 || scriptId >= MAX_SCRIPTS) {
    throw new RangeError(`script_id 必须是 0-${MAX_SCRIPTS - 1} 的整数，收到 ${scriptId}`);
  }
  return scriptId;
}

/** 阶段下标 0-7（MAX_STAGES = 8）。 */
function assertStageIndex(stageIndex: number): number {
  if (!Number.isInteger(stageIndex) || stageIndex < 0 || stageIndex >= MAX_STAGES) {
    throw new RangeError(`stage_index 必须是 0-${MAX_STAGES - 1} 的整数，收到 ${stageIndex}`);
  }
  return stageIndex;
}

/** 阶段时长 1-65535（0 非法：设备会拒）。 */
function assertDuration(durationMs: number): number {
  if (!Number.isInteger(durationMs) || durationMs < 1 || durationMs > MAX_STAGE_MS) {
    throw new RangeError(`阶段时长必须是 1-${MAX_STAGE_MS} 的整数，收到 ${durationMs}`);
  }
  return durationMs;
}

/**
 * 循环模式的线上字节校验（#98）：只接受 0 / 1 / 2。
 *
 * 布尔入参是**编码器这一层的兼容**（true → 1、false → 0），只留给历史测试与
 * 老调用点。#114 之后上层（`session.setPlayback` / `activateScript` /
 * `ScriptPlanOptions.loop`）一律收 `LoopMode`，布尔在那里过不了编译——所以
 * 这里折算不会成为一个「把三值压平」的推导点。
 *
 * **不钳位**：3 会被固件按 InvalidParam 拒，这里先拒。
 */
function assertLoopMode(value: number | boolean): number {
  if (typeof value === "boolean") {
    return value ? LOOP.ALL : LOOP.NONE;
  }
  if (!Number.isInteger(value) || value < 0 || value > LOOP_MAX) {
    throw new RangeError(`loop 必须是 ${LOOP.NONE}(不循环) / ${LOOP.ALL}(全部循环) / ` +
      `${LOOP.LAST}(最后一步循环)，收到 ${value}`);
  }
  return value;
}

/**
 * SetPlayback 0x13：载荷 `action, loop`。
 *
 * action：0 stop（播放头回 stage 0）/ 1 play（从当前播放头，暂停后即继续）/
 * 2 pause（冻结播放头与画面）。loop 在三种 action 下都写入。
 *
 * loop 是**三值**（#98）：0 不循环 / 1 全部循环 / 2 最后一步循环；也接受旧的
 * 布尔写法（true = 1、false = 0）。
 */
export function cmdSetPlayback(action: number, loop: number | boolean): CommandRequest {
  if (!Number.isInteger(action) || action < 0 || action > 2) {
    throw new RangeError(`action 必须是 0(stop) / 1(play) / 2(pause)，收到 ${action}`);
  }
  return { command: 0x13, payload: new Uint8Array([action, assertLoopMode(loop)]) };
}

/**
 * ScriptBegin 0x14：载荷 `script_id, stage_count, strip_count`。
 *
 * v3 修复：strip_count 允许 8（v2 误用 strip_id 的 0-7 校验，最多只能声明 7 条）。
 */
export function cmdScriptBegin(
  scriptId: number,
  stageCount: number,
  stripCount: number,
): CommandRequest {
  const id = assertScriptId(scriptId);
  if (!Number.isInteger(stageCount) || stageCount < 1 || stageCount > MAX_STAGES) {
    throw new RangeError(`stage_count 必须是 1-${MAX_STAGES} 的整数，收到 ${stageCount}`);
  }
  return {
    command: 0x14,
    payload: new Uint8Array([id, stageCount, assertStripCount(stripCount)]),
  };
}

/**
 * ScriptStage 0x15：载荷 `script_id, stage_index, duration(2 LE), fade(2 LE)`。
 *
 * `fadeMs` 是格式预留：协议允许非 0（设备接受并存储），但当前播放行为仍是硬切。
 */
export function cmdScriptStage(
  scriptId: number,
  stageIndex: number,
  durationMs: number,
  fadeMs = 0,
): CommandRequest {
  const id = assertScriptId(scriptId);
  const stage = assertStageIndex(stageIndex);
  const duration = assertDuration(durationMs);
  const fade = assertUint16(fadeMs, "fade_ms");
  return {
    command: 0x15,
    payload: new Uint8Array([
      id,
      stage,
      duration & 0xff,
      (duration >> 8) & 0xff,
      fade & 0xff,
      (fade >> 8) & 0xff,
    ]),
  };
}

/**
 * ScriptSegment 0x16：载荷 `script_id, stage_index` + 23 字节段 = 25 字节。
 *
 * 两层段与扁平段都接受（扁平自动补空层）。
 *
 * **清槽旁路**：两层都是 `0xFF` 表示「清空该槽位」（§9.6）。它绕过 shape 校验
 * （layer0 = 0xFF 本身是非法形状），所以必须单独要求两层的 `level` 都为 0——
 * 带亮度说明发送端把「清槽」和「压暗」混了，设备会回 `InvalidParam`。
 */
export function cmdScriptSegment(
  scriptId: number,
  stageIndex: number,
  segment: SegmentSpec | SegmentConfig,
): CommandRequest {
  const id = assertScriptId(scriptId);
  const stage = assertStageIndex(stageIndex);
  const spec = isSegmentSpec(segment) ? segment : toSpec(segment);
  if (spec.layer0.type === NO_EFFECT && spec.layer1.type === NO_EFFECT) {
    assertLevel(spec.layer0.level, "layer0");
    assertLevel(spec.layer1.level, "layer1");
    if (spec.layer0.level !== 0 || spec.layer1.level !== 0) {
      throw new RangeError("清空槽位时两层的 level 都必须为 0");
    }
  }
  const body = encodeSegmentPayload(spec, true);
  const payload = new Uint8Array(SCRIPT_SEGMENT_BYTES);
  payload[0] = id;
  payload[1] = stage;
  payload.set(body, 2);
  return { command: 0x16, payload };
}

/** ScriptCommit 0x17：载荷 `script_id`。 */
export function cmdScriptCommit(scriptId: number): CommandRequest {
  return { command: 0x17, payload: new Uint8Array([assertScriptId(scriptId)]) };
}

/** ScriptAbort 0x18：载荷 `script_id`。 */
export function cmdScriptAbort(scriptId: number): CommandRequest {
  return { command: 0x18, payload: new Uint8Array([assertScriptId(scriptId)]) };
}

/**
 * ActivateScript 0x19：载荷 `script_id, loop`。
 *
 * loop 同样是三值（#98），也接受旧的布尔写法。
 */
export function cmdActivateScript(scriptId: number, loop: number | boolean): CommandRequest {
  return {
    command: 0x19,
    payload: new Uint8Array([assertScriptId(scriptId), assertLoopMode(loop)]),
  };
}

/** QueryScript 0x1A：载荷 `script_id`。 */
export function cmdQueryScript(scriptId: number): CommandRequest {
  return { command: 0x1a, payload: new Uint8Array([assertScriptId(scriptId)]) };
}

/**
 * ClearScript 0x1E（#73）：载荷 `script_id`，真正从设备上删掉这套已提交剧本。
 *
 * 未提交即成功（幂等）；清掉的正是激活剧本时设备停播并退回「无激活剧本」。
 * 设备回 `0x00` 成功 / `0x01` id 越界 / `0x06` 存储失败（此时原剧本仍可用）/
 * `0x02` 旧固件不认识。**协议版本号不变**，旧固件按未知命令安全拒绝。
 */
export function cmdClearScript(scriptId: number): CommandRequest {
  return { command: 0x1e, payload: new Uint8Array([assertScriptId(scriptId)]) };
}

/** 一条 ScriptSummary 0x85（QueryScript 的响应）。 */
export interface ScriptSummary {
  scriptId: number;
  stageCount: number;
  /** 位表见 §7.5：bit0 循环中、bit2 最后一步循环（只对激活剧本有意义）。 */
  flags: number;
  /** flags 解出的循环模式（#98）：0/1/2。 */
  loopMode: number;
  /** 1 = 就是当前激活的剧本。 */
  active: boolean;
}

/** 解析 ScriptSummary 0x85：载荷 `script_id, stage_count, flags, active`。 */
export function parseScriptSummary(payload: Uint8Array): ScriptSummary {
  if (payload.length !== 4) {
    throw new RangeError(`ScriptSummary 载荷必须是 4 字节，收到 ${payload.length}`);
  }
  const active = payload[3];
  if (active > 1) {
    throw new RangeError(`ScriptSummary.active 必须是 0/1，收到 ${active}`);
  }
  if (payload[1] > MAX_STAGES) {
    throw new RangeError(`ScriptSummary.stage_count 不能超过 ${MAX_STAGES}，收到 ${payload[1]}`);
  }
  return {
    scriptId: payload[0],
    stageCount: payload[1],
    flags: payload[2],
    loopMode: loopModeFromFlags(payload[2]),
    active: active === 1,
  };
}

/** 一条 ScriptProgress 0x86：设备侧已接受的帧数（下发进度的补充证据）。 */
export interface ScriptProgress {
  scriptId: number;
  framesWritten: number;
}

/** 解析 ScriptProgress 0x86：载荷 `script_id, frames_lo, frames_hi`。 */
export function parseScriptProgress(payload: Uint8Array): ScriptProgress {
  if (payload.length !== 3) {
    throw new RangeError(`ScriptProgress 载荷必须是 3 字节，收到 ${payload.length}`);
  }
  return {
    scriptId: payload[0],
    framesWritten: payload[1] | (payload[2] << 8),
  };
}

/** 层编码里 `level` 的字节偏移（type 0、参数 1..7、level 8）。 */
const LAYER_LEVEL_OFFSET = 8;

/**
 * 解析 9 字节定宽层（§7.1）。
 *
 * 未知 type、静态层保留字节非 0、空层带非零参数、level > 100、**呼吸层
 * `p5 > 100`** 都视为协议不匹配（不「尽量解析」，不静默钳位）。
 *
 * 呼吸的 `p5` 在 v4 里是最暗基线的**相对百分比**（0-100），不是 v3 的绝对
 * 0-255。101-255 在固件侧回 `InvalidParam`，所以这里同样拒绝——两端对同一
 * 帧给出同一个判定，才不会出现「App 觉得读回成功、设备其实拒收」的漂移。
 */
export function parseLayer(bytes: Uint8Array, offset = 0): EffectLayer {
  if (bytes.length < offset + LAYER_BYTES) {
    throw new RangeError(`层编码需要 ${LAYER_BYTES} 字节，收到 ${bytes.length - offset}`);
  }
  const type = bytes[offset];
  const level = bytes[offset + LAYER_LEVEL_OFFSET];
  if (level > LAYER_LEVEL_MAX) {
    throw new RangeError(`层的 level 必须在 0-${LAYER_LEVEL_MAX}，收到 ${level}`);
  }
  if (type === NO_EFFECT) {
    /* 空层：type 之外的 8 字节（参数 + level）必须全 0（§7.1 第 3 步）。 */
    for (let i = offset + 1; i < offset + LAYER_BYTES; i += 1) {
      if (bytes[i] !== 0) {
        throw new RangeError(`空层的参数与 level 必须为 0，偏移 ${i} 收到 0x${bytes[i].toString(16)}`);
      }
    }
    return { type: NO_EFFECT, hue: 0, sat: 0, periodMs: 0, p5: 0, flags: 0, level: 0 };
  }
  if (!isKnownLayerType(type)) {
    throw new RangeError(`层的类型未知：0x${type.toString(16)}`);
  }
  const layer: EffectLayer = {
    type,
    hue: bytes[offset + 1] | (bytes[offset + 2] << 8),
    sat: bytes[offset + 3],
    periodMs: 0,
    p5: 0,
    flags: 0,
    level,
  };
  if (type === SEGMENT_TYPE.STATIC) {
    /* 静态层的保留位 param[3..6]（偏移 4..7）必须是 0；level 在 8，不受这条约束。 */
    for (let i = offset + 4; i < offset + LAYER_LEVEL_OFFSET; i += 1) {
      if (bytes[i] !== 0) {
        throw new RangeError(`静态层保留字节必须为 0，偏移 ${i} 收到 0x${bytes[i].toString(16)}`);
      }
    }
    return layer;
  }
  layer.periodMs = bytes[offset + 4] | (bytes[offset + 5] << 8);
  layer.p5 = bytes[offset + 6];
  layer.flags = bytes[offset + 7];
  /* v4：呼吸的 p5 是相对百分比 0-100；彩虹 / 流光的 p5（跨度 / 尾长）仍是
   * 0-255，不受这条约束。 */
  if (type === SEGMENT_TYPE.BREATHING && layer.p5 > 100) {
    throw new RangeError(
      `呼吸层的 p5（最低亮）必须是百分比 0-100，收到 ${layer.p5}`,
    );
  }
  /*
   * #74：新类型在解析侧也要按契约校验——否则读回一条设备已接受的坏配置时
   * App 会静默显示它，两端对同一串字节给出不同结论。
   */
  if (type === SEGMENT_TYPE.STROBE) {
    if (layer.flags !== 0) {
      throw new RangeError(`爆闪层的 flags 必须为 0，收到 0x${layer.flags.toString(16)}`);
    }
    if (layer.periodMs !== 0 && layer.periodMs < STROBE_MIN_PERIOD_MS) {
      throw new RangeError(
        `爆闪周期不能短于 ${STROBE_MIN_PERIOD_MS}ms（10Hz 上界），收到 ${layer.periodMs}`,
      );
    }
  } else if (type === SEGMENT_TYPE.HEARTBEAT) {
    if ((layer.flags & 0xfe) !== 0) {
      throw new RangeError(
        `心跳层的 flags 保留位 bit1-7 必须为 0，收到 0x${layer.flags.toString(16)}`,
      );
    }
    if (
      layer.periodMs !== 0 &&
      (layer.periodMs < HEARTBEAT_MIN_PERIOD_MS || layer.periodMs > HEARTBEAT_MAX_PERIOD_MS)
    ) {
      throw new RangeError(
        `心跳周期必须是 ${HEARTBEAT_MIN_PERIOD_MS}-${HEARTBEAT_MAX_PERIOD_MS}ms，` +
          `收到 ${layer.periodMs}`,
      );
    }
  } else if (type === SEGMENT_TYPE.OFF) {
    if (layer.hue !== 0 || layer.sat !== 0 || layer.periodMs !== 0 || layer.p5 !== 0 ||
        layer.flags !== 0) {
      throw new RangeError("熄灭层的参数必须全为 0");
    }
  } else if (type === SEGMENT_TYPE.FLICKER) {
    /* #98：flags 必须 0；周期 0 或 ≥ 334ms（与写入侧同一条规则）。 */
    if (layer.flags !== 0) {
      throw new RangeError(`随机闪烁层的 flags 必须为 0，收到 0x${layer.flags.toString(16)}`);
    }
    if (layer.periodMs !== 0 && layer.periodMs < FLICKER_MIN_PERIOD_MS) {
      throw new RangeError(
        `随机闪烁周期不能短于 ${FLICKER_MIN_PERIOD_MS}ms，收到 ${layer.periodMs}`,
      );
    }
  } else if (type === SEGMENT_TYPE.COMET) {
    /* #98：bit4-7 保留；bit0-3 是反向 / 实色拖尾 / 头数量。 */
    if ((layer.flags & COMET_FLAGS_RESERVED) !== 0) {
      throw new RangeError(
        `流光层的 flags 保留位 bit4-7 必须为 0，收到 0x${layer.flags.toString(16)}`,
      );
    }
  }
  return layer;
}

/**
 * 解析 23 字节段载荷（SetSegment / SegmentReport 同构，§7.1）。
 *
 * 返回纯 `SegmentSpec`；报告层的扁平兼容字段由 parseSegmentReport 补。
 */
export function parseSegmentPayload(payload: Uint8Array): SegmentSpec {
  if (payload.length !== SEGMENT_BYTES) {
    throw new RangeError(`段载荷必须是 ${SEGMENT_BYTES} 字节，收到 ${payload.length}`);
  }
  const layer0 = parseLayer(payload, SEGMENT_HEADER_BYTES);
  const layer1 = parseLayer(payload, SEGMENT_HEADER_BYTES + LAYER_BYTES);
  const blend = payload[4];
  if (blend > BLEND.ADD) {
    throw new RangeError(`段载荷的 blend 非法：0x${blend.toString(16)}`);
  }
  if (layer0.type === NO_EFFECT) {
    throw new RangeError("段载荷的 layer0 不能为空");
  }
  if (layer1.type === NO_EFFECT && blend !== BLEND.OVER) {
    throw new RangeError(`layer1 为空时 blend 必须为 0，收到 ${blend}`);
  }
  const spec: SegmentSpec = {
    stripId: payload[0],
    segId: payload[1],
    start: payload[2],
    end: payload[3],
    blend: blend as BlendMode,
    layer0,
    layer1,
  };
  if (spec.start > spec.end) {
    throw new RangeError(`段载荷的 start > end：${spec.start} > ${spec.end}`);
  }
  return spec;
}

/**
 * 解析 SegmentReport 0x83（与 SetSegment 载荷同构，固定 23 字节）。
 *
 * 除两层的权威字段外，还给出 layer0 的扁平投影（type/hue/sat/…），
 * 让 #41 之前的页面继续按「单层」读取，不需要改页面代码。
 */
export function parseSegmentReport(payload: Uint8Array): SegmentReport {
  const spec = parseSegmentPayload(payload);
  return { ...spec, ...toFlat(spec) };
}

/** 解析 SegmentListEnd 0x84：载荷 `strip_id, seg_mask`。 */
export function parseSegmentListEnd(payload: Uint8Array): SegmentListEnd {
  if (payload.length !== 2) {
    throw new RangeError(`SegmentListEnd 载荷必须是 2 字节，收到 ${payload.length}`);
  }
  return { stripId: payload[0], segMask: payload[1] };
}

/**
 * 解析 StripConfigReport 0x87：8 路 × `strip_id, gpio, flags`（24 字节）。
 *
 * 记录必须按 0-7 顺序给出（结构不变式）；`assigned` 是 flags bit0 的投影。
 */
export function parseStripConfigReport(payload: Uint8Array): StripConfig {
  if (payload.length !== STRIP_CONFIG_BYTES) {
    throw new RangeError(`StripConfigReport 载荷必须是 ${STRIP_CONFIG_BYTES} 字节，收到 ${payload.length}`);
  }
  const channels = [];
  for (let i = 0; i < MAX_STRIPS; i += 1) {
    const base = i * STRIP_CONFIG_RECORD_BYTES;
    const stripId = payload[base];
    if (stripId !== i) {
      throw new RangeError(`StripConfigReport 第 ${i} 条的 strip_id 必须是 ${i}，收到 ${stripId}`);
    }
    const flags = payload[base + 2];
    channels.push({
      stripId,
      gpio: payload[base + 1],
      flags,
      assigned: (flags & 0x01) !== 0,
    });
  }
  return { channels };
}

/**
 * 解析 DeviceInfoReport 0x88（15 字节）。
 *
 * **线上字节是小端**（#129）：固件写的是
 * `payload[0] = version & 0xFF` / `payload[1] = version >> 8`
 * （`firmware/main/protocol.c` 的 `encode_device_info`），所以 v4.0 在线上是
 * `00 04`。以前这里按大端读（`payload[0]` 当 major），于是 v4.0 被解成
 * `v0.4（0x0004）`，用户会以为固件该升级了，或者以为自己在用一个不存在的版本。
 *
 * 当初的依据是向量里的 `0400` 与 §7.4 的「major<<8 | minor」——那是一份
 * **按大端抄写**的期望值，和固件的实际输出对不上。以线上现实为准，三处一起改：
 * 这里、`docs/protocol-v4.md`、可执行向量。
 *
 * `hw_id` 是 6 字节 BT MAC，按 `AA:BB:CC:DD:EE:FF` 的自然顺序。
 */
export function parseDeviceInfoReport(payload: Uint8Array): DeviceInfo {
  if (payload.length !== DEVICE_INFO_BYTES) {
    throw new RangeError(`DeviceInfoReport 载荷必须是 ${DEVICE_INFO_BYTES} 字节，收到 ${payload.length}`);
  }
  const firmwareVersion = payload[0] | (payload[1] << 8);
  const firmwareMajor = firmwareVersion >> 8;
  const firmwareMinor = firmwareVersion & 0xff;
  const mac: string[] = [];
  for (let i = 0; i < 6; i += 1) {
    mac.push(payload[2 + i].toString(16).padStart(2, "0").toUpperCase());
  }
  const caps = payload[13];
  return {
    firmwareVersion,
    firmwareMajor,
    firmwareMinor,
    hwId: mac.join(":"),
    maxLeds: payload[8],
    maxStrips: payload[9],
    maxSegments: payload[10],
    maxStages: payload[11],
    maxScripts: payload[12],
    caps,
    supportsTwoLayers: (caps & 0x01) !== 0,
    fadeImplemented: (caps & 0x02) !== 0,
  };
}

/**
 * 解析 37 字节 State（State read 与 StateReport 共用，§7.3）。
 *
 * 长度不符视为协议不匹配，不「尽量解析」、不静默截断。
 * `ledCount` / `segCount` 是 strip 0 的派生投影（供 #41 之前的页面使用）。
 */
export function parseState(payload: Uint8Array): DeviceState {
  if (payload.length !== STATE_BYTES) {
    throw new RangeError(`State 必须是 ${STATE_BYTES} 字节，收到 ${payload.length}`);
  }
  const power = payload[0];
  if (power !== 0 && power !== 1) {
    throw new RangeError(`State.power 必须是 0/1，收到 ${power}`);
  }
  const stripCount = payload[6];
  if (stripCount < 1 || stripCount > MAX_STRIPS) {
    throw new RangeError(`State.strip_count 必须是 1-${MAX_STRIPS}，收到 ${stripCount}`);
  }
  const playbackState = payload[9];
  if (playbackState > 2) {
    throw new RangeError(`State.playback_state 必须是 0-2，收到 ${playbackState}`);
  }

  const stripCounts: number[] = [];
  for (let i = 0; i < MAX_STRIPS; i += 1) {
    const base = 13 + i * 2;
    stripCounts.push(payload[base] | (payload[base + 1] << 8));
  }
  const stripSegCounts: number[] = [];
  for (let i = 0; i < MAX_STRIPS; i += 1) {
    stripSegCounts.push(payload[29 + i]);
  }

  return {
    power,
    brightness: payload[1],
    r: payload[2],
    g: payload[3],
    b: payload[4],
    maxBrightness: payload[5],
    stripCount,
    scriptId: payload[7],
    stageIndex: payload[8],
    playbackState,
    flags: payload[10],
    stripPowerMask: payload[11],
    stripAnimMask: payload[12],
    stripCounts,
    stripSegCounts,
    /* 派生字段：保持 #41 之前的单灯带语义。 */
    ledCount: stripCounts[0],
    segCount: stripSegCounts[0],
  };
}

/** State 里的 `script_active` 位（bit1）。 */
export function stateScriptActive(state: DeviceState): boolean {
  return (state.flags & 0x02) !== 0;
}

/** State 里的 `loop` 位（bit0）：**有循环**（全部或最后一步）。旧语义不变。 */
export function stateLoop(state: DeviceState): boolean {
  return (state.flags & PLAYBACK_FLAG.LOOP) !== 0;
}

/**
 * State 里的循环模式（#98）：0 不循环 / 1 全部循环 / 2 最后一步循环。
 *
 * 位表见 §7.5：bit0 = 循环中、bit2 = 最后一步循环。bit2 单独出现（无 bit0）
 * 是矛盾编码，按不循环处理（与固件 `lumen_loop_from_flags` 一致）。
 */
export function stateLoopMode(state: DeviceState): LoopMode {
  return loopModeFromFlags(state.flags);
}

/** flags → 循环模式（State 与 ScriptSummary 共用同一张位表）。 */
export function loopModeFromFlags(flags: number): LoopMode {
  if ((flags & PLAYBACK_FLAG.LOOP) === 0) {
    return LOOP.NONE;
  }
  return (flags & PLAYBACK_FLAG.LOOP_LAST) !== 0 ? LOOP.LAST : LOOP.ALL;
}

/** 循环模式 → flags（State / ScriptSummary / blob 共用一张表）。 */
export function loopFlags(mode: number): number {
  if (mode === LOOP.NONE) {
    return 0;
  }
  return mode === LOOP.LAST
    ? (PLAYBACK_FLAG.LOOP | PLAYBACK_FLAG.LOOP_LAST)
    : PLAYBACK_FLAG.LOOP;
}

/** 是否有激活剧本（script_id != 0xFF）。 */
export function stateHasScript(state: DeviceState): boolean {
  return state.scriptId !== NO_SCRIPT;
}

/** 某条灯带的独立开关位（`strip_power_mask` 的 bit i）。 */
export function stateStripPower(state: DeviceState, stripId: number): boolean {
  return (state.stripPowerMask & (1 << stripId)) !== 0;
}

/** 某条灯带当前是否有动画类活动段（只作显示提示，§7.3）。 */
export function stateStripAnimated(state: DeviceState, stripId: number): boolean {
  return (state.stripAnimMask & (1 << stripId)) !== 0;
}

/** 某条灯带的灯珠数（越界返回 0，不猜）。 */
export function stateStripLedCount(state: DeviceState, stripId: number): number {
  return state.stripCounts[stripId] ?? 0;
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
