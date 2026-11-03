/**
 * 小程序**配置层**契约：这些错误不会让 tsc 或单测失败，但会让模拟器/真机
 * 出现「页面渲染了却点不动」「白屏」「构建报错」。
 *
 * 本文件锁住三类真实事故：
 *  1. `darkmode: true` 但缺 `themeLocation` / theme.json —— 编译期配置错误；
 *  2. `tabBar.custom: true` 但缺 custom-tab-bar 组件文件 —— tabBar 不渲染；
 *  3. WXML 里绑定的事件方法在 TS 里不存在 —— 点了没反应，只有 console warning。
 *
 * 第 3 条是「点不动」最常见的原因，而且最隐蔽：页面能正常渲染、静态内容全对，
 * 只有那个按钮不响应。
 */

import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** 递归收集目录下的文件（跳过 node_modules / tests / .auto / miniprogram_npm）。 */
function collect(dir: string, suffix: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (["node_modules", "tests", ".auto", "miniprogram_npm"].includes(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      collect(full, suffix, out);
    } else if (entry.endsWith(suffix)) {
      out.push(full);
    }
  }
  return out;
}

const appJson = JSON.parse(readFileSync(join(ROOT, "app.json"), "utf8")) as {
  pages: string[];
  tabBar?: { custom?: boolean; list?: Array<{ pagePath: string }> };
  darkmode?: boolean;
  themeLocation?: string;
  window?: { navigationStyle?: string };
};

describe("app.json 配置契约", () => {
  it("darkmode 开启时必须给出存在的 themeLocation", () => {
    if (appJson.darkmode !== true) {
      return;
    }
    expect(appJson.themeLocation, "darkmode=true 必须配 themeLocation").toBeTruthy();
    const themePath = join(ROOT, appJson.themeLocation!);
    expect(existsSync(themePath), `themeLocation 指向的文件不存在：${appJson.themeLocation}`).toBe(
      true,
    );
    /* 结构检查：light / dark 两组都要有，否则微信不认。 */
    const theme = JSON.parse(readFileSync(themePath, "utf8")) as {
      light?: Record<string, string>;
      dark?: Record<string, string>;
    };
    expect(theme.light).toBeTypeOf("object");
    expect(theme.dark).toBeTypeOf("object");
  });

  it("tabBar.custom 开启时 custom-tab-bar 组件文件齐全", () => {
    if (appJson.tabBar?.custom !== true) {
      return;
    }
    for (const ext of [".ts", ".wxml", ".json", ".wxss"]) {
      const file = join(ROOT, "custom-tab-bar", `index${ext}`);
      expect(existsSync(file), `缺少 custom-tab-bar/index${ext}`).toBe(true);
    }
  });

  it("tabBar 的页面都在 pages 里声明", () => {
    for (const item of appJson.tabBar?.list ?? []) {
      expect(appJson.pages).toContain(item.pagePath);
    }
  });

  it("每个页面的四件套都存在", () => {
    for (const page of appJson.pages) {
      for (const ext of [".ts", ".wxml", ".json"]) {
        expect(existsSync(join(ROOT, page + ext)), `缺少 ${page}${ext}`).toBe(true);
      }
    }
  });

  it("页面 json 里引用的组件都存在", () => {
    for (const page of appJson.pages) {
      const cfg = JSON.parse(readFileSync(join(ROOT, page + ".json"), "utf8")) as {
        usingComponents?: Record<string, string>;
      };
      for (const [name, path] of Object.entries(cfg.usingComponents ?? {})) {
        const base = join(ROOT, path.replace(/^\//, ""));
        for (const ext of [".ts", ".wxml", ".json"]) {
          expect(existsSync(base + ext), `${page} 引用的 ${name} 缺少 ${base}${ext}`).toBe(true);
        }
      }
    }
  });
});

describe("路由常量与 app.json 一致（#61）", () => {
  /**
   * 直接读文本而不是 `import "@utils/control/routes"`：那个模块的类型引用了
   * `wx`（全局），在 node 环境下的 ts 解析链并不可靠；而这里只需要字面量。
   */
  const routesSrc = readFileSync(join(ROOT, "utils/control/routes.ts"), "utf8");

  /** 抓 `export const X = { a: "/p/a", b: "/p/b" } as const;` 的 value 列表。 */
  function routeValues(name: string): string[] {
    const start = routesSrc.indexOf(`export const ${name} = {`);
    if (start < 0) return [];
    const end = routesSrc.indexOf("} as const;", start);
    if (end < 0) return [];
    const body = routesSrc.slice(start, end);
    const out: string[] = [];
    const re = /^\s+[A-Za-z_$][\w$]*:\s*"([^"]*)"/gm;
    let m: RegExpExecArray | null;
    while ((m = re.exec(body)) !== null) out.push(m[1]);
    return out;
  }

  /** app.json 里写的是无前导斜杠的路径；routes.ts 带斜杠，统一去掉再比。 */
  const bare = (path: string): string => path.replace(/^\//, "");

  it("TAB_ROUTES 的 tab 列表与 app.json 的 tabBar.list 完全一致（含顺序）", () => {
    const tabs = routeValues("TAB_ROUTES");
    /* 防空过：解析失败时两边都是空数组会让断言通过。 */
    expect(tabs.length).toBe(2);
    const declared = (appJson.tabBar?.list ?? []).map((item) => item.pagePath);
    expect(tabs.map(bare)).toEqual(declared);
  });

  it("PAGE_ROUTES 的每个二级页都在 app.json 的 pages 里", () => {
    const pages = routeValues("PAGE_ROUTES");
    expect(pages.length).toBeGreaterThanOrEqual(4);
    for (const page of pages) {
      expect(appJson.pages, `${page} 没有出现在 app.json 的 pages 里`).toContain(bare(page));
    }
  });
});

describe("WXML 事件绑定必须在 TS 里有对应方法", () => {
  /** 抓事件绑定：bindtap / catchtap / bind:action / capture-bind:tap 等。 */
  function bindings(src: string): string[] {
    const out: string[] = [];
    const re = /\b(?:bind|catch|capture-bind|capture-catch)[:]?([a-zA-Z]+)\s*=\s*"([^"]*)"/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src)) !== null) out.push(m[2].trim());
    return out;
  }

  /** 方法名：页面是 2 空格缩进，组件在 methods: {} 里是 4 空格，所以不限缩进。 */
  function methods(src: string): Set<string> {
    const names = new Set<string>();
    const re = /^[ \t]+(?:async\s+)?([A-Za-z_$][\w$]*)\s*\(/gm;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src)) !== null) names.add(m[1]);
    return names;
  }

  /** 找出每个 wxml 与它同名的 ts。 */
  function pairs(): Array<{ label: string; wxml: string; ts: string }> {
    const out: Array<{ label: string; wxml: string; ts: string }> = [];
    for (const wxml of collect(ROOT, ".wxml")) {
      const ts = wxml.replace(/\.wxml$/, ".ts");
      if (!existsSync(ts)) continue;
      out.push({ label: relative(ROOT, wxml).replace(/\\/g, "/"), wxml, ts });
    }
    return out;
  }

  it("扫描到了全部页面与组件（防止规则空过）", () => {
    const labels = pairs().map((pair) => pair.label);
    expect(labels).toContain("pages/home/home.wxml");
    expect(labels).toContain("pages/device/device.wxml");
    expect(labels).toContain("pages/me/me.wxml");
    expect(labels).toContain("pages/discover/discover.wxml");
    expect(labels).toContain("pages/strip/strip.wxml");
    expect(labels).toContain("components/nav-bar/nav-bar.wxml");
    expect(labels).toContain("custom-tab-bar/index.wxml");
  });

  it("没有「绑定了但方法不存在」的处理器", () => {
    const offenders: string[] = [];
    for (const { label, wxml, ts } of pairs()) {
      const defined = methods(readFileSync(ts, "utf8"));
      for (const handler of bindings(readFileSync(wxml, "utf8"))) {
        if (handler.length === 0) continue;
        /* 动态绑定（含 {{ }}）微信不支持，单独算违规。 */
        if (handler.includes("{{")) {
          offenders.push(`${label} → 动态绑定 "${handler}"（微信不支持）`);
          continue;
        }
        if (!defined.has(handler)) {
          offenders.push(`${label} → "${handler}" 在 TS 里不存在`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("判定逻辑有效（变异测试：缺失的方法会被抓出来）", () => {
    const wxml = `<view bindtap="ghostTap"></view><view catchtap="realTap"></view>`;
    const ts = `Page({\n  realTap() {},\n});`;
    const defined = methods(ts);
    const found = bindings(wxml);
    expect(found).toEqual(["ghostTap", "realTap"]);
    expect(defined.has("ghostTap")).toBe(false);
    expect(defined.has("realTap")).toBe(true);
  });
});
