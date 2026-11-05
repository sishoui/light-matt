/**
 * 进阶档的方案级设置：#99 的循环三档 + #100 的两层模型。
 *
 * ## 循环三档
 *
 * 协议侧的循环字节仍是三值（不循环 / 全部循环 / 最后一步循环，见 #98）。
 * 这里是界面与草稿层的映射：一个全局设置，不属于某一步。
 *
 * ## 两层模型
 *
 * 每个分区两个平级槽位：**背景层**（常亮 / 呼吸 / 彩虹这类铺底的）与
 * **特效层**（流星 / 随机闪烁这类流动的）。分组只影响排序与提示，任何灯效
 * 在任一层都能选。混合方式只剩「相加」与「覆盖」——「相乘」界面上说不清，
 * 也已从选项里移除（协议仍接受它，只是界面不再产生）。
 *
 * 「空」在编码上写成既有的「熄灭」类型 + 相加，输出等价于不贡献光。
 * 界面上不出现「熄灭」这个词。
 */

import { BLEND, NO_EFFECT, SEGMENT_TYPE } from "../protocol/constants";
import { loopModeFromFlags } from "../protocol/commands";
import type { EffectLayer } from "../protocol/types";

/* ---------------- 循环三档 ---------------- */

/** 循环模式（与协议字节同一套值）。 */
export const LOOP_MODE = {
  NONE: 0,
  ALL: 1,
  LAST: 2,
} as const;

export type LoopMode = (typeof LOOP_MODE)[keyof typeof LOOP_MODE];

/** 界面上的一档。 */
export interface LoopOption {
  value: LoopMode;
  label: string;
  /** 说明（副标题 / 选中时的一行解释）。 */
  hint: string;
}

export const LOOP_OPTIONS: readonly LoopOption[] = [
  { value: LOOP_MODE.NONE, label: "不循环", hint: "跑完一遍停在最后一帧" },
  { value: LOOP_MODE.ALL, label: "全部循环", hint: "跑完回到第一步" },
  { value: LOOP_MODE.LAST, label: "最后一步循环", hint: "前几步各播一次，最后一步原地重播" },
];

/** 是否是合法的循环模式。 */
export function isLoopMode(value: unknown): value is LoopMode {
  return value === LOOP_MODE.NONE || value === LOOP_MODE.ALL || value === LOOP_MODE.LAST;
}

/** 钳到合法值（坏数据按「不循环」处理，不抛错）。 */
export function clampLoopMode(value: unknown): LoopMode {
  return isLoopMode(value) ? value : LOOP_MODE.NONE;
}

/** 循环档 → 协议字节里的 flags（与 #98 的位表一致）。 */
export function loopFlagsOf(mode: LoopMode): { loop: boolean; lastStep: boolean } {
  return {
    loop: mode !== LOOP_MODE.NONE,
    lastStep: mode === LOOP_MODE.LAST,
  };
}

/**
 * 下发时要用的循环档位（#114）：**草稿优先，设备兜底**。
 *
 * 判据是 `draftLoop !== undefined`，不是「草稿是否被编辑过」——后者在
 * 加步骤 / 划分区 / 进一次进阶档时都会变真，于是「用户没选过」会被误读成
 * 「用户选了不循环」，简单档改个颜色就能把设备上的循环关掉。
 *
 * @param draftLoop 草稿里的原始值；`undefined` = 从未选过（默认草稿、
 *                  #99 之前落盘的草稿、坏值）。
 * @param flags     设备最近一次上报的 flags；`null` = 没读到。
 */
export function resolveLoopMode(
  draftLoop: number | undefined,
  flags: number | null,
): LoopMode {
  if (isLoopMode(draftLoop)) {
    return draftLoop;
  }
  if (flags !== null && Number.isInteger(flags)) {
    return loopModeFromFlags(flags);
  }
  return LOOP_MODE.NONE;
}

/** 循环档的展示文案。 */
export function loopLabel(mode: LoopMode): string {
  return LOOP_OPTIONS.find((option) => option.value === mode)?.label ?? "不循环";
}

/* ---------------- 两层模型 ---------------- */

/** 层的种类（只有两个平级槽位）。 */
export const LAYER_KIND = {
  /** 背景层：放常亮 / 呼吸 / 彩虹这类铺底的。 */
  BACKGROUND: "background",
  /** 特效层：放流星 / 随机闪烁这类流动的。 */
  EFFECT: "effect",
} as const;

export type LayerKind = (typeof LAYER_KIND)[keyof typeof LAYER_KIND];

/** 某一层的编辑状态。 */
export interface LayerDraft {
  kind: LayerKind;
  /** 灯效 id（`simple-effects` 的 id）；`empty` 表示这一层不贡献光。 */
  effectId: string;
  /** 是否是用户显式选的「空」（背景层允许，特效层也允许）。 */
  empty: boolean;
}

/** 默认的两层（背景常亮、特效空）。 */
export function defaultLayers(): { background: LayerDraft; effect: LayerDraft } {
  return {
    background: { kind: LAYER_KIND.BACKGROUND, effectId: "solid", empty: false },
    effect: { kind: LAYER_KIND.EFFECT, effectId: "empty", empty: true },
  };
}

/** 界面上的混合方式（只剩两种）。 */
export const BLEND_OPTIONS: ReadonlyArray<{ value: number; label: string; hint: string }> = [
  { value: BLEND.ADD, label: "相加", hint: "两层亮度叠加" },
  { value: BLEND.OVER, label: "覆盖", hint: "特效层盖住背景层" },
];

/** 是否是界面上允许的混合方式（相乘已被移除）。 */
export function isUiBlend(value: number): boolean {
  return value === BLEND.ADD || value === BLEND.OVER;
}

/**
 * 把界面上的混合方式钳到合法值。
 *
 * 设备读回「相乘」时（旧配置）按「覆盖」展示——界面不再提供它，但绝不能
 * 把它当成非法值让整块面板读不出来。
 */
export function clampUiBlend(value: number): number {
  return value === BLEND.ADD ? BLEND.ADD : BLEND.OVER;
}

/**
 * 特效层有颜色时「盖住」背景、没颜色时「透出」背景。
 *
 * 这在协议里就是「覆盖」（OVER）与「相加」（ADD）的差别：覆盖时输出只看
 * 特效层，相加时背景仍透出来。所以**默认混合由这个判定给出**，用户也可以在
 * 两种之间改。
 */
export function defaultBlendFor(effectEmpty: boolean): number {
  return effectEmpty ? BLEND.ADD : BLEND.OVER;
}

/**
 * 一层 → 协议层。
 *
 * - 「空」写成既有的熄灭类型（`0x06`，输出恒为黑，等价于不贡献光）；
 * - 背景层为空时用「相加」混合，否则熄灭会把整段变黑（相减不属于协议）。
 *
 * 参数（色相 / 饱和度 / 周期等）由调用方按灯效类型给；这里只决定**类型与
 * 空层编码**，保证「空」的语义只有一处。
 */
export function encodeLayer(input: {
  effectId: string;
  effectType: number;
  empty: boolean;
  params: Omit<EffectLayer, "type">;
}): EffectLayer {
  if (input.empty || input.effectId === "empty") {
    /* 空层：熄灭类型 + 全零参数（命令层要求熄灭的 hue/sat/p5/period/flags 全 0）。 */
    return {
      type: SEGMENT_TYPE.OFF,
      hue: 0,
      sat: 0,
      periodMs: 0,
      p5: 0,
      flags: 0,
      level: 0,
    };
  }
  return { type: input.effectType, ...input.params };
}

/**
 * 背景层「空」时的混合方式。
 *
 * 协议要求每段的背景层是真实灯效，所以「空」只能靠熄灭 + 相加等价实现；
 * 若用覆盖，两层会一起变黑。这里是界面与协议之间唯一的对接点。
 */
export function backgroundBlendOf(backgroundEmpty: boolean, effectEmpty: boolean): number {
  if (backgroundEmpty) {
    return BLEND.ADD;
  }
  return effectEmpty ? BLEND.ADD : BLEND.OVER;
}

/** 这一层是否为空（背景层允许空；特效层也允许）。 */
export function layerIsEmpty(layer: EffectLayer | null | undefined): boolean {
  return layer === null || layer === undefined || layer.type === NO_EFFECT || layer.type === SEGMENT_TYPE.OFF;
}

/** 两层视图（给 WXML 直接渲染）。 */
export interface LayerView {
  kind: LayerKind;
  label: string;
  /** 这一层当前灯效的名字（「常亮」「空」）。 */
  effectName: string;
  /** 是否为空。 */
  empty: boolean;
  /** 这一层的说明（分组提示）。 */
  hint: string;
}

export function buildLayerViews(input: {
  backgroundName: string;
  effectName: string;
  backgroundEmpty: boolean;
  effectEmpty: boolean;
}): LayerView[] {
  return [
    {
      kind: LAYER_KIND.BACKGROUND,
      label: "背景层",
      effectName: input.backgroundEmpty ? "空" : input.backgroundName,
      empty: input.backgroundEmpty,
      hint: "铺底：常亮 / 呼吸 / 彩虹",
    },
    {
      kind: LAYER_KIND.EFFECT,
      label: "特效层",
      effectName: input.effectEmpty ? "空" : input.effectName,
      empty: input.effectEmpty,
      hint: "流动：流星 / 随机闪烁",
    },
  ];
}

/** 两层的分组（界面按它排序：先背景、后特效）。 */
export function layersInOrder(): LayerKind[] {
  return [LAYER_KIND.BACKGROUND, LAYER_KIND.EFFECT];
}
