/**
 * 灯效编辑的纯视图逻辑（#53）：层折叠态、灯效类型切换、预设匹配。
 *
 * ## 为什么从页面下沉
 *
 * 这三段原本写在 `pages/segment-edit` 里（`layerView` / `applyLayerType` /
 * `modeOf` / `presetSelected`）。它们是**纯派生**：输入是一层协议数据，
 * 输出是 UI 要显示的字段，不碰设备、不碰 wx。留在页面里意味着：
 *
 *  - 只有模拟器能验证（`vitest` 跑不到页面）；
 *  - 删掉旧页面时会连带丢掉新界面还要用的逻辑（#58 要删 `segment-edit`）。
 *
 * 所以先下沉到这里，#54/#55 的自定义档直接复用；旧页面只剩「把结果画出来」。
 *
 * 纯函数、不碰 wx / BLE。
 */

import {
  BLEND,
  NO_EFFECT,
  SEGMENT_TYPE,
  WAVEFORM,
  WAVEFORM_NAMES,
} from "../protocol/constants";
import type { BlendMode, EffectLayer } from "../protocol/types";
import { PRESETS, rgbToHex, rgbToSegmentParams, segmentHueSatToRgb, type ColorPreset } from "../color/hsv";
import { blendEnabled, effectiveBlend, layerPeriodFloor } from "./segment-editor";
import { percentOf100, spanText, tailText } from "./segment-view";

/**
 * 层在界面上的灯效档位。
 *
 * 与协议类型一一对应，但两个「没有效果」要分开：
 *  - `off`  = 空层（0xFF），「叠加效果没有设置」；
 *  - `dark` = 熄灭（0x06），「这一段保持黑色」。
 *
 * 合并成一个会让设备页把一条熄灭的灯组显示成「关闭」——用户看到的是
 * 「这个分区没配」，而设备的真实状态是「这个分区被显式设成全黑」。
 */
export type LayerMode =
  | "static"
  | "breathing"
  | "rainbow"
  | "comet"
  | "strobe"
  | "heartbeat"
  | "dark"
  | "off";

/** 一个灯效选项（主效果 / 叠加效果各一份列表）。 */
export interface ModeOption {
  mode: LayerMode;
  name: string;
  type: number;
}

/** 主效果的选项：四种灯效，没有「关闭」（必填）。 */
export const MAIN_MODE_OPTIONS: readonly ModeOption[] = [
  { mode: "static", name: "静态", type: SEGMENT_TYPE.STATIC },
  { mode: "breathing", name: "呼吸", type: SEGMENT_TYPE.BREATHING },
  { mode: "rainbow", name: "彩虹", type: SEGMENT_TYPE.RAINBOW },
  { mode: "comet", name: "流光", type: SEGMENT_TYPE.COMET },
];

/** 叠加效果的选项：多一个「关闭」。 */
export const OVERLAY_MODE_OPTIONS: readonly ModeOption[] = [
  ...MAIN_MODE_OPTIONS,
  { mode: "off", name: "关闭", type: NO_EFFECT },
];

/**
 * 灯效类型 → 界面档位；未知类型按静态显示（与旧页面一致）。
 *
 * 七种协议类型都必须有独立的档位，否则设备页会把它们合并成同一个名字：
 * 0x04（爆闪）/ 0x05（心跳）曾经落到 `default`，于是一条正在爆闪的灯组在
 * 卡片上显示「静态」；0x06（熄灭）同样被显示成「静态」，用户会以为设备
 * 没执行刚才那条设置。
 */
export function layerModeOf(type: number): LayerMode {
  switch (type) {
    case SEGMENT_TYPE.BREATHING:
      return "breathing";
    case SEGMENT_TYPE.RAINBOW:
      return "rainbow";
    case SEGMENT_TYPE.COMET:
      return "comet";
    case SEGMENT_TYPE.STROBE:
      return "strobe";
    case SEGMENT_TYPE.HEARTBEAT:
      return "heartbeat";
    case SEGMENT_TYPE.OFF:
      return "dark";
    case NO_EFFECT:
      return "off";
    default:
      return "static";
  }
}

/**
 * 灯效档位 → 用户看到的名字（设备页的卡片摘要用）。
 *
 * 与 `layerModeOf` 放在一起是刻意的：两者必须同步，任何一边漏一种类型都会
 * 让卡片上的名字与实际画面不符（#72 之后 0x04/0x05/0x06 曾经落进默认分支
 * 被叫成「静态」）。`pages/device` 只调这个函数，不再自己写一份 switch。
 */
const MODE_NAMES: Readonly<Record<LayerMode, string>> = {
  static: "静态",
  breathing: "呼吸",
  rainbow: "彩虹",
  comet: "流光",
  strobe: "爆闪",
  heartbeat: "心跳",
  dark: "熄灭",
  off: "关闭",
};

/** 协议类型 → 显示名（未知类型按「静态」，与 `layerModeOf` 的兜底一致）。 */
export function layerModeNameOf(type: number): string {
  return MODE_NAMES[layerModeOf(type)];
}

/** 波形选项（顺序 = 协议枚举值）。 */
export const WAVEFORM_OPTIONS: ReadonlyArray<{ value: number; name: string }> = [
  { value: WAVEFORM.SINE, name: WAVEFORM_NAMES[WAVEFORM.SINE] },
  { value: WAVEFORM.TRIANGLE, name: WAVEFORM_NAMES[WAVEFORM.TRIANGLE] },
  { value: WAVEFORM.SAWTOOTH, name: WAVEFORM_NAMES[WAVEFORM.SAWTOOTH] },
  { value: WAVEFORM.SQUARE, name: WAVEFORM_NAMES[WAVEFORM.SQUARE] },
];

/** 叠加方式选项（顺序 = 协议值），带一行说明（界面不出现「层」这个字）。 */
export const BLEND_OPTIONS: ReadonlyArray<{ value: BlendMode; name: string; hint: string }> = [
  { value: BLEND.OVER, name: "覆盖", hint: "叠加效果直接替换主效果" },
  { value: BLEND.MULTIPLY, name: "相乘", hint: "两者相乘：明暗叠加、颜色不变形" },
  { value: BLEND.ADD, name: "相加", hint: "两者相加，更亮（可能过曝到白）" },
];

/** 叠加方式名称（未知值按覆盖显示）。 */
export function blendName(blend: BlendMode): string {
  const found = BLEND_OPTIONS.find((option) => option.value === blend);
  return found?.name ?? "覆盖";
}

/**
 * 切换灯效类型时保留颜色，按新类型的语义重置参数（静态层清零）。
 *
 * 就地改传入的层（调用方通常已经做了一份副本）并返回它。
 * 两条规则来自 effects-spec：
 *  - 呼吸只有波形位（bit1-2），彩虹 / 流光只有方向位（bit0），切换时清掉对方；
 *  - 从静态（周期恒 0）切到动画时给一个可感知的默认周期，否则「周期 0 = 静止」
 *    会让人以为新灯效没生效；已有周期抬到新类型下限之上。
 */
export function applyLayerType(layer: EffectLayer, type: number): EffectLayer {
  if (layer.type === type) {
    return layer;
  }
  layer.type = type;
  if (type === SEGMENT_TYPE.STATIC) {
    layer.periodMs = 0;
    layer.p5 = 0;
    layer.flags = 0;
    return layer;
  }
  if (type === SEGMENT_TYPE.BREATHING) {
    layer.flags = layer.flags & 0x06;
  } else {
    layer.flags = layer.flags & 0x01;
  }
  if (layer.periodMs === 0) {
    layer.periodMs = type === SEGMENT_TYPE.BREATHING ? 1000 : 1200;
  } else {
    layer.periodMs = Math.max(layer.periodMs, layerPeriodFloor(type));
  }
  return layer;
}

/** 哪个预设色块该高亮（按 hue+sat 判定，不比 hex）。 */
export function presetSelectedFlags(layer: EffectLayer, presets: readonly ColorPreset[] = PRESETS): boolean[] {
  return presets.map((preset) => {
    const params = rgbToSegmentParams(preset.rgb);
    return params.hue === layer.hue && params.sat === layer.sat;
  });
}

/**
 * 两层折叠态的默认值：主效果展开、叠加效果收起。
 *
 * 叠加效果为空时它没有可编辑的参数，本来就该收起；有内容时展开，
 * 让用户看到设备上的真实值（页面在读到设备值后会重新计算一次）。
 */
export function defaultCollapsed(layer1: EffectLayer): [boolean, boolean] {
  return [false, layer1.type === NO_EFFECT];
}

/** 切换某一层的折叠态，返回新元组（不就地改，便于测试与重画）。 */
export function toggleCollapsed(
  collapsed: readonly [boolean, boolean],
  index: 0 | 1,
): [boolean, boolean] {
  return index === 0 ? [!collapsed[0], collapsed[1]] : [collapsed[0], !collapsed[1]];
}

/** 显式设置某一层的折叠态，返回新元组。 */
export function setCollapsed(
  collapsed: readonly [boolean, boolean],
  index: 0 | 1,
  value: boolean,
): [boolean, boolean] {
  return index === 0 ? [value, collapsed[1]] : [collapsed[0], value];
}

/** 一层的展示态（WXML 只读这一份，编辑一律回写到草稿）。 */
export interface LayerView {
  /** 显示名：「主效果（必填）」/「叠加效果（可选）」（界面不出现「层」，见 decisions §12）。 */
  label: string;
  mode: LayerMode;
  /** 该层是否为空（只有叠加效果可能为空）。 */
  empty: boolean;
  /** 折叠态（空层永远展开，否则找不到打开它的入口）。 */
  collapsed: boolean;
  modeOptions: readonly ModeOption[];
  colorHex: string;
  periodMs: number;
  periodText: string;
  periodFloor: number;
  minLevel: number;
  minLevelText: string;
  waveform: number;
  waveformOptions: ReadonlyArray<{ value: number; name: string }>;
  span: number;
  spanText: string;
  tail: number;
  tailText: string;
  reverse: boolean;
  /** 该层是呼吸 / 彩虹 / 流光（WXML 据此显示对应参数组）。 */
  breathing: boolean;
  rainbow: boolean;
  comet: boolean;
  /** 每个预设色块是否等于该层当前色。 */
  presetSelected: boolean[];
}

/**
 * 一层 + 折叠态 → 视图。
 *
 * `index === 0` 是主效果（必填），`1` 是叠加效果（可关闭）。
 */
export function layerView(
  layer: EffectLayer,
  index: 0 | 1,
  collapsed: boolean,
  presets: readonly ColorPreset[] = PRESETS,
): LayerView {
  const empty = layer.type === NO_EFFECT;
  const mode = layerModeOf(layer.type);
  return {
    /* 术语（decisions §12）：界面只有「灯组 / 分区 / 步骤 / 方案」，「层」不能出现，
     * 所以两层改叫主效果 / 叠加效果。 */
    label: index === 0 ? "主效果（必填）" : "叠加效果（可选）",
    mode,
    empty,
    /* 空层永远展开：否则「叠加效果」只剩一行标题，用户找不到打开它的入口。 */
    collapsed: collapsed && !empty,
    modeOptions: index === 0 ? MAIN_MODE_OPTIONS : OVERLAY_MODE_OPTIONS,
    colorHex: rgbToHex(segmentHueSatToRgb(layer.hue, layer.sat)),
    periodMs: layer.periodMs,
    periodText: empty ? "—" : layer.periodMs === 0 ? "静止" : `${layer.periodMs}ms`,
    periodFloor: layerPeriodFloor(layer.type),
    minLevel: layer.p5,
    /* v4：呼吸的最低亮是相对百分比 0-100（不是 0-255）。 */
    minLevelText: percentOf100(layer.p5),
    waveform: (layer.flags >> 1) & 0x03,
    waveformOptions: WAVEFORM_OPTIONS,
    span: layer.p5,
    spanText: spanText(layer.p5),
    tail: layer.p5,
    tailText: tailText(layer.p5),
    reverse: (layer.flags & 0x01) !== 0,
    breathing: mode === "breathing",
    rainbow: mode === "rainbow",
    comet: mode === "comet",
    presetSelected: presetSelectedFlags(layer, presets),
  };
}

/** 一层的展示态集合 + 叠加方式区块的状态（页面一次 setData 用）。 */
export interface LayerPanel {
  views: [LayerView, LayerView];
  /** 叠加方式控件是否可用（有叠加效果）。 */
  blendEnabled: boolean;
  /** 实际生效的叠加方式（没有叠加效果时已归一为覆盖）。 */
  blend: BlendMode;
  /** 叠加方式区块的说明文案。 */
  blendHint: string;
}

/**
 * 草稿（二层 + 叠加方式 + 折叠态）→ 整个灯效面板的展示态。
 *
 * 把「折叠态 / 叠加方式是否可用 / 文案 / 单层归一」这些跨层判断集中在这里，
 * 页面只需 `setData(panel)`。`blend` 的归一沿用 `segment-editor.effectiveBlend`，
 * 与真正下发时的规则是同一份。
 */
export function buildLayerPanel(
  blend: BlendMode,
  layer0: EffectLayer,
  layer1: EffectLayer,
  collapsed: readonly [boolean, boolean],
  presets: readonly ColorPreset[] = PRESETS,
): LayerPanel {
  const enabled = blendEnabled(layer1);
  const effective = effectiveBlend({ blend, layer1 });
  return {
    views: [layerView(layer0, 0, collapsed[0], presets), layerView(layer1, 1, collapsed[1], presets)],
    blendEnabled: enabled,
    blend: effective,
    blendHint: enabled
      ? (BLEND_OPTIONS.find((option) => option.value === effective)?.hint ?? "")
      : "叠加效果关闭时固定为覆盖",
  };
}
