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
 */

import {
  CMD,
  DEVICE_CMD,
  RX_UUID,
  SERVICE_UUID,
  STATE_UUID,
  TX_UUID,
  commandName,
} from "../protocol/constants";
import { bytesToHex } from "../protocol/hex";
import { decodeFrame, encodeFrame } from "../protocol/frame";
import { parseAck, parseState } from "../protocol/commands";
import type {
  AckResult,
  CommandRequest,
  DeviceState,
  DiscoveredDevice,
  LinkState,
} from "../protocol/types";
import { errorText, iosStateText, resultText, triage } from "./errors";
import { FrameLog } from "./log";
import { WxCallError, WxCallTimeoutError, wxCall } from "./wx-promise";
import { SerialWriter } from "./writer";

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

export interface LinkDetail {
  message?: string;
  deviceName?: string;
  /**
   * true = 非用户主动的断线（设备断电 / 超出范围 / 10006）。
   * 会话层据此启动 1s/2s/4s 自动回连；主动 disconnect 不带这个标记。
   */
  reconnectable?: boolean;
}

export interface SendOptions {
  timeoutMs?: number;
  /** ACK 超时后重发次数（开关允许 1 次；连续量必须是 0）。 */
  retryOnTimeout?: number;
}

interface AckWaiter {
  command: number;
  resolve: (ack: AckResult) => void;
  reject: (err: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface StateWaiter {
  resolve: (value: Uint8Array) => void;
  reject: (err: unknown) => void;
}

const DEFAULT_INIT_SETTLE_MS = 500;
const DEFAULT_ACK_TIMEOUT_MS = 600;
const DEFAULT_STATE_READ_TIMEOUT_MS = 2000;
const DEFAULT_SCAN_HINT_MS = 10000;
const DEVICE_FLUSH_MS = 300;

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
  private readonly scanHintMs: number;

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

  private readonly devices = new Map<string, DiscoveredDevice>();
  private deviceFlushTimer: ReturnType<typeof setTimeout> | null = null;
  private scanTimer: ReturnType<typeof setTimeout> | null = null;
  private scanHint: string | null = null;
  /** 用户想扫描但适配器不可用：蓝牙打开后自动继续（spec 用户故事 8）。 */
  private scanRequested = false;

  private readonly writer: SerialWriter;
  private readonly ackWaiters = new Map<number, AckWaiter>();
  private stateWaiter: StateWaiter | null = null;
  private stateReadPromise: Promise<DeviceState> | null = null;

  private readonly linkListeners: Array<(state: LinkState, detail?: LinkDetail) => void> = [];
  private readonly deviceListeners: Array<(list: DiscoveredDevice[]) => void> = [];
  private readonly stateListeners: Array<(state: DeviceState) => void> = [];
  private readonly eventListeners: Array<(code: number, detail: number) => void> = [];
  private readonly scanHintListeners: Array<(hint: string | null) => void> = [];

  private destroyed = false;

  constructor(opts: BleTransportOptions) {
    this.log = opts.log;
    this.platform = opts.platform;
    this.initSettleMs = opts.initSettleMs ?? DEFAULT_INIT_SETTLE_MS;
    this.ackTimeoutMs = opts.ackTimeoutMs ?? DEFAULT_ACK_TIMEOUT_MS;
    this.stateReadTimeoutMs = opts.stateReadTimeoutMs ?? DEFAULT_STATE_READ_TIMEOUT_MS;
    this.scanHintMs = opts.scanHintMs ?? DEFAULT_SCAN_HINT_MS;

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
    this.linkListeners.push(fn);
    return () => {
      const i = this.linkListeners.indexOf(fn);
      if (i >= 0) this.linkListeners.splice(i, 1);
    };
  }

  onDevices(fn: (list: DiscoveredDevice[]) => void): () => void {
    this.deviceListeners.push(fn);
    return () => {
      const i = this.deviceListeners.indexOf(fn);
      if (i >= 0) this.deviceListeners.splice(i, 1);
    };
  }

  onState(fn: (state: DeviceState) => void): () => void {
    this.stateListeners.push(fn);
    return () => {
      const i = this.stateListeners.indexOf(fn);
      if (i >= 0) this.stateListeners.splice(i, 1);
    };
  }

  onDeviceEvent(fn: (code: number, detail: number) => void): () => void {
    this.eventListeners.push(fn);
    return () => {
      const i = this.eventListeners.indexOf(fn);
      if (i >= 0) this.eventListeners.splice(i, 1);
    };
  }

  onScanHint(fn: (hint: string | null) => void): () => void {
    this.scanHintListeners.push(fn);
    return () => {
      const i = this.scanHintListeners.indexOf(fn);
      if (i >= 0) this.scanHintListeners.splice(i, 1);
    };
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

    this.devices.clear();
    this.emitDevices();
    this.setScanHint(null);
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

    this.clearScanTimer();
    this.scanTimer = setTimeout(() => {
      this.scanTimer = null;
      if (this.link === "scanning" && this.devices.size === 0) {
        this.setScanHint(
          this.platform === "android"
            ? "10 秒未发现设备：请检查定位权限与定位开关"
            : "10 秒未发现设备：请检查微信的蓝牙授权",
        );
      }
    }, this.scanHintMs);
  }

  async stopScan(): Promise<void> {
    this.scanRequested = false;
    this.clearScanTimer();
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
    this.setScanHint(null);
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
    const frame = encodeFrame(req.command, seq, req.payload);
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
    const frame = encodeFrame(req.command, seq, req.payload);

    const timeoutMs = timeoutOverride ?? this.ackTimeoutMs;
    const ackPromise = new Promise<AckResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.ackWaiters.delete(seq);
        reject(new WxCallTimeoutError("ACK", timeoutMs));
      }, timeoutMs);
      this.ackWaiters.set(seq, {
        command: req.command,
        resolve,
        reject: (err) => reject(err),
        timer,
      });
    });
    // 写失败时我们会先 throw、不 await ackPromise；挂一个空 catch 防止
    // Node/开发者工具把这次 reject 报成 UnhandledPromiseRejection。
    ackPromise.catch(() => undefined);

    this.logFrame("tx", frame, req.command, seq, describeTx(req));
    try {
      await this.writer.enqueue(frame);
    } catch (err) {
      this.logFailure(frame, req.command, seq, errorText(err));
      const waiter = this.ackWaiters.get(seq);
      if (waiter !== undefined) {
        clearTimeout(waiter.timer);
        this.ackWaiters.delete(seq);
        waiter.reject(err);
      }
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

  // ------------------------------------------------------------------
  // 读 State
  // ------------------------------------------------------------------

  /** 读 State：注册 waiter → 调 read → 等 value 事件（success ≠ 数据到达）。 */
  readState(): Promise<DeviceState> {
    if (this.stateReadPromise !== null) {
      return this.stateReadPromise;
    }
    const deviceId = this.deviceId;
    const serviceId = this.serviceId;
    const characteristicId = this.stateId;
    if (deviceId === null || serviceId === null || characteristicId === null) {
      return Promise.reject(new Error("未连接"));
    }

    const promise = new Promise<DeviceState>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.stateWaiter = null;
        this.stateReadPromise = null;
        reject(new WxCallTimeoutError("State read", this.stateReadTimeoutMs));
      }, this.stateReadTimeoutMs);

      this.stateWaiter = {
        resolve: (value: Uint8Array) => {
          clearTimeout(timer);
          this.stateWaiter = null;
          this.stateReadPromise = null;
          try {
            const state = parseState(value);
            this.emitState(state);
            resolve(state);
          } catch (err) {
            reject(err);
          }
        },
        reject: (err: unknown) => {
          clearTimeout(timer);
          this.stateWaiter = null;
          this.stateReadPromise = null;
          reject(err);
        },
      };
    });
    this.stateReadPromise = promise;

    wxCall(
      "readBLECharacteristicValue",
      wx.readBLECharacteristicValue,
      { deviceId, serviceId, characteristicId },
      this.stateReadTimeoutMs,
    ).catch((err) => {
      this.stateWaiter?.reject(err);
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
    this.clearScanTimer();
    if (this.deviceFlushTimer !== null) {
      clearTimeout(this.deviceFlushTimer);
      this.deviceFlushTimer = null;
    }
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
    this.linkListeners.length = 0;
    this.deviceListeners.length = 0;
    this.stateListeners.length = 0;
    this.eventListeners.length = 0;
    this.scanHintListeners.length = 0;
  }

  // ------------------------------------------------------------------
  // wx 事件处理（箭头函数：destroy 时要用同一引用反注册）
  // ------------------------------------------------------------------

  private readonly handleDeviceFound = (res: any): void => {
    if (this.destroyed) {
      return;
    }
    const found: any[] = res?.devices ?? [];
    let changed = false;
    for (const dev of found) {
      const id = dev?.deviceId;
      if (!id) {
        continue;
      }
      // 广播名优先取扫描响应里的 localName，name 仅兜底。
      const name = dev.localName || dev.name || "(无名)";
      this.devices.set(id, { deviceId: id, name, rssi: dev.RSSI ?? 0 });
      changed = true;
    }
    if (changed) {
      this.scheduleDeviceFlush();
      if (this.link === "scanning" && this.devices.size > 0) {
        this.setScanHint(null);
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
      this.logFrame("rx", bytes, undefined, undefined, "State read 回值");
      const waiter = this.stateWaiter;
      if (waiter !== null) {
        waiter.resolve(bytes.slice());
      } else {
        try {
          this.emitState(parseState(bytes));
        } catch {
          /* 非 8 字节的 State 回值：记录日志已足够 */
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
    const result = decodeFrame(bytes);
    if (!result.ok) {
      this.logFrame("rx", bytes, undefined, undefined, `解码失败（${result.reason}）`, false);
      return;
    }

    const { command, seq, payload } = result;
    if (command === DEVICE_CMD.ACK) {
      let ack: AckResult;
      try {
        ack = parseAck(payload, seq);
      } catch (err) {
        this.logFrame("rx", bytes, command, seq, errorText(err), false);
        return;
      }
      this.logFrame(
        "rx",
        bytes,
        command,
        seq,
        `ACK ${commandName(ack.command)} ${ack.ok ? "OK" : resultText(ack.resultCode)}`,
        ack.ok,
      );
      const waiter = this.ackWaiters.get(seq);
      if (waiter !== undefined) {
        if (waiter.command === ack.command) {
          clearTimeout(waiter.timer);
          this.ackWaiters.delete(seq);
          waiter.resolve(ack);
        } else {
          // seq 对上但原命令字不符：协议异常，记录但不兑现。
          console.warn(`[lumen] ACK 原命令字不匹配 seq=${seq}`);
        }
      }
      return;
    }

    if (command === DEVICE_CMD.STATE_REPORT) {
      try {
        const state = parseState(payload);
        this.logFrame("rx", bytes, command, seq, describeState(state), true);
        this.emitState(state);
      } catch (err) {
        this.logFrame("rx", bytes, command, seq, errorText(err), false);
      }
      return;
    }

    if (command === DEVICE_CMD.EVENT) {
      if (payload.length !== 2) {
        this.logFrame("rx", bytes, command, seq, "Event 载荷长度错误", false);
        return;
      }
      const code = payload[0];
      const detail = payload[1];
      this.logFrame(
        "rx",
        bytes,
        command,
        seq,
        code === 0x01 ? `存储失败（原命令 ${commandName(detail)}）` : `Event ${code}`,
        code !== 0x01,
      );
      for (const fn of this.eventListeners.slice()) {
        fn(code, detail);
      }
      return;
    }

    this.logFrame("rx", bytes, command, seq, "未知的设备→小程序命令", false);
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
    for (const waiter of this.ackWaiters.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(reason);
    }
    this.ackWaiters.clear();
    if (this.stateWaiter !== null) {
      this.stateWaiter.reject(reason);
      this.stateWaiter = null;
    }
    this.stateReadPromise = null;
  }

  private setLink(state: LinkState, detail?: LinkDetail): void {
    this.link = state;
    for (const fn of this.linkListeners.slice()) {
      try {
        fn(state, detail);
      } catch {
        /* 监听者异常不能影响状态机 */
      }
    }
  }

  private emitDevices(): void {
    const list = Array.from(this.devices.values()).sort((a, b) => b.rssi - a.rssi);
    for (const fn of this.deviceListeners.slice()) {
      try {
        fn(list);
      } catch {
        /* ignore */
      }
    }
  }

  private emitState(state: DeviceState): void {
    for (const fn of this.stateListeners.slice()) {
      try {
        fn(state);
      } catch {
        /* ignore */
      }
    }
  }

  private setScanHint(hint: string | null): void {
    this.scanHint = hint;
    this.emitScanHint();
  }

  private emitScanHint(): void {
    for (const fn of this.scanHintListeners.slice()) {
      try {
        fn(this.scanHint);
      } catch {
        /* ignore */
      }
    }
  }

  private scheduleDeviceFlush(): void {
    if (this.deviceFlushTimer !== null) {
      return;
    }
    this.deviceFlushTimer = setTimeout(() => {
      this.deviceFlushTimer = null;
      this.emitDevices();
    }, DEVICE_FLUSH_MS);
  }

  private clearScanTimer(): void {
    if (this.scanTimer !== null) {
      clearTimeout(this.scanTimer);
      this.scanTimer = null;
    }
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

function describeTx(req: CommandRequest): string {
  const name = commandName(req.command);
  if (req.command === CMD.SET_POWER && req.payload.length === 1) {
    return `${name} power=${req.payload[0]}`;
  }
  return `${name} ${bytesToHex(req.payload)}`.trim();
}

function describeState(state: DeviceState): string {
  return (
    `State power=${state.power} brightness=${state.brightness} ` +
    `rgb=${state.r},${state.g},${state.b} leds=${state.ledCount} max=${state.maxBrightness}`
  );
}
