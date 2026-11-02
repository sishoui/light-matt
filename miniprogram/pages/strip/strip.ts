/**
 * 灯组编辑页（二级页）：query `strip` 指明是哪一组。
 *
 * #61 只建立骨架——简单档 / 时间轴 / 光区面板由后续票（#63–#67）填入。
 * 这里已经做对两件事，避免后面的票踩坑：
 *  1. `strip` 参数用 `queryInt` 解析并落到 `data.stripId`（越界交给编辑逻辑兜底）；
 *  2. 根节点是 `.page {{themeClass}}`，二级页带返回按钮。
 */

import { createWxStorage } from "../../utils/control/device-cache";
import { loadTheme, themeClass } from "../../utils/control/theme";
import { queryInt } from "../../utils/control/routes";

Page({
  data: {
    themeClass: "",
    stripId: 0,
    title: "灯组",
  },

  onLoad(options: Record<string, string | undefined>) {
    /* 页面私有状态在这里显式初始化（Page() 不保证对象字面量字段被复制到
     * 实例上；漏掉会让 onShow 的调用链抛错并中断整页事件绑定）。 */
    const stripId = queryInt(options, "strip", 0);
    this.setData({
      themeClass: themeClass(loadTheme(createWxStorage())),
      stripId,
      title: `灯组 ${stripId + 1}`,
    });
  },

  onShow() {
    const expected = themeClass(loadTheme(createWxStorage()));
    if (this.data.themeClass !== expected) {
      this.setData({ themeClass: expected });
    }
  },
});
