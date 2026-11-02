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
 */

import {
  BLEND,
  NO_EFFECT,
  SEGMENT_TYPE,
  WAVEFORM,
} from "../protocol/constants";
import type { EffectLayer, SegmentSpec } from "../protocol/types";
import { breathingFlags, directionFlags } from "../protocol/commands";

/** 卡片对应的灯效类型。 */
export type QuickKind = "solid" | "breathing" | "rainbow" | "comet";

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

/** 呼吸最暗档 → min_level（0-255，越大越暗）。 */
const LEVEL_P5: Record<QuickLevel, number> = {
  dim: 40,
  mid: 120,
  dark: 210,
};

/** 流光尾长档 → tail（0-255）。 */
const TAIL_P5: Record<QuickTail, number> = {
  short: 40,
  mid: 120,
  long: 220,
};

/** 默认 6 张卡片（前 4 张是四种灯效原型，后 2 张是同效果换色）。 */
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
 */
export function buildQuickLayer(card: QuickEffectCard, params: QuickParams = {}): EffectLayer {
  const p = { ...defaultParams(card), ...params };
  const hue = clampUint16(p.hue);
  const sat = clampByte(p.sat);

  switch (card.kind) {
    case "solid":
      return { type: SEGMENT_TYPE.STATIC, hue, sat, periodMs: 0, p5: 0, flags: 0 };
    case "breathing":
      return {
        type: SEGMENT_TYPE.BREATHING,
        hue,
        sat,
        periodMs: SPEED_MS[p.speed].breathing,
        p5: LEVEL_P5[p.level],
        flags: breathingFlags(WAVEFORM.SINE),
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
      };
    case "comet":
      return {
        type: SEGMENT_TYPE.COMET,
        hue,
        sat,
        periodMs: SPEED_MS[p.speed].animation,
        p5: TAIL_P5[p.tail],
        flags: directionFlags(p.direction === "reverse"),
      };
    default:
      return { type: SEGMENT_TYPE.STATIC, hue, sat, periodMs: 0, p5: 0, flags: 0 };
  }
}

/**
 * 卡片 + 参数 + 灯组 → 一个覆盖整组的光区 spec（单层）。
 *
 * 快捷档的语义就是「整组生效」，所以区间恒为 `0 .. ledCount-1`，
 * 槽位固定 0（整组只有这一个光区），叠加层为空、叠加方式覆盖。
 */
export function buildQuickSpec(
  card: QuickEffectCard,
  params: QuickParams,
  stripId: number,
  ledCount: number,
): SegmentSpec {
  const last = Math.max(0, Math.min(ledCount, 64) - 1);
  return {
    stripId,
    segId: 0,
    start: 0,
    end: last,
    blend: BLEND.OVER,
    layer0: buildQuickLayer(card, params),
    layer1: { type: NO_EFFECT, hue: 0, sat: 0, periodMs: 0, p5: 0, flags: 0 },
  };
}

/**
 * 从设备读回的灯效反推「当前是哪种快捷卡片」。
 *
 * 只按 layer0 的 type + 周期档位近似判断（设备不会告诉我们用户当初点了哪张卡）。
 * 用于切换回快捷档时高亮上次的选择；判断不出来返回 null（用户可自选）。
 */
export function inferQuickCard(layer: EffectLayer): string | null {
  if (layer.type === SEGMENT_TYPE.STATIC) {
    return "warm";
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
  return null;
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
