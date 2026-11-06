/**
 * 日志用的帧描述（纯函数，不依赖 wx.*）。
 *
 * 固件串口每帧打印 `cmd=0x.. seq=0x.. result=0x..`；小程序面板与 console
 * 用本模块生成同构的解析文本，两边靠 seq 对齐（spec §11）。
 *
 * 原则：命令名 + 参数都从字节里解析，不猜、不省略；解析不了时退回 hex，
 * 保证日志永远有可对照的原始数据。
 *
 * v5：一步两层（每层 9 字节，含层亮度）、State 32 字节、布局与场景各一族命令。
 * 日志必须把两层（含各自亮度）都写出来，否则「设备上的第二层」与「某层被压暗」
 * 在排查时完全不可见。
 */

import {
  CMD,
  DEVICE_CMD,
  EFFECT_TYPE,
  LAYOUT_PART_BYTES,
  MAX_STRIPS,
  NO_EFFECT,
  SCENE_NAME_BYTES,
  SCENE_STEP_BYTES,
  STATE_BYTES,
  WAVEFORM_NAMES,
  commandName,
} from "./constants";
import {
  breathingWaveform,
  cometHeads,
  cometSolidTail,
  layerReverse,
  parseDeviceInfoReport,
  parseLayer,
  parseState,
  parseStripConfigReport,
} from "./commands";

import { bytesToHex } from "./hex";
import type {
  AckResult,
  DeviceInfo,
  DeviceState,
  EffectLayer,
  LayoutListEnd,
  LayoutReport,
  SceneListEnd,
  ScenePartReport,
  SceneStepReport,
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
    case EFFECT_TYPE.STATIC:
      return "static";
    case EFFECT_TYPE.BREATHING:
      return "breathing";
    case EFFECT_TYPE.RAINBOW:
      return "rainbow";
    case EFFECT_TYPE.COMET:
      return "comet";
    case EFFECT_TYPE.STROBE:
      return "strobe";
    case EFFECT_TYPE.HEARTBEAT:
      return "heartbeat";
    case EFFECT_TYPE.OFF:
      return "off";
    case EFFECT_TYPE.FLICKER:
      return "flicker";
    case NO_EFFECT:
      return "empty";
    default:
      return `type${hex2(type)}`;
  }
}

/**
 * 混合方式名（日志可读性）。
 *
 * v5 的 blend **不在线上**（§6.2）：`layer1` 为空 → 覆盖；非空 → 按亮度叠加。
 * 所以这里只接受本地推导出的两个值。
 */
export function blendName(blend: number): string {
  if (blend === 0) {
    return "over";
  }
  if (blend === 3) {
    return "luma";
  }
  return `blend${blend}`;
}

/**
 * 一层的展示文本，按 type 解释同一个 p5 字段，并带上层亮度 `level`：
 *   0x00 静态：`static(hue=.. sat=.. level=..)`；
 *   0x01 呼吸：period / min_level(百分比) / waveform；
 *   0x02 彩虹：period / span / reverse；
 *   0x03 流光：period / tail / heads / solid / reverse（#98 的 bit1-3）；
 *   0x04 爆闪：period / duty / （无 flags 位）；
 *   0x05 心跳：period / pulse / double（bit0）；
 *   0x06 熄灭：`off(level=..)`，参数恒 0；
 *   0x07 随机闪烁：period / density（p5 = 同时亮着的比例）；
 *   0xFF 空层：`empty`（空层没有亮度可言，不写 level）。
 */
export function describeLayer(layer: EffectLayer): string {
  const name = layerTypeName(layer.type);
  if (layer.type === NO_EFFECT) {
    return name;
  }
  const head = `${name}(hue=${layer.hue} sat=${layer.sat} level=${layer.level}`;
  if (layer.type === EFFECT_TYPE.STATIC) {
    return `${head})`;
  }
  if (layer.type === EFFECT_TYPE.BREATHING) {
    return (
      `${head} period=${layer.periodMs} min_level=${layer.p5} ` +
      `waveform=${waveformName(breathingWaveform(layer.flags))} flags=${hex2(layer.flags)})`
    );
  }
  if (layer.type === EFFECT_TYPE.STROBE) {
    return `${head} period=${layer.periodMs} duty=${layer.p5})`;
  }
  if (layer.type === EFFECT_TYPE.HEARTBEAT) {
    return (
      `${head} period=${layer.periodMs} pulse=${layer.p5} ` +
      `double=${layerReverse(layer.flags) ? 1 : 0})`
    );
  }
  if (layer.type === EFFECT_TYPE.OFF) {
    return `${head})`;
  }
  if (layer.type === EFFECT_TYPE.FLICKER) {
    return `${head} period=${layer.periodMs} density=${layer.p5})`;
  }
  if (layer.type === EFFECT_TYPE.RAINBOW) {
    return (
      `${head} period=${layer.periodMs} span=${layer.p5} ` +
      `reverse=${layerReverse(layer.flags) ? 1 : 0} flags=${hex2(layer.flags)})`
    );
  }
  /* 流星（#98）：除了 tail / reverse，还要写出头数量与拖尾形状。 */
  return (
    `${head} period=${layer.periodMs} tail=${layer.p5} heads=${cometHeads(layer.flags)} ` +
    `solid=${cometSolidTail(layer.flags) ? 1 : 0} ` +
    `reverse=${layerReverse(layer.flags) ? 1 : 0} flags=${hex2(layer.flags)})`
  );
}

/**
 * 一步的正文（SceneStep / SceneStepReport 共用）。
 *
 * v5 的混合方式**不在线上**：`layer1` 为空 → 覆盖；非空 → 按亮度叠加
 * （§6.2）。所以这里按「有没有叠加层」推出一个可读的 blend 名，而不是读字节。
 */
function stepText(step: {
  sceneId: number;
  stripId: number;
  partId: number;
  stepIndex: number;
  durationMs: number;
  layer0: EffectLayer;
  layer1: EffectLayer;
}): string {
  const blend = step.layer1.type === NO_EFFECT ? "over" : "luma";
  return (
    `scene=${step.sceneId} strip=${step.stripId} part=${step.partId} ` +
    `step=${step.stepIndex} duration=${step.durationMs}ms blend=${blend} ` +
    `layer0=${describeLayer(step.layer0)} layer1=${describeLayer(step.layer1)}`
  );
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
    case CMD.SET_STRIP_POWER:
      return payload.length === 2
        ? `${name} strip=${payload[0]} on=${payload[1]}`
        : `${name} ${bytesToHex(payload)}`;
    case CMD.LAYOUT_WRITE:
      return payload.length === 2
        ? `${name} strip=${payload[0]} parts=${payload[1]}`
        : `${name} ${bytesToHex(payload)}`;
    case CMD.LAYOUT_PART:
      return payload.length === LAYOUT_PART_BYTES
        ? `${name} strip=${payload[0]} part=${payload[1]} ` +
            `name_len=${payload[2]} segs=${payload[27]}`
        : `${name} ${bytesToHex(payload)}`;
    case CMD.LAYOUT_SEG:
      return payload.length === 5
        ? `${name} strip=${payload[0]} part=${payload[1]} seg=${payload[2]} ` +
            `range=${payload[3]}-${payload[4]}`
        : `${name} ${bytesToHex(payload)}`;
    case CMD.LAYOUT_COMMIT:
      return name;
    case CMD.QUERY_LAYOUT:
      return payload.length === 1 ? `${name} strip=${payload[0]}` : `${name} ${bytesToHex(payload)}`;
    case CMD.SCENE_PART:
      return payload.length === 6
        ? `${name} scene=${payload[0]} strip=${payload[1]} part=${payload[2]} ` +
            `steps=${payload[3]} loop=${payload[4]} on=${payload[5]}`
        : `${name} ${bytesToHex(payload)}`;
    case CMD.SCENE_STEP: {
      if (payload.length !== SCENE_STEP_BYTES) {
        return fallback(name, payload);
      }
      return (
        `${name} scene=${payload[0]} strip=${payload[1]} part=${payload[2]} ` +
        `step=${payload[3]} duration=${payload[4] | (payload[5] << 8)}ms ` +
        `layer0=${describeLayer(parseLayer(payload, 6))} ` +
        `layer1=${describeLayer(parseLayer(payload, 15))}`
      );
    }
    case CMD.SCENE_NAME:
      return payload.length === SCENE_NAME_BYTES
        ? `${name} scene=${payload[0]} name_len=${payload[1]}`
        : `${name} ${bytesToHex(payload)}`;
    case CMD.ACTIVATE_SCENE:
    case CMD.QUERY_SCENE:
      return payload.length === 1 ? `${name} scene=${payload[0]}` : `${name} ${bytesToHex(payload)}`;
    default:
      return fallback(name, payload);
  }
}

/** 空载荷只给命令名，否则带上原始 hex（不丢证据、不猜）。 */
function fallback(name: string, payload: Uint8Array): string {
  if (payload.length === 0) {
    return name;
  }
  const hex = bytesToHex(payload);
  /* bytesToHex 对空数组返回空串，但对「不该为空的命令给了空载荷」要显式说明。 */
  return hex.length === 0 ? name : `${name} ${hex}`;
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
 * State（State read 与 StateReport 共用），字段顺序见 §7.3（32 字节）。
 *
 * v5 的 State 不含部位开关 / 播放位置 / 颜色摘要，所以日志里也没有那几项——
 * 要部位明细走 QueryLayout / QueryScene。
 */
export function describeState(state: DeviceState): string {
  const strips = Math.max(1, Math.min(state.stripCount, MAX_STRIPS));
  const counts = state.stripLedCounts.slice(0, strips);
  const parts = state.partCounts.slice(0, strips);
  return (
    `State power=${state.power} brightness=${state.brightness} ` +
    `max=${state.maxBrightness} strips=${state.stripCount} ` +
    `counts=${counts.join(",")} parts=${parts.join(",")} ` +
    `stripPower=${hex2(state.stripPowerMask)} scene=${state.activeScene} ` +
    `layout=${state.layoutValid ? 1 : 0}`
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
    return `State read（${bytes.length} 字节，无法解析；v5 要求 ${STATE_BYTES} 字节）`;
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
 * LayoutReport 0x89：一个部位的灯珠划分（§7.2）。
 *
 * 与 LayoutPart 的字段顺序一致，但**不**复用 describeCommand 的名字——
 * 日志里必须能一眼区分「下发的部位」与「设备回报的部位」。
 */
export function describeLayoutReport(report: LayoutReport): string {
  const segs = report.segs.map(([start, end]) => `${start}-${end}`).join(",");
  return (
    `LayoutReport strip=${report.stripId} part=${report.partId} ` +
    `name_len=${report.nameLen} segs=${report.segCount} range=[${segs}]`
  );
}

/** LayoutListEnd 0x8A：某链的部位位图（bit i = 部位 i 有段）。 */
export function describeLayoutListEnd(end: LayoutListEnd): string {
  const parts: number[] = [];
  for (let i = 0; i < 8; i += 1) {
    if ((end.partMask & (1 << i)) !== 0) {
      parts.push(i);
    }
  }
  return (
    `LayoutListEnd strip=${end.stripId} mask=${hex2(end.partMask)} ` +
    `parts=[${parts.join(",")}]`
  );
}

/** ScenePartReport 0x8B：一个部位的时间轴头。 */
export function describeScenePartReport(report: ScenePartReport): string {
  return (
    `ScenePartReport scene=${report.sceneId} strip=${report.stripId} ` +
    `part=${report.partId} steps=${report.stepCount} loop=${report.loop} ` +
    `on=${report.on ? 1 : 0}`
  );
}

/** SceneStepReport 0x8C：一步的两层（与 SceneStep 同构）。 */
export function describeSceneStepReport(report: SceneStepReport): string {
  return `SceneStepReport ${stepText(report)}`;
}

/** SceneListEnd 0x8D：场景读回的收尾（id 与名字长度）。 */
export function describeSceneListEnd(end: SceneListEnd): string {
  return `SceneListEnd scene=${end.sceneId} name_len=${end.nameLen}`;
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
    `maxLeds=${info.maxLeds} maxStrips=${info.maxStrips} maxParts=${info.maxParts} ` +
    `maxPartSegs=${info.maxPartSegs} maxSteps=${info.maxSteps} maxScenes=${info.maxScenes} ` +
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

