/// <reference types="miniprogram-api-typings" />

/**
 * App 级全局数据（#41）。
 *
 * v2 这里是 `Record<string, never>`——因为整个 App 只有一个页面，没有跨页
 * 共享。v3 拆成 tabBar 三页 + 两个二级页后，会话必须跨页存活。
 *
 * 约定：页面用 `getSession()`（utils/control/session-singleton）取，**不要**
 * 通过 `getApp().globalData.session` 直接拿——单例函数负责懒创建、复用与
 * 测试替换。这里留字段只是让「App 确实持有一份会话」在类型上可见。
 */
interface IAppOption {
  globalData: {
    /** App 级会话实例；由 utils/control/session-singleton 填充。 */
    session?: import("../utils/control/session").ControlSession;
  };
}
