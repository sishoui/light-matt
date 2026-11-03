/**
 * 演示用传输层（mock）：与 `BleTransport` **同形**，不是另一套数据模型。
 *
 * 为什么这么做（而不是在页面里塞假数组）：
 *  - 会话、页面、列表派生全都按真实数据流走，关掉 mock 后一行都不用改；
 *  - 「连接」会真的走 `connect → 初始化 → ready`，状态条、自动回连、
 *    逐带段读回、剧本下发全部照常运行；
 *  - 写命令真的改内部状态，`readState` 读回的就是刚写进去的值，
 *    所以「拖亮度 → 卡片光晕变化」是真的有因果，不是写死的动画。
 *
 * 它**只**替换传输层：`ControlSession` 里没有任何 if 分支。启用与否由
 * `utils/control/mock-mode.ts` 决定（App 启动时注入）。
 *
 * 与真机的已知差异（刻意保留，写在这里避免被当成 bug）：
 *  - 没有 GATT / MTU / 分片：命令一步到位；
 *  - 不会因距离断开、不会有 10006 / 10008；
 *  - 时间是即时的（没有 3s 的 ACK 超时窗口）。
 */

import {
  AckRejectedError,
} from "./errors";
import type { LinkDetail } from "./link-listeners";
import { FrameLog } from "./log";
import { TransportListeners } from "./link-listeners";
import { mockSpecOf, type MockDeviceSpec, type MockSegmentSeed } from "../control/mock-devices";
import { parseSegmentPayload } from "../protocol/commands";
import { toFlat } from "../protocol/segment-shapes";
import {
  BLEND,
  NO_EFFECT,
  NO_SCRIPT,
  SEGMENT_TYPE,
} from "../protocol/constants";
import type {
  AckResult,
  CommandRequest,
  DeviceInfo,
  DeviceState,
  DiscoveredDevice,
  LinkState,
  SegmentListEnd,
  SegmentReport,
  SegmentSpec,
  StripConfig,
} from "../protocol/types";

/** 每台演示设备的可变状态（连接时从 spec 播种，之后按命令修改）。 */
interface MockRuntime {
  ledCounts: number[];
  power: 0 | 1;
  brightness: number;
  rgb: { r: number; g: number; b: number };
  stripPowerMask: number;
  segments: SegmentSpec[];
  /** scriptId → 阶段数。 */
  scripts: Map<number, number>;
  activeScript: number;
  playback: number;
  loop: boolean;
  /** 下发中的剧本暂存（Begin 之后、Commit 之前）。 */
  staging: { scriptId: number; stages: Map<number, { durationMs: number; segments: SegmentSpec[] }> } | null;
}

const EMPTY_INFO: Omit<DeviceInfo, "hwId"> = {
  firmwareVersion: 0x0300,
  firmwareMajor: 3,
  firmwareMinor: 0,
  maxLeds: 64,
  maxStrips: 8,
  maxSegments: 8,
  maxStages: 8,
  maxScripts: 4,
  caps: 0x01,
  supportsTwoLayers: true,
  fadeImplemented: false,
};

/** 模拟的扫描结果里额外出现的「附近未登记」设备，让发现页有内容。 */
const NEARBY_ONLY: readonly DiscoveredDevice[] = [
  { deviceId: "A4:CF:12:9B:3E:77", name: "Lumen-9B77", rssi: -58 },
];

function seedRuntime(spec: MockDeviceSpec): MockRuntime {
  const segments: SegmentSpec[] = spec.segments.map((seed) => toSpecOf(seed));
  return {
    ledCounts: fillStrips(spec.stripCounts),
    power: spec.power,
    brightness: spec.brightness,
    rgb: { ...spec.rgb },
    stripPowerMask: spec.stripPowerMask,
    segments,
    scripts: new Map(),
    activeScript: NO_SCRIPT,
    playback: 0,
    loop: false,
    staging: null,
  };
}

function toSpecOf(seed: MockSegmentSeed): SegmentSpec {
  return {
    stripId: seed.stripId,
    segId: seed.segId,
    start: seed.start,
    end: seed.end,
    blend: BLEND.OVER,
    layer0: {
      type: SEGMENT_TYPE.STATIC,
      hue: seed.hue,
      sat: seed.sat,
      periodMs: 0,
      p5: 0,
      flags: 0,
    },
    layer1: { type: NO_EFFECT, hue: 0, sat: 0, periodMs: 0, p5: 0, flags: 0 },
  };
}

function fillStrips(counts: readonly number[]): number[] {
  const out = [0, 0, 0, 0, 0, 0, 0, 0];
  counts.forEach((count, index) => {
    if (index < out.length) out[index] = count;
  });
  return out;
}

export class MockTransport {
  readonly log: FrameLog;

  private link: LinkState = "uninitialized";
  private deviceId: string | null = null;
  private deviceName: string | null = null;
  private spec: MockDeviceSpec | null = null;
  private runtime: MockRuntime | null = null;
  private nextSeq = 1;
  private readonly listeners = new TransportListeners();
  private connectEpoch = 0;
  private destroyed = false;

  constructor(opts: { log?: FrameLog; platform?: "android" | "ios" | "other" } = {}) {
    this.log = opts.log ?? new FrameLog({ mirrorToConsole: false });
  }

  get linkState(): LinkState {
    return this.link;
  }

  get currentDeviceId(): string | null {
    return this.deviceId;
  }

  /** 分片容量（与真机同名字段，页面/测试若读它不会崩）。 */
  get chunkCapacityBytes(): number {
    return 244;
  }

  get negotiatedMtu(): number | null {
    return 247;
  }

  // ------------------------------------------------------------------
  // 订阅
  // ------------------------------------------------------------------

  onLink(fn: (state: LinkState, detail?: LinkDetail) => void): () => void {
    return this.listeners.onLink(fn);
  }

  onDevices(fn: (list: DiscoveredDevice[]) => void): () => void {
    return this.listeners.onDevices(fn);
  }

  onState(fn: (state: DeviceState) => void): () => void {
    return this.listeners.onState(fn);
  }

  onDeviceEvent(fn: (code: number, detail: number) => void): () => void {
    return this.listeners.onDeviceEvent(fn);
  }

  onScanHint(fn: (hint: string | null) => void): () => void {
    return this.listeners.onScanHint(fn);
  }

  onScriptProgress(fn: (scriptId: number, frames: number) => void): () => void {
    return this.listeners.onScriptProgress(fn);
  }

  // ------------------------------------------------------------------
  // 适配器与扫描
  // ------------------------------------------------------------------

  async openAdapter(): Promise<void> {
    if (this.link === "uninitialized" || this.link === "adapter-off") {
      this.setLink("idle");
    }
  }

  async startScan(): Promise<void> {
    if (this.link === "scanning") {
      return;
    }
    if (this.link === "connecting" || this.link === "initializing") {
      throw new Error("正在连接，无法扫描");
    }
    this.setLink("scanning", { message: "扫描中…" });
    /* 扫描结果分两批给：先给已登记的三台，再给一台「附近未登记」——
     * 发现页的「已知 / 新设备」两种徽标都能看到。 */
    const found: DiscoveredDevice[] = [];
    for (const deviceId of ["A4:CF:12:9B:3E:01", "A4:CF:12:9B:3E:02", "A4:CF:12:9B:3E:03"]) {
      const spec = mockSpecOf(deviceId);
      if (spec !== null) {
        found.push({
          deviceId,
          name: spec.broadcastName,
          rssi: -42 - found.length * 6,
        });
      }
    }
    this.listeners.emitDevices(found);
    setTimeout(() => {
      if (this.link === "scanning") {
        this.listeners.emitDevices([...found, ...NEARBY_ONLY]);
      }
    }, 600);
  }

  async stopScan(): Promise<void> {
    if (this.link === "scanning") {
      this.setLink("idle");
    }
  }

  // ------------------------------------------------------------------
  // 连接
  // ------------------------------------------------------------------

  async connect(targetDeviceId: string, name?: string): Promise<DeviceState> {
    if (this.link === "connecting" || this.link === "initializing") {
      throw new Error("正在连接中");
    }
    const spec = mockSpecOf(targetDeviceId);
    if (spec === null) {
      this.setLink("failed", { message: "设备不在附近", deviceName: name });
      throw new Error("设备不在附近");
    }
    const epoch = this.connectEpoch;
    const cancelled = (): boolean => epoch !== this.connectEpoch;

    this.deviceId = targetDeviceId;
    this.deviceName = name ?? spec.broadcastName;
    this.setLink("connecting", { deviceName: this.deviceName });

    await new Promise((resolve) => setTimeout(resolve, 60));
    if (cancelled()) {
      throw new Error("已取消连接");
    }
    this.setLink("initializing", { deviceName: this.deviceName });
    await new Promise((resolve) => setTimeout(resolve, 60));
    if (cancelled()) {
      throw new Error("已取消连接");
    }

    this.spec = spec;
    this.runtime = seedRuntime(spec);
    this.nextSeq = 1;
    this.setLink("ready", { deviceName: this.deviceName });
    const state = this.stateOf();
    this.listeners.emitState(state);
    return state;
  }

  cancelConnect(): boolean {
    if (this.link !== "connecting" && this.link !== "initializing") {
      return false;
    }
    this.connectEpoch += 1;
    this.deviceId = null;
    this.spec = null;
    this.runtime = null;
    this.setLink("idle", { message: "已取消连接" });
    return true;
  }

  async disconnect(): Promise<void> {
    this.deviceId = null;
    this.deviceName = null;
    this.spec = null;
    this.runtime = null;
    this.setLink("idle");
  }

  // ------------------------------------------------------------------
  // 写命令
  // ------------------------------------------------------------------

  async write(req: CommandRequest): Promise<{ seq: number }> {
    this.ensureWritable();
    const seq = this.allocateSeq();
    this.logCommand(req, seq, "tx");
    this.apply(req);
    return { seq };
  }

  async sendAndWaitAck(req: CommandRequest, _opts: { timeoutMs?: number; retryOnTimeout?: number } = {}): Promise<AckResult> {
    this.ensureWritable();
    const seq = this.allocateSeq();
    this.logCommand(req, seq, "tx");
    const resultCode = this.apply(req);
    const ack: AckResult = {
      seq,
      command: req.command,
      resultCode,
      ok: resultCode === 0x00,
    };
    this.log.push({
      ts: Date.now(),
      dir: "rx",
      hex: `${req.command.toString(16).padStart(2, "0")} ${resultCode
        .toString(16)
        .padStart(2, "0")}`.toUpperCase(),
      command: req.command,
      seq,
      parsed: resultCode === 0 ? "ACK OK" : `ACK 0x${resultCode.toString(16)}`,
      ok: resultCode === 0,
    });
    return ack;
  }

  async sendSequence(
    requests: CommandRequest[],
    onProgress?: (done: number, total: number) => void,
    opts: { timeoutMs?: number; retryOnTimeout?: number } = {},
  ): Promise<void> {
    for (let i = 0; i < requests.length; i += 1) {
      const ack = await this.sendAndWaitAck(requests[i], opts);
      if (!ack.ok) {
        throw new AckRejectedError(ack.command, ack.resultCode);
      }
      onProgress?.(i + 1, requests.length);
    }
  }

  // ------------------------------------------------------------------
  // 查询
  // ------------------------------------------------------------------

  async readState(): Promise<DeviceState> {
    this.ensureWritable();
    return this.stateOf();
  }

  async queryStrip(
    stripId: number,
    _opts: { timeoutMs?: number } = {},
  ): Promise<{ reports: SegmentReport[]; end: SegmentListEnd }> {
    this.ensureWritable();
    const runtime = this.runtimeOrThrow();
    const reports = runtime.segments
      .filter((segment) => segment.stripId === stripId)
      .sort((a, b) => a.segId - b.segId)
      .map((segment) => ({ ...segment, ...toFlat(segment) }));
    const segMask = reports.reduce((mask, report) => mask | (1 << report.segId), 0);
    return { reports, end: { stripId, segMask } };
  }

  async queryScript(scriptId: number, _opts: { timeoutMs?: number } = {}): Promise<{
    scriptId: number;
    stageCount: number;
    flags: number;
    active: boolean;
  }> {
    this.ensureWritable();
    const runtime = this.runtimeOrThrow();
    return {
      scriptId,
      stageCount: runtime.scripts.get(scriptId) ?? 0,
      flags: runtime.loop ? 0x01 : 0x00,
      active: runtime.activeScript === scriptId,
    };
  }

  async queryStripConfig(_opts: { timeoutMs?: number } = {}): Promise<StripConfig> {
    this.ensureWritable();
    const runtime = this.runtimeOrThrow();
    const channels = Array.from({ length: 8 }, (_, stripId) => {
      const assigned = stripId < runtime.ledCounts.filter((count) => count > 0).length;
      const gpio = [3, 10, 0, 1, 4, 5, 6, 7][stripId] ?? 0xff;
      return {
        stripId,
        gpio: assigned ? gpio : 0xff,
        flags: assigned ? 0x01 : 0x00,
        assigned,
      };
    });
    return { channels };
  }

  async queryDeviceInfo(_opts: { timeoutMs?: number } = {}): Promise<DeviceInfo> {
    this.ensureWritable();
    const spec = this.spec;
    if (spec === null) {
      throw new Error("未连接");
    }
    return { ...EMPTY_INFO, hwId: spec.hwId };
  }

  destroy(): void {
    if (this.destroyed) {
      return;
    }
    this.destroyed = true;
    this.listeners.clear();
  }

  // ------------------------------------------------------------------
  // 内部
  // ------------------------------------------------------------------

  private setLink(state: LinkState, detail?: LinkDetail): void {
    this.link = state;
    this.listeners.emitLink(state, detail);
  }

  private allocateSeq(): number {
    const seq = this.nextSeq;
    this.nextSeq = this.nextSeq >= 0xff ? 1 : this.nextSeq + 1;
    return seq;
  }

  private ensureWritable(): void {
    if (this.link !== "ready") {
      throw new Error("未连接");
    }
  }

  private runtimeOrThrow(): MockRuntime {
    if (this.runtime === null) {
      throw new Error("未连接");
    }
    return this.runtime;
  }

  private logCommand(req: CommandRequest, seq: number, dir: "tx" | "rx"): void {
    const hex = [req.command, ...Array.from(req.payload)]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join(" ")
      .toUpperCase();
    this.log.push({
      ts: Date.now(),
      dir,
      hex,
      command: req.command,
      seq,
      parsed: `${commandLabel(req.command)}（mock）`,
      ok: true,
    });
  }

  /** 执行命令并返回结果码（0x00 = OK）。设备侧权威校验也在这里模拟。 */
  private apply(req: CommandRequest): number {
    const runtime = this.runtimeOrThrow();
    const payload = req.payload;
    switch (req.command) {
      case 0x01: {
        runtime.power = payload[0] === 1 ? 1 : 0;
        return 0x00;
      }
      case 0x02: {
        runtime.brightness = Math.min(payload[0], this.spec?.maxBrightness ?? 255);
        return 0x00;
      }
      case 0x05: {
        return 0x00;
      }
      case 0x06: {
        const stripId = payload[0];
        const count = payload[1] | (payload[2] << 8);
        if (stripId >= 8 || count < 1 || count > 64) {
          return 0x01;
        }
        runtime.ledCounts[stripId] = count;
        /* 灯珠数变小会裁掉越界段（§9.2）。 */
        runtime.segments = runtime.segments.filter(
          (segment) => segment.stripId !== stripId || segment.end < count,
        );
        return 0x00;
      }
      case 0x07: {
        return 0x00;
      }
      case 0x10: {
        try {
          const spec = parseSegmentPayload(payload);
          if (spec.end >= runtime.ledCounts[spec.stripId]) {
            return 0x01;
          }
          /* 同带区间重叠：设备拒绝（§9.2）。 */
          const overlaps = runtime.segments.some(
            (segment) =>
              segment.stripId === spec.stripId &&
              segment.segId !== spec.segId &&
              segment.start <= spec.end &&
              spec.start <= segment.end,
          );
          if (overlaps) {
            return 0x01;
          }
          runtime.segments = runtime.segments.filter(
            (segment) => !(segment.stripId === spec.stripId && segment.segId === spec.segId),
          );
          runtime.segments.push(spec);
          return 0x00;
        } catch {
          return 0x01;
        }
      }
      case 0x11: {
        const stripId = payload[0];
        const segId = payload[1];
        runtime.segments = runtime.segments.filter(
          (segment) => !(segment.stripId === stripId && segment.segId === segId),
        );
        return 0x00;
      }
      case 0x13: {
        const action = payload[0];
        if (action > 2) {
          return 0x01;
        }
        runtime.playback = action;
        runtime.loop = payload[1] === 1;
        return 0x00;
      }
      case 0x14: {
        const scriptId = payload[0];
        const stageCount = payload[1];
        if (scriptId >= 4 || stageCount < 1 || stageCount > 8) {
          return 0x01;
        }
        runtime.staging = { scriptId, stages: new Map() };
        return 0x00;
      }
      case 0x15: {
        const scriptId = payload[0];
        const stageIndex = payload[1];
        const durationMs = payload[2] | (payload[3] << 8);
        if (runtime.staging === null || runtime.staging.scriptId !== scriptId) {
          return 0x09;
        }
        const stage = runtime.staging.stages.get(stageIndex) ?? { durationMs: 0, segments: [] };
        stage.durationMs = durationMs;
        runtime.staging.stages.set(stageIndex, stage);
        return 0x00;
      }
      case 0x16: {
        const scriptId = payload[0];
        const stageIndex = payload[1];
        if (runtime.staging === null || runtime.staging.scriptId !== scriptId) {
          return 0x09;
        }
        try {
          const spec = parseSegmentPayload(payload.slice(2));
          const stage = runtime.staging.stages.get(stageIndex) ?? { durationMs: 0, segments: [] };
          stage.segments = stage.segments.filter(
            (segment) => !(segment.stripId === spec.stripId && segment.segId === spec.segId),
          );
          if (spec.layer0.type !== NO_EFFECT) {
            stage.segments.push(spec);
          }
          runtime.staging.stages.set(stageIndex, stage);
          return 0x00;
        } catch {
          return 0x01;
        }
      }
      case 0x17: {
        const scriptId = payload[0];
        if (runtime.staging === null || runtime.staging.scriptId !== scriptId) {
          return 0x09;
        }
        runtime.scripts.set(scriptId, runtime.staging.stages.size);
        runtime.staging = null;
        return 0x00;
      }
      case 0x18: {
        runtime.staging = null;
        return 0x00;
      }
      case 0x19: {
        const scriptId = payload[0];
        if (!runtime.scripts.has(scriptId)) {
          return 0x01;
        }
        runtime.activeScript = scriptId;
        runtime.loop = payload[1] === 1;
        runtime.playback = 1;
        return 0x00;
      }
      case 0x1b: {
        const stripId = payload[0];
        const on = payload[1] === 1;
        const bit = 1 << stripId;
        runtime.stripPowerMask = on
          ? runtime.stripPowerMask | bit
          : runtime.stripPowerMask & ~bit;
        return 0x00;
      }
      case 0x1c:
      case 0x1d:
      case 0x1a:
      case 0x12: {
        /* 查询类由各自的 async 方法处理；走到这里说明调用方用错了通道。 */
        return 0x00;
      }
      default:
        return 0x02;
    }
  }

  /** 由运行时状态派生 37 字节 State 的等价对象。 */
  private stateOf(): DeviceState {
    const runtime = this.runtimeOrThrow();
    const stripCount = Math.max(
      1,
      runtime.ledCounts.reduce((count, value, index) => (value > 0 ? index + 1 : count), 1),
    );
    const stripSegCounts = Array.from({ length: 8 }, (_, stripId) =>
      runtime.segments.filter((segment) => segment.stripId === stripId).length,
    );
    return {
      power: runtime.power,
      brightness: runtime.brightness,
      r: runtime.rgb.r,
      g: runtime.rgb.g,
      b: runtime.rgb.b,
      ledCount: runtime.ledCounts[0],
      maxBrightness: this.spec?.maxBrightness ?? 255,
      stripCount,
      segCount: stripSegCounts[0],
      scriptId: runtime.activeScript,
      stageIndex: 0,
      playbackState: runtime.playback,
      flags: (runtime.loop ? 0x01 : 0x00) | (runtime.activeScript !== NO_SCRIPT ? 0x02 : 0x00),
      stripPowerMask: runtime.stripPowerMask,
      stripAnimMask: 0x00,
      stripCounts: [...runtime.ledCounts],
      stripSegCounts,
    };
  }
}

function commandLabel(command: number): string {
  const labels: Record<number, string> = {
    0x01: "SetPower",
    0x02: "SetBrightness",
    0x05: "QueryState",
    0x06: "SetLedCount",
    0x07: "SelfTest",
    0x10: "SetSegment",
    0x11: "ClearSegment",
    0x12: "QueryStrip",
    0x13: "SetPlayback",
    0x14: "ScriptBegin",
    0x15: "ScriptStage",
    0x16: "ScriptSegment",
    0x17: "ScriptCommit",
    0x18: "ScriptAbort",
    0x19: "ActivateScript",
    0x1a: "QueryScript",
    0x1b: "SetStripPower",
    0x1c: "QueryStripConfig",
    0x1d: "QueryDeviceInfo",
  };
  return labels[command] ?? `cmd 0x${command.toString(16)}`;
}
