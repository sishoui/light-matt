/**
 * deviceId 缓存：只存「上次连过的设备身份」，绝不缓存状态（设备是状态权威）。
 *
 * 缓存值与键名带版本号，避免读到旧结构。存储后端默认走 wx.storage；
 * 单测注入内存实现（spec 允许的假件之一），本模块不与 BLE 打交道。
 */

/** deviceId 缓存后端。默认 wx.storage；单测注入内存实现（不是 BLE 假件）。 */
export interface SessionStorage {
  get(key: string): string | null;
  set(key: string, value: string): void;
  remove(key: string): void;
}

export interface CachedDevice {
  deviceId: string;
  name?: string;
}

/** deviceId 缓存键（含版本，避免读到旧结构）。 */
export const DEVICE_CACHE_KEY = "lumen.lastDevice.v1";

/** 默认 storage：wx.setStorageSync。Node 单测里没有 wx，调用一律安全降级。 */
export function createWxStorage(): SessionStorage {
  const available =
    typeof wx !== "undefined" &&
    typeof wx.getStorageSync === "function" &&
    typeof wx.setStorageSync === "function";
  return {
    get(key) {
      if (!available) return null;
      try {
        const value = wx.getStorageSync(key);
        return typeof value === "string" && value.length > 0 ? value : null;
      } catch {
        return null;
      }
    },
    set(key, value) {
      if (!available) return;
      try {
        wx.setStorageSync(key, value);
      } catch {
        /* 存储失败不影响连接 */
      }
    },
    remove(key) {
      if (!available) return;
      try {
        wx.removeStorageSync(key);
      } catch {
        /* ignore */
      }
    },
  };
}

/** 读缓存并解析；任何异常/非法结构都按「没有缓存」处理。 */
export function loadCachedDevice(storage: SessionStorage): CachedDevice | null {
  const raw = storage.get(DEVICE_CACHE_KEY);
  if (raw === null) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as { deviceId?: unknown; name?: unknown };
    if (typeof parsed?.deviceId !== "string" || parsed.deviceId.length === 0) {
      return null;
    }
    return {
      deviceId: parsed.deviceId,
      ...(typeof parsed.name === "string" && parsed.name.length > 0 ? { name: parsed.name } : {}),
    };
  } catch {
    return null;
  }
}

/** 写入缓存；name 为空串/未给出时不写该字段（与读出结构对称）。 */
export function saveCachedDevice(
  storage: SessionStorage,
  deviceId: string,
  name?: string,
): CachedDevice {
  const cached: CachedDevice = {
    deviceId,
    ...(name !== undefined && name.length > 0 ? { name } : {}),
  };
  storage.set(DEVICE_CACHE_KEY, JSON.stringify(cached));
  return cached;
}

/** 清缓存。 */
export function clearCachedDevice(storage: SessionStorage): void {
  storage.remove(DEVICE_CACHE_KEY);
}
