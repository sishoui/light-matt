/**
 * 页面文案与纯视图派生（无 wx.*、无页面实例依赖）。
 *
 * 抽出来的目的：index.ts 只留状态持有与事件转发，文案规则集中在这里，
 * 与 color/brightness 的纯函数同一层级。行为与拆分前逐字一致。
 *
 * #25 起颜色属于「段」：颜色区的提示要说明当前在改哪一段，没有段时明确
 * 要求先划区间，而不是让用户拖动后以为没生效。
 */

import {
  brightnessPercent as percentOf,
  clampBrightness,
} from "../../utils/control/brightness";
import { PRESETS } from "../../utils/color/hsv";
import type { RGB } from "../../utils/protocol/types";

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

/**
 * 颜色区提示文案（#25）。
 *
 * - 未连接：说明要连上才能改；
 * - 已连接但没有选中段：明确要求先在下方划区间；
 * - 有选中段：指出正在编辑哪一段（段号与区间）。
 */
export function colorHintText(
  ready: boolean,
  active: { segId: number; start: number; end: number } | null,
): string {
  if (!ready) {
    return "连接后可调节；颜色按灯珠区间下发";
  }
  if (active === null) {
    return "先在上方划一个灯珠区间，再选颜色";
  }
  return `正在编辑 段 ${active.segId}（灯珠 ${active.start}-${active.end}）`;
}

/** 亮度 0 且 power=1：灯是灭的但开关位仍为开，文案要如实说明（§7）。 */
export function powerLabelText(power: 0 | 1, brightness: number): string {
  if (power === 0) {
    return "已关";
  }
  return brightness === 0 ? "已开 · 亮度 0" : "已开";
}

/** 当前 RGB 与哪个预设完全一致（用于高亮）；都不匹配返回空串。 */
export function matchingPreset(rgb: RGB): string {
  for (const preset of PRESETS) {
    if (preset.rgb.r === rgb.r && preset.rgb.g === rgb.g && preset.rgb.b === rgb.b) {
      return preset.name;
    }
  }
  return "";
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
