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

export interface HttpRequest {
  url: string;
  method: "POST";
  headers: Record<string, string>;
  /** 已序列化的 JSON 字符串。 */
  body: string;
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
          method: request.method,
          header: request.headers,
          data: request.body,
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
