/**
 * 命令构造器与载荷解析（纯函数）。业务范围校验在构造器里做，
 * 字节布局严格按 docs/protocol-v5.md §6 / §7。
 *
 * v5 换的是**模型**，不是「扩一版」：
 *   - v4 的「分区（段）+ 剧本」两族**整体退役**（0x03/0x04 与 0x10-0x1E 回 0x02）；
 *   - 新增布局族 0x20-0x24（灯组 → 部位 → 灯珠段）与场景族 0x25-0x29
 *     （部位 → 步骤 → 两层）；
 *   - State 从 37 字节改为 **32 字节**；报告 0x83-0x86 删除，新增 0x89-0x8D。
 *
 * 层编码仍是 v4 的 9 字节定宽（type + 7 字节参数 + level）；「一步」与 v4 的
 * 「一个段」是同一套层模型，只是宿主从段换成了步。
 *
 * 混合方式**不在线上**（§6.2）：`layer1` 为空 → 覆盖；非空 → 按亮度叠加。
 * 所以这里的构造器不再接受 `blend` 参数。
 */

import {
  ANIMATION_MIN_PERIOD_MS,
  BREATHING_MIN_PERIOD_MS,
  COMET_DENSITY_MASK,
  COMET_DENSITY_SHIFT,
  COMET_FLAG,
  COMET_HEADS_MAX,
  COMET_HEADS_MIN,
  DEVICE_INFO_BYTES,
  EFFECT_TYPE,
  FLICKER_MIN_PERIOD_MS,
  HEARTBEAT_MIN_PERIOD_MS,
  LAYER_BYTES,
  LAYER_LEVEL_MAX,
  LAYOUT_PART_BYTES,
  LAYOUT_REPORT_BYTES,
  PHASE,
  LOOP_MAX,
  MAX_LEDS,
  MAX_PARTS,
  MAX_PART_SEGS,
  MAX_SCENES,
  MAX_STEPS,
  MAX_STRIPS,
  MIN_LEDS,
  NAME_BYTES,
  NO_EFFECT,
  SCENE_NAME_BYTES,
  SCENE_STEP_BYTES,
  STATE_BYTES,
  STEP_MAX_MS,
  STEP_MIN_MS,
  STROBE_MIN_PERIOD_MS,
  STRIP_CONFIG_BYTES,
  STRIP_CONFIG_RECORD_BYTES,
  isKnownEffectType,
} from "./constants";
import type {
  AckResult,
  CommandRequest,
  DeviceInfo,
  DeviceState,
  EffectLayer,
  LayoutListEnd,
  LayoutPart,
  LayoutReport,
  SceneListEnd,
  ScenePartReport,
  SceneReport,
  SceneStep,
  SceneStepReport,
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

function assertRange(value: number, lo: number, hi: number, field: string): number {
  if (!Number.isInteger(value) || value < lo || value > hi) {
    throw new RangeError(`${field} 必须在 ${lo}..${hi}，收到 ${value}`);
  }
  return value;
}

function assertStripId(stripId: number): number {
  return assertRange(stripId, 0, MAX_STRIPS - 1, "stripId");
}

function assertPartId(partId: number): number {
  return assertRange(partId, 0, MAX_PARTS - 1, "partId");
}

function assertSceneId(sceneId: number): number {
  return assertRange(sceneId, 0, MAX_SCENES - 1, "sceneId");
}

function assertHue(value: number): number {
  return assertUint16(value, "hue");
}

function assertLevel(value: number, field: string): number {
  return assertRange(value, 0, LAYER_LEVEL_MAX, field);
}

/* ---------------- 整机 ---------------- */

export function cmdSetPower(on: boolean): CommandRequest {
  return { command: 0x01, payload: new Uint8Array([on ? 1 : 0]) };
}

export function cmdSetBrightness(brightness: number): CommandRequest {
  return { command: 0x02, payload: new Uint8Array([assertByte(brightness, "brightness")]) };
}

export function cmdQueryState(): CommandRequest {
  return { command: 0x05, payload: new Uint8Array([]) };
}

export function cmdSetLedCount(stripId: number, count: number): CommandRequest {
  assertStripId(stripId);
  assertRange(count, MIN_LEDS, MAX_LEDS, "count");
  return {
    command: 0x06,
    payload: new Uint8Array([stripId, count & 0xff, (count >> 8) & 0xff]),
  };
}

export function cmdSelfTest(): CommandRequest {
  return { command: 0x07, payload: new Uint8Array([]) };
}

/* ---------------- 层 / 一步 ---------------- */

/** 该类型的参数块长度（effects-spec §2）：静态 3，其余已知类型 7，未知 0。 */
export function layerParamLength(type: number): number {
  if (type === EFFECT_TYPE.STATIC) {
    return 3;
  }
  return isKnownEffectType(type) ? 7 : 0;
}

/**
 * 空层常量（`type = 0xFF`）。空层的 8 字节参数与 `level` 必须全 0，
 * 否则设备回 `InvalidParam`（§7.1 第 3 步）。
 */
export const EMPTY_LAYER: EffectLayer = {
  type: NO_EFFECT,
  hue: 0,
  sat: 0,
  periodMs: 0,
  p5: 0,
  flags: 0,
  level: 0,
};

export function isLayerEmpty(layer: EffectLayer): boolean {
  return layer.type === NO_EFFECT;
}

function writeLayer(out: Uint8Array, offset: number, layer: EffectLayer, field: string): void {
  const type = layer.type;
  if (type !== NO_EFFECT && !isKnownEffectType(type)) {
    throw new RangeError(`${field}.type 未知：0x${type.toString(16)}`);
  }
  const level = layer.level === undefined ? LAYER_LEVEL_MAX : layer.level;
  if (type === NO_EFFECT) {
    /* 空层：type 之外全 0（含 level）。带亮度直接拒绝，别让设备替我们拒。 */
    if (
      level !== 0 ||
      layer.hue !== 0 ||
      layer.sat !== 0 ||
      layer.periodMs !== 0 ||
      layer.p5 !== 0 ||
      layer.flags !== 0
    ) {
      throw new RangeError(`${field} 是空层，参数与 level 必须全 0`);
    }
    out[offset] = NO_EFFECT;
    for (let i = 1; i < LAYER_BYTES; i++) {
      out[offset + i] = 0;
    }
    return;
  }
  assertLevel(level, `${field}.level`);
  assertHue(layer.hue);
  assertByte(layer.sat, `${field}.sat`);
  assertUint16(layer.periodMs, `${field}.periodMs`);
  assertByte(layer.p5, `${field}.p5`);
  assertByte(layer.flags, `${field}.flags`);
  out[offset] = type;
  out[offset + 1] = layer.hue & 0xff;
  out[offset + 2] = (layer.hue >> 8) & 0xff;
  out[offset + 3] = layer.sat;
  out[offset + 4] = layer.periodMs & 0xff;
  out[offset + 5] = (layer.periodMs >> 8) & 0xff;
  out[offset + 6] = layer.p5;
  out[offset + 7] = layer.flags;
  out[offset + 8] = level;
}

/** 把一层写成 9 字节线格式（对外暴露给需要自己拼载荷的调用方）。 */
export function encodeLayer(layer: EffectLayer, field = "layer"): Uint8Array {
  const out = new Uint8Array(LAYER_BYTES);
  writeLayer(out, 0, layer, field);
  return out;
}

export function parseLayer(bytes: Uint8Array, offset = 0): EffectLayer {
  if (bytes.length < offset + LAYER_BYTES) {
    throw new RangeError(`层需要 ${LAYER_BYTES} 字节，只有 ${bytes.length - offset}`);
  }
  return {
    type: bytes[offset],
    hue: bytes[offset + 1] | (bytes[offset + 2] << 8),
    sat: bytes[offset + 3],
    periodMs: bytes[offset + 4] | (bytes[offset + 5] << 8),
    p5: bytes[offset + 6],
    flags: bytes[offset + 7],
    level: bytes[offset + 8],
  };
}

export function staticLayer(
  hue: number,
  sat: number,
  level: number = LAYER_LEVEL_MAX,
): EffectLayer {
  return {
    type: EFFECT_TYPE.STATIC,
    hue: assertHue(hue),
    sat: assertByte(sat, "sat"),
    periodMs: 0,
    p5: 0,
    flags: 0,
    level: assertLevel(level, "level"),
  };
}

export function breathingFlags(waveform: number, reverse = false): number {
  assertRange(waveform, 0, 3, "waveform");
  return ((waveform & 0x03) << 1) | (reverse ? 0x01 : 0);
}

export function breathingWaveform(flags: number): number {
  return (flags >> 1) & 0x03;
}

export function directionFlags(reverse = false): number {
  return reverse ? 0x01 : 0;
}

export function layerReverse(flags: number): boolean {
  return (flags & 0x01) !== 0;
}

/** 流星 flags（#98）：方向 / 实色拖尾 / 头数量（1-4）打包进已有 1 字节。 */
export function cometFlags(reverse = false, solidTail = false, heads = 1): number {
  assertRange(heads, COMET_HEADS_MIN, COMET_HEADS_MAX, "heads");
  return (
    (reverse ? COMET_FLAG.REVERSE : 0) |
    (solidTail ? COMET_FLAG.SOLID_TAIL : 0) |
    ((heads - 1) << COMET_DENSITY_SHIFT)
  );
}

export function cometHeads(flags: number): number {
  return ((flags & COMET_DENSITY_MASK) >> COMET_DENSITY_SHIFT) + 1;
}

export function cometSolidTail(flags: number): boolean {
  return (flags & COMET_FLAG.SOLID_TAIL) !== 0;
}

/** 该层的周期下限（effects-spec §5）；0 表示静止，不受限。 */
export function minPeriodMs(type: number): number {
  switch (type) {
    case EFFECT_TYPE.BREATHING:
      return BREATHING_MIN_PERIOD_MS;
    case EFFECT_TYPE.RAINBOW:
    case EFFECT_TYPE.COMET:
      return ANIMATION_MIN_PERIOD_MS;
    case EFFECT_TYPE.STROBE:
      return STROBE_MIN_PERIOD_MS;
    case EFFECT_TYPE.FLICKER:
      return FLICKER_MIN_PERIOD_MS;
    case EFFECT_TYPE.HEARTBEAT:
      return HEARTBEAT_MIN_PERIOD_MS;
    default:
      return 0;
  }
}

/* ---------------- 灯组 ---------------- */

export function cmdSetStripPower(stripId: number, on: boolean): CommandRequest {
  assertStripId(stripId);
  return { command: 0x1b, payload: new Uint8Array([stripId, on ? 1 : 0]) };
}

export function cmdQueryStripConfig(): CommandRequest {
  return { command: 0x1c, payload: new Uint8Array([]) };
}

export function cmdQueryDeviceInfo(): CommandRequest {
  return { command: 0x1d, payload: new Uint8Array([]) };
}

/* ---------------- 名字编解码 ---------------- */

/** 极简 UTF-8 编码（小程序环境没有 TextEncoder）。 */
function encodeUtf8(text: string): Uint8Array {
  const out: number[] = [];
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (code <= 0x7f) {
      out.push(code);
    } else if (code <= 0x7ff) {
      out.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    } else if (code <= 0xffff) {
      out.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    } else {
      out.push(
        0xf0 | (code >> 18),
        0x80 | ((code >> 12) & 0x3f),
        0x80 | ((code >> 6) & 0x3f),
        0x80 | (code & 0x3f),
      );
    }
  }
  return Uint8Array.from(out);
}

/** 从 24 字节名里取前 nameLen 字节并按 UTF-8 解码。 */
function decodeName(bytes: Uint8Array, offset: number, len: number): string {
  let text = "";
  const end = Math.min(offset + len, bytes.length);
  for (let i = offset; i < end; ) {
    const b0 = bytes[i];
    let code: number;
    let size: number;
    if (b0 < 0x80) {
      code = b0;
      size = 1;
    } else if ((b0 & 0xe0) === 0xc0) {
      code = ((b0 & 0x1f) << 6) | (bytes[i + 1] & 0x3f);
      size = 2;
    } else if ((b0 & 0xf0) === 0xe0) {
      code = ((b0 & 0x0f) << 12) | ((bytes[i + 1] & 0x3f) << 6) | (bytes[i + 2] & 0x3f);
      size = 3;
    } else if ((b0 & 0xf8) === 0xf0) {
      code =
        ((b0 & 0x07) << 18) |
        ((bytes[i + 1] & 0x3f) << 12) |
        ((bytes[i + 2] & 0x3f) << 6) |
        (bytes[i + 3] & 0x3f);
      size = 4;
    } else {
      /* 非法首字节：跳过（权威数据由设备侧校验）。 */
      i += 1;
      continue;
    }
    text += String.fromCodePoint(code);
    i += size;
  }
  return text;
}

/** UTF-8 编码成 24 字节（NUL 补齐）。超长直接拒绝。 */
export function encodeName(text: string, field = "name"): { bytes: Uint8Array; len: number } {
  const encoded = encodeUtf8(text);
  if (encoded.length > NAME_BYTES) {
    throw new RangeError(`${field} 是 ${encoded.length} 字节，上限 ${NAME_BYTES}`);
  }
  const padded = new Uint8Array(NAME_BYTES);
  padded.set(encoded);
  return { bytes: padded, len: encoded.length };
}

/** 从一段 24 字节名里解出文本（报告解析用）。 */
export function decodeNameBytes(bytes: Uint8Array, offset: number, len: number): string {
  return decodeName(bytes, offset, len);
}

/* ---------------- 布局族 0x20-0x24 ---------------- */

/** LayoutWrite 0x20：声明该链的部位数并清空其部位。 */
export function cmdLayoutWrite(stripId: number, partCount: number): CommandRequest {
  assertStripId(stripId);
  assertRange(partCount, 0, MAX_PARTS, "partCount");
  return { command: 0x20, payload: new Uint8Array([stripId, partCount]) };
}

/** LayoutPart 0x21：strip, part, name_len, name[24], seg_count（28 字节）。 */
export function cmdLayoutPart(
  stripId: number,
  partId: number,
  name: string,
  segCount: number,
  phase: number,
): CommandRequest {
  assertStripId(stripId);
  assertPartId(partId);
  assertRange(segCount, 0, MAX_PART_SEGS, "segCount");
  /* 相位只有两个合法值（§9.2）：越界一帧都不发，设备会回 InvalidParam。 */
  assertRange(phase, PHASE.CONTINUOUS, PHASE.PER_SEGMENT, "phase");
  const { bytes, len } = encodeName(name, "partName");
  const payload = new Uint8Array(LAYOUT_PART_BYTES);
  payload[0] = stripId;
  payload[1] = partId;
  payload[2] = len;
  payload.set(bytes, 3);
  payload[27] = segCount;
  payload[28] = phase;
  return { command: 0x21, payload };
}

/** LayoutSeg 0x22：strip, part, seg, start, end。 */
export function cmdLayoutSeg(
  stripId: number,
  partId: number,
  segId: number,
  start: number,
  end: number,
): CommandRequest {
  assertStripId(stripId);
  assertPartId(partId);
  assertRange(segId, 0, MAX_PART_SEGS - 1, "segId");
  assertByte(start, "start");
  assertByte(end, "end");
  if (start > end) {
    throw new RangeError(`区间非法：start(${start}) > end(${end})`);
  }
  return { command: 0x22, payload: new Uint8Array([stripId, partId, segId, start, end]) };
}

/** LayoutCommit 0x23：整份校验并立即落盘。 */
export function cmdLayoutCommit(): CommandRequest {
  return { command: 0x23, payload: new Uint8Array([]) };
}

/** QueryLayout 0x24：strip。 */
export function cmdQueryLayout(stripId: number): CommandRequest {
  assertStripId(stripId);
  return { command: 0x24, payload: new Uint8Array([stripId]) };
}

/* ---------------- 场景族 0x25-0x29 ---------------- */

/** ScenePart 0x25：scene, strip, part, step_count, loop, on。 */
export function cmdScenePart(
  sceneId: number,
  stripId: number,
  partId: number,
  stepCount: number,
  loop: number,
  on: boolean,
): CommandRequest {
  assertSceneId(sceneId);
  assertStripId(stripId);
  assertPartId(partId);
  assertRange(stepCount, 0, MAX_STEPS, "stepCount");
  assertRange(loop, 0, LOOP_MAX, "loop");
  return {
    command: 0x25,
    payload: new Uint8Array([sceneId, stripId, partId, stepCount, loop, on ? 1 : 0]),
  };
}

/** SceneStep 0x26：scene, strip, part, step, duration(2), layer0(9), layer1(9)。 */
export function cmdSceneStep(step: SceneStep): CommandRequest {
  assertSceneId(step.sceneId);
  assertStripId(step.stripId);
  assertPartId(step.partId);
  assertRange(step.stepIndex, 0, MAX_STEPS - 1, "stepIndex");
  assertRange(step.durationMs, STEP_MIN_MS, STEP_MAX_MS, "durationMs");
  const payload = new Uint8Array(SCENE_STEP_BYTES);
  payload[0] = step.sceneId;
  payload[1] = step.stripId;
  payload[2] = step.partId;
  payload[3] = step.stepIndex;
  payload[4] = step.durationMs & 0xff;
  payload[5] = (step.durationMs >> 8) & 0xff;
  writeLayer(payload, 6, step.layer0, "layer0");
  writeLayer(payload, 15, step.layer1 ?? EMPTY_LAYER, "layer1");
  return { command: 0x26, payload };
}

/** SceneName 0x27：scene, name_len, name[24]（26 字节）。 */
export function cmdSceneName(sceneId: number, name: string): CommandRequest {
  assertSceneId(sceneId);
  const { bytes, len } = encodeName(name, "sceneName");
  const payload = new Uint8Array(SCENE_NAME_BYTES);
  payload[0] = sceneId;
  payload[1] = len;
  payload.set(bytes, 2);
  return { command: 0x27, payload };
}

/** ActivateScene 0x28：scene。 */
export function cmdActivateScene(sceneId: number): CommandRequest {
  assertSceneId(sceneId);
  return { command: 0x28, payload: new Uint8Array([sceneId]) };
}

/** QueryScene 0x29：scene。 */
export function cmdQueryScene(sceneId: number): CommandRequest {
  assertSceneId(sceneId);
  return { command: 0x29, payload: new Uint8Array([sceneId]) };
}

/* ---------------- 设备 → 小程序 ---------------- */

/** LayoutReport 0x89（44 字节，§7.2）。 */
export function parseLayoutReport(payload: Uint8Array): LayoutReport {
  if (payload.length !== LAYOUT_REPORT_BYTES) {
    throw new RangeError(`LayoutReport 需要 ${LAYOUT_REPORT_BYTES} 字节，收到 ${payload.length}`);
  }
  const nameLen = payload[2];
  const segCount = payload[27];
  const segs: Array<[number, number]> = [];
  for (let i = 0; i < segCount && i < MAX_PART_SEGS; i++) {
    segs.push([payload[29 + i * 2], payload[30 + i * 2]]);
  }
  return {
    stripId: payload[0],
    partId: payload[1],
    nameLen,
    name: decodeName(payload, 3, nameLen),
    segCount,
    phase: payload[28],
    segs,
  };
}

/** LayoutListEnd 0x8A（2 字节）：strip_id, part_mask。 */
export function parseLayoutListEnd(payload: Uint8Array): LayoutListEnd {
  if (payload.length !== 2) {
    throw new RangeError(`LayoutListEnd 需要 2 字节，收到 ${payload.length}`);
  }
  return { stripId: payload[0], partMask: payload[1] };
}

/** ScenePartReport 0x8B（6 字节）。 */
export function parseScenePartReport(payload: Uint8Array): ScenePartReport {
  if (payload.length !== 6) {
    throw new RangeError(`ScenePartReport 需要 6 字节，收到 ${payload.length}`);
  }
  return {
    sceneId: payload[0],
    stripId: payload[1],
    partId: payload[2],
    stepCount: payload[3],
    loop: payload[4],
    on: payload[5] !== 0,
  };
}

/** SceneStepReport 0x8C（24 字节，与 SceneStep 同构）。 */
export function parseSceneStepReport(payload: Uint8Array): SceneStepReport {
  if (payload.length !== SCENE_STEP_BYTES) {
    throw new RangeError(`SceneStepReport 需要 ${SCENE_STEP_BYTES} 字节，收到 ${payload.length}`);
  }
  return {
    sceneId: payload[0],
    stripId: payload[1],
    partId: payload[2],
    stepIndex: payload[3],
    durationMs: payload[4] | (payload[5] << 8),
    layer0: parseLayer(payload, 6),
    layer1: parseLayer(payload, 15),
  };
}

/** SceneListEnd 0x8D（26 字节）：scene_id, name_len, name[24]。 */
export function parseSceneListEnd(payload: Uint8Array): SceneListEnd {
  if (payload.length !== SCENE_NAME_BYTES) {
    throw new RangeError(`SceneListEnd 需要 ${SCENE_NAME_BYTES} 字节，收到 ${payload.length}`);
  }
  const nameLen = payload[1];
  return { sceneId: payload[0], nameLen, name: decodeName(payload, 2, nameLen) };
}

/** StripConfigReport 0x87（24 字节）。 */
export function parseStripConfigReport(payload: Uint8Array): StripConfig {
  if (payload.length !== STRIP_CONFIG_BYTES) {
    throw new RangeError(
      `StripConfigReport 需要 ${STRIP_CONFIG_BYTES} 字节，收到 ${payload.length}`,
    );
  }
  const channels = [];
  for (let i = 0; i < STRIP_CONFIG_BYTES / STRIP_CONFIG_RECORD_BYTES; i++) {
    const base = i * STRIP_CONFIG_RECORD_BYTES;
    const flags = payload[base + 2];
    channels.push({
      stripId: payload[base],
      gpio: payload[base + 1],
      flags,
      assigned: (flags & 0x01) !== 0,
    });
  }
  return { channels };
}

/** DeviceInfoReport 0x88（15 字节，§7.4）。 */
export function parseDeviceInfoReport(payload: Uint8Array): DeviceInfo {
  if (payload.length !== DEVICE_INFO_BYTES) {
    throw new RangeError(`DeviceInfoReport 需要 ${DEVICE_INFO_BYTES} 字节，收到 ${payload.length}`);
  }
  const version = payload[0] | (payload[1] << 8);
  const mac: string[] = [];
  for (let i = 2; i < 8; i++) {
    mac.push(payload[i].toString(16).padStart(2, "0").toUpperCase());
  }
  const caps = payload[14];
  return {
    firmwareVersion: version,
    firmwareMajor: version >> 8,
    firmwareMinor: version & 0xff,
    hwId: mac.join(":"),
    maxLeds: payload[8],
    maxStrips: payload[9],
    maxParts: payload[10],
    maxPartSegs: payload[11],
    maxSteps: payload[12],
    maxScenes: payload[13],
    caps,
    supportsTwoLayers: (caps & 0x01) !== 0,
    fadeImplemented: (caps & 0x02) !== 0,
  };
}

/** State 0x82 / State read（32 字节，§7.3）。 */
export function parseState(payload: Uint8Array): DeviceState {
  if (payload.length !== STATE_BYTES) {
    throw new RangeError(`State 需要 ${STATE_BYTES} 字节，收到 ${payload.length}`);
  }
  const stripLedCounts: number[] = [];
  for (let i = 0; i < MAX_STRIPS; i++) {
    stripLedCounts.push(payload[8 + i * 2] | (payload[9 + i * 2] << 8));
  }
  const partCounts: number[] = [];
  for (let i = 0; i < MAX_STRIPS; i++) {
    partCounts.push(payload[24 + i]);
  }
  return {
    power: payload[0] === 1 ? 1 : 0,
    brightness: payload[1],
    maxBrightness: payload[2],
    stripCount: payload[3],
    stripPowerMask: payload[4],
    activeScene: payload[5],
    layoutValid: payload[6] !== 0,
    stripLedCounts,
    partCounts,
  };
}

export function stateStripPower(state: DeviceState, stripId: number): boolean {
  return (state.stripPowerMask & (1 << stripId)) !== 0;
}

export function stateStripLedCount(state: DeviceState, stripId: number): number {
  return state.stripLedCounts[stripId] ?? 0;
}

export function statePartCount(state: DeviceState, stripId: number): number {
  return state.partCounts[stripId] ?? 0;
}

export function parseAck(payload: Uint8Array, seq: number): AckResult {
  if (payload.length !== 2) {
    throw new RangeError(`ACK 需要 2 字节，收到 ${payload.length}`);
  }
  return {
    seq,
    command: payload[0],
    resultCode: payload[1],
    ok: payload[1] === 0,
  };
}

/**
 * 把「逐部位 / 逐步骤报告」组装成一份场景读回（QueryScene 的收尾）。
 *
 * 设备按部位头 → 每步 → 收尾的顺序发，本函数只做分组，不做校验。
 */
export function buildSceneReport(
  sceneId: number,
  name: string,
  parts: ScenePartReport[],
  steps: SceneStepReport[],
): SceneReport {
  return { sceneId, name, parts, steps };
}

/** 部位在一帧里覆盖的灯珠总数。 */
export function partPixelCount(part: LayoutPart): number {
  let total = 0;
  for (const [start, end] of part.segs) {
    if (end >= start) {
      total += end - start + 1;
    }
  }
  return total;
}
