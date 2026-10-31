/**
 * 设备登记表（App 本地，#41）：设备列表、备注名、**灯带启用掩码**。
 *
 * 与 device-history 的分工：
 *  - device-history 只记「最近连过」的时间序列，是设备页的排序来源；
 *  - 本模块记**用户对设备做的决定**（名字、哪些灯带实际接线），是长期数据，
 *    所以单独一个键、单独一层。
 *
 * 启用掩码为什么只能在 App 侧（协调者裁定，不要试图下发）：
 * WS2812B 是单向数据线，灯带没有回读能力，设备永远无法知道某条带物理上
 * 是否插着。因此「隐藏这条带」纯粹是界面偏好：它只影响灯带切换器显示谁，
 * **不影响设备上的任何段配置**——隐藏后重新显示，段与灯效原样还在。
 *
 * 掩码默认 0xFF（8 条全显示）：先假设都接了，比默认全隐藏更符合直觉。
 *
 * 纯逻辑 + 注入 SessionStorage，不碰 wx，可在 node 里直接测。
 */

import type { SessionStorage } from "./device-cache";
import { MAX_STRIPS } from "../protocol/constants";

/** 存储键带版本号，避免读到旧结构。 */
export const DEVICE_REGISTRY_KEY = "lumen.deviceRegistry.v1";

/** 8 条带全部启用（默认值）。 */
export const ALL_STRIPS_MASK = (1 << MAX_STRIPS) - 1;

export interface DeviceRegistryEntry {
  /** 平台的 BLE deviceId（iOS 上是会变的 UUID），列表主键。 */
  deviceId: string;
  /** 用户起的备注名（设备广播名不可靠，改名以这里为准）。 */
  remark?: string;
  /** 6 字节 BT MAC（#44 在 QueryDeviceInfo 之后补上）；未知时不写。 */
  hardwareId?: string;
  /** bit i = 第 i 条灯带在界面上可见。**只在本机有效，永不下发**。 */
  stripMask: number;
  /** 最后一次见到这台设备的时间（毫秒）；未知时不写。 */
  lastSeenAt?: number;
}

export interface DeviceRegistry {
  devices: DeviceRegistryEntry[];
}

const EMPTY_REGISTRY: DeviceRegistry = { devices: [] };

/** 一条记录是否结构合法；坏条目逐条丢弃，不整体失败。 */
function isValidEntry(value: unknown): value is DeviceRegistryEntry {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const entry = value as {
    deviceId?: unknown;
    remark?: unknown;
    hardwareId?: unknown;
    stripMask?: unknown;
    lastSeenAt?: unknown;
  };
  if (typeof entry.deviceId !== "string" || entry.deviceId.length === 0) {
    return false;
  }
  if (typeof entry.stripMask !== "number" || !Number.isInteger(entry.stripMask)) {
    return false;
  }
  if (entry.remark !== undefined && typeof entry.remark !== "string") {
    return false;
  }
  if (entry.hardwareId !== undefined && typeof entry.hardwareId !== "string") {
    return false;
  }
  if (entry.lastSeenAt !== undefined && typeof entry.lastSeenAt !== "number") {
    return false;
  }
  return true;
}

/** 读表；任何异常 / 非法结构都按空表处理。 */
export function loadRegistry(storage: SessionStorage): DeviceRegistry {
  const raw = storage.get(DEVICE_REGISTRY_KEY);
  if (raw === null) {
    return { ...EMPTY_REGISTRY, devices: [] };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ...EMPTY_REGISTRY, devices: [] };
  }
  const devices = (parsed as { devices?: unknown })?.devices;
  if (!Array.isArray(devices)) {
    return { ...EMPTY_REGISTRY, devices: [] };
  }
  return {
    devices: devices.filter(isValidEntry).map((entry) => ({
      ...entry,
      /* 越界位不进内存：只保留 0-7。 */
      stripMask: entry.stripMask & ALL_STRIPS_MASK,
    })),
  };
}

function writeRegistry(storage: SessionStorage, registry: DeviceRegistry): void {
  storage.set(DEVICE_REGISTRY_KEY, JSON.stringify(registry));
}

export function findEntry(registry: DeviceRegistry, deviceId: string): DeviceRegistryEntry | null {
  return registry.devices.find((entry) => entry.deviceId === deviceId) ?? null;
}

/** 取一条记录（没有就按默认值造一个，不落盘）。 */
function entryOf(registry: DeviceRegistry, deviceId: string): DeviceRegistryEntry {
  return (
    findEntry(registry, deviceId) ?? {
      deviceId,
      stripMask: ALL_STRIPS_MASK,
    }
  );
}

/** 用新记录替换同名条目，其余顺序不变；设备页的排序由调用方决定。 */
function upsertEntry(registry: DeviceRegistry, entry: DeviceRegistryEntry): DeviceRegistry {
  const devices = registry.devices.slice();
  const index = devices.findIndex((item) => item.deviceId === entry.deviceId);
  if (index >= 0) {
    devices[index] = entry;
  } else {
    devices.push(entry);
  }
  return { devices };
}

/**
 * 设置 / 清除备注名。
 *
 * `remark` 为 null 或空串时删掉该字段（不是写空串）：读出来的结构与写入时
 * 对称，UI 用 `?? 广播名` 判断「用户改过名没有」才可靠。
 */
export function setRemark(
  storage: SessionStorage,
  deviceId: string,
  remark: string | null,
): DeviceRegistry {
  const registry = loadRegistry(storage);
  const current = entryOf(registry, deviceId);
  const trimmed = remark === null ? "" : remark.trim();
  const next: DeviceRegistryEntry = { ...current };
  if (trimmed.length > 0) {
    next.remark = trimmed;
  } else {
    delete next.remark;
  }
  const updated = upsertEntry(registry, next);
  writeRegistry(storage, updated);
  return updated;
}

/** 记录一次「见到这台设备」。 */
export function recordSeen(
  storage: SessionStorage,
  deviceId: string,
  nowMs: number,
): DeviceRegistry {
  const registry = loadRegistry(storage);
  const updated = upsertEntry(registry, {
    ...entryOf(registry, deviceId),
    lastSeenAt: nowMs,
  });
  writeRegistry(storage, updated);
  return updated;
}

/**
 * 补上 hardwareId（#44 在 QueryDeviceInfo 之后调用）。
 *
 * 备注名与启用掩码必须原样保留：hardwareId 只是多一个身份键，不是新记录。
 */
export function setHardwareId(
  storage: SessionStorage,
  deviceId: string,
  hardwareId: string,
): DeviceRegistry {
  const registry = loadRegistry(storage);
  const updated = upsertEntry(registry, {
    ...entryOf(registry, deviceId),
    hardwareId,
  });
  writeRegistry(storage, updated);
  return updated;
}

/**
 * 设置某条灯带的可见性。
 *
 * 只改掩码位：**隐藏一条带不清它的段**（段的权威在设备里，登记表根本
 * 碰不到）。越界直接抛错——静默夹住会把 7 号带的开关写到别的带上。
 */
export function setStripEnabled(
  storage: SessionStorage,
  deviceId: string,
  stripId: number,
  enabled: boolean,
): DeviceRegistry {
  if (!Number.isInteger(stripId) || stripId < 0 || stripId >= MAX_STRIPS) {
    throw new RangeError(`灯带号必须是 0-${MAX_STRIPS - 1} 的整数，收到 ${stripId}`);
  }
  const registry = loadRegistry(storage);
  const current = entryOf(registry, deviceId);
  const bit = 1 << stripId;
  const mask = enabled ? current.stripMask | bit : current.stripMask & ~bit;
  const updated = upsertEntry(registry, { ...current, stripMask: mask & ALL_STRIPS_MASK });
  writeRegistry(storage, updated);
  return updated;
}

/** 删除一台设备的全部本地决定（备注 / 掩码 / 身份）。 */
export function removeDevice(storage: SessionStorage, deviceId: string): DeviceRegistry {
  const registry = loadRegistry(storage);
  const updated = {
    devices: registry.devices.filter((entry) => entry.deviceId !== deviceId),
  };
  writeRegistry(storage, updated);
  return updated;
}

/** 某条灯带是否启用；没有记录的设备按默认全启用。 */
export function stripEnabled(
  registry: DeviceRegistry,
  deviceId: string,
  stripId: number,
): boolean {
  const entry = findEntry(registry, deviceId);
  if (entry === null) {
    return true;
  }
  return (entry.stripMask & (1 << stripId)) !== 0;
}

/**
 * 可见的灯带号（0 起，升序），按设备的实际条数截断。
 *
 * stripCount 来自 State；未配置的槽位即使掩码位为 1 也不显示。
 */
export function enabledStripIds(
  registry: DeviceRegistry,
  deviceId: string,
  stripCount: number,
): number[] {
  const limit = Math.max(0, Math.min(MAX_STRIPS, Math.floor(stripCount)));
  const ids: number[] = [];
  for (let id = 0; id < limit; id += 1) {
    if (stripEnabled(registry, deviceId, id)) {
      ids.push(id);
    }
  }
  return ids;
}
