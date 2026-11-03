/**
 * #94 灯组元数据（名称与封面）的存取契约。
 *
 * 锁四件事：
 *  1. 默认名是「灯组 N」（从 1 编号）与默认占位图按灯组号固定分配；
 *  2. 读写往返（设置 / 清除 / 空串等于恢复默认）；
 *  3. 键由设备稳定标识 + 灯组号组成（iOS 换 UUID 后仍跟着走）；
 *  4. 删除设备时按前缀清理，不碰别的设备。
 */

import { describe, expect, it } from "vitest";
import {
  STRIP_META_KEY,
  STRIP_PLACEHOLDER_PHOTOS,
  clearStripMetaForDevice,
  countStripMetaForDevice,
  defaultStripName,
  defaultStripPhoto,
  getStripMeta,
  loadStripMeta,
  resolveStripMeta,
  resolveStripMetas,
  setStripName,
  setStripPhoto,
  stripMetaKey,
} from "../utils/control/strip-meta";
import type { SessionStorage } from "../utils/control/device-cache";

function memoryStorage(initial: Record<string, string> = {}): SessionStorage {
  const map = new Map(Object.entries(initial));
  return {
    get: (key) => map.get(key) ?? null,
    set: (key, value) => void map.set(key, value),
    remove: (key) => void map.delete(key),
  };
}

describe("默认值", () => {
  it("默认名是「灯组 N」，从 1 编号", () => {
    expect(defaultStripName(0)).toBe("灯组 1");
    expect(defaultStripName(7)).toBe("灯组 8");
  });

  it("默认占位图按灯组号对素材取模，同一灯组每次都一样", () => {
    const n = STRIP_PLACEHOLDER_PHOTOS.length;
    for (let stripId = 0; stripId < 16; stripId += 1) {
      expect(defaultStripPhoto(stripId)).toBe(STRIP_PLACEHOLDER_PHOTOS[stripId % n]);
      /* 幂等：连调两次结果相同（不会每次随机换图）。 */
      expect(defaultStripPhoto(stripId)).toBe(defaultStripPhoto(stripId));
    }
  });

  it("占位图三张互不相同（不是复制粘贴同一张）", () => {
    expect(new Set(STRIP_PLACEHOLDER_PHOTOS).size).toBe(STRIP_PLACEHOLDER_PHOTOS.length);
  });

  it("没设置过时 resolve 给出默认名与默认图", () => {
    const meta = resolveStripMeta(memoryStorage(), "dev-1", 2);
    expect(meta).toEqual({
      stripId: 2,
      name: "灯组 3",
      photo: defaultStripPhoto(2),
      nameIsCustom: false,
      photoIsCustom: false,
    });
  });
});

describe("存取", () => {
  it("设置名字后读回；metadata 里只有 name", () => {
    const storage = memoryStorage();
    setStripName(storage, "dev-1", 0, "书桌");
    expect(getStripMeta(storage, "dev-1", 0)).toEqual({ name: "书桌" });
    const meta = resolveStripMeta(storage, "dev-1", 0);
    expect(meta.name).toBe("书桌");
    expect(meta.nameIsCustom).toBe(true);
    expect(meta.photo).toBe(defaultStripPhoto(0));
  });

  it("设置封面后读回", () => {
    const storage = memoryStorage();
    setStripPhoto(storage, "dev-1", 1, "/tmp/a.jpg");
    expect(getStripMeta(storage, "dev-1", 1)).toEqual({ photo: "/tmp/a.jpg" });
    expect(resolveStripMeta(storage, "dev-1", 1).photo).toBe("/tmp/a.jpg");
    expect(resolveStripMeta(storage, "dev-1", 1).photoIsCustom).toBe(true);
  });

  it("名字与封面互不覆盖", () => {
    const storage = memoryStorage();
    setStripName(storage, "dev-1", 0, "客厅");
    setStripPhoto(storage, "dev-1", 0, "/tmp/x.jpg");
    expect(getStripMeta(storage, "dev-1", 0)).toEqual({ name: "客厅", photo: "/tmp/x.jpg" });
  });

  it("空串 / null 等于恢复默认（删字段，不留空串）", () => {
    const storage = memoryStorage();
    setStripName(storage, "dev-1", 0, "客厅");
    setStripPhoto(storage, "dev-1", 0, "/tmp/x.jpg");
    setStripName(storage, "dev-1", 0, "   ");
    expect(getStripMeta(storage, "dev-1", 0)).toEqual({ photo: "/tmp/x.jpg" });
    setStripPhoto(storage, "dev-1", 0, null);
    /* 两个字段都没了：整条记录删掉，读表里不留空壳。 */
    expect(loadStripMeta(storage)).toEqual({});
  });

  it("名字去首尾空白", () => {
    const storage = memoryStorage();
    setStripName(storage, "dev-1", 0, "  卧室  ");
    expect(getStripMeta(storage, "dev-1", 0).name).toBe("卧室");
  });

  it("不同灯组互不影响", () => {
    const storage = memoryStorage();
    setStripName(storage, "dev-1", 0, "A");
    setStripName(storage, "dev-1", 1, "B");
    expect(resolveStripMetas(storage, "dev-1", [0, 1, 2]).map((m) => m.name)).toEqual([
      "A",
      "B",
      "灯组 3",
    ]);
  });
});

describe("键与设备隔离", () => {
  it("键是 `deviceKey#stripId`", () => {
    expect(stripMetaKey("hw-abc", 3)).toBe("hw-abc#3");
  });

  it("同一灯组号在不同设备上是两条记录", () => {
    const storage = memoryStorage();
    setStripName(storage, "dev-a", 0, "甲");
    setStripName(storage, "dev-b", 0, "乙");
    expect(resolveStripMeta(storage, "dev-a", 0).name).toBe("甲");
    expect(resolveStripMeta(storage, "dev-b", 0).name).toBe("乙");
  });

  it("hardwareId 变了（iOS 换 UUID）仍能按 hardwareId 取到", () => {
    const storage = memoryStorage();
    setStripName(storage, "AA:BB:CC", 0, "书桌");
    expect(resolveStripMeta(storage, "AA:BB:CC", 0).name).toBe("书桌");
  });
});

describe("按设备前缀清理", () => {
  it("只删这台设备的条目，并返回要删的封面文件", () => {
    const storage = memoryStorage();
    setStripName(storage, "dev-a", 0, "甲");
    setStripPhoto(storage, "dev-a", 1, "/tmp/a1.jpg");
    setStripPhoto(storage, "dev-a", 2, "/tmp/a2.jpg");
    setStripName(storage, "dev-b", 0, "乙");

    const { removedPhotos } = clearStripMetaForDevice(storage, "dev-a");
    expect(removedPhotos.sort()).toEqual(["/tmp/a1.jpg", "/tmp/a2.jpg"]);
    expect(countStripMetaForDevice(storage, "dev-a")).toBe(0);
    /* 别的设备原样保留。 */
    expect(resolveStripMeta(storage, "dev-b", 0).name).toBe("乙");
  });

  it("前缀匹配不会误伤名字相近的设备（dev-a 不能吃掉 dev-ab）", () => {
    const storage = memoryStorage();
    setStripName(storage, "dev-a", 0, "甲");
    setStripName(storage, "dev-ab", 0, "丙");
    clearStripMetaForDevice(storage, "dev-a");
    expect(countStripMetaForDevice(storage, "dev-a")).toBe(0);
    expect(resolveStripMeta(storage, "dev-ab", 0).name).toBe("丙");
  });

  it("空 deviceKey 不清任何东西", () => {
    const storage = memoryStorage();
    setStripName(storage, "dev-a", 0, "甲");
    const { removedPhotos } = clearStripMetaForDevice(storage, "");
    expect(removedPhotos).toEqual([]);
    expect(countStripMetaForDevice(storage, "dev-a")).toBe(1);
  });
});

describe("坏数据", () => {
  it("JSON 损坏 → 空表，不抛错", () => {
    const storage = memoryStorage({ [STRIP_META_KEY]: "{not json" });
    expect(loadStripMeta(storage)).toEqual({});
    expect(resolveStripMeta(storage, "dev-1", 0).name).toBe("灯组 1");
  });

  it("结构不对的条目逐条丢弃", () => {
    const storage = memoryStorage({
      [STRIP_META_KEY]: JSON.stringify({
        "dev-1#0": { name: "好的" },
        "dev-1#1": { name: 42 },
        "dev-1#2": "nope",
        "dev-1#3": { photo: "/tmp/ok.jpg" },
      }),
    });
    const map = loadStripMeta(storage);
    expect(Object.keys(map).sort()).toEqual(["dev-1#0", "dev-1#3"]);
    expect(map["dev-1#0"]).toEqual({ name: "好的" });
  });

  it("数组 / null 也按空表处理", () => {
    expect(loadStripMeta(memoryStorage({ [STRIP_META_KEY]: "[]" }))).toEqual({});
    expect(loadStripMeta(memoryStorage({ [STRIP_META_KEY]: "null" }))).toEqual({});
  });
});
