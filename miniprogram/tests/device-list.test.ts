/**
 * #44 设备页列表的合并派生（`utils/control/device-list.ts`）。
 *
 * 这一层是「本地优先 + 后端补充」的语义边界：
 *  - 「我的设备」= 本地记录 ∪ 后端列表，按 hardwareId 去重，**本地备注名赢**；
 *  - 「附近设备」= 扫描结果，标出已知项，不去重掉（用户可能想连同一台）；
 *  - 后端缓存字段（灯带数 / 固件版本）只带 `*-cache` 来源标记，绝不冒充设备当前配置。
 *
 * 纯函数，node 单测直接跑。
 */

import { describe, expect, it } from "vitest";

import type { SyncedDevice } from "../utils/control/device-api";
import type { RecentDevice } from "../utils/control/device-history";
import type { DeviceRegistryEntry } from "../utils/control/device-registry";
import { buildMyDevices, buildNearby, buildScanRows } from "../utils/control/device-list";

const HW_A = "AA:BB:CC:DD:EE:01";
const HW_B = "AA:BB:CC:DD:EE:02";

function recent(overrides: Partial<RecentDevice> = {}): RecentDevice {
  return {
    deviceId: "DEV-A",
    name: "Lumen-1A2B",
    lastConnectedAt: 2000,
    ...overrides,
  };
}

function registryEntry(overrides: Partial<DeviceRegistryEntry> = {}): DeviceRegistryEntry {
  return { deviceId: "DEV-A", stripMask: 0xff, ...overrides };
}

function synced(overrides: Partial<SyncedDevice> = {}): SyncedDevice {
  return {
    id: 7,
    hardwareId: HW_A,
    displayName: null,
    lastSeenAt: 1000,
    addedAt: 500,
    ledCounts: null,
    firmwareVer: null,
    ...overrides,
  };
}

describe("#44 我的设备：本地优先", () => {
  it("本地记录立即成行（后端为 null 也照常），名字用广播名", () => {
    const rows = buildMyDevices({ recent: [recent()], registry: [], backend: null });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      key: "DEV-A",
      hardwareId: null,
      deviceId: "DEV-A",
      name: "Lumen-1A2B",
      remoteOnly: false,
      backendId: null,
    });
  });

  it("本地备注名优先于广播名与后端备注名", () => {
    const rows = buildMyDevices({
      recent: [recent({ hardwareId: HW_A })],
      registry: [registryEntry({ hardwareId: HW_A, remark: "书桌" })],
      backend: [synced({ displayName: "后端的名字" })],
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe("书桌");
    expect(rows[0].backendId).toBe(7);
    expect(rows[0].remoteOnly).toBe(false);
  });

  it("按 hardwareId 去重：本机 deviceId 与后端记录合成一行", () => {
    const rows = buildMyDevices({
      recent: [recent({ deviceId: "IOS-UUID", hardwareId: HW_A })],
      registry: [],
      backend: [synced({ hardwareId: HW_A })],
    });
    expect(rows).toHaveLength(1);
    /* 本机 deviceId 保留（连接要用），后端 id 也保留（改名/删除要用）。 */
    expect(rows[0]).toMatchObject({ deviceId: "IOS-UUID", backendId: 7, remoteOnly: false });
  });

  it("只有后端、本机没连过的设备标 remoteOnly 且没有 deviceId", () => {
    const rows = buildMyDevices({ recent: [], registry: [], backend: [synced()] });
    expect(rows[0]).toMatchObject({
      hardwareId: HW_A,
      deviceId: null,
      remoteOnly: true,
      backendId: 7,
    });
  });

  it("本地连接时间与后端 last_seen 取较新者，并按时间降序", () => {
    const rows = buildMyDevices({
      recent: [
        recent({ deviceId: "DEV-A", hardwareId: HW_A, lastConnectedAt: 9000 }),
        recent({ deviceId: "DEV-B", hardwareId: HW_B, lastConnectedAt: 1000 }),
      ],
      registry: [],
      backend: [synced({ hardwareId: HW_A, lastSeenAt: 5000 }), synced({ id: 8, hardwareId: HW_B, lastSeenAt: 8000 })],
    });
    expect(rows.map((row) => row.hardwareId)).toEqual([HW_A, HW_B]);
    expect(rows[0].lastSeenAt).toBe(9000);
    expect(rows[1].lastSeenAt).toBe(8000);
  });

  it("后端缓存字段带来源标记；本机记录不继承后端缓存（设备才是权威）", () => {
    const rows = buildMyDevices({
      recent: [recent({ hardwareId: HW_A })],
      registry: [],
      backend: [synced({ ledCounts: [30, 20], firmwareVer: 768 })],
    });
    /* 本机连过：没有实时的 State 时显示「上次」而不是后端缓存的旧配置。 */
    expect(rows[0]).toMatchObject({ ledCounts: [30, 20], firmwareVer: 768 });
    expect(rows[0].stripCount).toBe(2);
    expect(rows[0].stripCountSource).toBe("backend-cache");
    expect(rows[0].firmwareSource).toBe("backend-cache");

    const remoteOnly = buildMyDevices({
      recent: [],
      registry: [],
      backend: [synced({ ledCounts: [30, 20], firmwareVer: 768 })],
    });
    expect(remoteOnly[0]).toMatchObject({
      ledCounts: [30, 20],
      firmwareVer: 768,
      stripCount: 2,
      stripCountSource: "backend-cache",
      firmwareSource: "backend-cache",
    });
  });

  it("本机上次连接快照优先于后端缓存；本次连接（live）又优先于快照", () => {
    const snapshot = buildMyDevices({
      recent: [recent({ hardwareId: HW_A, stripCount: 3, firmwareVer: 900 })],
      registry: [],
      backend: [synced({ ledCounts: [30, 20], firmwareVer: 768 })],
    });
    expect(snapshot[0]).toMatchObject({
      stripCount: 3,
      stripCountSource: "last-session",
      firmwareVer: 900,
      firmwareSource: "last-session",
    });

    const live = buildMyDevices({
      recent: [recent({ hardwareId: HW_A, stripCount: 3, firmwareVer: 900 })],
      registry: [],
      backend: [synced()],
      live: { deviceId: "DEV-A", stripCount: 4, firmwareVer: 1024 },
    });
    expect(live[0]).toMatchObject({
      stripCount: 4,
      stripCountSource: "device",
      firmwareVer: 1024,
      firmwareSource: "device",
    });
  });

  it("live 只作用于当前连接的 deviceId（别的设备仍显示快照）", () => {
    const rows = buildMyDevices({
      recent: [
        recent({ deviceId: "DEV-A", hardwareId: HW_A, stripCount: 1 }),
        recent({ deviceId: "DEV-B", hardwareId: HW_B, stripCount: 2 }),
      ],
      registry: [],
      backend: null,
      live: { deviceId: "DEV-A", stripCount: 5, firmwareVer: 100 },
    });
    expect(rows[0]).toMatchObject({ deviceId: "DEV-A", stripCount: 5, stripCountSource: "device" });
    expect(rows[1]).toMatchObject({ deviceId: "DEV-B", stripCount: 2, stripCountSource: "last-session" });
  });

  it("后端缓存里的非法灯带数被丢弃（不让脏数据进 UI）", () => {
    const rows = buildMyDevices({
      recent: [],
      registry: [],
      backend: [synced({ ledCounts: [30, 0, -1, Number.NaN] })],
    });
    expect(rows[0].ledCounts).toEqual([30]);
  });

  it("没有名字的本地记录退回 deviceId（不显示空标题）", () => {
    const rows = buildMyDevices({
      recent: [recent({ name: undefined })],
      registry: [],
      backend: null,
    });
    expect(rows[0].name).toBe("DEV-A");
  });
});

describe("#44 附近设备：已知标记", () => {
  it("deviceId 命中本机记录 → known 且 duplicate（页面隐去，上面已有可点的行）", () => {
    const mine = buildMyDevices({ recent: [recent()], registry: [], backend: null });
    const rows = buildNearby({
      discovered: [{ deviceId: "DEV-A", name: "Lumen-1A2B", rssi: -60 }],
      mine,
    });
    expect(rows[0].known).toBe(true);
    expect(rows[0].duplicate).toBe(true);
  });

  it("广播名命中（跨手机 / 只有后端记录）→ known 但不 duplicate（本机没有可点的行）", () => {
    const mine = buildMyDevices({
      recent: [],
      registry: [],
      backend: [synced({ displayName: "LUMEN-1A2B" })],
    });
    const rows = buildNearby({
      discovered: [{ deviceId: "OTHER-UUID", name: "Lumen-1A2B", rssi: -70 }],
      mine,
    });
    expect(rows[0].known).toBe(true);
    expect(rows[0].duplicate).toBe(false);
  });

  it("从未见过 → 不是 known；当前连接的那台标 current", () => {
    const mine = buildMyDevices({ recent: [recent()], registry: [], backend: null });
    const rows = buildNearby({
      discovered: [
        { deviceId: "DEV-Z", name: "Lumen-FFFF", rssi: -50 },
        { deviceId: "DEV-A", name: "Lumen-1A2B", rssi: -40 },
      ],
      mine,
      currentDeviceId: "DEV-A",
    });
    expect(rows.map((row) => row.known)).toEqual([false, true]);
    expect(rows.map((row) => row.current)).toEqual([false, true]);
  });

  it("扫描结果本身不去重（同一台重复广播仍保留，由页面按 rssi 决定）", () => {
    const mine = buildMyDevices({ recent: [recent()], registry: [], backend: null });
    const rows = buildNearby({
      discovered: [
        { deviceId: "DEV-A", name: "Lumen-1A2B", rssi: -40 },
        { deviceId: "DEV-A", name: "Lumen-1A2B", rssi: -45 },
      ],
      mine,
    });
    expect(rows).toHaveLength(2);
  });
});

describe("#62 发现页的扫描结果行（不过滤已知设备）", () => {
  it("已登记设备照样成行，只打「已知」标记（新发现页没有并排的设备列表）", () => {
    const mine = buildMyDevices({ recent: [recent()], registry: [], backend: null });
    const rows = buildScanRows({
      discovered: [{ deviceId: "DEV-A", name: "Lumen-1A2B", rssi: -40 }],
      mine,
      currentDeviceId: "DEV-A",
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      deviceId: "DEV-A",
      known: true,
      current: true,
      rssiText: "-40 dBm",
    });
  });

  it("未知设备 known 为假（没有徽标）", () => {
    const mine = buildMyDevices({ recent: [], registry: [], backend: null });
    const rows = buildScanRows({
      discovered: [{ deviceId: "DEV-Z", name: "Lumen-FFFF", rssi: -88 }],
      mine,
    });
    expect(rows[0].known).toBe(false);
    expect(rows[0].rssiText).toBe("-88 dBm");
  });

  it("按信号强度降序（最强的最上面）", () => {
    const mine = buildMyDevices({ recent: [], registry: [], backend: null });
    const rows = buildScanRows({
      discovered: [
        { deviceId: "DEV-WEAK", name: "A", rssi: -90 },
        { deviceId: "DEV-STRONG", name: "B", rssi: -40 },
        { deviceId: "DEV-MID", name: "C", rssi: -65 },
      ],
      mine,
    });
    expect(rows.map((row) => row.deviceId)).toEqual(["DEV-STRONG", "DEV-MID", "DEV-WEAK"]);
  });

  it("同一台重复广播仍然各自成行（扫描阶段不去重）", () => {
    const mine = buildMyDevices({ recent: [], registry: [], backend: null });
    const rows = buildScanRows({
      discovered: [
        { deviceId: "DEV-A", name: "Lumen-1A2B", rssi: -40 },
        { deviceId: "DEV-A", name: "Lumen-1A2B", rssi: -45 },
      ],
      mine,
    });
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.rssi)).toEqual([-40, -45]);
  });
});
