/**
 * 使用日志的唯一配置源。
 *
 * 两项配置：后端 base URL 与小程序写入端令牌（`x-lumen-app-token`）。
 * 它们只在这里出现一次，logger / 页面 / 测试都从本模块取值，不在别处硬编码。
 *
 * ## 个人测试阶段怎么配
 *
 * 有两种方式，后者优先：
 *
 * 1. **改代码**：填下面的 `STATIC_USAGE_CONFIG`（适合分支出测试包）。
 * 2. **写 storage**（不改代码，开发者工具 Console 执行一次即可）：
 *
 * ```js
 * wx.setStorageSync("lumen.usage.config.v1", JSON.stringify({
 *   baseUrl: "https://lumen.example.com", // 末尾斜杠会被去掉
 *   appToken: "<APP_TOKEN>",
 * }))
 * ```
 *
 * 不配置（baseUrl 或 appToken 为空）时 `enabled === false`：**不排队、不发送**，
 * 控制功能完全不受影响。这是有意的降级，不是错误。
 */

import type { UsageStorage } from "./storage";

export interface UsageConfig {
  /** 后端根地址，例如 `https://lumen.example.com`（末尾斜杠已归一化掉）。 */
  readonly baseUrl: string;
  /** 后端 `APP_TOKEN`，放在 `x-lumen-app-token` 头里。 */
  readonly appToken: string;
  /** 单次 HTTP 的硬超时；超时按「后端不可达」处理，记录留在队列里。 */
  readonly requestTimeoutMs: number;
  /** 显式开关；缺省时由 baseUrl + appToken 是否齐全推导。 */
  readonly enabled: boolean;
}

export const USAGE_CONFIG_STORAGE_KEY = "lumen.usage.config.v1";

/**
 * 编译期兜底配置。留空 = 依赖 storage 配置；storage 也没有 → 功能关闭。
 *
 * 这不是「三处硬编码」中的一处，而是**唯一**的代码内默认值：所有读取方都
 * 通过 `loadUsageConfig()` 拿到归一化后的同一份配置。
 */
export const STATIC_USAGE_CONFIG: UsageConfig = {
  baseUrl: "",
  appToken: "",
  requestTimeoutMs: 5000,
  enabled: true,
};

export const USAGE_LOGS_PATH = "/api/v1/usage-logs";

/** 去掉尾部斜杠，避免拼出 `//api/v1/...`。 */
export function normalizeBaseUrl(raw: string): string {
  let value = raw.trim();
  while (value.endsWith("/")) {
    value = value.slice(0, -1);
  }
  return value;
}

interface StoredConfig {
  baseUrl?: unknown;
  appToken?: unknown;
  requestTimeoutMs?: unknown;
  enabled?: unknown;
}

/**
 * 读取配置并归一化。storage 里没有配置或 JSON 损坏时退回默认值（禁用）。
 * 永不抛错。
 */
export function loadUsageConfig(storage: UsageStorage): UsageConfig {
  const raw = storage.get(USAGE_CONFIG_STORAGE_KEY);
  let stored: StoredConfig = {};
  if (raw !== null) {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        stored = parsed as StoredConfig;
      }
    } catch {
      stored = {};
    }
  }

  const baseUrl = normalizeBaseUrl(
    typeof stored.baseUrl === "string" ? stored.baseUrl : STATIC_USAGE_CONFIG.baseUrl,
  );
  const appToken =
    typeof stored.appToken === "string" ? stored.appToken.trim() : STATIC_USAGE_CONFIG.appToken;
  const timeoutRaw =
    typeof stored.requestTimeoutMs === "number" ? stored.requestTimeoutMs : NaN;
  const requestTimeoutMs =
    Number.isFinite(timeoutRaw) && timeoutRaw > 0
      ? Math.trunc(timeoutRaw)
      : STATIC_USAGE_CONFIG.requestTimeoutMs;
  const explicitlyEnabled = stored.enabled !== false;

  return {
    baseUrl,
    appToken,
    requestTimeoutMs,
    // 两项缺一不可：没有地址或没有令牌都视为未配置（禁用，不影响控制）。
    enabled: explicitlyEnabled && baseUrl.length > 0 && appToken.length > 0,
  };
}

/** 写入端完整 URL（唯一拼接点）。 */
export function usageLogsUrl(config: UsageConfig): string {
  return `${config.baseUrl}${USAGE_LOGS_PATH}`;
}
