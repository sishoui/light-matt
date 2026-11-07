/**
 * 旧世界清理（#161）：首次启动时把 v4 留下的键删掉。
 *
 * ## 为什么需要它
 *
 * v5 是断崖：协议、持久化、编辑模型全换。v4 的方案草稿（`lumen.planDrafts.v1`）
 * 在新模型里**没有对应物**——草稿的键是「设备#灯组#槽位」，而 v5 的槽位概念
 * 整个没了（改成了部位 + 场景），语义对不上。P3 定的是「丢弃，不迁移」。
 *
 * 不清理的后果不是报错，而是**更难查的静默问题**：旧键占着用户存储配额，
 * 而且以后谁加了同名键就会读到一份结构完全不同的数据。
 *
 * ## 保留什么
 *
 * **灯组名与封面不能动**（P3）。它们是 `lumen.stripMeta.v1`，与设备上的配置
 * 无关，换手机、刷机都该还在。清理清单是一份**白名单**而不是黑名单：只有
 * 明确列出的键会被删，其余一律不碰——这样以后新增的存储键不会因为漏进黑名单
 * 而被误删。
 *
 * ## 为什么记一个标记
 *
 * 清理只做一次（`lumen.migrations.v1` 记已完成的那几条）。每次启动都扫一遍
 * 存储是白开销，而且如果用户在旧版本里又写了新草稿（回退安装），标记能让
 * 行为可预测：**迁移是一次性的语义，不是每次启动的守护**。
 *
 * 纯逻辑 + 注入存储，不碰 wx，可在 node 里直接测。
 */

import type { SessionStorage } from "./device-cache";

/** 迁移标记键：记录已经跑过的迁移 id（JSON 数组）。 */
export const MIGRATIONS_KEY = "lumen.migrations.v1";

/** v4 退役的键 → 为什么它退役了（删的时候顺手写进报告，便于排查）。 */
export const RETIRED_STORAGE_KEYS: ReadonlyArray<{ key: string; why: string }> = [
  {
    key: "lumen.planDrafts.v1",
    why: "v4 的方案草稿（键 = 设备#灯组#槽位）；v5 没有槽位，语义对不上（P3）",
  },
  {
    key: "lumen.mockActive.v1",
    why: "v4 的演示开关旧键；v5 用 lumen.mockMode.v1",
  },
  {
    key: "lumen.effectMode.v1",
    why: "v4 的「简单 / 进阶」档位；v5 没有两档（U3 简单档取消）",
  },
];

/** 本次迁移的 id（写进标记里，避免重复跑）。 */
export const RETIRED_KEYS_MIGRATION_ID = "retired-keys-v5";

/** 一次清理的结果。 */
export interface RetiredKeysResult {
  /** 这次真的删掉的键（不含本来就不存在的）。 */
  removed: string[];
  /** 启动前就已经跑过 → 什么都没做。 */
  skipped: boolean;
}

/**
 * 删掉 v4 留下的键。已经跑过就什么都不做（`skipped: true`）。
 *
 * `storage` 只需 `get/set/remove`，所以 Node 单测里能直接喂一个内存实现。
 */
export function purgeRetiredKeys(storage: SessionStorage): RetiredKeysResult {
  if (hasRun(storage)) {
    return { removed: [], skipped: true };
  }
  const removed: string[] = [];
  for (const entry of RETIRED_STORAGE_KEYS) {
    /* `get` 返回 null 说明本来就没有——不把「不存在」算成「删掉了」。 */
    if (storage.get(entry.key) !== null) {
      storage.remove(entry.key);
      removed.push(entry.key);
    }
  }
  markRun(storage);
  return { removed, skipped: false };
}

/** 这条迁移跑过没有。坏数据（不是数组）按「没跑过」处理。 */
export function hasRun(storage: SessionStorage): boolean {
  const raw = storage.get(MIGRATIONS_KEY);
  if (raw === null) {
    return false;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return false;
  }
  if (!Array.isArray(parsed)) {
    return false;
  }
  return parsed.includes(RETIRED_KEYS_MIGRATION_ID);
}

/** 记下这条迁移已完成（保留已有的其它迁移 id）。 */
export function markRun(storage: SessionStorage): void {
  const ids = runIds(storage);
  if (ids.includes(RETIRED_KEYS_MIGRATION_ID)) {
    return;
  }
  ids.push(RETIRED_KEYS_MIGRATION_ID);
  storage.set(MIGRATIONS_KEY, JSON.stringify(ids));
}

/** 标记里的迁移 id 列表（坏数据当作空表）。 */
export function runIds(storage: SessionStorage): string[] {
  const raw = storage.get(MIGRATIONS_KEY);
  if (raw === null) {
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter((item): item is string => typeof item === "string");
  } catch {
    return [];
  }
}

/**
 * 清理清单里**不该**出现的键（自检用）。
 *
 * 这是把 P3 那句「灯组名与封面保留」写成可执行的断言：谁将来往
 * `RETIRED_STORAGE_KEYS` 里加了 `lumen.stripMeta.v1`，这条会立刻红。
 */
export const PRESERVED_STORAGE_KEYS: readonly string[] = [
  "lumen.stripMeta.v1", // 灯组名与封面（P3：换手机 / 刷机都该在）
  "lumen.devicePhotos.v1", // 用户自己选的封面文件映射
  "lumen.theme.v1",
  "lumen.profile.v1",
  "lumen.recentDevices.v2",
  "lumen.deviceRegistry.v1",
  "lumen.lastDevice.v1",
  "lumen.identity.v1",
];
