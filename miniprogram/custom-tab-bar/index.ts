/**
 * 自定义 tabBar（设备 / 发现）。
 *
 * 为什么自建：原生 tabBar 只能给图标位放位图，做不出「细线条 + 选中强调色 +
 * 半透明底」的极简观感；位图在不同分辨率下还会糊。
 *
 * 图标全部由 CSS 绘制（不引任何资源）。tabBar 挂在页面外层，读不到 `.page`
 * 上的主题变量，所以这里自己判断主题并挂 `theme-light` / `theme-dark`。
 *
 * 用法：每个 tab 页在 `onShow` 里调用
 *   `this.getTabBar()?.setData({ selected: 0 })`
 * 索引与 `app.json` 的 `tabBar.list` 顺序一致。
 */

import { THEME_KEY } from "../utils/control/theme";

/**
 * 与 app.json tabBar.list 的顺序**必须一致**。
 *
 * #58 起只有两项（设备 / 发现）：灯效编排在设备详情页里，
 * 独立的「剧本」tab 已删除。
 */
const TABS = [
  { path: "/pages/home/home", label: "设备" },
  { path: "/pages/devices/devices", label: "发现" },
] as const;

/** 主题变化的监听（模块级：整个 App 只有一个 tabBar 实例）。 */
let themeListener: (() => void) | null = null;

/** 读偏好与系统主题，算出要挂的 class。 */
function resolveThemeClass(): string {
  let mode = "system";
  try {
    const stored = wx.getStorageSync(THEME_KEY);
    if (stored === "light" || stored === "dark" || stored === "system") {
      mode = stored;
    }
  } catch {
    /* 存储不可用：按跟随系统。 */
  }
  if (mode === "light" || mode === "dark") {
    return `theme-${mode}`;
  }
  let systemTheme = "light";
  try {
    const info = wx.getAppBaseInfo?.() ?? wx.getSystemInfoSync();
    if ((info as { theme?: string }).theme === "dark") {
      systemTheme = "dark";
    }
  } catch {
    /* ignore */
  }
  /* 跟随系统时也挂显式 class：组件内的媒体查询在部分基础库下不可靠。 */
  return `theme-${systemTheme}`;
}

Component({
  data: {
    selected: 0,
    tabs: TABS.map((tab, index) => ({ ...tab, index })),
    /* 初值留空，在 attached 里算：模块顶层不碰 wx。 */
    themeClass: "",
  },

  lifetimes: {
    attached() {
      this.setData({ themeClass: resolveThemeClass() });
      themeListener = () => this.setData({ themeClass: resolveThemeClass() });
      try {
        wx.onThemeChange?.(themeListener);
      } catch {
        /* 旧基础库没有该事件：按当前系统主题静态渲染即可。 */
      }
    },

    detached() {
      if (themeListener === null) {
        return;
      }
      try {
        wx.offThemeChange?.(themeListener);
      } catch {
        /* ignore */
      }
      themeListener = null;
    },
  },

  methods: {
    onTabTap(e: WechatMiniprogram.TouchEvent) {
      const index = Number(e.currentTarget.dataset.index ?? -1);
      const tab = TABS[index];
      if (tab === undefined || index === this.data.selected) {
        return;
      }
      wx.switchTab({
        url: tab.path,
        fail: (err) => console.warn(`[lumen] tabBar 切换失败：${err.errMsg}`),
      });
    },
  },
});
