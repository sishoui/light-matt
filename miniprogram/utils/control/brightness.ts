/**
 * 亮度语义（纯函数 + 小状态），#9 亮度端到端。
 *
 * 与协议的关系（docs/protocol.md §7 / §11.4）：
 *  - 协议亮度范围 0-255，设备按构建期 max_brightness 钳位；State 暴露该上限。
 *    所以 App 侧滑块最大值必须取 State.maxBrightness，不能硬编码 255。
 *  - 开关与亮度独立存储：亮度 0 是合法状态（视觉关灯，power 位不变），
 *    关灯也保留亮度值。
 *  - 亮度 0 时重新开灯会「什么都不亮」，因此 App 记住最近一次非 0 亮度，
 *    开灯时用它恢复（仅在 brightness === 0 时需要，正常关灯再开本就不改亮度）。
 *
 * 本模块不接触 wx / BLE，可在 vitest 里直接测。
 */

import type { DeviceState } from "../protocol/types";

/** 从没收到过非 0 亮度时的恢复值（与协议首次上电默认值一致）。 */
export const DEFAULT_BRIGHTNESS = 128;

/** 设备上报的 max_brightness 若为 0（非法/未初始化），按 255 处理。 */
export function effectiveMaxBrightness(maxBrightness: number | undefined): number {
  if (maxBrightness === undefined || !Number.isFinite(maxBrightness) || maxBrightness <= 0) {
    return 255;
  }
  return Math.min(255, Math.max(1, Math.round(maxBrightness)));
}

/**
 * 把任意滑块输入钳到 [0, max] 的整数。
 * 非有限值按 0 处理；11 这样的字节上限由协议保证，这里只做防御。
 */
export function clampBrightness(value: number, maxBrightness: number): number {
  const max = effectiveMaxBrightness(maxBrightness);
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.min(max, Math.max(0, Math.round(value)));
}

/** 滑块位置百分比（0-100），只用于展示。 */
export function brightnessPercent(value: number, maxBrightness: number): number {
  const max = effectiveMaxBrightness(maxBrightness);
  return Math.round((clampBrightness(value, max) / max) * 100);
}

/**
 * 视觉上是否等于关灯：power 为 0 或亮度为 0。
 * 注意这不等于「设备 power 位」——亮度 0 时 power 仍可能是 1。
 */
export function isVisuallyOff(state: Pick<DeviceState, "power" | "brightness">): boolean {
  return state.power === 0 || state.brightness === 0;
}

/**
 * 开灯时要下发的亮度。
 * 只有当前亮度为 0 才需要恢复；调用方自行判断（避免多余帧）。
 */
export function brightnessForPowerOn(
  lastNonZeroBrightness: number,
  maxBrightness: number,
): number {
  const candidate =
    Number.isFinite(lastNonZeroBrightness) && lastNonZeroBrightness > 0
      ? lastNonZeroBrightness
      : DEFAULT_BRIGHTNESS;
  return clampBrightness(candidate, maxBrightness);
}

/**
 * 本地乐观更新：拖动时 UI 不等设备回包。
 *
 * 只改 brightness，**不动 power**——亮度 0 是合法状态（§7），设备侧 power
 * 仍然为 1，只是视觉等于关灯。返回新对象，不修改入参。
 */
export function applyLocalBrightness(state: DeviceState, value: number): DeviceState {
  return { ...state, brightness: clampBrightness(value, state.maxBrightness) };
}
