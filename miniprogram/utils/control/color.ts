/**
 * 颜色语义（纯函数）。
 *
 * v5 的 State 是 32 字节且**不含颜色摘要**（§7.3）：颜色只存在场景的层里
 * （`SceneStep` 的 `layer[].param` 是 hue/sat），没有「读回当前色」这回事。
 * 所以这里只剩两件与协议无关的事：钳位、以及两个 RGB 的比较。
 *
 * 颜色是用户空间 RGB：App 不做 gamma、不把亮度折进 RGB。
 *
 * 本模块不接触 wx / BLE，可在 vitest 里直接测。
 */

import type { DeviceState, RGB } from "../protocol/types";

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
 * 本地乐观更新：**v5 已没有「设备当前的 RGB」这个字段**（§7.3：State 只有
 * 32 字节，颜色明细走 QueryScene），所以这里退化成「原样返回」。
 *
 * 保留函数是因为色环的点按仍然需要一个「归一化后的颜色」入口——`clampRgb`
 * 那一步才是它现在的职责，页面拿它的返回值去填本地的草稿色。
 */
export function applyLocalColor(state: DeviceState, _rgb: RGB): DeviceState {
  return state;
}

