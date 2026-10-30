/**
 * 隐藏协议日志面板的视图模型（纯逻辑，不依赖 wx.*，可在 node 里单测）。
 *
 * 数据源唯一：FrameLog（200 帧环形缓冲）。面板、console 镜像、复制文本都
 * 消费同一批 FrameLogEntry，禁止各自重新格式化（#8 已把 console 镜像放在
 * FrameLog.push 里）。
 *
 * 「暂停」语义选择：冻结视图但不丢数据。
 *   - 按下暂停时对当前缓冲做一次快照，视图停在那一刻；
 *   - 新帧继续进入 FrameLog（仍受 200 帧上限约束），恢复后立刻能看到；
 *   - 理由：诊断要的是「先复现再回看」。若停止记录，暂停期间发生的帧会
 *     直接缺失，反而破坏「每一帧都能在面板看到」的验收项；冻结视图既
 *     满足暂停阅读，又保证数据连续。
 */

import type { FrameLog, FrameLogEntry } from "./log";
import { commandName } from "../protocol/constants";

/** 连点版本号多少次开启面板（spec §10）。 */
export const LOG_PANEL_TAP_COUNT = 5;
/** 相邻两次点击的最大间隔；超过则重新计数，避免把一天的点击攒成 5 次。 */
export const LOG_PANEL_TAP_WINDOW_MS = 2000;

/** 连点判定：窗口内累计到 required 次即触发一次，并清空计数。 */
export class TapSequence {
  private readonly required: number;
  private readonly windowMs: number;
  private times: number[] = [];

  constructor(required: number = LOG_PANEL_TAP_COUNT, windowMs: number = LOG_PANEL_TAP_WINDOW_MS) {
    this.required = required;
    this.windowMs = windowMs;
  }

  /** 记录一次点击；返回 true 表示凑满 required 次（已自动重置）。 */
  tap(now: number): boolean {
    // 只保留窗口内的点击；用「与本次的时间差」判断，慢速点击自然过期。
    this.times = this.times.filter((t) => now - t <= this.windowMs && now - t >= 0);
    this.times.push(now);
    if (this.times.length >= this.required) {
      this.times = [];
      return true;
    }
    return false;
  }

  reset(): void {
    this.times = [];
  }

  get count(): number {
    return this.times.length;
  }
}

/** 面板一行的展示字段（时间戳 / 方向 / hex / 解析结果）。 */
export interface LogPanelRow {
  id: number;
  time: string;
  dir: "tx" | "rx";
  arrow: string;
  hex: string;
  name: string;
  seq: string;
  parsed: string;
  ok: boolean;
}

/** 时间戳格式 HH:MM:SS.mmm；面板和复制文本共用。 */
export function formatFrameTime(ts: number): string {
  const date = new Date(ts);
  const hh = String(date.getHours()).padStart(2, "0");
  const mm = String(date.getMinutes()).padStart(2, "0");
  const ss = String(date.getSeconds()).padStart(2, "0");
  const ms = String(date.getMilliseconds()).padStart(3, "0");
  return `${hh}:${mm}:${ss}.${ms}`;
}

/**
 * seq 同时给十进制与十六进制：固件串口打的是 `seq=0x..`，面板若只显示
 * 十进制，比对时每次都要心算。`7 (0x07)` 让「按 seq 对齐两端」变成直接
 * 字符串匹配（#13 验收项）。
 */
export function formatSeq(seq: number | undefined): string {
  if (seq === undefined) {
    return "-";
  }
  return `${seq} (0x${(seq & 0xff).toString(16).padStart(2, "0").toUpperCase()})`;
}

/** 单行：时间 方向 hex | 命令名 seq | 解析结果。 */
export function formatLogLine(entry: FrameLogEntry): string {
  const arrow = entry.dir === "tx" ? "->" : "<-";
  const name = entry.command === undefined ? "-" : commandName(entry.command);
  return (
    `${formatFrameTime(entry.ts)} ${arrow} ${entry.hex} | ${name} seq=${formatSeq(entry.seq)}` +
    ` | ${entry.parsed}`
  );
}

/** 复制用文本：一行一帧，末尾无空行。 */
export function formatLogEntries(entries: readonly FrameLogEntry[]): string {
  return entries.map(formatLogLine).join("\n");
}

/** FrameLogEntry → 面板行。 */
export function toPanelRow(entry: FrameLogEntry): LogPanelRow {
  return {
    id: entry.id,
    time: formatFrameTime(entry.ts),
    dir: entry.dir,
    arrow: entry.dir === "tx" ? "->" : "<-",
    hex: entry.hex,
    name: entry.command === undefined ? "-" : commandName(entry.command),
    seq: formatSeq(entry.seq),
    parsed: entry.parsed,
    ok: entry.ok !== false,
  };
}

/** 面板模型：可见性 + 暂停冻结 + 清空 + 复制。 */
export class LogPanelModel {
  readonly log: FrameLog;
  private readonly taps: TapSequence;
  private frozen: FrameLogEntry[] | null = null;
  private shown = false;

  constructor(log: FrameLog, taps: TapSequence = new TapSequence()) {
    this.log = log;
    this.taps = taps;
  }

  get visible(): boolean {
    return this.shown;
  }

  /** 暂停 = 持有冻结快照；恢复后重新跟随缓冲。 */
  get paused(): boolean {
    return this.frozen !== null;
  }

  setVisible(visible: boolean): void {
    this.shown = visible;
  }

  /**
   * 版本号点击：窗口内第 5 次切换面板可见性。
   * 返回 true 表示这次点击触发了开关（页面据此刷新或提示）。
   */
  tapVersion(now: number): boolean {
    if (!this.taps.tap(now)) {
      return false;
    }
    this.shown = !this.shown;
    return true;
  }

  /** 当前应显示的行：暂停时是冻结快照，否则跟随环形缓冲。 */
  entries(): FrameLogEntry[] {
    return this.frozen === null ? this.log.snapshot() : this.frozen.slice();
  }

  rows(): LogPanelRow[] {
    return this.entries().map(toPanelRow);
  }

  /** 冻结当前视图；新帧仍进缓冲（不丢数据）。 */
  pause(): void {
    if (this.frozen === null) {
      this.frozen = this.log.snapshot();
    }
  }

  /** 恢复跟随；暂停期间的新帧立刻可见。 */
  resume(): void {
    this.frozen = null;
  }

  /** 返回切换后的 paused 值。 */
  togglePause(): boolean {
    if (this.paused) {
      this.resume();
    } else {
      this.pause();
    }
    return this.paused;
  }

  /** 清空缓冲与冻结快照；暂停状态保持不变（清空后继续冻结）。 */
  clear(): void {
    this.log.clear();
    if (this.frozen !== null) {
      this.frozen = [];
    }
  }

  /** 复制当前视图的文本（暂停时复制冻结的那一段）。 */
  copyText(): string {
    return formatLogEntries(this.entries());
  }
}
