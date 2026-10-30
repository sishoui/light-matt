/**
 * 平台探测与「还没有设备状态」时的兜底快照。
 *
 * 都是纯函数（只读 wx 的环境信息），不接触 BLE。
 */

import type { DeviceState, RGB } from "../protocol/types";

/** 从 wx 取平台；devtools 归到 other（BLE 能力只模拟一部分）。 */
export function detectPlatform(): "android" | "ios" | "other" {
  try {
    const info = wx.getDeviceInfo?.() ?? wx.getSystemInfoSync();
    const platform = String((info as { platform?: string }).platform ?? "").toLowerCase();
    if (platform === "android") return "android";
    if (platform === "ios") return "ios";
    return "other";
  } catch {
    return "other";
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
    // v2（#21）：State 扩到 14 字节，兜底快照也要填满。
    stripCount: 1,
    segCount: 0,
    scriptId: 0xff,
    stageIndex: 0,
    playbackState: 0,
    flags: 0,
  };
}
