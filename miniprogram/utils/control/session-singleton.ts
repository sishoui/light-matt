/**
 * App 级会话单例（#41）。
 *
 * 为什么必须是单例：小程序只有一条 BLE 连接，切 tab 不能断链。会话里放着
 * 链路状态机、seq 分配、ACK 等待、State 镜像与逐带配置缓存——任何一次
 * 「页面卸载就 destroy」都会把连接、回连意图和这些缓存一起丢掉。
 *
 * 纪律（页面必须遵守）：
 *  - 页面**永远不调用** `session.destroy()`；destroy 只属于 App 生命周期；
 *  - 页面在 `onShow` 订阅、`onHide` 退订，不要假设自己一直活着；
 *  - 读取一律走 `getSession()`，不要自己 new ControlSession（会开出第二条链路）。
 *
 * 测试永远不 import 本模块：它们用 `new ControlSession({ transportOverride })`。
 * 因此本模块只在函数体内部碰 wx（`detectPlatform` / `createDefaultUsageLogger`
 * 自带守卫），import 时零副作用。
 */

import { ControlSession } from "./session";
import { detectDevMode, detectPlatform } from "./platform";
/*
 * 必须写全 `../usage/index`，不能写 `../usage`。
 *
 * 微信小程序的模块解析器**不认目录 index**：`../usage` 会在运行时报
 * `module 'utils/usage.js' is not defined`，而 TypeScript 编译期完全正常
 * （`tsc --noEmit` 干净、node 侧测试也全过），所以只有真机/模拟器才暴露。
 * 这个文件是 App 启动链的必经节点，一崩整棵页面树全部 `Page() has not been
 * registered yet` —— 表现为整个小程序白屏。
 */
import { createDefaultUsageLogger } from "../usage/index";
import type { UsageLogSink } from "../usage/logger";

let session: ControlSession | null = null;
/** `undefined` = 还没问过配置；`null` = 问了，但后端未配置（功能关闭）。 */
let usageLogger: UsageLogSink | null | undefined;

/**
 * 取 App 级会话（首次调用时创建）。
 *
 * 懒创建而不是在模块顶层 new：顶层 new 会在 import 时就构造 BleTransport
 * （它注册 `wx.on*`），任何在 node 里 import 到本模块的代码都会炸。
 */
export function getSession(): ControlSession {
  if (session === null) {
    const logger = getUsageLogger();
    session = new ControlSession({
      platform: detectPlatform(),
      devMode: detectDevMode(),
      ...(logger !== null ? { usageLogger: logger } : {}),
    });
  }
  return session;
}

/**
 * 使用日志落点（#34）：未配置后端时为 null，控制路径完全不受影响。
 *
 * 只问一次：`createDefaultUsageLogger` 会读 storage + 解析配置，页面每次
 * onShow 都调一遍没有意义。
 */
export function getUsageLogger(): UsageLogSink | null {
  if (usageLogger === undefined) {
    usageLogger = createDefaultUsageLogger();
  }
  return usageLogger;
}

/**
 * 测试用：替换 / 清空单例。
 *
 * 生产代码不调用。`null` 表示清空，下一次 `getSession()` 会重新创建。
 */
export function setSessionForTest(next: ControlSession | null): void {
  session = next;
}
