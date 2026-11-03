/**
 * 快捷灯效（应用里的「快捷」档）：成品效果卡片 + 参数档位。
 *
 * ## 设计意图
 *
 * 用户点的是**结果**，不是协议类型：卡片写「呼吸」「彩虹流动」，不写
 * `SEGMENT_TYPE.BREATHING`。所有参数以人话档位暴露（慢/中/快、微亮/中暗/全暗），
 * 毫秒与 0-255 只属于「自定义」档。
 *
 * 本模块只做两件事：
 *  1. 定义有哪些卡片、每张卡片允许调哪些参数；
 *  2. 把「档位」翻译成协议值（`EffectLayer`）。
 *
 * 不碰 wx / BLE，可直接单测。真正下发由页面调 `session.setSegment`。
 *
 * ## 九张卡（#81）
 *
 * 前三张原型（常亮 / 呼吸 / 彩虹 / 流光）+ 两张换色，再各加一张
 * 爆闪白 / 心跳暖红 / 熄灭黑。新增三张**没有可调档位**：票面要的是一键成品，
 * 参数固定在该效果的中间档（中等频率 / 中等占空比 / 60 BPM）。
 *
 * 编码不在这里另写一套：爆闪与心跳复用 `protocol/commands` 的校验入口
 * （`cmdSetSegment` 会拒绝非法周期 / 占空比），卡片只给出协议值。数值与
 * 进阶档面板的默认档（4Hz / 中占空比 / 60 BPM）由单测锁死一致。
 */

import {
  BLEND,
  LAYER_LEVEL_MAX,
  MAX_LEDS,
  SEGMENT_TYPE,
  WAVEFORM,
} from "../protocol/constants";
import type { EffectLayer, SegmentSpec } from "../protocol/types";
import { breathingFlags, directionFlags } from "../protocol/commands";
import { rgbToHex, rgbToSegmentParams, segmentHueSatToRgb, PRESETS, type ColorPreset } from "../color/hsv";
import { buildZoneSpec } from "./zone-model";

/** 卡片对应的灯效类型（与协议 SEGMENT_TYPE 一一对应，`solid` 即静态）。 */
export type QuickKind =
  | "solid"
  | "breathing"
  | "rainbow"
  | "comet"
  | "strobe"
  | "heartbeat"
  | "off";

/**
 * 简单档的网格列数（#81 从 2 列改 3 列）。
 *
 * 卡片数与列数由单测同时锁住：9 % 3 === 0，最后一行不会只剩一张孤儿卡。
 * `pages/strip/strip.wxss` 的 `.quick-grid` 必须写成同一组数（单测比对）。
 */
export const QUICK_GRID_COLUMNS = 3;

/** 快慢三档（映射到周期，越慢周期越长）。 */
export type QuickSpeed = "slow" | "normal" | "fast";
/** 呼吸最暗档：最亮时的占比。 */
export type QuickLevel = "dim" | "mid" | "dark";
/** 流光尾长三档。 */
export type QuickTail = "short" | "mid" | "long";
/** 方向。 */
export type QuickDirection = "forward" | "reverse";

/** 一张成品效果卡。 */
export interface QuickEffectCard {
  id: string;
  /** 卡片标题（用户看到的就是这个）。 */
  name: string;
  /** 一行说明，卡片副标题。 */
  hint: string;
  kind: QuickKind;
  /** 默认色（hue 0-65535 / sat 0-255）。 */
  hue: number;
  sat: number;
  /** 默认周期与参数。 */
  periodMs: number;
  p5: number;
  /** 该卡片在详参数区显示哪些控件。 */
  shows: {
    color: boolean;
    speed: boolean;
    level: boolean;
    tail: boolean;
    direction: boolean;
    /** 彩虹专属：饱和度（0-100）。 */
    saturation: boolean;
  };
}

/** 周期档（毫秒）。0 表示「静止」。 */
const SPEED_MS: Record<QuickSpeed, { breathing: number; animation: number }> = {
  slow: { breathing: 4000, animation: 6000 },
  normal: { breathing: 2000, animation: 3000 },
  fast: { breathing: 800, animation: 1000 },
};

/**
 * 呼吸最暗档 → min_level **百分比**（0-100，越大越暗）。
 *
 * v4 起呼吸的 p5 是相对百分比（谷底 = 层亮度 × p5%），不再是绝对 0-255；
 * 101-255 会被设备拒绝。三档沿用原来的「越大越暗」直觉（16/47/82 是旧
 * 40/120/210 换算成百分比后的近似值）。
 */
const LEVEL_P5: Record<QuickLevel, number> = {
  dim: 16,
  mid: 47,
  dark: 82,
};

/** 流光尾长档 → tail（0-255）。 */
const TAIL_P5: Record<QuickTail, number> = {
  short: 40,
  mid: 120,
  long: 220,
};

/*
 * 爆闪 / 心跳的固定档（#81 的卡片没有旋钮，参数就是这三个中间值）。
 *
 * 数值必须与进阶档面板的默认档一致（4Hz / 中占空比 / 60 BPM）；
 * `effect-panel` 反过来依赖本模块（经 `strip-simple`），所以这里**不能**
 * 从它 import——一致性由 `tests/quick-effects.test.ts` 断言两边换算结果相等。
 */
const STROBE_HZ = 4;
/** 中档占空比（effects-spec §2.5 的 90 ≈ 35%）。 */
const STROBE_DUTY = 90;
const STROBE_PERIOD_MS = Math.round(1000 / STROBE_HZ);
const HEARTBEAT_BPM = 60;
const HEARTBEAT_PERIOD_MS = Math.round(60000 / HEARTBEAT_BPM);
/** 心跳脉冲宽度（协议 p5）：与面板同样固定为中等。 */
const HEARTBEAT_PULSE = 60;
/** 心跳默认开双脉冲（flags bit0）。 */
const HEARTBEAT_FLAGS = 0x01;

/**
 * 九张成品卡（#81）：前 4 张是灯效原型、接着 2 张换色，最后 3 张是
 * #74 新增的爆闪 / 心跳 / 熄灭。原来的 6 张**顺序与参数都不动**。
 */
export const QUICK_CARDS: readonly QuickEffectCard[] = [
  {
    id: "warm",
    name: "暖白常亮",
    hint: "整组常亮，最省电",
    kind: "solid",
    hue: 7281,
    sat: 255,
    periodMs: 0,
    p5: 0,
    shows: { color: true, speed: false, level: false, tail: false, direction: false, saturation: false },
  },
  {
    id: "breathe",
    name: "呼吸",
    hint: "缓亮缓暗，像在呼吸",
    kind: "breathing",
    hue: 7281,
    sat: 255,
    periodMs: 2000,
    p5: LEVEL_P5.mid,
    shows: { color: true, speed: true, level: true, tail: false, direction: false, saturation: false },
  },
  {
    id: "rainbow",
    name: "彩虹流动",
    hint: "整组循环变色",
    kind: "rainbow",
    hue: 0,
    sat: 255,
    periodMs: 3000,
    p5: 255,
    shows: { color: false, speed: true, level: false, tail: false, direction: true, saturation: true },
  },
  {
    id: "comet",
    name: "流光追逐",
    hint: "亮点沿灯组跑动",
    kind: "comet",
    hue: 43690,
    sat: 255,
    periodMs: 2000,
    p5: TAIL_P5.mid,
    shows: { color: true, speed: true, level: false, tail: true, direction: true, saturation: false },
  },
  {
    id: "ice",
    name: "冷蓝氛围",
    hint: "低饱和冷色，适合夜景",
    kind: "solid",
    hue: 36409,
    sat: 200,
    periodMs: 0,
    p5: 0,
    shows: { color: true, speed: false, level: false, tail: false, direction: false, saturation: false },
  },
  {
    id: "violet",
    name: "紫色氛围",
    hint: "紫色柔光，适合卧室",
    kind: "solid",
    hue: 50000,
    sat: 220,
    periodMs: 0,
    p5: 0,
    shows: { color: true, speed: false, level: false, tail: false, direction: false, saturation: false },
  },
  {
    /* #81：白色爆闪。sat = 0 在固件里就是中性白（V 恒为 1），hue 无意义。 */
    id: "strobe",
    name: "爆闪白",
    hint: "高频闪白，够醒目",
    kind: "strobe",
    hue: 0,
    sat: 0,
    periodMs: STROBE_PERIOD_MS,
    p5: STROBE_DUTY,
    shows: { color: false, speed: false, level: false, tail: false, direction: false, saturation: false },
  },
  {
    /* #81：暖红心跳。hue 略偏橙（≈9°）才是「暖」红，纯红（hue 0）显冷。 */
    id: "heartbeat",
    name: "心跳暖红",
    hint: "像心跳一样一明一暗",
    kind: "heartbeat",
    hue: 1600,
    sat: 245,
    periodMs: HEARTBEAT_PERIOD_MS,
    p5: HEARTBEAT_PULSE,
    shows: { color: false, speed: false, level: false, tail: false, direction: false, saturation: false },
  },
  {
    /*
     * #81：整组熄灭。它是一条**分区**（主效果 OFF），不是关掉这条灯组的开关：
     * 灯组自身仍然开着（不碰 strip power），所以别的分区或别的灯组照常工作。
     */
    id: "off",
    name: "熄灭黑",
    hint: "整组黑，灯组仍开着",
    kind: "off",
    hue: 0,
    sat: 0,
    periodMs: 0,
    p5: 0,
    shows: { color: false, speed: false, level: false, tail: false, direction: false, saturation: false },
  },
];

export function quickCardOf(id: string): QuickEffectCard | null {
  return QUICK_CARDS.find((card) => card.id === id) ?? null;
}

/** 用户可调的参数（未给的一律取卡片默认）。 */
export interface QuickParams {
  /** 色相覆盖（0-65535）；不传用卡片默认。 */
  hue?: number;
  /** 饱和度覆盖（0-255）；彩虹卡的「饱和度」滑杆也写这里。 */
  sat?: number;
  speed?: QuickSpeed;
  level?: QuickLevel;
  tail?: QuickTail;
  direction?: QuickDirection;
}

/** 卡片 + 参数 → 卡片默认参数（用于首次进入时的档位回显）。 */
export function defaultParams(card: QuickEffectCard): Required<QuickParams> {
  return {
    hue: card.hue,
    sat: card.sat,
    speed: "normal",
    level: "mid",
    tail: "mid",
    direction: "forward",
  };
}

/**
 * 卡片 + 参数 → 一层灯效（协议形状）。
 *
 * 静态卡片的 period / p5 / flags 必须为 0（§7.1 第 6 条），这里保证；
 * 呼吸的 flags 只写波形位，彩虹/流光的 flags 只写方向位。
 *
 * `level` 是 v4 的逐分区亮度（0-100）；省略时为满亮 100（等价 v3 行为）。
 * 它由灯组页的亮度滑块给出，与卡片自己的「最暗」档（`QuickParams.level`）无关。
 */
export function buildQuickLayer(
  card: QuickEffectCard,
  params: QuickParams = {},
  level: number = LAYER_LEVEL_MAX,
): EffectLayer {
  const p = { ...defaultParams(card), ...params };
  const hue = clampUint16(p.hue);
  const sat = clampByte(p.sat);
  const zoneLevel = clampLevel100(level);

  switch (card.kind) {
    case "solid":
      return { type: SEGMENT_TYPE.STATIC, hue, sat, periodMs: 0, p5: 0, flags: 0, level: zoneLevel };
    case "breathing":
      return {
        type: SEGMENT_TYPE.BREATHING,
        hue,
        sat,
        periodMs: SPEED_MS[p.speed].breathing,
        p5: LEVEL_P5[p.level],
        flags: breathingFlags(WAVEFORM.SINE),
        level: zoneLevel,
      };
    case "rainbow":
      return {
        type: SEGMENT_TYPE.RAINBOW,
        hue,
        sat,
        periodMs: SPEED_MS[p.speed].animation,
        /* 彩虹的 span 固定铺满整圈，用户真正关心的是快慢与饱和度。 */
        p5: 255,
        flags: directionFlags(p.direction === "reverse"),
        level: zoneLevel,
      };
    case "comet":
      return {
        type: SEGMENT_TYPE.COMET,
        hue,
        sat,
        periodMs: SPEED_MS[p.speed].animation,
        p5: TAIL_P5[p.tail],
        flags: directionFlags(p.direction === "reverse"),
        level: zoneLevel,
      };
    case "strobe":
      /*
       * 爆闪（#74 / #81）：参数固定为卡片默认值（中等频率 + 中等占空比）。
       * flags 必须为 0；周期下限 100ms 由卡片默认值满足（250ms）。
       */
      return {
        type: SEGMENT_TYPE.STROBE,
        hue,
        sat,
        periodMs: STROBE_PERIOD_MS,
        p5: STROBE_DUTY,
        flags: 0,
        level: zoneLevel,
      };
    case "heartbeat":
      /*
       * 心跳（#74 / #81）：60 BPM（1000ms），双脉冲，脉冲宽度中等。
       * 周期必须落在 500-1500ms，卡片默认值正好在中间。
       */
      return {
        type: SEGMENT_TYPE.HEARTBEAT,
        hue,
        sat,
        periodMs: HEARTBEAT_PERIOD_MS,
        p5: HEARTBEAT_PULSE,
        flags: HEARTBEAT_FLAGS,
        level: zoneLevel,
      };
    case "off":
      /*
       * 熄灭（#74 / #81）：参数块与 level 全 0（协议硬约束：hue / sat /
       * period / p5 / flags 必须全 0）。`level` 也归 0——熄灭不受亮度影响，
       * 留一个非零亮度只会让「读回反推」误判。
       */
      return { type: SEGMENT_TYPE.OFF, hue: 0, sat: 0, periodMs: 0, p5: 0, flags: 0, level: 0 };
    default:
      return { type: SEGMENT_TYPE.STATIC, hue, sat, periodMs: 0, p5: 0, flags: 0, level: zoneLevel };
  }
}

/**
 * 卡片 + 参数 + 灯组 → 一个覆盖整组的分区 spec（单层）。
 *
 * 快捷档的语义就是「整组生效」，所以区间恒为 `0 .. ledCount-1`，
 * 槽位固定 0（整组只有这一个分区），叠加层为空、叠加方式覆盖。
 *
 * 装配委托给 `zone-model.buildZoneSpec`——单层 blend 归一与深拷贝只有一份实现。
 */
export function buildQuickSpec(
  card: QuickEffectCard,
  params: QuickParams,
  stripId: number,
  ledCount: number,
  level: number = LAYER_LEVEL_MAX,
): SegmentSpec {
  const last = Math.max(0, Math.min(ledCount, MAX_LEDS) - 1);
  return buildZoneSpec({
    stripId,
    segId: 0,
    start: 0,
    end: last,
    blend: BLEND.OVER,
    layer0: buildQuickLayer(card, params, level),
    layer1: null,
  });
}

/**
 * 整组的区间（供「快捷档只作用于选中的那组」时校验/展示）。
 *
 * 灯珠数未知（0）时仍返回 0-0：协议不允许负区间，且调用方本就该先等连接。
 */
export function quickRange(ledCount: number): { start: number; end: number } {
  return { start: 0, end: Math.max(0, Math.min(ledCount, MAX_LEDS) - 1) };
}

/**
 * 从设备读回的灯效反推「当前是哪种快捷卡片」。
 *
 * 只按 layer0 的 type + 颜色近似判断（设备不会告诉我们用户当初点了哪张卡）。
 * 用于切换回快捷档时高亮上次的选择；判断不出来返回 null（用户可自选）。
 *
 * #81 起九张卡都能认：爆闪 / 心跳 / 熄灭按层类型唯一对应；静态按「色相 + 饱和度
 * 精确命中某张换色卡」认（warm / ice / violet），改过颜色的静态层退回 warm
 * ——那是静态档的默认卡，且界面会把真实颜色回填，不会假装是别的卡。
 */
export function inferQuickCard(layer: EffectLayer): string | null {
  if (layer.type === SEGMENT_TYPE.STATIC) {
    return inferSolidCard(layer) ?? "warm";
  }
  if (layer.type === SEGMENT_TYPE.BREATHING) {
    return "breathe";
  }
  if (layer.type === SEGMENT_TYPE.RAINBOW) {
    return "rainbow";
  }
  if (layer.type === SEGMENT_TYPE.COMET) {
    return "comet";
  }
  if (layer.type === SEGMENT_TYPE.STROBE) {
    return "strobe";
  }
  if (layer.type === SEGMENT_TYPE.HEARTBEAT) {
    return "heartbeat";
  }
  if (layer.type === SEGMENT_TYPE.OFF) {
    return "off";
  }
  return null;
}

/** 静态层里色相与饱和度都精确命中某张换色卡（warm / ice / violet）时返回它。 */
function inferSolidCard(layer: EffectLayer): string | null {
  const hue = clampUint16(layer.hue);
  const sat = clampByte(layer.sat);
  const hit = QUICK_CARDS.find(
    (card) => card.kind === "solid" && card.hue === hue && card.sat === sat,
  );
  return hit === undefined ? null : hit.id;
}

/**
 * 卡片的预览色块。
 *
 * 熄灭卡给纯黑（它的默认色相 / 饱和度是 0/0，按 HSV 算出来是白，会误导成
 * 「点亮」）；其余卡片按色相 / 饱和度算，选中卡跟随用户改过的颜色。
 */
export function quickColorHex(card: QuickEffectCard, params: QuickParams = {}): string {
  if (card.kind === "off") {
    return "#000000";
  }
  const p = { ...defaultParams(card), ...params };
  return rgbToHex(segmentHueSatToRgb(clampUint16(p.hue), clampByte(p.sat)));
}

/** 档位的中文显示（卡片下方的当前值摘要）。 */
export function paramsSummary(card: QuickEffectCard, params: QuickParams = {}): string {
  const p = { ...defaultParams(card), ...params };
  const parts: string[] = [];
  if (card.shows.speed) {
    parts.push(`快慢 ${p.speed === "slow" ? "慢" : p.speed === "fast" ? "快" : "中"}`);
  }
  if (card.shows.level) {
    parts.push(`最暗 ${p.level === "dim" ? "微亮" : p.level === "dark" ? "全暗" : "中暗"}`);
  }
  if (card.shows.tail) {
    parts.push(`尾长 ${p.tail === "short" ? "短" : p.tail === "long" ? "长" : "中"}`);
  }
  if (card.shows.direction) {
    parts.push(p.direction === "reverse" ? "逆向" : "顺向");
  }
  if (card.shows.saturation) {
    parts.push(`饱和度 ${Math.round((clampByte(p.sat) / 255) * 100)}%`);
  }
  return parts.join(" · ");
}

function clampByte(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value)));
}

/** v4 的层亮度 0-100（非有限值按满亮）。 */
function clampLevel100(value: number): number {
  if (!Number.isFinite(value)) {
    return LAYER_LEVEL_MAX;
  }
  return Math.max(0, Math.min(LAYER_LEVEL_MAX, Math.round(value)));
}

function clampUint16(value: number): number {
  return Math.max(0, Math.min(0xffff, Math.round(value)));
}

/** 三档的展示名（页面渲染档位按钮用）。 */
export const SPEED_OPTIONS: ReadonlyArray<{ value: QuickSpeed; label: string }> = [
  { value: "slow", label: "慢" },
  { value: "normal", label: "中" },
  { value: "fast", label: "快" },
];

export const LEVEL_OPTIONS: ReadonlyArray<{ value: QuickLevel; label: string }> = [
  { value: "dim", label: "微亮" },
  { value: "mid", label: "中暗" },
  { value: "dark", label: "全暗" },
];

export const TAIL_OPTIONS: ReadonlyArray<{ value: QuickTail; label: string }> = [
  { value: "short", label: "短" },
  { value: "mid", label: "中" },
  { value: "long", label: "长" },
];

export const DIRECTION_OPTIONS: ReadonlyArray<{ value: QuickDirection; label: string }> = [
  { value: "forward", label: "顺向" },
  { value: "reverse", label: "逆向" },
];

/**
 * 颜色预设里哪一个与当前参数同色（按 hue+sat 判定，不比 hex 字符串）。
 *
 * 快捷档不给色环：用户要的是「换个颜色」而不是「调色相 0-65535」，
 * 所以用同一套预设色块，选中态由协议值反推（改档位不会让色块误高亮）。
 */
export function quickPresetFlags(
  params: QuickParams = {},
  presets: readonly ColorPreset[] = PRESETS,
): boolean[] {
  const hue = clampUint16(params.hue ?? 0);
  const sat = clampByte(params.sat ?? 0);
  return presets.map((preset) => {
    const converted = rgbToSegmentParams(preset.rgb);
    return converted.hue === hue && converted.sat === sat;
  });
}

/* ---------------- 页面视图派生（#54） ---------------- */

/** 卡片在界面上的样子（WXML 只读这个，不再自己算色）。 */
export interface QuickCardView {
  id: string;
  name: string;
  hint: string;
  /** 卡片预览色块（由卡片默认色相/饱和度算出）。 */
  hex: string;
  /** 当前选中（设备上的效果能反推出是它时也高亮）。 */
  selected: boolean;
}

/** 参数区的一个三档控件。 */
export interface QuickChoiceView {
  key: "speed" | "level" | "tail" | "direction";
  label: string;
  value: string;
  options: ReadonlyArray<{ value: string; label: string; active: boolean }>;
}

/** 选中卡片的完整参数区（只含该卡支持的控件）。 */
export interface QuickPanelView {
  cardId: string;
  cardName: string;
  /** 当前参数摘要（「快慢 中 · 最暗 中暗」）；没有可调项时为空串。 */
  summary: string;
  colorHex: string;
  /** 是否有任何可调参数（常亮卡只显示颜色）。 */
  hasChoices: boolean;
  choices: QuickChoiceView[];
  /** 是否显示颜色预设（彩虹卡自己循环变色，换色没有意义）。 */
  showsColor: boolean;
  /** 彩虹卡的饱和度（0-100）与是否显示滑杆。 */
  saturation: number;
  showsSaturation: boolean;
}

function choiceOf<T extends string>(
  key: QuickChoiceView["key"],
  label: string,
  value: T,
  options: ReadonlyArray<{ value: T; label: string }>,
): QuickChoiceView {
  return {
    key,
    label,
    value,
    options: options.map((option) => ({
      value: option.value,
      label: option.label,
      active: option.value === value,
    })),
  };
}

/**
 * 九张卡的视图：`selectedId` 由页面给出（设备反推或用户点的）。
 *
 * 预览色块按卡片的默认色相/饱和度算；选中卡跟随用户改过的颜色。
 * 彩虹卡默认 hue 为 0 且会自己循环，这里给一个渐变感更强的多色彩块由 wxss
 * 处理，不在数据里拼字符串（`quickColorHex` 只负责静态色）。
 */
export function buildQuickCardViews(
  selectedId: string | null,
  params: QuickParams = {},
): QuickCardView[] {
  return QUICK_CARDS.map((card) => ({
    id: card.id,
    name: card.name,
    hint: card.hint,
    hex: quickColorHex(card, card.id === selectedId ? params : {}),
    selected: card.id === selectedId,
  }));
}

/**
 * 参数区：只有该卡 `shows.*` 为真的控件才出现（票面验收：其余不出现）。
 *
 * 返回 null 表示没有选中卡片（界面显示卡片列表即可）。
 */
export function buildQuickPanel(
  cardId: string | null,
  params: QuickParams = {},
): QuickPanelView | null {
  const card = cardId === null ? null : quickCardOf(cardId);
  if (card === null) {
    return null;
  }
  const p = { ...defaultParams(card), ...params };
  const choices: QuickChoiceView[] = [];
  if (card.shows.speed) {
    choices.push(choiceOf("speed", "快慢", p.speed, SPEED_OPTIONS));
  }
  if (card.shows.level) {
    choices.push(choiceOf("level", "最暗", p.level, LEVEL_OPTIONS));
  }
  if (card.shows.tail) {
    choices.push(choiceOf("tail", "尾长", p.tail, TAIL_OPTIONS));
  }
  if (card.shows.direction) {
    choices.push(choiceOf("direction", "方向", p.direction, DIRECTION_OPTIONS));
  }
  return {
    cardId: card.id,
    cardName: card.name,
    summary: paramsSummary(card, p),
    /* 熄灭卡没有颜色可言：预览块给黑，不能按 0/0 色算成白。 */
    colorHex: quickColorHex(card, p),
    hasChoices: choices.length > 0,
    choices,
    showsColor: card.shows.color,
    saturation: Math.round((clampByte(p.sat) / 255) * 100),
    showsSaturation: card.shows.saturation,
  };
}
