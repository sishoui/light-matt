/**
 * 「我的」页（tab 2，二级页之外的唯一设置入口）。
 *
 * #61 只建立骨架：头像 / 昵称 / 外观 / 演示设备 / 我的设备 / 版本号与日志面板
 * 都由后续票（#62）填入。这里保证三件事：
 *  1. 页面能进能出、不白屏（根节点是 `.page`，主题 class 在 onLoad/onShow 算）；
 *  2. tabBar 的选中态由本页设置（索引 1，与 app.json 顺序一致）；
 *  3. 内容区给固定 tabBar 让出高度，不被压住。
 */

import { createWxStorage } from "../../utils/control/device-cache";
import { loadTheme, themeClass, type ThemeMode } from "../../utils/control/theme";

Page({
  data: {
    themeClass: "",
  },

  onLoad() {
    /* 本页暂无私有字段；主题偏好只用于算根节点的 class。 */
    const storage = createWxStorage();
    this.setData({ themeClass: themeClass(loadTheme(storage)) });
  },

  onShow() {
    /* 主题可能刚在别处改过：每次显示都重算一次。 */
    const mode: ThemeMode = loadTheme(createWxStorage());
    const expected = themeClass(mode);
    if (this.data.themeClass !== expected) {
      this.setData({ themeClass: expected });
    }
    this.syncTabBar();
  },

  /** 自定义 tabBar 的选中态（索引与 app.json 的 tabBar.list 一致）。 */
  syncTabBar() {
    const tabBar = this.getTabBar?.();
    if (tabBar !== undefined && tabBar !== null) {
      tabBar.setData({ selected: 1 });
    }
  },
});
