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
 * ## 演示模式（mock）
 *
 * 没有任何真机记录时（或用户显式打开），这里注入 `MockTransport` 并把演示
 * 设备播种进真实的 recent/registry 存储。会话本身没有感知——它拿到的仍是
 * 一个「传输层」，所有页面代码、列表派生、命令语义完全不变。
 *
 * 播种必须在 `new ControlSession` **之前**：会话只在构造时读一次
 * `recentDevices`。
 *
 * 测试永远不 import 本模块：它们用 `new ControlSession({ transportOverride })`。
 * 因此本模块只在函数体内部碰 wx（`detectPlatform` / `createDefaultUsageLogger`
 * 自带守卫），import 时零副作用。
 */

import { ControlSession } from "./session";
import { detectDevMode, detectPlatform } from "./platform";
import { createWxStorage } from "./device-cache";
import { reconcileMockMode } from "./mock-mode";
import { BleTransport } from "../ble/transport";
import { FrameLog } from "../ble/log";
import { MockTransport } from "../ble/mock-transport";
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
/** 当前是否运行在演示模式（供「发现」页显示开关与提示）。 */
let mockActive = false;

/**
 * 取 App 级会话（首次调用时创建）。
 *
 * 懒创建而不是在模块顶层 new：顶层 new 会在 import 时就构造 BleTransport
 * （它注册 `wx.on*`），任何在 node 里 import 到本模块的代码都会炸。
 */
export function getSession(): ControlSession {
  if (session === null) {
    const logger = getUsageLogger();
    const storage = createWxStorage();
    const platform = detectPlatform();
    const devMode = detectDevMode();
    /* 播种 / 清理演示设备必须在 new ControlSession 之前：会话只在构造时
     * 读一次 recentDevices。 */
    mockActive = reconcileMockMode(storage);
    const transport = mockActive
      ? new MockTransport({ log: new FrameLog({ mirrorToConsole: devMode }), platform })
      : new BleTransport({ log: new FrameLog({ mirrorToConsole: devMode }), platform });
    session = new ControlSession({
      platform,
      devMode,
      /* MockTransport 与 BleTransport 的公共面同形；断言只是为了让构造器
       * 的注入点保持单一类型（生产路径仍是真 BleTransport）。 */
      transportOverride: transport as unknown as BleTransport,
      ...(logger !== null ? { usageLogger: logger } : {}),
    });
  }
  return session;
}

/** 当前会话是否使用演示传输层。 */
export function isMockSession(): boolean {
  return mockActive;
}

/**
 * 丢弃当前会话并让下一次 `getSession()` 重建。
 *
 * 用途只有一个：切换演示模式。会话在构造时就绑定了传输层、并在构造时读一次
 * `recentDevices`，所以「换一批设备数据」不可能在原地完成。
 *
 * 调用方必须在本方法之后重新 `getSession()`，并在 `onShow` 里用新实例订阅——
 * 旧实例已经 `destroy()`，它的监听全部失效。
 */
export function reloadSession(): void {
  if (session === null) {
    return;
  }
  session.destroy();
  session = null;
  mockActive = false;
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
