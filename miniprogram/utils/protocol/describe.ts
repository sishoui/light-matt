/**
 * 日志用的帧描述（纯函数，不依赖 wx.*）。
 *
 * 固件串口每帧打印 `cmd=0x.. seq=0x.. result=0x..`；小程序面板与 console
 * 用本模块生成同构的解析文本，两边靠 seq 对齐（spec §11）。
 *
 * 原则：命令名 + 参数都从字节里解析，不猜、不省略；解析不了时退回 hex，
 * 保证日志永远有可对照的原始数据。
 *
 * v4：段载荷定宽 23/25 字节、两层（每层 9 字节，含 v4 的 level）；State 37 字节。
 * 日志必须把两层（含各自亮度）都写出来，否则「设备上的第二层」与「某层被压暗」
 * 在排查时完全不可见。
 */

import {
  BLEND,
  CMD,
  DEVICE_CMD,
  MAX_STRIPS,
  NO_EFFECT,
  NO_SCRIPT,
  SCRIPT_SEGMENT_BYTES,
  SEGMENT_TYPE,
  STATE_BYTES,
  WAVEFORM_NAMES,
  commandName,
} from "./constants";
import {
  breathingWaveform,
  parseDeviceInfoReport,
  parseSegmentPayload,
  parseState,
  parseStripConfigReport,
  segmentReverse,
} from "./commands";
import type { ScriptProgress, ScriptSummary } from "./commands";
import { bytesToHex } from "./hex";
import type {
  AckResult,
  DeviceInfo,
  DeviceState,
  EffectLayer,
  SegmentListEnd,
  SegmentReport,
  SegmentSpec,
  StripConfig,
} from "./types";

function hex2(value: number): string {
  return `0x${(value & 0xff).toString(16).padStart(2, "0").toUpperCase()}`;
}

/** 呼吸波形名（effects-spec §2.2）；未知值原样给数字。 */
function waveformName(waveform: number): string {
  return WAVEFORM_NAMES[waveform] ?? `wave${waveform}`;
}

/** 层类型名（日志可读性，不参与协议）；未知类型给 hex。 */
export function layerTypeName(type: number): string {
  switch (type) {
    case SEGMENT_TYPE.STATIC:
      return "static";
    case SEGMENT_TYPE.BREATHING:
      return "breathing";
    case SEGMENT_TYPE.RAINBOW:
      return "rainbow";
    case SEGMENT_TYPE.COMET:
      return "comet";
    case NO_EFFECT:
      return "empty";
    default:
      return `type${hex2(type)}`;
  }
}

/** blend 名（§7.2）。 */
export function blendName(blend: number): string {
  switch (blend) {
    case BLEND.OVER:
      return "over";
    case BLEND.MULTIPLY:
      return "multiply";
    case BLEND.ADD:
      return "add";
    default:
      return `blend${blend}`;
  }
}

/**
 * 一层的展示文本，按 type 解释同一个 p5 字段，并带上 v4 的 `level`：
 *   0x00 静态：`static(hue=.. sat=.. level=..)`；
 *   0x01 呼吸：period / min_level(百分比) / waveform；
 *   0x02 彩虹：period / span / reverse；
 *   0x03 流光：period / tail / reverse；
 *   0xFF 空层：`empty`（空层没有亮度可言，不写 level）。
 */
export function describeLayer(layer: EffectLayer): string {
  const name = layerTypeName(layer.type);
  if (layer.type === NO_EFFECT) {
    return name;
  }
  const head = `${name}(hue=${layer.hue} sat=${layer.sat} level=${layer.level}`;
  if (layer.type === SEGMENT_TYPE.STATIC) {
    return `${head})`;
  }
  if (layer.type === SEGMENT_TYPE.BREATHING) {
    return (
      `${head} period=${layer.periodMs} min_level=${layer.p5} ` +
      `waveform=${waveformName(breathingWaveform(layer.flags))} flags=${hex2(layer.flags)})`
    );
  }
  const p5Name = layer.type === SEGMENT_TYPE.RAINBOW ? "span" : "tail";
  return (
    `${head} period=${layer.periodMs} ${p5Name}=${layer.p5} ` +
    `reverse=${segmentReverse(layer.flags) ? 1 : 0} flags=${hex2(layer.flags)})`
  );
}

/** 两层段的正文（SetSegment / ScriptSegment / SegmentReport 共用）。 */
function segmentText(spec: SegmentSpec): string {
  return (
    `strip=${spec.stripId} seg=${spec.segId} range=${spec.start}-${spec.end} ` +
    `blend=${blendName(spec.blend)} layer0=${describeLayer(spec.layer0)} ` +
    `layer1=${describeLayer(spec.layer1)}`
  );
}

/** 载荷能否按 23 字节段解析（不能就退回 hex，不猜半截参数）。 */
function trySegment(payload: Uint8Array): SegmentSpec | null {
  try {
    return parseSegmentPayload(payload);
  } catch {
    return null;
  }
}

/** 小程序 → 设备命令：命令名 + 从载荷解析出的参数。 */
export function describeCommand(command: number, payload: Uint8Array): string {
  const name = commandName(command);
  switch (command) {
    case CMD.SET_POWER:
      return payload.length === 1 ? `${name} power=${payload[0]}` : `${name} ${bytesToHex(payload)}`;
    case CMD.SET_BRIGHTNESS:
      return payload.length === 1
        ? `${name} brightness=${payload[0]}`
        : `${name} ${bytesToHex(payload)}`;
    case CMD.QUERY_STATE:
    case CMD.SELF_TEST:
    case CMD.QUERY_STRIP_CONFIG:
    case CMD.QUERY_DEVICE_INFO:
      return name;
    case CMD.SET_LED_COUNT:
      return payload.length === 3
        ? `${name} strip=${payload[0]} count=${payload[1] | (payload[2] << 8)}`
        : `${name} ${bytesToHex(payload)}`;
    case CMD.SET_SEGMENT: {
      const spec = trySegment(payload);
      return spec === null ? fallback(name, payload) : `${name} ${segmentText(spec)}`;
    }
    case CMD.CLEAR_SEGMENT:
      return payload.length === 2
        ? `${name} strip=${payload[0]} seg=${payload[1]}`
        : `${name} ${bytesToHex(payload)}`;
    case CMD.QUERY_STRIP:
      return payload.length === 1 ? `${name} strip=${payload[0]}` : `${name} ${bytesToHex(payload)}`;
    case CMD.SET_STRIP_POWER:
      return payload.length === 2
        ? `${name} strip=${payload[0]} on=${payload[1]}`
        : `${name} ${bytesToHex(payload)}`;
    case CMD.SET_PLAYBACK:
      /* action 0 stop / 1 play / 2 pause；loop 是持久化字段（§10.5）。 */
      return payload.length === 2
        ? `${name} action=${playbackName(payload[0])} loop=${payload[1]}`
        : `${name} ${bytesToHex(payload)}`;
    case CMD.SCRIPT_BEGIN:
      return payload.length === 3
        ? `${name} script=${payload[0]} stages=${payload[1]} strips=${payload[2]}`
        : `${name} ${bytesToHex(payload)}`;
    case CMD.SCRIPT_STAGE:
      return payload.length === 6
        ? `${name} script=${payload[0]} stage=${payload[1]} ` +
            `duration=${payload[2] | (payload[3] << 8)}ms fade=${payload[4] | (payload[5] << 8)}ms`
        : `${name} ${bytesToHex(payload)}`;
    case CMD.SCRIPT_SEGMENT: {
      /* 载荷 script, stage, 再 23 字节段。 */
      if (payload.length !== SCRIPT_SEGMENT_BYTES) {
        return fallback(name, payload);
      }
      const spec = trySegment(payload.slice(2));
      if (spec === null) {
        return fallback(name, payload);
      }
      return `${name} script=${payload[0]} stage=${payload[1]} ${segmentText(spec)}`;
    }
    case CMD.SCRIPT_COMMIT:
    case CMD.SCRIPT_ABORT:
    case CMD.QUERY_SCRIPT:
    case CMD.CLEAR_SCRIPT:
      return payload.length === 1 ? `${name} script=${payload[0]}` : `${name} ${bytesToHex(payload)}`;
    case CMD.ACTIVATE_SCRIPT:
      return payload.length === 2
        ? `${name} script=${payload[0]} loop=${payload[1]}`
        : `${name} ${bytesToHex(payload)}`;
    default:
      return fallback(name, payload);
  }
}

/** 空载荷只给命令名，否则带上原始 hex（不丢证据、不猜）。 */
function fallback(name: string, payload: Uint8Array): string {
  return payload.length === 0 ? name : `${name} ${bytesToHex(payload)}`;
}

/** SetPlayback 的 action 名（日志可读性，不参与协议）。 */
export function playbackName(action: number): string {
  if (action === 0) {
    return "stop";
  }
  if (action === 1) {
    return "play";
  }
  if (action === 2) {
    return "pause";
  }
  return String(action);
}

/** ACK：回执的命令字 + 结果码，字段顺序与固件串口一致。 */
export function describeAck(ack: AckResult): string {
  return (
    `ACK ${commandName(ack.command)} cmd=${hex2(ack.command)} ` +
    `result=${hex2(ack.resultCode)} ${ack.ok ? "OK" : "FAIL"}`
  );
}

/**
 * State（State read 与 StateReport 共用），字段顺序见 §7.3。
 *
 * `leds` 是 strip 0 的派生值（#41 之前页面只认单灯带），`counts` / `segs`
 * 是 1..strip_count 的逐带值——两条都写出来，排查多灯带时才不用自己数。
 */
export function describeState(state: DeviceState): string {
  const script = state.scriptId === NO_SCRIPT ? "none" : `${state.scriptId}/${state.stageIndex}`;
  const strips = Math.max(1, Math.min(state.stripCount, MAX_STRIPS));
  const counts = state.stripCounts.slice(0, strips);
  const segs = state.stripSegCounts.slice(0, strips);
  return (
    `State power=${state.power} brightness=${state.brightness} ` +
    `rgb=${state.r},${state.g},${state.b} leds=${state.ledCount} max=${state.maxBrightness} ` +
    `strips=${state.stripCount} counts=${counts.join(",")} segs=${segs.join(",")} ` +
    `stripPower=${hex2(state.stripPowerMask)} stripAnim=${hex2(state.stripAnimMask)} ` +
    `script=${script} play=${state.playbackState} flags=${hex2(state.flags)}`
  );
}

/**
 * State read 的日志文本（已解析的 State）。
 *
 * State 特征值在 v3 里是裸 37 字节（无信封、无分片头），所以日志前缀必须
 * 与 StateReport 区分开。
 */
export function describeStateRead(state: DeviceState): string {
  return describeState(state).replace(/^State /, "State read ");
}

/**
 * State read 的日志文本（原始字节）。
 *
 * 解析失败时保留长度，便于判断是不是 MTU / 协议错配——这正是 v3 里最
 * 容易出问题的一步（MTU 23 下 37 字节读不出来）。
 */
export function describeStateReadBytes(bytes: Uint8Array): string {
  try {
    return describeStateRead(parseState(bytes));
  } catch {
    return `State read（${bytes.length} 字节，无法解析；v4 要求 ${STATE_BYTES} 字节）`;
  }
}

/** Event 0x81。code 0x01 = 存储失败，detail 是失败的原命令字；0x02 = 剧本提交失败。 */
export function describeEvent(code: number, detail: number): string {
  if (code === 0x01) {
    return (
      `Event storage_failed(0x01) cmd=${commandName(detail)}(${hex2(detail)}) ` +
      `detail=${hex2(detail)}`
    );
  }
  if (code === 0x02) {
    return `Event script_commit_failed(0x02) script=${detail}`;
  }
  return `Event 0x${code.toString(16).padStart(2, "0").toUpperCase()} detail=${hex2(detail)}`;
}

/** 设备→小程序命令名，只用于日志标题。 */
export function deviceCommandName(command: number): string {
  switch (command) {
    case DEVICE_CMD.ACK:
      return commandName(DEVICE_CMD.ACK);
    case DEVICE_CMD.EVENT:
      return commandName(DEVICE_CMD.EVENT);
    case DEVICE_CMD.STATE_REPORT:
      return commandName(DEVICE_CMD.STATE_REPORT);
    default:
      return commandName(command);
  }
}

/**
 * SegmentReport 0x83：日志用描述。
 *
 * 与 SET_SEGMENT 的字段顺序一致（同构载荷），但**不**复用 describeCommand 的
 * 名字——日志里必须能一眼区分「下发的段」与「设备回报的段」。
 */
export function describeSegmentReport(report: SegmentReport): string {
  return `SegmentReport ${segmentText(report)}`;
}

/** SegmentListEnd 0x84：某灯带的活动段位图（bit i = 槽位 i）。 */
export function describeSegmentListEnd(end: SegmentListEnd): string {
  const slots: number[] = [];
  for (let i = 0; i < 8; i += 1) {
    if ((end.segMask & (1 << i)) !== 0) {
      slots.push(i);
    }
  }
  return (
    `SegmentListEnd strip=${end.stripId} mask=${hex2(end.segMask)} ` +
    `slots=[${slots.join(",")}]`
  );
}

/** StripConfigReport 0x87：8 路的 GPIO 分配（只读，来自构建期 Kconfig）。 */
export function describeStripConfig(config: StripConfig): string {
  const parts = config.channels.map((ch) => `${ch.stripId}:gpio=${ch.gpio},on=${ch.assigned ? 1 : 0}`);
  return `StripConfigReport ${parts.join(" ")}`;
}

/** DeviceInfoReport 0x88：固件版本 / hw_id / 能力上限。 */
export function describeDeviceInfo(info: DeviceInfo): string {
  return (
    `DeviceInfoReport fw=${info.firmwareMajor}.${info.firmwareMinor} hw=${info.hwId} ` +
    `maxLeds=${info.maxLeds} maxStrips=${info.maxStrips} maxSegments=${info.maxSegments} ` +
    `maxStages=${info.maxStages} maxScripts=${info.maxScripts} ` +
    `twoLayers=${info.supportsTwoLayers ? 1 : 0} fade=${info.fadeImplemented ? 1 : 0}`
  );
}

/** 从原始载荷直接描述 0x87 / 0x88（解析失败给长度，不抛到日志层）。 */
export function describeStripConfigBytes(payload: Uint8Array): string {
  try {
    return describeStripConfig(parseStripConfigReport(payload));
  } catch {
    return `StripConfigReport（${payload.length} 字节，无法解析）`;
  }
}

/** 从原始载荷直接描述 0x88（解析失败给长度）。 */
export function describeDeviceInfoBytes(payload: Uint8Array): string {
  try {
    return describeDeviceInfo(parseDeviceInfoReport(payload));
  } catch {
    return `DeviceInfoReport（${payload.length} 字节，无法解析）`;
  }
}

/** ScriptSummary 0x85：剧本摘要（QueryScript 的响应）。 */
export function describeScriptSummary(summary: ScriptSummary): string {
  return (
    `ScriptSummary script=${summary.scriptId} stages=${summary.stageCount} ` +
    `loop=${(summary.flags & 0x01) !== 0 ? 1 : 0} active=${summary.active ? 1 : 0}`
  );
}

/** ScriptProgress 0x86：设备侧已接受的帧数（下发进度的补充证据）。 */
export function describeScriptProgress(progress: ScriptProgress): string {
  return `ScriptProgress script=${progress.scriptId} frames=${progress.framesWritten}`;
}
