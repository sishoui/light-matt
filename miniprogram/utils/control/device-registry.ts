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
  /**
   * 后端行 id（#44）：`POST /devices/register` 返回的那个。
   *
   * 只用来定位「这台设备对应后端的哪一行」，让改名 / 删除不必每次重拉列表。
   * 它不是身份（身份是 hardwareId），也不是灯光配置。
   */
  backendId?: number;
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
    backendId?: unknown;
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
  if (entry.backendId !== undefined && !Number.isInteger(entry.backendId)) {
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

/**
 * 按 hardwareId 找记录（#44）。
 *
 * 设备页合并后端列表后，"只有后端记录"的设备没有本机 deviceId，只能按
 * hardwareId 定位；改名 / 删除 / 掩码都走这里。同一 hwId 正常只有一条
 * （`setHardwareId` 在写入前不做去重，所以这里取第一条即可）。
 */
export function findEntryByHardwareId(
  registry: DeviceRegistry,
  hardwareId: string,
): DeviceRegistryEntry | null {
  if (hardwareId.length === 0) {
    return null;
  }
  return registry.devices.find((entry) => entry.hardwareId === hardwareId) ?? null;
}

/**
 * 「设备引用」：设备页一行同时可能知道 deviceId（本机连过）与 hardwareId
 * （设备自报）。两者都缺时没有可操作对象。
 */
export interface DeviceRef {
  readonly deviceId?: string | null;
  readonly hardwareId?: string | null;
}

/** 解析引用到已有记录；deviceId 优先（它当前一定可连接），再按 hwId。 */
export function resolveEntry(registry: DeviceRegistry, ref: DeviceRef): DeviceRegistryEntry | null {
  const deviceId = ref.deviceId ?? "";
  if (deviceId.length > 0) {
    const byId = findEntry(registry, deviceId);
    if (byId !== null) {
      return byId;
    }
  }
  const hardwareId = ref.hardwareId ?? "";
  return hardwareId.length > 0 ? findEntryByHardwareId(registry, hardwareId) : null;
}

/** 引用的稳定存储键：已有记录用它的 deviceId，否则当前的 deviceId，再否则 null。 */
export function storageKeyOf(registry: DeviceRegistry, ref: DeviceRef): string | null {
  const existing = resolveEntry(registry, ref);
  if (existing !== null) {
    return existing.deviceId;
  }
  const deviceId = ref.deviceId ?? "";
  /* 只有后端记录的设备没有 deviceId：它在本机不可连接，也就没有可写的
   * 本地备注槽位（备注走后端 PATCH）。返回 null 让调用方明确拒绝。 */
  return deviceId.length > 0 ? deviceId : null;
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

/**
 * 记下「这台设备对应后端的哪一行」（#44，`POST /devices/register` 的返回）。
 *
 * 不改备注 / 掩码 / 时间戳：它只是后端 id 的映射，失败的下次 sync 会重取。
 *
 * 有 deviceId 时即使用户还没设过备注也建一条记录——它就是本机的设备行
 * （默认全启用），后端 id 必须有个地方存。只有 hardwareId 时（本机没连过、
 * 只有后端记录）找不到本地记录，**不建空壳**：那时改名 / 删除直接用后端 id。
 */
export function setBackendId(
  storage: SessionStorage,
  ref: DeviceRef,
  backendId: number,
): DeviceRegistry {
  if (!Number.isInteger(backendId) || backendId <= 0) {
    throw new RangeError(`后端设备 id 必须是正整数，收到 ${backendId}`);
  }
  const registry = loadRegistry(storage);
  const deviceId = ref.deviceId ?? "";
  const existing = resolveEntry(registry, ref);
  if (existing === null && deviceId.length === 0) {
    return registry;
  }
  const current =
    existing ?? entryOf(registry, deviceId);
  const updated = upsertEntry(registry, { ...current, backendId });
  writeRegistry(storage, updated);
  return updated;
}

/**
 * 删除一台设备的全部本地决定（备注 / 掩码 / 身份）。
 */
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
