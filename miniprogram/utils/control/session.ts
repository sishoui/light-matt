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
  type BleTransportOptions,
  type LinkDetail,
  type SendOptions,
} from "../ble/transport";
import { AckRejectedError, errorText, resultText, triage } from "../ble/errors";
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
import { MAX_LEDS, MAX_SCRIPTS, MAX_STRIPS, MIN_LEDS, RESULT } from "../protocol/constants";
import type { UsageLogSink } from "../usage/logger";
import {
  breathingSegment,
  cmdActivateScript,
  cmdClearSegment,
  cmdQueryState,
  cmdScriptAbort,
  cmdSelfTest,
  cmdSetBrightness,
  cmdSetLedCount,
  cmdSetPlayback,
  cmdSetPower,
  cmdSetSegment,
  cmdSetStripPower,
  cometSegment,
  rainbowSegment,
  type ScriptSummary,
} from "../protocol/commands";
import { specFromReport, toFlat } from "../protocol/segment-shapes";
import { rgbToHsv } from "../color/hsv";
import {
  buildAbort,
  buildScriptPlan,
  checkScriptCapacity,
  scriptProgressView,
  validateScript,
  type ScriptCapacityCheck,
  type ScriptConfig,
  type ScriptPlanOptions,
  type ScriptProgressView,
  type ScriptValidation,
} from "./script-plan";
import type {
  AckResult,
  CommandRequest,
  DeviceInfo,
  DeviceState,
  DiscoveredDevice,
  LinkState,
  RGB,
  SegmentConfig,
  SegmentListEnd,
  SegmentReport,
  SegmentSpec,
  SegmentTarget,
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
 * 连续量通道（20Hz latest-wins）。**亮度与段颜色共用同一个闸门**：
 * 两条各自 20Hz 会叠成 40Hz，BLE 写入串行化会被拖慢（docs/ble-notes.md）。
 * 两帧都是绝对值命令，互相覆盖的语义安全——最后一帧决定最终观感。
 */
export type ContinuousUpdate =
  | { kind: "brightness"; value: number }
  | { kind: "color"; target: SegmentTarget; hue: number; sat: number };

/**
 * 「改色」用的已读回段 spec（#48）。
 *
 * 为什么需要：段是**两层 + blend** 的线上形状，只改颜色的局部修改必须基于
 * 设备读回的完整 `SegmentSpec`。拿不到就报错，**绝不用扁平默认 spec 覆盖**。
 */
type SpecResolve =
  | { kind: "ok"; spec: SegmentSpec }
  | { kind: "error"; message: string };

/**
 * 段命令的专用结果。段配置不在 State 里，所以成功时不返回 DeviceState，
 * 而是返回设备权威的段列表（由 QueryStrip 读回）。
 */
export type SegmentResult =
  | { kind: "ok"; reports: SegmentReport[]; end: SegmentListEnd }
  | { kind: "ack-error"; ack: AckResult }
  | { kind: "stale" }
  | { kind: "error"; message: string };

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

/** SetPlayback 的 action（docs/protocol-v3.md §9.6）。 */
export type PlaybackAction = 0 | 1 | 2;

/**
 * 剧本命令的结果（#32 / #45）。
 *
 * 与 CommandResult 的区别：多了 `invalid`（本端预检就没过，一帧都没发）、
 * `too-large`（设备回 ScriptTooLarge；配置未变，文案已含「未保存」），
 * 以及成功时不强求 DeviceState（读回失败也不该让下发看起来失败）。
 */
export type ScriptResult =
  | { kind: "ok"; plan?: unknown; state?: DeviceState | null }
  | { kind: "invalid"; message: string }
  | { kind: "too-large"; message: string }
  | { kind: "ack-error"; ack: AckResult }
  | { kind: "stale" }
  | { kind: "error"; message: string };

/** QueryScript 的结果（ScriptSummary 是设备权威）。 */
export type ScriptSummaryResult =
  | { kind: "ok"; summary: ScriptSummary }
  | { kind: "stale" }
  | { kind: "error"; message: string };

/**
 * 4 个剧本槽位的摘要读回结果。
 *
 * 失败时仍带上已读到的部分（`summaries` 的前缀）：页面可以只灰掉读不到的
 * 那几张卡片，而不是整块清空。
 */
export type ScriptSummariesResult =
  | { kind: "ok"; summaries: ScriptSummary[] }
  | { kind: "stale" }
  | { kind: "error"; message: string; summaries: ScriptSummary[] };

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
 * 同时维护派生字段 `ledCount`（= strip 0 的值），这样 #41 之前的页面继续读
 * `state.ledCount` 时看到的仍是设备真实值。
 */
function applyStripLedCount(state: DeviceState, stripId: number, count: number): DeviceState {
  const stripCounts = state.stripCounts.slice();
  stripCounts[stripId] = count;
  return {
    ...state,
    stripCounts,
    ...(stripId === 0 ? { ledCount: count } : {}),
  };
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

/**
 * 改色的纯函数核心（#48）：拿已读回的完整 spec，**只换 layer0 的 hue / sat**。
 *
 * 明确保留：layer0 的 type / periodMs / p5 / flags、layer1 的整个对象、
 * blend 字节。这正是本票要锁住的不变量——把「彩虹 × 呼吸（相乘）」改成任意
 * 颜色后，第二层与混合模式必须字节级不变。
 *
 * 层对象一律返回新副本：spec 会被反复读写，共享引用会引入别名 bug。
 */
function recolorLayer0(spec: SegmentSpec, hue: number, sat: number): SegmentSpec {
  return {
    ...spec,
    layer0: { ...spec.layer0, hue, sat },
    layer1: { ...spec.layer1 },
  };
}

const defaultTimer: TimerApi = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle),
};

/** 8 个空段列表（逐带缓存初值，与 MAX_STRIPS 对齐）。 */
function emptyStripCache(): SegmentReport[][] {
  return Array.from({ length: MAX_STRIPS }, () => []);
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
  /** 颜色控件的当前目标段（页面在选中/新建段时设置）。 */
  private defaultSegment: SegmentTarget | null = null;
  /** v3：当前操作哪条灯带（#41 的灯带切换器会调 `setActiveStripId`）。 */
  private activeStrip = DEFAULT_ACTIVE_STRIP_ID;
  /** v3：最近一次 QueryStripConfig 的结果（§9.1 第 2 步）。 */
  private stripConfigCache: StripConfig | null = null;
  /** v3：最近一次 QueryDeviceInfo 的结果（§9.1 第 3 步）。 */
  private deviceInfoCache: DeviceInfo | null = null;
  /**
   * v3：逐带段列表缓存（§9.1 第 4 步，`QueryStrip(i)` 按需）。
   *
   * 下标 = stripId，元素是该带上一次读回的 SegmentReport。功能上只做「同一
   * 条带重复读不必等」的加速——**每次切带仍以设备为准**，页面要最新值就调
   * `queryStrip`。断线必须整体清空：它描述的是上一台 / 上一次连接。
   */
  private segmentsByStrip: SegmentReport[][] = emptyStripCache();
  /**
   * 「设备增强信息（引脚表 / 设备身份）已读完」的订阅者。
   *
   * 为什么需要：§9.1 的第 2、3 步由会话在进入 ready 后异步补，页面没法
   * 知道它什么时候完成（用固定延时猜是错的）。这是**只读通知**，不带载荷：
   * 页面收到后自己读 `stripConfigs` / `deviceInfo`。
   */
  private readonly deviceConfigListeners: Array<() => void> = [];
  /**
   * 「改色读回失败」的提示订阅者（#48）。
   *
   * 节流通道是 fire-and-forget，没有可 await 的结果，页面只能靠这条通知弹出
   * 「读不回段配置，未下发」——绝不让一次失败的改色看起来像成功。
   */
  private readonly segmentHintListeners: Array<(message: string) => void> = [];
  /** 上一次已提示的段提示文案（同一句不重复刷屏）。 */
  private lastSegmentHint: string | null = null;

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
        if (update.kind === "brightness") {
          return this.transport.write(cmdSetBrightness(update.value)).then(
            () => undefined,
            (err) => {
              this.reconnect.handleCommandFailure(err);
            },
          );
        }
        /* #48：颜色帧也必须走「读回的完整 spec + 只改 layer0 色相/饱和度」，
         * 否则连续拖动会把两层的段降级成单层。 */
        return this.writeRecoloredFrame(update.target, update.hue, update.sat);
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
   * 输入校验（1-64、纯整数）在页面层用 parseLedCountInput 先做，这里再兜一次：
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
      /* 数量变化可能让设备裁掉越界的段（§9.2）：该带缓存作废。 */
      if (this.segmentsByStrip[stripId] !== undefined) {
        this.segmentsByStrip[stripId] = [];
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

  /* ---------------- #32 剧本 ---------------- */

  /**
   * 下发一套剧本并（默认）激活它。
   *
   * 帧序由 script-plan 的纯函数决定（Begin → Stage/Segment… → Commit →
   * Activate）。这里只负责逐帧发送与失败处理：
   *
   *  - 容量预检在**发第一帧之前**（§10.4）：预估持久化字节超过 16KB 直接
   *    返回 `invalid`，一帧都不发——绝不等设备报到 Commit 才回 0x0A；
   *  - 任何一帧 ACK 非零 → 立即 ScriptAbort 丢弃设备暂存，**旧剧本保持可用**
   *    （设备侧 commit 才替换，这是协议保证的，也是本函数的前提）；
   *  - `ScriptTooLarge (0x0A)`（预检漏了的合并超限）折成 `too-large`，
   *    文案明确「设备配置未改变」，不让用户以为半套生效了；
   *  - 传输异常 → 同样尝试 Abort（尽力而为，链路已断时它会失败，无所谓：
   *    设备上没 commit 的暂存不会被激活）。
   *
   * `onProgress` 以**每帧 ACK** 为权威（§10.4）；设备侧的 0x86 只是旁证，
   * 由 transport 的 onScriptProgress 单独广播，不参与这里的计数。
   */
  async downloadScript(
    script: ScriptConfig,
    opts: ScriptPlanOptions = {},
    onProgress?: (view: ScriptProgressView) => void,
  ): Promise<ScriptResult> {
    if (this.transport.linkState !== "ready") {
      return { kind: "error", message: "设备未连接" };
    }

    const validation = this.validateScriptForDevice(script);
    if (!validation.ok) {
      return { kind: "invalid", message: validation.message };
    }

    /* 容量预检：按与固件 encode 相同的公式预估，超限直接拒发（§10.4）。 */
    const capacity = checkScriptCapacity([script]);
    if (!capacity.ok) {
      return { kind: "invalid", message: capacity.message };
    }

    const plan = buildScriptPlan(script, opts);
    const requests = plan.steps.map((step) => step.request);
    const epoch = this.reconnect.epoch;
    onProgress?.(scriptProgressView(plan, 0));

    try {
      await this.transport.sendSequence(requests, (done) => {
        onProgress?.(scriptProgressView(plan, done));
      });
    } catch (err) {
      /* 尽力丢弃暂存：绝不让设备停在半套状态（它本来也不会，但暂存会占着）。 */
      try {
        await this.transport.sendAndWaitAck(buildAbort(script.scriptId));
      } catch {
        /* 链路已断：暂存不 commit 就不会生效，可以忽略。 */
      }
      if (this.reconnect.isStale(epoch)) {
        return { kind: "stale" };
      }
      /*
       * 设备明确拒绝：0x0A 是「编码后装不下」，必须单独说清楚——预检是按
       * 单套算的，4 个槽位共享 16KB，合并超限只有设备知道。
       */
      if (err instanceof AckRejectedError) {
        if (err.resultCode === RESULT.SCRIPT_TOO_LARGE) {
          return { kind: "too-large", message: resultText(err.resultCode) };
        }
        return { kind: "error", message: errorText(err) };
      }
      return { kind: "error", message: errorText(err) };
    }

    if (this.reconnect.isStale(epoch)) {
      return { kind: "stale" };
    }
    onProgress?.(scriptProgressView(plan, plan.frameCount));
    /* 激活成功：把设备权威的 State 读回来（script_id / flags 已经变了）。 */
    const state = await this.refreshState().catch(() => this.latestState);
    return { kind: "ok", plan, state: state ?? this.latestState };
  }

  /** 用设备侧灯珠数校验剧本（本端预检，让用户在发第一帧前就看到原因）。 */
  validateScriptForDevice(script: ScriptConfig): ScriptValidation {
    const ledCounts = this.currentLedCounts();
    return validateScript(script, ledCounts);
  }

  /**
   * 本端的剧本容量预检（§10.4）。
   *
   * 只看**这一套**：设备上其它槽位的内容读不回来（QueryScript 只给摘要），
   * 所以「4 套合计超限」只能在 Commit 时由设备发现，走 0x0A 文案。
   */
  scriptCapacityForDevice(script: ScriptConfig): ScriptCapacityCheck {
    return checkScriptCapacity([script]);
  }

  /**
   * 各条灯带的灯珠数（设备权威）。
   *
   * v3 的 State 逐带给出 `strip_counts[8]`，所以这里直接切前 strip_count 条，
   * 不再像 v2 那样「其余条沿用 strip 0」。未连接时返回空数组：
   * validateScript 对 `ledCount === 0` 会跳过上界检查（避免未连接时误拒）。
   */
  currentLedCounts(): number[] {
    const state = this.latestState;
    if (state === null) {
      return [];
    }
    const strips = Math.max(1, Math.min(state.stripCount, MAX_STRIPS));
    return state.stripCounts.slice(0, strips);
  }

  /**
   * 播放控制（SetPlayback 0x13）。
   *
   *  - stop：播放头回 stage 0，画面回静态配置；
   *  - play：从**当前播放头**继续（暂停后即继续，不从头）；
   *  - pause：冻结播放头与画面。
   *
   * `loop` 三种 action 下都会写入（设备侧持久化，§10.5）。
   */
  async setPlayback(action: PlaybackAction, loop: boolean): Promise<ScriptResult> {
    const epoch = this.reconnect.epoch;
    try {
      const ack = await this.sendCommand(cmdSetPlayback(action, loop));
      if (this.reconnect.isStale(epoch)) {
        return { kind: "stale" };
      }
      if (!ack.ok) {
        return { kind: "ack-error", ack };
      }
      /* 播放状态在 State 字节 12，读回来让 UI 以设备为准。 */
      const state = await this.refreshState().catch(() => this.latestState);
      return { kind: "ok", state: state ?? this.latestState };
    } catch (err) {
      return { kind: "error", message: errorText(err) };
    }
  }

  /** 切换到另一套已提交剧本（ActivateScript 0x19）；不自动播放。 */
  async activateScript(scriptId: number, loop: boolean): Promise<ScriptResult> {
    const epoch = this.reconnect.epoch;
    try {
      const ack = await this.sendCommand(cmdActivateScript(scriptId, loop));
      if (this.reconnect.isStale(epoch)) {
        return { kind: "stale" };
      }
      if (!ack.ok) {
        return { kind: "ack-error", ack };
      }
      const state = await this.refreshState().catch(() => this.latestState);
      return { kind: "ok", state: state ?? this.latestState };
    } catch (err) {
      return { kind: "error", message: errorText(err) };
    }
  }

  /** 丢弃设备侧的暂存（ScriptAbort 0x18）。 */
  async abortScript(scriptId: number): Promise<ScriptResult> {
    return this.sendScriptOnly(cmdScriptAbort(scriptId));
  }

  /**
   * 查一套剧本的摘要（QueryScript 0x1A → ScriptSummary 0x85）。
   * 重连重建 UI 的权威路径第 3 步（§10.1）。
   *
   * **只回摘要**：v3 没有「读回整份剧本」的命令，所以 stage_count / flags /
   * active 之外拿不到任何内容（§10.4 的取舍）。页面必须把这个限制说清楚。
   */
  async queryScript(scriptId: number): Promise<ScriptSummaryResult> {
    if (this.transport.linkState !== "ready") {
      return { kind: "error", message: "设备未连接" };
    }
    const epoch = this.reconnect.epoch;
    try {
      const summary = await this.transport.queryScript(scriptId);
      if (this.reconnect.isStale(epoch)) {
        return { kind: "stale" };
      }
      return { kind: "ok", summary };
    } catch (err) {
      if (this.reconnect.isStale(epoch)) {
        return { kind: "stale" };
      }
      return { kind: "error", message: errorText(err) };
    }
  }

  /**
   * 依次读回 4 个剧本槽位的摘要（连上 / 回到页面时刷新「设备上有什么」）。
   *
   * 一条失败不中断：把失败原因单独返回，页面仍能展示读到的那些槽位——
   * 「部分读回」比「整块空白」有用，也不会把已确认的信息丢掉。
   */
  async queryScriptSummaries(): Promise<ScriptSummariesResult> {
    if (this.transport.linkState !== "ready") {
      return { kind: "error", message: "设备未连接", summaries: [] };
    }
    const summaries: ScriptSummary[] = [];
    for (let scriptId = 0; scriptId < MAX_SCRIPTS; scriptId += 1) {
      const result = await this.queryScript(scriptId);
      if (result.kind === "ok") {
        summaries.push(result.summary);
      } else if (result.kind === "stale") {
        return { kind: "stale" };
      } else {
        return { kind: "error", message: result.message, summaries };
      }
    }
    return { kind: "ok", summaries };
  }

  /** 只有 ACK 没有后续帧的剧本命令的公共路径。 */
  private async sendScriptOnly(request: CommandRequest): Promise<ScriptResult> {
    const epoch = this.reconnect.epoch;
    try {
      const ack = await this.sendCommand(request);
      if (this.reconnect.isStale(epoch)) {
        return { kind: "stale" };
      }
      if (!ack.ok) {
        return { kind: "ack-error", ack };
      }
      return { kind: "ok" };
    } catch (err) {
      return { kind: "error", message: errorText(err) };
    }
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
  async setSegment(
    segment: SegmentSpec | SegmentConfig,
    opts: SendOptions = {},
  ): Promise<AckResult> {
    const ack = await this.sendCommand(cmdSetSegment(segment), opts);
    if (ack.ok) {
      /* 写成功后缓存不再代表设备：清掉该带，逼页面重新 queryStrip。 */
      const stripId = segment.stripId;
      if (this.segmentsByStrip[stripId] !== undefined) {
        this.segmentsByStrip[stripId] = [];
      }
    }
    return ack;
  }

  /**
   * 清一个段槽位（ClearSegment 0x11）。
   *
   * `stripId` 必填：段属于哪条带只有调用方（页面）知道。给缺省值等于把
   * 第 3 条带上的删除偷偷写回第 0 条带——这是 #41 要消灭的缺陷。
   */
  async clearSegment(stripId: number, segId: number): Promise<AckResult> {
    const ack = await this.sendCommand(cmdClearSegment(stripId, segId));
    if (ack.ok) {
      /* 清掉该带缓存里的这一格：读回值不再代表设备，宁可让页面重新 queryStrip。 */
      if (this.segmentsByStrip[stripId] !== undefined) {
        this.segmentsByStrip[stripId] = this.segmentsByStrip[stripId].filter(
          (report) => report.segId !== segId,
        );
      }
    }
    return ack;
  }

  /**
   * 读回某灯带的段列表（QueryStrip 0x12）：seg_count 条 SegmentReport +
   * SegmentListEnd，同 seq 多帧。这是重连重建 UI 的权威路径
   * （protocol-v3 §9.1 第 4 步）。
   *
   * `stripId` 必填：读哪条带是页面的决定，不是会话的缺省。
   */
  async queryStrip(stripId: number): Promise<SegmentResult> {
    if (this.transport.linkState !== "ready") {
      return { kind: "error", message: "设备未连接" };
    }
    const epoch = this.reconnect.epoch;
    try {
      const result = await this.transport.queryStrip(stripId);
      if (this.reconnect.isStale(epoch)) {
        return { kind: "stale" };
      }
      this.segmentsByStrip[stripId] = result.reports.map((report) => ({ ...report }));
      return { kind: "ok", reports: result.reports, end: result.end };
    } catch (err) {
      if (this.reconnect.isStale(epoch)) {
        return { kind: "stale" };
      }
      return { kind: "error", message: errorText(err) };
    }
  }

  /**
   * 某条灯带最近一次读回的段列表（设备权威的本地镜像）。
   *
   * 只反映「上一次 queryStrip 的结果」，不能当成实时状态：段配置不在 State
   * 里，设备不会主动上报，页面在写操作后要自己再读。
   */
  segmentsOf(stripId: number): SegmentReport[] {
    const cached = this.segmentsByStrip[stripId];
    return cached === undefined ? [] : cached.map((report) => ({ ...report }));
  }

  /**
   * 把选中段改成 rgb 并等 ACK——页面与预设共用的一条路径。
   * 返回 ACK 结果（InvalidParam 表示设备拒绝了区间或与其它段重叠）。
   *
   * #48：**基于已读回的完整 spec 做局部修改**，只换 layer0 的 hue/sat；
   * layer1 与 blend 原样保留（见 `recolorLayer0`）。
   */
  async setSegmentColor(target: SegmentTarget, rgb: RGB): Promise<SegmentResult> {
    // 色环给的是 RGB；协议的静态参数是 hue+sat。用 HSV 反推（V 恒为 1）。
    const [hue, sat] = this.segmentHueSat(rgb);
    const resolved = await this.resolveSpec(target);
    if (resolved.kind !== "ok") {
      return { kind: "error", message: resolved.message };
    }
    return this.sendSegmentAwaitingAck(target, recolorLayer0(resolved.spec, hue, sat), {});
  }

  /**
   * 把一个段改成呼吸灯效（#30）：SetSegment type=0x01 + 等 ACK。
   *
   * 呼吸参数是**绝对值**（不像色环那样节流）：周期 / 最暗亮度 / 波形都是
   * 用户松手才提交的离散选择，走 sendCommand 等 ACK。设备拒绝时返回
   * ack-error，页面据此提示原因（周期过短 / 保留位 / 区间冲突）。
   *
   * `rgb` 决定 hue+sat（呼吸的基准色）；`periodMs` / `minLevel` / `waveform`
   * 是呼吸专属参数。periodMs = 0 表示「静止」。
   */
  async setSegmentBreathing(
    target: SegmentTarget,
    rgb: RGB,
    periodMs: number,
    minLevel: number,
    waveform: number,
    opts: SendOptions = {},
  ): Promise<SegmentResult> {
    const [hue, sat] = this.segmentHueSat(rgb);
    return this.sendSegmentAwaitingAck(
      target,
      breathingSegment(
        target.stripId,
        target.segId,
        target.start,
        target.end,
        hue,
        sat,
        periodMs,
        minLevel,
        waveform,
      ),
      opts,
    );
  }

  /**
   * 把一个段改成彩虹灯效（#31）：SetSegment type=0x02 + 等 ACK。
   *
   * `span` 是沿灯带的色相跨度（0 = 整条同色、255 = 铺满整圈）；
   * `reverse` 让色相沿灯带递减。周期下限是 200ms（5Hz），比呼吸宽松。
   */
  async setSegmentRainbow(
    target: SegmentTarget,
    rgb: RGB,
    periodMs: number,
    span: number,
    reverse = false,
    opts: SendOptions = {},
  ): Promise<SegmentResult> {
    const [hue, sat] = this.segmentHueSat(rgb);
    return this.sendSegmentAwaitingAck(
      target,
      rainbowSegment(
        target.stripId,
        target.segId,
        target.start,
        target.end,
        hue,
        sat,
        periodMs,
        span,
        reverse,
      ),
      opts,
    );
  }

  /**
   * 把一个段改成流光灯效（#31）：SetSegment type=0x03 + 等 ACK。
   *
   * `tail` 是拖尾长度（0 = 硬边亮点、255 = 整条都是尾）；
   * `reverse` 让亮点反向移动。
   */
  async setSegmentComet(
    target: SegmentTarget,
    rgb: RGB,
    periodMs: number,
    tail: number,
    reverse = false,
    opts: SendOptions = {},
  ): Promise<SegmentResult> {
    const [hue, sat] = this.segmentHueSat(rgb);
    return this.sendSegmentAwaitingAck(
      target,
      cometSegment(
        target.stripId,
        target.segId,
        target.start,
        target.end,
        hue,
        sat,
        periodMs,
        tail,
        reverse,
      ),
      opts,
    );
  }

  /** 用户空间 RGB → 协议的 (hue 0-65535, sat 0-255)（四种灯效共用前缀）。 */
  private segmentHueSat(rgb: RGB): [number, number] {
    const hsv = rgbToHsv(rgb);
    return [
      Math.round((hsv.h / 360) * 0x10000) & 0xffff,
      Math.round(hsv.s * 255),
    ];
  }

  /**
   * 动画类段的统一下发路径（#30/#31）：SetSegment + 等 ACK。
   *
   * 三类的差异只在装配好的 SegmentConfig，传输与结果分诊完全一致——
   * 抽出来避免三份几乎相同的 reconnect.isStale / ack-error 分支漂移。
   */
  private async sendSegmentAwaitingAck(
    target: SegmentTarget,
    segment: SegmentSpec | SegmentConfig,
    opts: SendOptions,
  ): Promise<SegmentResult> {
    if (this.transport.linkState !== "ready") {
      return { kind: "error", message: "设备未连接" };
    }
    const epoch = this.reconnect.epoch;
    try {
      const ack = await this.setSegment(segment, opts);
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

  /* ---------------- #48 改色的「读-改-写」 ---------------- */

  /**
   * 订阅「读回失败 / 目标段不存在」的提示（#48）。
   *
   * 为什么要有这条通道：节流通道（`queueColor` / `commitColor`）是 fire-and-forget
   * 的连续量路径，没有 await 的结果可返回。读不回完整 spec 时既不能下发，也不能
   * 静默吞掉——页面据此弹一次提示，避免用户以为改色生效了。
   */
  onSegmentHint(fn: (message: string) => void): () => void {
    this.segmentHintListeners.push(fn);
    return () => {
      const index = this.segmentHintListeners.indexOf(fn);
      if (index >= 0) {
        this.segmentHintListeners.splice(index, 1);
      }
    };
  }

  /**
   * 取目标段**设备权威的完整两层 spec**（#48 的读-改-写前置）。
   *
   * 顺序：本地已读回的段列表 → 没有就地 `QueryStrip` 一次。
   * 读不回来或设备上没有这个槽位都返回 error（调用方**不下发**）——
   * 这正是本票要消灭的「用默认值覆盖」。
   */
  private async resolveSpec(target: SegmentTarget): Promise<SpecResolve> {
    const cached = this.findCachedReport(target);
    if (cached !== null) {
      return { kind: "ok", spec: specFromReport(cached) };
    }
    if (this.transport.linkState !== "ready") {
      return { kind: "error", message: "设备未连接" };
    }
    const result = await this.queryStrip(target.stripId);
    if (result.kind === "stale") {
      return { kind: "error", message: "连接已变化，请重试" };
    }
    if (result.kind !== "ok") {
      /* ACK 拒绝（设备侧 InvalidParam）与传输异常都归成「读不回来」。 */
      const message =
        result.kind === "error"
          ? result.message
          : resultText(result.ack.resultCode);
      return { kind: "error", message: `读取段配置失败：${message}` };
    }
    const fresh = this.findCachedReport(target);
    if (fresh === null) {
      return {
        kind: "error",
        message: `设备上没有段 ${target.segId}（请先刷新段列表）`,
      };
    }
    return { kind: "ok", spec: specFromReport(fresh) };
  }

  /**
   * 在本地已读回的段列表里找目标段。
   *
   * **要求区间也一致**：同 segId 但区间不同的缓存说明设备上这个槽位早已重配，
   * 拿它去改色会写回一个用户没选中的区间——宁可当作「没有」再读一次。
   */
  private findCachedReport(target: SegmentTarget): SegmentReport | null {
    const cached = this.segmentsByStrip[target.stripId];
    if (cached === undefined) {
      return null;
    }
    const found = cached.find((report) => report.segId === target.segId);
    if (found === undefined) {
      return null;
    }
    if (found.start !== target.start || found.end !== target.end) {
      return null;
    }
    return found;
  }

  /**
   * 节流通道的颜色帧（#48）：读回完整 spec → 只换 layer0 色相/饱和度 → 裸写。
   *
   * 裸写（`transport.write`）而不是 `setSegment`：连续量不等 ACK，也不清段缓存
   * （见 `setSegment` 成功后清缓存的行为）；缓存由 `cacheRecolored` 就地更新。
   *
   * 已缓存时**同步**取 spec：拖动是 20Hz 连续量，多一层 `await` 会让写时刻
   * 落后于节流窗口，把稳定的 50ms 间隔抖成 40/60ms。只有首次（需要 QueryStrip）
   * 才走异步分支。
   */
  private async writeRecoloredFrame(
    target: SegmentTarget,
    hue: number,
    sat: number,
  ): Promise<void> {
    const cached = this.findCachedReport(target);
    const spec = cached === null ? null : specFromReport(cached);
    if (spec !== null) {
      try {
        await this.transport.write(cmdSetSegment(recolorLayer0(spec, hue, sat)));
        this.cacheRecolored(target, hue, sat);
        /* 成功一次就把「上一句提示」作废，下一次失败仍要说得出来。 */
        this.lastSegmentHint = null;
      } catch (err) {
        this.reconnect.handleCommandFailure(err);
      }
      return;
    }
    const resolved = await this.resolveSpec(target);
    if (resolved.kind !== "ok") {
      this.notifySegmentHint(resolved.message);
      return;
    }
    try {
      await this.transport.write(cmdSetSegment(recolorLayer0(resolved.spec, hue, sat)));
      this.cacheRecolored(target, hue, sat);
      this.lastSegmentHint = null;
    } catch (err) {
      this.reconnect.handleCommandFailure(err);
    }
  }

  /** 改色成功后同步本地镜像，后续帧不必再读回（它只改了 layer0 的两个字节）。 */
  private cacheRecolored(target: SegmentTarget, hue: number, sat: number): void {
    const cached = this.segmentsByStrip[target.stripId];
    if (cached === undefined) {
      return;
    }
    const index = cached.findIndex((report) => report.segId === target.segId);
    if (index < 0) {
      return;
    }
    const report = cached[index];
    const layer0 = { ...report.layer0, hue, sat };
    cached[index] = {
      ...report,
      layer0,
      /* 扁平投影是 layer0 的镜像，必须一起更新（#41 之前的读法）。 */
      ...toFlat({ ...report, layer0 }),
    };
  }

  /** 提示一次给页面；同一句不重复刷屏（拖动失败会连续重试）。 */
  private notifySegmentHint(message: string): void {
    if (this.lastSegmentHint === message) {
      return;
    }
    this.lastSegmentHint = message;
    for (const fn of this.segmentHintListeners.slice()) {
      try {
        fn(message);
      } catch (err) {
        console.warn(`[lumen] 段提示监听失败：${errorText(err)}`);
      }
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
        state: this.latestState ?? fallbackState({ r: 0, g: 0, b: 0 }),
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
    return this.latestState?.stripCounts[stripId] ?? 0;
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
    /* 断开后没有可写的段：颜色控件应回到禁用态。 */
    this.defaultSegment = null;
    this.stripConfigCache = null;
    this.deviceInfoCache = null;
    /* 逐带段缓存同样属于上一台 / 上一次连接，必须一起清：
     * 留着会让重连后的灯光页显示不存在的段。 */
    this.segmentsByStrip = emptyStripCache();
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
    /* `deviceInfoCache` 只属于本次连接（断开即清），因此不会是上一台的 hw_id。 */
    const hardwareId = this.deviceInfoCache?.hwId ?? null;
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
