/**
 * 灯组页「简单档」的纯派生（#64）。
 *
 * 简单档只做一件事：**让整条灯组变成一张成品效果卡**。所以这里的函数全部是
 * 「设备/草稿 → 界面视图」的换算，不碰 wx、不碰 BLE，可直接单测：
 *
 *  1. 方案槽位按钮的文案（「方案 ①」+「空白 / N 个步骤」）；
 *  2. HSV 三滑块的取值范围（亮度是协议 v4 的 `level`，**真实下发**）；
 *  3. 设备读回值 → 「当前是不是某一张卡」（整组一个分区、无叠加层才算）。
 *
 * 卡片表本身在 `quick-effects.ts`（`QUICK_CARDS` / `buildQuickCardViews` /
 * `buildQuickPanel`），这里不重新定义任何一张卡。
 */

import { NO_EFFECT } from "../protocol/constants";
import type { SegmentReport } from "../protocol/types";
import {
  buildQuickPanel,
  defaultParams,
  inferQuickCard,
  quickCardOf,
  quickColorHex,
  type QuickParams,
} from "./quick-effects";

/** 亮度滑块的显示区间：0 会让整组不出光，给用户的下限留 5%。 */
export const LEVEL_MIN = 5;
export const LEVEL_MAX = 100;
export const LEVEL_DEFAULT = 100;

/*
 * 方案槽位的文案与轮换已经不在这里（#83）：方案改为按需增长，规则全是
 * 「最小空位 / 删除不重排 / tab 文案」，集中在 `plan-slots.ts`。
 * 这里曾经有 `planSlotLabel` / `planSlotSub` / `cyclePlanSlot`——固定四套
 * 轮换的遗留物，留着只会让页面在两套口吻之间漂移。
 */

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

/** 亮度滑块的值钳到显示区间（越界 / 非有限值都给默认满亮）。 */
export function clampLevel(level: number): number {
  if (!Number.isFinite(level)) {
    return LEVEL_DEFAULT;
  }
  return Math.max(LEVEL_MIN, Math.min(LEVEL_MAX, Math.round(level)));
}

/**
 * 亮度钳到**协议合法区间 0-100**（越界 / 非有限值给默认满亮）。
 *
 * 与 `clampLevel` 的区别：滑块的显示下限是 5（0 会让整组不出光，不给拖），
 * 但 **0 在协议里合法**（这一层不出光）。设备读回 0 时必须原样保留，否则
 * 「读-改-写」会把用户刻意关掉的分区偷偷点亮。
 */
export function clampZoneLevel(level: number): number {
  if (!Number.isFinite(level)) {
    return LEVEL_DEFAULT;
  }
  return Math.max(0, Math.min(LEVEL_MAX, Math.round(level)));
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
  /** 滑块是否真的会改变设备（现存滑块全部为 true）。 */
  sends: boolean;
  /** 不能下发时的原因；空串表示正常下发。 */
  note: string;
}

/** 选中卡片的参数区：只含这张卡支持的滑块。 */
export interface SimpleParamView {
  cardId: string;
  cardName: string;
  /** 参数区标题（「暖白常亮的参数」；没有可调项的卡片只写名字）。 */
  title: string;
  /** 当前颜色的预览色（滑块的实时反馈）。 */
  colorHex: string;
  sliders: SimpleSliderView[];
  /** 没有滑块时的说明（熄灭卡：整组黑掉但灯组仍开着）；空串表示不显示。 */
  notice: string;
}

/**
 * 卡片 + 参数 + 亮度草稿 → 参数区。
 *
 * 「只显示该卡支持的控件」的判据来自卡片表自己的 `shows`：
 *  - `shows.color` → 色相（彩虹卡自己循环变色，没有「色相」可言）；
 *  - `shows.color || shows.saturation` → 饱和度（彩虹卡用它调浓淡）；
 *  - 亮度对**会有光**的卡片恒在，真实下发（v4 的逐分区 `level`，票 #69 接通）。
 *
 * 熄灭卡（#81）不给亮度滑块：它的参数块全 0、`level` 也归 0，给一个拖了
 * 也不起作用的滑块只会让人以为坏了。它只剩一句说明。
 */
export function buildSimpleParams(
  cardId: string | null,
  params: QuickParams = {},
  level: number = LEVEL_DEFAULT,
  /**
   * 灯效名（`simple-effects` 的八个名字）。
   *
   * #135：参数区标题与灯效行必须同源。以前标题取的是卡片表的旧色卡名
   * （暖白常亮 / 流光追逐 / 爆闪白…），而灯效行写「常亮 / 流星 / 爆闪」，
   * 同一屏两套名字，用户会怀疑自己点错了。
   */
  effectName: string | null = null,
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
  if (card.kind !== "off") {
    /* 读回值可以是 0（该层不出光）：显示真实值，只把滑块下限留给用户拖动。 */
    const brightness = clampZoneLevel(level);
    sliders.push({
      key: "level",
      label: "亮度",
      value: brightness,
      display: `${brightness}%`,
      min: LEVEL_MIN,
      max: LEVEL_MAX,
      step: 1,
      sends: true,
      note: "",
    });
  }

  /* #135：名字以灯效行为准。卡片名只作为「没给灯效名」时的兜底。 */
  const name = effectName ?? panel.cardName;
  return {
    cardId: panel.cardId,
    cardName: name,
    title: sliders.length === 0 ? name : `${name}的参数`,
    colorHex: panel.colorHex,
    sliders,
    notice: card.kind === "off" ? OFF_CARD_NOTICE : "",
  };
}

/** 熄灭卡的说明：它不是「关掉这组」，所以必须明说灯组仍然开着。 */
export const OFF_CARD_NOTICE = "整组保持黑色；这条灯组本身仍然开着。";

/**
 * 换卡时亮度草稿的去向。
 *
 * 熄灭卡（#81）不发光，设备读回的 `level` 是 0；如果把这个 0 原样带到下一张
 * 会发光的卡上，用户点「暖白常亮」也依然全黑——看起来像卡坏了。
 * 所以 0 在换卡时按默认满亮处理；非 0 值代表用户自己的亮度，原样保留。
 *
 * 注意：换到熄灭卡时**不要**把草稿清零（`levelAfterCardTap` 传旧值即可）：
 * 熄灭层的 level 恒为 0，草稿留着，用户从熄灭切回亮灯时亮度还在。
 */
export function levelAfterCardTap(level: number): number {
  if (!Number.isFinite(level) || level <= 0) {
    return LEVEL_DEFAULT;
  }
  return clampLevel(level);
}

/**
 * 设备读回后亮度草稿该取哪个值。
 *
 * 熄灭卡读回的 level 是 0（协议要求），但它不代表用户的亮度选择：
 * 把 0 写进草稿会让用户从熄灯切回亮灯后又变全黑。所以熄灭卡保留上一次草稿，
 * 其余卡片以设备值为准。
 */
export function levelDraftFromDevice(
  cardId: string,
  deviceLevel: number,
  previous: number,
): number {
  if (cardId === "off") {
    return levelAfterCardTap(previous);
  }
  return clampZoneLevel(deviceLevel);
}

/* ---------------- 设备读回 → 当前卡片 ---------------- */

/** 设备上「整组就是这一张卡」时的参数。 */
export interface SimpleDeviceState {
  cardId: string;
  /** 协议色相 0-65535（不是滑块度数）。 */
  hue: number;
  sat: number;
  /** v4：该分区主效果的亮度 0-100（设备权威值，滑块据它回显）。 */
  level: number;
  colorHex: string;
}

/**
 * 判断设备上的这一组是否「整组 = 一张成品卡」。
 *
 * 只有同时满足才敢回填界面（否则界面会高亮一个设备上并不存在的效果）：
 *  1. 只有一个分区；
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
  const card = cardId === null ? null : quickCardOf(cardId);
  if (card === null) {
    return null;
  }
  return {
    cardId: card.id,
    hue: only.layer0.hue,
    sat: only.layer0.sat,
    level: clampZoneLevel(only.layer0.level),
    /* 熄灭卡的预览一定是黑；按 0/0 色算会得到白，界面会误导成「点亮」。 */
    colorHex: quickColorHex(card, { hue: only.layer0.hue, sat: only.layer0.sat }),
  };
}
