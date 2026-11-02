/**
 * 小程序页面字段契约：**非 `data` 的字段必须在 `onLoad` 里初始化**。
 *
 * 微信的 `Page({...})` 只保证 `data` 里的字段出现在 `this.data`；写在对象
 * 字面量上的其它字段（如 `remoteDevices: [] as X[]`）**不保证被复制到页面
 * 实例**。TypeScript 断言只是编译期语法，运行时就是 `undefined`。
 *
 * 真实事故（开发者工具 2.02 实测）：
 *
 *     TypeError: Cannot read properties of undefined (reading 'length')
 *         at applyListViews (devices.js)
 *         at refreshLocal (devices.js)
 *         at onLoad (devices.js)
 *
 * `applyListViews` 读 `this.remoteDevices.length`，而它在 `onLoad` 的调用链
 * 上 → 页面初始化中断 → **所有 `bindtap` 都不再响应**。表现是「点扫描 /
 * 连接 / 取消全都没反应」，但：
 *
 *   - `tsc --noEmit` 干净；
 *   - 615 个单测全过（它们直接 new ControlSession，不经过 Page()）；
 *   - 构建成功、页面也能渲染出静态内容。
 *
 * 和 `module-resolution.test.ts` 是同一类陷阱：只有模拟器/真机能发现。
 *
 * 这条测试的做法：静态扫描每个 `pages/*\/\*.ts` 的 `Page({...})`，取出
 * 非 data 字段里的**数组/对象字面量初始化**，断言同名 `onLoad` 里出现过
 * 一次赋值。不用 AST 是为了避免给测试引入额外依赖；这里的代码形态足够规整。
 */

import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PAGES_DIR = join(ROOT, "pages");

function pageFiles(): string[] {
  const out: string[] = [];
  for (const dir of readdirSync(PAGES_DIR)) {
    let entries: string[];
    try {
      entries = readdirSync(join(PAGES_DIR, dir));
    } catch {
      continue;
    }
    for (const name of entries) {
      if (name.endsWith(".ts")) out.push(join(PAGES_DIR, dir, name));
    }
  }
  return out;
}

/** 取 `Page({` 之后、`data:` 块之外、`onLoad` 之前的字段声明名。 */
function nonDataFields(src: string): string[] {
  const start = src.indexOf("Page({");
  if (start < 0) return [];
  const dataAt = src.indexOf("data:", start);
  if (dataAt < 0) return [];
  /* 配对找到 data 块的结束花括号。 */
  let depth = 0;
  let dataEnd = -1;
  for (let i = src.indexOf("{", dataAt); i < src.length; i += 1) {
    if (src[i] === "{") depth += 1;
    else if (src[i] === "}") {
      depth -= 1;
      if (depth === 0) {
        dataEnd = i;
        break;
      }
    }
  }
  if (dataEnd < 0) return [];

  const after = src.slice(dataEnd + 1);
  /* 必须匹配「方法定义」而不是注释里出现的 onLoad 字样：字段注释里就有
   * "必须在 onLoad 里显式兜底"，用 indexOf 会把 region 截断在注释中间，
   * 后面的字段声明全被漏掉，规则于是假绿。 */
  const onLoadMatch = /\n {2}onLoad\s*\(/.exec(after);
  const region = onLoadMatch ? after.slice(0, onLoadMatch.index) : after;

  const fields: string[] = [];
  /* 只抓「顶层两空格缩进、字段名 + 冒号」的声明。 */
  const re = /^ {2}([A-Za-z_$][\w$]*):\s*(.*)$/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(region)) !== null) {
    const name = m[1];
    if (name === "data") continue;
    fields.push(name);
  }
  return fields;
}

/** 这些字段在 onLoad 里有没有被赋值/清空过。 */
function initializesInOnLoad(src: string, field: string): boolean {
  /* 必须匹配「方法定义」而不是注释里出现的 onLoad 字样：
   * 本文件的字段注释里就写着 "onLoad 里显式兜底"，用 indexOf 会定位到那里，
   * 把整段 onLoad 函数体都排除在 scope 之外，规则于是永远通过（假绿）。 */
  const m = /\n {2}onLoad\s*\(/.exec(src);
  if (m === null) return false;
  const body = src.slice(m.index + 1);
  /* 方法体结束：下一个顶层 `  },`（两空格缩进的收尾）。 */
  const end = /\n {2}\},/.exec(body);
  const scope = end ? body.slice(0, end.index) : body;
  return new RegExp(`this\\.${field}\\s*=`).test(scope);
}

describe("页面非 data 字段必须在 onLoad 里初始化", () => {
  const files = pageFiles();

  it("扫描到全部页面（防止规则空过）", () => {
    const names = files.map((f) => relative(ROOT, f).replace(/\\/g, "/"));
    expect(names).toContain("pages/home/home.ts");
    expect(names).toContain("pages/devices/devices.ts");
    expect(names).toContain("pages/device/device.ts");
    expect(names).toContain("pages/device-info/device-info.ts");
  });

  it("每个页面的私有字段都在 onLoad 赋值（否则整页事件绑定会失效）", () => {
    const offenders: string[] = [];
    for (const file of files) {
      const src = readFileSync(file, "utf8");
      for (const field of nonDataFields(src)) {
        if (!initializesInOnLoad(src, field)) {
          offenders.push(`${relative(ROOT, file).replace(/\\/g, "/")} → this.${field}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("判定逻辑本身有效（变异测试：未初始化的字段会被抓出来）", () => {
    const sample = [
      "Page({",
      "  data: { a: 1 },",
      "  ghost: [] as number[],",
      "  onLoad() {",
      "    this.setData({});",
      "  },",
      "});",
    ].join("\n");
    expect(nonDataFields(sample)).toContain("ghost");
    expect(initializesInOnLoad(sample, "ghost")).toBe(false);
  });
});
