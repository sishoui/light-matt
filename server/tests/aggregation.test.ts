import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveDeviceKey } from "../src/identity.js";
import { APP_TOKEN, logBody, makeHarness, type Harness } from "./helpers.js";

let h: Harness;

beforeEach(async () => {
  h = await makeHarness();
});

afterEach(async () => {
  await h.close();
});

async function post(payload: Record<string, unknown>): Promise<void> {
  const res = await h.app.inject({
    method: "POST",
    url: "/api/v1/usage-logs",
    headers: { "x-lumen-app-token": APP_TOKEN },
    payload,
  });
  if (res.statusCode !== 201) {
    throw new Error(`写入失败 ${res.statusCode}: ${res.body}`);
  }
}

describe("设备聚合（跨手机归一）", () => {
  it("同一台设备在 Android 与 iOS 上 deviceId 不同，但广播名相同 → 聚成一台", async () => {
    // 同一台物理设备：广播名都是 Lumen-1A2B。
    // Android 看到的 deviceId 是 MAC；iOS 看到的是系统 UUID。
    await post(
      logBody({
        clientEventId: "agg-android",
        startedAt: 1_000,
        device: {
          deviceName: "Lumen-1A2B",
          deviceId: "AA:BB:CC:DD:1A:2B",
          platform: "android",
        },
      }),
    );
    await post(
      logBody({
        clientEventId: "agg-ios",
        startedAt: 2_000,
        device: {
          deviceName: "Lumen-1A2B",
          deviceId: "8B5F4A2C-1111-2222-3333-444455556666",
          platform: "ios",
        },
      }),
    );

    const res = await h.app.inject({
      method: "GET",
      url: "/admin/devices",
      headers: { authorization: "Basic " + Buffer.from("admin:test-admin-password").toString("base64") },
    });
    expect(res.statusCode).toBe(200);

    const devices = h.db.prepare("SELECT * FROM v_devices").all() as Array<{
      device_key: string;
      device_name: string;
      use_count: number;
      user_count: number;
      mac_count: number;
    }>;
    expect(devices).toHaveLength(1);
    expect(devices[0]).toMatchObject({
      device_key: "name:LUMEN-1A2B",
      device_name: "LUMEN-1A2B",
      use_count: 2,
      user_count: 1,
      mac_count: 1,
    });
  });

  it("两台不同设备用了同一个广播名（撞车）→ 仍算一台，但看板会标出 mac_count = 2", async () => {
    await post(
      logBody({
        clientEventId: "collide-1",
        device: { deviceName: "Lumen-FFFF", deviceId: "11:22:33:44:FF:FF", platform: "android" },
      }),
    );
    await post(
      logBody({
        clientEventId: "collide-2",
        device: { deviceName: "Lumen-FFFF", deviceId: "11:22:33:44:FF:FE", platform: "android" },
      }),
    );

    const row = h.db
      .prepare("SELECT use_count, mac_count FROM v_devices WHERE device_key = 'name:LUMEN-FFFF'")
      .get() as { use_count: number; mac_count: number };
    expect(row).toEqual({ use_count: 2, mac_count: 2 });
  });

  it("有 hardwareId 时以硬件 id 为准，广播名只作为展示", async () => {
    await post(
      logBody({
        clientEventId: "hw-1",
        device: { hardwareId: "24:6F:28:AA:BB:CC", deviceName: "Lumen-1A2B", platform: "android" },
      }),
    );
    await post(
      logBody({
        clientEventId: "hw-2",
        device: { hardwareId: "24:6F:28:AA:BB:CC", deviceName: "Lumen-FFFF", platform: "ios" },
      }),
    );

    const rows = h.db.prepare("SELECT device_key, use_count FROM v_devices").all();
    expect(rows).toEqual([{ device_key: "hw:24:6f:28:aa:bb:cc", use_count: 2 }]);
  });

  it("没有广播名时按 platform+deviceId 兜底，分组按手机分裂但数据不丢", async () => {
    await post(
      logBody({
        clientEventId: "raw-1",
        device: { deviceId: "AA:BB:CC:DD:EE:FF", platform: "android" },
      }),
    );

    const rows = h.db.prepare("SELECT device_key FROM v_devices").all();
    expect(rows).toEqual([{ device_key: "raw:android:aa:bb:cc:dd:ee:ff" }]);
  });

  it("v_devices 的 use_count 是会话数（每行一条），不是心跳", async () => {
    for (let i = 0; i < 5; i += 1) {
      await post(
        logBody({
          clientEventId: `count-${i}`,
          startedAt: 1_000 + i * 10_000,
          device: { deviceName: "Lumen-0001", platform: "android" },
        }),
      );
    }
    const row = h.db
      .prepare("SELECT use_count FROM v_devices WHERE device_key = 'name:LUMEN-0001'")
      .get() as { use_count: number };
    expect(row.use_count).toBe(5);
  });

  it("last_seen_at 取 ended_at 与 started_at 中较大的那条", async () => {
    await post(
      logBody({
        clientEventId: "last-1",
        startedAt: 1_000,
        endedAt: 9_000,
        device: { deviceName: "Lumen-0002", platform: "android" },
      }),
    );
    const row = h.db
      .prepare("SELECT last_seen_at FROM v_devices WHERE device_key = 'name:LUMEN-0002'")
      .get() as { last_seen_at: number };
    expect(row.last_seen_at).toBe(9_000);
  });
});

describe("resolveDeviceKey 单元规则", () => {
  it("优先级 hardware > name > raw", () => {
    expect(
      resolveDeviceKey({
        hardwareId: " AB:CD ",
        deviceName: "lumen-1a2b",
        deviceId: "uuid",
        platform: "ios",
      }),
    ).toEqual({ key: "hw:ab:cd", kind: "hardware", name: "LUMEN-1A2B" });

    expect(
      resolveDeviceKey({ deviceName: " lumen-1a2b ", deviceId: "uuid", platform: "ios" }),
    ).toEqual({ key: "name:LUMEN-1A2B", kind: "name", name: "LUMEN-1A2B" });

    expect(
      resolveDeviceKey({ deviceName: null, deviceId: "UUID-A", platform: "ios" }),
    ).toEqual({ key: "raw:ios:uuid-a", kind: "raw", name: null });
  });

  it("完全没有设备标识时抛错（由校验层提前拦成 400）", () => {
    expect(() =>
      resolveDeviceKey({ hardwareId: "", deviceName: "   ", deviceId: null, platform: "unknown" }),
    ).toThrow(/hardwareId/);
  });
});
