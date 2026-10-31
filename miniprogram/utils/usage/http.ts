/**
 * 使用日志的 HTTP 接缝。
 *
 * 纯逻辑（logger / 队列）只依赖 `HttpFetch` 这个函数类型，不直接调 `wx.request`。
 * 这样 vitest 可以注入「成功 / 超时 / 断网 / 重复」四种假后端，而生产代码的
 * wx 适配器只有下面这一个小函数。
 *
 * 超时责任在 logger（用可注入的计时器），不在这里：wx.request 的 `timeout`
 * 只是双保险，部分平台不保证回调，所以真正的硬超时由调用方保证。
 */

/** 小程序 HTTP 接缝支持的方法（#44 起不再只有 POST）。 */
export type HttpMethod = "GET" | "POST" | "PATCH" | "DELETE";

/**
 * 一条 HTTP 请求。
 *
 * `body` 可省略：GET / DELETE 没有请求体；`headers` 由调用方给全
 * （使用日志带 `x-lumen-app-token`，设备 API 另加 `x-lumen-user-key`）——
 * 这里不认识任何业务头，避免接缝层偷偷夹带身份。
 */
export interface HttpRequest {
  url: string;
  method: HttpMethod;
  headers: Record<string, string>;
  /** 已序列化的 JSON 字符串；无请求体时省略。 */
  body?: string;
  timeoutMs: number;
}

export interface HttpResponse {
  status: number;
  body: string;
}

/** 注入点：任意返回 Promise 的 fetch 形状函数。 */
export type HttpFetch = (request: HttpRequest) => Promise<HttpResponse>;

/**
 * 生产实现：wx.request 包成 Promise。
 *
 * 注意 wx.request 的 `success` 对 4xx/5xx 也会触发（它只看网络层），
 * 所以状态码原样带回给 logger 分类。
 *
 * `PATCH` 不在 wx.request 的类型联合里（基础库里可用但 typings 滞后），
 * 这里只做一次窄化断言；GET / DELETE 的 `data` 传 undefined 即可。
 */
export function createWxHttpFetch(): HttpFetch {
  return (request) =>
    new Promise<HttpResponse>((resolve, reject) => {
      if (typeof wx === "undefined" || typeof wx.request !== "function") {
        reject(new Error("wx.request 不可用"));
        return;
      }
      try {
        wx.request({
          url: request.url,
          // wx.request 的 typings 漏了 PATCH（基础库本身支持），双重断言绕过一次。
          method: request.method as unknown as "GET" | "POST" | "DELETE",
          header: request.headers,
          ...(request.body !== undefined ? { data: request.body } : {}),
          timeout: request.timeoutMs,
          dataType: "text",
          success: (res) => {
            const body =
              typeof res.data === "string" ? res.data : JSON.stringify(res.data ?? "");
            resolve({ status: Number(res.statusCode) || 0, body });
          },
          fail: (err) => reject(err),
        });
      } catch (err) {
        reject(err);
      }
    });
}
