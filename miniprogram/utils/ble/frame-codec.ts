/**
 * 协议编解码：帧的字节层 ↔ 传输层可用的结果。
 *
 * 传输层只负责「把字节搬进搬出」；这里负责把入站字节解成可判定的动作
 * （ACK / StateReport / Event / 无可动作），并为日志行准备与既有格式完全
 * 一致的描述文本。所有函数都是纯函数，不接触 wx.*，也不持有任何连接状态。
 */

import { DEVICE_CMD } from "../protocol/constants";
import { decodeFrame, encodeFrame } from "../protocol/frame";
import {
  parseAck,
  parseScriptProgress,
  parseScriptSummary,
  parseSegmentListEnd,
  parseSegmentReport,
  parseState,
  type ScriptProgress,
  type ScriptSummary,
} from "../protocol/commands";
import {
  describeAck,
  describeCommand,
  describeEvent,
  describeScriptProgress,
  describeScriptSummary,
  describeSegmentListEnd,
  describeSegmentReport,
  describeState,
  describeStateRead,
} from "../protocol/describe";
import type {
  AckResult,
  CommandRequest,
  DeviceState,
  SegmentListEnd,
  SegmentReport,
} from "../protocol/types";
import { errorText } from "./errors";

/** 入站帧解析后要执行的动作；`none` 表示只看日志、无需改状态。 */
export type InboundAction =
  | { kind: "none" }
  | { kind: "ack"; ack: AckResult }
  | { kind: "state"; state: DeviceState }
  | { kind: "event"; code: number; detail: number }
  /* #25：QueryStrip 的多帧回包。小程序按命令字区分类型、按 SegmentListEnd 收尾。 */
  | { kind: "segment-report"; report: SegmentReport }
  | { kind: "segment-list-end"; end: SegmentListEnd }
  /* #32：QueryScript 的响应（ScriptSummary）与下发进度（ScriptProgress）。 */
  | { kind: "script-summary"; summary: ScriptSummary }
  | { kind: "script-progress"; progress: ScriptProgress };

/** 一条入站帧的日志字段 + 动作。日志字段与拆分前逐字一致。 */
export interface InboundFrame {
  command: number | undefined;
  seq: number | undefined;
  text: string;
  ok: boolean;
  action: InboundAction;
}

/** 出站帧编码：命令字 + seq + 载荷 → 完整字节（含信封与 checksum）。 */
export function encodeTxFrame(command: number, seq: number, payload: Uint8Array): Uint8Array {
  return encodeFrame(command, seq, payload);
}

/** TX 帧的日志描述。 */
export function describeTx(req: CommandRequest): string {
  return describeCommand(req.command, req.payload);
}

/** State read 的裸值：能解析就写出完整状态，不能解析也保留长度。 */
export function describeStateReadBytes(bytes: Uint8Array): string {
  try {
    return describeStateRead(parseState(bytes));
  } catch {
    return `State read（${bytes.length} 字节，无法解析）`;
  }
}

/**
 * 解一条设备 → 小程序的帧。
 *
 * 顺序与拆分前的 handleDeviceFrame 完全一致：先判信封，再按命令字分派；
 * 解析失败只产出日志文本，不产出动作。
 */
export function routeInboundFrame(bytes: Uint8Array): InboundFrame {
  const result = decodeFrame(bytes);
  if (!result.ok) {
    return {
      command: undefined,
      seq: undefined,
      text: `解码失败（${result.reason}）`,
      ok: false,
      action: { kind: "none" },
    };
  }

  const { command, seq, payload } = result;

  if (command === DEVICE_CMD.ACK) {
    try {
      const ack = parseAck(payload, seq);
      return { command, seq, text: describeAck(ack), ok: ack.ok, action: { kind: "ack", ack } };
    } catch (err) {
      return { command, seq, text: errorText(err), ok: false, action: { kind: "none" } };
    }
  }

  if (command === DEVICE_CMD.STATE_REPORT) {
    try {
      const state = parseState(payload);
      return {
        command,
        seq,
        text: describeState(state),
        ok: true,
        action: { kind: "state", state },
      };
    } catch (err) {
      return { command, seq, text: errorText(err), ok: false, action: { kind: "none" } };
    }
  }

  if (command === DEVICE_CMD.EVENT) {
    if (payload.length !== 2) {
      return { command, seq, text: "Event 载荷长度错误", ok: false, action: { kind: "none" } };
    }
    const code = payload[0];
    const detail = payload[1];
    return {
      command,
      seq,
      text: describeEvent(code, detail),
      ok: code !== 0x01,
      action: { kind: "event", code, detail },
    };
  }

  /* #25：QueryStrip 的多帧回包。 */
  if (command === DEVICE_CMD.SEGMENT_REPORT) {
    try {
      const report = parseSegmentReport(payload);
      return {
        command,
        seq,
        text: describeSegmentReport(report),
        ok: true,
        action: { kind: "segment-report", report },
      };
    } catch (err) {
      return { command, seq, text: errorText(err), ok: false, action: { kind: "none" } };
    }
  }

  if (command === DEVICE_CMD.SEGMENT_LIST_END) {
    try {
      const end = parseSegmentListEnd(payload);
      return {
        command,
        seq,
        text: describeSegmentListEnd(end),
        ok: true,
        action: { kind: "segment-list-end", end },
      };
    } catch (err) {
      return { command, seq, text: errorText(err), ok: false, action: { kind: "none" } };
    }
  }

  /* #32：QueryScript 的响应与下发进度。两者都带 seq，但语义不同——
   * ScriptSummary 收尾一次查询，ScriptProgress 只是进度旁证。 */
  if (command === DEVICE_CMD.SCRIPT_SUMMARY) {
    try {
      const summary = parseScriptSummary(payload);
      return {
        command,
        seq,
        text: describeScriptSummary(summary),
        ok: true,
        action: { kind: "script-summary", summary },
      };
    } catch (err) {
      return { command, seq, text: errorText(err), ok: false, action: { kind: "none" } };
    }
  }

  if (command === DEVICE_CMD.SCRIPT_PROGRESS) {
    try {
      const progress = parseScriptProgress(payload);
      return {
        command,
        seq,
        text: describeScriptProgress(progress),
        ok: true,
        action: { kind: "script-progress", progress },
      };
    } catch (err) {
      return { command, seq, text: errorText(err), ok: false, action: { kind: "none" } };
    }
  }

  return { command, seq, text: "未知的设备→小程序命令", ok: false, action: { kind: "none" } };
}
