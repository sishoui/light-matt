/**
 * 页面文案与纯视图派生（无 wx.*、无页面实例依赖）。
 *
 * 抽出来的目的：index.ts 只留状态持有与事件转发，文案规则集中在这里，
 * 与 color/brightness 的纯函数同一层级。
 *
 * 颜色相关的文案（旧 `colorHintText`）已随色环 UI 一起删除：现在选颜色走
 * 灯组页的 HSV 滑块，文案由 `effect-panel` 提供，本模块只剩亮度与开关。
 */

import {
  brightnessPercent as percentOf,
  clampBrightness,
} from "./brightness";

/** 亮度滑块读数的 setData 节流（毫秒）：与 BLE 20Hz 对齐，避免每帧重建视图。 */
export const BRIGHTNESS_UI_INTERVAL_MS = 50;

/** 亮度提示文案：未连接 / 亮度 0 的语义都要如实说明（§7）。 */
export function brightnessHintText(value: number, ready: boolean): string {
  if (!ready) {
    return "连接后可调节";
  }
  if (value === 0) {
    return "亮度 0 视觉上等于关灯；开关状态保持为开";
  }
  return "拖动实时跟随，松手确认";
}

/** 亮度 0 且 power=1：灯是灭的但开关位仍为开，文案要如实说明（§7）。 */
export function powerLabelText(power: 0 | 1, brightness: number): string {
  if (power === 0) {
    return "已关";
  }
  return brightness === 0 ? "已开 · 亮度 0" : "已开";
}

/**
 * 亮度滑块视图补丁。
 *
 * 只影响 brightness 相关字段：power 位不动（亮度 0 视觉等于关灯，但设备仍是「开」）。
 * bindValue 为 false 时不回写 slider.value（拖动中由原生控件跟手）。
 */
export function brightnessViewPatch(
  rawValue: number,
  maxBrightness: number,
  ready: boolean,
  bindValue: boolean,
): Record<string, unknown> {
  const value = clampBrightness(rawValue, maxBrightness);
  const patch: Record<string, unknown> = {
    brightnessDisplay: value,
    brightnessPercent: percentOf(value, maxBrightness),
    brightnessHintText: brightnessHintText(value, ready),
  };
  if (bindValue) {
    patch.brightness = value;
  }
  return patch;
}
