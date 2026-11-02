/**
 * #41 设备登记表（App 本地）：设备列表、备注名、**启用掩码**。
 *
 * 关键约束（协调者裁定，不能改）：
 *  - 启用掩码只在 App 侧，**永远不发给设备**。它只决定灯带切换器里显示谁，
 *    不改变设备上的段配置；
 *  - 隐藏某条灯带**不能**丢配置：登记表里除了掩码位之外的一切都必须原样保留；
 *  - 默认全显示（掩码 0xFF）：WS2812B 无法回报物理接线，App 只能「先假设都接了」。
 *
 * 纯逻辑 + 注入 SessionStorage，可在 node 里直接测。
 */

import { describe, expect, it } from "vitest";

import type { SessionStorage } from "../utils/control/device-cache";
import {
  ALL_STRIPS_MASK,
  DEVICE_REGISTRY_KEY,
  enabledStripIds,
  findEntry,
  findEntryByHardwareId,
  loadRegistry,
  recordSeen,
  removeDevice,
  resolveEntry,
  setHardwareId,
  setRemark,
  setStripEnabled,
  storageKeyOf,
  stripEnabled,
} from "../utils/control/device-registry";

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

describe("#41 设备登记表：默认值", () => {
  it("空存储读出空表", () => {
    const storage = memoryStorage();
    expect(loadRegistry(storage)).toEqual({ devices: [] });
    expect(findEntry(loadRegistry(storage), "DEV-A")).toBeNull();
  });

  it("损坏的 JSON / 非数组 / 坏条目都按空表处理（不整体失败）", () => {
    expect(loadRegistry(memoryStorage({ [DEVICE_REGISTRY_KEY]: "{" }))).toEqual({ devices: [] });
    expect(loadRegistry(memoryStorage({ [DEVICE_REGISTRY_KEY]: '"x"' }))).toEqual({ devices: [] });
    expect(
      loadRegistry(
        memoryStorage({
          [DEVICE_REGISTRY_KEY]: JSON.stringify({
            devices: [{ deviceId: 1 }, { deviceId: "OK", stripMask: 0x01 }],
          }),
        }),
      ),
    ).toEqual({ devices: [{ deviceId: "OK", stripMask: 0x01 }] });
  });

  it("没有登记记录的设备默认「全部灯带启用」", () => {
    const registry = loadRegistry(memoryStorage());
    /* 8 条带全部为真——默认值不是「全部关闭」，否则新设备连上后一片空白。 */
    for (let id = 0; id < 8; id += 1) {
      expect(stripEnabled(registry, "DEV-A", id)).toBe(true);
    }
    expect(enabledStripIds(registry, "DEV-A", 3)).toEqual([0, 1, 2]);
  });
});

describe("#41 设备登记表：备注名与持久化", () => {
  it("设置备注名会创建记录，且默认掩码仍是全 1", () => {
    const storage = memoryStorage();
    const registry = setRemark(storage, "DEV-A", "书桌灯带");
    expect(findEntry(registry, "DEV-A")).toMatchObject({
      deviceId: "DEV-A",
      remark: "书桌灯带",
      stripMask: ALL_STRIPS_MASK,
    });
    /* 真的落盘了：换一个 storage 实例读同一份 key。 */
    expect(loadRegistry(storage)).toEqual(registry);
  });

  it("传 null / 空串清掉备注名，但记录与掩码保留", () => {
    const storage = memoryStorage();
    setRemark(storage, "DEV-A", "客厅");
    setStripEnabled(storage, "DEV-A", 2, false);
    const registry = setRemark(storage, "DEV-A", null);
    expect(findEntry(registry, "DEV-A")?.remark).toBeUndefined();
    expect(findEntry(registry, "DEV-A")?.stripMask).toBe(ALL_STRIPS_MASK & ~(1 << 2));
  });

  it("重复设置同一台设备不会产生重复记录", () => {
    const storage = memoryStorage();
    setRemark(storage, "DEV-A", "一");
    setRemark(storage, "DEV-A", "二");
    const registry = loadRegistry(storage);
    expect(registry.devices).toHaveLength(1);
    expect(registry.devices[0].remark).toBe("二");
  });

  it("记录最近一次见到的时间", () => {
    const storage = memoryStorage();
    const registry = recordSeen(storage, "DEV-A", 1700000000000);
    expect(findEntry(registry, "DEV-A")?.lastSeenAt).toBe(1700000000000);
  });

  it("hardwareId 可后补（#44 在 QueryDeviceInfo 之后调用），不覆盖备注与掩码", () => {
    const storage = memoryStorage();
    setRemark(storage, "DEV-A", "阳台");
    setStripEnabled(storage, "DEV-A", 1, false);
    const registry = setHardwareId(storage, "DEV-A", "AA:BB:CC:DD:EE:FF");
    expect(findEntry(registry, "DEV-A")).toMatchObject({
      remark: "阳台",
      hardwareId: "AA:BB:CC:DD:EE:FF",
      stripMask: ALL_STRIPS_MASK & ~(1 << 1),
    });
  });

  it("删除设备整条记录消失", () => {
    const storage = memoryStorage();
    setRemark(storage, "DEV-A", "一");
    setRemark(storage, "DEV-B", "二");
    const registry = removeDevice(storage, "DEV-A");
    expect(registry.devices.map((entry) => entry.deviceId)).toEqual(["DEV-B"]);
  });
});

describe("#41 启用掩码", () => {
  it("关闭某条带只清那一位，其他带的配置原样保留（隐藏 ≠ 清配置）", () => {
    const storage = memoryStorage();
    setRemark(storage, "DEV-A", "书桌");
    const before = findEntry(loadRegistry(storage), "DEV-A")!;

    const registry = setStripEnabled(storage, "DEV-A", 3, false);
    const after = findEntry(registry, "DEV-A")!;

    expect(after.stripMask).toBe(ALL_STRIPS_MASK & ~(1 << 3));
    expect(stripEnabled(registry, "DEV-A", 3)).toBe(false);
    /* 其余 7 条仍然启用。 */
    expect(enabledStripIds(registry, "DEV-A", 8)).toEqual([0, 1, 2, 4, 5, 6, 7]);
    /* 除掩码外的字段一个字节都没变（备注 / hardwareId / 时间戳）。 */
    expect({ ...after, stripMask: before.stripMask }).toEqual(before);
  });

  it("重新启用恢复到全 1", () => {
    const storage = memoryStorage();
    setStripEnabled(storage, "DEV-A", 5, false);
    const registry = setStripEnabled(storage, "DEV-A", 5, true);
    expect(findEntry(registry, "DEV-A")?.stripMask).toBe(ALL_STRIPS_MASK);
  });

  it("多台设备的掩码互不影响", () => {
    const storage = memoryStorage();
    setStripEnabled(storage, "DEV-A", 0, false);
    setStripEnabled(storage, "DEV-B", 1, false);
    const registry = loadRegistry(storage);
    expect(enabledStripIds(registry, "DEV-A", 4)).toEqual([1, 2, 3]);
    expect(enabledStripIds(registry, "DEV-B", 4)).toEqual([0, 2, 3]);
  });

  it("enabledStripIds 按 strip_count 截断（未配置的槽位不出现）", () => {
    const registry = loadRegistry(memoryStorage());
    expect(enabledStripIds(registry, "DEV-A", 1)).toEqual([0]);
    expect(enabledStripIds(registry, "DEV-A", 0)).toEqual([]);
    expect(enabledStripIds(registry, "DEV-A", 99)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });

  it("灯带号越界抛 RangeError（不静默夹住，避免把 7 号带的开关写到别的带上）", () => {
    const storage = memoryStorage();
    expect(() => setStripEnabled(storage, "DEV-A", 8, false)).toThrow(RangeError);
    expect(() => setStripEnabled(storage, "DEV-A", -1, false)).toThrow(RangeError);
  });
});

describe("#44 按 hardwareId 定位（只有后端记录的设备）", () => {
  it("findEntryByHardwareId 命中带 hwId 的记录；空串不匹配任何东西", () => {
    const storage = memoryStorage();
    setRemark(storage, "DEV-A", "书桌");
    setHardwareId(storage, "DEV-A", "AA:BB:CC:DD:EE:FF");
    const registry = loadRegistry(storage);

    expect(findEntryByHardwareId(registry, "AA:BB:CC:DD:EE:FF")?.deviceId).toBe("DEV-A");
    expect(findEntryByHardwareId(registry, "AA:BB:CC:DD:EE:00")).toBeNull();
    expect(findEntryByHardwareId(registry, "")).toBeNull();
  });

  it("resolveEntry 先按 deviceId 再按 hwId（本机连过的 deviceId 一定可用）", () => {
    const storage = memoryStorage();
    setRemark(storage, "DEV-A", "书桌");
    setHardwareId(storage, "DEV-A", "AA:BB:CC:DD:EE:FF");
    const registry = loadRegistry(storage);

    expect(resolveEntry(registry, { deviceId: "DEV-A" })?.remark).toBe("书桌");
    expect(resolveEntry(registry, { hardwareId: "AA:BB:CC:DD:EE:FF" })?.remark).toBe("书桌");
    /* deviceId 找不到时退回 hwId。 */
    expect(
      resolveEntry(registry, { deviceId: "STALE-UUID", hardwareId: "AA:BB:CC:DD:EE:FF" })?.deviceId,
    ).toBe("DEV-A");
    expect(resolveEntry(registry, { deviceId: "NOPE" })).toBeNull();
    expect(resolveEntry(registry, {})).toBeNull();
  });

  it("只有后端记录的设备（无 deviceId）没有本地可写的备注槽位", () => {
    const registry = loadRegistry(memoryStorage());
    /* hwId 不能当行键：备注名走后端 PATCH，本地不建空壳记录。 */
    expect(storageKeyOf(registry, { hardwareId: "AA:BB:CC:DD:EE:FF" })).toBeNull();
    expect(storageKeyOf(registry, { deviceId: "DEV-A" })).toBe("DEV-A");
  });
});
