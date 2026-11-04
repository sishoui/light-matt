/**
 * 主题偏好：浅色 / 深色 / 跟随系统。
 *
 * 样式层由 `app.wxss` 的 CSS 变量 + `prefers-color-scheme` 负责；本模块只决定
 * **是否覆盖系统**——根节点加 `theme-light` / `theme-dark` class 即可。
 *
 * 为什么不做成「页面自己判断」：原生导航栏已换成自建（`components/nav-bar`），
 * 它要跟着主题变色，所以必须有一个 App 级、可持久化的选择，而不是各页各猜。
 *
 * ## 为什么要提供 `accentColor`
 *
 * 小程序的 `slider` / `switch` 是**原生组件**，它们的激活色不接受 CSS 变量
 * （`activeColor` / `color` 只收字面量颜色）。所以主题换了之后，如果页面继续
 * 传写死的 `#ff9500`，就会出现「整体换了、滑块还是橙的」。颜色因此必须由
 * 页面数据传入，取值从本模块来——这是全仓唯一的色源。
 */

import type { SessionStorage } from "./device-cache";

export type ThemeMode = "system" | "light" | "dark";

/** 存储键（含版本，避免读到旧结构）。 */
export const THEME_KEY = "lumen.theme.v1";

export const THEME_OPTIONS: Array<{ value: ThemeMode; label: string }> = [
  { value: "light", label: "浅色" },
  { value: "dark", label: "深色" },
  { value: "system", label: "跟随系统" },
];

/** 雾蓝主色。必须与 `app.wxss` 的 `--accent` 逐字一致（theme.test.ts 守着）。 */
export const ACCENT_LIGHT = "#6B8CAE";
export const ACCENT_DARK = "#8FA9C4";

function isMode(value: unknown): value is ThemeMode {
  return value === "system" || value === "light" || value === "dark";
}

/** 读偏好；未设置或损坏一律按「跟随系统」。 */
export function loadTheme(storage: SessionStorage): ThemeMode {
  const raw = storage.get(THEME_KEY);
  return isMode(raw) ? raw : "system";
}

export function saveTheme(storage: SessionStorage, mode: ThemeMode): ThemeMode {
  storage.set(THEME_KEY, mode);
  return mode;
}

/**
 * 页面根节点要挂的 class。
 *
 * 返回空串表示「跟随系统」——此时由 `app.wxss` 的媒体查询决定，
 * 页面不需要知道当前系统是深是浅。
 */
export function themeClass(mode: ThemeMode): string {
  if (mode === "light") return "theme-light";
  if (mode === "dark") return "theme-dark";
  return "";
}

/** 系统当前是不是深色；取不到按浅色（浅色是默认主题）。 */
export function systemDark(): boolean {
  try {
    const info = wx.getAppBaseInfo?.() ?? wx.getSystemInfoSync();
    return (info as { theme?: string }).theme === "dark";
  } catch {
    return false;
  }
}

/**
 * 偏好 + 系统取色 → 实际是不是深色。
 *
 * `systemDark` 参数存在是为了可测：node 里没有 wx，调用方（页面）把
 * 系统主题传进来，纯逻辑部分就能单测。
 */
export function isDarkMode(mode: ThemeMode, systemIsDark: boolean): boolean {
  if (mode === "dark") return true;
  if (mode === "light") return false;
  return systemIsDark;
}

/** 实际深色下要传给原生 `slider` / `switch` 的激活色。 */
export function accentColor(isDark: boolean): string {
  return isDark ? ACCENT_DARK : ACCENT_LIGHT;
}

/**
 * 页面 `onShow` 用的一站式取值。
 *
 * **必须在显示时调用**，不能在 `onLoad` 缓存：tab 页只加载一次，而主题在
 * 「我的」页改完后返回，缓存值永远不会更新（这就是本轮要修的断点之一）。
 */
export interface ThemeSnapshot {
  mode: ThemeMode;
  themeClass: string;
  dark: boolean;
  /** 原生 slider / switch 的激活色。 */
  accentColor: string;
}

export function resolveTheme(storage: SessionStorage, systemIsDark: boolean): ThemeSnapshot {
  const mode = loadTheme(storage);
  const dark = isDarkMode(mode, systemIsDark);
  return {
    mode,
    themeClass: themeClass(mode),
    dark,
    accentColor: accentColor(dark),
  };
}

/** 主题选择器用的选中态（供设置页渲染）。 */
export function themeLabel(mode: ThemeMode): string {
  return THEME_OPTIONS.find((option) => option.value === mode)?.label ?? "跟随系统";
}
