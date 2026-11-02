/**
 * 「最近连过」设备列表（#33 / #44）。
 *
 * 与 device-cache 的区别：device-cache 只记**最后连过的那一台**，是回连的前提；
 * 这里记**一串**连过的设备与最后连接时间，用来在设备列表里排序。
 *
 * ## #44：改以 hardwareId 为键（v2）
 *
 * 平台的 BLE `deviceId` 不能当身份：Android 给 MAC、iOS 给每台手机各不相同的
 * UUID，换手机 / 重装后同一台设备会变成两条记录。设备自报的 `hw_id`
 * （`QueryDeviceInfo` 0x88）才是稳定身份，所以：
 *  - **键 = `hardwareId ?? deviceId`**：DeviceInfo 还没读到前先用 deviceId 顶着，
 *    读到后由 `updateHardwareId` 合并不成新记录；
 *  - 新键 `lumen.recentDevices.v2`：v1 里没有任何条目带 hardwareId，**不做静默迁移**
 *    ——迁移只能按 deviceId 猜，iOS 上猜错就是两条记录、备注名对不上。老数据留在
 *    v1 键里自然过期，用户重新连一次即可。
 *
 * ## 上限 8 → 20
 *
 * 8 是「个人手头设备个位数」时的估计；v3 的设备页要同时展示「我的设备」与
 * 「附近设备」，8 条会把跨手机同步回来的记录挤掉。20 仍然有界，不会无限增长。
 *
 * 纯逻辑 + 注入 storage，不碰 BLE、不碰 wx.*，因此可在 node 里直接单测。
 */

import type { SessionStorage } from "./device-cache";

export interface RecentDevice {
  /** 平台 BLE id（iOS 上会变）；连接时必须用它，**不是**身份。 */
  deviceId: string;
  /**
   * 设备自报的 6 字节 BT MAC（大写冒号，与协议 0x88 一致）。
   * 未知时不写——绝不拿 deviceId 冒充 hardwareId。
   */
  hardwareId?: string;
  /** 广播名（`Lumen-XXXX`）。备注名在 device-registry，不重复存。 */
  name?: string;
  /** 最后一次成功连接的 Unix 毫秒时间戳。 */
  lastConnectedAt: number;
  /**
   * 上次连接时设备上报的灯带数（State.stripCount）。
   *
   * 这是**上次的快照**，不是当前配置：设备可能在别处被改过。设备页只在
   * 未连接时显示它并标注「上次」，连上后一律以 State 为准。
   */
  stripCount?: number;
  /** 上次连接时设备上报的固件版本（DeviceInfo.firmwareVersion）。同样只是快照。 */
  firmwareVer?: number;
}

/** v2 存储键：结构变了（多了 hardwareId），不与 v1 混读。 */
export const RECENT_DEVICES_KEY = "lumen.recentDevices.v2";

/**
 * v1 键，仅用于文档与将来可能的显式迁移入口。
 * 本模块**不读**它：v1 条目没有 hardwareId，按 deviceId 迁移会在 iOS 上产生重复。
 */
export const RECENT_DEVICES_KEY_V1 = "lumen.recentDevices.v1";

/** 上限 20 台：有界，且足够覆盖「个人 + 家人几台」的跨手机同步结果。 */
export const MAX_RECENT_DEVICES = 20;

/** 去重键：有 hardwareId 用它，否则退回 deviceId。 */
export function deviceKeyOf(entry: { deviceId: string; hardwareId?: string }): string {
  return entry.hardwareId !== undefined && entry.hardwareId.length > 0
    ? entry.hardwareId
    : entry.deviceId;
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isValidEntry(value: unknown): value is RecentDevice {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const entry = value as {
    deviceId?: unknown;
    hardwareId?: unknown;
    name?: unknown;
    lastConnectedAt?: unknown;
    stripCount?: unknown;
    firmwareVer?: unknown;
  };
  if (!nonEmpty(entry.deviceId)) {
    return false;
  }
  if (typeof entry.lastConnectedAt !== "number" || !Number.isFinite(entry.lastConnectedAt)) {
    return false;
  }
  if (entry.name !== undefined && typeof entry.name !== "string") {
    return false;
  }
  if (entry.hardwareId !== undefined && !nonEmpty(entry.hardwareId)) {
    return false;
  }
  if (entry.stripCount !== undefined && !Number.isInteger(entry.stripCount)) {
    return false;
  }
  if (entry.firmwareVer !== undefined && !Number.isInteger(entry.firmwareVer)) {
    return false;
  }
  return true;
}

function normalizeEntry(entry: RecentDevice): RecentDevice {
  const hardwareId =
    entry.hardwareId !== undefined && entry.hardwareId.length > 0 ? entry.hardwareId : undefined;
  const name = entry.name !== undefined && entry.name.length > 0 ? entry.name : undefined;
  const stripCount =
    entry.stripCount !== undefined && entry.stripCount > 0 ? entry.stripCount : undefined;
  const firmwareVer =
    entry.firmwareVer !== undefined && entry.firmwareVer >= 0 ? entry.firmwareVer : undefined;
  return {
    deviceId: entry.deviceId,
    ...(hardwareId !== undefined ? { hardwareId } : {}),
    ...(name !== undefined ? { name } : {}),
    lastConnectedAt: entry.lastConnectedAt,
    ...(stripCount !== undefined ? { stripCount } : {}),
    ...(firmwareVer !== undefined ? { firmwareVer } : {}),
  };
}

/** 按去重键收敛：后出现的覆盖先出现的（调用方保证「后 = 更新」）。 */
function dedupe(list: readonly RecentDevice[]): RecentDevice[] {
  const byKey = new Map<string, RecentDevice>();
  for (const entry of list) {
    byKey.set(deviceKeyOf(entry), normalizeEntry(entry));
  }
  return Array.from(byKey.values());
}

function sortAndTrim(list: readonly RecentDevice[]): RecentDevice[] {
  return dedupe(list)
    .sort((a, b) => b.lastConnectedAt - a.lastConnectedAt)
    .slice(0, MAX_RECENT_DEVICES);
}

/** 读列表并按最后连接时间降序；损坏的条目逐条丢弃，不整体失败。 */
export function loadRecentDevices(storage: SessionStorage): RecentDevice[] {
  const raw = storage.get(RECENT_DEVICES_KEY);
  if (raw === null) {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) {
    return [];
  }
  return sortAndTrim(parsed.filter(isValidEntry));
}

function writeRecentDevices(storage: SessionStorage, list: RecentDevice[]): void {
  storage.set(RECENT_DEVICES_KEY, JSON.stringify(list));
}

/**
 * 记一次成功连接：同一身份只保留一条（更新时间 / 名字 / hardwareId），
 * 然后按时间降序裁剪到上限。
 *
 * `hardwareId` 可选：连接成功的那一刻通常还没有它（要等 0x88），此时先按
 * deviceId 记一条，`updateHardwareId` 随后补上并合并。**绝不**用 deviceId
 * 填充 hardwareId——那会让 iOS 上的同一台设备变成两个身份。
 */
export function recordConnection(
  storage: SessionStorage,
  deviceId: string,
  name: string | undefined,
  nowMs: number,
  hardwareId?: string,
): RecentDevice[] {
  const entry: RecentDevice = {
    deviceId,
    ...(hardwareId !== undefined && hardwareId.length > 0 ? { hardwareId } : {}),
    ...(name !== undefined && name.length > 0 ? { name } : {}),
    lastConnectedAt: nowMs,
  };
  const key = deviceKeyOf(entry);
  /* 同时按 deviceId 与 hardwareId 剔除旧条目：从「只有 deviceId」升级到
   * 「有了 hardwareId」时，两条必须收敛成一条。 */
  const rest = loadRecentDevices(storage).filter(
    (item) => deviceKeyOf(item) !== key && item.deviceId !== deviceId,
  );
  const next = sortAndTrim([entry, ...rest]);
  writeRecentDevices(storage, next);
  return next;
}

/**
 * DeviceInfo 到达后补上 hardwareId 与缓存快照（#44 的连接顺序：connect →
 * State → QueryDeviceInfo → 记录）。
 *
 * 只改身份键与缓存字段，**不覆盖**时间戳与广播名；若另一条记录已经用这个
 * hardwareId 存在（例如之前连过），合并成一条：保留较新的时间，名字以新记录为准。
 *
 * 找不到按 deviceId 的条目时返回原列表：不凭一次读到的 hwId 造一条
 * 「从未连过」的记录。
 */
export function updateDeviceIdentity(
  storage: SessionStorage,
  deviceId: string,
  patch: { hardwareId?: string | undefined; stripCount?: number | undefined; firmwareVer?: number | undefined },
): RecentDevice[] {
  const list = loadRecentDevices(storage);
  const target = list.find((entry) => entry.deviceId === deviceId);
  if (target === undefined) {
    return list;
  }
  const hardwareId =
    patch.hardwareId !== undefined && patch.hardwareId.length > 0
      ? patch.hardwareId
      : target.hardwareId;
  const sameHardware =
    hardwareId !== undefined
      ? list.find((entry) => entry.hardwareId === hardwareId && entry !== target)
      : undefined;

  const merged: RecentDevice = {
    ...normalizeEntry(target),
    ...(hardwareId !== undefined ? { hardwareId } : {}),
    ...(patch.stripCount !== undefined && patch.stripCount > 0
      ? { stripCount: patch.stripCount }
      : {}),
    ...(patch.firmwareVer !== undefined && patch.firmwareVer >= 0
      ? { firmwareVer: patch.firmwareVer }
      : {}),
    /* 合并时保留较新的连接时间（两条描述的是同一台设备）。 */
    lastConnectedAt: Math.max(
      target.lastConnectedAt,
      sameHardware?.lastConnectedAt ?? target.lastConnectedAt,
    ),
  };
  const rest = list.filter((entry) => {
    if (entry === target) {
      return false;
    }
    if (hardwareId !== undefined && entry.hardwareId === hardwareId) {
      return false;
    }
    return true;
  });
  const next = sortAndTrim([merged, ...rest]);
  writeRecentDevices(storage, next);
  return next;
}

/**
 * 补 hardwareId（`updateDeviceIdentity` 的窄包装，供只需要身份的调用方用）。
 */
export function updateHardwareId(
  storage: SessionStorage,
  deviceId: string,
  hardwareId: string,
): RecentDevice[] {
  return updateDeviceIdentity(storage, deviceId, { hardwareId });
}

/**
 * 移除一台设备（deviceId 失效 / 用户删除）。
 *
 * 知道 hardwareId 时按它删：iOS 换了 UUID 后 deviceId 已不匹配，只有 hwId
 * 能定位到同一条记录。否则按 deviceId 删。不清空整张表。
 */
export function forgetDevice(
  storage: SessionStorage,
  deviceId: string,
  hardwareId?: string,
): RecentDevice[] {
  const list = loadRecentDevices(storage);
  const next = list.filter((entry) => {
    if (entry.deviceId === deviceId) {
      return false;
    }
    if (hardwareId !== undefined && hardwareId.length > 0 && entry.hardwareId === hardwareId) {
      return false;
    }
    return true;
  });
  writeRecentDevices(storage, next);
  return next;
}
