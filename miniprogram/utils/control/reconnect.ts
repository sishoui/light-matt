/**
 * 连接生命周期监督者（#11）：断线通知、1s/2s/4s 有限次退避回连、前台静默回连、
 * 连接代次（epoch）与手动/自动连接的互斥。
 *
 * 这里只有「什么时候该回连」，具体怎么连由 host（ControlSession + BleTransport）
 * 提供。拆出来的目的：session 只留命令语义，回连状态机单独一份。
 *
 * 关键不变量（改动时务必保持）：
 *  - 退避是**有限次**的：序列长度就是最大尝试次数，耗尽后停在 failed 等用户手动；
 *  - 主动断开后进前台不擅自回连（suppressAutoReconnect），直到下次手动连接/扫描；
 *  - 手动连接 / 扫描优先，自动回连不抢链路；
 *  - epoch 只在「连接身份变化」时 +1，用来丢弃旧连接上飞行的命令结果。
 */

import type { LinkState } from "../protocol/types";
import type { TimerApi } from "../ble/throttle";
import type { LinkDetail } from "../ble/link-listeners";
import { triage } from "../ble/errors";
import { WxCallError } from "../ble/wx-promise";
import type { CachedDevice } from "./device-cache";

const DEFAULT_RECONNECT_DELAYS_MS = [1000, 2000, 4000];

/** 监督者需要宿主提供的连接能力与状态读写。 */
export interface ReconnectHost {
  linkState(): LinkState;
  cached(): CachedDevice | null;
  /** 走完整初始化流水线（订阅 notify + 读 State），返回读到的设备状态。 */
  connect(deviceId: string, name?: string): Promise<unknown>;
  disconnect(): Promise<void>;
  /** 读一次 State 探活（失败即视为可能断线）。 */
  refresh(): Promise<unknown>;
  /** 断线：清本地设备镜像与节流残留。 */
  clearDeviceState(): void;
  /** 回连成功：同步本地镜像。 */
  onConnected(state: unknown): void;
}

export class ReconnectSupervisor {
  private readonly host: ReconnectHost;
  private readonly timer: TimerApi;
  private readonly delaysMs: number[];

  /** 有回连意图时为 true；主动断开 / 用户扫描 / 手动连接都会清掉。 */
  private desired = false;
  /** 已发起的自动回连次数（0 表示还没重试过）。 */
  private attempts = 0;
  private handle: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  /** 本轮退避已耗尽：onShow 不再自动重来，只留手动入口（禁止无限循环）。 */
  private exhausted = false;
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

  constructor(host: ReconnectHost, opts: { timer: TimerApi; delaysMs?: number[]; initialLink: LinkState }) {
    this.host = host;
    this.timer = opts.timer;
    this.delaysMs =
      opts.delaysMs !== undefined && opts.delaysMs.length > 0
        ? [...opts.delaysMs]
        : [...DEFAULT_RECONNECT_DELAYS_MS];
    this.lastLinkState = opts.initialLink;
  }

  get epoch(): number {
    return this.linkEpoch;
  }

  /** 是否还有未完成的自动回连意图（UI/测试可观察）。 */
  get pending(): boolean {
    return this.desired;
  }

  /** 当前 epoch 是否需要丢弃结果。 */
  isStale(epoch: number): boolean {
    return epoch !== this.linkEpoch;
  }

  get isManualConnecting(): boolean {
    return this.manualConnecting;
  }

  // ------------------------------------------------------------------
  // 手动入口（扫描 / 连接 / 断开 / 页面卸载）
  // ------------------------------------------------------------------

  /** 用户主动扫描 = 接管连接意图：取消待执行的自动回连，避免和扫描抢链路。 */
  scanIntent(): void {
    this.abandon();
    this.suppressAutoReconnect = false;
  }

  /** 手动连接优先：取消退避计时器与回连意图，并重置尝试次数（spec #41）。 */
  manualConnectBegin(): void {
    this.abandon();
    this.suppressAutoReconnect = false;
    this.manualConnecting = true;
  }

  manualConnectEnd(): void {
    this.manualConnecting = false;
  }

  /** 主动断开：不触发自动回连，也不再让 onShow 擅自重连。 */
  async disconnectIntent(): Promise<void> {
    this.abandon();
    this.suppressAutoReconnect = true;
    await this.host.disconnect();
    this.linkEpoch += 1;
  }

  destroy(): void {
    this.desired = false;
    this.clearTimer();
  }

  // ------------------------------------------------------------------
  // onShow
  // ------------------------------------------------------------------

  /**
   * 页面 onShow：有 deviceId 缓存且当前未连接时静默回连。
   *
   * 不得打断正在进行的扫描 / 手动连接 / 自动回连：这些状态下直接返回。
   * 已连接时只做一次 State 复核（设备是权威；后台期间可能被系统断开）。
   * 退避已耗尽的一轮不再自动重来（禁止无限循环），只留手动入口。
   */
  async onShow(): Promise<void> {
    if (this.running || this.manualConnecting) {
      return;
    }
    const link = this.host.linkState();
    if (link === "scanning" || link === "connecting" || link === "initializing") {
      return; // 用户正在扫描/连接，onShow 不抢链路
    }
    if (link === "ready") {
      // 后台可能被系统断连：读一次 State 复核，失败按「可能断线」处理。
      void this.host.refresh().catch((err) => {
        if (triage(err) === "reconnect") {
          void this.forceReconnect("连接已断开");
        }
      });
      return;
    }
    if (this.host.cached() === null || this.suppressAutoReconnect) {
      return;
    }
    if (link === "adapter-off" || link === "uninitialized") {
      // 适配器没开：只记回连意图，等 onBluetoothAdapterStateChange；
      // 10001 是非致命的，这里绝不能弹错或空转。
      if (!this.exhausted) {
        this.desired = true;
      }
      return;
    }
    if (link !== "idle" && link !== "failed") {
      return;
    }
    if (this.exhausted) {
      // 上一轮 1s/2s/4s 已用完：不自动重来，用户点连接条手动重连。
      return;
    }
    // 未连接且有缓存：立即静默试一次；失败后按 2s/4s 继续（总次数仍不超过 3 次）。
    this.desired = true;
    this.attempts = 0;
    this.exhausted = false;
    this.clearTimer();
    await this.runAttempt();
  }

  // ------------------------------------------------------------------
  // 链路事件
  // ------------------------------------------------------------------

  handleLinkChange(state: LinkState, detail?: LinkDetail): void {
    const previous = this.lastLinkState;
    this.lastLinkState = state;

    if (state === "ready") {
      // 新连接（首次 / 回连）：seq 已由传输层重置为 0x01；这里重置退避与过期判定代次。
      this.linkEpoch += 1;
      this.desired = false;
      this.attempts = 0;
      this.exhausted = false;
      this.suppressAutoReconnect = false;
      this.clearTimer();
      return;
    }

    if (state === "adapter-off") {
      this.linkEpoch += 1;
      this.host.clearDeviceState();
      this.clearTimer();
      // 只有「本来连着 / 本来就想回连」才挂起回连意图；
      // 纯扫描意图优先，适配器恢复后交给 transport 自动续扫。
      if (
        previous === "ready" ||
        previous === "initializing" ||
        previous === "connecting" ||
        this.desired
      ) {
        this.desired = this.host.cached() !== null && !this.suppressAutoReconnect;
      }
      return;
    }

    if (state === "idle") {
      if (detail?.reconnectable === true) {
        // 非主动断线：UI 立即失去设备状态（不显示过期状态）。
        this.linkEpoch += 1;
        this.host.clearDeviceState();
        if (this.manualConnecting || this.running) {
          // 初始化中被打断：由 connect()/本次回连的 catch 处理，这里不重复排。
          return;
        }
        if (this.host.cached() !== null && !this.suppressAutoReconnect) {
          // 新的一轮断线：退避从 1s 重新数，并清掉上一轮的耗尽标记。
          this.desired = true;
          this.attempts = 0;
          this.exhausted = false;
          this.schedule();
        }
        return;
      }
      // 适配器恢复 / 停扫后的 idle：如果还挂着回连意图，按退避节奏继续。
      if (
        (previous === "adapter-off" || previous === "uninitialized" || previous === "scanning") &&
        this.desired &&
        this.host.cached() !== null
      ) {
        this.attempts = 0;
        this.schedule();
      }
      return;
    }

    if (state === "failed") {
      // 一次回连尝试失败：由 runAttempt 的 catch 排下一次；
      // 其它来源的失败（手动连接）不自动退避。
      if (this.desired && !this.running && !this.manualConnecting) {
        this.schedule();
      }
    }
  }

  // ------------------------------------------------------------------
  // 命令失败分诊
  // ------------------------------------------------------------------

  /** 命令失败后的分诊：10006 直接重连；ACK 超时先读 State 探活再决定。 */
  handleCommandFailure(err: unknown): void {
    const action = triage(err);
    if (action !== "reconnect") {
      // retry-after-gap 由 sendCommand 负责重试；wait-adapter 等适配器事件；
      // fatal 交给调用方提示用户。
      return;
    }
    // 10006 = no connection：链路确定已断，直接重建，不浪费 2s 去 read。
    const errCode = err instanceof WxCallError ? err.errCode : undefined;
    if (errCode === 10006 || this.host.linkState() !== "ready") {
      void this.forceReconnect("连接已断开");
      return;
    }
    // ACK 超时（可能只是丢了一帧）：读一次 State 探活，读不到才重建。
    // 无论如何都不重传这条命令（连续量不重传；离散量由调用方决定）。
    void this.host.refresh().catch(() => {
      void this.forceReconnect("连接已断开");
    });
  }

  // ------------------------------------------------------------------
  // 内部
  // ------------------------------------------------------------------

  /** 取消当前这一轮自动回连（用户扫描 / 手动连接 / 主动断开时调用）。 */
  private abandon(): void {
    this.desired = false;
    this.attempts = 0;
    this.exhausted = false;
    this.clearTimer();
  }

  private schedule(): void {
    if (!this.desired || this.host.cached() === null || this.handle !== null) {
      return;
    }
    if (this.running) {
      return;
    }
    if (this.attempts >= this.delaysMs.length) {
      // 有限次：耗尽后停在这里，链路停在最后一次失败的 failed，
      // 页面显示「未连接」并由连接条提供扫描/手动重连入口。绝不无限循环。
      this.desired = false;
      this.exhausted = true;
      this.clearTimer();
      return;
    }
    const wait = this.delaysMs[this.attempts];
    this.handle = this.timer.setTimeout(() => {
      this.handle = null;
      void this.runAttempt();
    }, wait);
  }

  /** 一次自动回连：完整走 transport.connect（重新订阅 notify + 读 State）。 */
  private async runAttempt(): Promise<void> {
    const target = this.host.cached();
    if (!this.desired || this.running || target === null) {
      return;
    }
    const link = this.host.linkState();
    if (link === "adapter-off" || link === "uninitialized") {
      return; // 等适配器事件，不消耗尝试次数
    }
    if (link === "scanning" || link === "connecting" || link === "initializing" || link === "ready") {
      return; // 不打断扫描 / 手动连接
    }

    this.running = true;
    this.attempts += 1;
    let failed = false;
    try {
      const state = await this.host.connect(target.deviceId, target.name);
      // ready 事件负责清掉回连意图；这里只兜底同步本地镜像。
      this.host.onConnected(state);
    } catch {
      failed = true;
    } finally {
      this.running = false;
    }
    // 必须在 running 复位之后再排下一次，否则 schedule 会直接返回，
    // 退避链就断在一次失败上（只剩 1s 这一次）。
    if (failed && this.desired) {
      this.schedule();
    }
  }

  /**
   * 链路疑似已断（10006 / 写超时 / 连续 10008）时强制重建连接。
   *
   * 若传输层已经把状态切到 idle（带 reconnectable），这里直接返回——
   * 避免和 onLink 触发的退避重复排程。
   */
  async forceReconnect(reason: string): Promise<void> {
    if (this.desired || this.host.cached() === null || this.suppressAutoReconnect) {
      return;
    }
    console.warn(`[lumen] ${reason}，准备回连`);
    this.desired = true;
    this.attempts = 0;
    this.exhausted = false;
    this.clearTimer();
    this.host.clearDeviceState();
    this.linkEpoch += 1;
    try {
      await this.host.disconnect();
    } catch {
      /* 已断开时 close 失败无所谓 */
    }
    if (!this.desired) {
      return;
    }
    this.schedule();
  }

  private clearTimer(): void {
    if (this.handle !== null) {
      this.timer.clearTimeout(this.handle);
      this.handle = null;
    }
  }
}
