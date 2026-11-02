/**
 * 发现页（二级页）：扫描附近的 Lumen 灯控。
 *
 * #61 只建立骨架——一个能进能出、不白屏的页面。真正的扫描按钮、连接状态行
 * 与结果列表由后续票（#62）填入。路由语义已定：本页是**二级页**（不是 tab），
 * 从设备页右上角的菜单进入。
 */

import { createWxStorage } from "../../utils/control/device-cache";
import { loadTheme, themeClass } from "../../utils/control/theme";

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
    const expected = themeClass(loadTheme(createWxStorage()));
    if (this.data.themeClass !== expected) {
      this.setData({ themeClass: expected });
    }
  },
});
