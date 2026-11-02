/**
 * 平台探测与「还没有设备状态」时的兜底快照。
 *
 * 都是纯函数（只读 wx 的环境信息），不接触 BLE。
 */

import type { DeviceState, RGB } from "../protocol/types";

/** 从 wx 取平台；devtools 归到 other（BLE 能力只模拟一部分）。 */
export function detectPlatform(): "android" | "ios" | "other" {
  const platform = detectRuntimePlatform();
  if (platform === "android") return "android";
  if (platform === "ios") return "ios";
  return "other";
}

/**
 * 原始运行平台串（`android` / `ios` / `devtools` / 空串）。
 *
 * 与 `detectPlatform()` 的区别：这里**保留 `devtools`**。演示模式的自动开启
 * 只认这一个值——模拟器没有 BLE 外设，才需要演示数据兜底；真机必须走真实
 * 蓝牙。`detectPlatform()` 为了 BLE 分支把 devtools 归成 other，两者不能混用。
 */
export function detectRuntimePlatform(): string {
  try {
    const info = wx.getDeviceInfo?.() ?? wx.getSystemInfoSync();
    return String((info as { platform?: string }).platform ?? "").toLowerCase();
  } catch {
    return "";
  }
}

/** 开发版判断：develop / trial 都打 hex，正式版不打。 */
export function detectDevMode(): boolean {
  try {
    const info = wx.getAccountInfoSync?.();
    const env = info?.miniProgram?.envVersion;
    return env === "develop" || env === "trial";
  } catch {
    return false;
  }
}

/**
 * 还没有设备状态时的兜底快照：只用于页面渲染，不写入设备。
 * （正常路径下 latestState 在连接流水线读 State 后必然存在。）
 *
 * v3：State 是 37 字节（带逐带灯珠数 / 段数 / 开关位），兜底快照也要填满，
 * 否则页面按派生字段渲染时会读到 undefined。
 */
export function fallbackState(rgb: RGB, power: 0 | 1 = 1, brightness = 0): DeviceState {
  return {
    power,
    brightness,
    r: rgb.r,
    g: rgb.g,
    b: rgb.b,
    ledCount: 0,
    maxBrightness: 255,
    stripCount: 1,
    segCount: 0,
    scriptId: 0xff,
    stageIndex: 0,
    playbackState: 0,
    flags: 0,
    /** 兜底按「全开」显示，避免未连接时误显示为每条带都关着。 */
    stripPowerMask: 0xff,
    stripAnimMask: 0,
    stripCounts: [0, 0, 0, 0, 0, 0, 0, 0],
    stripSegCounts: [0, 0, 0, 0, 0, 0, 0, 0],
  };
}
