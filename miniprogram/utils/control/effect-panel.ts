/**
 * 进阶档「效果面板」（#67，第三层）：效果类型 + 按类型整体替换的参数区。
 *
 * ## 为什么是纯模块
 *
 * 这一层几乎全是「规则」而不是「布局」：
 *
 *  1. **每种类型各自用哪几个旋钮**（静态 3 个、呼吸 5 个 + 波形、彩虹 2 个 + 方向、
 *     流光 5 个 + 方向）。写错一个就是「用户看到了当前类型用不上的旋钮」；
 *  2. **切换类型时保留什么**。颜色（色相 / 饱和度）与亮度必须留下，其余参数按新
 *     类型的语义重置——把彩虹的「跨度」带进流光当「尾长」没有任何意义；
 *  3. **滑块刻度 ↔ 协议值**。色相 0-360° ↔ 0-65535、饱和度 0-100% ↔ 0-255、
 *     周期秒 ↔ 毫秒、最低亮 / 跨度 / 尾长百分比 ↔ 0-255。
 *  4. **装配光区**。面板只改 `layer0`，但写进设备前必须过 `zone-model.buildZoneSpec`
 *     （空叠加层归一、两层定宽、深拷贝），否则设备回 `InvalidParam`。
 *
 * 页面只把结果塞进 `setData`、把滑块回调交给这里换算，不做算术与判断。
 * 不碰 wx / BLE，可直接单测。
 *
 * ## 亮度的现状（单点集成处）
 *
 * `level`（逐光区亮度）是协议 v4 字段。固件侧 v4 编码已经合入（#68），但小程序
 * 编解码还没升到 v4（#69），`EffectLayer` 因此**没有** `level` 字段。本模块照做
 * 滑块与草稿（`EffectParams.level`），编码时**不往字节里塞协议还不认识的字段**；
 * 唯一的转换点是 `panelLayer()`（见那里的注释）。#69 给 `EffectLayer` 加上
 * `level` 后，只需要改那一处。
 */

import {
  ANIMATION_MIN_PERIOD_MS,
  BREATHING_MIN_PERIOD_MS,
  SEGMENT_TYPE,
  WAVEFORM,
  WAVEFORM_NAMES,
} from "../protocol/constants";
import { breathingFlags, breathingWaveform, directionFlags } from "../protocol/commands";
import type { EffectLayer, SegmentSpec } from "../protocol/types";
import { rgbToHex, segmentHueSatToRgb } from "../color/hsv";
import { buildZoneSpec } from "./zone-model";
import { layerModeOf, WAVEFORM_OPTIONS } from "./effect-view";
import { percentOf255, spanText, tailText } from "./segment-view";
import {
  clampLevel,
  LEVEL_DEFAULT,
  LEVEL_MAX,
  LEVEL_MIN,
  hueDegreesOf,
  hueFromDegrees,
  satFromPercent,
  satPercentOf,
} from "./strip-simple";

/** 面板上的四种效果类型（与协议类型一一对应，没有「关闭」：主效果必填）。 */
export type PanelType = "static" | "breathing" | "rainbow" | "comet";

/** 类型 → 界面文案（四个等宽按钮）。 */
export const PANEL_TYPE_OPTIONS: ReadonlyArray<{ type: PanelType; name: string }> = [
  { type: "static", name: "静态" },
  { type: "breathing", name: "呼吸" },
  { type: "rainbow", name: "彩虹" },
  { type: "comet", name: "流光" },
];

/** 类型 → 协议枚举值。 */
const TYPE_VALUE: Record<PanelType, number> = {
  static: SEGMENT_TYPE.STATIC,
  breathing: SEGMENT_TYPE.BREATHING,
  rainbow: SEGMENT_TYPE.RAINBOW,
  comet: SEGMENT_TYPE.COMET,
};

/** 协议枚举值 → 面板类型（空层 / 未知按静态，与 `layerModeOf` 一致）。 */
export function panelTypeOf(type: number): PanelType {
  const mode = layerModeOf(type);
  return mode === "off" ? "static" : (mode as PanelType);
}

/** 周期滑块的秒数区间（0.5–10 秒，步进 0.5）。协议里是毫秒，界面只出现秒。 */
export const PERIOD_MIN_MS = 500;
export const PERIOD_MAX_MS = 10000;
export const PERIOD_STEP_MS = 500;

/** 最低亮 / 跨度 / 尾长在界面上的百分比区间。 */
export const PERCENT_MIN = 0;
export const PERCENT_MAX = 100;
export const PERCENT_STEP = 1;

/**
 * 面板的本地草稿。
 *
 * 一份草稿同时覆盖四种类型：每种类型只用其中一部分字段（见 `PARAM_KEYS`）。
 * 这样切换类型时「保留颜色」不需要在页面里做拆装。
 */
export interface EffectParams {
  /** 色相 0-65535（协议值，不是度数）。 */
  hue: number;
  /** 饱和度 0-255。 */
  sat: number;
  /** 亮度 0-100；协议 v4 字段，编码在 #69（见模块头）。 */
  level: number;
  /** 周期毫秒（静态恒 0，由 `panelLayer` 保证）。 */
  periodMs: number;
  /** 呼吸最低亮的占比 0-255（协议 `p5`）。 */
  minLevel: number;
  /** 呼吸波形 0-3（正弦 / 三角 / 锯齿 / 方波）。 */
  waveform: number;
  /** 彩虹跨度 0-255（协议 `p5`）。 */
  span: number;
  /** 流光尾长 0-255（协议 `p5`）。 */
  tail: number;
  /** 彩虹 / 流光的方向：true = 反转。 */
  reverse: boolean;
}

/**
 * 每种类型的默认参数。
 *
 * 颜色与亮度不在这里「按类型给」：它们是用户已经选好的东西，切换类型必须保留。
 * 这里的周期都高于各自的协议下限（334 / 200 毫秒），所以切过去立刻有可感知的动画，
 * 不会出现「周期 0 = 静止」让人以为新效果没生效。
 */
export function defaultParams(type: PanelType): EffectParams {
  const base: EffectParams = {
    hue: 7281,
    sat: 255,
    level: LEVEL_DEFAULT,
    periodMs: 1000,
    minLevel: 0,
    waveform: WAVEFORM.SINE,
    span: 255,
    tail: 120,
    reverse: false,
  };
  switch (type) {
    case "breathing":
      return { ...base, periodMs: 2000, minLevel: 102 };
    case "rainbow":
      return { ...base, periodMs: 3000, span: 255 };
    case "comet":
      return { ...base, periodMs: 2000, tail: 120 };
    default:
      return { ...base, periodMs: 0 };
  }
}

/** 把草稿里所有字段钳到各自合法区间（外部值 / 设备读回值都可能越界）。 */
export function normalizeParams(params: Partial<EffectParams>): EffectParams {
  const merged = { ...defaultParams("static"), ...params };
  return {
    hue: clampHue(merged.hue),
    sat: clampByte(merged.sat),
    level: clampLevel(merged.level),
    periodMs: clampPeriodMs(merged.periodMs),
    minLevel: clampByte(merged.minLevel),
    waveform: clampWaveform(merged.waveform),
    span: clampByte(merged.span),
    tail: clampByte(merged.tail),
    reverse: merged.reverse === true,
  };
}

/** 色相钳到 0-65535（非有限值按 0）。 */
export function clampHue(hue: number): number {
  if (!Number.isFinite(hue)) {
    return 0;
  }
  const rounded = Math.round(hue) % 0x10000;
  return rounded < 0 ? rounded + 0x10000 : rounded;
}

/** 0-255 的字节字段钳位。 */
function clampByte(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.min(255, Math.round(value)));
}

/** 周期钳到滑块的区间。静态的 0 也合法（表示「不需要周期」）。 */
export function clampPeriodMs(periodMs: number): number {
  if (!Number.isFinite(periodMs) || periodMs <= 0) {
    return 0;
  }
  const stepped = Math.round(periodMs / PERIOD_STEP_MS) * PERIOD_STEP_MS;
  return Math.max(PERIOD_MIN_MS, Math.min(PERIOD_MAX_MS, stepped));
}

/** 波形钳到 0-3。 */
export function clampWaveform(waveform: number): number {
  if (!Number.isFinite(waveform)) {
    return WAVEFORM.SINE;
  }
  return Math.max(0, Math.min(3, Math.round(waveform)));
}

/* ---------------- 每种类型用哪些旋钮 ---------------- */

/** 滑块键（顺序 = 面板上的显示顺序）。 */
export type PanelSliderKey = "hue" | "sat" | "level" | "period" | "minLevel" | "span" | "tail";

/** 选择键（波形 / 方向）。 */
export type PanelChoiceKey = "waveform" | "direction";

/**
 * 每种类型的滑块列表。
 *
 * 这张表就是「用户永远看不到当前类型用不上的旋钮」的唯一真相：参数区整体替换
 * 的依据是它，不是页面里的 `wx:if` 集合。
 */
export const SLIDER_KEYS: Record<PanelType, readonly PanelSliderKey[]> = {
  static: ["hue", "sat", "level"],
  breathing: ["hue", "sat", "level", "period", "minLevel"],
  rainbow: ["period", "span"],
  comet: ["hue", "sat", "level", "period", "tail"],
};

/** 全部滑块键（页面判 `dataset.key` 用）。 */
const ALL_SLIDER_KEYS: readonly PanelSliderKey[] = [
  "hue",
  "sat",
  "level",
  "period",
  "minLevel",
  "span",
  "tail",
];

/** 这个 key 是不是一个滑块键（来自渲染层的数据不算可信）。 */
export function isPanelSliderKey(key: string): key is PanelSliderKey {
  return (ALL_SLIDER_KEYS as readonly string[]).includes(key);
}

/** 每种类型的选择控件（永远排在滑块之后）。 */
export const CHOICE_KEYS: Record<PanelType, readonly PanelChoiceKey[]> = {
  static: [],
  breathing: ["waveform"],
  rainbow: ["direction"],
  comet: ["direction"],
};

/** 一个滑块的展示态。 */
export interface PanelSliderView {
  key: PanelSliderKey;
  label: string;
  /** 滑块位置（色相是度、其余是百分比或秒）。 */
  value: number;
  min: number;
  max: number;
  step: number;
  /** 右侧读数（「40°」「62%」「2 秒」「整圈」「拖尾 47%」）。 */
  display: string;
  /** 滑轨是否画彩虹渐变（只有色相）。 */
  rainbow: boolean;
  /** false = 只改草稿、不下发（逐光区亮度要等 #69 的 v4 编解码）。 */
  sends: boolean;
  /** 不下发时的说明；空串表示正常生效。 */
  note: string;
}

/** 一个选择控件（波形 / 方向）。 */
export interface PanelChoiceView {
  key: PanelChoiceKey;
  label: string;
  options: ReadonlyArray<{ value: number; label: string }>;
  /** 当前选中的 option 值（方向：0 正转 / 1 反转）。 */
  value: number;
}

/** 四个类型按钮的展示态。 */
export interface PanelTypeView {
  type: PanelType;
  name: string;
  selected: boolean;
}

/** 整个参数区的展示态。 */
export interface EffectPanelView {
  type: PanelType;
  types: PanelTypeView[];
  sliders: PanelSliderView[];
  choices: PanelChoiceView[];
  /** 预览色块（拖色相 / 饱和度时的即时反馈）。 */
  colorHex: string;
  /** 一行摘要（「呼吸 · 2 秒 · 最暗 40% · 正弦」）。 */
  summary: string;
}

/**
 * 逐光区亮度暂不生效的说明。
 *
 * #69 接通 v4 编解码后这一行与 `PanelSliderView.sends === false` 一起删除。
 */
export const LEVEL_PENDING_NOTE = "亮度会在固件更新后生效";

/** 四个类型按钮（等宽一排）。 */
export function buildTypeViews(current: PanelType): PanelTypeView[] {
  return PANEL_TYPE_OPTIONS.map((option) => ({
    type: option.type,
    name: option.name,
    selected: option.type === current,
  }));
}

/** 方向选项：正转 / 反转。 */
const DIRECTION_OPTIONS: ReadonlyArray<{ value: number; label: string }> = [
  { value: 0, label: "正转" },
  { value: 1, label: "反转" },
];

/** 波形选项（「正弦 / 三角 / 锯齿 / 方波」）。 */
const WAVEFORM_CHOICE_OPTIONS = WAVEFORM_OPTIONS.map((option) => ({
  value: option.value,
  name: option.name,
  label: option.name,
}));

/** 秒的显示：2 / 2.5（不留 2.000 这种噪声）。 */
function secondsText(ms: number): string {
  const seconds = Number((ms / 1000).toFixed(1));
  return `${seconds} 秒`;
}

/** 0-255 → 滑块的百分比。 */
function p5Percent(value: number): number {
  return Math.round((clampByte(value) / 255) * 100);
}

/** 滑块的百分比 → 0-255（与 `p5Percent` 互逆到 ±1）。 */
export function p5FromPercent(percent: number): number {
  const value = Number.isFinite(percent) ? Math.max(0, Math.min(100, percent)) : 0;
  return Math.round((value / 100) * 255);
}

/** 一个滑块的位置与读数（按 key 与草稿换算）。 */
export function sliderView(key: PanelSliderKey, params: EffectParams): PanelSliderView {
  switch (key) {
    case "hue": {
      const degrees = hueDegreesOf(params.hue);
      return {
        key,
        label: "色相",
        value: degrees,
        min: 0,
        max: 360,
        step: 1,
        display: `${degrees}°`,
        rainbow: true,
        sends: true,
        note: "",
      };
    }
    case "sat": {
      const percent = satPercentOf(params.sat);
      return {
        key,
        label: "饱和度",
        value: percent,
        min: PERCENT_MIN,
        max: PERCENT_MAX,
        step: PERCENT_STEP,
        display: `${percent}%`,
        rainbow: false,
        sends: true,
        note: "",
      };
    }
    case "level": {
      const level = clampLevel(params.level);
      return {
        key,
        label: "亮度",
        value: level,
        min: LEVEL_MIN,
        max: LEVEL_MAX,
        step: 1,
        display: `${level}%`,
        rainbow: false,
        sends: false,
        note: LEVEL_PENDING_NOTE,
      };
    }
    case "period": {
      const ms = clampPeriodMs(params.periodMs);
      const value = Math.max(PERIOD_MIN_MS, ms) / 1000;
      return {
        key,
        label: "周期",
        value,
        min: PERIOD_MIN_MS / 1000,
        max: PERIOD_MAX_MS / 1000,
        step: PERIOD_STEP_MS / 1000,
        display: secondsText(Math.max(PERIOD_MIN_MS, ms)),
        rainbow: false,
        sends: true,
        note: "",
      };
    }
    case "minLevel": {
      const percent = p5Percent(params.minLevel);
      return {
        key,
        label: "最低亮",
        value: percent,
        min: PERCENT_MIN,
        max: PERCENT_MAX,
        step: PERCENT_STEP,
        display: `${percent}%`,
        rainbow: false,
        sends: true,
        note: "",
      };
    }
    case "span": {
      const percent = p5Percent(params.span);
      return {
        key,
        label: "跨度",
        value: percent,
        min: PERCENT_MIN,
        max: PERCENT_MAX,
        step: PERCENT_STEP,
        display: spanText(clampByte(params.span)),
        rainbow: false,
        sends: true,
        note: "",
      };
    }
    default: {
      const percent = p5Percent(params.tail);
      return {
        key: "tail",
        label: "尾长",
        value: percent,
        min: PERCENT_MIN,
        max: PERCENT_MAX,
        step: PERCENT_STEP,
        display: tailText(clampByte(params.tail)),
        rainbow: false,
        sends: true,
        note: "",
      };
    }
  }
}

/** 一个选择控件的展示态。 */
function choiceView(key: PanelChoiceKey, params: EffectParams): PanelChoiceView {
  if (key === "waveform") {
    return {
      key,
      label: "波形",
      options: WAVEFORM_CHOICE_OPTIONS,
      value: clampWaveform(params.waveform),
    };
  }
  return {
    key,
    label: "方向",
    options: DIRECTION_OPTIONS,
    value: params.reverse ? 1 : 0,
  };
}

/** 一行摘要（给面板右上角与底部反馈用）。 */
export function panelSummary(type: PanelType, params: EffectParams): string {
  const parts: string[] = [PANEL_TYPE_OPTIONS.find((o) => o.type === type)?.name ?? "静态"];
  if (type === "static") {
    parts.push(`${hueDegreesOf(params.hue)}°`, satPercentOf(params.sat) + "%");
    return parts.join(" · ");
  }
  parts.push(secondsText(Math.max(PERIOD_MIN_MS, clampPeriodMs(params.periodMs))));
  if (type === "breathing") {
    parts.push(
      `最暗 ${percentOf255(clampByte(params.minLevel))}`,
      WAVEFORM_NAMES[clampWaveform(params.waveform)] ?? "正弦",
    );
  } else if (type === "rainbow") {
    parts.push(spanText(clampByte(params.span)), params.reverse ? "反转" : "正转");
  } else {
    parts.push(tailText(clampByte(params.tail)), params.reverse ? "反转" : "正转");
  }
  return parts.join(" · ");
}

/**
 * 类型 + 草稿 → 整个参数区。
 *
 * 参数区「整体替换」就是这里：滑块列表完全由 `SLIDER_KEYS[type]` 决定，
 * 页面不做任何按类型的条件渲染。
 */
export function buildEffectPanel(type: PanelType, params: EffectParams): EffectPanelView {
  const normalized = normalizeParams(params);
  return {
    type,
    types: buildTypeViews(type),
    sliders: SLIDER_KEYS[type].map((key) => sliderView(key, normalized)),
    choices: CHOICE_KEYS[type].map((key) => choiceView(key, normalized)),
    colorHex: rgbToHex(segmentHueSatToRgb(normalized.hue, normalized.sat)),
    summary: panelSummary(type, normalized),
  };
}

/* ---------------- 交互：切换类型 / 改一个参数 ---------------- */

/**
 * 切换效果类型：**保留颜色与亮度**，其余参数回到新类型的默认值。
 *
 * 与 `effect-view.applyLayerType` 同一套规则（保留颜色、清掉新类型用不到的
 * 标志位、周期抬到该类型的下限），差别只在「其余参数取新类型默认值」而不是
 * 沿用旧值——把彩虹的跨度直接当成流光的尾长，用户看到的是没调过的怪东西。
 *
 * 类型没变时返回同一个对象（引用相等 = 什么都没变，调用方据此不刷新）。
 */
export function switchPanelType(
  params: EffectParams,
  from: PanelType,
  to: PanelType,
): EffectParams {
  if (from === to) {
    return params;
  }
  const current = normalizeParams(params);
  const base = defaultParams(to);
  return {
    ...base,
    /* 颜色与亮度跨类型保留（用户已经挑好的东西，不该因为换效果丢掉）。 */
    hue: current.hue,
    sat: current.sat,
    level: current.level,
    /* 呼吸 / 彩虹 / 流光的周期抬到协议下限之上（与 applyLayerType 一致）。 */
    periodMs:
      to === "static"
        ? 0
        : Math.max(base.periodMs, to === "breathing" ? BREATHING_MIN_PERIOD_MS : ANIMATION_MIN_PERIOD_MS),
  };
}

/**
 * 改一个滑块：滑块刻度 → 草稿。
 *
 * 拖动中（`bindchanging`）与松手（`bindchange`）都走这里，区别只由页面决定
 * （拖动中不写设备，松手记一次提交）。
 */
export function applySlider(
  params: EffectParams,
  key: PanelSliderKey,
  value: number,
): EffectParams {
  const next = clampSliderValue(key, value);
  switch (key) {
    case "hue":
      return { ...params, hue: hueFromDegrees(next) };
    case "sat":
      return { ...params, sat: satFromPercent(next) };
    case "level":
      return { ...params, level: clampLevel(next) };
    case "period":
      /* 滑块给的是秒；0.5 秒以下一律当成下限，绝不留 0（0 = 静止）。 */
      return { ...params, periodMs: clampPeriodMs(next * 1000) || PERIOD_MIN_MS };
    case "minLevel":
      return { ...params, minLevel: p5FromPercent(next) };
    case "span":
      return { ...params, span: p5FromPercent(next) };
    default:
      return { ...params, tail: p5FromPercent(next) };
  }
}

/** 把滑块值钳到该 key 自己的区间（越界 / 非有限值）。 */
export function clampSliderValue(key: PanelSliderKey, value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  switch (key) {
    case "hue":
      return Math.max(0, Math.min(360, value));
    case "level":
      return clampLevel(value);
    case "period":
      return Math.max(PERIOD_MIN_MS / 1000, Math.min(PERIOD_MAX_MS / 1000, value));
    default:
      return Math.max(PERCENT_MIN, Math.min(PERCENT_MAX, value));
  }
}

/** 改一个选择控件（波形 / 方向）。 */
export function applyChoice(
  params: EffectParams,
  key: PanelChoiceKey,
  value: number,
): EffectParams {
  if (key === "waveform") {
    return { ...params, waveform: clampWaveform(value) };
  }
  return { ...params, reverse: Number(value) === 1 };
}

/* ---------------- 草稿 ↔ 协议层 ---------------- */

/**
 * 草稿 + 类型 → 协议层（`EffectLayer`）。
 *
 * **这是 `level` 唯一的集成点。** `EffectLayer` 还没有 `level` 字段（#69），所以
 * 这里只写 v3 的六个字段：亮度值留在 `EffectParams.level` 里，不会被编成帧，
 * 也不会让设备因为「多出来一个字节 / 未知字段」回 `InvalidParam`。
 * #69 把 `EffectLayer` 扩到九字节后，在返回对象上补 `level: clampLevel(params.level)` 即可。
 */
export function panelLayer(type: PanelType, params: EffectParams): EffectLayer {
  const normalized = normalizeParams(params);
  const hue = normalized.hue;
  const sat = normalized.sat;
  switch (type) {
    case "breathing":
      return {
        type: SEGMENT_TYPE.BREATHING,
        hue,
        sat,
        periodMs: Math.max(clampPeriodMs(normalized.periodMs) || PERIOD_MIN_MS, BREATHING_MIN_PERIOD_MS),
        p5: clampByte(normalized.minLevel),
        /* 呼吸只有波形位（bit1-2）；bit0 是保留位，必须为 0。 */
        flags: breathingFlags(clampWaveform(normalized.waveform)),
      };
    case "rainbow":
      return {
        type: SEGMENT_TYPE.RAINBOW,
        hue,
        sat,
        periodMs: Math.max(clampPeriodMs(normalized.periodMs) || PERIOD_MIN_MS, ANIMATION_MIN_PERIOD_MS),
        p5: clampByte(normalized.span),
        flags: directionFlags(normalized.reverse),
      };
    case "comet":
      return {
        type: SEGMENT_TYPE.COMET,
        hue,
        sat,
        periodMs: Math.max(clampPeriodMs(normalized.periodMs) || PERIOD_MIN_MS, ANIMATION_MIN_PERIOD_MS),
        p5: clampByte(normalized.tail),
        flags: directionFlags(normalized.reverse),
      };
    default:
      /* 静态层：period / p5 / flags 必须为 0（协议硬约束）。 */
      return { type: SEGMENT_TYPE.STATIC, hue, sat, periodMs: 0, p5: 0, flags: 0 };
  }
}

/**
 * 设备读回的层 → 面板草稿。
 *
 * 只取该类型真正用的字段；周期为 0（静止）时退回该类型的默认周期，避免面板上
 * 出现一个「0 秒」的滑块位置。
 */
export function paramsFromLayer(type: PanelType, layer: EffectLayer): EffectParams {
  const base = defaultParams(type);
  const period = clampPeriodMs(layer.periodMs);
  switch (type) {
    case "breathing":
      return {
        ...base,
        hue: clampHue(layer.hue),
        sat: clampByte(layer.sat),
        periodMs: period === 0 ? base.periodMs : period,
        minLevel: clampByte(layer.p5),
        waveform: breathingWaveform(layer.flags),
        reverse: false,
      };
    case "rainbow":
      return {
        ...base,
        hue: clampHue(layer.hue),
        sat: clampByte(layer.sat),
        periodMs: period === 0 ? base.periodMs : period,
        span: clampByte(layer.p5),
        reverse: (layer.flags & 0x01) !== 0,
      };
    case "comet":
      return {
        ...base,
        hue: clampHue(layer.hue),
        sat: clampByte(layer.sat),
        periodMs: period === 0 ? base.periodMs : period,
        tail: clampByte(layer.p5),
        reverse: (layer.flags & 0x01) !== 0,
      };
    default:
      return { ...base, hue: clampHue(layer.hue), sat: clampByte(layer.sat) };
  }
}

/**
 * 把一个光区的 `layer0` 换成面板的效果（其余字段一字不动）。
 *
 * 装配走 `buildZoneSpec`：叠加层为空时叠加方式归一为覆盖、两层定宽、深拷贝——
 * 「面板只改颜色 / 效果，不该顺手把叠加层弄丢」。
 */
export function applyPanelToZone(
  zones: readonly SegmentSpec[],
  segId: number,
  type: PanelType,
  params: EffectParams,
): SegmentSpec[] {
  return zones.map((zone) =>
    zone.segId === segId
      ? buildZoneSpec({
          stripId: zone.stripId,
          segId: zone.segId,
          start: zone.start,
          end: zone.end,
          blend: zone.blend,
          layer0: panelLayer(type, params),
          layer1: zone.layer1,
        })
      : zone,
  );
}

/* ---------------- 界面必须告知的两条事实 ---------------- */

/**
 * 「方案内容只存在本机」。
 *
 * v3 的查询只回 4 字节摘要（步骤数 / 是否启用 / 是否循环），步骤时长与光区
 * 内容都读不回来。用户以为能「从灯控把方案拉回来改」是最容易踩的误解。
 */
export const PANEL_LOCAL_ONLY_NOTE =
  "方案内容只存在这台手机上：灯控只回「有几个步骤、是否启用」，内容读不回来。";

/** 第二条事实：换机 / 清缓存后要重新编排。 */
export const PANEL_REBUILD_NOTE = "换手机或清缓存后需要重新编排。";

/** 两条事实（界面按行渲染，避免挤成一段）。 */
export const PANEL_FACTS: readonly string[] = [PANEL_LOCAL_ONLY_NOTE, PANEL_REBUILD_NOTE];

/** 方案为空时的引导（不是一片空白）。 */
export const PANEL_EMPTY_PLAN_GUIDE =
  "这套方案还是空的：先在「光区」里点「+ 新增」划出灯珠区间，再回来选效果。";

/** 当前步骤还没有光区时的引导。 */
export const PANEL_EMPTY_STEP_GUIDE =
  "这一步还没有光区：在「光区」里点「+ 新增」划出第一片灯珠区间。";

/** 有光区但没选中任何一块时的引导。 */
export const PANEL_NO_ZONE_GUIDE = "先在上面「光区」轴里点一块，再调它的效果。";

/** 色相滑轨的彩虹渐变（hsl 不是 hex，不触发「wxss 不写死颜色」的规则）。 */
export const HUE_RAMP_GRADIENT =
  "linear-gradient(90deg, hsl(0, 100%, 50%), hsl(60, 100%, 50%), hsl(120, 100%, 50%), " +
  "hsl(180, 100%, 50%), hsl(240, 100%, 50%), hsl(300, 100%, 50%), hsl(360, 100%, 50%))";

/** 某个类型在协议里的枚举值（页面构造测试断言时用）。 */
export function panelTypeValue(type: PanelType): number {
  return TYPE_VALUE[type];
}
