/**
 * State read 的等待者：一次 read 请求 → 等 value 事件拿真正的 8 字节。
 *
 * read 的 success 只代表请求受理，真正的值走 onBLECharacteristicValueChange，
 * 因此必须在这里挂一个等待者。同一时刻只允许一个在飞（重复调用复用同一个
 * Promise），超时 / 解析失败 / 断线都要把它清干净。
 */

import type { DeviceState } from "../protocol/types";
import { WxCallTimeoutError } from "./wx-promise";

export class StateReadSlot {
  private waiter: {
    resolve: (value: Uint8Array) => void;
    reject: (err: unknown) => void;
  } | null = null;
  private promise: Promise<DeviceState> | null = null;

  /** 已有在飞的 read 时复用它（与拆分前的单飞语义一致）。 */
  get inflight(): Promise<DeviceState> | null {
    return this.promise;
  }

  /**
   * 建立一次 read 等待。
   *
   * @param onValue 拿到 8 字节后由调用方解析并派发（保持解析异常落到这里）。
   */
  open(
    timeoutMs: number,
    onValue: (bytes: Uint8Array) => DeviceState,
  ): Promise<DeviceState> {
    const promise = new Promise<DeviceState>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiter = null;
        this.promise = null;
        reject(new WxCallTimeoutError("State read", timeoutMs));
      }, timeoutMs);

      this.waiter = {
        resolve: (value: Uint8Array) => {
          clearTimeout(timer);
          this.waiter = null;
          this.promise = null;
          try {
            resolve(onValue(value));
          } catch (err) {
            reject(err);
          }
        },
        reject: (err: unknown) => {
          clearTimeout(timer);
          this.waiter = null;
          this.promise = null;
          reject(err);
        },
      };
    });
    this.promise = promise;
    return promise;
  }

  /** value 事件到达：有等待者就交给它（否则调用方按 StateReport 处理）。 */
  deliver(bytes: Uint8Array): boolean {
    const waiter = this.waiter;
    if (waiter === null) {
      return false;
    }
    waiter.resolve(bytes.slice());
    return true;
  }

  reject(err: unknown): void {
    this.waiter?.reject(err);
  }

  /** 断线 / 销毁：清掉等待者与在飞 Promise。 */
  reset(reason: Error): void {
    if (this.waiter !== null) {
      this.waiter.reject(reason);
      this.waiter = null;
    }
    this.promise = null;
  }
}
