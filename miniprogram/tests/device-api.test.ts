/**
 * #44 设备同步 API（`utils/control/device-api.ts`）。
 *
 * 验收要点（票面 + 协调者裁定）：
 *  - 先 `POST /api/v1/session` 换身份，再带 `x-lumen-user-key` 调设备接口
 *    （后端在 session 之前 404 unknown_user）；
 *  - 请求形状与后端契约逐字段一致（register / list / rename / delete / seen）；
 *  - **任何失败都不抛错**：调用方拿到 `{ok:false}` 后继续用本地列表；
 *  - 只在瞬时失败（网络 / 超时 / 5xx）上**静默重试一次**，4xx 不重试；
 *  - 后端 404 `unknown_user` 时重建会话再试一次（后端库被重置的情况）；
 *  - 后端缓存字段（ledCounts / firmwareVer）只作为缓存上报，从不被当成当前配置。
 *
 * 假件只替换 HTTP 接缝与存储后端——不碰 wx、不碰 BLE。
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DeviceApi,
  IDENTITY_STORAGE_KEY,
  type DeviceApiOptions,
} from "../utils/control/device-api";
import { createWxLoginCode } from "../utils/control/wx-login";
import { createMemoryUsageStorage, type UsageStorage } from "../utils/usage/storage";
import type { HttpFetch, HttpRequest, HttpResponse } from "../utils/usage/http";
import type { UsageConfig } from "../utils/usage/config";

const TOKEN = "test-app-token";
const LOCAL_KEY = "local-0123456789abcdef";

function config(overrides: Partial<UsageConfig> = {}): UsageConfig {
  return {
    baseUrl: "https://lumen.test",
    appToken: TOKEN,
    requestTimeoutMs: 5000,
    enabled: true,
    ...overrides,
  };
}

interface Script {
  /** 按「方法 + 路径」匹配；返回 undefined 时用 `fallback`。 */
  routes?: Array<{ method: string; path: string; response: () => HttpResponse | Error }>;
  fallback?: () => HttpResponse | Error;
}

function fakeFetch(script: Script): { fetch: HttpFetch; calls: HttpRequest[] } {
  const calls: HttpRequest[] = [];
  const fetch: HttpFetch = async (req) => {
    calls.push(req);
    const path = new URL(req.url).pathname;
    const route = script.routes?.find(
      (item) => item.method === req.method && item.path === path,
    );
    const produce = route?.response ?? script.fallback;
    if (produce === undefined) {
      throw new Error(`没有为 ${req.method} ${path} 准备响应`);
    }
    const value = produce();
    if (value instanceof Error) {
      throw value;
    }
    return value;
  };
  return { fetch, calls };
}

function json(status: number, payload: unknown): HttpResponse {
  return { status, body: JSON.stringify(payload) };
}

/** 默认：session 成功（local 身份）。 */
function sessionRoute(userKey = LOCAL_KEY) {
  return {
    method: "POST",
    path: "/api/v1/session",
    response: () => json(200, { userKey, identityKind: "local", trusted: false }),
  };
}

function makeApi(
  script: Script,
  opts: Partial<DeviceApiOptions> = {},
  storage: UsageStorage = createMemoryUsageStorage(),
): { api: DeviceApi; calls: HttpRequest[]; storage: UsageStorage } {
  const { fetch, calls } = fakeFetch(script);
  const api = new DeviceApi({
    config: config(),
    fetch,
    storage,
    localUserKey: () => LOCAL_KEY,
    ...opts,
  });
  return { api, calls, storage };
}

describe("#44 session 身份", () => {
  it("先 POST /api/v1/session，带 app token 与本地 userKey", async () => {
    const { api, calls } = makeApi({
      routes: [sessionRoute()],
    });

    const result = await api.ensureIdentity();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toMatchObject({
        userKey: LOCAL_KEY,
        identityKind: "local",
        trusted: false,
      });
    }

    expect(calls).toHaveLength(1);
    const req = calls[0];
    expect(req.method).toBe("POST");
    expect(req.url).toBe("https://lumen.test/api/v1/session");
    expect(req.headers["x-lumen-app-token"]).toBe(TOKEN);
    expect(JSON.parse(req.body as string)).toEqual({ userKey: LOCAL_KEY });
  });

  it("身份落到 storage 并在新实例里复用（不重复换 session）", async () => {
    const storage = createMemoryUsageStorage();
    const first = makeApi({ routes: [sessionRoute()] }, {}, storage);
    await first.api.ensureIdentity();
    expect(first.calls).toHaveLength(1);
    expect(storage.get(IDENTITY_STORAGE_KEY)).toContain(LOCAL_KEY);

    const second = makeApi({ routes: [sessionRoute()] }, {}, storage);
    const reused = await second.api.ensureIdentity();
    expect(reused.ok).toBe(true);
    /* 已持久化：不再打 session。 */
    expect(second.calls).toHaveLength(0);
  });

  it("openid 身份如实带回 identityKind（后端返回的 userKey 覆盖本地键）", async () => {
    const { api } = makeApi({
      routes: [
        {
          method: "POST",
          path: "/api/v1/session",
          response: () => json(200, { userKey: "openid-abc", identityKind: "openid", trusted: true }),
        },
      ],
    });
    const result = await api.ensureIdentity();
    expect(result.ok && result.value.identityKind).toBe("openid");
    expect(result.ok && result.value.userKey).toBe("openid-abc");
  });

  it("session 401 → unauthorized，且不继续调设备接口", async () => {
    const { api, calls } = makeApi({
      routes: [
        { method: "POST", path: "/api/v1/session", response: () => json(401, { error: "unauthorized" }) },
      ],
    });
    const list = await api.listDevices();
    expect(list.ok).toBe(false);
    if (!list.ok) expect(list.reason).toBe("unauthorized");
    /* 只有 session 一次尝试（4xx 不重试），没有设备请求。 */
    expect(calls.map((c) => c.method)).toEqual(["POST"]);
  });
});

describe("#44 设备接口请求形状", () => {
  const authedSession = sessionRoute();

  it("GET /api/v1/devices 带 x-lumen-user-key，无请求体", async () => {
    const { api, calls } = makeApi({
      routes: [
        authedSession,
        {
          method: "GET",
          path: "/api/v1/devices",
          response: () =>
            json(200, {
              devices: [
                {
                  id: 7,
                  hardwareId: "AA:BB:CC:DD:EE:FF",
                  displayName: "书桌",
                  lastSeenAt: 1700000000000,
                  addedAt: 1600000000000,
                  ledCounts: [30, 20],
                  firmwareVer: 768,
                },
              ],
            }),
        },
      ],
    });

    const result = await api.listDevices();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual([
        {
          id: 7,
          hardwareId: "AA:BB:CC:DD:EE:FF",
          displayName: "书桌",
          lastSeenAt: 1700000000000,
          addedAt: 1600000000000,
          ledCounts: [30, 20],
          firmwareVer: 768,
        },
      ]);
    }

    const req = calls[1];
    expect(req.method).toBe("GET");
    expect(req.url).toBe("https://lumen.test/api/v1/devices");
    expect(req.headers["x-lumen-user-key"]).toBe(LOCAL_KEY);
    expect(req.body).toBeUndefined();
  });

  it("POST /devices/register 只发 hardwareId 与备注名（不带任何灯光配置）", async () => {
    const { api, calls } = makeApi({
      routes: [
        authedSession,
        {
          method: "POST",
          path: "/api/v1/devices/register",
          response: () =>
            json(201, {
              deviceId: 7,
              hardwareId: "AA:BB:CC:DD:EE:FF",
              displayName: "书桌",
            }),
        },
      ],
    });

    const result = await api.registerDevice("AA:BB:CC:DD:EE:FF", "书桌");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.deviceId).toBe(7);

    const body = JSON.parse(calls[1].body as string);
    expect(body).toEqual({ hardwareId: "AA:BB:CC:DD:EE:FF", displayName: "书桌" });
  });

  it("PATCH /devices/:id 改名；DELETE /devices/:id 解除关联", async () => {
    const { api, calls } = makeApi({
      routes: [
        authedSession,
        {
          method: "PATCH",
          path: "/api/v1/devices/7",
          response: () => json(200, { id: 7, displayName: "阳台" }),
        },
        {
          method: "DELETE",
          path: "/api/v1/devices/7",
          response: () => json(200, { deleted: true }),
        },
      ],
    });

    expect((await api.renameDevice(7, "阳台")).ok).toBe(true);
    expect((await api.deleteDevice(7)).ok).toBe(true);

    const patch = calls.find((c) => c.method === "PATCH");
    expect(patch?.url).toBe("https://lumen.test/api/v1/devices/7");
    expect(JSON.parse(patch?.body as string)).toEqual({ displayName: "阳台" });

    const del = calls.find((c) => c.method === "DELETE");
    expect(del?.url).toBe("https://lumen.test/api/v1/devices/7");
    expect(del?.body).toBeUndefined();
  });

  it("POST /devices/:id/seen 只上报缓存字段", async () => {
    const { api, calls } = makeApi({
      routes: [
        authedSession,
        {
          method: "POST",
          path: "/api/v1/devices/7/seen",
          response: () =>
            json(200, {
              id: 7,
              hardwareId: "AA:BB:CC:DD:EE:FF",
              displayName: null,
              lastSeenAt: 1700000000000,
              ledCounts: [30, 20],
              firmwareVer: 768,
              createdAt: 1600000000000,
            }),
        },
      ],
    });

    const result = await api.markSeen(7, { ledCounts: [30, 20], firmwareVer: 768 });
    expect(result.ok).toBe(true);

    const body = JSON.parse(calls[1].body as string);
    expect(body).toEqual({ ledCounts: [30, 20], firmwareVer: 768 });
  });

  it("未配置后端时一次请求都不发（disabled），不是错误", async () => {
    const { fetch, calls } = fakeFetch({ fallback: () => json(200, {}) });
    const api = new DeviceApi({
      config: config({ enabled: false }),
      fetch,
      storage: createMemoryUsageStorage(),
      localUserKey: () => LOCAL_KEY,
    });
    const result = await api.listDevices();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("disabled");
    expect(calls).toHaveLength(0);
  });
});

describe("#44 失败与重试", () => {
  it("网络异常：只重试一次，返回 offline，永不抛错", async () => {
    const { api, calls } = makeApi({
      routes: [sessionRoute()],
      fallback: () => new Error("网络不可达"),
    });
    const result = await api.listDevices();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("offline");
    /* session 1 次 + 设备 2 次（首次 + 一次静默重试）。 */
    expect(calls).toHaveLength(3);
  });

  it("500 也只重试一次（不无限重试）", async () => {
    const { api, calls } = makeApi({
      routes: [sessionRoute()],
      fallback: () => json(500, { error: "boom" }),
    });
    const result = await api.listDevices();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("server");
    expect(calls.filter((c) => c.method === "GET")).toHaveLength(2);
  });

  it("超时（fetch 永不 resolve）按 offline 处理且不挂住调用方", async () => {
    const hanging: HttpFetch = (req) =>
      new URL(req.url).pathname === "/api/v1/session"
        ? Promise.resolve(json(200, { userKey: LOCAL_KEY, identityKind: "local", trusted: false }))
        : new Promise<HttpResponse>(() => undefined);
    const api = new DeviceApi({
      config: config({ requestTimeoutMs: 10 }),
      fetch: hanging,
      storage: createMemoryUsageStorage(),
      localUserKey: () => LOCAL_KEY,
    });
    const result = await api.listDevices();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("offline");
  });

  it("404 unknown_user：重建会话后重试一次设备调用", async () => {
    const { api, calls } = makeApi({
      routes: [
        sessionRoute(LOCAL_KEY),
        {
          method: "GET",
          path: "/api/v1/devices",
          response: () => json(404, { error: "unknown_user" }),
        },
      ],
    });
    const result = await api.listDevices();
    /* 重建后仍然 unknown_user：按身份不可用返回，不再无限循环。 */
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("unauthorized");
    expect(calls.filter((c) => c.url.endsWith("/session"))).toHaveLength(2);
    expect(calls.filter((c) => c.method === "GET")).toHaveLength(2);
  });

  it("device_not_found（404 非 unknown_user）不重试、不重建会话", async () => {
    const { api, calls } = makeApi({
      routes: [
        sessionRoute(),
        {
          method: "PATCH",
          path: "/api/v1/devices/7",
          response: () => json(404, { error: "device_not_found" }),
        },
      ],
    });
    const result = await api.renameDevice(7, "阳台");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("rejected");
    expect(calls.filter((c) => c.method === "PATCH")).toHaveLength(1);
    expect(calls.filter((c) => c.url.endsWith("/session"))).toHaveLength(1);
  });
});

describe("#44 身份头部", () => {
  it("设备请求带的是后端返回的 userKey（openid 模式下不是本地键）", async () => {
    const { api, calls } = makeApi({
      routes: [
        {
          method: "POST",
          path: "/api/v1/session",
          response: () => json(200, { userKey: "openid-abc", identityKind: "openid", trusted: true }),
        },
        { method: "GET", path: "/api/v1/devices", response: () => json(200, { devices: [] }) },
      ],
    });
    await api.listDevices();
    const get = calls.find((c) => c.method === "GET");
    expect(get?.headers["x-lumen-user-key"]).toBe("openid-abc");
  });

  it("未配置/失败时不写 identity（下次调用还有机会）", async () => {
    const storage = createMemoryUsageStorage();
    const offline = makeApi({ fallback: () => new Error("offline") }, {}, storage);
    await offline.api.ensureIdentity();
    expect(storage.get(IDENTITY_STORAGE_KEY)).toBeNull();
  });
});

describe("#44 单例模块的 import 安全性", () => {
  it("在 node（无 wx）里 import 单例模块不报错，未配置时返回 null", async () => {
    /* 纪律：模块 import 时零副作用；只在函数体内部碰 wx。 */
    expect(typeof globalThis.wx).toBe("undefined");
    const { getDeviceApi } = await import("../utils/control/device-api-singleton");
    /* storage 是 wx 的空实现 → 配置读不到 → 功能关闭。 */
    expect(getDeviceApi()).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// #47 微信登录（code2session）
// ---------------------------------------------------------------------------

/** 会话路由：配了 AppSecret 的后端（没有 code 就 400）。 */
function wxSessionRoute(openid = "openid-from-code") {
  return {
    method: "POST",
    path: "/api/v1/session",
    response: () =>
      json(200, { userKey: openid, identityKind: "openid", trusted: true }),
  };
}

/** 后端在「已配 AppSecret 但没有 code」时回的形状（见 server/src/app.ts:183）。 */
function missingCode() {
  return json(400, {
    error: "invalid_payload",
    details: [{ field: "code", message: "已配置微信登录，code 必填" }],
  });
}

function makeApiWithLogin(
  script: Script,
  loginCode: () => Promise<string | null>,
  storage: UsageStorage = createMemoryUsageStorage(),
): { api: DeviceApi; calls: HttpRequest[]; storage: UsageStorage } {
  return makeApi(script, { loginCode }, storage);
}

describe("#47 会话携带 code", () => {
  it("拿到 code 时随会话请求一起发，后端回 openid 身份", async () => {
    const { api, calls } = makeApiWithLogin({ routes: [wxSessionRoute()] }, () =>
      Promise.resolve("the-one-time-code"),
    );

    const result = await api.ensureIdentity();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toMatchObject({
        userKey: "openid-from-code",
        identityKind: "openid",
        trusted: true,
        backendBacked: true,
        fallback: null,
      });
    }

    expect(calls).toHaveLength(1);
    expect(JSON.parse(calls[0].body as string)).toEqual({
      userKey: LOCAL_KEY,
      code: "the-one-time-code",
    });
  });

  it("openid 身份可用于设备接口（带后端 userKey 而不是本地键）", async () => {
    const { api, calls } = makeApiWithLogin(
      {
        routes: [
          wxSessionRoute(),
          { method: "GET", path: "/api/v1/devices", response: () => json(200, { devices: [] }) },
        ],
      },
      () => Promise.resolve("code-1"),
    );

    expect((await api.listDevices()).ok).toBe(true);
    /* 只有身份请求带 code；设备请求仍只带 userKey 头。 */
    expect(JSON.parse(calls[0].body as string)).toHaveProperty("code", "code-1");
    expect(calls[1].headers["x-lumen-user-key"]).toBe("openid-from-code");
    expect(calls[1].body).toBeUndefined();
  });

  it("未注入登录接缝（未配 AppSecret 环境）时请求体仍只有 userKey", async () => {
    const { api, calls } = makeApi({ routes: [sessionRoute()] });

    const result = await api.ensureIdentity();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toMatchObject({
        identityKind: "local",
        backendBacked: true,
        fallback: null,
      });
    }
    expect(JSON.parse(calls[0].body as string)).toEqual({ userKey: LOCAL_KEY });
  });

  it("后端没配 AppSecret（忽略 code）时照常拿 local 身份", async () => {
    const { api, calls } = makeApiWithLogin({ routes: [sessionRoute()] }, () =>
      Promise.resolve("ignored-code"),
    );

    const result = await api.ensureIdentity();
    expect(result.ok && result.value.identityKind).toBe("local");
    expect(result.ok && result.value.backendBacked).toBe(true);
    /* code 仍然发出去了，只是后端不用它。 */
    expect(JSON.parse(calls[0].body as string)).toHaveProperty("code", "ignored-code");
  });
});

describe("#47 wx.login 失败 → 回落 local", () => {
  it("拿不到 code 且后端要求 code：显式回落，不再打设备接口", async () => {
    const { api, calls } = makeApiWithLogin(
      {
        routes: [{ method: "POST", path: "/api/v1/session", response: missingCode }],
      },
      () => Promise.resolve(null),
    );

    const identity = await api.ensureIdentity();
    expect(identity.ok).toBe(true);
    if (identity.ok) {
      expect(identity.value).toMatchObject({
        userKey: LOCAL_KEY,
        identityKind: "local",
        trusted: false,
        backendBacked: false,
        fallback: "login_failed",
      });
    }

    const list = await api.listDevices();
    expect(list.ok).toBe(false);
    if (!list.ok) expect(list.reason).toBe("login_failed");
    /* 只有那一次 session：回落身份不会再撞设备接口。 */
    expect(calls.map((c) => c.method)).toEqual(["POST"]);
  });

  it("loginCode 抛错也按「拿不到 code」处理，不抛给调用方", async () => {
    const { api } = makeApiWithLogin(
      { routes: [{ method: "POST", path: "/api/v1/session", response: missingCode }] },
      () => Promise.reject(new Error("wx.login 崩了")),
    );

    const identity = await api.ensureIdentity();
    expect(identity.ok && identity.value.fallback).toBe("login_failed");
  });

  it("回落身份不落盘：下次启动还会再试登录", async () => {
    const storage = createMemoryUsageStorage();
    const { api } = makeApiWithLogin(
      { routes: [{ method: "POST", path: "/api/v1/session", response: missingCode }] },
      () => Promise.resolve(null),
      storage,
    );

    await api.ensureIdentity();
    expect(storage.get(IDENTITY_STORAGE_KEY)).toBeNull();
  });

  it("回落身份只在内存复用：连续设备调用不会每次都重新 wx.login", async () => {
    let logins = 0;
    const { api, calls } = makeApiWithLogin(
      { routes: [{ method: "POST", path: "/api/v1/session", response: missingCode }] },
      () => {
        logins += 1;
        return Promise.resolve(null);
      },
    );

    await api.listDevices();
    await api.listDevices();
    expect(logins).toBe(1);
    expect(calls).toHaveLength(1);
  });

  it("后端未配 AppSecret 时拿不到 code 也没关系：仍按 userKey 拿 local 身份", async () => {
    const { api, calls } = makeApiWithLogin({ routes: [sessionRoute()] }, () =>
      Promise.resolve(null),
    );

    const result = await api.ensureIdentity();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toMatchObject({
        userKey: LOCAL_KEY,
        identityKind: "local",
        backendBacked: true,
        fallback: null,
      });
    }
    /* 没 code 就不带这个字段（不是空串）。 */
    expect(JSON.parse(calls[0].body as string)).toEqual({ userKey: LOCAL_KEY });
  });

  it("缓存里的 local 身份会被重新登录升级成 openid（每个进程只试一次）", async () => {
    const storage = createMemoryUsageStorage({
      /* 上一版本留下的 local 缓存：没有 code 时的身份。 */
      [IDENTITY_STORAGE_KEY]: JSON.stringify({
        userKey: LOCAL_KEY,
        identityKind: "local",
        trusted: false,
      }),
    });
    const { api, calls } = makeApiWithLogin({ routes: [wxSessionRoute()] }, () =>
      Promise.resolve("fresh-code"),
    );

    const first = await api.ensureIdentity();
    expect(first.ok && first.value.identityKind).toBe("openid");
    expect(calls).toHaveLength(1);

    /* 已经升级：第二次直接用缓存，不再打 session。 */
    await api.ensureIdentity();
    expect(calls).toHaveLength(1);
  });

  it("没有登录接缝时旧 local 缓存直接复用（未配 AppSecret 路径行为不变）", async () => {
    const storage = createMemoryUsageStorage({
      [IDENTITY_STORAGE_KEY]: JSON.stringify({
        userKey: LOCAL_KEY,
        identityKind: "local",
        trusted: false,
      }),
    });
    const { api, calls } = makeApi({ routes: [sessionRoute()] }, {}, storage);

    const result = await api.ensureIdentity();
    expect(result.ok && result.value.userKey).toBe(LOCAL_KEY);
    expect(result.ok && result.value.backendBacked).toBe(true);
    expect(calls).toHaveLength(0);
  });
});

describe("#47 invalid_code → 回落 local", () => {
  it("后端 401 invalid_code：回落并给出可读原因，不当作 unauthorized", async () => {
    const { api, calls } = makeApiWithLogin(
      {
        routes: [
          {
            method: "POST",
            path: "/api/v1/session",
            response: () =>
              json(401, { error: "invalid_code", message: "wx.login 的 code 无效或已过期" }),
          },
        ],
      },
      () => Promise.resolve("expired-code"),
    );

    const identity = await api.ensureIdentity();
    expect(identity.ok).toBe(true);
    if (identity.ok) {
      expect(identity.value).toMatchObject({
        identityKind: "local",
        backendBacked: false,
        fallback: "invalid_code",
      });
    }

    const list = await api.listDevices();
    expect(list.ok).toBe(false);
    if (!list.ok) expect(list.reason).toBe("invalid_code");
    expect(calls.map((c) => c.method)).toEqual(["POST"]);
  });

  it("真 401（app token 错）仍按 unauthorized 返回，不被误判成登录问题", async () => {
    const { api } = makeApiWithLogin(
      {
        routes: [
          { method: "POST", path: "/api/v1/session", response: () => json(401, { error: "unauthorized" }) },
        ],
      },
      () => Promise.resolve("some-code"),
    );

    const identity = await api.ensureIdentity();
    expect(identity.ok).toBe(false);
    if (!identity.ok) expect(identity.reason).toBe("unauthorized");
  });

  it("forgetIdentity 后重新登录成功：从回落身份升级为 openid", async () => {
    let code: string | null = null;
    const { api } = makeApiWithLogin(
      {
        routes: [
          {
            method: "POST",
            path: "/api/v1/session",
            response: () =>
              code === null ? missingCode() : json(200, { userKey: "openid-2", identityKind: "openid", trusted: true }),
          },
        ],
      },
      () => Promise.resolve(code),
    );

    expect((await api.ensureIdentity()).ok).toBe(true);
    expect(api.currentIdentity?.fallback).toBe("login_failed");

    code = "fresh-code";
    api.forgetIdentity();
    const retried = await api.ensureIdentity();
    expect(retried.ok && retried.value.identityKind).toBe("openid");
    expect(retried.ok && retried.value.backendBacked).toBe(true);
  });
});

describe("#47 wx.login 适配器（utils/control/wx-login.ts）", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("成功时把 code 带回来（去空白）", async () => {
    vi.stubGlobal("wx", {
      login: (opts: { success: (res: { code: string }) => void }) => opts.success({ code: "  abc123  " }),
    });
    expect(await createWxLoginCode()()).toBe("abc123");
  });

  it("fail 回调 → null（用户取消 / 网络失败都走这里）", async () => {
    vi.stubGlobal("wx", { login: (opts: { fail: () => void }) => opts.fail() });
    expect(await createWxLoginCode()()).toBeNull();
  });

  it("空 code → null（后端会把空串当无效 code）", async () => {
    vi.stubGlobal("wx", {
      login: (opts: { success: (res: { code: string }) => void }) => opts.success({ code: "" }),
    });
    expect(await createWxLoginCode()()).toBeNull();
  });

  it("wx.login 同步抛错 → null，不把异常冒给会话层", async () => {
    vi.stubGlobal("wx", {
      login: () => {
        throw new Error("基础库不支持");
      },
    });
    expect(await createWxLoginCode()()).toBeNull();
  });

  it("没有 wx（node 环境）→ null", async () => {
    expect(await createWxLoginCode()()).toBeNull();
  });
});
