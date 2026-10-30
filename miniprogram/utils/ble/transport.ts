/**
 * BLE 传输层：唯一接触 wx.* BLE API 的模块。
 *
 * 职责：
 *  - 适配器 / 扫描 / 连接 / 固定初始化流水线（MTU → services → characteristics →
 *    notify → 等 500ms → 读 State）；
 *  - 写入串行化（SerialWriter）；
 *  - 帧收发、ACK 匹配、Event / StateReport 分发；
 *  - 每连接重置 seq = 0x01（协议 §9）；
 *  - 断线时清空写队列与所有等待者。
 *
 * UI 层不直接调用任何 BLE API；#11 的自动退避回连只需在同一状态机上补状态。
 *
 * 拆分后的协作模块（同级 utils/ble/）：
 *  - frame-codec.ts：入站帧解码与出站日志描述（纯函数，不碰 wx）；
 *  - ack-waiters.ts：ACK 等待表；
 *  - state-read.ts：State read 的 value 等待者；
 *  - scan-controller.ts：扫描结果缓存与合并派发；
 *  - link-listeners.ts：订阅表与派发。
 */

import { RX_UUID, SERVICE_UUID, STATE_UUID, TX_UUID, commandName } from "../protocol/constants";
import { bytesToHex } from "../protocol/hex";
import { parseState, type ScriptSummary } from "../protocol/commands";
import type {
  AckResult,
  CommandRequest,
  DeviceState,
  DiscoveredDevice,
  LinkState,
  SegmentListEnd,
  SegmentReport,
} from "../protocol/types";
import { AckWaiters } from "./ack-waiters";
import { errorText, iosStateText, resultText, triage } from "./errors";
import {
  describeStateReadBytes,
  describeTx,
  encodeTxFrame,
  routeInboundFrame,
} from "./frame-codec";
import { TransportListeners, type LinkDetail } from "./link-listeners";
import { FrameLog } from "./log";
import { DeviceScanner } from "./scan-controller";
import { StateReadSlot } from "./state-read";
import { StripQueryCollector } from "./strip-collector";
import { WxCallError, WxCallTimeoutError, wxCall } from "./wx-promise";
import { SerialWriter } from "./writer";

export type { LinkDetail } from "./link-listeners";

export interface BleTransportOptions {
  log: FrameLog;
  platform: "android" | "ios" | "other";
  /** notify 订阅成功后到第一次读 State 的间隔（Android 防 10008）。 */
  initSettleMs?: number;
  /** 普通命令等 ACK 的超时。SetLedCount 由调用方传 3000。 */
  ackTimeoutMs?: number;
  /** 读 State 等 value 事件的超时。 */
  stateReadTimeoutMs?: number;
  /** 扫描无结果提示的等待时间。 */
  scanHintMs?: number;
}

export interface SendOptions {
  timeoutMs?: number;
  /** ACK 超时后重发次数（开关允许 1 次；连续量必须是 0）。 */
  retryOnTimeout?: number;
}

const DEFAULT_INIT_SETTLE_MS = 500;
const DEFAULT_ACK_TIMEOUT_MS = 600;
const DEFAULT_STATE_READ_TIMEOUT_MS = 2000;
const DEFAULT_SCAN_HINT_MS = 10000;

function upper(value: string | undefined): string {
  return (value ?? "").toUpperCase();
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class BleTransport {
  readonly log: FrameLog;

  private readonly platform: "android" | "ios" | "other";
  private readonly initSettleMs: number;
  private readonly ackTimeoutMs: number;
  private readonly stateReadTimeoutMs: number;

  private link: LinkState = "uninitialized";
  private adapterOpened = false;
  /** createBLEConnection 成功之前，忽略旧连接残留的 DISCONNECT 事件。 */
  private connectionConfirmed = false;
  /** value 事件过滤用的 deviceId：连接过程中也不清空。 */
  private filterDeviceId: string | null = null;

  private deviceId: string | null = null;
  private deviceName: string | null = null;
  private serviceId: string | null = null;
  private rxId: string | null = null;
  private txId: string | null = null;
  private stateId: string | null = null;

  /** 每条连接从 0x01 开始；发送时分配，回绕 0xFF → 0x00。 */
  private nextSeq = 1;

  private readonly listeners = new TransportListeners();
  private readonly scanner: DeviceScanner;
  /** 用户想扫描但适配器不可用：蓝牙打开后自动继续（spec 用户故事 8）。 */
  private scanRequested = false;

  private readonly writer: SerialWriter;
  private readonly ackWaiters = new AckWaiters();
  private readonly stateRead = new StateReadSlot();
  /** #25：QueryStrip 的多帧收集（seg_count 条 SegmentReport + 1 条 ListEnd）。 */
  private readonly stripQueries = new StripQueryCollector();
  /**
   * #32：QueryScript 的响应（一条 ScriptSummary 0x85，回显请求 seq）。
   * 同一时刻只允许一个查询：下发流程与 UI 不会并发查剧本。
   */
  private pendingScriptQuery: {
    seq: number;
    resolve: (summary: ScriptSummary) => void;
    reject: (err: unknown) => void;
    timer: ReturnType<typeof setTimeout>;
  } | null = null;

  private destroyed = false;

  constructor(opts: BleTransportOptions) {
    this.log = opts.log;
    this.platform = opts.platform;
    this.initSettleMs = opts.initSettleMs ?? DEFAULT_INIT_SETTLE_MS;
    this.ackTimeoutMs = opts.ackTimeoutMs ?? DEFAULT_ACK_TIMEOUT_MS;
    this.stateReadTimeoutMs = opts.stateReadTimeoutMs ?? DEFAULT_STATE_READ_TIMEOUT_MS;
    this.scanner = new DeviceScanner(
      this.listeners,
      opts.scanHintMs ?? DEFAULT_SCAN_HINT_MS,
    );

    this.writer = new SerialWriter((bytes) => this.sendOne(bytes));

    // 监听注册必须早于 startBluetoothDevicesDiscovery（探针经验）。
    wx.onBluetoothDeviceFound(this.handleDeviceFound);
    wx.onBLECharacteristicValueChange(this.handleValueChange);
    wx.onBLEConnectionStateChange(this.handleConnectionStateChange);
    wx.onBluetoothAdapterStateChange(this.handleAdapterStateChange);
  }

  get linkState(): LinkState {
    return this.link;
  }

  get currentDeviceId(): string | null {
    return this.deviceId;
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

  /** #32：设备侧 ScriptProgress(0x86) 的旁证（scriptId + 设备侧累计帧数）。 */
  onScriptProgress(fn: (scriptId: number, frames: number) => void): () => void {
    return this.listeners.onScriptProgress(fn);
  }

  // ------------------------------------------------------------------
  // 适配器与扫描
  // ------------------------------------------------------------------

  /** 打开适配器。10001 非致命：进入 adapter-off，等系统蓝牙打开后的事件。 */
  async openAdapter(): Promise<void> {
    if (this.adapterOpened) {
      return;
    }
    try {
      await wxCall("openBluetoothAdapter", wx.openBluetoothAdapter, { mode: "central" }, 5000);
      this.adapterOpened = true;
      if (this.link === "uninitialized" || this.link === "adapter-off") {
        this.setLink("idle");
      }
    } catch (err) {
      const code = err instanceof WxCallError ? err.errCode : undefined;
      if (code === 10001) {
        // 模块已初始化，只是系统蓝牙没开：显示「请打开蓝牙」并继续监听。
        this.adapterOpened = true;
        this.setLink("adapter-off", { message: this.adapterOffText(err) });
        return;
      }
      this.scanRequested = false;
      this.setLink("failed", { message: this.adapterOffText(err) });
      throw err;
    }
  }

  /** iOS 的 fail state 0-4 必须映射成文案；Android 统一「请打开蓝牙」。 */
  private adapterOffText(err: unknown): string {
    if (this.platform === "ios" && err instanceof WxCallError) {
      const state = (err.raw as { state?: number } | null)?.state;
      if (typeof state === "number") {
        return iosStateText(state);
      }
    }
    if (err instanceof WxCallError && err.errCode === 10001) {
      return "请打开蓝牙";
    }
    return errorText(err);
  }

  async startScan(): Promise<void> {
    if (this.link === "scanning") {
      return;
    }
    if (this.link === "connecting" || this.link === "initializing") {
      throw new Error("正在连接，无法扫描");
    }

    this.scanRequested = true;
    await this.openAdapter();
    if (this.link === "adapter-off") {
      throw new Error("请打开蓝牙");
    }

    this.scanner.reset();
    this.scanner.setHint(null);
    this.setLink("scanning", { message: "扫描中…" });

    try {
      await wxCall(
        "startBluetoothDevicesDiscovery",
        wx.startBluetoothDevicesDiscovery,
        {
          services: [SERVICE_UUID],
          allowDuplicatesKey: true,
          interval: 500,
        },
        5000,
      );
    } catch (err) {
      this.setLink("failed", { message: errorText(err) });
      throw err;
    }

    this.scanner.scheduleHint(() => {
      if (this.link === "scanning" && this.scanner.size === 0) {
        return this.platform === "android"
          ? "10 秒未发现设备：请检查定位权限与定位开关"
          : "10 秒未发现设备：请检查微信的蓝牙授权";
      }
      return null;
    });
  }

  async stopScan(): Promise<void> {
    this.scanRequested = false;
    this.scanner.clearHintTimer();
    if (this.link !== "scanning") {
      return;
    }
    try {
      await wxCall(
        "stopBluetoothDevicesDiscovery",
        wx.stopBluetoothDevicesDiscovery,
        {},
        3000,
      );
    } catch {
      /* 停扫失败不影响后续流程 */
    }
    if (this.link === "scanning") {
      this.setLink("idle");
    }
    this.scanner.setHint(null);
  }

  // ------------------------------------------------------------------
  // 连接与初始化
  // ------------------------------------------------------------------

  /** 停扫 → 连接 → 固定初始化流水线 → 读 State。设备状态作为初始 UI 值返回。 */
  async connect(targetDeviceId: string, name?: string): Promise<DeviceState> {
    if (this.link === "connecting" || this.link === "initializing") {
      throw new Error("正在连接中");
    }
    if (this.link === "ready" && this.deviceId === targetDeviceId) {
      return this.readState();
    }

    this.scanRequested = false;
    await this.stopScan();
    // 单连接设备：换设备前先释放旧连接，否则 create 一定失败。
    const previous = this.deviceId;
    if (previous !== null && previous !== targetDeviceId) {
      this.resetLinkWaiters(new Error("切换设备"));
      await wxCall("closeBLEConnection", wx.closeBLEConnection, { deviceId: previous }, 2000).catch(
        () => undefined,
      );
      this.serviceId = null;
      this.rxId = null;
      this.txId = null;
      this.stateId = null;
    }
    this.connectionConfirmed = false;
    this.deviceId = targetDeviceId;
    this.filterDeviceId = targetDeviceId;
    this.deviceName = name ?? null;
    this.setLink("connecting", { deviceName: this.deviceName ?? undefined });

    try {
      // 单连接设备：重连前先吞掉旧连接残留（失败无所谓）。
      await wxCall("closeBLEConnection", wx.closeBLEConnection, { deviceId: targetDeviceId }, 2000).catch(
        () => undefined,
      );
      await wxCall(
        "createBLEConnection",
        wx.createBLEConnection,
        { deviceId: targetDeviceId, timeout: 10000 },
        12000,
      );
      this.connectionConfirmed = true;

      this.setLink("initializing", { deviceName: this.deviceName ?? undefined });
      // 新连接：seq 重置为 1，写队列解除上一个连接的失败状态。
      this.nextSeq = 1;
      this.writer.revive();
      const state = await this.initLink();
      this.setLink("ready", { deviceName: this.deviceName ?? undefined });
      return state;
    } catch (err) {
      // 初始化失败时先主动断开，避免设备侧残留连接（单连接设备）。
      // 先把 connectionConfirmed 清掉，让 close 触发的 DISCONNECT 走「旧连接」分支，
      // 不会把下面的 failed 状态覆盖回 idle。
      this.connectionConfirmed = false;
      await wxCall(
        "closeBLEConnection",
        wx.closeBLEConnection,
        { deviceId: targetDeviceId },
        2000,
      ).catch(() => undefined);
      this.clearConnectionHandles();
      this.setLink("failed", {
        message: errorText(err),
        deviceName: name,
      });
      throw err;
    }
  }

  /**
   * 固定初始化顺序（spec §3）：Android MTU → services → characteristics →
   * notify → 等 500ms → 读 State。每次连接都重新发现 GATT 句柄。
   */
  private async initLink(): Promise<DeviceState> {
    const deviceId = this.deviceId;
    if (deviceId === null) {
      throw new Error("未连接");
    }

    if (this.platform === "android") {
      try {
        const res = await wxCall<any>(
          "setBLEMTU",
          wx.setBLEMTU,
          { deviceId, mtu: 185 },
          3000,
        );
        // 请求值不是最终值，只记录回包。
        console.log(`[lumen] MTU 协商结果 ${res?.mtu ?? "?"}（帧长仍按 20 字节设计）`);
      } catch {
        /* MTU 只当优化，失败不阻断连接 */
      }
    }

    const servicesRes = await wxCall<any>(
      "getBLEDeviceServices",
      wx.getBLEDeviceServices,
      { deviceId },
      5000,
    );
    const services: any[] = servicesRes?.services ?? [];
    const service = services.find((s) => upper(s.uuid) === SERVICE_UUID);
    if (service === undefined) {
      throw new Error(`找不到 service ${SERVICE_UUID}`);
    }
    this.serviceId = service.uuid;
    const serviceId = service.uuid;

    const charsRes = await wxCall<any>(
      "getBLEDeviceCharacteristics",
      wx.getBLEDeviceCharacteristics,
      { deviceId, serviceId },
      5000,
    );
    const characteristics: any[] = charsRes?.characteristics ?? [];
    const rx = characteristics.find((c) => upper(c.uuid) === RX_UUID);
    const tx = characteristics.find((c) => upper(c.uuid) === TX_UUID);
    const state = characteristics.find((c) => upper(c.uuid) === STATE_UUID);
    if (rx === undefined) {
      throw new Error("找不到 RX 特征值");
    }
    if (tx === undefined) {
      throw new Error("找不到 TX 特征值");
    }
    if (state === undefined) {
      throw new Error("找不到 State 特征值");
    }
    if (rx.properties?.writeNoResponse !== true) {
      // 协议规定 RX 是 write-no-response；不满足说明固件不对，明确报错。
      throw new Error("RX 不支持 writeNoResponse（固件与协议不匹配）");
    }
    this.rxId = rx.uuid;
    this.txId = tx.uuid;
    this.stateId = state.uuid;

    await wxCall(
      "notifyBLECharacteristicValueChange",
      wx.notifyBLECharacteristicValueChange,
      {
        state: true,
        deviceId,
        serviceId,
        characteristicId: tx.uuid,
        type: "notification",
      },
      5000,
    );

    // notify 后立刻写会触发 Android 10008；等一小段或先读一次。
    await delay(this.initSettleMs);

    // read 的 success 只代表请求受理，真正的值走 value 事件。
    return this.readState();
  }

  async disconnect(): Promise<void> {
    const deviceId = this.deviceId;
    // 主动断开：先摘掉「已确认连接」标记，这样 close 触发的
    // onBLEConnectionStateChange(false) 会被当成「旧连接残留」直接返回，
    // 不会误发 reconnectable —— 主动断开绝不能触发自动回连（spec §3 / 笔记 #42）。
    this.connectionConfirmed = false;
    this.resetLinkWaiters(new Error("已断开连接"));
    if (deviceId !== null) {
      try {
        await wxCall("closeBLEConnection", wx.closeBLEConnection, { deviceId }, 3000);
      } catch {
        /* 已断开时 close 会失败，忽略 */
      }
    }
    this.clearConnectionHandles();
    this.setLink("idle");
  }

  // ------------------------------------------------------------------
  // 写入
  // ------------------------------------------------------------------

  /** 只等写入回调（连续量用）；ACK 异步记录在日志里。 */
  async write(req: CommandRequest): Promise<{ seq: number }> {
    this.ensureWritable();
    const seq = this.allocateSeq();
    const frame = encodeTxFrame(req.command, seq, req.payload);
    this.logFrame("tx", frame, req.command, seq, describeTx(req));
    try {
      await this.writer.enqueue(frame);
    } catch (err) {
      this.logFailure(frame, req.command, seq, errorText(err));
      // 10006 / 写回调超时：链路已经不可用，切到「非主动断线」交给会话层退避回连；
      // 10001：适配器被关掉，显示「请打开蓝牙」，等适配器事件（非致命）。
      this.noteWriteFailure(err);
      throw err;
    }
    return { seq };
  }

  /**
   * 离散命令：写入后等 ACK（按 seq + 原命令字匹配）。
   *
   * 只在 ACK 超时且 retryOnTimeout > 0 时重发（每次重发分配新 seq）；
   * 命令都是绝对值，重传不会造成状态翻转（protocol §9）。
   */
  async sendAndWaitAck(req: CommandRequest, opts: SendOptions = {}): Promise<AckResult> {
    const retries = opts.retryOnTimeout ?? 0;
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await this.sendAndWaitAckOnce(req, opts.timeoutMs);
      } catch (err) {
        const ackTimeout = err instanceof WxCallTimeoutError && err.api === "ACK";
        if (ackTimeout && attempt < retries) {
          console.warn(`[lumen] ACK 超时，重发 ${commandName(req.command)}（第 ${attempt + 1} 次）`);
          continue;
        }
        throw err;
      }
    }
  }

  private async sendAndWaitAckOnce(
    req: CommandRequest,
    timeoutOverride?: number,
  ): Promise<AckResult> {
    this.ensureWritable();
    const seq = this.allocateSeq();
    const frame = encodeTxFrame(req.command, seq, req.payload);

    const timeoutMs = timeoutOverride ?? this.ackTimeoutMs;
    const ackPromise = this.ackWaiters.register(seq, req.command, timeoutMs);

    this.logFrame("tx", frame, req.command, seq, describeTx(req));
    try {
      await this.writer.enqueue(frame);
    } catch (err) {
      this.logFailure(frame, req.command, seq, errorText(err));
      this.ackWaiters.fail(seq, err);
      this.noteWriteFailure(err);
      throw err;
    }

    const ack = await ackPromise;
    if (!ack.ok) {
      // 非零结果码：设备权威，UI 之后应重新读 State（#11 统一处理）。
      console.warn(`[lumen] ACK 失败 cmd=${ack.command} seq=${ack.seq}: ${resultText(ack.resultCode)}`);
    }
    return ack;
  }

  /**
   * #25：QueryStrip 0x12 + 多条 SegmentReport + SegmentListEnd。
   *
   * 与 sendAndWaitAck 的区别：响应不是单帧 ACK，而是同 seq 的多帧。
   * 这里同一 seq 既登记 ACK 等待者（拿到拒绝时的结果码），又登记段收集器
   * （拿到 SegmentReport 列表与 ListEnd）。ACK 与收尾两者都成功才返回。
   *
   * ACK 可能是非零（InvalidParam）：那时设备不会再发 SegmentReport，
   * 所以先 await ACK；ok 才等收尾。超时按链路异常抛出。
   */
  async queryStrip(
    stripId: number,
    opts: { timeoutMs?: number } = {},
  ): Promise<{ reports: SegmentReport[]; end: SegmentListEnd }> {
    this.ensureWritable();
    const seq = this.allocateSeq();
    const req: CommandRequest = { command: 0x12, payload: new Uint8Array([stripId & 0xff]) };
    const frame = encodeTxFrame(req.command, seq, req.payload);
    const timeoutMs = opts.timeoutMs ?? this.ackTimeoutMs;

    const ackPromise = this.ackWaiters.register(seq, req.command, timeoutMs);
    const collectPromise = this.stripQueries.open(seq, stripId, timeoutMs);

    this.logFrame("tx", frame, req.command, seq, describeTx(req));
    try {
      await this.writer.enqueue(frame);
    } catch (err) {
      this.logFailure(frame, req.command, seq, errorText(err));
      this.ackWaiters.fail(seq, err);
      this.stripQueries.reset(err instanceof Error ? err : new Error(String(err)));
      this.noteWriteFailure(err);
      throw err;
    }

    const ack = await ackPromise;
    if (!ack.ok) {
      /* 非零 ACK：设备不会发段回包。收尾 Promise 必须显式丢弃，避免悬挂。 */
      this.stripQueries.reset(new Error(`QueryStrip 被拒（${resultText(ack.resultCode)}）`));
      throw new Error(`QueryStrip 失败：${resultText(ack.resultCode)}`);
    }

    const result = await collectPromise;
    return { reports: result.reports, end: result.end };
  }

  /**
   * #32：QueryScript 0x1A + ScriptSummary 0x85。
   *
   * 响应是一条**单独**的 0x85（不是 ACK 的多帧续），同样回显请求 seq。
   * 流程与 queryStrip 一致：先等 ACK；ACK 非零时设备不会发 0x85。
   */
  async queryScript(
    scriptId: number,
    opts: { timeoutMs?: number } = {},
  ): Promise<ScriptSummary> {
    this.ensureWritable();
    const seq = this.allocateSeq();
    const req = { command: 0x1a, payload: new Uint8Array([scriptId & 0xff]) };
    const frame = encodeTxFrame(req.command, seq, req.payload);
    const timeoutMs = opts.timeoutMs ?? this.ackTimeoutMs;

    const ackPromise = this.ackWaiters.register(seq, req.command, timeoutMs);
    const summaryPromise = new Promise<ScriptSummary>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingScriptQuery = null;
        reject(new WxCallTimeoutError("QueryScript", timeoutMs));
      }, timeoutMs);
      this.pendingScriptQuery = { seq, resolve, reject, timer };
    });
    summaryPromise.catch(() => undefined);

    this.logFrame("tx", frame, req.command, seq, describeTx(req));
    try {
      await this.writer.enqueue(frame);
    } catch (err) {
      this.logFailure(frame, req.command, seq, errorText(err));
      this.ackWaiters.fail(seq, err);
      this.failPendingScriptQuery(err instanceof Error ? err : new Error(String(err)));
      this.noteWriteFailure(err);
      throw err;
    }

    const ack = await ackPromise;
    if (!ack.ok) {
      this.failPendingScriptQuery(
        new Error(`QueryScript 被拒（${resultText(ack.resultCode)}）`),
      );
      throw new Error(`QueryScript 失败：${resultText(ack.resultCode)}`);
    }
    return summaryPromise;
  }

  /**
   * #32：按顺序下发一串命令，每帧等 ACK。
   *
   * 剧本下发是「一帧一条命令」的批量流程，用 sendAndWaitAck 逐帧串行即可：
   * 顺序是协议要求（Begin → Stage/Segment → Commit），不能并发。
   * 回调在每帧确认后报告进度（done 是**已确认**的帧数）。
   */
  async sendSequence(
    requests: CommandRequest[],
    onProgress?: (done: number, total: number) => void,
    opts: SendOptions = {},
  ): Promise<void> {
    const total = requests.length;
    for (let i = 0; i < total; i += 1) {
      await this.sendAndWaitAck(requests[i], opts);
      onProgress?.(i + 1, total);
    }
  }

  // ------------------------------------------------------------------
  // 读 State
  // ------------------------------------------------------------------

  /** 读 State：注册 waiter → 调 read → 等 value 事件（success ≠ 数据到达）。 */
  readState(): Promise<DeviceState> {
    const inflight = this.stateRead.inflight;
    if (inflight !== null) {
      return inflight;
    }
    const deviceId = this.deviceId;
    const serviceId = this.serviceId;
    const characteristicId = this.stateId;
    if (deviceId === null || serviceId === null || characteristicId === null) {
      return Promise.reject(new Error("未连接"));
    }

    const promise = this.stateRead.open(this.stateReadTimeoutMs, (value) => {
      const state = parseState(value);
      this.listeners.emitState(state);
      return state;
    });

    wxCall(
      "readBLECharacteristicValue",
      wx.readBLECharacteristicValue,
      { deviceId, serviceId, characteristicId },
      this.stateReadTimeoutMs,
    ).catch((err) => {
      this.stateRead.reject(err);
    });

    return promise;
  }

  // ------------------------------------------------------------------
  // 清理
  // ------------------------------------------------------------------

  destroy(): void {
    if (this.destroyed) {
      return;
    }
    this.destroyed = true;
    this.scanner.clearTimers();
    this.resetLinkWaiters(new Error("页面已销毁"));

    // 反注册必须传同一个函数对象，否则 off 不生效。
    // 部分基础库版本的 typings 把 off* 声明为无参（等于移除全部监听），
    // 实际 API 接受 listener；传函数对旧版本是无害的兼容写法。
    const offDeviceFound = wx.offBluetoothDeviceFound as unknown as (
      fn: (res: unknown) => void,
    ) => void;
    const offValueChange = wx.offBLECharacteristicValueChange as unknown as (
      fn: (res: unknown) => void,
    ) => void;
    const offAdapterChange = wx.offBluetoothAdapterStateChange as unknown as (
      fn: (res: unknown) => void,
    ) => void;
    offDeviceFound(this.handleDeviceFound);
    offValueChange(this.handleValueChange);
    wx.offBLEConnectionStateChange(this.handleConnectionStateChange);
    offAdapterChange(this.handleAdapterStateChange);

    const deviceId = this.deviceId;
    if (deviceId !== null) {
      wx.closeBLEConnection({ deviceId, fail: () => undefined });
    }
    this.deviceId = null;
    this.filterDeviceId = null;
    this.listeners.clear();
  }

  // ------------------------------------------------------------------
  // wx 事件处理（箭头函数：destroy 时要用同一引用反注册）
  // ------------------------------------------------------------------

  private readonly handleDeviceFound = (res: any): void => {
    if (this.destroyed) {
      return;
    }
    const found: any[] = res?.devices ?? [];
    const changed = this.scanner.addDevices(found);
    if (changed) {
      if (this.link === "scanning" && this.scanner.size > 0) {
        this.scanner.setHint(null);
      }
    }
  };

  private readonly handleValueChange = (res: any): void => {
    if (this.destroyed) {
      return;
    }
    const deviceId = res?.deviceId ?? "";
    // 断开后 filterDeviceId 会被清空：此时任何 value 回调都属于旧连接，
    // 必须丢弃，否则旧 State / 旧 ACK 会串进新连接（设备是状态权威）。
    if (this.filterDeviceId === null || upper(deviceId) !== upper(this.filterDeviceId)) {
      return;
    }
    const characteristicId = upper(res?.characteristicId);
    const raw = res?.value;
    if (!(raw instanceof ArrayBuffer)) {
      return;
    }
    const bytes = new Uint8Array(raw);

    if (characteristicId === upper(this.txId ?? TX_UUID)) {
      this.handleDeviceFrame(bytes);
      return;
    }
    if (characteristicId === upper(this.stateId ?? STATE_UUID)) {
      // State read 回值不是协议帧（直接 14 字节），但同样进日志、同样可解析。
      this.logFrame("rx", bytes, undefined, undefined, describeStateReadBytes(bytes));
      if (!this.stateRead.deliver(bytes)) {
        try {
          this.listeners.emitState(parseState(bytes));
        } catch {
          /* 非 14 字节的 State 回值：记录日志已足够 */
        }
      }
    }
  };

  private readonly handleConnectionStateChange = (res: any): void => {
    if (this.destroyed) {
      return;
    }
    const deviceId = res?.deviceId ?? "";
    if (this.filterDeviceId === null || upper(deviceId) !== upper(this.filterDeviceId)) {
      return;
    }
    if (res?.connected === true) {
      return; // 连接建立由 connect() 的流水线继续
    }
    if (this.deviceId === null || !this.connectionConfirmed) {
      // createBLEConnection 成功前的 DISCONNECT 属于旧连接残留。
      return;
    }

    // 断线：清空写队列、reject 所有等待者；UI 立即显示未连接。
    // reconnectable 让会话层启动 1s/2s/4s 退避回连（这是唯一自动回连触发源）。
    this.markLinkLost("连接已断开");
  };

  private readonly handleAdapterStateChange = (res: any): void => {
    if (this.destroyed) {
      return;
    }
    if (res?.available === false) {
      // 适配器关闭：连接必然失效。清掉设备句柄与等待者，避免残留状态。
      this.resetLinkWaiters(new Error("蓝牙已关闭"));
      this.clearConnectionHandles();
      this.setLink("adapter-off", { message: "请打开蓝牙" });
      return;
    }
    // 适配器恢复：如果用户此前发起过扫描，自动继续（不等用户重启小程序）。
    if (this.link === "adapter-off" || this.link === "uninitialized") {
      this.setLink("idle");
      if (this.scanRequested) {
        void this.startScan().catch((err) => {
          this.setLink("failed", { message: errorText(err) });
        });
      }
    }
  };

  // ------------------------------------------------------------------
  // 内部
  // ------------------------------------------------------------------

  private handleDeviceFrame(bytes: Uint8Array): void {
    const frame = routeInboundFrame(bytes);
    this.logFrame("rx", bytes, frame.command, frame.seq, frame.text, frame.ok);

    switch (frame.action.kind) {
      case "ack":
        this.ackWaiters.settle(frame.seq as number, frame.action.ack);
        return;
      case "state":
        this.listeners.emitState(frame.action.state);
        return;
      case "event":
        this.listeners.emitEvent(frame.action.code, frame.action.detail);
        return;
      case "segment-report":
        /* #25：同 seq 多帧，交给 QueryStrip 的收集器。 */
        this.stripQueries.report(frame.seq as number, frame.action.report);
        return;
      case "segment-list-end":
        this.stripQueries.listEnd(frame.seq as number, frame.action.end);
        return;
      case "script-summary": {
        const pending = this.pendingScriptQuery;
        if (pending !== null && pending.seq === frame.seq) {
          clearTimeout(pending.timer);
          this.pendingScriptQuery = null;
          pending.resolve(frame.action.summary);
        }
        return;
      }
      case "script-progress":
        /* 设备侧旁证，不进 ACK 等待表；只广播给关心进度的 UI。 */
        this.listeners.emitScriptProgress(
          frame.action.progress.scriptId,
          frame.action.progress.framesWritten,
        );
        return;
      default:
        return;
    }
  }

  /** 丢掉 in-flight 的 QueryScript（写失败 / 被拒 / 断线）。 */
  private failPendingScriptQuery(err: Error): void {
    const pending = this.pendingScriptQuery;
    if (pending === null) {
      return;
    }
    clearTimeout(pending.timer);
    this.pendingScriptQuery = null;
    pending.reject(err);
  }

  /**
   * 清掉一条连接的全部句柄与 seq。
   *
   * 每次连接（含回连）的 GATT 句柄与订阅都是 per-connection 的，必须重新发现；
   * filterDeviceId 也一起清空，后续任何迟到 value 回调都会被丢弃。
   */
  private clearConnectionHandles(): void {
    this.connectionConfirmed = false;
    this.deviceId = null;
    this.filterDeviceId = null;
    this.serviceId = null;
    this.rxId = null;
    this.txId = null;
    this.stateId = null;
    this.nextSeq = 1;
  }

  /**
   * 非主动断线的统一收尾：清等待者与句柄 → `idle` + reconnectable。
   * 触发源只有一个（这里），会话层据此启动退避回连；不做重试写。
   */
  private markLinkLost(message: string): void {
    if (this.link !== "ready" && this.link !== "initializing") {
      return;
    }
    this.resetLinkWaiters(new Error(message));
    this.clearConnectionHandles();
    this.setLink("idle", { message, deviceName: this.deviceName ?? undefined, reconnectable: true });
  }

  /**
   * 写失败的错误分诊（spec §9）：
   *  - 10006 / 写回调超时 → 链路已断：切 reconnectable，**不在这里重试写**；
   *  - 10001 → 适配器被关闭：非致命，切 adapter-off 等 onBluetoothAdapterStateChange；
   *  - 10008 → 留给会话层「加间隔重试一次」，这里不动链路状态。
   */
  private noteWriteFailure(err: unknown): void {
    const action = triage(err);
    if (action === "reconnect") {
      this.markLinkLost("连接已断开");
    } else if (action === "wait-adapter" && this.link === "ready") {
      this.resetLinkWaiters(new Error("请打开蓝牙"));
      this.clearConnectionHandles();
      this.setLink("adapter-off", { message: "请打开蓝牙" });
    }
  }

  private sendOne(bytes: Uint8Array): Promise<void> {
    const deviceId = this.deviceId;
    const serviceId = this.serviceId;
    const characteristicId = this.rxId;
    if (deviceId === null || serviceId === null || characteristicId === null) {
      return Promise.reject(new Error("未连接"));
    }
    // 复制成独立 ArrayBuffer：某些平台对视图的底层缓冲区长度敏感。
    const value = bytes.slice().buffer;
    return wxCall(
      "writeBLECharacteristicValue",
      wx.writeBLECharacteristicValue,
      { deviceId, serviceId, characteristicId, value, writeType: "writeNoResponse" },
      2000,
    );
  }

  private ensureWritable(): void {
    if (this.link !== "ready" || this.deviceId === null || this.rxId === null) {
      throw new Error("设备未就绪");
    }
  }

  private allocateSeq(): number {
    const seq = this.nextSeq;
    this.nextSeq = (this.nextSeq + 1) & 0xff;
    return seq;
  }

  private resetLinkWaiters(reason: Error): void {
    this.writer.reset(reason);
    this.ackWaiters.reset(reason);
    this.stateRead.reset(reason);
    this.stripQueries.reset(reason);
    this.failPendingScriptQuery(reason);
  }

  private setLink(state: LinkState, detail?: LinkDetail): void {
    this.link = state;
    this.listeners.emitLink(state, detail);
  }

  /** 写失败时补一条同 seq 的日志，保留「这一帧没发出去」的证据。 */
  private logFailure(
    bytes: Uint8Array,
    command: number,
    seq: number,
    message: string,
  ): void {
    this.log.push({
      ts: Date.now(),
      dir: "tx",
      hex: bytesToHex(bytes),
      command,
      seq,
      parsed: `写入失败：${message}`,
      ok: false,
    });
  }

  /** TX 帧入日志。hex 与命令字是排查两端 seq 对齐的主线索。 */
  private logFrame(
    dir: "tx" | "rx",
    bytes: Uint8Array,
    command: number | undefined,
    seq: number | undefined,
    parsed: string,
    ok?: boolean,
  ): void {
    this.log.push({ ts: Date.now(), dir, hex: bytesToHex(bytes), command, seq, parsed, ok });
  }
}
