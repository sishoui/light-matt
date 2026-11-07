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
import { mockSpecOf, type MockDeviceSpec } from "../control/mock-devices";
import {
  EFFECT_TYPE,
  LAYOUT_PART_BYTES,
  MAX_LEDS,
  MAX_SCENES,
  NAME_BYTES,
  NO_EFFECT,
  SCENE_STEP_BYTES,
  STEP_MAX_MS,
  STEP_MIN_MS,
} from "../protocol/constants";
import type {
  AckResult,
  CommandRequest,
  DeviceInfo,
  DeviceState,
  DiscoveredDevice,
  EffectLayer,
  LayoutListEnd,
  LayoutReport,
  LinkState,
  SceneListEnd,
  ScenePartReport,
  SceneStepReport,
  StripConfig,
} from "../protocol/types";

/** 一个部位在 mock 里的可变状态（布局 + 它在本场景的时间轴）。 */
interface MockPart {
  partId: number;
  name: string;
  /** 闭区间灯珠段，最多 8 条。 */
  segs: Array<[number, number]>;
  stepCount: number;
  loop: number;
  on: boolean;
  steps: Array<{
    durationMs: number;
    layer0: EffectLayer;
    layer1: EffectLayer;
  }>;
}

/** 每条链：部位列表（布局） + 本场景里各部位的时间轴。 */
interface MockStrip {
  ledCount: number;
  parts: MockPart[];
}

/**
 * 每台演示设备的可变状态（连接时从 spec 播种，之后按命令修改）。
 *
 * v5 的两张表都按链展开：`strips[i].parts` 是布局，每个部位的
 * stepCount / loop / on / steps 是**当前场景**的时间轴。三个场景在 mock 里
 * 只保留激活这一个——演示模式不需要多场景切换的视觉证据，而 State 只报
 * `activeScene`，页面读到的仍是设备权威值。
 */
interface MockRuntime {
  strips: MockStrip[];
  power: 0 | 1;
  brightness: number;
  stripPowerMask: number;
  activeScene: number;
  layoutValid: boolean;
  sceneName: string;
  /** 布局暂存（LayoutWrite 之后、LayoutCommit 之前）。 */
  layoutStaging: boolean;
}

const EMPTY_INFO: Omit<DeviceInfo, "hwId"> = {
  firmwareVersion: 0x0500,
  firmwareMajor: 5,
  firmwareMinor: 0,
  maxLeds: MAX_LEDS,
  maxStrips: 8,
  maxParts: 8,
  maxPartSegs: 8,
  maxSteps: 8,
  maxScenes: MAX_SCENES,
  caps: 0x01,
  supportsTwoLayers: true,
  fadeImplemented: false,
};

/** 演示用的静态层（常亮）。 */
function staticLayer(hue: number, sat: number): EffectLayer {
  return { type: EFFECT_TYPE.STATIC, hue, sat, periodMs: 0, p5: 0, flags: 0, level: 100 };
}

function emptyLayer(): EffectLayer {
  return { type: NO_EFFECT, hue: 0, sat: 0, periodMs: 0, p5: 0, flags: 0, level: 0 };
}

/** 模拟的扫描结果里额外出现的「附近未登记」设备，让发现页有内容。 */
const NEARBY_ONLY: readonly DiscoveredDevice[] = [
  { deviceId: "A4:CF:12:9B:3E:77", name: "Lumen-9B77", rssi: -58 },
];

function seedRuntime(spec: MockDeviceSpec): MockRuntime {
  const strips: MockStrip[] = fillStrips(spec.stripCounts).map((ledCount, stripIndex) => ({
    ledCount,
    parts: spec.parts
      .filter((part) => part.stripId === stripIndex)
      .map((part) => ({
        partId: part.partId,
        name: part.name,
        segs: part.segs.map(([start, end]) => [start, end] as [number, number]),
        /* 出厂状态：每部位 1 步常亮，与「点 + 播种整条/1 步/常亮」一致。 */
        stepCount: 1,
        loop: 0,
        on: true,
        steps: [{ durationMs: 3000, layer0: staticLayer(part.hue, part.sat), layer1: emptyLayer() }],
      })),
  }));
  return {
    strips,
    power: spec.power,
    brightness: spec.brightness,
    stripPowerMask: spec.stripPowerMask,
    activeScene: 0,
    layoutValid: strips.some((strip) => strip.parts.length > 0),
    sceneName: "场景 1",
    layoutStaging: false,
  };
}

function fillStrips(counts: readonly number[]): number[] {
  const out = [0, 0, 0, 0, 0, 0, 0, 0];
  counts.forEach((count, index) => {
    if (index < out.length) out[index] = count;
  });
  return out;
}

/** UTF-8 字节长度（名字字段的上限校验用）。 */
function encodeUtf8Length(text: string): number {
  let bytes = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    bytes += code <= 0x7f ? 1 : code <= 0x7ff ? 2 : code <= 0xffff ? 3 : 4;
  }
  return bytes;
}

/** 从载荷里读一层（9 字节定宽，§7.1）。 */
function readLayer(payload: Uint8Array, offset: number): EffectLayer {
  return {
    type: payload[offset],
    hue: payload[offset + 1] | (payload[offset + 2] << 8),
    sat: payload[offset + 3],
    periodMs: payload[offset + 4] | (payload[offset + 5] << 8),
    p5: payload[offset + 6],
    flags: payload[offset + 7],
    level: payload[offset + 8],
  };
}

/** 从 24 字节名字段里解出前 len 字节（UTF-8）。 */
function decodeUtf8(bytes: Uint8Array, offset: number, len: number): string {
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
    } else {
      code =
        ((b0 & 0x07) << 18) |
        ((bytes[i + 1] & 0x3f) << 12) |
        ((bytes[i + 2] & 0x3f) << 6) |
        (bytes[i + 3] & 0x3f);
      size = 4;
    }
    text += String.fromCodePoint(code);
    i += size;
  }
  return text;
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

  async queryLayout(
    stripId: number,
    _opts: { timeoutMs?: number } = {},
  ): Promise<{ reports: LayoutReport[]; end: LayoutListEnd }> {
    this.ensureWritable();
    const runtime = this.runtimeOrThrow();
    const strip = runtime.strips[stripId];
    if (strip === undefined) {
      throw new Error(`没有 strip ${stripId}`);
    }
    /* 只有 segs 非空的部位才报（§7.2：part_mask 与报告条数一致）。 */
    const reports: LayoutReport[] = strip.parts
      .filter((part) => part.segs.length > 0)
      .map((part) => ({
        stripId,
        partId: part.partId,
        nameLen: encodeUtf8Length(part.name),
        name: part.name,
        segCount: part.segs.length,
        segs: part.segs.map(([start, end]) => [start, end] as [number, number]),
      }));
    const partMask = reports.reduce((mask, report) => mask | (1 << report.partId), 0);
    return { reports, end: { stripId, partMask } };
  }

  async queryScene(
    sceneId: number,
    _opts: { timeoutMs?: number } = {},
  ): Promise<{
    sceneId: number;
    parts: ScenePartReport[];
    steps: SceneStepReport[];
    end: SceneListEnd;
  }> {
    this.ensureWritable();
    const runtime = this.runtimeOrThrow();
    const parts: ScenePartReport[] = [];
    const steps: SceneStepReport[] = [];
    runtime.strips.forEach((strip, stripId) => {
      for (const part of strip.parts) {
        if (part.stepCount === 0) {
          continue;
        }
        parts.push({
          sceneId,
          stripId,
          partId: part.partId,
          stepCount: part.stepCount,
          loop: part.loop,
          on: part.on,
        });
        part.steps.slice(0, part.stepCount).forEach((step, stepIndex) => {
          steps.push({
            sceneId,
            stripId,
            partId: part.partId,
            stepIndex,
            durationMs: step.durationMs,
            layer0: { ...step.layer0 },
            layer1: { ...step.layer1 },
          });
        });
      }
    });
    const nameLen = encodeUtf8Length(runtime.sceneName);
    return {
      sceneId,
      parts,
      steps,
      end: { sceneId, nameLen, name: runtime.sceneName },
    };
  }

  async queryStripConfig(_opts: { timeoutMs?: number } = {}): Promise<StripConfig> {
    this.ensureWritable();
    const runtime = this.runtimeOrThrow();
    const channels = Array.from({ length: 8 }, (_, stripId) => {
      const assigned = stripId < runtime.strips.filter((strip) => strip.ledCount > 0).length;
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
        if (stripId >= 8 || count < 1 || count > MAX_LEDS) {
          return 0x01;
        }
        const strip = runtime.strips[stripId];
        if (strip === undefined) {
          return 0x01;
        }
        strip.ledCount = count;
        /* 灯珠数变小会裁掉越界的段（§6.1：不自动缩短，整段失效）。 */
        for (const part of strip.parts) {
          part.segs = part.segs.filter(([, end]) => end < count);
        }
        return 0x00;
      }
      case 0x07: {
        return 0x00;
      }
      /* ---- 布局族 0x20-0x24 ---- */
      case 0x20: {
        const stripId = payload[0];
        const partCount = payload[1];
        const strip = runtime.strips[stripId];
        if (strip === undefined || partCount > 8) {
          return 0x01;
        }
        /* LayoutWrite：声明部位数并**清空**该链的部位（§6.1 第 1 条）。 */
        strip.parts = Array.from({ length: partCount }, (_, partId) => ({
          partId,
          name: "",
          segs: [],
          stepCount: 0,
          loop: 0,
          on: true,
          steps: [],
        }));
        runtime.layoutStaging = true;
        return 0x00;
      }
      case 0x21: {
        if (payload.length !== LAYOUT_PART_BYTES) {
          return 0x04;
        }
        const stripId = payload[0];
        const partId = payload[1];
        const nameLen = payload[2];
        const segCount = payload[27];
        const part = runtime.strips[stripId]?.parts[partId];
        if (part === undefined || nameLen > NAME_BYTES || segCount > 8) {
          return 0x01;
        }
        part.name = decodeUtf8(payload, 3, nameLen);
        /* 声明段数时清空旧段（分帧下发的中间态由 LayoutCommit 兜底）。 */
        part.segs = [];
        part.stepCount = part.stepCount;
        return 0x00;
      }
      case 0x22: {
        const stripId = payload[0];
        const partId = payload[1];
        const segId = payload[2];
        const start = payload[3];
        const end = payload[4];
        const strip = runtime.strips[stripId];
        const part = strip?.parts[partId];
        if (strip === undefined || part === undefined) {
          return 0x01;
        }
        if (start > end || end >= strip.ledCount) {
          return 0x01;
        }
        /*
         * 一颗灯珠只属一个部位（S3）：与同链**所有**段互斥，同部位的其它段也在内
         * ——与固件 `seg_conflicts` 同一份规则（它只跳过 `skip_part/skip_seg` 这
         * 一个位置）。替换自己时因此必须跳过自己那一条。
         */
        for (const other of strip.parts) {
          for (let index = 0; index < other.segs.length; index += 1) {
            if (other.partId === partId && index === segId) {
              continue;
            }
            const [ostart, oend] = other.segs[index];
            if (!(end < ostart || oend < start)) {
              return 0x01;
            }
          }
        }
        part.segs = part.segs.filter((_, index) => index !== segId);
        part.segs.push([start, end]);
        return 0x00;
      }
      case 0x23: {
        /*
         * LayoutCommit：整份校验，与固件 `lumen_layout_store_validate` 同口径。
         *
         * **0 段的部位是合法的**（它只是整条黑，§6.1 允许「有部位但没划灯珠」），
         * 所以只校验段本身：区间合法 + 同链互斥。
         */
        for (const strip of runtime.strips) {
          const seen: Array<[number, number]> = [];
          for (const part of strip.parts) {
            for (const [start, end] of part.segs) {
              if (start > end || end >= strip.ledCount) {
                return 0x01;
              }
              if (seen.some(([a, b]) => !(end < a || b < start))) {
                return 0x01;
              }
              seen.push([start, end]);
            }
          }
        }
        runtime.layoutValid = runtime.strips.some((strip) => strip.parts.length > 0);
        runtime.layoutStaging = false;
        return 0x00;
      }
      case 0x24: {
        /* 查询由 queryLayout 处理；走到这里说明调用方用错了通道。 */
        return 0x00;
      }
      /* ---- 场景族 0x25-0x29 ---- */
      case 0x25: {
        const sceneId = payload[0];
        const stripId = payload[1];
        const partId = payload[2];
        const stepCount = payload[3];
        const loop = payload[4];
        const on = payload[5];
        const part = runtime.strips[stripId]?.parts[partId];
        if (sceneId >= MAX_SCENES || part === undefined) {
          return 0x01;
        }
        if (stepCount > 8 || loop > 2 || on > 1) {
          return 0x01;
        }
        /* 只有步数真的变了才清空步骤（§6.2：点一下开关不该抹掉时间轴）。 */
        if (part.stepCount !== stepCount) {
          part.steps = part.steps.slice(0, stepCount);
          while (part.steps.length < stepCount) {
            part.steps.push({
              durationMs: 1000,
              layer0: staticLayer(0, 255),
              layer1: emptyLayer(),
            });
          }
        }
        part.stepCount = stepCount;
        part.loop = loop;
        part.on = on !== 0;
        return 0x00;
      }
      case 0x26: {
        if (payload.length !== SCENE_STEP_BYTES) {
          return 0x04;
        }
        const stripId = payload[1];
        const partId = payload[2];
        const stepIndex = payload[3];
        const durationMs = payload[4] | (payload[5] << 8);
        const part = runtime.strips[stripId]?.parts[partId];
        if (part === undefined) {
          return 0x01;
        }
        if (stepIndex >= part.stepCount) {
          return 0x01;
        }
        if (durationMs < STEP_MIN_MS || durationMs > STEP_MAX_MS) {
          return 0x01;
        }
        part.steps[stepIndex] = {
          durationMs,
          layer0: readLayer(payload, 6),
          layer1: readLayer(payload, 15),
        };
        return 0x00;
      }
      case 0x27: {
        const nameLen = payload[1];
        if (payload[0] >= MAX_SCENES || nameLen > NAME_BYTES) {
          return 0x01;
        }
        runtime.sceneName = decodeUtf8(payload, 2, nameLen);
        return 0x00;
      }
      case 0x28: {
        if (payload[0] >= MAX_SCENES) {
          return 0x01;
        }
        runtime.activeScene = payload[0];
        return 0x00;
      }
      case 0x29:
        return 0x00;
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
      case 0x1d: {
        /* 查询类由各自的 async 方法处理；走到这里说明调用方用错了通道。 */
        return 0x00;
      }
      default:
        return 0x02;
    }
  }

  /** 由运行时状态派生 32 字节 State 的等价对象（§7.3）。 */
  private stateOf(): DeviceState {
    const runtime = this.runtimeOrThrow();
    const stripCount = Math.max(
      1,
      runtime.strips.reduce((count, strip, index) => (strip.ledCount > 0 ? index + 1 : count), 1),
    );
    const ledCounts = runtime.strips.map((strip) => strip.ledCount);
    const partCounts = runtime.strips.map((strip) => strip.parts.length);
    return {
      power: runtime.power,
      brightness: runtime.brightness,
      maxBrightness: this.spec?.maxBrightness ?? 255,
      stripCount,
      stripPowerMask: runtime.stripPowerMask,
      activeScene: runtime.activeScene,
      layoutValid: runtime.layoutValid,
      stripLedCounts: ledCounts,
      partCounts,
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
     0x1b: "SetStripPower",
    0x1c: "QueryStripConfig",
    0x1d: "QueryDeviceInfo",
    0x20: "LayoutWrite",
    0x21: "LayoutPart",
    0x22: "LayoutSeg",
    0x23: "LayoutCommit",
    0x24: "QueryLayout",
    0x25: "ScenePart",
    0x26: "SceneStep",
    0x27: "SceneName",
    0x28: "ActivateScene",
    0x29: "QueryScene",
  };
  return labels[command] ?? `cmd 0x${command.toString(16)}`;
}
