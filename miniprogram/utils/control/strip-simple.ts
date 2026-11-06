/**
 * 灯组页「简单档」的纯派生。
 *
 * 简单档只做一件事：**让整条灯组变成一个灯效**。所以这里的函数全部是
 * 「设备 → 界面」的换算，不碰 wx、不碰 BLE，可直接单测：
 *
 *  1. HSV 滑块的取值范围（亮度是协议 v4 的 `level`，**真实下发**）；
 *  2. 设备读回值 → 「整组是什么灯效、参数是多少」。
 *
 * ## 为什么不再有「九张成品卡」
 *
 * 早期简单档是九张色卡（暖白常亮 / 冷蓝氛围 / 紫色氛围 / 爆闪白 / 心跳暖红…），
 * 进阶档另有一套按类型展开的参数面板。两套模型并行造成两个问题：
 *
 *  - **配置项不一致**：简单档只有三个滑块，进阶档能调周期 / 尾巴 / 方向 /
 *    波形 / 占空比。用户在简单档看不到的东西，进进阶档突然冒出来。
 *  - **卡片本质是「预设颜色」**，而颜色已经由色相 / 饱和度滑块表达。同一件事
 *    有两个入口，改一个还会覆盖另一个。
 *
 * 现在两边共用 `effect-panel` 的参数模型（`SLIDER_KEYS` / `CHOICE_KEYS` 是唯一
 * 真相）：简单档 = 一个灯效 + 它的全部配置项，作用于整条灯组。
 */

import { NO_EFFECT } from "../protocol/constants";
import type { EffectLayer, SegmentReport } from "../protocol/types";
import { rgbToHex, segmentHueSatToRgb } from "../color/hsv";
import {
  buildEffectPanel,
  defaultParams,
  paramsFromLayer,
  type EffectParams,
  type PanelChoiceView,
  type PanelSliderView,
  type PanelType,
} from "./effect-panel";
import {
  effectIdOfPanelType,
  panelTypeOfEffect,
  simpleEffectIdOfType,
  simpleEffectOf,
} from "./simple-effects";

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

/* ---------------- 设备读回 → 当前灯效 ---------------- */

/** 设备上「整组就是这一个灯效」时的状态。 */
export interface SimpleDeviceState {
  /** 八个灯效的 id（`simple-effects`）。 */
  effectId: string;
  /** 参数面板的类型（由 `effectId` 反查，两者一一对应）。 */
  panelType: PanelType;
  /** 该灯效的完整参数（含设备上的精确 hue / sat / level）。 */
  params: EffectParams;
  colorHex: string;
}

/**
 * 判断设备上的这一组是否「整组 = 一个灯效」，并把它读成完整参数。
 *
 * 只有同时满足才敢回填界面（否则界面会高亮一个设备上并不存在的效果）：
 *  1. 只有一个分区；
 *  2. 它从 0 覆盖到最后一颗灯珠；
 *  3. 没有叠加层（`layer1.type === NO_EFFECT`）；
 *  4. 层类型能反推出某个灯效（`simpleEffectIdOfType`）。
 *
 * 不满足返回 null，界面显示「空」。
 *
 * **参数直接由 `paramsFromLayer` 还原**：协议里七种灯效的全部参数都在层编码
 * 里（hue / sat / p5 / period / flags / level），所以周期、尾巴、方向、波形、
 * 占空比、密度都能完整读回来——这正是退役成品卡之后「读回即真相」的依据。
 * 成品卡时代只能反推颜色与亮度，其余档位读不回来。
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
  const effectId = simpleEffectIdOfType(only.layer0.type);
  if (effectId === null) {
    return null;
  }
  const panelType = panelTypeOfEffect(effectId);
  if (panelType === null) {
    return null;
  }
  const type = panelType as PanelType;
  const params = paramsFromLayer(type, only.layer0);
  return {
    effectId,
    panelType: type,
    params,
    /* 「空」的预览一定是黑；按 0/0 色算会得到白，界面会误导成「点亮」。 */
    colorHex: colorHexOf(type, params),
  };
}

/** 当前参数的预览色（「空」恒为黑）。 */
export function colorHexOf(type: PanelType, params: EffectParams): string {
  if (type === "off") {
    return "#000000";
  }
  return rgbToHex(segmentHueSatToRgb(params.hue, params.sat));
}

/**
 * 一层协议数据 → 简单档的界面状态（读回时用）。
 *
 * 与 `inferSimpleState` 的区别：这个不管「是否覆盖整组」，只把一层读成参数。
 * 进阶档的叠加层读回也用它。
 */
export function simpleStateOfLayer(
  layer: EffectLayer,
  ledCount: number,
): SimpleDeviceState | null {
  return inferSimpleState(
    [
      {
        stripId: 0,
        segId: 0,
        start: 0,
        end: Math.max(0, ledCount - 1),
        blend: 0,
        layer0: layer,
        layer1: { type: NO_EFFECT, hue: 0, sat: 0, periodMs: 0, p5: 0, flags: 0, level: 0 },
      } as SegmentReport,
    ],
    ledCount,
  );
}

/** 灯效 id → 面板类型（未知返回 null）。 */
export function panelTypeForEffectId(effectId: string | null): PanelType | null {
  if (effectId === null) {
    return null;
  }
  const type = panelTypeOfEffect(effectId);
  return type === null ? null : (type as PanelType);
}

/** 面板类型 → 灯效 id（未知返回 null）。 */
export function effectIdForPanelType(type: PanelType): string | null {
  return effectIdOfPanelType(type);
}

/** 面板类型 → 界面上显示的名字（「空」「常亮」…）。 */
export function effectNameOfPanelType(type: PanelType): string {
  const effectId = effectIdOfPanelType(type);
  return effectId === null ? "空" : simpleEffectName(effectId);
}

/** 熄灭（空）的说明：它不是「关掉这组」。 */
export const OFF_CARD_NOTICE = "整组保持黑色；这条灯组本身仍然开着。";

/** 当前灯效的名称（`null` → 「空」）。 */
export function simpleEffectName(effectId: string | null): string {
  if (effectId === null) {
    return "空";
  }
  return simpleEffectOf(effectId)?.name ?? "空";
}

/* ---------------- 参数区视图 ---------------- */

/**
 * 简单档的参数区：滑块 + 选择项 + 预览色。
 *
 * 与进阶档两张卡**完全同源**：滑块列表来自 `SLIDER_KEYS`、选择项来自
 * `CHOICE_KEYS`，所以「呼吸有波形、流星有方向、爆闪有占空比」两边一模一样。
 * 差别只有作用范围（整条灯组 vs 某个分区）。
 */
export interface SimpleParamView {
  /** 面板类型（`effect-panel` 的 `PanelType`）。 */
  type: PanelType;
  /** 灯效名（「常亮」「流星」…）。 */
  name: string;
  /** 参数区标题（「常亮的参数」；没有可调项时只写名字）。 */
  title: string;
  /** 当前颜色的预览色（滑块的实时反馈）。 */
  colorHex: string;
  sliders: PanelSliderView[];
  choices: PanelChoiceView[];
  /** 没有滑块时的说明（「空」：整组黑掉但灯组仍开着）；空串表示不显示。 */
  notice: string;
}

/**
 * 类型 + 草稿 → 参数区。
 *
 * 「只显示该类型支持的控件」由 `SLIDER_KEYS` / `CHOICE_KEYS` 决定——页面不做
 * 任何按类型的条件渲染，所以简单档与进阶档不可能漂成两套。
 */
export function buildSimpleParams(
  type: PanelType,
  params: Partial<EffectParams>,
): SimpleParamView {
  const merged = { ...defaultParams(type), ...params };
  const panel = buildEffectPanel(type, merged);
  const name = effectNameOfPanelType(type);
  const hasControls = panel.sliders.length > 0 || panel.choices.length > 0;
  return {
    type,
    name,
    title: hasControls ? `${name}的参数` : name,
    colorHex: panel.colorHex,
    sliders: panel.sliders,
    choices: panel.choices,
    notice: type === "off" ? OFF_CARD_NOTICE : "",
  };
}

/**
 * 切到某个灯效时亮度草稿的去向。
 *
 * 熄灭（空）读回的 `level` 恒为 0（协议要求）；把 0 原样带到下一张会发光的
 * 灯效上，用户点「常亮」也依然全黑——看起来像坏了。所以熄灭按默认满亮处理，
 * 其余以设备值（或用户刚拖的值）为准。
 */
export function levelDraftFromEffect(
  type: PanelType,
  deviceLevel: number,
  previous: number,
): number {
  if (type === "off") {
    return clampLevel(previous);
  }
  return clampZoneLevel(deviceLevel);
}
