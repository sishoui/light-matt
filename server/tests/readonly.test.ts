import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { APP_TOKEN, basicAuth, logBody, makeHarness, type Harness } from "./helpers.js";

let h: Harness;

beforeEach(async () => {
  h = await makeHarness();
});

afterEach(async () => {
  await h.close();
});

async function seedOneLog(): Promise<void> {
  const res = await h.app.inject({
    method: "POST",
    url: "/api/v1/usage-logs",
    headers: { "x-lumen-app-token": APP_TOKEN },
    payload: logBody({
      clientEventId: "seed-admin-read",
      startedAt: 1_760_000_000_000,
      endedAt: 1_760_000_060_000,
      device: { deviceName: "Lumen-BEEF", deviceId: "AA:BB:CC:DD:BE:EF", platform: "android" },
    }),
  });
  expect(res.statusCode).toBe(201);
}

describe("只读看板：内容", () => {
  it("/admin/devices 显示设备、使用次数与最后出现时间", async () => {
    await seedOneLog();
    const res = await h.app.inject({
      method: "GET",
      url: "/admin/devices",
      headers: { authorization: basicAuth() },
    });

    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("LUMEN-BEEF");
    expect(res.body).toContain("name:LUMEN-BEEF");
    expect(res.body).toContain(">1<"); // use_count
    expect(res.body).toContain("UTC");
  });

  it("/admin/users 列出用户", async () => {
    await seedOneLog();
    const res = await h.app.inject({
      method: "GET",
      url: "/admin/users",
      headers: { authorization: basicAuth() },
    });

    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("小明");
    expect(res.body).toContain("openid-user-a");
  });

  it("/admin/ 重定向到设备列表", async () => {
    const res = await h.app.inject({
      method: "GET",
      url: "/admin/",
      headers: { authorization: basicAuth() },
    });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe("/admin/devices");
  });

  it("HTML 里没有任何表单或写操作控件", async () => {
    await seedOneLog();
    for (const url of ["/admin/devices", "/admin/users"]) {
      const res = await h.app.inject({
        method: "GET",
        url,
        headers: { authorization: basicAuth() },
      });
      expect(res.statusCode).toBe(200);
      expect(res.body).not.toMatch(/<form/i);
      expect(res.body).not.toMatch(/<input/i);
      expect(res.body).not.toMatch(/<button/i);
      expect(res.body).not.toMatch(/<textarea/i);
      expect(res.body).not.toMatch(/method\s*=\s*["']?post/i);
    }
  });
});

describe("只读看板：没有任何写路由", () => {
  const writes = ["POST", "PUT", "PATCH", "DELETE"] as const;
  const targets = [
    "/admin/devices",
    "/admin/users",
    "/admin/",
    "/admin",
    "/admin/devices/1",
    "/admin/users/1",
    "/admin/logs",
  ];

  for (const method of writes) {
    for (const url of targets) {
      it(`${method} ${url} → 405（不是 404，也不是被某个写路由吞掉）`, async () => {
        const res = await h.app.inject({
          method,
          url,
          headers: { authorization: basicAuth(), "content-type": "application/json" },
          payload: { deviceName: "hacked" },
        });
        expect(res.statusCode).toBe(405);
        expect(res.headers.allow).toContain("GET");
      });
    }
  }

  it("写方法即使带正确凭据也不能改数据", async () => {
    await seedOneLog();
    const before = h.db.prepare("SELECT COUNT(*) AS n FROM usage_logs").get() as { n: number };

    await h.app.inject({
      method: "DELETE",
      url: "/admin/devices",
      headers: { authorization: basicAuth() },
    });
    await h.app.inject({
      method: "PUT",
      url: "/admin/users",
      headers: { authorization: basicAuth(), "content-type": "application/json" },
      payload: { displayName: "renamed" },
    });

    const after = h.db.prepare("SELECT COUNT(*) AS n FROM usage_logs").get() as { n: number };
    const user = h.db.prepare("SELECT display_name FROM users").get() as {
      display_name: string;
    };
    expect(after.n).toBe(before.n);
    expect(user.display_name).toBe("小明");
  });

  it("匿名写方法也是 401（鉴权先于 405，不泄露路由形状）", async () => {
    const res = await h.app.inject({ method: "POST", url: "/admin/devices", payload: {} });
    expect(res.statusCode).toBe(401);
    expect(res.headers["www-authenticate"]).toBeDefined();
  });
});

describe("公共端点", () => {
  it("/health 不需要鉴权", async () => {
    const res = await h.app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
  });

  it("不存在的路径 → 404", async () => {
    const res = await h.app.inject({ method: "GET", url: "/nope" });
    expect(res.statusCode).toBe(404);
  });
});
