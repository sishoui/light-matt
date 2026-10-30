/**
 * 控制会话：页面与传输层之间唯一的门面。
 *
 * 页面只 import 本模块；BLE 细节、节流、命令构造都在这里或其下层。
 * #8 开关走离散路径；#9 亮度走 20Hz latest-wins 连续路径；#11 在会话层补
 * 连接生命周期的最后一块：断线通知、1s/2s/4s 有限次退避回连、前台静默回连、
 * deviceId 缓存，以及 10006 / 10008 / 10001 的错误分诊。
 *
 * 状态权威：设备。任何连接建立（首次 / 回连）都由 transport.connect 走完整
 * 初始化流水线（MTU → services → chars → 重新订阅 notify → 读 State），
 * 本模块只在拿到 State 后更新本地镜像，绝不用本地缓存覆盖设备。
 *
 * 拆分后的协作模块（同级 utils/control/）：
 *  - reconnect.ts：连接生命周期监督者（退避回连 / epoch / 手动/自动互斥）；
 *  - device-cache.ts：deviceId 缓存（只存身份，不存状态）；
 *  - platform.ts：平台/开发版探测 + 无状态兜底快照。
 * 本文件只保留「命令语义 + 本地状态镜像 + 节流通道」。
 *
 * v2（#21）退役了 SetColor 0x03 / SetAll 0x04，颜色由段配置（0x10 SetSegment）
 * 承担。#25 会围绕分段重建 UI；在那之前 queueColor / commitColor / applyPreset
 * 是**明确禁用**的占位实现：不发帧、不改本地状态，只让页面给出可见提示。
 */

import { FrameLog } from "../ble/log";
import { LatestWinsThrottle, type TimerApi } from "../ble/throttle";
import {
  BleTransport,
  type BleTransportOptions,
  type LinkDetail,
  type SendOptions,
} from "../ble/transport";
import { errorText, triage } from "../ble/errors";
import { WxCallError } from "../ble/wx-promise";
import {
  applyLocalBrightness,
  brightnessForPowerOn,
  clampBrightness,
  effectiveMaxBrightness,
} from "./brightness";
import { LED_COUNT_ACK_TIMEOUT_MS } from "./ledCount";
import { MAX_LEDS, MIN_LEDS } from "../protocol/constants";
import {
  cmdQueryState,
  cmdSelfTest,
  cmdSetBrightness,
  cmdSetLedCount,
  cmdSetPower,
} from "../protocol/commands";
import type {
  AckResult,
  CommandRequest,
  DeviceState,
  DiscoveredDevice,
  LinkState,
  RGB,
} from "../protocol/types";
import {
  clearCachedDevice,
  createWxStorage,
  DEVICE_CACHE_KEY,
  loadCachedDevice,
  saveCachedDevice,
  type CachedDevice,
  type SessionStorage,
} from "./device-cache";
import { detectDevMode, detectPlatform, fallbackState } from "./platform";
import { ReconnectSupervisor } from "./reconnect";

export { DEVICE_CACHE_KEY, detectDevMode, detectPlatform };
export type { CachedDevice, SessionStorage };

/**
 * 连续量只有亮度。v2 退役 SetColor 后，20Hz 通道不再承载颜色
 * （段配置是离散命令，由 #25 的下发流程负责）。
 */
export type ContinuousUpdate = { kind: "brightness"; value: number };

/**
 * 颜色 / 预设入口在 v2 的占位提示。#25 把这部分重建为分段界面，
 * 在此之前 UI 必须明确告诉用户功能去哪儿了，而不是静默什么都不做。
 */
export const SEGMENTS_UI_NOTICE = "该功能在 v2 分段界面中提供（#25）";

/** 每套灯带在 State 里的 strip_id；多灯带 #29 之前固定 0。 */
const PRIMARY_STRIP_ID = 0;

export interface SessionOptions {
  platform: "android" | "ios" | "other";
  /** 开发版才把每帧 hex 打到 console（spec §11）。 */
  devMode: boolean;
  /**
   * 仅测试用：注入假传输通道（spec 允许的假件之一）。
   * 生产代码不传，正常走 new BleTransport。
   */
  transportOverride?: BleTransport;
  /** 仅测试用：注入节流计时器（spec 允许的假件之一）。 */
  throttleTimer?: TimerApi;
  /** 仅测试用：回连退避与 10008 间隔重试用计时器（spec 允许的假件之一）。 */
  reconnectTimer?: TimerApi;
  /** 退避序列，默认 1s / 2s / 4s；尝试次数等于序列长度。 */
  reconnectDelaysMs?: number[];
  /** 10008（疑似 notify 后立即写）重试前的间隔，默认 500ms。 */
  retryAfterGapMs?: number;
  /** 仅测试用：deviceId 缓存后端；生产走 wx.storage。 */
  storage?: SessionStorage;
}

/** 离散命令的统一结果：成功带回更新后的本地状态，失败区分 ACK 与异常。 */
export type CommandResult =
  | { kind: "ok"; state: DeviceState }
  | { kind: "ack-error"; ack: AckResult }
  /** 旧连接的命令迟到返回：不覆盖回连后读到的新 State，UI 直接忽略。 */
  | { kind: "stale" }
  | { kind: "error"; message: string };

/** #9 起沿用的名字；与 CommandResult 完全等价。 */
export type PowerResult = CommandResult;

const DEFAULT_RETRY_AFTER_GAP_MS = 500;

const defaultTimer: TimerApi = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle),
};

function delayWith(timer: TimerApi, ms: number): Promise<void> {
  return new Promise((resolve) => {
    timer.setTimeout(() => resolve(), ms);
  });
}

export class ControlSession {
  readonly transport: BleTransport;
  private readonly throttle: LatestWinsThrottle<ContinuousUpdate>;
  private latestState: DeviceState | null = null;
  /** 亮度 0 时开灯，用最近一次非 0 亮度恢复（#9）。 */
  private lastNonZeroBrightness = 128;

  private readonly retryAfterGapMs: number;
  /** 10008 间隔重试的计时器：与回连退避共用同一个注入实例。 */
  private readonly reconnectTimer: TimerApi;
  private readonly storage: SessionStorage;
  /** 缓存的设备身份：回连与进前台静默回连都用它（设备是状态权威，不缓存状态）。 */
  private cached: CachedDevice | null = null;
  private readonly reconnect: ReconnectSupervisor;

  constructor(opts: SessionOptions) {
    const log = new FrameLog({ mirrorToConsole: opts.devMode });
    if (opts.transportOverride !== undefined) {
      this.transport = opts.transportOverride;
    } else {
      const transportOptions: BleTransportOptions = { log, platform: opts.platform };
      this.transport = new BleTransport(transportOptions);
    }

    const reconnectTimer = opts.reconnectTimer ?? defaultTimer;
    this.reconnectTimer = reconnectTimer;
    this.retryAfterGapMs = opts.retryAfterGapMs ?? DEFAULT_RETRY_AFTER_GAP_MS;
    this.storage = opts.storage ?? createWxStorage();
    this.cached = loadCachedDevice(this.storage);

    this.reconnect = new ReconnectSupervisor(
      {
        linkState: () => this.transport.linkState,
        cached: () => this.cached,
        connect: (deviceId, name) => this.transport.connect(deviceId, name),
        disconnect: () => this.transport.disconnect(),
        refresh: () => this.refreshState(),
        clearDeviceState: () => this.clearDeviceState(),
        onConnected: (state) => {
          if (state !== null && state !== undefined && typeof state === "object") {
            this.latestState = state as DeviceState;
          }
        },
      },
      {
        timer: reconnectTimer,
        delaysMs: opts.reconnectDelaysMs,
        initialLink: this.transport.linkState,
      },
    );

    // 20Hz latest-wins 闸门：v2 只剩亮度这一路连续量。
    this.throttle = new LatestWinsThrottle<ContinuousUpdate>(
      (update) => {
        const req: CommandRequest = cmdSetBrightness(update.value);
        // 连续量只等写回调；ACK 会异步进日志。写失败不重传连续量（spec §9），
        // 但 10006 等链路错误要触发回连检查。
        return this.transport.write(req).then(
          () => undefined,
          (err) => {
            this.reconnect.handleCommandFailure(err);
          },
        );
      },
      opts.throttleTimer !== undefined ? { timer: opts.throttleTimer } : {},
    );

    // 内部监听必须早于页面注册，保证断线时先清本地状态再通知 UI。
    this.transport.onLink((state, detail) => this.reconnect.handleLinkChange(state, detail));

    this.transport.onState((state) => {
      this.latestState = state;
      if (state.brightness > 0) {
        this.lastNonZeroBrightness = state.brightness;
      }
    });
  }

  get linkState(): LinkState {
    return this.transport.linkState;
  }

  get deviceState(): DeviceState | null {
    return this.latestState;
  }

  get log(): FrameLog {
    return this.transport.log;
  }

  /** 缓存的设备身份（不含状态）；回连失败后可据此给手动重连入口。 */
  get cachedDevice(): CachedDevice | null {
    return this.cached === null ? null : { ...this.cached };
  }

  /** 是否还有未完成的自动回连意图（UI/测试可观察）。 */
  get reconnectPending(): boolean {
    return this.reconnect.pending;
  }

  /** 进页面：只打开适配器；有 deviceId 缓存时由 onShow 触发静默回连。 */
  async boot(): Promise<void> {
    try {
      await this.transport.openAdapter();
    } catch (err) {
      console.warn(`[lumen] 打开适配器失败：${errorText(err)}`);
    }
  }

  async scan(): Promise<void> {
    // 用户主动扫描 = 接管连接意图：取消待执行的自动回连，避免和扫描抢链路。
    this.reconnect.scanIntent();
    await this.transport.startScan();
  }

  async stopScan(): Promise<void> {
    await this.transport.stopScan();
  }

  async connect(deviceId: string, name?: string): Promise<DeviceState> {
    // 手动连接优先：取消退避计时器与回连意图，并重置尝试次数（spec #41）。
    this.reconnect.manualConnectBegin();
    try {
      const state = await this.transport.connect(deviceId, name);
      this.latestState = state;
      // 只有完整初始化成功后才缓存 deviceId（失败的下次扫描更可靠）。
      this.cached = saveCachedDevice(this.storage, deviceId, name);
      return state;
    } catch (err) {
      // 10002 / 10013：设备不在附近或 deviceId 失效（iOS UUID 会变），清缓存。
      if (err instanceof WxCallError && (err.errCode === 10002 || err.errCode === 10013)) {
        this.clearCachedDevice();
      }
      throw err;
    } finally {
      this.reconnect.manualConnectEnd();
    }
  }

  async disconnect(): Promise<void> {
    // 主动断开：不触发自动回连，也不再让 onShow 擅自重连。
    this.throttle.cancel();
    await this.reconnect.disconnectIntent();
    this.latestState = null;
  }

  /** 页面 onShow：回连决策全部交给监督者（不打断扫描 / 手动连接）。 */
  async onShow(): Promise<void> {
    await this.reconnect.onShow();
  }

  /**
   * 离散命令的统一入口（#12 / #13 复用）：写入 → 等 ACK。
   *
   * 错误分诊（spec §9）：
   *  - 10006 / 写超时 → 不重试写，触发回连；
   *  - 10008 → 怀疑「notify 后立即写」，等 500ms 重试一次；仍失败走重连；
   *  - 10001 → 非致命，不重试，等适配器状态事件。
   */
  async sendCommand(req: CommandRequest, opts: SendOptions = {}): Promise<AckResult> {
    const epoch = this.reconnect.epoch;
    try {
      return await this.transport.sendAndWaitAck(req, opts);
    } catch (err) {
      if (triage(err) === "retry-after-gap") {
        await delayWith(this.reconnectTimer, this.retryAfterGapMs);
        if (this.reconnect.isStale(epoch)) {
          throw err; // 等待期间已断开/重连：这条命令不再写
        }
        try {
          // 丢弃 retryOnTimeout：这次「加间隔重试」本身就是唯一一次额外写，
          // 不允许它在内部再叠一次 ACK 超时重发。
          return await this.transport.sendAndWaitAck(req, { ...opts, retryOnTimeout: 0 });
        } catch (retryErr) {
          if (triage(retryErr) === "retry-after-gap") {
            // 加间隔后仍失败：链路重建（不再重试写）。
            void this.reconnect.forceReconnect("蓝牙链路异常，正在重连");
          } else {
            this.reconnect.handleCommandFailure(retryErr);
          }
          throw retryErr;
        }
      }
      this.reconnect.handleCommandFailure(err);
      throw err;
    }
  }

  /**
   * #12：改灯珠数量。
   *
   * 为什么单独一条路径而不是走连续量/普通离散路径：
   *  - 设备要重建 led_strip 句柄，ACK 可能晚很多，超时放宽到 3000ms；
   *  - 不重传：重建是重操作，超时重发只会撞上 0x05 Busy；超时按断线处理；
   *  - 成功才更新本地 ledCount（设备权威），失败保留旧值并给出具体提示。
   *
   * 输入校验（1-64、纯整数）在页面层用 parseLedCountInput 先做，这里再兜一次：
   * 非法值不发帧，直接返回错误，绝不「尽量发送」。
   */
  async setLedCount(count: number): Promise<CommandResult> {
    if (!Number.isInteger(count) || count < MIN_LEDS || count > MAX_LEDS) {
      return { kind: "error", message: `灯珠数量必须是 ${MIN_LEDS}-${MAX_LEDS} 的整数` };
    }
    if (this.transport.linkState !== "ready") {
      return { kind: "error", message: "设备未连接" };
    }
    const epoch = this.reconnect.epoch;
    try {
      // 走 #11 的统一命令通道（10008 加间隔重试 / 断线触发重连），
      // 但 ACK 超时仍是 3000ms，且不设 retryOnTimeout：重建是重操作，
      // 超时重发只会撞上 0x05 Busy。
      // v2 载荷带 strip_id；多灯带（#29）之前固定 strip 0。
      const ack = await this.sendCommand(cmdSetLedCount(PRIMARY_STRIP_ID, count), {
        timeoutMs: LED_COUNT_ACK_TIMEOUT_MS,
      });
      // #11：旧连接上飞行的 ACK 晚到，不得覆盖回连后读到的新 State。
      if (this.reconnect.isStale(epoch)) {
        return { kind: "stale" };
      }
      if (!ack.ok) {
        // Busy(0x05) / InternalError(0x09) / InvalidParam(0x01) 都表示数量没变：
        // 不更新本地值，页面按 ledCountResultHint 提示。
        return { kind: "ack-error", ack };
      }
      // 成功：设备已按新数量重建并持久化，本地只改 ledCount。
      if (this.latestState !== null) {
        this.latestState = { ...this.latestState, ledCount: count };
      }
      return {
        kind: "ok",
        state: this.latestState ?? fallbackState({ r: 0, g: 0, b: 0 }),
      };
    } catch (err) {
      return { kind: "error", message: errorText(err) };
    }
  }

  /** 重新读设备 State（设备权威）。 */
  async refreshState(): Promise<DeviceState> {
    const state = await this.transport.readState();
    this.latestState = state;
    if (state.brightness > 0) {
      this.lastNonZeroBrightness = state.brightness;
    }
    return state;
  }

  /** 调试兜底：QueryState（次要路径，主路径是 State read）。 */
  async queryState(): Promise<AckResult> {
    return this.sendCommand(cmdQueryState());
  }

  /**
   * #13：自检。设备按 红→绿→蓝→白 各 500ms 临时覆盖灯带，2s 后自动恢复。
   *
   * 这里只发一帧并等 ACK：自检不改变设备状态，所以本地状态与 UI 都不动
   * （避免「自检后 UI 显示自检颜色」）。允许 ACK 超时重发一次——重发会
   * 让设备重启序列，结果仍是同一条 2s 自检，可接受；不重发则一次丢包就会
   * 让用户觉得按钮没反应。
   *
   * 走 #11 的统一命令通道（错误分诊 + 10006 触发回连），并做 epoch 守卫：
   * 旧连接上飞行的 ACK 晚到达时，不要在新连接上弹「自检失败」。
   */
  async selfTest(): Promise<CommandResult> {
    const epoch = this.reconnect.epoch;
    try {
      const ack = await this.sendCommand(cmdSelfTest(), { retryOnTimeout: 1 });
      if (this.reconnect.isStale(epoch)) {
        return { kind: "stale" };
      }
      if (!ack.ok) {
        return { kind: "ack-error", ack };
      }
      return {
        kind: "ok",
        state: this.latestState ?? fallbackState({ r: 0, g: 0, b: 0 }, 0, 0),
      };
    } catch (err) {
      return { kind: "error", message: errorText(err) };
    }
  }

  /**
   * #9：滑块 changing（连续量）走 20Hz latest-wins。
   *
   * 设备是状态权威，但拖动过程中不能等 State read——这里先乐观更新本地值，
   * 让 UI 跟手；值按设备上报的 max_brightness 钳位后再进命令构造器。
   * 亮度 0 不改 power 位（§7）：设备侧仍为「开」，只是视觉关灯。
   */
  queueBrightness(value: number): void {
    if (this.transport.linkState !== "ready") {
      return;
    }
    const effective = clampBrightness(value, this.maxBrightness);
    this.rememberBrightness(effective);
    this.throttle.push({ kind: "brightness", value: effective });
  }

  /** #9：滑块 change（松手）——发最新值并立即 flush，保证最终值落地。 */
  commitBrightness(value: number): void {
    if (this.transport.linkState !== "ready") {
      return;
    }
    const effective = clampBrightness(value, this.maxBrightness);
    this.rememberBrightness(effective);
    this.throttle.push({ kind: "brightness", value: effective });
    this.throttle.flush();
  }

  /** 当前生效的亮度上限（设备 State.maxBrightness；未连上时按 255）。 */
  get maxBrightness(): number {
    return effectiveMaxBrightness(this.latestState?.maxBrightness);
  }

  /** 最近一次非 0 亮度（开灯恢复用）。 */
  get brightnessHint(): number {
    return this.lastNonZeroBrightness;
  }

  /** 乐观更新本地亮度：UI 立即跟手，同时维护「最近一次非 0 亮度」记忆。 */
  private rememberBrightness(value: number): void {
    if (value > 0) {
      this.lastNonZeroBrightness = value;
    }
    if (this.latestState !== null) {
      this.latestState = applyLocalBrightness(this.latestState, value);
    }
  }

  /**
   * 色环拖动（连续量）——v2 占位实现，**不发帧**。
   *
   * v1 的 SetColor 0x03 已退役；单个「颜色」概念在 v2 里属于 strip 0 / seg 0
   * 的静态段，由 #25 的分段界面处理。这里保持方法签名让页面继续编译，
   * 但不改动设备状态，也不做乐观更新（避免 UI 显示一个设备上不存在的颜色）。
   *
   * TODO(#25)：改名/替换为「下发 strip 0 seg 0 的静态段」的正式路径。
   */
  queueColor(_rgb: RGB): void {
    /* 有意为空：v2 没有单色命令。 */
  }

  /** 色环松手——同 queueColor，v2 占位实现不发帧。TODO(#25) */
  commitColor(_rgb: RGB): void {
    /* 有意为空：v2 没有单色命令。 */
  }

  /**
   * 预设点击——v2 占位实现，**不发帧**。
   *
   * v1 用一条 SetAll（0x04）原子写开关 + 亮度 + RGB；0x04 已退役。
   * 返回 error 而不是 ok，页面据此提示「该功能在 v2 分段界面中提供（#25）」，
   * 绝不能假装成功。
   *
   * TODO(#25)：预设应改成「写入一个静态段」，并沿用亮度恢复规则。
   */
  async applyPreset(_rgb: RGB): Promise<CommandResult> {
    return { kind: "error", message: SEGMENTS_UI_NOTICE };
  }

  /** 开关：离散路径，等 ACK。成功时用设备语义更新本地状态。 */
  async setPower(on: boolean): Promise<PowerResult> {
    const epoch = this.reconnect.epoch;
    try {
      // 亮度 0 时直接开灯视觉上等于没开：先用最近一次非 0 亮度恢复。
      // 正常关灯（brightness > 0）不会走这里——SetPower 本身保留亮度（§7）。
      // 这里拆成 SetBrightness + SetPower 两帧（#9 既有行为，保留）；
      // 两条都是绝对值命令，顺序保证最终状态一致。
      if (on && this.latestState !== null && this.latestState.brightness === 0) {
        const restored = brightnessForPowerOn(
          this.lastNonZeroBrightness,
          effectiveMaxBrightness(this.latestState.maxBrightness),
        );
        // 连续量不重传（spec §9）：亮度这一帧只发一次；ACK 超时按可能的断线处理。
        // 只有后面的 SetPower 允许重发一次。
        const brightnessAck = await this.sendCommand(cmdSetBrightness(restored));
        if (this.reconnect.isStale(epoch)) {
          return { kind: "stale" };
        }
        if (!brightnessAck.ok) {
          return { kind: "ack-error", ack: brightnessAck };
        }
        this.latestState = { ...this.latestState, brightness: restored };
        this.lastNonZeroBrightness = restored;
      }

      // 开关是幂等绝对值命令：ACK 超时允许重发一次（spec §9）。
      const ack = await this.sendCommand(cmdSetPower(on), {
        retryOnTimeout: 1,
      });
      if (this.reconnect.isStale(epoch)) {
        return { kind: "stale" };
      }
      if (!ack.ok) {
        return { kind: "ack-error", ack };
      }
      if (this.latestState !== null) {
        this.latestState = { ...this.latestState, power: on ? 1 : 0 };
      }
      return {
        kind: "ok",
        state: this.latestState ?? fallbackState({ r: 0, g: 0, b: 0 }, on ? 1 : 0),
      };
    } catch (err) {
      // 同上：异常照常提示，不用 stale 吞掉。
      return { kind: "error", message: errorText(err) };
    }
  }

  onLink(fn: (state: LinkState, detail?: LinkDetail) => void): () => void {
    return this.transport.onLink((state, detail) => fn(state, detail));
  }

  onDevices(fn: (list: DiscoveredDevice[]) => void): () => void {
    return this.transport.onDevices(fn);
  }

  onState(fn: (state: DeviceState) => void): () => void {
    return this.transport.onState(fn);
  }

  onDeviceEvent(fn: (code: number, detail: number) => void): () => void {
    return this.transport.onDeviceEvent(fn);
  }

  onScanHint(fn: (hint: string | null) => void): () => void {
    return this.transport.onScanHint(fn);
  }

  destroy(): void {
    this.reconnect.destroy();
    this.throttle.cancel();
    this.transport.destroy();
  }

  // ------------------------------------------------------------------
  // 内部
  // ------------------------------------------------------------------

  /** 清本地设备镜像与节流残留：断线后不保留旧状态显示。 */
  private clearDeviceState(): void {
    this.latestState = null;
    this.throttle.cancel();
  }

  private clearCachedDevice(): void {
    this.cached = null;
    clearCachedDevice(this.storage);
  }
}
