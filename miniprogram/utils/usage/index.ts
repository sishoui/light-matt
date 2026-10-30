/**
 * 使用日志的组装入口：页面只需要 `createDefaultUsageLogger()`。
 *
 * 生产依赖（wx.storage / wx.request / Date.now / Math.random）都在这里注入，
 * 纯逻辑模块本身不认识 wx。未配置后端（见 config.ts）时返回 `null`，
 * 页面把它当「没有日志功能」处理，控制路径完全不受影响。
 */

import { loadUsageConfig } from "./config";
import { createWxHttpFetch } from "./http";
import { UsageLogger, type UsageLogSink } from "./logger";
import { createWxUsageStorage } from "./storage";

export { loadUsageConfig, type UsageConfig } from "./config";
export { UsageQueue, USAGE_QUEUE_MAX } from "./queue";
export { UsageLogger, type UsageLogSink } from "./logger";
export { getOrCreateLocalUserKey, createClientEventId, toUsagePlatform } from "./event";
export type { ConnectionIdentity, UsageEvent } from "./event";
export { createWxUsageStorage, createMemoryUsageStorage, type UsageStorage } from "./storage";
export type { HttpFetch, HttpResponse, HttpRequest } from "./http";

/**
 * 生产用 logger。配置缺失或后端地址/令牌不完整时返回 null（功能关闭）。
 *
 * 注意：返回 null 不是错误，页面不应该提示用户——后端上报是隐藏的旁路。
 */
export function createDefaultUsageLogger(): UsageLogSink | null {
  const storage = createWxUsageStorage();
  const config = loadUsageConfig(storage);
  if (!config.enabled) {
    return null;
  }
  return new UsageLogger({
    config,
    fetch: createWxHttpFetch(),
    storage,
    onDiagnostic: (message) => console.warn(`[lumen] ${message}`),
  });
}
