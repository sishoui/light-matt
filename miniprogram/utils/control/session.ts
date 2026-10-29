/**
 * 控制会话：页面与传输层之间唯一的门面。
 *
 * 页面只 import 本模块；BLE 细节、节流、命令构造都在这里或其下层。
 * #8 只有开关走离散路径；亮度/颜色的节流接口已建好（queue 与 commit），
 * #9/#10 直接接 UI，不需要改传输层。
 */

import { FrameLog } from "../ble/log";
import { LatestWinsThrottle } from "../ble/throttle";
import { BleTransport, type BleTransportOptions, type LinkDetail } from "../ble/transport";
import { errorText } from "../ble/errors";
import {
  cmdQueryState,
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
}

export type PowerResult =
  | { kind: "ok"; state: DeviceState }
  | { kind: "ack-error"; ack: AckResult }
  | { kind: "error"; message: string };

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
  /** 亮度 0 时点开关，用最近一次非 0 亮度恢复（#9 会用，本票先记录）。 */
  private lastNonZeroBrightness = 128;

  constructor(opts: SessionOptions) {
    const log = new FrameLog({ mirrorToConsole: opts.devMode });
    const transportOptions: BleTransportOptions = { log, platform: opts.platform };
    this.transport = new BleTransport(transportOptions);

    // 单一 20Hz 闸门服务亮度与颜色，避免两路各 20Hz 叠成 40Hz。
    this.throttle = new LatestWinsThrottle<ContinuousUpdate>((update) => {
      const req: CommandRequest =
        update.kind === "brightness"
          ? cmdSetBrightness(update.value)
          : cmdSetColor(update.rgb);
      // 连续量只等写回调；ACK 会异步进日志。
      return this.transport.write(req).then(() => undefined);
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
        state: this.latestState ?? {
          power: on ? 1 : 0,
          brightness: 0,
          r: 0,
          g: 0,
          b: 0,
          ledCount: 0,
          maxBrightness: 255,
        },
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

  /** #9：滑块 changing 走 20Hz latest-wins。 */
  queueBrightness(value: number): void {
    this.throttle.push({ kind: "brightness", value });
  }

  /** #9：松手时 flush，保证最终值落地。 */
  commitBrightness(value: number): void {
    this.throttle.push({ kind: "brightness", value });
    this.throttle.flush();
  }

  /** #10：色环移动。 */
  queueColor(rgb: RGB): void {
    this.throttle.push({ kind: "color", rgb });
  }

  /** #10：色环松手。 */
  commitColor(rgb: RGB): void {
    this.throttle.push({ kind: "color", rgb });
    this.throttle.flush();
  }

  get brightnessHint(): number {
    return this.lastNonZeroBrightness;
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
