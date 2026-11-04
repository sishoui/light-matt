/**
 * 「用户显式删除过的演示设备」（#91）。
 *
 * ## 为什么需要单独记一笔
 *
 * 演示模式（`utils/control/mock-mode.ts`）在**没有真机记录**时会自动开启并
 * 播种三台演示设备。如果用户把其中一台删掉，下次启动时 `reconcileMockMode`
 * 看到「没有真机记录 + 自动开启」又会把它播种回来——「删除」当场失效。
 *
 * 所以删除时要留下一条持久标记：这些 deviceId 是用户**主动删掉的**，
 * 播种时跳过它们，直到用户关掉再打开演示模式（那是一次显式重置）。
 *
 * 标记按 deviceId 存，与演示设备的播种逻辑同源；不写进登记表，因为登记表
 * 的语义是「用户对设备做的决定」而不是「播种黑名单」。
 */

import type { SessionStorage } from "./device-cache";
import { isMockDeviceId } from "./mock-mode";

/** 存储键（含版本）。 */
export const MOCK_DELETED_KEY = "lumen.mockDeleted.v1";

/** 演示设备会话的最小接口（`deleteDeviceFully` 只用到这个形状）。 */
export interface MockSessionLike {
  readonly linkState: string;
}

function parseList(raw: string | null): string[] {
  if (raw === null || raw.length === 0) {
    return [];
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter((item): item is string => typeof item === "string" && item.length > 0);
  } catch {
    return [];
  }
}

/** 被用户显式删除过的演示 deviceId 列表。 */
export function loadMockDeleted(storage: SessionStorage): string[] {
  return parseList(storage.get(MOCK_DELETED_KEY));
}

/** 记下「用户删掉了这台演示设备」。非演示设备忽略（不写无用标记）。 */
export function markMockDeleted(storage: SessionStorage, deviceId: string): string[] {
  if (deviceId.length === 0 || !isMockDeviceId(deviceId)) {
    return loadMockDeleted(storage);
  }
  const list = loadMockDeleted(storage);
  if (list.includes(deviceId)) {
    return list;
  }
  const next = [...list, deviceId];
  storage.set(MOCK_DELETED_KEY, JSON.stringify(next));
  return next;
}

/** 用户关掉 / 重新打开演示模式 = 显式重置：清空标记，下次照常播种。 */
export function clearMockDeleted(storage: SessionStorage): void {
  storage.remove(MOCK_DELETED_KEY);
}

/** 某台演示设备是否被显式删除过（播种时用）。 */
export function isMockDeleted(storage: SessionStorage, deviceId: string): boolean {
  return loadMockDeleted(storage).includes(deviceId);
}
