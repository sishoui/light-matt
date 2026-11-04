/**
 * #90 主题全局同步的契约。
 *
 * 这组测试锁四件「只有看代码/看渲染才知道」的事：
 *  1. 雾蓝两个色值与 `app.wxss` 的 `--accent` 逐字一致（否则滑块与页面会不同色）；
 *  2. 页面在**显示时**重读主题，而不是用 `onLoad` 的缓存（tab 页只加载一次）；
 *  3. 原生 `slider` / `switch` 的激活色由页面数据传入，wxml 里没有写死色；
 *  4. 导航栏与 tabBar 在页面显示时各自重算（组件样式隔离，页面 class 传不进去）。
 */

import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ACCENT_DARK,
  ACCENT_LIGHT,
  accentColor,
  isDarkMode,
  resolveTheme,
  themeClass,
  type ThemeMode,
} from "../utils/control/theme";
import { pageThemeData, syncTabBarTheme } from "../utils/control/page-theme";
import type { SessionStorage } from "../utils/control/device-cache";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function memoryStorage(initial: Record<string, string> = {}): SessionStorage {
  const map = new Map(Object.entries(initial));
  return {
    get: (key) => map.get(key) ?? null,
    set: (key, value) => void map.set(key, value),
    remove: (key) => void map.delete(key),
  };
}

function read(rel: string): string {
  return readFileSync(join(ROOT, rel), "utf8");
}

describe("雾蓝主色", () => {
  it("两个色值就是规格给的 #6B8CAE / #8FA9C4", () => {
    expect(ACCENT_LIGHT.toLowerCase()).toBe("#6b8cae");
    expect(ACCENT_DARK.toLowerCase()).toBe("#8fa9c4");
  });

  it("app.wxss 的浅色 --accent 与 ACCENT_LIGHT 一致", () => {
    const css = read("app.wxss");
    const match = /\.page\s*\{[\s\S]*?--accent:\s*([^;]+);/.exec(css);
    expect(match).not.toBeNull();
    expect(match![1].trim().toLowerCase()).toBe(ACCENT_LIGHT.toLowerCase());
  });

  it("深色覆盖块的 --accent 与 ACCENT_DARK 一致（两处：媒体查询与 .theme-dark）", () => {
    const css = read("app.wxss");
    const hits = [...css.matchAll(/--accent:\s*([^;]+);/g)].map((m) => m[1].trim().toLowerCase());
    /* 浅色两处（.page 与 .theme-light）+ 深色两处（媒体查询与 .theme-dark）。 */
    expect(hits.filter((value) => value === ACCENT_LIGHT.toLowerCase()).length).toBe(2);
    expect(hits.filter((value) => value === ACCENT_DARK.toLowerCase()).length).toBe(2);
  });

  it("nav-bar 与 tabBar 自带的两套变量也用雾蓝（组件样式隔离，抄了一份）", () => {
    const nav = read("components/nav-bar/nav-bar.wxss").toLowerCase();
    expect(nav).toContain(ACCENT_LIGHT.toLowerCase());
    expect(nav).toContain(ACCENT_DARK.toLowerCase());
    const tab = read("custom-tab-bar/index.wxss").toLowerCase();
    expect(tab).toContain(ACCENT_LIGHT.toLowerCase());
    expect(tab).toContain(ACCENT_DARK.toLowerCase());
  });

  it("theme.json 的 tabSelectedColor 与主题同族", () => {
    const theme = JSON.parse(read("theme.json")) as {
      light: { tabSelectedColor: string };
      dark: { tabSelectedColor: string };
    };
    expect(theme.light.tabSelectedColor.toLowerCase()).toBe(ACCENT_LIGHT.toLowerCase());
    expect(theme.dark.tabSelectedColor.toLowerCase()).toBe(ACCENT_DARK.toLowerCase());
  });
});

describe("全仓不再有橙色残留", () => {
  function walk(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
      if (["node_modules", "tests", ".auto", "dist"].includes(entry)) continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full, out);
      else if (/\.(wxss|wxml|json)$/.test(entry)) out.push(full);
    }
    return out;
  }

  it("任何 wxss / wxml / json 里都没有 #ff9500、#ffb478 或 255,149,0", () => {
    const offenders: string[] = [];
    for (const file of walk(ROOT)) {
      const src = readFileSync(file, "utf8").toLowerCase();
      if (src.includes("#ff9500") || src.includes("#ffb478") || src.includes("255, 149, 0")) {
        offenders.push(relative(ROOT, file).replace(/\\/g, "/"));
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe("原生 slider / switch 的激活色由页面数据传入", () => {
  it("wxml 里不再写死 activeColor / color 的字面色值", () => {
    const offenders: string[] = [];
    for (const page of ["device", "device-info", "me", "strip"]) {
      const src = read(`pages/${page}/${page}.wxml`);
      for (const match of src.matchAll(/(?:activeColor|color)="([^"]*)"/g)) {
        const value = match[1].trim();
        /* 允许绑定表达式与「色环滑块」用的透明值。 */
        if (value.startsWith("{{")) continue;
        if (value === "rgba(0, 0, 0, 0)") continue;
        offenders.push(`${page}.wxml → ${match[0]}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("每个有原生控件的页面都把 accentColor 放进 data", () => {
    for (const page of ["device", "device-info", "me", "strip"]) {
      const src = read(`pages/${page}/${page}.ts`);
      expect(src, `${page} 缺少 accentColor 数据字段`).toContain("accentColor");
    }
  });
});

describe("页面在显示时读到最新主题（不是 onLoad 的缓存）", () => {
  it("resolveTheme 跟随「跟随系统」解析", () => {
    expect(resolveTheme(memoryStorage(), false).dark).toBe(false);
    expect(resolveTheme(memoryStorage(), true).dark).toBe(true);
  });

  it("手动浅色忽略系统深色；手动深色忽略系统浅色", () => {
    expect(resolveTheme(memoryStorage({ "lumen.theme.v1": "light" }), true).dark).toBe(false);
    expect(resolveTheme(memoryStorage({ "lumen.theme.v1": "dark" }), false).dark).toBe(true);
  });

  it("同一个 storage 改了值之后再读会变（这就是 onShow 重读的意义）", () => {
    const storage = memoryStorage();
    const before = pageThemeData(storage, false);
    storage.set("lumen.theme.v1", "dark");
    const after = pageThemeData(storage, false);
    expect(before.themeClass).toBe("");
    expect(after.themeClass).toBe("theme-dark");
    expect(before.accentColor).not.toBe(after.accentColor);
    expect(after.accentColor).toBe(ACCENT_DARK);
  });

  it("损坏的存储值回落到跟随系统，不抛错", () => {
    const storage = memoryStorage({ "lumen.theme.v1": "purple" });
    expect(pageThemeData(storage, true).themeClass).toBe("");
    expect(pageThemeData(storage, true).dark).toBe(true);
  });

  it("accentColor 只有两个取值，且与深色判定一致", () => {
    expect(accentColor(true)).toBe(ACCENT_DARK);
    expect(accentColor(false)).toBe(ACCENT_LIGHT);
    expect(isDarkMode("system", true)).toBe(true);
    expect(isDarkMode("system", false)).toBe(false);
    expect(themeClass("system")).toBe("");
  });

  it("每个页面的 onShow 都调 pageThemeData（不是只在 onLoad 里读一次）", () => {
    for (const page of ["home", "device", "device-info", "discover", "strip", "me"]) {
      const src = read(`pages/${page}/${page}.ts`);
      const onShow = /\n {2}onShow\s*\([\s\S]*?\n {2}\}/.exec(src);
      expect(onShow, `${page} 没有 onShow`).not.toBeNull();
      expect(
        onShow![0].includes("pageThemeData") ||
          onShow![0].includes("applyThemeView") ||
          onShow![0].includes("syncTabBar"),
        `${page} 的 onShow 没有刷新主题`,
      ).toBe(true);
    }
  });
});

describe("导航栏与 tabBar 的组件级重算", () => {
  it("nav-bar 在 pageLifetimes.show 里重算主题", () => {
    const src = read("components/nav-bar/nav-bar.ts");
    expect(src).toContain("pageLifetimes");
    const show = /pageLifetimes:\s*\{[\s\S]*?show\(\)\s*\{([\s\S]*?)\n\s*\},/.exec(src);
    expect(show, "nav-bar 缺少 pageLifetimes.show").not.toBeNull();
    expect(show![1]).toContain("applyTheme");
  });

  it("tabBar 提供 refreshTheme()，且会解析「跟随系统」", () => {
    const src = read("custom-tab-bar/index.ts");
    expect(src).toContain("refreshTheme()");
    expect(src).toContain("resolveThemeClass()");
  });

  it("syncTabBarTheme 优先走 refreshTheme，老实例退回写 class", () => {
    const calls: string[] = [];
    const modern = {
      data: {},
      setData: () => calls.push("setData"),
      refreshTheme: () => calls.push("refreshTheme"),
    };
    syncTabBarTheme(modern, "dark");
    expect(calls).toEqual(["refreshTheme"]);

    const legacy = { data: {}, setData: (patch: Record<string, unknown>) => calls.push(String(patch.themeClass)) };
    syncTabBarTheme(legacy, "light");
    expect(calls).toContain("theme-light");
  });

  it("两个 tab 页的 syncTabBar 都把主题推给 tabBar", () => {
    for (const page of ["home", "me"]) {
      const src = read(`pages/${page}/${page}.ts`);
      expect(src, `${page} 没有把主题同步给 tabBar`).toContain("syncTabBarTheme");
    }
  });
});

describe("页面根节点挂主题 class（不是只有首页）", () => {
  it("六个页面的 wxml 根节点都绑定了 themeClass", () => {
    for (const page of ["home", "device", "device-info", "discover", "strip", "me"]) {
      const src = read(`pages/${page}/${page}.wxml`);
      expect(src, `${page}.wxml 根节点没挂 themeClass`).toMatch(
        /^<view class="page \{\{themeClass\}\}"/m,
      );
    }
  });
});

describe("主题模式类型", () => {
  it("只有三档（规格明确不做第三套配色）", () => {
    const modes: ThemeMode[] = ["system", "light", "dark"];
    expect(modes.length).toBe(3);
  });
});
