/**
 * App 级设备同步 API 单例（#44）。
 *
 * 与 `session-singleton` 同一套理由：后端配置读一次、身份缓存复用，
 * 页面每次 onShow 都重建会重复 `POST /api/v1/session`。
 *
 * 纪律：
 *  - 页面通过 `getDeviceApi()` 取，不要自己 new（会绕开身份缓存）；
 *  - 未配置后端时返回 `null`：同步功能关闭，**不是错误**，页面不该提示；
 *  - 只在函数体内部碰 wx（storage / request 的实现自带守卫），import 零副作用，
 *    所以 node 单测即使间接 import 到本模块也不会炸。
 *
 * 测试永远不 import 本模块：它们直接 new `DeviceApi`（注入假 fetch）。
 */

import { createDefaultDeviceApi, type DeviceApi } from "./device-api";
import { createWxHttpFetch } from "../usage/http";
import { createWxUsageStorage } from "../usage/storage";
import { getOrCreateLocalUserKey } from "../usage/event";

let api: DeviceApi | null | undefined;

/**
 * 取设备同步 API；后端未配置时为 `null`（功能关闭）。
 *
 * 懒创建：模块顶层 new 会在 import 时读 wx.storage，node 环境下虽然安全降级，
 * 但会让「import 即失败」的纪律变形——保持只在调用时构造。
 */
export function getDeviceApi(): DeviceApi | null {
  if (api === undefined) {
    api = createDefaultDeviceApi({
      storage: createWxUsageStorage(),
      fetch: createWxHttpFetch(),
      /* 本地身份与使用日志共用同一个键（`lumen.usage.userkey.v1`）：
       * 同一安装、同一个人，没有理由生成两个。 */
      localUserKey: () => getOrCreateLocalUserKey(createWxUsageStorage()),
    });
  }
  return api;
}

/** 测试用：替换 / 清空单例。生产代码不调用。 */
export function setDeviceApiForTest(next: DeviceApi | null): void {
  api = next;
}
