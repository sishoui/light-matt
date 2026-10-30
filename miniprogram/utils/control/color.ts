/**
 * 颜色语义（纯函数）。
 *
 * v2（#21）退役了 v1 的 SetColor 0x03 / SetAll 0x04，颜色改由段配置
 * （0x10 SetSegment）承担。这里的纯函数（钳位、本地乐观写回、预设亮度）
 * 仍然有效，但**下发路径**在 #25 重建分段界面之前是禁用的：
 * `ControlSession.queueColor / commitColor / applyPreset` 都是占位实现。
 *
 * 与协议的关系（docs/protocol.md §7）：
 *  - State 字节 2-4 是 **strip 0 / seg 0 的基准色**（hue+sat 转 RGB，
 *    不含动画包络），无 seg 0 时为 0；
 *  - 颜色是用户空间 RGB：App 不做 gamma、不把亮度折进 RGB。
 *
 * 本模块不接触 wx / BLE，可在 vitest 里直接测。
 */

import type { DeviceState, RGB } from "../protocol/types";
import { brightnessForPowerOn, clampBrightness, effectiveMaxBrightness } from "./brightness";

/** 单通道钳成 0-255 的整数；非有限值按 0（与命令行参构造器的字节约束对齐）。 */
export function clampChannel(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.min(255, Math.max(0, Math.round(value)));
}

/** 三个通道都钳到 0-255，返回新对象。 */
export function clampRgb(rgb: RGB): RGB {
  return {
    r: clampChannel(rgb.r),
    g: clampChannel(rgb.g),
    b: clampChannel(rgb.b),
  };
}

/** 两个颜色是否逐通道相同（预设高亮用）。 */
export function sameRgb(a: RGB, b: RGB): boolean {
  return a.r === b.r && a.g === b.g && a.b === b.b;
}

/**
 * 本地乐观更新：只改 RGB，不动 power / brightness。
 * 色环拖动时 UI 立即跟手，不等设备回包（设备仍是权威，重连/错误时读 State）。
 */
export function applyLocalColor(state: DeviceState, rgb: RGB): DeviceState {
  const color = clampRgb(rgb);
  return { ...state, r: color.r, g: color.g, b: color.b };
}

/**
 * 预设点击时要下发的亮度（亮度 0 时用「最近一次非 0 亮度」恢复）。
 *
 * v2 暂时没有下发路径（SetAll 已退役，预设改由 #25 的静态段承担）；
 * 这个函数保留给 #25 复用，单测仍覆盖其边界。
 * 上限取设备上报的 maxBrightness（不硬编码 255）。
 */
export function presetBrightness(
  state: Pick<DeviceState, "brightness" | "maxBrightness"> | null,
  lastNonZeroBrightness: number,
): number {
  if (state === null) {
    return brightnessForPowerOn(lastNonZeroBrightness, 255);
  }
  const max = effectiveMaxBrightness(state.maxBrightness);
  if (state.brightness > 0) {
    return clampBrightness(state.brightness, max);
  }
  return brightnessForPowerOn(lastNonZeroBrightness, max);
}
