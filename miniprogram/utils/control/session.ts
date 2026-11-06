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
 *
 * v2（#21）退役了 SetColor 0x03 / SetAll 0x04，颜色由段配置（0x10 SetSegment）
 * 承担；#25 已把颜色入口接到选中段（不再是占位实现）。
 *
 * #34：成功连接（ready）时向可选的使用日志落点记一条「谁 × 哪台 × 什么时候」。
 * 日志是同步、吞异常、不 await 的旁路——BLE 控制不依赖后端，后端不可达也不影响它。
 */

import { FrameLog } from "../ble/log";
import { LatestWinsThrottle, type TimerApi } from "../ble/throttle";
import {
  BleTransport,
  ConnectCancelledError,
  type BleTransportOptions,
  type LinkDetail,
  type SendOptions,
} from "../ble/transport";
import { errorText, resultText, triage } from "../ble/errors";
import { WxCallError } from "../ble/wx-promise";
import {
  applyLocalBrightness,
  brightnessForPowerOn,
  clampBrightness,
  effectiveMaxBrightness,
} from "./brightness";
import {
  abandonSwitch,
  beginSwitch,
  initialSwitchState,
  isSwitching,
  retrySwitch,
  switchedDisconnected,
  switchedReady,
  switchFailed,
  type SwitchState,
} from "./device-switch";
import {
  forgetDevice,
  loadRecentDevices,
  recordConnection,
  updateDeviceIdentity,
  type RecentDevice,
} from "./device-history";
import { LED_COUNT_ACK_TIMEOUT_MS } from "./ledCount";
import { MAX_LEDS, MAX_SCENES, MAX_STRIPS, MIN_LEDS, RESULT } from "../protocol/constants";
import type { UsageLogSink } from "../usage/logger";
import {
  buildSceneReport,
  cmdActivateScene,
  cmdLayoutCommit,
  cmdLayoutPart,
  cmdLayoutSeg,
  cmdLayoutWrite,
  cmdQueryState,
  cmdSceneName,
  cmdScenePart,
  cmdSceneStep,
  cmdSelfTest,
  cmdSetBrightness,
  cmdSetLedCount,
  cmdSetPower,
  cmdSetStripPower,
} from "../protocol/commands";
import type {
  AckResult,
  CommandRequest,
  DeviceInfo,
  DeviceState,
  DiscoveredDevice,
  LayoutPart,
  LayoutReadback,
  LinkState,
  SceneReport,
  SceneStep,
  StripConfig,
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
import { loadRegistry, setHardwareId } from "./device-registry";

export { DEVICE_CACHE_KEY, detectDevMode, detectPlatform };
export type { CachedDevice, SessionStorage };

/**
 * 连续量通道（20Hz latest-wins）。
 *
 * v5 只剩亮度一条连续量：颜色不再逐帧下发（灯效的参数编辑走离散的
 * SceneStep，一次一步，不需要 20Hz 闸门）。
 */
export type ContinuousUpdate = { kind: "brightness"; value: number };

/**
 * 会话当前操作的灯带（App 级状态，#41）。
 *
 * 灯带是 v3 的显式维度：**页面必须把正在展示的 stripId 传进来**，本字段只
 * 用于「用户上次选的是哪条带」这类跨页记忆（切 tab 后不跳带）。它绝不是
 * 「省略 stripId 时的默认值」——那种缺省会让第 3 条带上的删除操作写回第 0 条。
 */
const DEFAULT_ACTIVE_STRIP_ID = 0;

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
  /**
   * 使用日志落点（#34）。不传 = 不上报（配置缺失时页面就不注入）。
   *
   * 接口只有「记录一次成功连接」一个方法，且同步返回：日志是旁路，
   * 传输层 / 控制流程永远不 await 它，也不感知它的失败。
   */
  usageLogger?: UsageLogSink;
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

/**
 * 布局读回的结果（QueryLayout 0x24）。
 *
 * 失败时仍带上已读到的部分（`parts` 的前缀）：页面可以只灰掉读不到的
 * 那几个部位，而不是整块清空。
 */
export type LayoutResult =
  | { kind: "ok"; layout: LayoutReadback }
  | { kind: "stale" }
  | { kind: "error"; message: string; layout?: LayoutReadback };

/**
 * 场景读回的结果（QueryScene 0x29）。
 *
 * 同 `LayoutResult`：失败时把已读到的部位 / 步骤带回来。
 */
export type SceneResult =
  | { kind: "ok"; scene: SceneReport }
  | { kind: "stale" }
  | { kind: "error"; message: string; scene?: SceneReport };

/**
 * 布局 / 场景写命令的结果。
 *
 * `storage` 单独一支：设备回 StorageFailed 表示**落盘失败但 RAM 已改**
 * （layout 例外——commit 失败时 RAM 保留），页面要提示「已生效但未保存」。
 */
export type EditResult =
  | { kind: "ok"; state?: DeviceState | null }
  | { kind: "storage"; message: string }
  | { kind: "ack-error"; ack: AckResult }
  | { kind: "stale" }
  | { kind: "error"; message: string };

/** QueryStripConfig 的结果（0x87 是设备权威，只读）。 */
export type StripConfigResult =
  | { kind: "ok"; config: StripConfig }
  | { kind: "stale" }
  | { kind: "error"; message: string };

/** QueryDeviceInfo 的结果（0x88 是设备权威）。 */
export type DeviceInfoResult =
  | { kind: "ok"; info: DeviceInfo }
  | { kind: "stale" }
  | { kind: "error"; message: string };

const DEFAULT_RETRY_AFTER_GAP_MS = 500;

/**
 * 改某条灯带的灯珠数（本地镜像）。
 *
 * v5 的 State 里 `stripLedCounts` 就是权威字段（逐条数组），没有派生字段
 * 要维护——`DeviceState` 不再有 `ledCount` / `segCount`。
 */
function applyStripLedCount(state: DeviceState, stripId: number, count: number): DeviceState {
  const stripLedCounts = state.stripLedCounts.slice();
  stripLedCounts[stripId] = count;
  return { ...state, stripLedCounts };
}

/**
 * 改某条灯带的开关位（本地镜像）。mask 是设备的权威字段，命令成功后才改；
 * 全局 `power` 不受影响（§9.5：总闸与每带开关是两件事）。
 */
function applyStripPower(state: DeviceState, stripId: number, on: boolean): DeviceState {
  const bit = 1 << stripId;
  const mask = on ? state.stripPowerMask | bit : state.stripPowerMask & ~bit;
  return { ...state, stripPowerMask: mask };
}

const defaultTimer: TimerApi = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle),
};

/** 8 个空布局读回（逐带缓存初值，与 MAX_STRIPS 对齐）。 */
function emptyLayoutCache(): Array<LayoutReadback | null> {
  return Array.from({ length: MAX_STRIPS }, () => null);
}

/** 3 个空场景读回（与 MAX_SCENES 对齐）。 */
function emptySceneCache(): Array<SceneReport | null> {
  return Array.from({ length: MAX_SCENES }, () => null);
}

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
  /** v3：当前操作哪条灯带（#41 的灯带切换器会调 `setActiveStripId`）。 */
  private activeStrip = DEFAULT_ACTIVE_STRIP_ID;
  /** v3：最近一次 QueryStripConfig 的结果（§9.1 第 2 步）。 */
  private stripConfigCache: StripConfig | null = null;
  /** v3：最近一次 QueryDeviceInfo 的结果（§9.1 第 3 步）。 */
  private deviceInfoCache: DeviceInfo | null = null;
  /**
   * 逐带布局缓存（§9.1 第 3 步，`QueryLayout(i)` 按需）。
   *
   * 下标 = stripId。功能上只做「同一条带重复读不必等」的加速——**每次切带
   * 仍以设备为准**，页面要最新值就调 `queryLayout`。断线必须整体清空：
   * 它描述的是上一台 / 上一次连接。
   */
  private layoutsByStrip: Array<LayoutReadback | null> = emptyLayoutCache();
  /** 逐场景的最近读回（QueryScene 是「三个场景只读当前那个」，§9.1 第 4 步）。 */
  private scenesById: Array<SceneReport | null> = emptySceneCache();
  /**
   * 「设备增强信息（引脚表 / 设备身份）已读完」的订阅者。
   *
   * 为什么需要：§9.1 的第 2、3 步由会话在进入 ready 后异步补，页面没法
   * 知道它什么时候完成（用固定延时猜是错的）。这是**只读通知**，不带载荷：
   * 页面收到后自己读 `stripConfigs` / `deviceInfo`。
   */
  private readonly deviceConfigListeners: Array<() => void> = [];
  private readonly retryAfterGapMs: number;
  /** 10008 间隔重试的计时器：与回连退避共用同一个注入实例。 */
  private readonly reconnectTimer: TimerApi;
  private readonly storage: SessionStorage;
  /** #34：成功连接时记一条使用日志（可选，绝不参与控制路径）。 */
  private readonly usageLogger: UsageLogSink | null;
  private readonly platform: "android" | "ios" | "other";

  /** 缓存的设备身份：回连与进前台静默回连都用它（设备是状态权威，不缓存状态）。 */
  private cached: CachedDevice | null = null;
  /**
   * 当前正在建立/已建立的连接身份（#34 日志用）。
   * `ready` 事件里拿不到 transport 的 deviceId，所以在发起 connect 时记下。
   */
  private activeDevice: CachedDevice | null = null;
  /**
   * #34：下一次 `ready` 是否要记一条使用日志。只有「发起一次连接」
   * （手动 / 自动回连，同一条 host.connect）才置位；ready 消费后清掉，
   * 保证一次连接会话一条记录。
   */
  private usageArmed = false;
  /**
   * #50：本次连接待入队的使用日志身份（`ready` 时快照）。
   *
   * 为什么不在 `ready` 里直接记：聚合键首选 `hw_id`，而它只有 `0x88` 才下发，
   * `ready` 那一刻还没有。先快照身份，等 `QueryDeviceInfo` 回来再入队；
   * 同时用 epoch 钉住快照，跨连接的结果一律作废。
   */
  private pendingUsage: {
    epoch: number;
    deviceId: string | null;
    deviceName: string | null;
  } | null = null;
  private readonly reconnect: ReconnectSupervisor;
  /** #33 设备切换状态机（主动切换，与上面的自动回连完全分开）。 */
  private switchState: SwitchState = initialSwitchState();
  /** 「最近连过」列表：按最后连接时间降序，上限由 device-history 决定。 */
  private recent: RecentDevice[];

  constructor(opts: SessionOptions) {
    const log = new FrameLog({ mirrorToConsole: opts.devMode });
    this.platform = opts.platform;
    this.usageLogger = opts.usageLogger ?? null;
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
    this.recent = loadRecentDevices(this.storage);

    this.reconnect = new ReconnectSupervisor(
      {
        linkState: () => this.transport.linkState,
        cached: () => this.cached,
        connect: (deviceId, name) => {
          // #34：自动回连也是「一次连接会话」，成功（ready）后同样记一条。
          this.armUsageLog(deviceId, name);
          return this.transport.connect(deviceId, name).catch((err: unknown) => {
            // 这次回连失败：撤掉置位，别让后面不相干的 ready 补记一条假会话。
            this.usageArmed = false;
            throw err;
          });
        },
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
        return this.transport.write(cmdSetBrightness(update.value)).then(
          () => undefined,
          (err) => {
            this.reconnect.handleCommandFailure(err);
          },
        );
      },
      opts.throttleTimer !== undefined ? { timer: opts.throttleTimer } : {},
    );

    // 内部监听必须早于页面注册，保证断线时先清本地状态再通知 UI。
    this.transport.onLink((state, detail) => {
      /* #50：会话结束（断线 / 适配器关闭 / 连接失败）时会话日志可能还没等到
       * 0x88 回来。这里先补记——按当时已知的身份（通常没有 hw_id），绝不能
       * 因为设备信息查询没完成就把一次成功会话漏掉。必须在 handleLinkChange
       * 之前：它会递增 epoch，之后这份快照就属于「上一次连接」了。 */
      if (state !== "ready") {
        this.flushPendingUsage();
      }
      this.reconnect.handleLinkChange(state, detail);
      /* #41：每次进入 ready（首次连接 / 自动回连 / 切换设备）都补一次
       * §9.1 的第 2、3 步。State 已由 transport.connect 的初始化流水线读过，
       * 这里不再重读，避免把「回连读一次 State」的既有约定改掉。
       *
       * #50：使用日志也挂在这次重建的末尾——`hw_id` 只有 0x88 才给，
       * 等它回来再记，日志与设备登记表才会用同一个聚合键。 */
      if (state === "ready") {
        this.captureUsageOnce();
        void this.rebuildDeviceConfig();
      }
    });

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
    /* #44：换了一台设备就先把上一台的一切清干净（State / 引脚表 / 身份 /
     * 逐带段缓存）。页面走 switchTo 时也会清，这里是兜底——任何直接
     * connect 新设备的路径都不能把旧设备的段列表带过去。 */
    if (this.cached !== null && this.cached.deviceId !== deviceId) {
      this.clearDeviceState();
    }
    // #34：记下本次连接身份并置位——ready 事件据此写使用日志（一次会话一条）。
    this.armUsageLog(deviceId, name);
    try {
      const state = await this.transport.connect(deviceId, name);
      this.latestState = state;
      // 「已连同一台设备」时 transport.connect 只重读 State、不发 ready：
      // 没有发生新的连接会话，撤掉置位，避免下一次 ready 补记一条假会话。
      this.usageArmed = false;
      // 只有完整初始化成功后才缓存 deviceId（失败的下次扫描更可靠）。
      this.cached = saveCachedDevice(this.storage, deviceId, name);
      /* #44：连接成功立刻记一条本地记录（列表要能马上刷新，不等网络）。
       * hardwareId 此时通常还没读到（它在 0x88 里），所以先用登记表里已知的
       * 那个；读到之后由 `attachHardwareId` 补上并合并，不会多出一条。 */
      this.recent = recordConnection(
        this.storage,
        deviceId,
        name,
        Date.now(),
        this.knownHardwareIdOf(deviceId) ?? undefined,
      );
      return state;
    } catch (err) {
      // 连接失败：撤掉日志置位，避免后面不相干的 ready 误记一条。
      this.usageArmed = false;
      /* 用户主动取消：不是错误。不做失败清理（transport 已经清干净），
       * 也不弹提示——页面状态条此时已经是「未连接 / 已取消连接」。 */
      if (err instanceof ConnectCancelledError) {
        throw err;
      }
      // 10002 / 10013：设备不在附近或 deviceId 失效（iOS UUID 会变），清缓存。
      if (err instanceof WxCallError && (err.errCode === 10002 || err.errCode === 10013)) {
        /* #44：知道 hardwareId 时按它删——旧 deviceId 已经失效，只有 hwId
         * 能定位到同一条记录（iOS 换 UUID 后 deviceId 不再匹配）。 */
        const hardwareId = this.knownHardwareIdOf(deviceId);
        this.clearCachedDevice();
        this.recent = forgetDevice(this.storage, deviceId, hardwareId ?? undefined);
      }
      throw err;
    } finally {
      this.reconnect.manualConnectEnd();
    }
  }

  /**
   * #33 切换到指定设备。
   *
   * 与 connect 的区别：这是**主动切换**，当前可能还连着别的设备。
   * 流程：先断开（单连接约束）→ 再连新的 → 成功后把这个设备的配置从设备读回来。
   *
   * 失败时**停在未连接 + 保留目标供重试**，不自动回滚到上一台：
   * 上一台此时可能也不可用，来回拨号会让用户不知道点哪个按钮
   * （见 device-switch.ts 顶部注释）。也绝不进 1s/2s/4s 的自动回连退避。
   */
  async switchTo(deviceId: string, name?: string): Promise<DeviceState> {
    if (isSwitching(this.switchState)) {
      throw new Error("正在切换设备，请稍候");
    }
    this.switchState = beginSwitch(this.switchState, deviceId, name, this.transport.linkState);

    if (this.switchState.phase === "disconnecting") {
      try {
        // 主动断开当前设备：取消节流与回连意图，避免旧连接的命令串到新连接上。
        this.throttle.cancel();
        await this.reconnect.disconnectIntent();
        /* #44：切换设备必须清空上一台的一切镜像——State、引脚表、hwId、
         * **逐带段缓存**。少了这一步，新设备（尤其灯带数更少的一台）会显示
         * 上一台残留的段，用户以为配置丢了。 */
        this.clearDeviceState();
      } catch (err) {
        // 断开报错也照样往下连：目标状态是「连上新设备」，
        // 卡在 disconnecting 只会让用户看不到任何进展。
        console.warn(`[lumen] 切换前断开失败：${errorText(err)}`);
        this.clearDeviceState();
      }
      this.switchState = switchedDisconnected(this.switchState);
    }

    try {
      const state = await this.connect(deviceId, name);
      this.switchState = switchedReady(this.switchState);
      /* 设备是权威：切换后所有设备级状态都来自新设备。
       * §9.1 的 QueryStripConfig / QueryDeviceInfo 已由 ready 钩子补过，
       * 这里只再确认一次 State（分段按需由页面 queryStrip 拉取）。 */
      await this.refreshState().catch(() => state);
      return state;
    } catch (err) {
      /* 用户取消：回到 idle 状态机，不记成「切换失败」——否则下次打开
       * 设备页还会看到一个要求重试的失败目标。 */
      if (err instanceof ConnectCancelledError) {
        this.switchState = abandonSwitch();
        throw err;
      }
      this.switchState = switchFailed(this.switchState, errorText(err));
      // 不清 cached：用户可能只是暂时连不上，重试入口还要用它。
      throw err;
    }
  }

  /**
   * 重试上一次失败的切换。
   * 没有失败目标时报错，由页面决定是否提示（通常不应该走到）。
   */
  async retrySwitch(): Promise<DeviceState> {
    const next = retrySwitch(this.switchState, this.transport.linkState);
    if (next === this.switchState || next.target === null) {
      throw new Error("没有可重试的切换目标");
    }
    const target = next.target;
    // 先回到 idle 再走完整流程，避免 isSwitching 守卫挡住自己。
    this.switchState = initialSwitchState();
    return this.switchTo(target.deviceId, target.name);
  }

  /** 放弃切换 / 页面卸载：清状态机，不再保留目标。 */
  cancelSwitch(): void {
    this.switchState = abandonSwitch();
  }

  /**
   * 用户点状态条上的「取消」：中止正在进行的连接尝试。
   *
   * 只对 `connecting` / `initializing` 有效。返回 `true` 表示确实取消了一次
   * 进行中的尝试——页面据此决定要不要给提示。
   *
   * 与 `cancelSwitch` 的分工：那个清的是「切换目标」状态机（连都没开始连的
   * 阶段），这个中断的是 transport 里正在跑的连接流水线。
   */
  cancelConnect(): boolean {
    const cancelled = this.transport.cancelConnect();
    if (cancelled) {
      /* 取消后这个设备没有变成「最近连过」的资格：撤掉 usage 置位，
       * 否则下一次不相干的 ready 会补记一条属于本次取消的假会话。 */
      this.usageArmed = false;
      this.cancelSwitch();
    }
    return cancelled;
  }

  get deviceSwitch(): SwitchState {
    return { ...this.switchState, target: this.switchState.target && { ...this.switchState.target } };
  }

  /** 「最近连过」列表（按最后连接时间降序，不依赖后端）。 */
  get recentDevices(): RecentDevice[] {
    return this.recent.map((entry) => ({ ...entry }));
  }

  /**
   * 从「最近连过」里移除一台（#44 的「删除设备」）。
   *
   * 只删本机记录：设备本身不受影响，重新扫描连上后会再记一条。知道
   * hardwareId 时一并按它删——iOS 换了 UUID 后 deviceId 已不匹配。
   */
  forgetRecent(deviceId: string, hardwareId?: string): void {
    this.recent = forgetDevice(this.storage, deviceId, hardwareId);
  }

  /**
   * §9.1 的「设备增强信息」重建：QueryStripConfig → QueryDeviceInfo。
   *
   * 为什么不在这里读 State：进入 ready 的那一刻 transport 的初始化流水线刚
   * 读过 State，再读一次既多余又会改掉既有测试里「一次回连只读一次 State」的
   * 约定。
   *
   * 两条查询都是界面增强信息：失败只让缓存保持为 null，绝不把一次成功的
   * 连接降级成失败（旧固件不支持 0x1C/0x1D 时页面上只是看不到 GPIO）。
   * `QueryStrip(i)` 不在这里做——它属于页面（按需、逐带），见 `queryStrip`。
   *
   * #50：使用日志在这条流水线的末尾写。`hw_id` 由 0x88 下发，ready 事件
   * 本身还拿不到它；等重建结束再记，一次会话仍然只记一条，只是入队晚了
   * 一次查询往返。两次查询失败也照样记（不带 hardwareId 的旧格式），
   * 界面增强信息拿不到不能连带丢日志。
   *
   * 这条流水线不认 epoch 就没法防住「旧连接的重建跑完时新连接已经 ready」，
   * 所以下面用 `isStale` 把跨连接的迟到结果整体丢掉（设备信息与日志一起丢）。
   */
  private async rebuildDeviceConfig(): Promise<void> {
    if (this.transport.linkState !== "ready") {
      return;
    }
    /* 上一次连接的重建可能拖到这里才回来：跨连接的设备信息不能写给新连接，
     * 也不该替新会话补一条日志。epoch 只在连接身份变化时递增。 */
    const epoch = this.reconnect.epoch;
    await this.queryStripConfig().catch(() => undefined);
    await this.queryDeviceInfo().catch(() => undefined);
    if (this.reconnect.isStale(epoch) || this.transport.linkState !== "ready") {
      return;
    }
    /* #44：hwId 是设备的稳定身份，读到后立刻补进本地两层存储
     * （登记表 + 最近连过），后续去重、删除、同步都按它走。失败不影响连接。 */
    this.attachHardwareId();
    /* #50：hw_id 已就位，此刻记的使用日志才能与设备登记表用同一个键。 */
    this.flushPendingUsage();
    /* 通知页面「设备增强信息已就绪」（GPIO / hwId）。失败也要通知：
     * 页面据此把「GPIO ?」收敛成「—」，不必自己猜什么时候该重画。 */
    this.notifyDeviceConfig();
  }

  /**
   * 把 `QueryDeviceInfo` 读到的 hwId 与缓存快照落到本地（#44）。
   *
   * 只在**当前连接**的设备上做：`deviceInfoCache` 属于这一次连接，断开就清，
   * 所以不存在「把上一台的 hwId 写给了新设备」的可能。
   *
   * 写入 `stripCount` / `firmwareVer` 的目的只有一个：设备页在**未连接**时
   * 能显示「上次」的条数与固件。它们不是当前配置，UI 必须标注来源。
   */
  private attachHardwareId(): void {
    const info = this.deviceInfoCache;
    const deviceId = this.transport.currentDeviceId;
    if (info === null || typeof deviceId !== "string" || deviceId.length === 0) {
      return;
    }
    if (info.hwId.length === 0) {
      return;
    }
    try {
      setHardwareId(this.storage, deviceId, info.hwId);
      /* 合并而非新增：这台设备可能已经有一条「只有 deviceId」的记录。 */
      this.recent = updateDeviceIdentity(this.storage, deviceId, {
        hardwareId: info.hwId,
        /* State 的 stripCount 是设备权威的条数（0x88 只给上限 maxStrips）。 */
        stripCount: this.latestState?.stripCount,
        firmwareVer: info.firmwareVersion,
      });
    } catch (err) {
      console.warn(`[lumen] 记录设备身份失败：${errorText(err)}`);
    }
  }

  /**
   * 某台设备已知的 hardwareId（登记表优先，最近连过的记录兜底）。
   *
   * 用途：连接成功的那一刻先按已知身份记一条；10002 时用它删掉失效记录。
   * 还不知道就返回 null——**绝不**拿 deviceId 冒充。
   */
  private knownHardwareIdOf(deviceId: string): string | null {
    try {
      const entry = loadRegistry(this.storage).devices.find((item) => item.deviceId === deviceId);
      if (entry?.hardwareId !== undefined && entry.hardwareId.length > 0) {
        return entry.hardwareId;
      }
    } catch {
      /* 存储损坏按「不知道」处理 */
    }
    const known = this.recent.find((item) => item.deviceId === deviceId);
    return known?.hardwareId ?? null;
  }

  /** 设备增强信息（引脚表 / 设备身份）读取结束的一次通知。 */
  private notifyDeviceConfig(): void {
    for (const fn of this.deviceConfigListeners.slice()) {
      try {
        fn();
      } catch (err) {
        console.warn(`[lumen] 设备配置监听失败：${errorText(err)}`);
      }
    }
  }

  async disconnect(): Promise<void> {
    // 主动断开：不触发自动回连，也不再让 onShow 擅自重连。
    await this.reconnect.disconnectIntent();
    /* 统一走 clearDeviceState：State / 选中段 / v3 的两份缓存一起清，
     * 避免「主动断开」与「被动断线」两条路径的清理范围不一致。 */
    this.clearDeviceState();
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
   * 输入校验（1-100、纯整数）在页面层用 parseLedCountInput 先做，这里再兜一次：
   * 非法值不发帧，直接返回错误，绝不「尽量发送」。
   */
  async setLedCount(count: number, stripId = this.activeStrip): Promise<CommandResult> {
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
      const ack = await this.sendCommand(cmdSetLedCount(stripId, count), {
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
      // 成功：设备已按新数量重建并持久化，本地只改该带的灯珠数。
      if (this.latestState !== null) {
        this.latestState = applyStripLedCount(this.latestState, stripId, count);
      }
      /* 数量变化会让设备裁掉越界的段（§6.1）：该带的布局缓存作废。 */
      this.layoutsByStrip[stripId] = null;
      return {
        kind: "ok",
        state: this.latestState ?? fallbackState(),
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
        state: this.latestState ?? fallbackState(0, 0),
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
        state: this.latestState ?? fallbackState(on ? 1 : 0),
      };
    } catch (err) {
      // 同上：异常照常提示，不用 stale 吞掉。
      return { kind: "error", message: errorText(err) };
    }
  }

  /* ---------------- v3 灯带维度 ---------------- */

  /**
   * 每条灯带的独立开关（SetStripPower 0x1B，§9.5）。
   *
   * 只改该带的掩码位，不动全局 `power`：实际是否出光 = 全局 power &&
   * strip_power_mask 对应位。成功后就地更新本地掩码（设备权威字段），
   * 不额外读 State——这是一条 O(1) 的绝对值命令。
   */
  async setStripPower(stripId: number, on: boolean): Promise<CommandResult> {
    if (!Number.isInteger(stripId) || stripId < 0 || stripId >= MAX_STRIPS) {
      return { kind: "error", message: `灯带号必须是 0-${MAX_STRIPS - 1} 的整数` };
    }
    if (this.transport.linkState !== "ready") {
      return { kind: "error", message: "设备未连接" };
    }
    const epoch = this.reconnect.epoch;
    try {
      const ack = await this.sendCommand(cmdSetStripPower(stripId, on));
      if (this.reconnect.isStale(epoch)) {
        return { kind: "stale" };
      }
      if (!ack.ok) {
        return { kind: "ack-error", ack };
      }
      if (this.latestState !== null) {
        this.latestState = applyStripPower(this.latestState, stripId, on);
      }
      return {
        kind: "ok",
        state: this.latestState ?? fallbackState(),
      };
    } catch (err) {
      return { kind: "error", message: errorText(err) };
    }
  }

  /**
   * 读设备的引脚分配（QueryStripConfig 0x1C → 0x87）。
   *
   * 只读：引脚表来自构建期 Kconfig，协议不允许改（§1）。结果缓存在
   * `stripConfigs`，失败时返回 error 但不清掉上一次的好值。
   */
  async queryStripConfig(): Promise<StripConfigResult> {
    if (this.transport.linkState !== "ready") {
      return { kind: "error", message: "设备未连接" };
    }
    const epoch = this.reconnect.epoch;
    try {
      const config = await this.transport.queryStripConfig();
      if (this.reconnect.isStale(epoch)) {
        return { kind: "stale" };
      }
      this.stripConfigCache = {
        channels: config.channels.map((channel) => ({ ...channel })),
      };
      return { kind: "ok", config: this.stripConfigCache };
    } catch (err) {
      return { kind: "error", message: errorText(err) };
    }
  }

  /**
   * 读设备身份与能力上限（QueryDeviceInfo 0x1D → 0x88）。
   *
   * `hwId` 是设备真身份（广播名不再是身份，§2）。结果缓存在 `deviceInfo`，
   * #44 的「连上后先用 hardwareId 登记」依赖这条路径。
   */
  async queryDeviceInfo(): Promise<DeviceInfoResult> {
    if (this.transport.linkState !== "ready") {
      return { kind: "error", message: "设备未连接" };
    }
    const epoch = this.reconnect.epoch;
    try {
      const info = await this.transport.queryDeviceInfo();
      if (this.reconnect.isStale(epoch)) {
        return { kind: "stale" };
      }
      this.deviceInfoCache = { ...info };
      return { kind: "ok", info: this.deviceInfoCache };
    } catch (err) {
      return { kind: "error", message: errorText(err) };
    }
  }

  /* ---------------- 布局族 0x20-0x24（§6.1 / §9.1 第 3 步） ---------------- */

  /**
   * 读一条链的部位划分（QueryLayout 0x24 → 逐条 0x89 + 一条 0x8A）。
   *
   * 结果缓存在 `layoutsByStrip`，失败时返回 error 但不清掉上一次的好值——
   * 「读不到」和「本地没有」是两件事，页面据此决定是灰掉还是显示空态。
   */
  async queryLayout(stripId: number): Promise<LayoutResult> {
    if (this.transport.linkState !== "ready") {
      return { kind: "error", message: "设备未连接" };
    }
    const epoch = this.reconnect.epoch;
    try {
      const { reports, end } = await this.transport.queryLayout(stripId);
      if (this.reconnect.isStale(epoch)) {
        return { kind: "stale" };
      }
      const layout: LayoutReadback = {
        stripId,
        parts: reports.map((report) => ({
          ...report,
          segs: report.segs.map(([start, end2]) => [start, end2] as [number, number]),
        })),
        partMask: end.partMask,
      };
      this.layoutsByStrip[stripId] = layout;
      return { kind: "ok", layout };
    } catch (err) {
      return { kind: "error", message: errorText(err), layout: this.layoutsByStrip[stripId] ?? undefined };
    }
  }

  /** 某链上一次读回的布局（没有则为 null）。 */
  layoutOf(stripId: number): LayoutReadback | null {
    const cached = this.layoutsByStrip[stripId];
    return cached === undefined || cached === null ? null : cached;
  }

  /**
   * 写一条链的布局并提交（LayoutWrite → LayoutPart/LayoutSeg → LayoutCommit）。
   *
   * 帧序固定（§6.1）：Begin 声明部位数 → 逐部位名字与段数 → 逐段区间 →
   * Commit。**一次一帧、串行**（§8：小程序一次只发一帧、等 ACK 再发下一帧）。
   *
   * 任何一帧被拒就立刻停：布局的中间态在设备侧只是 RAM，不 Commit 就不落盘
   * 也不生效（§6.1 第 4 条），所以「半套下发」不会留下持久化后果。
   */
  async writeLayout(stripId: number, parts: LayoutPart[]): Promise<EditResult> {
    if (this.transport.linkState !== "ready") {
      return { kind: "error", message: "设备未连接" };
    }
    const epoch = this.reconnect.epoch;
    try {
      const requests: CommandRequest[] = [cmdLayoutWrite(stripId, parts.length)];
      for (const part of parts) {
        requests.push(
          cmdLayoutPart(stripId, part.partId, part.name, part.segs.length),
        );
        part.segs.forEach(([start, end], segId) => {
          requests.push(cmdLayoutSeg(stripId, part.partId, segId, start, end));
        });
      }
      requests.push(cmdLayoutCommit());
      await this.transport.sendSequence(requests);
      if (this.reconnect.isStale(epoch)) {
        return { kind: "stale" };
      }
      /* 提交成功：设备侧的段可能被裁过，缓存作废让页面重新读。 */
      this.layoutsByStrip[stripId] = null;
      const state = await this.refreshState().catch(() => this.latestState);
      return { kind: "ok", state: state ?? this.latestState };
    } catch (err) {
      return this.editFailure(err, epoch);
    }
  }

  /* ---------------- 场景族 0x25-0x29（§6.2 / §9.1 第 4 步） ---------------- */

  /**
   * 读一个场景（QueryScene 0x29 → 部位头 + 每步 + 收尾）。
   *
   * §9.1 第 4 步只读**当前**场景；切换场景后再读目标场景。结果缓存在
   * `scenesById`。
   */
  async queryScene(sceneId: number): Promise<SceneResult> {
    if (this.transport.linkState !== "ready") {
      return { kind: "error", message: "设备未连接" };
    }
    const epoch = this.reconnect.epoch;
    try {
      const report = await this.transport.queryScene(sceneId);
      if (this.reconnect.isStale(epoch)) {
        return { kind: "stale" };
      }
      const scene = buildSceneReport(
        sceneId,
        report.end.name,
        report.parts.map((part) => ({ ...part })),
        report.steps.map((step) => ({ ...step })),
      );
      this.scenesById[sceneId] = scene;
      return { kind: "ok", scene };
    } catch (err) {
      return {
        kind: "error",
        message: errorText(err),
        scene: this.scenesById[sceneId] ?? undefined,
      };
    }
  }

  /** 某场景上一次读回的内容（没有则为 null）。 */
  sceneOf(sceneId: number): SceneReport | null {
    const cached = this.scenesById[sceneId];
    return cached === undefined || cached === null ? null : cached;
  }

  /**
   * 写一个部位的时间轴头（ScenePart 0x25）。
   *
   * **只有 step_count 真的变了设备才清空步骤**（§6.2），所以这条命令同时
   * 用来改开关与循环档——点一下部位开关不会抹掉整个时间轴（T9）。
   */
  async setScenePart(
    sceneId: number,
    stripId: number,
    partId: number,
    stepCount: number,
    loop: number,
    on: boolean,
  ): Promise<EditResult> {
    const result = await this.sendEditSafe(() =>
      cmdScenePart(sceneId, stripId, partId, stepCount, loop, on),
    );
    this.invalidateScene(sceneId, result);
    return result;
  }

  /** 写一步（SceneStep 0x26）：**单步增量**，不重传整场景（E5）。 */
  async setSceneStep(step: SceneStep): Promise<EditResult> {
    const result = await this.sendEditSafe(() => cmdSceneStep(step));
    this.invalidateScene(step.sceneId, result);
    return result;
  }

  /** 写场景名（SceneName 0x27）。 */
  async setSceneName(sceneId: number, name: string): Promise<EditResult> {
    const result = await this.sendEditSafe(() => cmdSceneName(sceneId, name));
    this.invalidateScene(sceneId, result);
    return result;
  }

  /**
   * 写成功后作废该场景的读回缓存。
   *
   * 为什么必须有：`sceneOf()` 是**页面的第一读取入口**（读到就直接用，读不到
   * 才发 `QueryScene`）。写入之后不作废的话，页面下一次 `load()` 会拿回**写入
   * 前**的那一份，表现是「点了下发、提示成功、界面却还是旧的」。`writeLayout`
   * 早有这一步（`layoutsByStrip[stripId] = null`），场景这三条以前漏了。
   *
   * 只在真的可能改了设备时作废：`ok`（RAM 与落盘都成功）与 `storage`
   * （RAM 已改、只是没落盘，§10.4）都要作废；`stale` / `error` / `ack-error`
   * 一律不动——它们代表「这次写入没生效」，缓存仍是权威。
   */
  private invalidateScene(sceneId: number, result: EditResult): void {
    if (result.kind !== "ok" && result.kind !== "storage") {
      return;
    }
    if (!Number.isInteger(sceneId) || sceneId < 0 || sceneId >= MAX_SCENES) {
      return;
    }
    this.scenesById[sceneId] = null;
  }

  /**
   * 激活场景（ActivateScene 0x28）：硬切 + 全部部位从第 1 步重跳（T3/C4）。
   *
   * 成功后读回 State（`activeScene` 变了），并清掉场景缓存——切场景会让
   * 播放头重置，页面该按新的 activeScene 重新读。
   */
  async activateScene(sceneId: number): Promise<EditResult> {
    const epoch = this.reconnect.epoch;
    try {
      const ack = await this.sendCommand(cmdActivateScene(sceneId));
      if (this.reconnect.isStale(epoch)) {
        return { kind: "stale" };
      }
      if (!ack.ok) {
        return this.storageOrAck(ack);
      }
      const state = await this.refreshState().catch(() => this.latestState);
      return { kind: "ok", state: state ?? this.latestState };
    } catch (err) {
      return this.editFailure(err, epoch);
    }
  }

  /**
   * 先构造请求再发：构造器抛的 `RangeError` 折成 `error` 结果。
   *
   * 为什么需要：`cmdScenePart` / `cmdSceneStep` / `cmdSceneName` 是**提前拒绝**
   * 的唯一机会（越界的 loop / 步数 / 名字字节数），它们抛 `RangeError`。若直接
   * 把构造结果传给 `sendEdit`，异常会在 `await` 之前就冒到调用方，页面拿到的是
   * 一个抛出而不是 `{ kind: "error" }` —— 与 `setLedCount` 等其它写入口不一致，
   * 页面里那句 `if (result.kind === ...)` 根本没机会执行。
   *
   * 这里仍然**不发帧**：异常发生在构造阶段，传输层没被碰过。
   */
  private async sendEditSafe(build: () => CommandRequest): Promise<EditResult> {
    let request: CommandRequest;
    try {
      request = build();
    } catch (err) {
      return { kind: "error", message: errorText(err) };
    }
    return this.sendEdit(request);
  }

  /** 布局 / 场景写命令的公共路径：一帧、等 ACK、StorageFailed 单独一支。 */
  private async sendEdit(request: CommandRequest): Promise<EditResult> {
    if (this.transport.linkState !== "ready") {
      return { kind: "error", message: "设备未连接" };
    }
    const epoch = this.reconnect.epoch;
    try {
      const ack = await this.sendCommand(request);
      if (this.reconnect.isStale(epoch)) {
        return { kind: "stale" };
      }
      if (!ack.ok) {
        return this.storageOrAck(ack);
      }
      return { kind: "ok", state: this.latestState };
    } catch (err) {
      return this.editFailure(err, epoch);
    }
  }

  /**
   * StorageFailed (0x06) 折叠成 `storage` 一支。
   *
   * 它和别的 ACK 错误的区别很重要：设备的 RAM 已经改了，只是没落盘
   * （场景超过 12 KB / NVS 写失败，§10.4 / §10.5）。页面要提示「已生效但
   * 未保存」而不是「没生效」。
   */
  private storageOrAck(ack: AckResult): EditResult {
    if (ack.resultCode === RESULT.STORAGE_FAILED) {
      return { kind: "storage", message: resultText(ack.resultCode) };
    }
    return { kind: "ack-error", ack };
  }

  private editFailure(err: unknown, epoch: number): EditResult {
    if (this.reconnect.isStale(epoch)) {
      return { kind: "stale" };
    }
    return { kind: "error", message: errorText(err) };
  }

  /** v3：当前操作的灯带（页面切换灯带后所有缺省 stripId 的方法都跟着走）。 */
  get activeStripId(): number {
    return this.activeStrip;
  }

  /**
   * 切到另一条灯带（#41 的灯带切换器入口）。
   *
   * 只改「缺省操作哪条带」；设备状态、段列表都是设备权威，页面切换后
   * 自己重新 `queryStrip` / 读 State 即可，这里不做隐式 I/O。
   */
  setActiveStripId(stripId: number): void {
    if (!Number.isInteger(stripId) || stripId < 0 || stripId >= MAX_STRIPS) {
      throw new RangeError(`灯带号必须是 0-${MAX_STRIPS - 1} 的整数，收到 ${stripId}`);
    }
    this.activeStrip = stripId;
  }

  /** 最近一次读到的引脚分配（未读 / 已断开为 null）。 */
  get stripConfigs(): StripConfig | null {
    const config = this.stripConfigCache;
    return config === null ? null : { channels: config.channels.map((c) => ({ ...c })) };
  }

  /** 最近一次读到的设备身份（未读 / 已断开为 null）。 */
  get deviceInfo(): DeviceInfo | null {
    const info = this.deviceInfoCache;
    return info === null ? null : { ...info };
  }

  /** 某条灯带的开关位（本地镜像；未连接按「关」）。 */
  stripPower(stripId: number): boolean {
    const state = this.latestState;
    if (state === null) {
      return false;
    }
    return (state.stripPowerMask & (1 << stripId)) !== 0;
  }

  /** 某条灯带的灯珠数（本地镜像；未连接为 0）。 */
  stripLedCount(stripId: number): number {
    return this.latestState?.stripLedCounts[stripId] ?? 0;
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

  /**
   * 设备增强信息（引脚表 / 设备身份）重建完成。
   *
   * 每次进入 ready 后都会触发一次（成功或失败都触发）；页面据此重画
   * GPIO / hwId，不要用固定延时去猜。
   */
  onDeviceConfig(fn: () => void): () => void {
    this.deviceConfigListeners.push(fn);
    return () => {
      const index = this.deviceConfigListeners.indexOf(fn);
      if (index >= 0) {
        this.deviceConfigListeners.splice(index, 1);
      }
    };
  }

  destroy(): void {
    /* #50：页面卸载时这一轮的日志可能还等在 0x88 上；销毁前补记，别丢会话。 */
    this.flushPendingUsage();
    this.reconnect.destroy();
    this.throttle.cancel();
    this.deviceConfigListeners.length = 0;
    this.transport.destroy();
  }

  // ------------------------------------------------------------------
  // 内部
  // ------------------------------------------------------------------

  /**
   * 清本地设备镜像与节流残留：断线后不保留旧状态显示。
   *
   * v3 新增的两份缓存（引脚表 / 设备身份）也必须一起清：它们描述的是
   * **上一台设备**，留着会让重连后的页面显示错误的 GPIO 与 hwId。
   */
  private clearDeviceState(): void {
    /* #50：断线时兜底——这一轮的日志若还没入队（0x88 没回来），先按已知身份
     * 补记，再清缓存（`deviceInfoCache` 一清就拿不到 hw_id 了）。
     * 正常路径在 onLink 里已经 flush 过，走到这里通常是空操作。 */
    this.flushPendingUsage();
    this.latestState = null;
    this.throttle.cancel();
    this.stripConfigCache = null;
    this.deviceInfoCache = null;
    /* 逐带布局与逐场景读回同样属于上一台 / 上一次连接，必须一起清：
     * 留着会让重连后的设备页显示不存在的部位。 */
    this.layoutsByStrip = emptyLayoutCache();
    this.scenesById = emptySceneCache();
  }

  /**
   * #34 / #50：一次成功的连接会话记一条使用日志。
   *
   * 三条纪律，全部体现在这里：
   *  1. **只记成功**：`usageArmed` 只在发起一次 connect 时置位（手动 / 自动回连
   *     走同一条 ready 事件），失败不置位、也不记录；
   *  2. **一次会话一条**：`ready` 时快照成 `pendingUsage`，入队后清空；
   *  3. **同步、吞异常、不 await**：日志落点是 fire-and-forget 的旁路，
   *     BLE 连接与控制绝不等待它，后端挂了也感知不到。
   *
   * #50：`hardwareId` 取本次连接读到的 `hw_id`（设备登记表的同一个主键）。
   * 读不到（旧固件 / 查询失败 / 断线太快）就不带这个字段——后端退化为按
   * 广播名聚合，与老客户端的上报体完全一致。
   */
  private flushPendingUsage(): void {
    const pending = this.pendingUsage;
    if (pending === null) {
      return;
    }
    /* 会话已换了一轮：这份快照属于上一次连接，但此刻 `deviceInfoCache` 描述的
     * 已经是新连接，带上它的 hw_id 就是张冠李戴。丢弃而不是补记——正常路径
     * 在 link 非 ready 时已经 flush 过，走到这里说明身份已不可靠。 */
    if (pending.epoch !== this.reconnect.epoch) {
      this.pendingUsage = null;
      return;
    }
    this.pendingUsage = null;

    const logger = this.usageLogger;
    if (logger === null) {
      return;
    }
    /* 优先用本次连接读回的 hw_id（`deviceInfoCache` 只属于本次连接，断开即清，
     * 不会是上一台的）。
     *
     * 读不到时**必须**退到已知身份：0x88 的 ACK 超时是 600ms，弱信号下很常见。
     * 若此时直接记成「无 hardwareId」，这条日志会落到 `name:LUMEN-XXXX`，
     * 与这台设备历史的所有 `hw:` 行分裂 —— 正是 #50 要消灭的症状，
     * 而且会随每次超时反复制造。
     *
     * 用 `knownHardwareIdOf(pending.deviceId)` 不会串号：deviceId 是本次会话的
     * 快照，断线/切换时已随 pendingUsage 一起钉住。 */
    const hardwareId =
      this.deviceInfoCache?.hwId ??
      (pending.deviceId === null ? null : this.knownHardwareIdOf(pending.deviceId));
    try {
      logger.recordConnection({
        ...(hardwareId !== null && hardwareId.length > 0 ? { hardwareId } : {}),
        deviceName: pending.deviceName,
        deviceId: pending.deviceId,
        platform: this.platform,
      });
    } catch {
      // 日志是旁路：任何异常都不能冒泡到连接状态机。
    }
  }

  /**
   * #50：`ready` 时快照这次会话的身份（一次会话最多一份）。
   *
   * 不在这里直接入队：聚合键首选 `hw_id`，而它只有 `0x88` 才下发；
   * 入队推迟到 `rebuildDeviceConfig` 末尾（或断线清理时兜底）。
   */
  private captureUsageOnce(): void {
    if (!this.usageArmed) {
      return;
    }
    this.usageArmed = false;

    const device = this.activeDevice;
    this.pendingUsage = {
      epoch: this.reconnect.epoch,
      deviceId: device?.deviceId ?? this.transport.currentDeviceId ?? null,
      deviceName: device?.name ?? null,
    };
  }

  /** 发起一次连接：记下身份并置位「下一个 ready 要记一条使用日志」。 */
  private armUsageLog(deviceId: string, name?: string): void {
    this.activeDevice = {
      deviceId,
      ...(name !== undefined && name.length > 0 ? { name } : {}),
    };
    this.usageArmed = true;
  }

  private clearCachedDevice(): void {
    this.cached = null;
    clearCachedDevice(this.storage);
  }
}
