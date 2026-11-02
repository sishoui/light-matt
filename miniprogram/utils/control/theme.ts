/**
 * 主题偏好：浅色 / 深色 / 跟随系统。
 *
 * 样式层由 `app.wxss` 的 CSS 变量 + `prefers-color-scheme` 负责；本模块只决定
 * **是否覆盖系统**——根节点加 `theme-light` / `theme-dark` class 即可。
 *
 * 为什么不做成「页面自己判断」：原生导航栏已换成自建（`components/nav-bar`），
 * 它要跟着主题变色，所以必须有一个 App 级、可持久化的选择，而不是各页各猜。
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

/** 主题选择器用的选中态（供设置页渲染）。 */
export function themeLabel(mode: ThemeMode): string {
  return THEME_OPTIONS.find((option) => option.value === mode)?.label ?? "跟随系统";
}
