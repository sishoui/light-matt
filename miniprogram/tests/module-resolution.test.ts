/**
 * 小程序模块解析契约：**不允许目录导入**。
 *
 * 微信小程序的模块解析器不认 `index.ts`：写 `import x from "../usage"` 时
 * TypeScript 编译期完全正常（`tsc --noEmit` 干净、node 侧 vitest 也全过），
 * 但运行时抛
 *
 *     module 'utils/usage.js' is not defined, require args is '../usage'
 *
 * 后果是灾难性的：`utils/control/session-singleton.ts` 是 App 启动链的必经
 * 节点，它一崩，所有页面的 `Page()` 都不执行，整个小程序白屏，控制台只有
 * `Page "pages/xxx" has not been registered yet.`。
 *
 * 这个缺陷曾真实存在于仓库里（`from "../usage"` → `from "../usage/index"`），
 * 三端测试全绿、自动化构建成功，只有真机/模拟器才暴露。所以这条契约必须由
 * 测试守住，而不是靠 review 记忆。
 */

import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** 递归收集 src 下所有 .ts（跳过 node_modules / tests）。 */
function collectTs(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "tests" || entry === ".auto") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      collectTs(full, out);
    } else if (entry.endsWith(".ts") && !entry.endsWith(".d.ts")) {
      out.push(full);
    }
  }
  return out;
}

/** 抓出所有 `from "..."` 里的相对路径。 */
function relativeImports(src: string): string[] {
  const out: string[] = [];
  const re = /from\s+["'](\.[^"']+)["']/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) out.push(m[1]);
  return out;
}

describe("小程序模块解析：禁止目录导入", () => {
  const files = collectTs(ROOT);
  const offenders: string[] = [];

  for (const file of files) {
    const src = readFileSync(file, "utf8");
    for (const spec of relativeImports(src)) {
      const target = resolve(dirname(file), spec);
      let isDir = false;
      try {
        isDir = statSync(target).isDirectory();
      } catch {
        /* 路径不存在：交给 tsc 报错，这里只管目录 */
      }
      if (isDir) {
        offenders.push(`${relative(ROOT, file)} → "${spec}"`);
      }
    }
  }

  it("所有相对 import 都指向具体文件，而不是目录", () => {
    expect(offenders).toEqual([]);
  });

  it("覆盖到了 App 启动链（防止扫描失效导致空过）", () => {
    const names = files.map((f) => relative(ROOT, f).replace(/\\/g, "/"));
    expect(names).toContain("app.ts");
    expect(names).toContain("utils/control/session-singleton.ts");
    expect(names.length).toBeGreaterThan(40);
  });

  it("能识别出目录导入（变异测试：判定逻辑本身有效）", () => {
    /* 用真实存在的目录构造一个违规样本，确认上面那条规则确实会红。 */
    const fake = resolve(ROOT, "utils/control");
    const sample = `import { x } from "../usage";`;
    const spec = relativeImports(sample)[0];
    const target = resolve(dirname(join(ROOT, "utils/control/_probe.ts")), spec);
    expect(target).toBe(resolve(ROOT, "utils/usage"));
    expect(statSync(target).isDirectory()).toBe(true);
    expect(statSync(fake).isDirectory()).toBe(true);
  });
});
