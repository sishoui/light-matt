/**
 * 控制会话：页面与传输层之间唯一的门面。
 *
 * 页面只 import 本模块；BLE 细节、节流、命令构造都在这里或其下层。
 * #8 开关走离散路径；#9 亮度走 20Hz latest-wins 连续路径；#10 颜色复用同一条
 * 连续通道（一个 throttle 实例，避免两路各 20Hz 叠成 40Hz）；#11 在会话层补
 * 连接生命周期的最后一块：断线通知、1s/2s/4s 有限次退避回连、前台静默回连、
 * deviceId 缓存，以及 10006 / 10008 / 10001 的错误分诊。
 *
 * 状态权威：设备。任何连接建立（首次 / 回连）都由 transport.connect 走完整
 * 初始化流水线（MTU → services → chars → 重新订阅 notify → 读 State），
 * 本模块只在拿到 State 后更新本地镜像，绝不用本地缓存覆盖设备。
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
import { applyLocalColor, clampRgb, presetBrightness } from "./color";
import { LED_COUNT_ACK_TIMEOUT_MS } from "./ledCount";
import { MAX_LEDS, MIN_LEDS } from "../protocol/constants";
import {
  cmdQueryState,
  cmdSetAll,
  cmdSetBrightness,
  cmdSetColor,
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

export type ContinuousUpdate =
  | { kind: "brightness"; value: number }
  | { kind: "color"; rgb: RGB };

/** deviceId 缓存后端。默认 wx.storage；单测注入内存实现（不是 BLE 假件）。 */
export interface SessionStorage {
  get(key: string): string | null;
  set(key: string, value: string): void;
  remove(key: string): void;
}

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

/** deviceId 缓存键（含版本，避免读到旧结构）。 */
export const DEVICE_CACHE_KEY = "lumen.lastDevice.v1";

const DEFAULT_RECONNECT_DELAYS_MS = [1000, 2000, 4000];
const DEFAULT_RETRY_AFTER_GAP_MS = 500;

interface CachedDevice {
  deviceId: string;
  name?: string;
}

const defaultTimer: TimerApi = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle),
};

function delayWith(timer: TimerApi, ms: number): Promise<void> {
  return new Promise((resolve) => {
    timer.setTimeout(() => resolve(), ms);
  });
}

/** 默认 storage：wx.setStorageSync。Node 单测里没有 wx，调用一律安全降级。 */
function createWxStorage(): SessionStorage {
  const available =
    typeof wx !== "undefined" &&
    typeof wx.getStorageSync === "function" &&
    typeof wx.setStorageSync === "function";
  return {
    get(key) {
      if (!available) return null;
      try {
        const value = wx.getStorageSync(key);
        return typeof value === "string" && value.length > 0 ? value : null;
      } catch {
        return null;
      }
    },
    set(key, value) {
      if (!available) return;
      try {
        wx.setStorageSync(key, value);
      } catch {
        /* 存储失败不影响连接 */
      }
    },
    remove(key) {
      if (!available) return;
      try {
        wx.removeStorageSync(key);
      } catch {
        /* ignore */
      }
    },
  };
}

/**
 * 还没有设备状态时的兜底快照：只用于页面渲染，不写入设备。
 * （正常路径下 latestState 在连接流水线读 State 后必然存在。）
 */
function fallbackState(rgb: RGB, power: 0 | 1 = 1, brightness = 0): DeviceState {
  return {
    power,
    brightness,
    r: rgb.r,
    g: rgb.g,
    b: rgb.b,
    ledCount: 0,
    maxBrightness: 255,
  };
}

/** 从 wx 取平台；devtools 归到 other（BLE 能力只模拟一部分）。 */
export function detectPlatform(): "android" | "ios" | "other" {
  try {
    const info = wx.getDeviceInfo?.() ?? wx.getSystemInfoSync();
    const platform = String((info as { platform?: string }).platform ?? "").toLowerCase();
    if (platform === "android") return "android";
    if (platform === "ios") return "ios";
    return "other";
  } catch {
    return "other";
  }
}

/** 开发版判断：develop / trial 都打 hex，正式版不打。 */
export function detectDevMode(): boolean {
  try {
    const info = wx.getAccountInfoSync?.();
    const env = info?.miniProgram?.envVersion;
    return env === "develop" || env === "trial";
  } catch {
    return false;
  }
}

export class ControlSession {
  readonly transport: BleTransport;
  private readonly throttle: LatestWinsThrottle<ContinuousUpdate>;
  private latestState: DeviceState | null = null;
  /** 亮度 0 时开灯，用最近一次非 0 亮度恢复（#9）。 */
  private lastNonZeroBrightness = 128;

  private readonly reconnectTimer: TimerApi;
  private readonly reconnectDelaysMs: number[];
  private readonly retryAfterGapMs: number;
  private readonly storage: SessionStorage;

  /** 缓存的设备身份：回连与进前台静默回连都用它（设备是状态权威，不缓存状态）。 */
  private cached: CachedDevice | null = null;
  /** 有回连意图时为 true；主动断开 / 用户扫描 / 手动连接都会清掉。 */
  private reconnectDesired = false;
  /** 已发起的自动回连次数（0 表示还没重试过）。 */
  private reconnectAttempts = 0;
  private reconnectHandle: ReturnType<typeof setTimeout> | null = null;
  private reconnectRunning = false;
  /** 本轮退避已耗尽：onShow 不再自动重来，只留手动入口（禁止无限循环）。 */
  private reconnectExhausted = false;
  private manualConnecting = false;
  /** 用户主动断开后，进前台不再擅自回连；下次手动连接/扫描时解除。 */
  private suppressAutoReconnect = false;

  /**
   * 连接代次：每次「连接身份」变化都 +1——进入 ready、主动断开、非主动断线、
   * 适配器关闭。
   *
   * 唯一用途：判断一条飞行中的命令是不是**旧连接上的**。
   *  - 成功 / 非零 ACK：旧连接的结论一律作废，不覆盖回连后读到的新 State → `stale`；
   *  - 异常：照常向上抛（错误提示必须能被用户看到，不能被 stale 吞掉）。
   */
  private linkEpoch = 0;
  private lastLinkState: LinkState;

  constructor(opts: SessionOptions) {
    const log = new FrameLog({ mirrorToConsole: opts.devMode });
    if (opts.transportOverride !== undefined) {
      this.transport = opts.transportOverride;
    } else {
      const transportOptions: BleTransportOptions = { log, platform: opts.platform };
      this.transport = new BleTransport(transportOptions);
    }

    this.reconnectTimer = opts.reconnectTimer ?? defaultTimer;
    this.reconnectDelaysMs =
      opts.reconnectDelaysMs !== undefined && opts.reconnectDelaysMs.length > 0
        ? [...opts.reconnectDelaysMs]
        : [...DEFAULT_RECONNECT_DELAYS_MS];
    this.retryAfterGapMs = opts.retryAfterGapMs ?? DEFAULT_RETRY_AFTER_GAP_MS;
    this.storage = opts.storage ?? createWxStorage();
    this.cached = this.loadCachedDevice();
    this.lastLinkState = this.transport.linkState;

    // 单一 20Hz 闸门服务亮度与颜色，避免两路各 20Hz 叠成 40Hz。
    this.throttle = new LatestWinsThrottle<ContinuousUpdate>(
      (update) => {
        const req: CommandRequest =
          update.kind === "brightness"
            ? cmdSetBrightness(update.value)
            : cmdSetColor(update.rgb);
        // 连续量只等写回调；ACK 会异步进日志。写失败不重传连续量（spec §9），
        // 但 10006 等链路错误要触发回连检查。
        return this.transport.write(req).then(
          () => undefined,
          (err) => {
            this.handleCommandFailure(err);
          },
        );
      },
      opts.throttleTimer !== undefined ? { timer: opts.throttleTimer } : {},
    );

    // 内部监听必须早于页面注册，保证断线时先清本地状态再通知 UI。
    this.transport.onLink((state, detail) => this.handleLinkChange(state, detail));

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
    return this.reconnectDesired;
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
    this.abandonReconnect();
    this.suppressAutoReconnect = false;
    await this.transport.startScan();
  }

  async stopScan(): Promise<void> {
    await this.transport.stopScan();
  }

  async connect(deviceId: string, name?: string): Promise<DeviceState> {
    // 手动连接优先：取消退避计时器与回连意图，并重置尝试次数（spec #41）。
    this.abandonReconnect();
    this.suppressAutoReconnect = false;
    this.manualConnecting = true;
    try {
      const state = await this.transport.connect(deviceId, name);
      this.latestState = state;
      // 只有完整初始化成功后才缓存 deviceId（失败的下次扫描更可靠）。
      this.cacheDevice(deviceId, name);
      return state;
    } catch (err) {
      // 10002 / 10013：设备不在附近或 deviceId 失效（iOS UUID 会变），清缓存。
      if (err instanceof WxCallError && (err.errCode === 10002 || err.errCode === 10013)) {
        this.clearCachedDevice();
      }
      throw err;
    } finally {
      this.manualConnecting = false;
    }
  }

  async disconnect(): Promise<void> {
    // 主动断开：不触发自动回连，也不再让 onShow 擅自重连。
    this.abandonReconnect();
    this.suppressAutoReconnect = true;
    this.throttle.cancel();
    await this.transport.disconnect();
    this.latestState = null;
    this.linkEpoch += 1;
  }

  /**
   * 页面 onShow：有 deviceId 缓存且当前未连接时静默回连。
   *
   * 不得打断正在进行的扫描 / 手动连接 / 自动回连：这些状态下直接返回。
   * 已连接时只做一次 State 复核（设备是权威；后台期间可能被系统断开）。
   * 退避已耗尽的一轮不再自动重来（禁止无限循环），只留手动入口。
   */
  async onShow(): Promise<void> {
    if (this.reconnectRunning || this.manualConnecting) {
      return;
    }
    const link = this.transport.linkState;
    if (link === "scanning" || link === "connecting" || link === "initializing") {
      return; // 用户正在扫描/连接，onShow 不抢链路
    }
    if (link === "ready") {
      // 后台可能被系统断连：读一次 State 复核，失败按「可能断线」处理。
      void this.refreshState().catch((err) => {
        if (triage(err) === "reconnect") {
          void this.forceReconnect("连接已断开");
        }
      });
      return;
    }
    if (this.cached === null || this.suppressAutoReconnect) {
      return;
    }
    if (link === "adapter-off" || link === "uninitialized") {
      // 适配器没开：只记回连意图，等 onBluetoothAdapterStateChange；
      // 10001 是非致命的，这里绝不能弹错或空转。
      if (!this.reconnectExhausted) {
        this.reconnectDesired = true;
      }
      return;
    }
    if (link !== "idle" && link !== "failed") {
      return;
    }
    if (this.reconnectExhausted) {
      // 上一轮 1s/2s/4s 已用完：不自动重来，用户点连接条手动重连。
      return;
    }
    // 未连接且有缓存：立即静默试一次；失败后按 2s/4s 继续（总次数仍不超过 3 次）。
    this.reconnectDesired = true;
    this.reconnectAttempts = 0;
    this.reconnectExhausted = false;
    this.clearReconnectTimer();
    await this.runReconnectAttempt();
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
    const epoch = this.linkEpoch;
    try {
      return await this.transport.sendAndWaitAck(req, opts);
    } catch (err) {
      if (triage(err) === "retry-after-gap") {
        await delayWith(this.reconnectTimer, this.retryAfterGapMs);
        if (epoch !== this.linkEpoch) {
          throw err; // 等待期间已断开/重连：这条命令不再写
        }
        try {
          // 丢弃 retryOnTimeout：这次「加间隔重试」本身就是唯一一次额外写，
          // 不允许它在内部再叠一次 ACK 超时重发。
          return await this.transport.sendAndWaitAck(req, { ...opts, retryOnTimeout: 0 });
        } catch (retryErr) {
          if (triage(retryErr) === "retry-after-gap") {
            // 加间隔后仍失败：链路重建（不再重试写）。
            void this.forceReconnect("蓝牙链路异常，正在重连");
          } else {
            this.handleCommandFailure(retryErr);
          }
          throw retryErr;
        }
      }
      this.handleCommandFailure(err);
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
    const epoch = this.linkEpoch;
    try {
      // 走 #11 的统一命令通道（10008 加间隔重试 / 断线触发重连），
      // 但 ACK 超时仍是 3000ms，且不设 retryOnTimeout：重建是重操作，
      // 超时重发只会撞上 0x05 Busy。
      const ack = await this.sendCommand(cmdSetLedCount(count), {
        timeoutMs: LED_COUNT_ACK_TIMEOUT_MS,
      });
      // #11：旧连接上飞行的 ACK 晚到，不得覆盖回连后读到的新 State。
      if (this.isStaleEpoch(epoch)) {
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
   * #10：色环拖动（连续量）。走与亮度同一个 20Hz latest-wins 闸门，
   * 绝不另开通道（否则两路各 20Hz 会叠成 40Hz）。
   *
   * 乐观更新：本地 RGB 立即跟随手指；不等 ACK、不重传（连续量语义）。
   * 只改颜色，不动 power / brightness（§7：关灯时选色只保存，不点亮）。
   */
  queueColor(rgb: RGB): void {
    if (this.transport.linkState !== "ready") {
      return;
    }
    const color = clampRgb(rgb);
    this.rememberColor(color);
    this.throttle.push({ kind: "color", rgb: color });
  }

  /** #10：色环松手——发最新值并 flush，保证最终颜色落地。 */
  commitColor(rgb: RGB): void {
    if (this.transport.linkState !== "ready") {
      return;
    }
    const color = clampRgb(rgb);
    this.rememberColor(color);
    this.throttle.push({ kind: "color", rgb: color });
    this.throttle.flush();
  }

  /**
   * #10：预设点击 = 一次 SetAll（开关=1、亮度=当前、RGB=预设）。
   *
   * 为什么用 SetAll 而不是 SetPower + SetColor：
   *  - 单帧原子生效，固件只渲染一次，灯带不出现「先变亮再变色」的中间态；
   *  - 关灯态点预设也能一步点亮（预设 = 场景入口）；
   *  - 当前亮度为 0 时用最近一次非 0 亮度恢复，避免「点了但没亮」。
   *
   * 关键顺序：先丢弃节流通道里还没发出的旧颜色，再发 SetAll。
   * 否则拖动残留的颜色可能在 SetAll 之后落地，造成「旧色回跳」。
   * SetAll 是离散绝对值命令，允许 ACK 超时重发一次。
   *
   * ACK 写回本地状态前要再核一次「本地颜色是否仍等于这次请求的颜色」：
   * 若用户在这条 SetAll 飞行的过程中又拖了色环 / 点了别的预设，本地已经
   * 是更新的值，旧 ACK 不得把颜色改回去。
   */
  async applyPreset(rgb: RGB): Promise<CommandResult> {
    const epoch = this.linkEpoch;
    try {
      const color = clampRgb(rgb);
      const brightness = presetBrightness(this.latestState, this.lastNonZeroBrightness);
      this.throttle.dropIf((update) => update.kind === "color");
      this.rememberColor(color);
      this.rememberBrightness(brightness);
      const ack = await this.sendCommand(cmdSetAll(1, brightness, color), {
        retryOnTimeout: 1,
      });
      if (this.isStaleEpoch(epoch)) {
        return { kind: "stale" };
      }
      if (!ack.ok) {
        return { kind: "ack-error", ack };
      }
      this.applyPresetLocally(color, brightness);
      return { kind: "ok", state: this.latestState ?? fallbackState(color, 1, brightness) };
    } catch (err) {
      // 异常不折成 stale：用户需要看到「连接已断开」之类的提示。
      // 只有成功的旧 ACK 才会覆盖新 State，那种情况才丢弃。
      return { kind: "error", message: errorText(err) };
    }
  }

  /**
   * 预设 ACK 后的本地写回。
   *
   * power 一定置 1：SetAll(power=1) 已被设备接受，这是设备事实。
   * 亮度与颜色只在「本地颜色仍是这次预设色」时覆盖——若用户在这条 SetAll
   * 飞行过程中又拖了色环 / 点了别的预设，本地已是更新的值，旧 ACK 不得改回。
   */
  private applyPresetLocally(color: RGB, brightness: number): void {
    const state = this.latestState;
    if (state === null) {
      return;
    }
    if (state.r !== color.r || state.g !== color.g || state.b !== color.b) {
      this.latestState = { ...state, power: 1 };
      return;
    }
    this.latestState = {
      ...applyLocalColor(state, color),
      power: 1,
      brightness,
    };
  }

  /** 乐观更新本地颜色：UI 立即跟手；不动 power / brightness。 */
  private rememberColor(rgb: RGB): void {
    if (this.latestState !== null) {
      this.latestState = applyLocalColor(this.latestState, rgb);
    }
  }

  /** 开关：离散路径，等 ACK。成功时用设备语义更新本地状态。 */
  async setPower(on: boolean): Promise<PowerResult> {
    const epoch = this.linkEpoch;
    try {
      // 亮度 0 时直接开灯视觉上等于没开：先用最近一次非 0 亮度恢复。
      // 正常关灯（brightness > 0）不会走这里——SetPower 本身保留亮度（§7）。
      // 这里拆成 SetBrightness + SetPower 两帧（#9 既有行为，保留）；
      // 两条都是绝对值命令，顺序保证最终状态一致。预设走 SetAll 单帧（#10）。
      if (on && this.latestState !== null && this.latestState.brightness === 0) {
        const restored = brightnessForPowerOn(
          this.lastNonZeroBrightness,
          effectiveMaxBrightness(this.latestState.maxBrightness),
        );
        // 连续量不重传（spec §9）：亮度这一帧只发一次；ACK 超时按可能的断线处理。
        // 只有后面的 SetPower 允许重发一次。
        const brightnessAck = await this.sendCommand(cmdSetBrightness(restored));
        if (this.isStaleEpoch(epoch)) {
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
      if (this.isStaleEpoch(epoch)) {
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
    this.reconnectDesired = false;
    this.clearReconnectTimer();
    this.throttle.cancel();
    this.transport.destroy();
  }

  // ------------------------------------------------------------------
  // 连接生命周期（#11）
  // ------------------------------------------------------------------

  private handleLinkChange(state: LinkState, detail?: LinkDetail): void {
    const previous = this.lastLinkState;
    this.lastLinkState = state;

    if (state === "ready") {
      // 新连接（首次 / 回连）：seq 已由传输层重置为 0x01；这里重置退避与过期判定代次。
      this.linkEpoch += 1;
      this.reconnectDesired = false;
      this.reconnectAttempts = 0;
      this.reconnectExhausted = false;
      this.suppressAutoReconnect = false;
      this.clearReconnectTimer();
      return;
    }

    if (state === "adapter-off") {
      this.linkEpoch += 1;
      this.clearDeviceState();
      this.clearReconnectTimer();
      // 只有「本来连着 / 本来就想回连」才挂起回连意图；
      // 纯扫描意图优先，适配器恢复后交给 transport 自动续扫。
      if (
        previous === "ready" ||
        previous === "initializing" ||
        previous === "connecting" ||
        this.reconnectDesired
      ) {
        this.reconnectDesired = this.cached !== null && !this.suppressAutoReconnect;
      }
      return;
    }

    if (state === "idle") {
      if (detail?.reconnectable === true) {
        // 非主动断线：UI 立即失去设备状态（不显示过期状态）。
        this.linkEpoch += 1;
        this.clearDeviceState();
        if (this.manualConnecting || this.reconnectRunning) {
          // 初始化中被打断：由 connect()/本次回连的 catch 处理，这里不重复排。
          return;
        }
        if (this.cached !== null && !this.suppressAutoReconnect) {
          // 新的一轮断线：退避从 1s 重新数，并清掉上一轮的耗尽标记。
          this.reconnectDesired = true;
          this.reconnectAttempts = 0;
          this.reconnectExhausted = false;
          this.scheduleReconnect();
        }
        return;
      }
      // 适配器恢复 / 停扫后的 idle：如果还挂着回连意图，按退避节奏继续。
      if (
        (previous === "adapter-off" || previous === "uninitialized" || previous === "scanning") &&
        this.reconnectDesired &&
        this.cached !== null
      ) {
        this.reconnectAttempts = 0;
        this.scheduleReconnect();
      }
      return;
    }

    if (state === "failed") {
      // 一次回连尝试失败：由 runReconnectAttempt 的 catch 排下一次；
      // 其它来源的失败（手动连接）不自动退避。
      if (this.reconnectDesired && !this.reconnectRunning && !this.manualConnecting) {
        this.scheduleReconnect();
      }
    }
  }

  /** 清本地设备镜像与节流残留：断线后不保留旧状态显示。 */
  private clearDeviceState(): void {
    this.latestState = null;
    this.throttle.cancel();
  }

  /** 取消当前这一轮自动回连（用户扫描 / 手动连接 / 主动断开时调用）。 */
  private abandonReconnect(): void {
    this.reconnectDesired = false;
    this.reconnectAttempts = 0;
    this.reconnectExhausted = false;
    this.clearReconnectTimer();
  }

  private scheduleReconnect(): void {
    if (!this.reconnectDesired || this.cached === null || this.reconnectHandle !== null) {
      return;
    }
    if (this.reconnectRunning) {
      return;
    }
    if (this.reconnectAttempts >= this.reconnectDelaysMs.length) {
      // 有限次：耗尽后停在这里，链路停在最后一次失败的 failed，
      // 页面显示「未连接」并由连接条提供扫描/手动重连入口。绝不无限循环。
      this.reconnectDesired = false;
      this.reconnectExhausted = true;
      this.clearReconnectTimer();
      return;
    }
    const wait = this.reconnectDelaysMs[this.reconnectAttempts];
    this.reconnectHandle = this.reconnectTimer.setTimeout(() => {
      this.reconnectHandle = null;
      void this.runReconnectAttempt();
    }, wait);
  }

  /** 一次自动回连：完整走 transport.connect（重新订阅 notify + 读 State）。 */
  private async runReconnectAttempt(): Promise<void> {
    if (!this.reconnectDesired || this.reconnectRunning || this.cached === null) {
      return;
    }
    const link = this.transport.linkState;
    if (link === "adapter-off" || link === "uninitialized") {
      return; // 等适配器事件，不消耗尝试次数
    }
    if (
      link === "scanning" ||
      link === "connecting" ||
      link === "initializing" ||
      link === "ready"
    ) {
      return; // 不打断扫描 / 手动连接
    }

    this.reconnectRunning = true;
    this.reconnectAttempts += 1;
    const target = this.cached;
    let failed = false;
    try {
      const state = await this.transport.connect(target.deviceId, target.name);
      // ready 事件负责清掉回连意图；这里只兜底同步本地镜像。
      this.latestState = state;
    } catch {
      failed = true;
    } finally {
      this.reconnectRunning = false;
    }
    // 必须在 reconnectRunning 复位之后再排下一次，否则 scheduleReconnect 会直接返回，
    // 退避链就断在一次失败上（只剩 1s 这一次）。
    if (failed && this.reconnectDesired) {
      this.scheduleReconnect();
    }
  }

  /**
   * 链路疑似已断（10006 / 写超时 / 连续 10008）时强制重建连接。
   *
   * 若传输层已经把状态切到 idle（带 reconnectable），这里直接返回——
   * 避免和 onLink 触发的退避重复排程。
   */
  private async forceReconnect(reason: string): Promise<void> {
    if (this.reconnectDesired || this.cached === null || this.suppressAutoReconnect) {
      return;
    }
    console.warn(`[lumen] ${reason}，准备回连`);
    this.reconnectDesired = true;
    this.reconnectAttempts = 0;
    this.reconnectExhausted = false;
    this.clearReconnectTimer();
    this.clearDeviceState();
    this.linkEpoch += 1;
    try {
      await this.transport.disconnect();
    } catch {
      /* 已断开时 close 失败无所谓 */
    }
    if (!this.reconnectDesired) {
      return;
    }
    this.scheduleReconnect();
  }

  /** 命令失败后的分诊：10006 直接重连；ACK 超时先读 State 探活再决定。 */
  private handleCommandFailure(err: unknown): void {
    const action = triage(err);
    if (action !== "reconnect") {
      // retry-after-gap 由 sendCommand 负责重试；wait-adapter 等适配器事件；
      // fatal 交给调用方提示用户。
      return;
    }
    // 10006 = no connection：链路确定已断，直接重建，不浪费 2s 去 read。
    const errCode = err instanceof WxCallError ? err.errCode : undefined;
    if (errCode === 10006 || this.transport.linkState !== "ready") {
      void this.forceReconnect("连接已断开");
      return;
    }
    // ACK 超时（可能只是丢了一帧）：读一次 State 探活，读不到才重建。
    // 无论如何都不重传这条命令（连续量不重传；离散量由调用方决定）。
    void this.refreshState().catch(() => {
      void this.forceReconnect("连接已断开");
    });
  }

  private isStaleEpoch(epoch: number): boolean {
    return epoch !== this.linkEpoch;
  }

  private clearReconnectTimer(): void {
    if (this.reconnectHandle !== null) {
      this.reconnectTimer.clearTimeout(this.reconnectHandle);
      this.reconnectHandle = null;
    }
  }

  private loadCachedDevice(): CachedDevice | null {
    const raw = this.storage.get(DEVICE_CACHE_KEY);
    if (raw === null) {
      return null;
    }
    try {
      const parsed = JSON.parse(raw) as { deviceId?: unknown; name?: unknown };
      if (typeof parsed?.deviceId !== "string" || parsed.deviceId.length === 0) {
        return null;
      }
      return {
        deviceId: parsed.deviceId,
        ...(typeof parsed.name === "string" && parsed.name.length > 0
          ? { name: parsed.name }
          : {}),
      };
    } catch {
      return null;
    }
  }

  private cacheDevice(deviceId: string, name?: string): void {
    this.cached = {
      deviceId,
      ...(name !== undefined && name.length > 0 ? { name } : {}),
    };
    this.storage.set(DEVICE_CACHE_KEY, JSON.stringify(this.cached));
  }

  private clearCachedDevice(): void {
    this.cached = null;
    this.storage.remove(DEVICE_CACHE_KEY);
  }
}
