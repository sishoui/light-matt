/**
 * 灯组页「简单档」的纯派生（#64）。
 *
 * 简单档只做一件事：**让整条灯组变成一张成品效果卡**。所以这里的函数全部是
 * 「设备/草稿 → 界面视图」的换算，不碰 wx、不碰 BLE，可直接单测：
 *
 *  1. 方案槽位按钮的文案（「方案 ①」+「空白 / N 个步骤」）；
 *  2. HSV 三滑块的取值范围与「能不能下发」标记（亮度要等协议 v4 的 `level`）；
 *  3. 设备读回值 → 「当前是不是某一张卡」（整组一个光区、无叠加层才算）。
 *
 * 卡片表本身在 `quick-effects.ts`（`QUICK_CARDS` / `buildQuickCardViews` /
 * `buildQuickPanel`），这里不重新定义任何一张卡。
 */

import { rgbToHex, segmentHueSatToRgb } from "../color/hsv";
import { NO_EFFECT } from "../protocol/constants";
import type { SegmentReport } from "../protocol/types";
import {
  buildQuickPanel,
  defaultParams,
  inferQuickCard,
  quickCardOf,
  type QuickParams,
} from "./quick-effects";

/** 方案槽位数（协议：设备侧可存 4 套）。 */
export const PLAN_SLOT_COUNT = 4;

/** 亮度滑块的显示区间：0 会让整组不出光，给用户的下限留 5%。 */
export const LEVEL_MIN = 5;
export const LEVEL_MAX = 100;
export const LEVEL_DEFAULT = 100;

/**
 * 亮度滑块的限制说明。
 *
 * `level` 是协议 v4 才有的字段（逐光区亮度）。小程序编解码还没升到 v4
 * （票 #69），所以滑块与草稿照做，但**不下发**——更不能临时映射到设备的
 * 全局亮度（那会串到别的灯组）。
 */
export const LEVEL_UNAVAILABLE_NOTE = "固件更新后可用";

const CIRCLED = ["①", "②", "③", "④"] as const;

/** 槽位号 → 「方案 ①」；越界按 4 取模（按钮是轮换的，不会出现非法值）。 */
export function planSlotLabel(slot: number): string {
  const index = normalizedSlot(slot);
  return `方案 ${CIRCLED[index]}`;
}

/** 槽位内容摘要：空槽位必须明说「空白」，有内容说步骤数。 */
export function planSlotSub(stepCount: number): string {
  const count = Number.isFinite(stepCount) ? Math.max(0, Math.floor(stepCount)) : 0;
  return count === 0 ? "空白" : `${count} 个步骤`;
}

/** 点一下切到下一个槽位（0→1→2→3→0）。 */
export function cyclePlanSlot(current: number, count: number = PLAN_SLOT_COUNT): number {
  const size = Number.isFinite(count) && count > 0 ? Math.floor(count) : PLAN_SLOT_COUNT;
  return (normalizedSlot(current, size) + 1) % size;
}

function normalizedSlot(slot: number, count: number = PLAN_SLOT_COUNT): number {
  if (!Number.isFinite(slot)) {
    return 0;
  }
  const mod = Math.floor(slot) % count;
  return mod < 0 ? mod + count : mod;
}

/* ---------------- HSV 滑块与协议值的换算 ---------------- */

/** 协议色相 0-65535 → 滑块的 0-359 度。 */
export function hueDegreesOf(hue: number): number {
  const value = Number.isFinite(hue) ? hue : 0;
  const wrapped = ((Math.round(value) % 0x10000) + 0x10000) % 0x10000;
  return Math.round((wrapped / 0x10000) * 360) % 360;
}

/** 滑块的 0-360 度 → 协议色相 0-65535（360 度回到红色，即 0）。 */
export function hueFromDegrees(degrees: number): number {
  const value = Number.isFinite(degrees) ? degrees : 0;
  const wrapped = ((value % 360) + 360) % 360;
  return Math.round((wrapped / 360) * 0x10000) & 0xffff;
}

/** 协议饱和度 0-255 → 滑块的 0-100（%）。 */
export function satPercentOf(sat: number): number {
  const value = Number.isFinite(sat) ? sat : 0;
  return Math.max(0, Math.min(100, Math.round((value / 255) * 100)));
}

/** 滑块的 0-100（%）→ 协议饱和度 0-255。 */
export function satFromPercent(percent: number): number {
  const value = Number.isFinite(percent) ? percent : 0;
  const clamped = Math.max(0, Math.min(100, value));
  return Math.round((clamped / 100) * 255);
}

/** 亮度草稿钳到显示区间（越界 / 非有限值都给默认满亮）。 */
export function clampLevel(level: number): number {
  if (!Number.isFinite(level)) {
    return LEVEL_DEFAULT;
  }
  return Math.max(LEVEL_MIN, Math.min(LEVEL_MAX, Math.round(level)));
}

/* ---------------- 参数区视图 ---------------- */

export type SimpleSliderKey = "hue" | "sat" | "level";

/** 参数区的一个 HSV 滑块。 */
export interface SimpleSliderView {
  key: SimpleSliderKey;
  label: string;
  /** 滑块位置（hue: 0-359 度；sat / level: 0-100）。 */
  value: number;
  /** 右侧读数（「40°」「62%」「100%」）。 */
  display: string;
  min: number;
  max: number;
  step: number;
  /** false = 只改草稿、不下发（协议还没有该字段）。 */
  sends: boolean;
  /** 不能下发时的原因；空串表示正常下发。 */
  note: string;
}

/** 选中卡片的参数区：只含这张卡支持的滑块。 */
export interface SimpleParamView {
  cardId: string;
  cardName: string;
  /** 当前颜色的预览色（滑块的实时反馈）。 */
  colorHex: string;
  sliders: SimpleSliderView[];
}

/**
 * 卡片 + 参数 + 亮度草稿 → 参数区。
 *
 * 「只显示该卡支持的控件」的判据来自卡片表自己的 `shows`：
 *  - `shows.color` → 色相（彩虹卡自己循环变色，没有「色相」可言）；
 *  - `shows.color || shows.saturation` → 饱和度（彩虹卡用它调浓淡）；
 *  - 亮度恒在，但带「固件更新后可用」标记。
 */
export function buildSimpleParams(
  cardId: string | null,
  params: QuickParams = {},
  level: number = LEVEL_DEFAULT,
): SimpleParamView | null {
  const card = cardId === null ? null : quickCardOf(cardId);
  if (card === null) {
    return null;
  }
  /* 复用快捷档的参数视图：卡片名与预览色只有一份实现。 */
  const panel = buildQuickPanel(card.id, params);
  if (panel === null) {
    return null;
  }
  const merged = { ...defaultParams(card), ...params };
  const sliders: SimpleSliderView[] = [];

  if (card.shows.color) {
    const degrees = hueDegreesOf(merged.hue);
    sliders.push({
      key: "hue",
      label: "色相",
      value: degrees,
      display: `${degrees}°`,
      min: 0,
      max: 360,
      step: 1,
      sends: true,
      note: "",
    });
  }
  if (card.shows.color || card.shows.saturation) {
    const percent = satPercentOf(merged.sat);
    sliders.push({
      key: "sat",
      label: "饱和度",
      value: percent,
      display: `${percent}%`,
      min: 0,
      max: 100,
      step: 1,
      sends: true,
      note: "",
    });
  }
  const brightness = clampLevel(level);
  sliders.push({
    key: "level",
    label: "亮度",
    value: brightness,
    display: `${brightness}%`,
    min: LEVEL_MIN,
    max: LEVEL_MAX,
    step: 1,
    sends: false,
    note: LEVEL_UNAVAILABLE_NOTE,
  });

  return {
    cardId: panel.cardId,
    cardName: panel.cardName,
    colorHex: panel.colorHex,
    sliders,
  };
}

/* ---------------- 设备读回 → 当前卡片 ---------------- */

/** 设备上「整组就是这一张卡」时的参数。 */
export interface SimpleDeviceState {
  cardId: string;
  /** 协议色相 0-65535（不是滑块度数）。 */
  hue: number;
  sat: number;
  colorHex: string;
}

/**
 * 判断设备上的这一组是否「整组 = 一张成品卡」。
 *
 * 只有同时满足才敢回填界面（否则界面会高亮一个设备上并不存在的效果）：
 *  1. 只有一个光区；
 *  2. 它从 0 覆盖到最后一颗灯珠；
 *  3. 没有叠加层（`layer1.type === NO_EFFECT`）；
 *  4. 层类型能反推出某张卡（`inferQuickCard`）。
 *
 * 不满足返回 null，界面清掉选中态与参数。
 */
export function inferSimpleState(
  reports: readonly SegmentReport[],
  ledCount: number,
): SimpleDeviceState | null {
  if (reports.length !== 1) {
    return null;
  }
  const only = reports[0];
  const coversWhole = only.start === 0 && only.end >= Math.max(0, Math.floor(ledCount) - 1);
  if (!coversWhole || only.layer1.type !== NO_EFFECT) {
    return null;
  }
  const cardId = inferQuickCard(only.layer0);
  if (cardId === null || quickCardOf(cardId) === null) {
    return null;
  }
  return {
    cardId,
    hue: only.layer0.hue,
    sat: only.layer0.sat,
    colorHex: rgbToHex(segmentHueSatToRgb(only.layer0.hue, only.layer0.sat)),
  };
}
