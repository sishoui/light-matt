import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { APP_TOKEN, makeHarness, type Harness } from "./helpers.js";
import type { AppWxConfig } from "../src/app.js";
import { readEnv } from "../src/config.js";

/**
 * POST /api/v1/session —— 身份换取。
 *
 * 两种模式：
 * - 未配 WX_APPID/WX_SECRET：沿用 `local-<16hex>`，identityKind = "local"，trusted = false；
 * - 配了：wx.login 的 code 换 openid，identityKind = "openid"，trusted = true。
 *
 * 测试里 fake fetch 必须注入，绝不真出网（vitest 不联网）。
 */

const tokenHeader = (): Record<string, string> => ({ "x-lumen-app-token": APP_TOKEN });

const LOCAL_KEY = "local-0123456789abcdef";
const OPENID = "oX7-openid-from-wechat";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

interface FakeWx {
  readonly config: AppWxConfig;
  readonly fetchMock: ReturnType<typeof vi.fn>;
}

function fakeWx(impl: (url: URL) => Response | Promise<Response>): FakeWx {
  const fetchMock = vi.fn(async (input: string | URL | Request) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    return impl(new URL(raw));
  });
  return {
    config: {
      appid: "wx-test-appid",
      secret: "wx-test-secret",
      fetchImpl: fetchMock as unknown as typeof fetch,
    },
    fetchMock,
  };
}

/** code → openid 成功的假微信。 */
function wxOk(): FakeWx {
  return fakeWx(() => jsonResponse({ openid: OPENID, session_key: "sk" }));
}

/** 微信业务错误：errcode 40029（code 无效）。 */
function wxInvalidCode(): FakeWx {
  return fakeWx(() => jsonResponse({ errcode: 40029, errmsg: "invalid code" }));
}

/** 微信系统错误：-1（系统繁忙），HTTP 200。 */
function wxBusy(): FakeWx {
  return fakeWx(() => jsonResponse({ errcode: -1, errmsg: "system error" }));
}

/** 网络层直接失败。 */
function wxNetworkDown(): FakeWx {
  return fakeWx(() => {
    throw new Error("getaddrinfo ENOTFOUND api.weixin.qq.com");
  });
}

describe("POST /api/v1/session —— 未配 AppSecret 的本地模式", () => {
  let h: Harness;

  beforeEach(async () => {
    h = await makeHarness();
  });

  afterEach(async () => {
    await h.close();
  });

  it("local-<16hex> 被接受：local 模式、不可信、落 users 行", async () => {
    const res = await h.app.inject({
      method: "POST",
      url: "/api/v1/session",
      headers: tokenHeader(),
      payload: { userKey: LOCAL_KEY },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.userKey).toBe(LOCAL_KEY);
    expect(body.identityKind).toBe("local");
    expect(body.trusted).toBe(false);
    expect(typeof body.userId).toBe("number");

    const rows = h.db.prepare("SELECT user_key FROM users").all();
    expect(rows).toEqual([{ user_key: LOCAL_KEY }]);
  });

  it("同一 local key 重复换取是幂等的：同一个 userId，只有一行", async () => {
    const first = await h.app.inject({
      method: "POST",
      url: "/api/v1/session",
      headers: tokenHeader(),
      payload: { userKey: LOCAL_KEY },
    });
    const second = await h.app.inject({
      method: "POST",
      url: "/api/v1/session",
      headers: tokenHeader(),
      payload: { userKey: LOCAL_KEY },
    });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(second.json().userId).toBe(first.json().userId);
    const count = h.db.prepare("SELECT COUNT(*) AS n FROM users").get() as { n: number };
    expect(count.n).toBe(1);
  });

  it("不符合 local-<16hex> 的自称身份 → 400", async () => {
    for (const userKey of ["openid-user-a", "local-XYZ", "local-0123", "", 42, null]) {
      const res = await h.app.inject({
        method: "POST",
        url: "/api/v1/session",
        headers: tokenHeader(),
        payload: { userKey },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe("invalid_payload");
      const fields = (res.json().details as Array<{ field: string }>).map((d) => d.field);
      expect(fields).toContain("userKey");
    }
    const count = h.db.prepare("SELECT COUNT(*) AS n FROM users").get() as { n: number };
    expect(count.n).toBe(0);
  });

  it("缺 userKey → 400", async () => {
    const res = await h.app.inject({
      method: "POST",
      url: "/api/v1/session",
      headers: tokenHeader(),
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_payload");
  });

  it("没有 app token → 401，且不落库", async () => {
    const res = await h.app.inject({
      method: "POST",
      url: "/api/v1/session",
      payload: { userKey: LOCAL_KEY },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe("unauthorized");
    const count = h.db.prepare("SELECT COUNT(*) AS n FROM users").get() as { n: number };
    expect(count.n).toBe(0);
  });

  it("本地模式带 code 也只是普通字段：给了合法 userKey 仍可登录", async () => {
    const res = await h.app.inject({
      method: "POST",
      url: "/api/v1/session",
      headers: tokenHeader(),
      payload: { userKey: LOCAL_KEY, code: "whatever" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().identityKind).toBe("local");
  });

  it("本地模式只给 code 不给 userKey → 400（不会把 code 当身份）", async () => {
    const res = await h.app.inject({
      method: "POST",
      url: "/api/v1/session",
      headers: tokenHeader(),
      payload: { code: "whatever" },
    });
    expect(res.statusCode).toBe(400);
    expect((res.json().details as Array<{ field: string }>).map((d) => d.field)).toContain(
      "userKey",
    );
  });
});

describe("POST /api/v1/session —— 配了 AppSecret 的 openid 模式", () => {
  let h: Harness;
  let wx: FakeWx;

  afterEach(async () => {
    await h.close();
  });

  async function boot(fake: FakeWx): Promise<void> {
    wx = fake;
    h = await makeHarness({ wx: fake.config });
  }

  it("code 换 openid：身份为 openid、可信、落 users 行", async () => {
    await boot(wxOk());

    const res = await h.app.inject({
      method: "POST",
      url: "/api/v1/session",
      headers: tokenHeader(),
      payload: { code: "wx-code-1" },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.userKey).toBe(OPENID);
    expect(body.identityKind).toBe("openid");
    expect(body.trusted).toBe(true);
    expect(typeof body.userId).toBe("number");

    const rows = h.db.prepare("SELECT user_key FROM users").all();
    expect(rows).toEqual([{ user_key: OPENID }]);
  });

  it("请求参数正确：appid / secret / js_code / grant_type", async () => {
    await boot(wxOk());

    await h.app.inject({
      method: "POST",
      url: "/api/v1/session",
      headers: tokenHeader(),
      payload: { code: "wx-code-query" },
    });

    expect(wx.fetchMock).toHaveBeenCalledTimes(1);
    const calledUrl = new URL(String(wx.fetchMock.mock.calls[0]?.[0]));
    expect(calledUrl.origin + calledUrl.pathname).toBe("https://api.weixin.qq.com/sns/jscode2session");
    expect(calledUrl.searchParams.get("appid")).toBe("wx-test-appid");
    expect(calledUrl.searchParams.get("secret")).toBe("wx-test-secret");
    expect(calledUrl.searchParams.get("js_code")).toBe("wx-code-query");
    expect(calledUrl.searchParams.get("grant_type")).toBe("authorization_code");
  });

  it("同一 openid 换个 code 再来：同一个 userId", async () => {
    await boot(wxOk());
    const first = await h.app.inject({
      method: "POST",
      url: "/api/v1/session",
      headers: tokenHeader(),
      payload: { code: "wx-code-a" },
    });
    const second = await h.app.inject({
      method: "POST",
      url: "/api/v1/session",
      headers: tokenHeader(),
      payload: { code: "wx-code-b" },
    });
    expect(first.json().userId).toBe(second.json().userId);
  });

  it("微信拒绝 code（errcode 40029）→ 401 invalid_code", async () => {
    await boot(wxInvalidCode());
    const res = await h.app.inject({
      method: "POST",
      url: "/api/v1/session",
      headers: tokenHeader(),
      payload: { code: "expired-code" },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe("invalid_code");
    const count = h.db.prepare("SELECT COUNT(*) AS n FROM users").get() as { n: number };
    expect(count.n).toBe(0);
  });

  it("微信系统繁忙（errcode -1）→ 502 upstream", async () => {
    await boot(wxBusy());
    const res = await h.app.inject({
      method: "POST",
      url: "/api/v1/session",
      headers: tokenHeader(),
      payload: { code: "any-code" },
    });
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toBe("upstream_unavailable");
  });

  it("网络层失败 → 502 upstream", async () => {
    await boot(wxNetworkDown());
    const res = await h.app.inject({
      method: "POST",
      url: "/api/v1/session",
      headers: tokenHeader(),
      payload: { code: "any-code" },
    });
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toBe("upstream_unavailable");
  });

  it("HTTP 500 → 502 upstream", async () => {
    await boot(fakeWx(() => new Response("boom", { status: 500 })));
    const res = await h.app.inject({
      method: "POST",
      url: "/api/v1/session",
      headers: tokenHeader(),
      payload: { code: "any-code" },
    });
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toBe("upstream_unavailable");
  });

  it("微信返回了但没有 openid → 502（不是把空串当身份）", async () => {
    await boot(fakeWx(() => jsonResponse({ session_key: "sk" })));
    const res = await h.app.inject({
      method: "POST",
      url: "/api/v1/session",
      headers: tokenHeader(),
      payload: { code: "any-code" },
    });
    expect(res.statusCode).toBe(502);
  });

  it("openid 模式缺 code → 400（不接受自报 userKey 顶替）", async () => {
    await boot(wxOk());
    const res = await h.app.inject({
      method: "POST",
      url: "/api/v1/session",
      headers: tokenHeader(),
      payload: { userKey: LOCAL_KEY },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_payload");
    expect(wx.fetchMock).not.toHaveBeenCalled();
  });

  it("openid 模式没有 app token → 401，且不出网", async () => {
    await boot(wxOk());
    const res = await h.app.inject({
      method: "POST",
      url: "/api/v1/session",
      payload: { code: "any-code" },
    });
    expect(res.statusCode).toBe(401);
    expect(wx.fetchMock).not.toHaveBeenCalled();
  });
});

describe("readEnv：微信凭据成对出现", () => {
  const base: NodeJS.ProcessEnv = {
    ADMIN_USER: "admin",
    ADMIN_PASSWORD: "pass",
    APP_TOKEN: "token",
  };

  it("两个都不配 → 不出现 wx 字段（走 local 回落）", () => {
    const env = readEnv({ ...base });
    expect(env.WX_APPID).toBeUndefined();
    expect(env.WX_SECRET).toBeUndefined();
  });

  it("两个都配 → 都保留", () => {
    const env = readEnv({ ...base, WX_APPID: " wxid ", WX_SECRET: " secret " });
    expect(env.WX_APPID).toBe("wxid");
    expect(env.WX_SECRET).toBe("secret");
  });

  it("只配一个 → 启动即失败（避免运行期总是 502）", () => {
    expect(() => readEnv({ ...base, WX_APPID: "wxid" })).toThrow(/同时配置或同时留空/);
    expect(() => readEnv({ ...base, WX_SECRET: "secret" })).toThrow(/同时配置或同时留空/);
  });

  it("空串视同未配置", () => {
    expect(() => readEnv({ ...base, WX_APPID: "", WX_SECRET: "secret" })).toThrow(
      /同时配置或同时留空/,
    );
    expect(readEnv({ ...base, WX_APPID: "  ", WX_SECRET: "" }).WX_APPID).toBeUndefined();
  });
});
