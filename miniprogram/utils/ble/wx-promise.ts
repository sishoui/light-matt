/**
 * wx.* 的 Promise 化封装。
 *
 * 约束：
 *  - 调用方的 success / fail 永远被本封装覆盖（最后展开），保证 Promise 一定 settle；
 *  - 每个调用都带超时，避免某些平台既不回调 success 也不回调 fail；
 *  - 错误对象保留原 errCode / errMsg，并在 errMsg 前带上 API 名，便于日志定位。
 */

export interface WxFail {
  errCode?: number;
  errno?: number;
  errMsg?: string;
  message?: string;
}

export class WxCallError extends Error {
  readonly api: string;
  readonly errCode?: number;
  readonly raw: unknown;

  constructor(api: string, raw: unknown) {
    const err = raw as WxFail | null;
    const code = err?.errCode ?? err?.errno;
    const msg = err?.errMsg ?? err?.message ?? String(raw);
    super(code === undefined ? `${api}: ${msg}` : `${api}: errCode=${code} ${msg}`);
    this.name = "WxCallError";
    this.api = api;
    this.errCode = code;
    this.raw = raw;
  }
}

export class WxCallTimeoutError extends Error {
  readonly api: string;
  readonly timeoutMs: number;

  constructor(api: string, timeoutMs: number) {
    super(`${api}: 超时 ${timeoutMs}ms`);
    this.name = "WxCallTimeoutError";
    this.api = api;
    this.timeoutMs = timeoutMs;
  }
}

/**
 * 包一层 wx API。`api` 必须接收 options 对象并回调 success/fail。
 * 注意不能传 `wx.openBluetoothAdapter` 的裸引用之外的东西——微信 API 不依赖 this。
 */
export function wxCall<T>(
  apiName: string,
  api: (options: any) => void,
  options: Record<string, unknown> = {},
  timeoutMs = 0,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      fn();
    };

    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        finish(() => reject(new WxCallTimeoutError(apiName, timeoutMs)));
      }, timeoutMs);
    }

    try {
      api({
        ...options,
        success: (res: T) => finish(() => resolve(res)),
        fail: (err: unknown) => finish(() => reject(new WxCallError(apiName, err))),
      });
    } catch (err) {
      finish(() => reject(new WxCallError(apiName, err)));
    }
  });
}

/** 给任意 Promise 加超时（用于等 value 事件的 waiter）。 */
export function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new WxCallTimeoutError(label, timeoutMs)), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}
