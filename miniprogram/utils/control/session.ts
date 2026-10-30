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
 * #25 分段：段配置由 SetSegment 0x10 / ClearSegment 0x11 下发，
 * 用 QueryStrip 0x12 读回（重连重建 UI 的权威路径，protocol §10.1）。
 * 颜色入口（queueColor / commitColor / applyPreset）不再禁用，改为「写入
 * strip 0 的选中段」；段列表由页面持有并驱动。
 *
 * 拆分后的协作模块（同级 utils/control/）：
 *  - reconnect.ts：连接生命周期监督者（退避回连 / epoch / 手动/自动互斥）；
 *  - device-cache.ts：deviceId 缓存（只存身份，不存状态）；
 *  - platform.ts：平台/开发版探测 + 无状态兜底快照。
 * 本文件只保留「命令语义 + 本地状态镜像 + 节流通道」。
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
  cmdClearSegment,
  cmdQueryState,
  cmdSelfTest,
  cmdSetBrightness,
  cmdSetLedCount,
  cmdSetPower,
  cmdSetSegment,
  staticSegment,
} from "../protocol/commands";
import { rgbToHsv } from "../color/hsv";
import type {
  AckResult,
  CommandRequest,
  DeviceState,
  DiscoveredDevice,
  LinkState,
  RGB,
  SegmentConfig,
  SegmentListEnd,
  SegmentReport,
  SegmentTarget,
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
 * 连续量通道（20Hz latest-wins）。**亮度与段颜色共用同一个闸门**：
 * 两条各自 20Hz 会叠成 40Hz，BLE 写入串行化会被拖慢（docs/ble-notes.md）。
 * 两帧都是绝对值命令，互相覆盖的语义安全——最后一帧决定最终观感。
 */
export type ContinuousUpdate =
  | { kind: "brightness"; value: number }
  | { kind: "color"; target: SegmentTarget; hue: number; sat: number };

/**
 * 段命令的专用结果。段配置不在 State 里，所以成功时不返回 DeviceState，
 * 而是返回设备权威的段列表（由 QueryStrip 读回）。
 */
export type SegmentResult =
  | { kind: "ok"; reports: SegmentReport[]; end: SegmentListEnd }
  | { kind: "ack-error"; ack: AckResult }
  | { kind: "stale" }
  | { kind: "error"; message: string };

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
  /** 颜色控件的当前目标段（页面在选中/新建段时设置）。 */
  private defaultSegment: SegmentTarget | null = null;

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

    /*
     * 20Hz latest-wins 闸门：亮度与段颜色共用一条。
     *
     * 为什么共用：两条独立的 20Hz 通道会在拖动时叠成 40Hz，把串行化的 BLE
     * 写队列压满（docs/ble-notes.md 的结论）。两者都是绝对值命令、互相覆盖
     * 的语义安全，因此「只保留最新一帧」对两者都成立。
     *
     * 连续量只等写回调；ACK 会异步进日志。写失败不重传（spec §9），
     * 但 10006 等链路错误要触发回连检查。
     */
    this.throttle = new LatestWinsThrottle<ContinuousUpdate>(
      (update) => {
        const req: CommandRequest =
          update.kind === "brightness"
            ? cmdSetBrightness(update.value)
            : cmdSetSegment(
                staticSegment(
                  update.target.stripId,
                  update.target.segId,
                  update.target.start,
                  update.target.end,
                  update.hue,
                  update.sat,
                ),
              );
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

  /** 颜色控件的当前目标段（未选中 / 没有段时为 null）。 */
  get activeSegment(): SegmentTarget | null {
    return this.defaultSegment === null ? null : { ...this.defaultSegment };
  }

  /**
   * 设置颜色控件的目标段。页面在「选中某段」或「新建区间」时调用；
   * 传 null 表示当前没有可写的段（颜色控件应给提示而不是假装成功）。
   */
  setActiveSegment(target: SegmentTarget | null): void {
    this.defaultSegment = target === null ? null : { ...target };
  }

  /** 目标段的兼容别名（内部使用）。 */
  private get defaultSegmentTarget(): SegmentTarget | null {
    return this.defaultSegment === null ? null : { ...this.defaultSegment };
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
    this.defaultSegment = null;
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
   * 色环拖动（连续量）——#25 起改为写入**选中段**的静态颜色。
   *
   * 为什么不走 20Hz 节流：段配置是离散命令（每帧一条 SetSegment，带完整的
   * 区间 + 参数），设备侧是 O(1) 内存写；而且它没有「绝对值合并」之外的连续
   * 语义（同段重复写只会覆盖自己）。但拖动会产生大量帧，所以这里**仍然**
   * 复用 20Hz latest-wins 闸门，只是 sink 换成 SetSegment。
   *
   * rgb 是用户空间颜色（不做 gamma、不折亮度）。hue/sat 由调用方给出
   * （色环本身就是 HSV，避免往返量化误差）；缺省时由 rgb 反推。
   */
  queueColor(rgb: RGB, target?: SegmentTarget): void {
    this.pushSegmentColor(rgb, target, false);
  }

  /** 色环松手——同 queueColor，并立即 flush（保证最终颜色落地）。 */
  commitColor(rgb: RGB, target?: SegmentTarget): void {
    this.pushSegmentColor(rgb, target, true);
  }

  /**
   * 预设点击——写入选中段的静态颜色（#25）。
   *
   * v1 的 SetAll 0x04 已退役；现在预设只是「给当前选中的段换个颜色」，
   * 开关与亮度都不动（亮度是独立字段，见 protocol §7）。
   */
  async applyPreset(rgb: RGB, target?: SegmentTarget): Promise<CommandResult> {
    const seg = target ?? this.defaultSegmentTarget;
    if (seg === null) {
      return { kind: "error", message: "请先新建一个灯珠区间" };
    }
    try {
      const result = await this.setSegmentColor(seg, rgb);
      if (result.kind !== "ok") {
        return result;
      }
      return {
        kind: "ok",
        state: this.latestState ?? fallbackState({ r: rgb.r, g: rgb.g, b: rgb.b }),
      };
    } catch (err) {
      return { kind: "error", message: errorText(err) };
    }
  }

  /**
   * 写一个静态段（#25 的主入口）：SetSegment + 等 ACK。
   *
   * 成功只代表「设备已接受并写入 RAM」；界面要显示权威段列表请用
   * queryStrip()。失败区分 ACK（InvalidParam：重叠 / 越界 / 类型不支持）与
   * 传输异常——前者要给用户明确原因，后者交给统一错误分诊。
   */
  async setSegment(segment: SegmentConfig, opts: SendOptions = {}): Promise<AckResult> {
    return this.sendCommand(cmdSetSegment(segment), opts);
  }

  /** 清一个段槽位（ClearSegment 0x11）。 */
  async clearSegment(segId: number, stripId = PRIMARY_STRIP_ID): Promise<AckResult> {
    return this.sendCommand(cmdClearSegment(stripId, segId));
  }

  /**
   * 读回某灯带的段列表（QueryStrip 0x12）：seg_count 条 SegmentReport +
   * SegmentListEnd，同 seq 多帧。这是重连重建 UI 的权威路径
   * （protocol §10.1 第 2 步）。
   */
  async queryStrip(stripId = PRIMARY_STRIP_ID): Promise<SegmentResult> {
    if (this.transport.linkState !== "ready") {
      return { kind: "error", message: "设备未连接" };
    }
    const epoch = this.reconnect.epoch;
    try {
      const result = await this.transport.queryStrip(stripId);
      if (this.reconnect.isStale(epoch)) {
        return { kind: "stale" };
      }
      return { kind: "ok", reports: result.reports, end: result.end };
    } catch (err) {
      if (this.reconnect.isStale(epoch)) {
        return { kind: "stale" };
      }
      return { kind: "error", message: errorText(err) };
    }
  }

  /**
   * 把选中段改成 rgb 并等 ACK——页面与预设共用的一条路径。
   * 返回 ACK 结果（InvalidParam 表示设备拒绝了区间或与其它段重叠）。
   */
  async setSegmentColor(target: SegmentTarget, rgb: RGB): Promise<SegmentResult> {
    if (this.transport.linkState !== "ready") {
      return { kind: "error", message: "设备未连接" };
    }
    // 色环给的是 RGB；协议的静态参数是 hue+sat。用 HSV 反推（V 恒为 1）。
    const hsv = rgbToHsv(rgb);
    const segment = staticSegment(
      target.stripId,
      target.segId,
      target.start,
      target.end,
      Math.round((hsv.h / 360) * 0x10000) & 0xffff,
      Math.round(hsv.s * 255),
    );
    const epoch = this.reconnect.epoch;
    try {
      const ack = await this.setSegment(segment);
      if (this.reconnect.isStale(epoch)) {
        return { kind: "stale" };
      }
      if (!ack.ok) {
        return { kind: "ack-error", ack };
      }
      return { kind: "ok", reports: [], end: { stripId: target.stripId, segMask: 0 } };
    } catch (err) {
      return { kind: "error", message: errorText(err) };
    }
  }

  /**
   * 色环拖动 / 松手的统一入口（#25）：把用户空间 RGB 写进目标段的静态颜色。
   *
   * - 没有目标段：静默忽略（页面在 UI 上禁用颜色控件，这里只是兜底）。
   * - 连续拖动：20Hz latest-wins；松手 flush 一次确保最终颜色落地。
   * - 不做本地乐观更新：段配置不在 State 里，界面只显示「已选颜色」，
   *   设备权威的段列表由 queryStrip 拉取。
   */
  private pushSegmentColor(rgb: RGB, target: SegmentTarget | undefined, commit: boolean): void {
    const seg = target ?? this.defaultSegmentTarget;
    if (seg === null || this.transport.linkState !== "ready") {
      return;
    }
    const hsv = rgbToHsv(rgb);
    this.throttle.push({
      kind: "color",
      target: seg,
      hue: Math.round((hsv.h / 360) * 0x10000) & 0xffff,
      // 饱和度用 0-255：协议 sat 的刻度（effects-spec §2.1）。
      sat: Math.round(hsv.s * 255),
    });
    if (commit) {
      this.throttle.flush();
    }
  }

  /**
   * 开关：离散路径，等 ACK。成功时用设备语义更新本地状态。
   */
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
    /* 断开后没有可写的段：颜色控件应回到禁用态。 */
    this.defaultSegment = null;
  }

  private clearCachedDevice(): void {
    this.cached = null;
    clearCachedDevice(this.storage);
  }
}
