/**
 * 内存版 SessionStorage（测试共用）。
 *
 * 与 `device-cache.ts` 的 `createWxStorage` 同接口，但不碰 wx——node 里
 * 所有需要「预置存储内容」的用例都用它。
 */

import type { SessionStorage } from "../../utils/control/device-cache";

export interface MemoryStorage extends SessionStorage {
  /** 直接看写入的内容（断言用）。 */
  readonly map: Map<string, string>;
}

export function createSessionStorage(seed: Record<string, string> = {}): MemoryStorage {
  const map = new Map<string, string>(Object.entries(seed));
  return {
    map,
    get(key) {
      return map.get(key) ?? null;
    },
    set(key, value) {
      map.set(key, value);
    },
    remove(key) {
      map.delete(key);
    },
  };
}
