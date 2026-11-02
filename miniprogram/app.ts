/**
 * 小程序入口（#41）。
 *
 * 会话是 App 级单例：切 tab / push 二级页都不能重建它（小程序只有一条 BLE
 * 连接，重建 = 断链）。App 只负责两件生命周期的活：
 *  1. `onLaunch` 打开适配器（`boot`），后续连接由设备页驱动；
 *  2. `onShow` 让使用日志补报队列，并让会话做一次静默回连判断。
 *
 * 页面自己订阅 / 退订自己的监听，不依赖 App 中转。
 */

import { getSession, getUsageLogger } from "./utils/control/session-singleton";

App<IAppOption>({
  globalData: {},

  onLaunch() {
    /* 只打开适配器：不自动连接（用户可能想先看设备列表）。 */
    void getSession().boot();
  },

  onShow() {
    /* #34：进前台补报本地待发记录（fire-and-forget，绝不影响 BLE）。 */
    getUsageLogger()?.replay();
    /* #11：进前台静默回连。会话内部判断是否该回连，且不打断扫描 / 手动连接。 */
    void getSession().onShow();
  },

  onHide() {
    /* 进后台不断链：设备侧时间轴（剧本）要继续跑，回前台后会话自己复核 State。 */
  },
});
