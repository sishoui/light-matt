import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { APP_TOKEN, basicAuth, makeHarness, type Harness } from "./helpers.js";

/**
 * 设备登记 API。
 *
 * 约束（docs/spec-v3.md §2.2）：后端只存「谁登记过、备注名、最后在线、非权威缓存」，
 * **不存任何灯光配置**。设备 NVS 是唯一真相。
 *
 * 身份：`x-lumen-user-key` 头 + 共享 app token。这个头是**可伪造的自称**，
 * 与「不做访问控制」一致（spec-v3 §2.3）——本票刻意不做 HMAC / 会话令牌。
 */

const USER_A = "local-aaaaaaaaaaaaaaaa";
const USER_B = "local-bbbbbbbbbbbbbbbb";

let h: Harness;

beforeEach(async () => {
  h = await makeHarness();
});

afterEach(async () => {
  await h.close();
});

type Headers = Record<string, string>;

function auth(userKey: string | null = USER_A): Headers {
  const headers: Headers = { "x-lumen-app-token": APP_TOKEN };
  if (userKey !== null) headers["x-lumen-user-key"] = userKey;
  return headers;
}

/** 先建 users 行（设备路由只认已存在的 user_key）。 */
async function seedUser(userKey: string): Promise<void> {
  const res = await h.app.inject({
    method: "POST",
    url: "/api/v1/session",
    headers: { "x-lumen-app-token": APP_TOKEN },
    payload: { userKey },
  });
  expect(res.statusCode).toBe(200);
}

async function register(
  hardwareId: string,
  options: { userKey?: string; displayName?: string } = {},
): Promise<{ statusCode: number; body: Record<string, unknown> }> {
  const res = await h.app.inject({
    method: "POST",
    url: "/api/v1/devices/register",
    headers: auth(options.userKey ?? USER_A),
    payload:
      options.displayName === undefined
        ? { hardwareId }
        : { hardwareId, displayName: options.displayName },
  });
  return { statusCode: res.statusCode, body: res.json() as Record<string, unknown> };
}

async function listDevices(userKey = USER_A): Promise<{
  statusCode: number;
  body: { devices: Array<Record<string, unknown>> };
}> {
  const res = await h.app.inject({
    method: "GET",
    url: "/api/v1/devices",
    headers: auth(userKey),
  });
  return { statusCode: res.statusCode, body: res.json() as { devices: Array<Record<string, unknown>> } };
}

function deviceCount(): number {
  return (h.db.prepare("SELECT COUNT(*) AS n FROM devices").get() as { n: number }).n;
}

function linkCount(): number {
  return (h.db.prepare("SELECT COUNT(*) AS n FROM user_devices").get() as { n: number }).n;
}

describe("设备认证：app token + 自称 user key", () => {
  it("没有 app token → 401（五个设备路由都拦）", async () => {
    await seedUser(USER_A);
    const calls = [
      { method: "POST" as const, url: "/api/v1/devices/register", payload: { hardwareId: "AA:BB:CC:DD:EE:FF" } },
      { method: "GET" as const, url: "/api/v1/devices" },
      { method: "PATCH" as const, url: "/api/v1/devices/1", payload: { displayName: "x" } },
      { method: "DELETE" as const, url: "/api/v1/devices/1" },
      { method: "POST" as const, url: "/api/v1/devices/1/seen", payload: {} },
    ];
    for (const call of calls) {
      const res = await h.app.inject({ ...call, headers: { "x-lumen-user-key": USER_A } });
      expect(res.statusCode).toBe(401);
      expect(res.json().error).toBe("unauthorized");
    }
  });

  it("缺 x-lumen-user-key → 401", async () => {
    const res = await h.app.inject({
      method: "POST",
      url: "/api/v1/devices/register",
      headers: auth(null),
      payload: { hardwareId: "AA:BB:CC:DD:EE:FF" },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe("unauthorized");
  });

  it("未登记过的 user key → 404（不静默建用户）", async () => {
    const res = await h.app.inject({
      method: "GET",
      url: "/api/v1/devices",
      headers: auth(USER_A),
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe("unknown_user");
    const count = h.db.prepare("SELECT COUNT(*) AS n FROM users").get() as { n: number };
    expect(count.n).toBe(0);
  });
});

describe("POST /api/v1/devices/register", () => {
  beforeEach(async () => {
    await seedUser(USER_A);
  });

  it("首次登记返回 201 与 deviceId，硬件 id 归一为大写冒号 MAC", async () => {
    const res = await register("aa-bb-cc-dd-ee-ff");
    expect(res.statusCode).toBe(201);
    expect(res.body.hardwareId).toBe("AA:BB:CC:DD:EE:FF");
    expect(typeof res.body.deviceId).toBe("number");
    expect(deviceCount()).toBe(1);
    expect(linkCount()).toBe(1);

    const row = h.db.prepare("SELECT hardware_id FROM devices").get() as { hardware_id: string };
    expect(row.hardware_id).toBe("AA:BB:CC:DD:EE:FF");
  });

  it("同一 hardwareId 再登记：200、同一 deviceId、只有一行设备一条关联", async () => {
    const first = await register("AA:BB:CC:DD:EE:FF");
    const second = await register("AA:BB:CC:DD:EE:FF");

    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(200);
    expect(second.body.deviceId).toBe(first.body.deviceId);
    expect(deviceCount()).toBe(1);
    expect(linkCount()).toBe(1);
  });

  it("两种写法视为同一台设备（12 hex 与带冒号）", async () => {
    const first = await register("aabbccddeeff");
    const second = await register("AA:BB:CC:DD:EE:FF");
    expect(second.body.deviceId).toBe(first.body.deviceId);
    expect(deviceCount()).toBe(1);
  });

  it("第二位用户登记同一台设备：同一 deviceId，两条关联", async () => {
    await seedUser(USER_B);
    const a = await register("AA:BB:CC:DD:EE:FF", { userKey: USER_A });
    const b = await register("AA:BB:CC:DD:EE:FF", { userKey: USER_B });

    expect(b.body.deviceId).toBe(a.body.deviceId);
    expect(deviceCount()).toBe(1);
    expect(linkCount()).toBe(2);
  });

  it("hardwareId 缺失或格式非法 → 400", async () => {
    for (const hardwareId of [undefined, "", "not-a-mac", "AA:BB:CC:DD:EE", "AA:BB:CC:DD:EE:FF:00", 42]) {
      const res = await h.app.inject({
        method: "POST",
        url: "/api/v1/devices/register",
        headers: auth(),
        payload: { hardwareId },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe("invalid_payload");
      const fields = (res.json().details as Array<{ field: string }>).map((d) => d.field);
      expect(fields).toContain("hardwareId");
    }
    expect(deviceCount()).toBe(0);
  });

  it("登记时带备注名：写入本人关联，返回该名字", async () => {
    const res = await register("AA:BB:CC:DD:EE:FF", { displayName: "客厅灯带" });
    expect(res.statusCode).toBe(201);
    expect(res.body.displayName).toBe("客厅灯带");

    const list = await listDevices();
    expect(list.body.devices[0]?.displayName).toBe("客厅灯带");
  });

  it("请求体里塞灯光配置只落已知列（不存 rgb/brightness/segment/script）", async () => {
    const res = await h.app.inject({
      method: "POST",
      url: "/api/v1/devices/register",
      headers: auth(),
      payload: {
        hardwareId: "AA:BB:CC:DD:EE:FF",
        rgb: [255, 0, 0],
        brightness: 200,
        segment: { start: 0, end: 10 },
        script: ["stage-1"],
      },
    });
    expect(res.statusCode).toBe(201);

    const row = h.db.prepare("SELECT * FROM devices").get() as Record<string, unknown>;
    expect(Object.keys(row).sort()).toEqual(
      ["created_at", "display_name", "firmware_ver", "hardware_id", "id", "last_seen_at", "led_counts"].sort(),
    );
  });
});

describe("devices 表结构：没有任何灯光配置列", () => {
  it("列名里不存在 rgb / brightness / segment / script / stage / color / power", () => {
    for (const table of ["devices", "user_devices"]) {
      const columns = h.db
        .prepare(`SELECT name FROM pragma_table_info('${table}')`)
        .all() as Array<{ name: string }>;
      const names = columns.map((c) => c.name.toLowerCase());
      for (const forbidden of ["rgb", "brightness", "segment", "segments", "script", "scripts", "stage", "stages", "color", "colour", "power", "effect", "led_count"]) {
        expect(names, `${table} 不应有 ${forbidden}`).not.toContain(forbidden);
      }
    }
  });

  it("两张新表都是 STRICT（类型不会被静默放宽）", () => {
    const rows = h.db
      .prepare("SELECT name, sql FROM sqlite_master WHERE type='table' AND name IN ('devices','user_devices')")
      .all() as Array<{ name: string; sql: string }>;
    expect(rows).toHaveLength(2);
    for (const row of rows) expect(row.sql.toUpperCase()).toContain("STRICT");
  });
});

describe("GET /api/v1/devices", () => {
  beforeEach(async () => {
    await seedUser(USER_A);
    await seedUser(USER_B);
  });

  it("只返回当前 user 关联的设备", async () => {
    const a = await register("AA:BB:CC:DD:EE:01", { userKey: USER_A });
    const b = await register("AA:BB:CC:DD:EE:02", { userKey: USER_B });

    const listA = await listDevices(USER_A);
    expect(listA.statusCode).toBe(200);
    expect(listA.body.devices.map((d) => d.id)).toEqual([a.body.deviceId]);
    expect(listA.body.devices.map((d) => d.hardwareId)).toEqual(["AA:BB:CC:DD:EE:01"]);

    const listB = await listDevices(USER_B);
    expect(listB.body.devices.map((d) => d.id)).toEqual([b.body.deviceId]);
  });

  it("按 last_seen_at 倒序，其次 id 升序", async () => {
    const old = await register("AA:BB:CC:DD:EE:01");
    const mid = await register("AA:BB:CC:DD:EE:02");
    const recent = await register("AA:BB:CC:DD:EE:03");
    // 直接改库，避免依赖真实时钟（毫秒相同会让顺序不稳定）
    h.db.prepare("UPDATE devices SET last_seen_at = ? WHERE id = ?").run(1_000, Number(old.body.deviceId));
    h.db.prepare("UPDATE devices SET last_seen_at = ? WHERE id = ?").run(3_000, Number(recent.body.deviceId));
    h.db.prepare("UPDATE devices SET last_seen_at = ? WHERE id = ?").run(2_000, Number(mid.body.deviceId));

    const list = await listDevices();
    expect(list.body.devices.map((d) => d.id)).toEqual([
      recent.body.deviceId,
      mid.body.deviceId,
      old.body.deviceId,
    ]);
  });

  it("响应字段是 camelCase，缓存字段可空", async () => {
    await register("AA:BB:CC:DD:EE:FF");
    const list = await listDevices();
    const device = list.body.devices[0];
    expect(device).toBeDefined();
    expect(Object.keys(device ?? {}).sort()).toEqual(
      ["id", "hardwareId", "displayName", "lastSeenAt", "addedAt", "ledCounts", "firmwareVer"].sort(),
    );
    expect(device?.ledCounts).toBeNull();
    expect(device?.firmwareVer).toBeNull();
  });
});

describe("PATCH /api/v1/devices/:id —— 备注名", () => {
  beforeEach(async () => {
    await seedUser(USER_A);
    await seedUser(USER_B);
  });

  async function rename(
    deviceId: number,
    payload: unknown,
    userKey = USER_A,
  ): Promise<{ statusCode: number; body: Record<string, unknown> }> {
    const res = await h.app.inject({
      method: "PATCH",
      url: `/api/v1/devices/${deviceId}`,
      headers: auth(userKey),
      payload: payload as Record<string, unknown>,
    });
    return { statusCode: res.statusCode, body: res.json() as Record<string, unknown> };
  }

  it("改名成功并出现在列表里", async () => {
    const reg = await register("AA:BB:CC:DD:EE:FF");
    const res = await rename(Number(reg.body.deviceId), { displayName: "  卧室  " });
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ id: reg.body.deviceId, displayName: "卧室" });

    const list = await listDevices();
    expect(list.body.devices[0]?.displayName).toBe("卧室");
  });

  it("备注名按 user 隔离：同一设备两人各用各的名字", async () => {
    const reg = await register("AA:BB:CC:DD:EE:FF", { userKey: USER_A });
    await register("AA:BB:CC:DD:EE:FF", { userKey: USER_B });
    const deviceId = Number(reg.body.deviceId);

    await rename(deviceId, { displayName: "A 的名字" }, USER_A);
    await rename(deviceId, { displayName: "B 的名字" }, USER_B);

    const listA = await listDevices(USER_A);
    const listB = await listDevices(USER_B);
    expect(listA.body.devices[0]?.displayName).toBe("A 的名字");
    expect(listB.body.devices[0]?.displayName).toBe("B 的名字");
  });

  it("只登记了设备的用户才看得到自己的名字，回落到全局默认", async () => {
    const reg = await register("AA:BB:CC:DD:EE:FF", { userKey: USER_A, displayName: "全局默认" });
    await register("AA:BB:CC:DD:EE:FF", { userKey: USER_B });

    // B 没有自己的备注 → 返回 devices.display_name 这个非权威默认值
    const listB = await listDevices(USER_B);
    expect(listB.body.devices[0]?.displayName).toBe("全局默认");
    expect(reg.body.displayName).toBe("全局默认");
  });

  it("超长（>128）→ 400，且不改库", async () => {
    const reg = await register("AA:BB:CC:DD:EE:FF", { displayName: "原名" });
    const res = await rename(Number(reg.body.deviceId), { displayName: "长".repeat(129) });
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe("invalid_payload");

    const list = await listDevices();
    expect(list.body.devices[0]?.displayName).toBe("原名");
  });

  it("空串 / 纯空白 → 400", async () => {
    const reg = await register("AA:BB:CC:DD:EE:FF");
    for (const displayName of ["", "   ", "\t\n"]) {
      const res = await rename(Number(reg.body.deviceId), { displayName });
      expect(res.statusCode).toBe(400);
      expect((res.body.details as Array<{ field: string }>).map((d) => d.field)).toContain(
        "displayName",
      );
    }
  });

  it("非本人关联的设备 → 404（不能改别人的备注）", async () => {
    const reg = await register("AA:BB:CC:DD:EE:FF", { userKey: USER_A });
    const res = await rename(Number(reg.body.deviceId), { displayName: "B 想改" }, USER_B);
    expect(res.statusCode).toBe(404);
    expect(res.body.error).toBe("device_not_found");
  });

  it("不存在的 id → 404；非数字 id → 400", async () => {
    const missing = await rename(9999, { displayName: "x" });
    expect(missing.statusCode).toBe(404);

    const bad = await h.app.inject({
      method: "PATCH",
      url: "/api/v1/devices/1abc",
      headers: auth(),
      payload: { displayName: "x" },
    });
    expect(bad.statusCode).toBe(400);
  });

  it("HTML 原样入库，看板渲染时转义", async () => {
    const reg = await register("AA:BB:CC:DD:EE:FF");
    const raw = `<script>alert("x")</script>`;
    await rename(Number(reg.body.deviceId), { displayName: raw });

    const stored = h.db.prepare("SELECT display_name FROM devices").get() as { display_name: string };
    expect(stored.display_name).toBe(raw);

    const page = await h.app.inject({
      method: "GET",
      url: "/admin/registry",
      headers: { authorization: basicAuth() },
    });
    expect(page.statusCode).toBe(200);
    expect(page.body).not.toContain(raw);
    expect(page.body).toContain("&lt;script&gt;");
  });
});

describe("DELETE /api/v1/devices/:id —— 只解除关联", () => {
  beforeEach(async () => {
    await seedUser(USER_A);
    await seedUser(USER_B);
  });

  it("删除后列表不再返回该设备，但 devices 行保留", async () => {
    const reg = await register("AA:BB:CC:DD:EE:FF");
    const deviceId = Number(reg.body.deviceId);

    const res = await h.app.inject({
      method: "DELETE",
      url: `/api/v1/devices/${deviceId}`,
      headers: auth(),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ deleted: true });

    expect(deviceCount()).toBe(1);
    expect(linkCount()).toBe(0);
    const list = await listDevices();
    expect(list.body.devices).toEqual([]);
  });

  it("重新登记同一台设备：复用原 deviceId", async () => {
    const reg = await register("AA:BB:CC:DD:EE:FF");
    const deviceId = Number(reg.body.deviceId);
    await h.app.inject({ method: "DELETE", url: `/api/v1/devices/${deviceId}`, headers: auth() });

    const again = await register("AA:BB:CC:DD:EE:FF");
    expect(again.statusCode).toBe(200);
    expect(again.body.deviceId).toBe(deviceId);
    expect(deviceCount()).toBe(1);
    expect(linkCount()).toBe(1);
  });

  it("删除别人登记的设备关联 → 404，关联不动", async () => {
    // B 没登记这台设备，所以对 B 来说是「不在你的列表里」
    const reg = await register("AA:BB:CC:DD:EE:FF", { userKey: USER_A });
    const deviceId = Number(reg.body.deviceId);

    const res = await h.app.inject({
      method: "DELETE",
      url: `/api/v1/devices/${deviceId}`,
      headers: auth(USER_B),
    });
    expect(res.statusCode).toBe(404);
    expect(linkCount()).toBe(1);
  });

  it("两人都登记时，删一次只删掉自己的关联", async () => {
    const reg = await register("AA:BB:CC:DD:EE:FF", { userKey: USER_A });
    await register("AA:BB:CC:DD:EE:FF", { userKey: USER_B });
    const deviceId = Number(reg.body.deviceId);

    const res = await h.app.inject({
      method: "DELETE",
      url: `/api/v1/devices/${deviceId}`,
      headers: auth(USER_B),
    });
    expect(res.statusCode).toBe(200);
    expect(linkCount()).toBe(1);
    expect((await listDevices(USER_A)).body.devices).toHaveLength(1);
    expect((await listDevices(USER_B)).body.devices).toHaveLength(0);
  });

  it("从未关联过的 id → 404", async () => {
    const res = await h.app.inject({
      method: "DELETE",
      url: "/api/v1/devices/42",
      headers: auth(),
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("POST /api/v1/devices/:id/seen —— 缓存与最后在线", () => {
  beforeEach(async () => {
    await seedUser(USER_A);
    await seedUser(USER_B);
  });

  async function seen(
    deviceId: number,
    payload: Record<string, unknown>,
    userKey = USER_A,
  ): Promise<{ statusCode: number; body: Record<string, unknown> }> {
    const res = await h.app.inject({
      method: "POST",
      url: `/api/v1/devices/${deviceId}/seen`,
      headers: auth(userKey),
      payload,
    });
    return { statusCode: res.statusCode, body: res.json() as Record<string, unknown> };
  }

  it("写入 led_counts JSON、firmware_ver，并推进 last_seen_at", async () => {
    const reg = await register("AA:BB:CC:DD:EE:FF");
    const deviceId = Number(reg.body.deviceId);
    h.db.prepare("UPDATE devices SET last_seen_at = 1 WHERE id = ?").run(deviceId);

    const res = await seen(deviceId, { ledCounts: [30, 60], firmwareVer: 3 });
    expect(res.statusCode).toBe(200);
    expect(res.body.id).toBe(deviceId);
    expect(res.body.ledCounts).toEqual([30, 60]);
    expect(res.body.firmwareVer).toBe(3);

    const row = h.db.prepare("SELECT last_seen_at, led_counts, firmware_ver FROM devices").get() as {
      last_seen_at: number;
      led_counts: string;
      firmware_ver: number;
    };
    expect(row.last_seen_at).toBeGreaterThan(1);
    expect(row.led_counts).toBe("[30,60]");
    expect(row.firmware_ver).toBe(3);
  });

  it("只给部分字段时保留旧缓存（COALESCE，不写 null）", async () => {
    const reg = await register("AA:BB:CC:DD:EE:FF");
    const deviceId = Number(reg.body.deviceId);
    await seen(deviceId, { ledCounts: [64], firmwareVer: 2 });

    const res = await seen(deviceId, {});
    expect(res.statusCode).toBe(200);
    expect(res.body.ledCounts).toEqual([64]);
    expect(res.body.firmwareVer).toBe(2);
  });

  it("请求体里的灯光配置字段全部忽略", async () => {
    const reg = await register("AA:BB:CC:DD:EE:FF");
    const deviceId = Number(reg.body.deviceId);

    const res = await seen(deviceId, {
      ledCounts: [10, 20],
      firmwareVer: 1,
      rgb: [255, 0, 0],
      brightness: 128,
      segment: { start: 0, end: 4 },
      script: ["x"],
      stage: 2,
      power: true,
    });
    expect(res.statusCode).toBe(200);

    const row = h.db.prepare("SELECT * FROM devices WHERE id = ?").get(deviceId) as Record<string, unknown>;
    expect(Object.keys(row).sort()).toEqual(
      ["created_at", "display_name", "firmware_ver", "hardware_id", "id", "last_seen_at", "led_counts"].sort(),
    );
    expect(row.led_counts).toBe("[10,20]");
  });

  it("非法 ledCounts / firmwareVer → 400", async () => {
    const reg = await register("AA:BB:CC:DD:EE:FF");
    const deviceId = Number(reg.body.deviceId);

    const bad = [
      { ledCounts: "abc" },
      { ledCounts: [-1] },
      { ledCounts: [0] },
      { ledCounts: [1.5] },
      { ledCounts: Array.from({ length: 17 }, () => 1) },
      { firmwareVer: -1 },
      { firmwareVer: 70_000 },
      { firmwareVer: 1.5 },
    ];
    for (const payload of bad) {
      const res = await seen(deviceId, payload);
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
      expect(res.body.error).toBe("invalid_payload");
    }
  });

  it("别人的设备 → 404，且不动缓存", async () => {
    const reg = await register("AA:BB:CC:DD:EE:FF", { userKey: USER_A });
    const deviceId = Number(reg.body.deviceId);

    const res = await seen(deviceId, { firmwareVer: 9 }, USER_B);
    expect(res.statusCode).toBe(404);
    const row = h.db.prepare("SELECT firmware_ver FROM devices WHERE id = ?").get(deviceId) as {
      firmware_ver: number | null;
    };
    expect(row.firmware_ver).toBeNull();
  });
});

describe("admin 设备登记页（只读）", () => {
  beforeEach(async () => {
    await seedUser(USER_A);
  });

  it("/admin/registry 列出硬件 id、备注名、时间与标注为非权威的缓存", async () => {
    const reg = await register("AA:BB:CC:DD:EE:FF", { displayName: "书架" });
    await h.app.inject({
      method: "POST",
      url: `/api/v1/devices/${String(reg.body.deviceId)}/seen`,
      headers: auth(),
      payload: { ledCounts: [64], firmwareVer: 2 },
    });

    const res = await h.app.inject({
      method: "GET",
      url: "/admin/registry",
      headers: { authorization: basicAuth() },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("AA:BB:CC:DD:EE:FF");
    expect(res.body).toContain("书架");
    expect(res.body).toContain("[64]");
    expect(res.body).toContain("非权威");
  });

  it("匿名访问 → 401", async () => {
    const res = await h.app.inject({ method: "GET", url: "/admin/registry" });
    expect(res.statusCode).toBe(401);
  });

  it("/admin/devices 页给出到登记页的链接", async () => {
    const res = await h.app.inject({
      method: "GET",
      url: "/admin/devices",
      headers: { authorization: basicAuth() },
    });
    expect(res.body).toContain("/admin/registry");
  });
});
