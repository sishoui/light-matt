/**
 * BLE 传输层：唯一接触 wx.* BLE API 的模块。
 *
 * 职责：
 *  - 适配器 / 扫描 / 连接 / 固定初始化流水线（MTU → services → characteristics →
 *    notify → 等 500ms → 读 State）；
 *  - 写入串行化（SerialWriter）；
 *  - 帧收发、ACK 匹配、Event / StateReport 分发；
 *  - 每连接重置 seq = 0x01（协议 §8）；
 *  - 断线时清空写队列与所有等待者。
 *
 * v3（#40）变化：
 *  - 每次逻辑帧先分片（chunk.ts）再串行写入；MTU 未知按 23（20 字节）工作；
 *  - 入站 notify 先重组（ChunkAssembler）再解帧；
 *  - ACK / 查询超时按分片数放大（13 片 × 600ms 会让大帧必然超时）；
 *  - 新增 QueryStripConfig 0x1C / QueryDeviceInfo 0x1D 的单飞查询；
 *  - State read 若读到的长度不是 37（MTU 23 放不下），回落到 QueryState 0x05
 *    → StateReport 0x82，绝不静默截断。
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

import {
  DEFAULT_CHUNK_CAPACITY,
  RX_UUID,
  SERVICE_UUID,
  STATE_BYTES,
  STATE_UUID,
  TX_UUID,
  commandName,
} from "../protocol/constants";
import { bytesToHex } from "../protocol/hex";
import {
  cmdQueryDeviceInfo,
  cmdQueryState,
  cmdQueryStripConfig,
  parseState,
  type ScriptSummary,
} from "../protocol/commands";
import { chunkCapacityForMtu, chunkDataCapacity, chunkFrame, ChunkAssembler } from "../protocol/chunk";
import type {
  AckResult,
  CommandRequest,
  DeviceInfo,
  DeviceState,
  DiscoveredDevice,
  LinkState,
  SegmentListEnd,
  SegmentReport,
  StripConfig,
} from "../protocol/types";
import { AckWaiters } from "./ack-waiters";
import { AckRejectedError, errorText, iosStateText, resultText, triage } from "./errors";
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
/**
 * 每个分片额外放宽的 ACK 等待时间。
 *
 * 大帧（240B / cap 20）要 13 次串行写；固定 600ms 会让「设备其实收到了、
 * 只是排在后半段」的帧被误判超时。按片数线性放大，单分片行为完全不变。
 */
const ACK_TIMEOUT_PER_CHUNK_MS = 120;

function upper(value: string | undefined): string {
  return (value ?? "").toUpperCase();
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * `openBluetoothAdapter` 返回「已经打开」——这是成功状态，不是失败。
 *
 * 微信给这个错误的 errMsg 形如
 * `openBluetoothAdapter:fail already opened`（模拟器实测还有
 * `openBluetoothAdapter: openBluetoothAdapter: fail already opened` 这种前缀重复），
 * 且**不带 errCode**，所以只能匹配文案。
 *
 * 若不识别它，热重载后第一次扫描就会把链路打成 failed 并清掉
 * `scanRequested`，用户看到的是「点扫描毫无反应」。
 */
function isAdapterAlreadyOpened(err: unknown): boolean {
  const raw = err instanceof WxCallError ? err.raw : err;
  const message = `${(raw as { errMsg?: string } | null)?.errMsg ?? ""} ${(err as Error)?.message ?? ""}`;
  return /already\s*open/i.test(message);
}

/** 一条「只有单帧报告、没有多帧续」的查询（v3：0x1C / 0x1D）。 */
interface SingleReportQuery<T> {
  seq: number;
  resolve: (value: T) => void;
  reject: (err: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * State read 回值长度不是 37：不是链路错误，而是「read 这条路径放不下」。
 * 内部用它触发 QueryState 回落，不向上暴露（§7.3 / 协调者裁决 2）。
 */
class StateLengthMismatchError extends Error {
  readonly actual: number;

  constructor(actual: number) {
    super(`State read 返回 ${actual} 字节，v3 要求 ${STATE_BYTES} 字节`);
    this.name = "StateLengthMismatchError";
    this.actual = actual;
  }
}

/** readBLECharacteristicValue 失败：同样回落到 QueryState。 */
class StateReadFallbackError extends Error {
  constructor() {
    super("State read 失败，改用 QueryState");
    this.name = "StateReadFallbackError";
  }
}

/**
 * 用户点「取消」后，正在跑的连接尝试用它退出。
 *
 * 刻意不是 `Error` 的普通失败：取消是用户的正常意图，不该显示成错误，
 * 也不该触发自动回连退避。调用方靠 `instanceof` 区分「取消」与「连不上」。
 */
export class ConnectCancelledError extends Error {
  constructor() {
    super("已取消连接");
    this.name = "ConnectCancelledError";
  }
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

  /**
   * 连接尝试的代次。用户点「取消」时 +1。
   *
   * `createBLEConnection` / GATT 发现是 wx 的原子调用，**没有中断接口**，
   * 只能让它自己跑完。所以取消的做法是让这次尝试的结果作废：流水线在每次
   * await 之后核对代次，发现变了就静默退出，不写链路状态、不覆盖用户意图。
   * 如果不做这一步，用户取消后 3 秒（createBLEConnection 超时）整条链路会
   * 被那次「幽灵连接」翻成 failed 或 ready。
   */
  private connectEpoch = 0;

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

  /** v3：QueryStripConfig 0x1C → StripConfigReport 0x87（单飞）。 */
  private pendingStripConfig: SingleReportQuery<StripConfig> | null = null;
  /** v3：QueryDeviceInfo 0x1D → DeviceInfoReport 0x88（单飞）。 */
  private pendingDeviceInfo: SingleReportQuery<DeviceInfo> | null = null;
  /**
   * v3：State read 回落到 QueryState 时，等 0x82 的等待者（单飞）。
   * 带独立计时器：ACK 与 StateReport 是两段等待，任何一段都不能悬挂。
   */
  private pendingStateReport: {
    seq: number;
    resolve: (state: DeviceState) => void;
    reject: (err: unknown) => void;
    timer: ReturnType<typeof setTimeout>;
  } | null = null;

  /**
   * 协商到的 ATT MTU（未知 = null，按 23 工作）。只影响分片，不影响逻辑帧。
   */
  private mtu: number | null = null;
  /** 单次写上限（含 1 字节分片头）；由 mtu 推出，缺省 20。 */
  private chunkCapacity = DEFAULT_CHUNK_CAPACITY;
  /** 入站分片重组（一问一答，同一时刻只有一条逻辑帧在途）。 */
  private readonly assembler = new ChunkAssembler();
  /** State read 回落到 QueryState 时的在飞 Promise（单飞，避免重复查询）。 */
  private stateFallback: Promise<DeviceState> | null = null;

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
      /*
       * `fail already opened`：适配器**已经打开**，这是成功状态不是失败。
       *
       * 实测这个错误不带可用 errCode，只能看 errMsg。场景：
       *  - 开发者工具热重载后，新模块实例的 adapterOpened 是 false，
       *    而底层适配器还开着；
       *  - 真机上切换账号 / 重新进入小程序。
       * 早期把它当失败处理（scanRequested=false + failed），表现是「点扫描
       * 永远没反应」——扫描请求被自己取消了。
       */
      if (isAdapterAlreadyOpened(err)) {
        this.adapterOpened = true;
        if (this.link === "uninitialized" || this.link === "adapter-off") {
          this.setLink("idle");
        }
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
    /* 本次尝试的代次。取消（cancelConnect）会让它失效，后续每一步都要核对。 */
    const epoch = this.connectEpoch;
    const cancelled = (): boolean => epoch !== this.connectEpoch;
    this.setLink("connecting", { deviceName: this.deviceName ?? undefined });

    try {
      // 单连接设备：重连前先吞掉旧连接残留（失败无所谓）。
      await wxCall("closeBLEConnection", wx.closeBLEConnection, { deviceId: targetDeviceId }, 2000).catch(
        () => undefined,
      );
      if (cancelled()) {
        throw new ConnectCancelledError();
      }
      await wxCall(
        "createBLEConnection",
        wx.createBLEConnection,
        { deviceId: targetDeviceId, timeout: 10000 },
        12000,
      ).catch((err) => {
        /* 已取消时，底层无论是成功还是失败都不得改写链路状态：
         * 失败也要先翻成取消，否则页面会把「我主动取消」显示成连接错误。 */
        throw cancelled() ? new ConnectCancelledError() : err;
      });
      if (cancelled()) {
        throw new ConnectCancelledError();
      }
      this.connectionConfirmed = true;

      this.setLink("initializing", { deviceName: this.deviceName ?? undefined });
      // 新连接：seq 重置为 1，写队列解除上一个连接的失败状态。
      this.nextSeq = 1;
      this.writer.revive();
      const state = await this.initLink(cancelled);
      if (cancelled()) {
        throw new ConnectCancelledError();
      }
      this.setLink("ready", { deviceName: this.deviceName ?? undefined });
      return state;
    } catch (err) {
      // 取消不是失败：不写 failed、不抛给页面（页面已经改回「未连接」了）。
      if (err instanceof ConnectCancelledError) {
        this.connectionConfirmed = false;
        this.clearConnectionHandles();
        throw err;
      }
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
   * 用户点「取消」：让正在进行的连接尝试作废，链路回到 `idle`。
   *
   * 不返回 Promise 是因为底层的 `createBLEConnection` 无法中断——它还会继续
   * 跑到自己的超时，只是结果被代次号丢掉。这里立刻把 UI 状态改回去，用户
   * 感知是即时的。
   *
   * 返回 `true` 表示确实取消了一次进行中的尝试（调用方据此决定是否提示）。
   */
  cancelConnect(): boolean {
    if (this.link !== "connecting" && this.link !== "initializing") {
      return false;
    }
    this.connectEpoch += 1;
    /* 底层连接可能已经建成：主动关掉，避免设备侧留着一个没人用的连接
     * （协议是单连接，留着会让下一次扫描扫不到设备）。 */
    const deviceId = this.deviceId;
    if (deviceId !== null && this.connectionConfirmed) {
      this.connectionConfirmed = false;
      wx.closeBLEConnection({ deviceId, fail: () => undefined });
    }
    this.clearConnectionHandles();
    this.setLink("idle", { message: "已取消连接" });
    return true;
  }

  /**
   * 固定初始化顺序（spec §3）：Android MTU → services → characteristics →
   * notify → 等 500ms → 读 State。每次连接都重新发现 GATT 句柄。
   *
   * v3：MTU 协商结果决定分片容量；协商失败或平台不支持时按 23（20 字节）
   * 工作——功能不降级，只是分片更多（§2.1）。
   */
  private async initLink(cancelled: () => boolean = () => false): Promise<DeviceState> {
    const deviceId = this.deviceId;
    if (deviceId === null) {
      throw new Error("未连接");
    }

    /* 每个 await 之后都要核对代次：用户取消后，底层调用无论成败都不能再
     * 改写链路状态（否则「我主动取消」会被显示成各种连接错误）。 */
    const step = async <T>(run: () => Promise<T>): Promise<T> => {
      try {
        const value = await run();
        if (cancelled()) {
          throw new ConnectCancelledError();
        }
        return value;
      } catch (err) {
        throw cancelled() ? new ConnectCancelledError() : err;
      }
    };

    await step(() => this.negotiateMtu(deviceId));

    const servicesRes = await step(() =>
      wxCall<any>("getBLEDeviceServices", wx.getBLEDeviceServices, { deviceId }, 5000),
    );
    const services: any[] = servicesRes?.services ?? [];
    const service = services.find((s) => upper(s.uuid) === SERVICE_UUID);
    if (service === undefined) {
      throw new Error(`找不到 service ${SERVICE_UUID}`);
    }
    this.serviceId = service.uuid;
    const serviceId = service.uuid;

    const charsRes = await step(() =>
      wxCall<any>(
        "getBLEDeviceCharacteristics",
        wx.getBLEDeviceCharacteristics,
        { deviceId, serviceId },
        5000,
      ),
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

    await step(() =>
      wxCall(
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
      ),
    );

    // notify 后立刻写会触发 Android 10008；等一小段或先读一次。
    await step(() => delay(this.initSettleMs));

    // read 的 success 只代表请求受理，真正的值走 value 事件。
    return step(() => this.readState());
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

  /**
   * 逻辑帧 → 分片 → 串行写入。
   *
   * seq 只在**逻辑帧**层面分配一次：分片的 ctrl 序号与之无关（§8）。
   * 任一分片写失败即拒绝整帧（中间分片丢了，后面的分片只会拼出错误帧）。
   *
   * 日志：每片一条 tx（hex 是**实际线上字节**，带 ctrl 头），解析文本挂在
   * 第一片上——单分片帧因此仍是一行，与 v2 的日志密度一致。
   */
  private async writeLogicalFrame(
    req: CommandRequest,
    seq: number,
    frame: Uint8Array,
  ): Promise<void> {
    const chunks = chunkFrame(frame, this.chunkCapacity);
    chunks.forEach((chunk, index) => {
      this.logChunk(
        "tx",
        chunk,
        req.command,
        seq,
        frame.length,
        index === 0 ? describeTx(req) : undefined,
      );
    });
    try {
      for (const chunk of chunks) {
        await this.writer.enqueue(chunk);
      }
    } catch (err) {
      this.logFailure(frame, req.command, seq, errorText(err));
      throw err;
    }
  }

  /** 分片数（ACK 超时按它放大）。 */
  private chunksFor(frame: Uint8Array): number {
    return Math.max(1, Math.ceil(frame.length / chunkDataCapacity(this.chunkCapacity)));
  }

  /** 超时按分片数放大：单分片与 v2 完全一致（600ms）。 */
  private scaledTimeout(baseMs: number, frame: Uint8Array): number {
    const extra = this.chunksFor(frame) - 1;
    return baseMs + extra * ACK_TIMEOUT_PER_CHUNK_MS;
  }

  /** 只等写入回调（连续量用）；ACK 异步记录在日志里。 */
  async write(req: CommandRequest): Promise<{ seq: number }> {
    this.ensureWritable();
    const seq = this.allocateSeq();
    const frame = encodeTxFrame(req.command, seq, req.payload);
    try {
      await this.writeLogicalFrame(req, seq, frame);
    } catch (err) {
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

    const timeoutMs = this.scaledTimeout(timeoutOverride ?? this.ackTimeoutMs, frame);
    const ackPromise = this.ackWaiters.register(seq, req.command, timeoutMs);

    try {
      await this.writeLogicalFrame(req, seq, frame);
    } catch (err) {
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
    const timeoutMs = this.scaledTimeout(opts.timeoutMs ?? this.ackTimeoutMs, frame);

    const ackPromise = this.ackWaiters.register(seq, req.command, timeoutMs);
    const collectPromise = this.stripQueries.open(seq, stripId, timeoutMs);

    try {
      await this.writeLogicalFrame(req, seq, frame);
    } catch (err) {
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
    const timeoutMs = this.scaledTimeout(opts.timeoutMs ?? this.ackTimeoutMs, frame);

    const ackPromise = this.ackWaiters.register(seq, req.command, timeoutMs);
    const summaryPromise = new Promise<ScriptSummary>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingScriptQuery = null;
        reject(new WxCallTimeoutError("QueryScript", timeoutMs));
      }, timeoutMs);
      this.pendingScriptQuery = { seq, resolve, reject, timer };
    });
    summaryPromise.catch(() => undefined);

    try {
      await this.writeLogicalFrame(req, seq, frame);
    } catch (err) {
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

  /** v3：QueryStripConfig 0x1C → StripConfigReport 0x87（单帧，回显 seq）。 */
  async queryStripConfig(opts: { timeoutMs?: number } = {}): Promise<StripConfig> {
    return this.querySingleReport(
      cmdQueryStripConfig(),
      "QueryStripConfig",
      opts,
      (pending) => {
        this.pendingStripConfig = pending;
      },
      () => this.pendingStripConfig,
    );
  }

  /** v3：QueryDeviceInfo 0x1D → DeviceInfoReport 0x88（单帧，回显 seq）。 */
  async queryDeviceInfo(opts: { timeoutMs?: number } = {}): Promise<DeviceInfo> {
    return this.querySingleReport(
      cmdQueryDeviceInfo(),
      "QueryDeviceInfo",
      opts,
      (pending) => {
        this.pendingDeviceInfo = pending;
      },
      () => this.pendingDeviceInfo,
    );
  }

  /**
   * 「一条命令 → 一条单帧报告」的公共流程（0x1C / 0x1D）。
   *
   * 与 queryScript 同构，但把「挂哪个 pending」「取哪个 pending」作为参数，
   * 避免三份几乎相同的 ACK 等待 + 超时清理代码各自漂移。
   */
  private async querySingleReport<T>(
    req: CommandRequest,
    label: string,
    opts: { timeoutMs?: number },
    setPending: (pending: SingleReportQuery<T> | null) => void,
    getPending: () => SingleReportQuery<T> | null,
  ): Promise<T> {
    this.ensureWritable();
    const seq = this.allocateSeq();
    const frame = encodeTxFrame(req.command, seq, req.payload);
    const timeoutMs = this.scaledTimeout(opts.timeoutMs ?? this.ackTimeoutMs, frame);

    const ackPromise = this.ackWaiters.register(seq, req.command, timeoutMs);
    const reportPromise = new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        setPending(null);
        reject(new WxCallTimeoutError(label, timeoutMs));
      }, timeoutMs);
      setPending({ seq, resolve, reject, timer });
    });
    reportPromise.catch(() => undefined);

    try {
      await this.writeLogicalFrame(req, seq, frame);
    } catch (err) {
      this.ackWaiters.fail(seq, err);
      this.failPendingReport(getPending(), setPending, err instanceof Error ? err : new Error(String(err)));
      this.noteWriteFailure(err);
      throw err;
    }

    const ack = await ackPromise;
    if (!ack.ok) {
      this.failPendingReport(
        getPending(),
        setPending,
        new Error(`${label} 被拒（${resultText(ack.resultCode)}）`),
      );
      throw new Error(`${label} 失败：${resultText(ack.resultCode)}`);
    }
    return reportPromise;
  }

  /**
   * #32：按顺序下发一串命令，每帧等 ACK。
   *
   * 剧本下发是「一帧一条命令」的批量流程，用 sendAndWaitAck 逐帧串行即可：
   * 顺序是协议要求（Begin → Stage/Segment → Commit），不能并发。
   * 回调在每帧确认后报告进度（done 是**已确认**的帧数）。
   *
   * **非零 ACK 必须中断**：剧本的 Commit 回 `ScriptTooLarge (0x0A)` 时设备
   * 不提交，继续发后面的 Activate 会得到一条误导性的成功。所以这里把非零
   * ACK 折成 `AckRejectedError` 抛出，由会话层决定 Abort 与提示文案。
   */
  async sendSequence(
    requests: CommandRequest[],
    onProgress?: (done: number, total: number) => void,
    opts: SendOptions = {},
  ): Promise<void> {
    const total = requests.length;
    for (let i = 0; i < total; i += 1) {
      const ack = await this.sendAndWaitAck(requests[i], opts);
      if (!ack.ok) {
        throw new AckRejectedError(ack.command, ack.resultCode);
      }
      onProgress?.(i + 1, total);
    }
  }

  // ------------------------------------------------------------------
  // 读 State
  // ------------------------------------------------------------------

  /**
   * 读 State。
   *
   * v3 的 State 是 37 字节：MTU 23（ATT 载荷 20）时 GATT read 根本放不下，
   * 平台可能返回截断值或直接失败。权威路径（§9.1）要求拿到完整 37 字节，
   * 所以这里做**回落**：
   *   1. 先试 read State 特征值；
   *   2. 若回值长度 ≠ 37（或 read 失败），改发 QueryState 0x05 → StateReport
   *      0x82（chunked notify），用它作为 State。
   * 绝不静默截断——parseState 仍对非 37 字节抛错。
   */
  readState(): Promise<DeviceState> {
    const inflight = this.stateRead.inflight;
    if (inflight !== null) {
      return inflight;
    }
    if (this.stateFallback !== null) {
      return this.stateFallback;
    }
    const deviceId = this.deviceId;
    const serviceId = this.serviceId;
    const characteristicId = this.stateId;
    if (deviceId === null || serviceId === null || characteristicId === null) {
      return Promise.reject(new Error("未连接"));
    }

    const promise = this.stateRead.open(this.stateReadTimeoutMs, (value) => {
      if (value.length !== STATE_BYTES) {
        /* 长度不对（典型：MTU 23 下短读）：交给回落路径，不在等待者里硬解析。 */
        throw new StateLengthMismatchError(value.length);
      }
      const state = parseState(value);
      this.listeners.emitState(state);
      return state;
    });

    wxCall(
      "readBLECharacteristicValue",
      wx.readBLECharacteristicValue,
      { deviceId, serviceId, characteristicId },
      this.stateReadTimeoutMs,
    ).catch(() => {
      /* read 失败也走回落；真正的错误由回落路径报告。 */
      this.stateRead.reject(new StateReadFallbackError());
    });

    return promise.catch((err: unknown) => {
      if (err instanceof StateLengthMismatchError || err instanceof StateReadFallbackError) {
        return this.readStateViaQueryState();
      }
      /* read 一直没有回值（MTU 23 下某些平台的表现）：同样走 QueryState 回落；
       * 回落也失败时抛出的才是真正的链路错误。 */
      if (err instanceof WxCallTimeoutError && err.api === "State read") {
        return this.readStateViaQueryState();
      }
      throw err;
    });
  }

  /**
   * 回落路径：QueryState 0x05 → 等 StateReport 0x82。
   *
   * 用 ackWaiters 等 ACK，用一次性 state 等待者接 0x82。StateReport 的回包
   * 会同时广播给 onState（设备权威），这里只是把它作为 `readState` 的返回值。
   */
  private readStateViaQueryState(): Promise<DeviceState> {
    const existing = this.stateFallback;
    if (existing !== null) {
      return existing;
    }
    const req = cmdQueryState();
    const seq = this.allocateSeq();
    const frame = encodeTxFrame(req.command, seq, req.payload);
    const timeoutMs = this.scaledTimeout(this.stateReadTimeoutMs, frame);

    const ackPromise = this.ackWaiters.register(seq, req.command, timeoutMs);
    const statePromise = new Promise<DeviceState>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingStateReport = null;
        reject(new WxCallTimeoutError("StateReport", timeoutMs));
      }, timeoutMs);
      this.pendingStateReport = { seq, resolve, reject, timer };
    });
    statePromise.catch(() => undefined);

    void this.writeLogicalFrame(req, seq, frame).then(
      () => undefined,
      (err: unknown) => {
        this.ackWaiters.fail(seq, err);
        this.failPendingStateReport(err instanceof Error ? err : new Error(String(err)));
        this.noteWriteFailure(err);
      },
    );

    const fallback = ackPromise.then(
      (ack) => {
        if (!ack.ok) {
          this.failPendingStateReport(
            new Error(`QueryState 被拒（${resultText(ack.resultCode)}）`),
          );
          throw new Error(`QueryState 失败：${resultText(ack.resultCode)}`);
        }
        return statePromise;
      },
      (err: unknown) => {
        this.failPendingStateReport(err instanceof Error ? err : new Error(String(err)));
        throw err;
      },
    );
    this.stateFallback = fallback;
    /* 无论成败都要摘掉单飞标记，否则一次失败会永久挡住后续读 State。 */
    void fallback.then(
      () => {
        if (this.stateFallback === fallback) this.stateFallback = null;
      },
      () => {
        if (this.stateFallback === fallback) this.stateFallback = null;
      },
    );
    return fallback;
  }

  // ------------------------------------------------------------------
  // MTU
  // ------------------------------------------------------------------

  /** 当前分片容量（含分片头；测试可观察）。 */
  get chunkCapacityBytes(): number {
    return this.chunkCapacity;
  }

  /** 当前协商到的 MTU（未知为 null）。 */
  get negotiatedMtu(): number | null {
    return this.mtu;
  }

  /**
   * MTU 协商（§2.1）：Android 主动请求 185，其它平台用系统协商值；
   * 拿不到就按 23 工作（功能不降级，只是分片更多）。
   *
   * 任何一步失败都不阻断连接——分片容量退回默认值即可。
   */
  private async negotiateMtu(deviceId: string): Promise<void> {
    let mtu: number | null = null;
    if (this.platform === "android") {
      try {
        const res = await wxCall<any>("setBLEMTU", wx.setBLEMTU, { deviceId, mtu: 185 }, 3000);
        if (typeof res?.mtu === "number" && res.mtu > 0) {
          mtu = res.mtu;
        }
      } catch {
        /* 只当优化：失败继续用 getBLEMTU / 默认值 */
      }
    }
    if (mtu === null && typeof wx.getBLEMTU === "function") {
      try {
        const res = await wxCall<any>("getBLEMTU", wx.getBLEMTU, { deviceId, writeType: "write" }, 2000);
        if (typeof res?.mtu === "number" && res.mtu > 0) {
          mtu = res.mtu;
        }
      } catch {
        /* 平台不支持或还没协商好：按默认 23 */
      }
    }
    this.applyMtu(mtu);
  }

  /** 记录 MTU 并换算分片容量（未知 → 23 → 20）。 */
  private applyMtu(mtu: number | null): void {
    this.mtu = mtu;
    this.chunkCapacity = chunkCapacityForMtu(mtu);
    // 请求值不是最终值，只记录协商结果与随之确定的分片容量。
    console.log(
      `[lumen] MTU=${mtu ?? "未知(按23)"} → 分片容量 ${this.chunkCapacity} 字节` +
        `（数据 ${this.chunkCapacity - 1} 字节）`,
    );
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
      this.handleInboundChunk(bytes);
      return;
    }
    if (characteristicId === upper(this.stateId ?? STATE_UUID)) {
      // State read 回值在 v3 是裸 37 字节（无信封、无分片头），但同样进日志、同样可解析。
      this.logFrame("rx", bytes, undefined, undefined, describeStateReadBytes(bytes));
      if (!this.stateRead.deliver(bytes)) {
        try {
          this.listeners.emitState(parseState(bytes));
        } catch {
          /* 非 37 字节的 State 回值：记录日志已足够（readState 会走回落） */
        }
      }
    }
  };

  /**
   * v3 入站：每个 notify 是**一个分片**（带 1 字节 ctrl 头）。
   *
   * 分片先进日志（hex 含 ctrl，便于与固件串口对照），重组出完整逻辑帧后
   * 才交给命令层；解析失败按 §5 的语义留在日志里。
   */
  private handleInboundChunk(bytes: Uint8Array): void {
    const result = this.assembler.push(bytes);
    if (result.kind === "incomplete") {
      this.logChunk("rx", bytes, undefined, undefined);
      return;
    }
    if (result.kind === "error") {
      this.log.push({
        ts: Date.now(),
        dir: "rx",
        hex: bytesToHex(bytes),
        parsed: `分片重组失败（${result.reason}）`,
        ok: false,
      });
      return;
    }
    this.handleDeviceFrame(result.frame);
  }

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
        /* v3：State read 回落到 QueryState 时，这里兑现那次读。 */
        this.settlePendingStateReport(frame.seq as number, frame.action.state);
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
      case "strip-config": {
        const pending = this.pendingStripConfig;
        if (pending !== null && pending.seq === frame.seq) {
          clearTimeout(pending.timer);
          this.pendingStripConfig = null;
          pending.resolve(frame.action.config);
        }
        return;
      }
      case "device-info": {
        const pending = this.pendingDeviceInfo;
        if (pending !== null && pending.seq === frame.seq) {
          clearTimeout(pending.timer);
          this.pendingDeviceInfo = null;
          pending.resolve(frame.action.info);
        }
        return;
      }
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

  /** 丢掉 in-flight 的 0x1C / 0x1D 查询（写失败 / 被拒 / 断线）。 */
  private failPendingReport<T>(
    pending: SingleReportQuery<T> | null,
    setPending: (value: SingleReportQuery<T> | null) => void,
    err: Error,
  ): void {
    if (pending === null) {
      return;
    }
    clearTimeout(pending.timer);
    setPending(null);
    pending.reject(err);
  }

  /** 兑现回落到 QueryState 的 State 等待者（seq 不符时静默忽略）。 */
  private settlePendingStateReport(seq: number, state: DeviceState): void {
    const pending = this.pendingStateReport;
    if (pending === null || pending.seq !== seq) {
      return;
    }
    clearTimeout(pending.timer);
    this.pendingStateReport = null;
    pending.resolve(state);
  }

  /** 丢掉回落到 QueryState 的 State 等待者（写失败 / 被拒 / 断线）。 */
  private failPendingStateReport(err: Error): void {
    const pending = this.pendingStateReport;
    if (pending === null) {
      return;
    }
    clearTimeout(pending.timer);
    this.pendingStateReport = null;
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
    /* MTU 是 per-connection 的：新连接必须重新协商，未知时按 23（20 字节）工作。 */
    this.mtu = null;
    this.chunkCapacity = DEFAULT_CHUNK_CAPACITY;
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
    this.failPendingReport(this.pendingStripConfig, (v) => {
      this.pendingStripConfig = v;
    }, reason);
    this.failPendingReport(this.pendingDeviceInfo, (v) => {
      this.pendingDeviceInfo = v;
    }, reason);
    this.failPendingStateReport(reason);
    this.stateFallback = null;
    /* 未完成的分片不能在回连后与新分片拼接（seq / 帧都已是旧的）。 */
    this.assembler.reset();
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

  /**
   * 分片入日志：hex 带 ctrl 头（与固件串口逐片对照）。
   *
   * `frameLength` 是所属逻辑帧长度；入站分片在重组完成前不知道它，所以可选。
   * 分片序号从 ctrl 低 6 位解析出来，日志里直接给出片号比裸 hex 好用。
   * `parsed` 只在该帧的**第一片**上传入解析文本，避免一片一行把日志刷满。
   */
  private logChunk(
    dir: "tx" | "rx",
    chunk: Uint8Array,
    command: number | undefined,
    seq: number | undefined,
    frameLength?: number,
    parsed?: string,
  ): void {
    const ctrl = chunk[0] ?? 0;
    const flags: string[] = [];
    if ((ctrl & 0x80) !== 0) flags.push("FIRST");
    if ((ctrl & 0x40) !== 0) flags.push("LAST");
    flags.push(`#${ctrl & 0x3f}`);
    const size =
      frameLength === undefined ? `chunk=${chunk.length}B` : `chunk=${chunk.length}/${frameLength}B`;
    const chunkText = `分片[${flags.join("|")}] ${size}`;
    this.log.push({
      ts: Date.now(),
      dir,
      hex: bytesToHex(chunk),
      command,
      seq,
      parsed: parsed === undefined ? chunkText : `${chunkText} ${parsed}`,
    });
  }
}
