/**
 * 控制会话：页面与传输层之间唯一的门面。
 *
 * 页面只 import 本模块；BLE 细节、节流、命令构造都在这里或其下层。
 * #8 开关走离散路径；#9 亮度走 20Hz latest-wins 连续路径；#10 颜色复用同一条
 * 连续通道（一个 throttle 实例，避免两路各 20Hz 叠成 40Hz）。
 */

import { FrameLog } from "../ble/log";
import { LatestWinsThrottle, type TimerApi } from "../ble/throttle";
import { BleTransport, type BleTransportOptions, type LinkDetail } from "../ble/transport";
import { errorText } from "../ble/errors";
import {
  applyLocalBrightness,
  brightnessForPowerOn,
  clampBrightness,
  effectiveMaxBrightness,
} from "./brightness";
import { applyLocalColor, clampRgb, presetBrightness } from "./color";
import {
  cmdQueryState,
  cmdSelfTest,
  cmdSetAll,
  cmdSetBrightness,
  cmdSetColor,
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
}

/** 离散命令的统一结果：成功带回更新后的本地状态，失败区分 ACK 与异常。 */
export type CommandResult =
  | { kind: "ok"; state: DeviceState }
  | { kind: "ack-error"; ack: AckResult }
  | { kind: "error"; message: string };

/** #9 起沿用的名字；与 CommandResult 完全等价。 */
export type PowerResult = CommandResult;

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

  constructor(opts: SessionOptions) {
    const log = new FrameLog({ mirrorToConsole: opts.devMode });
    if (opts.transportOverride !== undefined) {
      this.transport = opts.transportOverride;
    } else {
      const transportOptions: BleTransportOptions = { log, platform: opts.platform };
      this.transport = new BleTransport(transportOptions);
    }

    // 单一 20Hz 闸门服务亮度与颜色，避免两路各 20Hz 叠成 40Hz。
    this.throttle = new LatestWinsThrottle<ContinuousUpdate>(
      (update) => {
        const req: CommandRequest =
          update.kind === "brightness"
            ? cmdSetBrightness(update.value)
            : cmdSetColor(update.rgb);
        // 连续量只等写回调；ACK 会异步进日志。
        return this.transport.write(req).then(() => undefined);
      },
      opts.throttleTimer !== undefined ? { timer: opts.throttleTimer } : {},
    );

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

  /** 进页面：只打开适配器；扫描/连接由用户触发（本票不做静默回连）。 */
  async boot(): Promise<void> {
    try {
      await this.transport.openAdapter();
    } catch (err) {
      console.warn(`[lumen] 打开适配器失败：${errorText(err)}`);
    }
  }

  async scan(): Promise<void> {
    await this.transport.startScan();
  }

  async stopScan(): Promise<void> {
    await this.transport.stopScan();
  }

  async connect(deviceId: string, name?: string): Promise<DeviceState> {
    const state = await this.transport.connect(deviceId, name);
    this.latestState = state;
    return state;
  }

  async disconnect(): Promise<void> {
    this.throttle.cancel();
    await this.transport.disconnect();
    this.latestState = null;
  }

  /** 开关：离散路径，等 ACK。成功时用设备语义更新本地状态。 */
  async setPower(on: boolean): Promise<PowerResult> {
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
        const brightnessAck = await this.transport.sendAndWaitAck(cmdSetBrightness(restored));
        if (!brightnessAck.ok) {
          return { kind: "ack-error", ack: brightnessAck };
        }
        this.latestState = { ...this.latestState, brightness: restored };
        this.lastNonZeroBrightness = restored;
      }

      // 开关是幂等绝对值命令：ACK 超时允许重发一次（spec §9）。
      const ack = await this.transport.sendAndWaitAck(cmdSetPower(on), {
        retryOnTimeout: 1,
      });
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
    return this.transport.sendAndWaitAck(cmdQueryState());
  }

  /**
   * #13：自检。设备按 红→绿→蓝→白 各 500ms 临时覆盖灯带，2s 后自动恢复。
   *
   * 这里只发一帧并等 ACK：自检不改变设备状态，所以本地状态与 UI 都不动
   * （避免「自检后 UI 显示自检颜色」）。允许 ACK 超时重发一次——重发会
   * 让设备重启序列，结果仍是同一条 2s 自检，可接受；不重发则一次丢包就会
   * 让用户觉得按钮没反应。
   */
  async selfTest(): Promise<CommandResult> {
    try {
      const ack = await this.transport.sendAndWaitAck(cmdSelfTest(), { retryOnTimeout: 1 });
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
    try {
      const color = clampRgb(rgb);
      const brightness = presetBrightness(this.latestState, this.lastNonZeroBrightness);
      this.throttle.dropIf((update) => update.kind === "color");
      this.rememberColor(color);
      this.rememberBrightness(brightness);
      const ack = await this.transport.sendAndWaitAck(cmdSetAll(1, brightness, color), {
        retryOnTimeout: 1,
      });
      if (!ack.ok) {
        return { kind: "ack-error", ack };
      }
      this.applyPresetLocally(color, brightness);
      return { kind: "ok", state: this.latestState ?? fallbackState(color, 1, brightness) };
    } catch (err) {
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
    this.throttle.cancel();
    this.transport.destroy();
  }
}
