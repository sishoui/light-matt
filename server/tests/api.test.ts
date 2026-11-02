import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ADMIN_PASSWORD,
  APP_TOKEN,
  basicAuth,
  logBody,
  makeHarness,
  type Harness,
} from "./helpers.js";

let h: Harness;

beforeEach(async () => {
  h = await makeHarness();
});

afterEach(async () => {
  await h.close();
});

const tokenHeader = (): Record<string, string> => ({ "x-lumen-app-token": APP_TOKEN });

describe("POST /api/v1/usage-logs —— 写一条使用日志", () => {
  it("写入成功返回 201，并把用户与日志都落库", async () => {
    const res = await h.app.inject({
      method: "POST",
      url: "/api/v1/usage-logs",
      headers: tokenHeader(),
      payload: logBody({ clientEventId: "evt-single" }),
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.duplicate).toBe(false);
    expect(body.deviceKey).toBe("name:LUMEN-1A2B");
    expect(body.deviceKeyKind).toBe("name");

    const users = h.db.prepare("SELECT user_key FROM users").all();
    expect(users).toEqual([{ user_key: "openid-user-a" }]);

    const logs = h.db.prepare("SELECT device_name, platform, ended_at FROM usage_logs").all();
    expect(logs).toEqual([
      { device_name: "LUMEN-1A2B", platform: "android", ended_at: null },
    ]);
  });

  it("同一 clientEventId 重复补报是幂等的：只有一行，第二次返回 200", async () => {
    const payload = logBody({ clientEventId: "evt-replay" });
    const first = await h.app.inject({
      method: "POST",
      url: "/api/v1/usage-logs",
      headers: tokenHeader(),
      payload,
    });
    const second = await h.app.inject({
      method: "POST",
      url: "/api/v1/usage-logs",
      headers: tokenHeader(),
      payload,
    });

    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(200);
    expect(second.json().duplicate).toBe(true);
    expect(second.json().id).toBe(first.json().id);

    const count = h.db.prepare("SELECT COUNT(*) AS n FROM usage_logs").get() as { n: number };
    expect(count.n).toBe(1);
  });

  it("同一用户同一设备再次连接，自动收尾上一条未结束的会话", async () => {
    await h.app.inject({
      method: "POST",
      url: "/api/v1/usage-logs",
      headers: tokenHeader(),
      payload: logBody({ clientEventId: "evt-1", startedAt: 1_000 }),
    });
    await h.app.inject({
      method: "POST",
      url: "/api/v1/usage-logs",
      headers: tokenHeader(),
      payload: logBody({ clientEventId: "evt-2", startedAt: 2_000 }),
    });

    const rows = h.db
      .prepare("SELECT started_at, ended_at FROM usage_logs ORDER BY started_at")
      .all() as Array<{ started_at: number; ended_at: number | null }>;
    expect(rows).toEqual([
      { started_at: 1_000, ended_at: 2_000 },
      { started_at: 2_000, ended_at: null },
    ]);
  });

  it("没有 app token → 401，且不落库", async () => {
    const res = await h.app.inject({
      method: "POST",
      url: "/api/v1/usage-logs",
      payload: logBody({ clientEventId: "evt-no-token" }),
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe("unauthorized");

    const count = h.db.prepare("SELECT COUNT(*) AS n FROM usage_logs").get() as { n: number };
    expect(count.n).toBe(0);
  });

  it("app token 错误 → 401", async () => {
    const res = await h.app.inject({
      method: "POST",
      url: "/api/v1/usage-logs",
      headers: { "x-lumen-app-token": "wrong" },
      payload: logBody({ clientEventId: "evt-bad-token" }),
    });
    expect(res.statusCode).toBe(401);
  });

  it("缺 userKey / device 全空 → 400 且列出字段", async () => {
    const res = await h.app.inject({
      method: "POST",
      url: "/api/v1/usage-logs",
      headers: tokenHeader(),
      payload: {
        startedAt: 1_000,
        clientEventId: "evt-invalid",
        device: { platform: "android" },
      },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_payload");
    const fields = (res.json().details as Array<{ field: string }>).map((d) => d.field);
    expect(fields).toContain("userKey");
    expect(fields).toContain("device");
  });

  it("endedAt 早于 startedAt → 400", async () => {
    const res = await h.app.inject({
      method: "POST",
      url: "/api/v1/usage-logs",
      headers: tokenHeader(),
      payload: logBody({
        clientEventId: "evt-bad-range",
        startedAt: 5_000,
        endedAt: 4_000,
      }),
    });
    expect(res.statusCode).toBe(400);
    expect((res.json().details as Array<{ field: string }>).map((d) => d.field)).toContain(
      "endedAt",
    );
  });

  it("日志里不存任何控制数据：请求体里塞颜色/亮度也只落已知列", async () => {
    const res = await h.app.inject({
      method: "POST",
      url: "/api/v1/usage-logs",
      headers: tokenHeader(),
      payload: logBody({
        clientEventId: "evt-no-control-data",
        rgb: [255, 0, 0],
        brightness: 200,
        power: 1,
      }),
    });
    expect(res.statusCode).toBe(201);

    const columns = h.db
      .prepare("SELECT name FROM pragma_table_info('usage_logs')")
      .all() as Array<{ name: string }>;
    const names = columns.map((c) => c.name);
    expect(names).not.toContain("rgb");
    expect(names).not.toContain("brightness");
    expect(names).not.toContain("power");
  });
});

describe("admin 鉴权", () => {
  it("匿名访问看板 → 401 + WWW-Authenticate", async () => {
    const res = await h.app.inject({ method: "GET", url: "/admin/devices" });
    expect(res.statusCode).toBe(401);
    expect(res.headers["www-authenticate"]).toContain('Basic realm="lumen admin"');
    expect(res.body).toContain("看板不可匿名访问");
  });

  it("错误密码 → 401", async () => {
    const res = await h.app.inject({
      method: "GET",
      url: "/admin/users",
      headers: { authorization: basicAuth("admin", "nope") },
    });
    expect(res.statusCode).toBe(401);
  });

  it("错误用户名 → 401", async () => {
    const res = await h.app.inject({
      method: "GET",
      url: "/admin/users",
      headers: { authorization: basicAuth("root", ADMIN_PASSWORD) },
    });
    expect(res.statusCode).toBe(401);
  });

  it("malformed Authorization → 401", async () => {
    const res = await h.app.inject({
      method: "GET",
      url: "/admin/devices",
      headers: { authorization: "Basic not-base64!!" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("正确凭据 → 200 HTML", async () => {
    const res = await h.app.inject({
      method: "GET",
      url: "/admin/devices",
      headers: { authorization: basicAuth() },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/html");
  });
});
