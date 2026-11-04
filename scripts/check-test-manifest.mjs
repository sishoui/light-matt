#!/usr/bin/env node
/**
 * 测试清单查漏：仓库里存在的测试文件必须在 docs/test-manifest.json 里登记。
 *
 * 未登记 = 一轮测试里有人不知道自己跑了什么，正是这套流程要消灭的东西，
 * 所以这里判失败而不是警告。
 *
 * 用法：
 *   node scripts/check-test-manifest.mjs
 *   node scripts/check-test-manifest.mjs --json
 *
 * 退出码：0 通过 / 1 有未登记文件或有登记了但文件不存在的条目 / 2 清单本身读不了。
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO = resolve(HERE, "..");
const MANIFEST = join(REPO, "docs", "test-manifest.json");

const toPosix = (p) => p.split(sep).join("/");

/** 单层通配：只支持文件名里的 `*`，不跨目录。够用，也不会误抓子目录。 */
function scanPattern(repoRoot, pattern) {
  const slash = pattern.lastIndexOf("/");
  const dir = slash < 0 ? "" : pattern.slice(0, slash);
  const name = slash < 0 ? pattern : pattern.slice(slash + 1);
  const absDir = join(repoRoot, dir);

  let entries;
  try {
    entries = readdirSync(absDir);
  } catch {
    return [];
  }

  if (!name.includes("*")) {
    const abs = join(absDir, name);
    try {
      return statSync(abs).isFile() ? [toPosix(relative(repoRoot, abs))] : [];
    } catch {
      return [];
    }
  }

  const [prefix, suffix] = name.split("*");
  return entries
    .filter((entry) => {
      if (!entry.startsWith(prefix) || !entry.endsWith(suffix)) return false;
      try {
        return statSync(join(absDir, entry)).isFile();
      } catch {
        return false;
      }
    })
    .map((entry) => toPosix(relative(repoRoot, join(absDir, entry))))
    .sort();
}

export function loadManifest(repoRoot = REPO) {
  const raw = readFileSync(join(repoRoot, "docs", "test-manifest.json"), "utf8");
  const manifest = JSON.parse(raw);
  if (!manifest.layers || typeof manifest.layers !== "object") {
    throw new Error("manifest 缺少 layers");
  }
  if (!manifest.files || typeof manifest.files !== "object") {
    throw new Error("manifest 缺少 files");
  }
  return manifest;
}

/** 按各层声明的 scan 收集仓库里实际存在的测试文件。 */
export function discoverTests(manifest, repoRoot = REPO) {
  const found = new Map();
  for (const [layerName, layer] of Object.entries(manifest.layers)) {
    for (const pattern of layer.scan ?? []) {
      for (const file of scanPattern(repoRoot, pattern)) {
        found.set(file, layerName);
      }
    }
  }
  return found;
}

/**
 * 对比清单与仓库。返回三类问题：
 *  - unregistered：仓库里有、清单里没有（最要紧）
 *  - missing：清单里有、仓库里没有（清单腐化）
 *  - misplaced：登记了，但声明的层与实际扫描到的层不一致
 */
export function checkManifest(manifest, repoRoot = REPO) {
  const discovered = discoverTests(manifest, repoRoot);
  const declared = manifest.files;

  const unregistered = [];
  const misplaced = [];

  for (const [file, actualLayer] of discovered) {
    const entry = declared[file];
    if (!entry) {
      unregistered.push({ file, layer: actualLayer });
      continue;
    }
    if (entry.layer !== actualLayer) {
      misplaced.push({ file, declared: entry.layer, actual: actualLayer });
    }
  }

  const missing = Object.keys(declared)
    .filter((file) => !discovered.has(file))
    .map((file) => ({ file, layer: declared[file].layer }));

  const unknownLayer = Object.entries(declared)
    .filter(([, entry]) => !manifest.layers[entry.layer])
    .map(([file, entry]) => ({ file, layer: entry.layer }));

  const emptyCovers = Object.entries(declared)
    .filter(([, entry]) => !entry.covers || !String(entry.covers).trim())
    .map(([file]) => ({ file }));

  const ok =
    unregistered.length === 0 &&
    missing.length === 0 &&
    misplaced.length === 0 &&
    unknownLayer.length === 0 &&
    emptyCovers.length === 0;

  return {
    ok,
    total: discovered.size,
    unregistered,
    missing,
    misplaced,
    unknownLayer,
    emptyCovers,
  };
}

function main() {
  const asJson = process.argv.includes("--json");
  let manifest;
  try {
    manifest = loadManifest();
  } catch (error) {
    if (asJson) {
      console.log(JSON.stringify({ ok: false, error: String(error.message ?? error) }));
    } else {
      console.error(`[manifest] 清单读取失败：${error.message ?? error}`);
    }
    process.exit(2);
  }

  const result = checkManifest(manifest);

  if (asJson) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    for (const item of result.unregistered) {
      console.error(`[manifest] 未登记：${item.file}（应属 ${item.layer} 层）`);
    }
    for (const item of result.missing) {
      console.error(`[manifest] 文件不存在：${item.file}（登记为 ${item.layer} 层）`);
    }
    for (const item of result.misplaced) {
      console.error(
        `[manifest] 层不一致：${item.file} 登记为 ${item.declared}，实际属 ${item.actual}`,
      );
    }
    for (const item of result.unknownLayer) {
      console.error(`[manifest] 未知层：${item.file} 声明了 ${item.layer}`);
    }
    for (const item of result.emptyCovers) {
      console.error(`[manifest] 缺少覆盖说明：${item.file}`);
    }
    if (result.ok) {
      console.log(`[manifest] ${result.total} 个测试文件全部已登记`);
    }
  }

  process.exit(result.ok ? 0 : 1);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
