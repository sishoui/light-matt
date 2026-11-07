/**
 * 旧世界清理（#161）：首次启动删掉 v4 的退役键，且**不碰灯组名与封面**。
 *
 * 这一条以前是假的：`delete-device.ts` 里 `planDraftsCleared` 硬写 0，注释说
 * 「v5 已经没有本地草稿」。话没说错，但**没人清过旧键**——用户从 v4 升上来，
 * `lumen.planDrafts.v1` 会一直躺在存储里。所以这里测的是「真的删了」。
 */

import { describe, expect, it } from "vitest";
import {
  MIGRATIONS_KEY,
  PRESERVED_STORAGE_KEYS,
  RETIRED_KEYS_MIGRATION_ID,
  RETIRED_STORAGE_KEYS,
  hasRun,
  markRun,
  purgeRetiredKeys,
  runIds,
} from "../utils/control/migrations";
import type { SessionStorage } from "../utils/control/device-cache";

/** 内存存储。 */
function memoryStorage(seed: Record<string, string> = {}): SessionStorage & {
  dump(): Record<string, string>;
} {
  const map = new Map<string, string>(Object.entries(seed));
  return {
    get: (key) => (map.has(key) ? (map.get(key) as string) : null),
    set: (key, value) => void map.set(key, value),
    remove: (key) => void map.delete(key),
    dump: () => Object.fromEntries(map.entries()),
  };
}

describe("清理退役键", () => {
  it("删掉 v4 的方案草稿", () => {
    const storage = memoryStorage({
      "lumen.planDrafts.v1": JSON.stringify({ "AA:BB#0#0": { steps: [] } }),
    });
    const result = purgeRetiredKeys(storage);
    expect(result.skipped).toBe(false);
    expect(result.removed).toContain("lumen.planDrafts.v1");
    expect(storage.get("lumen.planDrafts.v1")).toBeNull();
  });

  it("本来不存在的键不算「删掉了」（报告要诚实）", () => {
    const storage = memoryStorage({});
    const result = purgeRetiredKeys(storage);
    expect(result.removed).toEqual([]);
    expect(result.skipped).toBe(false);
  });

  it("只删清单里的键，别的都不碰", () => {
    const storage = memoryStorage({
      "lumen.planDrafts.v1": "{}",
      "lumen.stripMeta.v1": '{"AA#0":{"name":"床头"}}',
      "lumen.theme.v1": "dark",
      "lumen.unknownFutureKey.v1": "whatever",
    });
    purgeRetiredKeys(storage);

    expect(storage.get("lumen.planDrafts.v1")).toBeNull();
    /* 未知键不碰：清理是白名单，不是黑名单。 */
    expect(storage.get("lumen.unknownFutureKey.v1")).toBe("whatever");
    expect(storage.get("lumen.theme.v1")).toBe("dark");
    expect(storage.get("lumen.stripMeta.v1")).not.toBeNull();
  });
});

describe("灯组名与封面保留（P3）", () => {
  it("清理后灯组元数据逐字节不变", () => {
    const meta = JSON.stringify({
      "AA:BB:CC:DD:EE:FF#0": { name: "床头", photo: "wxfile://tmp/a.jpg" },
      "AA:BB:CC:DD:EE:FF#1": { name: "书架" },
    });
    const storage = memoryStorage({
      "lumen.planDrafts.v1": "{}",
      "lumen.stripMeta.v1": meta,
      "lumen.devicePhotos.v1": '{"AA:BB":"wxfile://tmp/b.jpg"}',
    });
    purgeRetiredKeys(storage);

    expect(storage.get("lumen.stripMeta.v1")).toBe(meta);
    expect(storage.get("lumen.devicePhotos.v1")).toBe('{"AA:BB":"wxfile://tmp/b.jpg"}');
  });

  it("保留清单不与退役清单重叠（防以后有人把 stripMeta 加进去）", () => {
    const retired = RETIRED_STORAGE_KEYS.map((entry) => entry.key);
    for (const key of PRESERVED_STORAGE_KEYS) {
      expect(retired, `「${key}」既在保留清单又在退役清单里`).not.toContain(key);
    }
  });

  it("退役清单里的每一项都写清了为什么退役", () => {
    for (const entry of RETIRED_STORAGE_KEYS) {
      expect(entry.why.length, `${entry.key} 没写理由`).toBeGreaterThan(4);
    }
  });
});

describe("只跑一次", () => {
  it("第一次跑会写标记；第二次跳过", () => {
    const storage = memoryStorage({ "lumen.planDrafts.v1": "{}" });
    const first = purgeRetiredKeys(storage);
    expect(first.skipped).toBe(false);
    expect(hasRun(storage)).toBe(true);

    /* 用户回退到旧版又写了草稿，再升上来：标记在，所以不再清。 */
    storage.set("lumen.planDrafts.v1", "{}");
    const second = purgeRetiredKeys(storage);
    expect(second.skipped).toBe(true);
    expect(second.removed).toEqual([]);
    expect(storage.get("lumen.planDrafts.v1")).toBe("{}");
  });

  it("标记是 JSON 数组，保留别的迁移 id", () => {
    const storage = memoryStorage({ [MIGRATIONS_KEY]: JSON.stringify(["other-migration"]) });
    markRun(storage);
    expect(runIds(storage)).toEqual(["other-migration", RETIRED_KEYS_MIGRATION_ID]);
  });

  it("标记坏掉（不是数组 / 不是 JSON）当作没跑过", () => {
    for (const bad of ["not json", '"a string"', "{}", "123"]) {
      const storage = memoryStorage({
        [MIGRATIONS_KEY]: bad,
        "lumen.planDrafts.v1": "{}",
      });
      expect(hasRun(storage)).toBe(false);
      const result = purgeRetiredKeys(storage);
      expect(result.skipped).toBe(false);
      expect(storage.get("lumen.planDrafts.v1")).toBeNull();
    }
  });

  it("重复 markRun 不产生重复 id", () => {
    const storage = memoryStorage({});
    markRun(storage);
    markRun(storage);
    markRun(storage);
    expect(runIds(storage)).toEqual([RETIRED_KEYS_MIGRATION_ID]);
  });
});
