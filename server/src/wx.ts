/**
 * 微信 `code2session`。只做一件事：把 `wx.login()` 拿到的 code 换成 openid。
 *
 * 为什么要单独一个文件 + 可注入 `fetch`：
 *   1. 服务器的其余部分完全不联网，这是唯一一处出站请求，集中放这里便于审计；
 *   2. 测试里必须注入假 fetch —— vitest 不联网，访问真实域名会直接失败。
 *
 * 返回三态而不是抛异常，因为调用方要区分「code 不对（用户重登）」和
 * 「微信挂了（稍后重试）」，两者对小程序是不同提示。
 */

export interface WxConfig {
  readonly appid: string;
  readonly secret: string;
}

export type WxExchangeResult =
  | { readonly ok: true; readonly openid: string }
  | { readonly ok: false; readonly reason: "invalid_code" | "upstream" };

/** 微信业务错误码里，明确表示 code 本身不可用（过期/已用过/伪造）。 */
const INVALID_CODE_ERRCODES = new Set([40029, 40163, 40226]);

const TIMEOUT_MS = 5_000;

export async function exchangeCodeForOpenId(
  code: string,
  cfg: WxConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<WxExchangeResult> {
  const url = new URL("https://api.weixin.qq.com/sns/jscode2session");
  url.searchParams.set("appid", cfg.appid);
  url.searchParams.set("secret", cfg.secret);
  url.searchParams.set("js_code", code);
  url.searchParams.set("grant_type", "authorization_code");

  let response: Response;
  try {
    response = await fetchImpl(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch {
    // 网络层失败（DNS / 连接 / 超时）与微信自己报错要分开：都不该让请求 500。
    return { ok: false, reason: "upstream" };
  }

  if (!response.ok) return { ok: false, reason: "upstream" };

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { ok: false, reason: "upstream" };
  }
  if (typeof body !== "object" || body === null) return { ok: false, reason: "upstream" };

  const payload = body as { openid?: unknown; errcode?: unknown; errmsg?: unknown };
  if (typeof payload.errcode === "number" && payload.errcode !== 0) {
    return {
      ok: false,
      reason: INVALID_CODE_ERRCODES.has(payload.errcode) ? "invalid_code" : "upstream",
    };
  }
  if (typeof payload.openid !== "string" || payload.openid.length === 0) {
    // 微信成功响应里 openid 一定存在；没有就是协议异常，绝不能把空串当身份。
    return { ok: false, reason: "upstream" };
  }
  return { ok: true, openid: payload.openid };
}
