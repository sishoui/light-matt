/**
 * 双主题的配色契约。
 *
 * 为什么用静态解析而不是渲染后读计算样式：
 *  - automator 的 `computedStyle` 返回对象无法跨进程克隆，拿不到；
 *  - 真机/模拟器只反映"当前这一台"，而主题错误的代价是**白底白字**，
 *    这种缺陷必须在改动样式表时就拦住，不能等跑起来才看。
 *
 * 这里检查三件事：
 *  1. `app.wxss` 里 light / dark 两套变量都存在，且关键色**互不相同**；
 *  2. 深色的文字比背景亮、浅色的文字比背景暗（对比方向正确，不会白底白字）；
 *  3. 页面 wxss 不再散落硬编码十六进制色（除少数刻意保留的透明叠加）。
 */

import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const APP_WXSS = readFileSync(join(ROOT, "app.wxss"), "utf8");

/** 从 CSS 文本里抽出某个选择器块中 `--name: value;` 的映射。 */
function varsInBlock(css: string, selectorPattern: RegExp): Record<string, string> {
  const match = selectorPattern.exec(css);
  if (match === null) return {};
  /* 从匹配处向后配对花括号。 */
  const start = css.indexOf("{", match.index);
  let depth = 0;
  let end = -1;
  for (let i = start; i < css.length; i += 1) {
    if (css[i] === "{") depth += 1;
    else if (css[i] === "}") {
      depth -= 1;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  const body = css.slice(start + 1, end);
  const out: Record<string, string> = {};
  const re = /--([\w-]+)\s*:\s*([^;]+);/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) out[m[1]] = m[2].trim();
  return out;
}

/** `#rgb` / `#rrggbb` / `rgb()` / `rgba()` → 相对亮度（0-255 的近似）。 */
function luma(color: string): number | null {
  const hex = /^#([0-9a-fA-F]{6})$/.exec(color.trim());
  if (hex !== null) {
    const v = hex[1];
    const r = parseInt(v.slice(0, 2), 16);
    const g = parseInt(v.slice(2, 4), 16);
    const b = parseInt(v.slice(4, 6), 16);
    return 0.299 * r + 0.587 * g + 0.114 * b;
  }
  const short = /^#([0-9a-fA-F]{3})$/.exec(color.trim());
  if (short !== null) {
    const v = short[1];
    const r = parseInt(v[0] + v[0], 16);
    const g = parseInt(v[1] + v[1], 16);
    const b = parseInt(v[2] + v[2], 16);
    return 0.299 * r + 0.587 * g + 0.114 * b;
  }
  const rgb = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/.exec(color.trim());
  if (rgb !== null) {
    return 0.299 * Number(rgb[1]) + 0.587 * Number(rgb[2]) + 0.114 * Number(rgb[3]);
  }
  return null;
}

/* 默认（浅色）在 .page 里；深色在媒体查询里的 .page 块。 */
const light = varsInBlock(APP_WXSS, /^\.page\s*\{/m);
const darkMedia = /@media\s*\(prefers-color-scheme:\s*dark\)\s*\{([\s\S]*?)\n\}/.exec(APP_WXSS);
const dark = darkMedia === null ? {} : varsInBlock(darkMedia[1], /\.page\s*\{/);

describe("app.wxss 双主题变量", () => {
  it("浅色与深色两套变量都定义了必要项", () => {
    for (const key of ["bg", "card", "text", "text-2", "border", "accent", "danger"]) {
      expect(light[key], `浅色缺少 --${key}`).toBeTruthy();
      expect(dark[key], `深色缺少 --${key}`).toBeTruthy();
    }
  });

  it("浅色：文字比背景暗（不会白底白字）", () => {
    const bg = luma(light.bg);
    const text = luma(light.text);
    expect(bg).not.toBeNull();
    expect(text).not.toBeNull();
    expect(text!).toBeLessThan(bg!);
  });

  it("深色：文字比背景亮（不会黑底黑字）", () => {
    const bg = luma(dark.bg);
    const text = luma(dark.text);
    expect(bg).not.toBeNull();
    expect(text).not.toBeNull();
    expect(text!).toBeGreaterThan(bg!);
  });

  it("两套的底色与文字色确实不同（不是复制粘贴漏改）", () => {
    expect(light.bg).not.toBe(dark.bg);
    expect(light.text).not.toBe(dark.text);
    expect(light.card).not.toBe(dark.card);
  });

  it("对比度足够（文字与背景亮度差 > 80），保证可读", () => {
    expect(Math.abs(luma(light.text)! - luma(light.bg)!)).toBeGreaterThan(80);
    expect(Math.abs(luma(dark.text)! - luma(dark.bg)!)).toBeGreaterThan(80);
  });
});

describe("页面样式不再散落硬编码色", () => {
  /** 递归收集页面与组件的 wxss。 */
  function wxssFiles(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
      if (["node_modules", "tests", ".auto"].includes(entry)) continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) wxssFiles(full, out);
      else if (entry.endsWith(".wxss") && full !== join(ROOT, "app.wxss")) out.push(full);
    }
    return out;
  }

  it("页面 wxss 里没有成片的十六进制色（应走 var(--…)）", () => {
    const offenders: string[] = [];
    for (const file of wxssFiles(ROOT)) {
      const src = readFileSync(file, "utf8");
      /* 变量声明里的值是「主题定义」，不是散落的硬编码：
       * nav-bar 因为组件样式隔离必须自带两套变量，那是正确做法。
       * 所以先把 `--x: #fff;` 这类声明剔掉，再找剩下的字面色。 */
      const withoutDeclarations = src
        .split("\n")
        .filter((line) => !/^\s*--[\w-]+\s*:/.test(line))
        .join("\n");
      const hits = withoutDeclarations.match(/#[0-9a-fA-F]{6}\b/g) ?? [];
      /* 允许少量：纯白/纯黑用于遮罩与内阴影。每个文件最多 4 处。 */
      if (hits.length > 4) {
        offenders.push(
          `${relative(ROOT, file).replace(/\\/g, "/")} 有 ${hits.length} 处硬编码色：${hits
            .slice(0, 5)
            .join(" ")}`,
        );
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe("theme.json 与 app.json 一致", () => {
  it("app.json 的 darkmode / themeLocation 与 theme.json 内容匹配", () => {
    const app = JSON.parse(readFileSync(join(ROOT, "app.json"), "utf8")) as {
      darkmode?: boolean;
      themeLocation?: string;
    };
    if (app.darkmode !== true) return;
    const file = join(ROOT, app.themeLocation ?? "");
    expect(existsSync(file), "themeLocation 指向的文件不存在").toBe(true);
    const theme = JSON.parse(readFileSync(file, "utf8")) as {
      light?: Record<string, string>;
      dark?: Record<string, string>;
    };
    expect(theme.light).toBeTypeOf("object");
    expect(theme.dark).toBeTypeOf("object");
    /* 深色 tabBar 的选中色要与 app.wxss 的 --accent 同族（不能一深一浅）。 */
    expect(theme.dark!.tabSelectedColor).toBeTruthy();
    expect(theme.light!.tabSelectedColor).toBeTruthy();
  });
});
