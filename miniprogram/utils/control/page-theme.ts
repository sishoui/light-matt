/**
 * 页面主题接线（#90）。
 *
 * 主题切换要在**页面显示时**重新读，不能在 `onLoad` 缓存——tab 页只加载一次，
 * 用户在「我的」页改完再切回来，缓存值永远不会变。这里把「读存储 → 算出页面
 * 要的 data 字段」收成一个函数，页面 `onShow` 调它就行。
 *
 * ## 为什么还要一并处理 tabBar
 *
 * 自建 tabBar 是全局单例，`attached` 只跑一次；手动主题存在 App 存储里，
 * 系统事件不会通知它。所以每个 tab 页显示时必须顺手让它重算一次。
 * 导航栏不用在这里管——它自己监听 `pageLifetimes.show`（组件级）。
 */

import type { SessionStorage } from "./device-cache";
import { accentColor, isDarkMode, loadTheme, systemDark, themeClass, type ThemeMode } from "./theme";

/** 页面 `data` 里与主题有关的三项。 */
export interface PageThemeData {
  /** 根节点 class：`theme-light` / `theme-dark` / 空串（跟随系统）。 */
  themeClass: string;
  /** 实际是不是深色（含「跟随系统」解析后的结果）。 */
  dark: boolean;
  /**
   * 原生 `slider` / `switch` 的激活色（`activeColor` / `color`）。
   *
   * 必须由页面数据传入：这两类组件**不读 CSS 变量**，写死字面量就会在换主题
   * 后留下一处旧色。
   */
  accentColor: string;
}

/** 供页面 `onShow` 直接用：读偏好 + 解析系统主题 → `data` 片段。 */
export function pageThemeData(
  storage: SessionStorage,
  systemIsDark: boolean = systemDark(),
): PageThemeData {
  const mode = loadTheme(storage);
  const dark = isDarkMode(mode, systemIsDark);
  return {
    themeClass: themeClass(mode),
    dark,
    accentColor: accentColor(dark),
  };
}

/** 页面显示时的主题模式（选择器选中态用）。 */
export function pageThemeMode(storage: SessionStorage): ThemeMode {
  return loadTheme(storage);
}

/** tabBar 实例的最小接口（`this.getTabBar()` 的返回）。 */
export interface ThemeAwareTabBar {
  data: Record<string, unknown>;
  setData(patch: Record<string, unknown>): void;
  refreshTheme?: () => void;
}

/**
 * 让 tabBar 重算主题。优先走组件自己的 `refreshTheme()`（它会解析「跟随系统」），
 * 老实例没有这个方法时退回直接写 class。
 */
export function syncTabBarTheme(tabBar: ThemeAwareTabBar | null | undefined, mode: ThemeMode): void {
  if (tabBar === null || tabBar === undefined) {
    return;
  }
  if (typeof tabBar.refreshTheme === "function") {
    tabBar.refreshTheme();
    return;
  }
  tabBar.setData({ themeClass: themeClass(mode) });
}
