/**
 * 使用日志用的键值存储接缝。
 *
 * 与 `SessionStorage` 形状相同（读写字符串），但单独定义，避免 usage 模块
 * 反向依赖 control/session。生产实现走 wx.storage；单测注入内存实现。
 *
 * 存储失败一律吞掉：记录使用日志是「尽力而为」的旁路，绝不能因为存储异常
 * 影响 BLE 控制。
 */

export interface UsageStorage {
  get(key: string): string | null;
  set(key: string, value: string): void;
  remove(key: string): void;
}

/** 默认存储：Node（vitest）里没有 wx，所有操作安全降级为空操作。 */
export function createWxUsageStorage(): UsageStorage {
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
        /* 存储失败不影响控制 */
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

/** 内存实现：单测用（不是 wx 假件，只是存储后端）。 */
export function createMemoryUsageStorage(seed: Record<string, string> = {}): UsageStorage {
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
