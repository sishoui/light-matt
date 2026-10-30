/**
 * 日志用的帧描述（纯函数，不依赖 wx.*）。
 *
 * 固件串口每帧打印 `cmd=0x.. seq=0x.. result=0x..`；小程序面板与 console
 * 用本模块生成同构的解析文本，两边靠 seq 对齐（spec §11）。
 *
 * 原则：命令名 + 参数都从字节里解析，不猜、不省略；解析不了时退回 hex，
 * 保证日志永远有可对照的原始数据。
 */

import {
  CMD,
  DEVICE_CMD,
  SEGMENT_TYPE,
  WAVEFORM_NAMES,
  commandName,
} from "./constants";
import { breathingWaveform, segmentParamLength } from "./commands";
import { bytesToHex } from "./hex";
import type { AckResult, DeviceState, SegmentListEnd, SegmentReport } from "./types";

function hex2(value: number): string {
  return `0x${(value & 0xff).toString(16).padStart(2, "0").toUpperCase()}`;
}

/** 呼吸波形名（effects-spec §2.2）；未知值原样给数字。 */
function waveformName(waveform: number): string {
  return WAVEFORM_NAMES[waveform] ?? `wave${waveform}`;
}

/**
 * 段参数的展示文本，按 type 解释同一个 p5 字段：
 *   0x00 静态：没有参数（hue/sat 已在外面）；
 *   0x01 呼吸：period / min_level / waveform；
 *   0x02/0x03：period / span|tail / flags（#31 落地，日志先能读）。
 */
function describeSegmentParams(type: number, periodMs: number, p5: number, flags: number): string {
  if (type === SEGMENT_TYPE.STATIC) {
    return "";
  }
  if (type === SEGMENT_TYPE.BREATHING) {
    return (
      ` period=${periodMs} min_level=${p5} ` +
      `waveform=${waveformName(breathingWaveform(flags))} flags=${hex2(flags)}`
    );
  }
  const p5Name = type === SEGMENT_TYPE.RAINBOW ? "span" : "tail";
  return ` period=${periodMs} ${p5Name}=${p5} flags=${hex2(flags)}`;
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
      return name;
    case CMD.SET_LED_COUNT:
      return payload.length === 3
        ? `${name} strip=${payload[0]} count=${payload[1] | (payload[2] << 8)}`
        : `${name} ${bytesToHex(payload)}`;
    case CMD.SET_SEGMENT: {
      /* 载荷 strip, seg, start, end, type, params；长度不符时只给 hex，不猜。 */
      if (payload.length < 5) {
        return payload.length === 0 ? name : `${name} ${bytesToHex(payload)}`;
      }
      const type = payload[4];
      const paramLen = segmentParamLength(type);
      if (paramLen === 0 || payload.length !== 5 + paramLen) {
        return `${name} ${bytesToHex(payload)}`;
      }
      const anim = paramLen > 3;
      return (
        `${name} strip=${payload[0]} seg=${payload[1]} range=${payload[2]}-${payload[3]} ` +
        `type=${hex2(type)} hue=${payload[5] | (payload[6] << 8)} sat=${payload[7]}` +
        describeSegmentParams(
          type,
          anim ? payload[8] | (payload[9] << 8) : 0,
          anim ? payload[10] : 0,
          anim ? payload[11] : 0,
        )
      );
    }
    case CMD.CLEAR_SEGMENT:
      return payload.length === 2
        ? `${name} strip=${payload[0]} seg=${payload[1]}`
        : `${name} ${bytesToHex(payload)}`;
    case CMD.QUERY_STRIP:
      return payload.length === 1 ? `${name} strip=${payload[0]}` : `${name} ${bytesToHex(payload)}`;
    default:
      return payload.length === 0 ? name : `${name} ${bytesToHex(payload)}`;
  }
}

/** ACK：回执的命令字 + 结果码，字段顺序与固件串口一致。 */
export function describeAck(ack: AckResult): string {
  return (
    `ACK ${commandName(ack.command)} cmd=${hex2(ack.command)} ` +
    `result=${hex2(ack.resultCode)} ${ack.ok ? "OK" : "FAIL"}`
  );
}

/** State（State read 与 StateReport 共用），字段顺序见 protocol §7。 */
export function describeState(state: DeviceState): string {
  const script =
    state.scriptId === 0xff ? "none" : `${state.scriptId}/${state.stageIndex}`;
  return (
    `State power=${state.power} brightness=${state.brightness} ` +
    `rgb=${state.r},${state.g},${state.b} leds=${state.ledCount} max=${state.maxBrightness} ` +
    `strips=${state.stripCount} segs=${state.segCount} script=${script} ` +
    `play=${state.playbackState} flags=${hex2(state.flags)}`
  );
}

/**
 * State read 是裸 14 字节、没有命令信封：日志里要能和 StateReport 区分开。
 * 其余字段与 describeState 完全一致（同一份 14 字节布局）。
 */
export function describeStateRead(state: DeviceState): string {
  return describeState(state).replace(/^State /, "State read ");
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
  return (
    `SegmentReport strip=${report.stripId} seg=${report.segId} ` +
    `range=${report.start}-${report.end} type=${hex2(report.type)} ` +
    `hue=${report.hue} sat=${report.sat}` +
    describeSegmentParams(report.type, report.periodMs, report.p5, report.flags)
  );
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
