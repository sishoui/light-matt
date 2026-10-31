/**
 * #44 设备同步编排（`utils/control/device-sync.ts`）。
 *
 * 这一层固定「本地先写、后端后同步」的顺序，并保证**任何同步失败都不影响
 * BLE 控制**：
 *  - 连接成功 → register（幂等）→ seen；两次都失败也只置 offline；
 *  - 改名：本地已写过，PATCH 失败只影响别的手机；
 *  - 删除：只删后端关联，设备仍能被重新扫描到；
 *  - `identityKind === "local"` 要能透出给页面。
 *
 * 假件只替换 api 与 storage。
 */

import { describe, expect, it } from "vitest";

import type { SessionStorage } from "../utils/control/device-cache";
import { loadRegistry, setHardwareId, setRemark } from "../utils/control/device-registry";
import {
  DeviceSync,
  type DeviceSyncApi,
  type ConnectedFacts,
} from "../utils/control/device-sync";
import type { SyncedDevice } from "../utils/control/device-api";
import type { IdentityKind } from "../utils/control/device-api";

function memoryStorage(seed: Record<string, string> = {}): SessionStorage {
  const map = new Map(Object.entries(seed));
  return {
    get: (key) => map.get(key) ?? null,
    set: (key, value) => {
      map.set(key, value);
    },
    remove: (key) => {
      map.delete(key);
    },
  };
}

const HW = "AA:BB:CC:DD:EE:FF";

type IdentityResult =
  | { ok: true; value: { userKey: string; identityKind: IdentityKind; trusted: boolean } }
  | { ok: false; reason: string };

/** 可编排的假 api：记录调用顺序，按用例设定成败。 */
class FakeApi implements DeviceSyncApi {
  enabled = true;
  identityKind: IdentityKind = "local";
  identityOk = true;
  listOk = true;
  registerOk = true;
  renameOk = true;
  deleteOk = true;
  seenOk = true;

  calls: string[] = [];
  registered: Array<{ hardwareId: string; displayName: string | null | undefined }> = [];
  renames: Array<{ deviceId: number; displayName: string }> = [];
  deletes: number[] = [];
  seen: Array<{ deviceId: number; body: unknown }> = [];
  devices: SyncedDevice[] = [];
  /** register 分配的后端 id（默认 7）。 */
  registeredId = 7;

  ensureIdentity(): Promise<IdentityResult> {
    this.calls.push("session");
    if (!this.identityOk) {
      return Promise.resolve({ ok: false, reason: "offline" });
    }
    return Promise.resolve({
      ok: true,
      value: {
        userKey: "local-0123456789abcdef",
        identityKind: this.identityKind,
        trusted: this.identityKind === "openid",
      },
    });
  }

  listDevices() {
    this.calls.push("list");
    return Promise.resolve(
      this.listOk ? { ok: true as const, value: this.devices } : { ok: false as const, reason: "offline" },
    );
  }

  registerDevice(hardwareId: string, displayName?: string | null) {
    this.calls.push("register");
    this.registered.push({ hardwareId, displayName });
    return Promise.resolve(
      this.registerOk
        ? {
            ok: true as const,
            value: { deviceId: this.registeredId, hardwareId, displayName: displayName ?? null },
          }
        : { ok: false as const, reason: "offline" },
    );
  }

  renameDevice(deviceId: number, displayName: string) {
    this.calls.push("rename");
    this.renames.push({ deviceId, displayName });
    return Promise.resolve({ ok: this.renameOk });
  }

  deleteDevice(deviceId: number) {
    this.calls.push("delete");
    this.deletes.push(deviceId);
    return Promise.resolve({ ok: this.deleteOk });
  }

  markSeen(deviceId: number, seen: { ledCounts?: number[] | null; firmwareVer?: number | null } = {}) {
    this.calls.push("seen");
    this.seen.push({ deviceId, body: seen });
    return Promise.resolve(
      this.seenOk
        ? { ok: true as const, value: { id: deviceId } }
        : { ok: false as const, reason: "offline" },
    );
  }
}

function facts(overrides: Partial<ConnectedFacts> = {}): ConnectedFacts {
  return {
    deviceId: "DEV-A",
    hardwareId: HW,
    ledCounts: [30, 20],
    firmwareVer: 0x300,
    ...overrides,
  };
}

describe("#44 连接后的登记与 seen", () => {
  it("顺序是 session → register → seen，且 seen 只有缓存字段", async () => {
    const api = new FakeApi();
    const storage = memoryStorage();
    const sync = new DeviceSync({ api, storage });

    await sync.noteConnected(facts());

    expect(api.calls).toEqual(["session", "register", "seen"]);
    /* 没给备注名就传 null（后端 PATCH 语义：null 表示「不改名」）。 */
    expect(api.registered[0]).toEqual({ hardwareId: HW, displayName: null });
    expect(api.seen[0]).toEqual({
      deviceId: 7,
      body: { ledCounts: [30, 20], firmwareVer: 0x300 },
    });
    /* 后端 id 落到登记表：下次不必再 register。 */
    const registry = loadRegistry(storage);
    expect(
      registry.devices.find((entry) => entry.deviceId === "DEV-A")?.backendId,
    ).toBe(7);
    expect(sync.offline).toBe(false);
  });

  it("第二次连接同一台设备：不再打 register（本地已有后端 id）", async () => {
    const api = new FakeApi();
    const storage = memoryStorage();
    const sync = new DeviceSync({ api, storage });

    await sync.noteConnected(facts());
    api.calls = [];
    await sync.noteConnected(facts());

    expect(api.calls).toEqual(["seen"]);
  });

  it("后端全挂：不抛错，只置 offline（BLE 控制不受影响）", async () => {
    const api = new FakeApi();
    api.identityOk = false;
    const sync = new DeviceSync({ api, storage: memoryStorage() });

    await expect(sync.noteConnected(facts())).resolves.toBeUndefined();
    expect(sync.offline).toBe(true);
  });

  it("register 失败时不再发 seen", async () => {
    const api = new FakeApi();
    api.registerOk = false;
    const sync = new DeviceSync({ api, storage: memoryStorage() });

    await sync.noteConnected(facts());
    expect(api.calls).toEqual(["session", "register"]);
    expect(sync.offline).toBe(true);
  });

  it("没有 hardwareId 的设备不登记（后端主键就是它，不能编造）", async () => {
    const api = new FakeApi();
    const sync = new DeviceSync({ api, storage: memoryStorage() });
    await sync.noteConnected(facts({ hardwareId: "" }));
    expect(api.calls).toEqual([]);
  });

  it("未配置后端（api === null）时一切静默", async () => {
    const sync = new DeviceSync({ api: null, storage: memoryStorage() });
    expect(sync.enabled).toBe(false);
    await sync.noteConnected(facts());
    expect(await sync.refreshRemote()).toBeNull();
    expect(await sync.ensureIdentity()).toBeNull();
  });
});

describe("#44 拉取后端列表", () => {
  it("成功时返回列表并缓存 hardwareId → backendId", async () => {
    const api = new FakeApi();
    const storage = memoryStorage();
    setHardwareId(storage, "DEV-A", HW);
    api.devices = [
      {
        id: 9,
        hardwareId: HW,
        displayName: "书桌",
        lastSeenAt: 1000,
        addedAt: 1,
        ledCounts: [30],
        firmwareVer: 700,
      },
    ];
    const sync = new DeviceSync({ api, storage });

    const result = await sync.refreshRemote();
    expect(result).toHaveLength(1);
    expect(api.calls).toEqual(["session", "list"]);
    expect(loadRegistry(storage).devices.find((e) => e.deviceId === "DEV-A")?.backendId).toBe(9);
    expect(sync.offline).toBe(false);
  });

  it("失败返回 null（页面保留本地列表），并置 offline", async () => {
    const api = new FakeApi();
    api.listOk = false;
    const sync = new DeviceSync({ api, storage: memoryStorage() });
    expect(await sync.refreshRemote()).toBeNull();
    expect(sync.offline).toBe(true);
  });
});

describe("#44 备注名与删除", () => {
  it("改名：本地已有备注时 PATCH，用的是缓存的后端 id", async () => {
    const api = new FakeApi();
    const storage = memoryStorage();
    setRemark(storage, "DEV-A", "书桌");
    setHardwareId(storage, "DEV-A", HW);
    const sync = new DeviceSync({ api, storage });
    await sync.noteConnected(facts()); // 建立 backendId
    api.calls = [];

    const ok = await sync.pushRemark({ deviceId: "DEV-A", hardwareId: HW });
    expect(ok).toBe(true);
    expect(api.renames).toEqual([{ deviceId: 7, displayName: "书桌" }]);
  });

  it("本地没有备注时不 PATCH（没有可同步的东西）", async () => {
    const api = new FakeApi();
    const storage = memoryStorage();
    setHardwareId(storage, "DEV-A", HW);
    const sync = new DeviceSync({ api, storage });
    expect(await sync.pushRemark({ deviceId: "DEV-A", hardwareId: HW })).toBe(false);
    expect(api.calls).toEqual([]);
  });

  it("PATCH 失败不影响本地备注（本地早已落盘）", async () => {
    const api = new FakeApi();
    api.renameOk = false;
    const storage = memoryStorage();
    setRemark(storage, "DEV-A", "书桌");
    const sync = new DeviceSync({ api, storage });
    await sync.noteConnected(facts());
    expect(await sync.pushRemark({ deviceId: "DEV-A", hardwareId: HW })).toBe(false);
    expect(loadRegistry(storage).devices.find((e) => e.deviceId === "DEV-A")?.remark).toBe("书桌");
    expect(sync.offline).toBe(true);
  });

  it("删除只发 DELETE，不碰本地记录（设备还能重新扫到）", async () => {
    const api = new FakeApi();
    const storage = memoryStorage();
    setRemark(storage, "DEV-A", "书桌");
    const sync = new DeviceSync({ api, storage });

    expect(await sync.unlink(7)).toBe(true);
    expect(api.deletes).toEqual([7]);
    /* 登记表不变：删除是「解除关联」，不是「忘记本机」。 */
    expect(loadRegistry(storage).devices).toHaveLength(1);
  });

  it("没有后端 id 时删除是空操作（只有本地记录的设备）", async () => {
    const api = new FakeApi();
    const sync = new DeviceSync({ api, storage: memoryStorage() });
    expect(await sync.unlink(null)).toBe(false);
    expect(api.calls).toEqual([]);
  });
});

describe("#44 identityKind 透出", () => {
  it("local 身份 → identityKind 是 local（页面显示「仅本机可见」）", async () => {
    const api = new FakeApi();
    api.identityKind = "local";
    const sync = new DeviceSync({ api, storage: memoryStorage() });
    expect(await sync.ensureIdentity()).toBe("local");
    expect(sync.identityKind).toBe("local");
  });

  it("openid 身份 → identityKind 是 openid（不显示提示）", async () => {
    const api = new FakeApi();
    api.identityKind = "openid";
    const sync = new DeviceSync({ api, storage: memoryStorage() });
    expect(await sync.ensureIdentity()).toBe("openid");
    expect(sync.identityKind).toBe("openid");
  });

  it("换取失败时 identityKind 保持 null（页面不显示提示）", async () => {
    const api = new FakeApi();
    api.identityOk = false;
    const sync = new DeviceSync({ api, storage: memoryStorage() });
    expect(await sync.ensureIdentity()).toBeNull();
    expect(sync.identityKind).toBeNull();
  });
});

describe("#44 seen 的上报体约束", () => {
  it("未配置的灯带槽位（0）被滤掉：后端只收正整数数组", async () => {
    const api = new FakeApi();
    const sync = new DeviceSync({ api, storage: memoryStorage() });
    /* State.stripCounts 是定长 8 槽，未使用为 0。 */
    await sync.noteConnected(facts({ ledCounts: [30, 20, 0, 0, 0, 0, 0, 0] }));
    expect(api.seen[0].body).toEqual({ ledCounts: [30, 20], firmwareVer: 0x300 });
  });

  it("全 0 / 空数组时传 null（后端 COALESCE 保留旧缓存，不写空数组）", async () => {
    const api = new FakeApi();
    const sync = new DeviceSync({ api, storage: memoryStorage() });
    await sync.noteConnected(facts({ ledCounts: [0, 0] }));
    expect(api.seen[0].body).toEqual({ ledCounts: null, firmwareVer: 0x300 });
  });
});
