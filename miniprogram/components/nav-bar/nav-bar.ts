/**
 * 自建导航栏（Apple 风格大标题）。
 *
 * 为什么不用原生：原生导航栏无法做大标题 + 滚动收缩，也无法在首页把设备名
 * 做成副标题（`navigationStyle: custom` 后由本组件负责全部顶部空间）。
 *
 * 必须自己处理的两件事：
 *  1. **刘海/状态栏高度**：`wx.getWindowInfo().statusBarHeight`，拿不到时按 44px 兜底；
 *  2. **胶囊按钮避让**：右上角胶囊是系统绘制的，标题与右侧动作都不能压到它。
 *     `getMenuButtonBoundingClientRect()` 给出精确位置，拿不到时按保守值。
 *
 * ## 主题
 *
 * 组件样式是隔离的，页面根节点上的 `theme-light` / `theme-dark` 传不进来，
 * 所以这里自己解析一次主题偏好，把 `use-light` / `use-dark` 挂到根节点上
 * （见 nav-bar.wxss）。**不能用 `var(--text, #深色)` 兜底**——兜底值在另一套
 * 主题下就是「深色字压深色底」。
 *
 * 组件不读会话、不碰 BLE——纯展示，避免和页面生命周期耦合。
 */

import { loadTheme, type ThemeMode } from "../../utils/control/theme";
import { createWxStorage } from "../../utils/control/device-cache";

Component({
  properties: {
    /** 大标题；为空时不渲染标题行（详情页用设备名做标题时也走这里）。 */
    title: { type: String, value: "" },
    /** 标题下的一行小字（首页用来显示「已连接 · 2 条灯带」）。 */
    subtitle: { type: String, value: "" },
    /** 返回按钮：二级页传 true。 */
    back: { type: Boolean, value: false },
    /** 右侧文字动作（如「编辑」）；空串不渲染。 */
    actionText: { type: String, value: "" },
    /** 是否显示大标题。滚动收缩的页面可以传 false，只留一行小标题。 */
    large: { type: Boolean, value: true },
  },

  data: {
    /** 状态栏高度（px）。 */
    statusBarHeight: 44,
    /** 导航区总高度（px）：状态栏 + 44 的标题行。 */
    barHeight: 88,
    /** 右侧内容可用宽度（px）：给胶囊留出位置。 */
    sideWidth: 88,
    /** `use-light` / `use-dark`：组件自带的配色开关。 */
    themeSwitchClass: "",
  },

  lifetimes: {
    attached() {
      this.measure();
      this.applyTheme();
    },
  },

  methods: {
    measure() {
      let statusBarHeight = 44;
      let sideWidth = 88;
      try {
        const info = wx.getWindowInfo?.() ?? wx.getSystemInfoSync();
        const height = Number((info as { statusBarHeight?: number }).statusBarHeight);
        if (Number.isFinite(height) && height > 0) {
          statusBarHeight = height;
        }
        /* 屏幕宽 - 胶囊右边界 - 一点间隙 = 右侧可安全放置内容的宽度。 */
        const windowWidth = Number((info as { windowWidth?: number }).windowWidth) || 375;
        const rect = wx.getMenuButtonBoundingClientRect?.();
        if (rect !== undefined && rect.width > 0) {
          sideWidth = Math.max(64, windowWidth - rect.right + rect.width + 8);
        }
      } catch {
        /* 取不到就用兜底值：布局略保守，但不会压到胶囊。 */
      }
      this.setData({
        statusBarHeight,
        barHeight: statusBarHeight + 44,
        sideWidth,
      });
    },

    /** 解析主题偏好 → 组件内的配色开关。 */
    applyTheme() {
      let mode: ThemeMode = "system";
      try {
        mode = loadTheme(createWxStorage());
      } catch {
        /* 存储不可用：按跟随系统。 */
      }
      let dark = false;
      if (mode === "dark") {
        dark = true;
      } else if (mode === "system") {
        try {
          const info = wx.getAppBaseInfo?.() ?? wx.getSystemInfoSync();
          dark = (info as { theme?: string }).theme === "dark";
        } catch {
          dark = false;
        }
      }
      this.setData({ themeSwitchClass: dark ? "use-dark" : "use-light" });
    },

    onBackTap() {
      wx.navigateBack({
        fail: () => {
          /* 没有上一页（从分享卡片直达）时回首页。 */
          wx.switchTab({ url: "/pages/home/home", fail: () => undefined });
        },
      });
    },

    onActionTap() {
      this.triggerEvent("action");
    },
  },
});
