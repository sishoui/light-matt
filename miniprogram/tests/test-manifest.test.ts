import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
// @ts-expect-error -- 仓库根的工具脚本是 .mjs，没有类型声明
import { checkManifest, discoverTests, loadManifest } from "../../scripts/check-test-manifest.mjs";

/**
 * 清单查漏这套工具本身也要被测，而且必须证明规则会抓错——否则它只是一个
 * 看起来在检查的脚本。每个用例在临时目录里造一棵最小的假仓库，不碰真仓库。
 */

const REPO = resolve(__dirname, "../..");

let root: string;

const writeFiles = (files: string[]) => {
  for (const rel of files) {
    const abs = join(root, rel);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, "// stub\n");
  }
};

const writeManifest = (files: Record<string, unknown>) => {
  mkdirSync(join(root, "docs"), { recursive: true });
  writeFileSync(join(root, "docs", "test-manifest.json"), JSON.stringify({ ...manifestWith(files) }, null, 2));
};

const manifestWith = (files: Record<string, unknown>) => ({
  version: 1,
  layers: {
    mp: { label: "小程序单测", cheap: true, requires: [], missingHint: "", scan: ["mp/tests/*.test.ts"] },
    ble: { label: "真机 e2e", cheap: false, requires: ["真机"], missingHint: "缺真机", scan: [] },
  },
  files,
});

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "lumen-manifest-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("discoverTests", () => {
  it("按层声明的通配收集文件，并记下归属层", () => {
    writeFiles(["mp/tests/a.test.ts", "mp/tests/b.test.ts", "mp/tests/helper.ts"]);

    const found = discoverTests(manifestWith({}), root);

    expect([...found.keys()].sort()).toEqual(["mp/tests/a.test.ts", "mp/tests/b.test.ts"]);
    expect(found.get("mp/tests/a.test.ts")).toBe("mp");
  });

  it("扫描目录不存在时安静返回空，不抛错", () => {
    expect(discoverTests(manifestWith({}), root).size).toBe(0);
  });

  it("支持不带通配的文件路径", () => {
    writeFiles(["firmware/test/test_skeleton.c"]);
    const manifest = manifestWith({}) as any;
    manifest.layers.firmware = {
      label: "固件",
      cheap: true,
      requires: [],
      missingHint: "",
      scan: ["firmware/test/test_skeleton.c"],
    };

    expect([...discoverTests(manifest, root).keys()]).toEqual(["firmware/test/test_skeleton.c"]);
  });
});

describe("checkManifest", () => {
  it("全部登记时通过", () => {
    writeFiles(["mp/tests/a.test.ts"]);
    const result = checkManifest(
      manifestWith({ "mp/tests/a.test.ts": { layer: "mp", covers: "某个行为" } }),
      root,
    );

    expect(result.ok).toBe(true);
    expect(result.total).toBe(1);
  });

  it("变异测试：仓库里有但清单没登记的文件会被抓住", () => {
    writeFiles(["mp/tests/a.test.ts", "mp/tests/surprise.test.ts"]);
    const result = checkManifest(
      manifestWith({ "mp/tests/a.test.ts": { layer: "mp", covers: "某个行为" } }),
      root,
    );

    expect(result.ok).toBe(false);
    expect(result.unregistered).toEqual([{ file: "mp/tests/surprise.test.ts", layer: "mp" }]);
  });

  it("变异测试：把漏掉的文件登记之后回到通过", () => {
    writeFiles(["mp/tests/a.test.ts", "mp/tests/surprise.test.ts"]);
    const result = checkManifest(
      manifestWith({
        "mp/tests/a.test.ts": { layer: "mp", covers: "某个行为" },
        "mp/tests/surprise.test.ts": { layer: "mp", covers: "补登记之后的行为" },
      }),
      root,
    );

    expect(result.ok).toBe(true);
    expect(result.unregistered).toEqual([]);
  });

  it("列出全部未登记文件，不只报第一个", () => {
    writeFiles(["mp/tests/x.test.ts", "mp/tests/y.test.ts", "mp/tests/z.test.ts"]);
    const result = checkManifest(manifestWith({}), root);

    expect(result.unregistered.map((item: { file: string }) => item.file)).toEqual([
      "mp/tests/x.test.ts",
      "mp/tests/y.test.ts",
      "mp/tests/z.test.ts",
    ]);
  });

  it("清单里有但文件已删掉的条目也算问题", () => {
    const result = checkManifest(
      manifestWith({ "mp/tests/gone.test.ts": { layer: "mp", covers: "已经不存在的文件" } }),
      root,
    );

    expect(result.ok).toBe(false);
    expect(result.missing).toEqual([{ file: "mp/tests/gone.test.ts", layer: "mp" }]);
  });

  it("登记的层与实际扫描到的层不一致会被抓住", () => {
    writeFiles(["mp/tests/a.test.ts"]);
    const result = checkManifest(
      manifestWith({ "mp/tests/a.test.ts": { layer: "ble", covers: "层标错了" } }),
      root,
    );

    expect(result.ok).toBe(false);
    expect(result.misplaced).toEqual([
      { file: "mp/tests/a.test.ts", declared: "ble", actual: "mp" },
    ]);
  });

  it("声明了清单里不存在的层会被抓住", () => {
    writeFiles(["mp/tests/a.test.ts"]);
    const result = checkManifest(
      manifestWith({ "mp/tests/a.test.ts": { layer: "ghost", covers: "层名拼错" } }),
      root,
    );

    expect(result.ok).toBe(false);
    expect(result.unknownLayer).toEqual([{ file: "mp/tests/a.test.ts", layer: "ghost" }]);
  });

  it("没有覆盖说明的条目会被抓住", () => {
    writeFiles(["mp/tests/a.test.ts"]);
    const result = checkManifest(
      manifestWith({ "mp/tests/a.test.ts": { layer: "mp", covers: "   " } }),
      root,
    );

    expect(result.ok).toBe(false);
    expect(result.emptyCovers).toEqual([{ file: "mp/tests/a.test.ts" }]);
  });

  it("改一行覆盖说明不会破坏判定", () => {
    writeFiles(["mp/tests/a.test.ts"]);
    const before = checkManifest(
      manifestWith({ "mp/tests/a.test.ts": { layer: "mp", covers: "旧说法" } }),
      root,
    );
    const after = checkManifest(
      manifestWith({ "mp/tests/a.test.ts": { layer: "mp", covers: "换了个更准确的说法" } }),
      root,
    );

    expect(before.ok).toBe(true);
    expect(after.ok).toBe(true);
  });
});

describe("仓库自身的清单", () => {
  it("docs/test-manifest.json 与真实仓库一致", () => {
    const manifest = loadManifest(REPO);
    const result = checkManifest(manifest, REPO);

    expect(result.unregistered).toEqual([]);
    expect(result.missing).toEqual([]);
    expect(result.misplaced).toEqual([]);
    expect(result.unknownLayer).toEqual([]);
    expect(result.emptyCovers).toEqual([]);
    expect(result.total).toBeGreaterThan(70);
  });

  it("五层都有定义，且有环境成本的层写明了缺什么", () => {
    const manifest = loadManifest(REPO);

    expect(Object.keys(manifest.layers).sort()).toEqual(["ble", "firmware", "mp", "server", "ui"]);
    for (const [name, layer] of Object.entries<any>(manifest.layers)) {
      if (layer.cheap) continue;
      expect(layer.missingHint, `${name} 层必须写明缺环境时缺什么`).toBeTruthy();
      expect(layer.requires.length, `${name} 层必须列出前置条件`).toBeGreaterThan(0);
    }
  });

  it("每个已登记的文件都有非空的覆盖说明", () => {
    const manifest = loadManifest(REPO);
    for (const [file, entry] of Object.entries<any>(manifest.files)) {
      expect(String(entry.covers).trim().length, `${file} 缺少覆盖说明`).toBeGreaterThan(0);
    }
  });
});
