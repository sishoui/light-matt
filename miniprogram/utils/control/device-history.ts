/**
 * 「最近连过」设备列表（#33）。
 *
 * 与 device-cache 的区别：device-cache 只记**最后连过的那一台**，是回连的前提；
 * 这里记**一串**连过的设备与最后连接时间，用来在设备列表里排序。
 *
 * 纯逻辑 + 注入 storage，不碰 BLE、不碰 wx.*，因此可在 node 里直接单测。
 * 列表有上限，防止长期使用后无限增长；排序按 lastConnectedAt 降序。
 */

import type { SessionStorage } from "./device-cache";

export interface RecentDevice {
  deviceId: string;
  name?: string;
  /** 最后一次成功连接的 Unix 毫秒时间戳。 */
  lastConnectedAt: number;
}

/** 存储键带版本号，避免读到旧结构。 */
export const RECENT_DEVICES_KEY = "lumen.recentDevices.v1";

/**
 * 上限 8 台。个人测试阶段手头的设备只有个位数，8 条足够覆盖
 * 「最近连过」的语义；再多就会把列表变成历史记录，反而找不到常用那台。
 */
export const MAX_RECENT_DEVICES = 8;

function isValidEntry(value: unknown): value is RecentDevice {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const entry = value as { deviceId?: unknown; name?: unknown; lastConnectedAt?: unknown };
  if (typeof entry.deviceId !== "string" || entry.deviceId.length === 0) {
    return false;
  }
  if (typeof entry.lastConnectedAt !== "number" || !Number.isFinite(entry.lastConnectedAt)) {
    return false;
  }
  return entry.name === undefined || typeof entry.name === "string";
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
  return parsed
    .filter(isValidEntry)
    .map((entry) => ({
      deviceId: entry.deviceId,
      ...(typeof entry.name === "string" && entry.name.length > 0 ? { name: entry.name } : {}),
      lastConnectedAt: entry.lastConnectedAt,
    }))
    .sort((a, b) => b.lastConnectedAt - a.lastConnectedAt)
    .slice(0, MAX_RECENT_DEVICES);
}

function writeRecentDevices(storage: SessionStorage, list: RecentDevice[]): void {
  storage.set(RECENT_DEVICES_KEY, JSON.stringify(list));
}

/**
 * 记一次成功连接：同一 deviceId 只保留一条（更新时间与名字），
 * 然后按时间降序裁剪到上限。
 *
 * 返回更新后的列表，调用方据此刷新 UI，避免再读一次 storage。
 */
export function recordConnection(
  storage: SessionStorage,
  deviceId: string,
  name: string | undefined,
  nowMs: number,
): RecentDevice[] {
  const existing = loadRecentDevices(storage).filter((entry) => entry.deviceId !== deviceId);
  const entry: RecentDevice = {
    deviceId,
    ...(name !== undefined && name.length > 0 ? { name } : {}),
    lastConnectedAt: nowMs,
  };
  const next = [entry, ...existing]
    .sort((a, b) => b.lastConnectedAt - a.lastConnectedAt)
    .slice(0, MAX_RECENT_DEVICES);
  writeRecentDevices(storage, next);
  return next;
}

/**
 * 移除一台（deviceId 失效时，例如 iOS 换了 UUID）。
 * 不清空整张表：其它设备的记录仍然有价值。
 */
export function forgetDevice(storage: SessionStorage, deviceId: string): RecentDevice[] {
  const next = loadRecentDevices(storage).filter((entry) => entry.deviceId !== deviceId);
  writeRecentDevices(storage, next);
  return next;
}
