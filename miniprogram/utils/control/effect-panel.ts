/**
 * 进阶档「效果面板」（#67 四类 → #80 七类）：效果类型 + 按类型整体替换的参数区。
 *
 * ## 为什么是纯模块
 *
 * 这一层几乎全是「规则」而不是「布局」：
 *
 *  1. **每种类型各自用哪几个旋钮**（见 `SLIDER_KEYS` / `CHOICE_KEYS`）。
 *     写错一个就是「用户看到了当前类型用不上的旋钮」；
 *  2. **切换类型时保留什么**。颜色（色相 / 饱和度）与亮度必须留下，其余参数按新
 *     类型的语义重置——把彩虹的「跨度」带进流光当「尾长」没有任何意义；
 *  3. **滑块刻度 ↔ 协议值**。色相 0-360° ↔ 0-65535、饱和度 0-100% ↔ 0-255、
 *     周期秒 ↔ 毫秒、频率赫兹 ↔ 周期毫秒、节奏 BPM ↔ 周期毫秒、
 *     最低亮 / 跨度 / 尾长百分比 ↔ 0-255；
 *  4. **装配光区**。面板只改 `layer0`，但写进设备前必须过 `zone-model.buildZoneSpec`
 *     （空叠加层归一、两层定宽、深拷贝），否则设备回 `InvalidParam`；
 *  5. **本地预检**。频率过快、节奏过快或过慢在本机就拦住，一帧都不发。
 *
 * 页面只把结果塞进 `setData`、把滑块回调交给这里换算，不做算术与判断。
 * 不碰 wx / BLE，可直接单测。
 *
 * ## 七种类型（#80）
 *
 * 静态 / 呼吸 / 彩虹 / 流光沿用 #67；爆闪 / 心跳 / 熄灭是 #74 的协议新增。
 * 「熄灭」在界面上**没有任何旋钮**：给它色相与周期只会让人以为那些参数有用，
 * 实际下发是全零参数块，界面只说明这一段保持黑色。
 *
 * ## 亮度（v4 起真实生效）
 *
 * `level`（逐光区亮度 0-100）是协议 v4 的层字段（#69 接通）。本模块的
 * `EffectParams.level` 经 `panelLayer()` 写进 `EffectLayer.level`，再由
 * `zone-model.buildZoneSpec` 归一（空层恒 0、非空层钳到 0-100）后编进 9 字节层。
 * 滑块松手即落进草稿，写设备仍只走「应用并播放」。
 */

import {
  ANIMATION_MIN_PERIOD_MS,
  BREATHING_MIN_PERIOD_MS,
  BLEND,
  HEARTBEAT_MAX_PERIOD_MS,
  HEARTBEAT_MIN_PERIOD_MS,
  SEGMENT_TYPE,
  STROBE_MIN_PERIOD_MS,
  WAVEFORM,
  WAVEFORM_NAMES,
} from "../protocol/constants";
import { breathingFlags, breathingWaveform, directionFlags } from "../protocol/commands";
import { emptyLayer } from "../protocol/segment-shapes";
import type { BlendMode, EffectLayer, SegmentSpec } from "../protocol/types";
import { rgbToHex, segmentHueSatToRgb } from "../color/hsv";
import { buildZoneSpec } from "./zone-model";
import { WAVEFORM_OPTIONS } from "./effect-view";
import { spanText, tailText } from "./segment-view";
import {
  clampLevel,
  clampZoneLevel,
  LEVEL_DEFAULT,
  LEVEL_MAX,
  LEVEL_MIN,
  hueDegreesOf,
  hueFromDegrees,
  satFromPercent,
  satPercentOf,
} from "./strip-simple";

/** 面板上的七种效果类型（与协议类型一一对应）。 */
export type PanelType = "static" | "breathing" | "rainbow" | "comet" | "strobe" | "heartbeat" | "off";

/** 类型 → 界面文案（七个等宽按钮，顺序即票面顺序）。 */
export const PANEL_TYPE_OPTIONS: ReadonlyArray<{ type: PanelType; name: string }> = [
  { type: "static", name: "静态" },
  { type: "breathing", name: "呼吸" },
  { type: "rainbow", name: "彩虹" },
  { type: "comet", name: "流光" },
  { type: "strobe", name: "爆闪" },
  { type: "heartbeat", name: "心跳" },
  { type: "off", name: "熄灭" },
];

/**
 * 叠加层可选类型：七种里去掉「熄灭」。
 *
 * 叠加一个「熄灭」等于什么都没做（它只会把下面那层乘成黑），
 * 让用户能选到它只会制造困惑。
 */
export const PANEL_OVERLAY_TYPE_OPTIONS: ReadonlyArray<{ type: PanelType; name: string }> =
  PANEL_TYPE_OPTIONS.filter((option) => option.type !== "off");

/* ---------------- 叠加层（#71 US49/US50） ---------------- */

/**
 * 叠加层的开关选项：「关闭」+ 可选的六种类型。
 *
 * 「关闭」不是 `PanelType`——它表示 `layer1` 是空层（`type = 0xFF`），
 * 与「点亮灭」是两件事：熄灭是一条真实存在、参数全零的层。
 */
export type OverlayChoice = PanelType | "none";

export const OVERLAY_CHOICE_OPTIONS: ReadonlyArray<{ value: OverlayChoice; name: string }> = [
  { value: "none", name: "关闭" },
  ...PANEL_OVERLAY_TYPE_OPTIONS.map((option) => ({ value: option.type, name: option.name })),
];

/**
 * 叠加层的叠加方式（覆盖 / 相乘 / 相加）。
 *
 * 与 `effect-view.BLEND_OPTIONS` 同一组语义；这里重列是为了让「叠加层」这一
 * 整块（选项 / 草稿 / 装配）留在同一个模块里，页面只认一个来源。
 */
export const OVERLAY_BLEND_OPTIONS: ReadonlyArray<{
  value: BlendMode;
  name: string;
  hint: string;
}> = [
  { value: BLEND.OVER, name: "覆盖", hint: "叠加效果直接替换主效果" },
  { value: BLEND.MULTIPLY, name: "相乘", hint: "两者相乘：明暗叠加、颜色不变形" },
  { value: BLEND.ADD, name: "相加", hint: "两者相加，更亮（可能过曝到白）" },
];

/** 一个光区的叠加层草稿：没有叠加层时 `type = "none"`。 */
export interface OverlayDraft {
  type: OverlayChoice;
  /** 叠加层自己的参数，与主效果的草稿互相独立。 */
  params: EffectParams;
  blend: BlendMode;
}

/** 没有叠加层时的草稿（关闭 + 覆盖）。 */
export function emptyOverlayDraft(): OverlayDraft {
  return { type: "none", params: defaultParams("static"), blend: BLEND.OVER };
}

/**
 * 从设备读回的光区还原叠加层草稿。空层 → 「关闭」。
 *
 * 设备上若是「熄灭」叠加层（旧数据 / 别的客户端写的），这里如实还原成
 * 「关闭」并把叠加方式归一为覆盖——界面不提供这个选项，也不该假装它存在。
 */
export function overlayDraftOf(
  layer1: EffectLayer | null | undefined,
  blend: BlendMode,
): OverlayDraft {
  if (layer1 === null || layer1 === undefined || layer1.type === SEGMENT_TYPE.EMPTY) {
    return emptyOverlayDraft();
  }
  const type = panelTypeOf(layer1.type);
  if (type === "off") {
    return emptyOverlayDraft();
  }
  return { type, params: paramsFromLayer(type, layer1), blend };
}

/** 叠加层是否真的启用。 */
export function overlayEnabled(draft: OverlayDraft): boolean {
  return draft.type !== "none";
}

/**
 * 叠加层草稿 → `layer1`（未启用时给空层）。
 *
 * 「熄灭」不在可选类型里，但草稿可能来自旧数据：这里再挡一次。叠加熄灭等于
 * 把下面那层乘成黑，用户真正想要的是「不加东西」，应该选「关闭」。
 */
export function overlayLayer(draft: OverlayDraft): EffectLayer {
  if (draft.type === "none" || draft.type === "off") {
    return emptyLayer();
  }
  return panelLayer(draft.type, draft.params);
}

/**
 * 切换叠加层类型。
 *
 * 关闭时**保留原参数**：用户可能是误关，切回来还要接着调。
 * 从关闭切回来沿用上次参数；两种类型之间切换按新类型语义重置（与主效果一致）。
 */
export function switchOverlayType(draft: OverlayDraft, next: OverlayChoice): OverlayDraft {
  if (next === draft.type) {
    return draft;
  }
  if (next === "none") {
    return { ...draft, type: "none" };
  }
  const params =
    draft.type === "none" ? draft.params : switchPanelType(draft.params, draft.type, next);
  return { type: next, params, blend: draft.blend };
}

/** 叠加层的摘要（「关闭」时给空串，调用方据此不显示这一行）。 */
export function overlaySummary(draft: OverlayDraft): string {
  if (!overlayEnabled(draft)) {
    return "";
  }
  /* `overlayEnabled` 已排除 "none"，这里只剩真实类型。 */
  const type = draft.type as PanelType;
  const name = PANEL_TYPE_OPTIONS.find((option) => option.type === type)?.name ?? "";
  return `${name} · ${panelSummary(type, draft.params)}`;
}


/** 类型 → 协议枚举值。 */
const TYPE_VALUE: Record<PanelType, number> = {
  static: SEGMENT_TYPE.STATIC,
  breathing: SEGMENT_TYPE.BREATHING,
  rainbow: SEGMENT_TYPE.RAINBOW,
  comet: SEGMENT_TYPE.COMET,
  strobe: SEGMENT_TYPE.STROBE,
  heartbeat: SEGMENT_TYPE.HEARTBEAT,
  off: SEGMENT_TYPE.OFF,
};

/** 协议枚举值 → 面板类型（空层 / 未知按静态）。 */
export function panelTypeOf(type: number): PanelType {
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
      return "off";
    default:
      /* 空层（0xFF）与未知值都按静态显示——空层不是「熄灭」，它表示这里没效果。 */
      return "static";
  }
}

/** 周期滑块的秒数区间（0.5–10 秒，步进 0.5）。协议里是毫秒，界面只出现秒。 */
export const PERIOD_MIN_MS = 500;
export const PERIOD_MAX_MS = 10000;
export const PERIOD_STEP_MS = 500;

/** 最低亮 / 跨度 / 尾长 / 占空比在界面上的百分比区间。 */
export const PERCENT_MIN = 0;
export const PERCENT_MAX = 100;
export const PERCENT_STEP = 1;

/**
 * 爆闪频率的界面区间：1–10 Hz。
 *
 * 10 Hz = 100ms 周期，是固件默认 20fps（每帧 50ms）能表现的上界；
 * 更快只会掉帧，看起来比低频更糟（#74 不提高帧率）。
 */
export const FREQUENCY_MIN = 1;
export const FREQUENCY_MAX = 10;
export const FREQUENCY_STEP = 1;

/** 心跳节奏的界面区间：40–120 BPM（500–1500ms 一个节拍）。 */
export const BPM_MIN = 40;
export const BPM_MAX = 120;
export const BPM_STEP = 1;

/**
 * 占空比三档（effects-spec §2.5）：窄 ≈15% / 中 ≈35% / 宽 ≈60%，
 * 对应协议值 40 / 90 / 153。
 */
export const DUTY_OPTIONS: ReadonlyArray<{ value: number; label: string }> = [
  { value: 40, label: "窄" },
  { value: 90, label: "中" },
  { value: 153, label: "宽" },
];

/** 心跳的脉冲宽度（协议 p5）。界面上不暴露，固定中等（effects-spec §2.6）。 */
const HEARTBEAT_PULSE = 60;

/** 心跳默认开双脉冲（flags bit0）。 */
const HEARTBEAT_FLAGS = 0x01;

/**
 * 面板的本地草稿。
 *
 * 一份草稿同时覆盖七种类型：每种类型只用其中一部分字段（见 `SLIDER_KEYS`）。
 * 这样切换类型时「保留颜色」不需要在页面里做拆装。
 */
export interface EffectParams {
  /** 色相 0-65535（协议值，不是度数）。 */
  hue: number;
  /** 饱和度 0-255。 */
  sat: number;
  /** 亮度 0-100；协议 v4 字段，编码在 #69（见模块头）。 */
  level: number;
  /** 周期毫秒（静态 / 熄灭恒 0；爆闪与心跳由频率 / 节奏换算，草稿里不单独调）。 */
  periodMs: number;
  /**
   * 呼吸最低亮的占比 **0-100 百分比**（协议 `p5`）。
   *
   * v4 起呼吸的 p5 是相对百分比（谷底 = 层亮度 × p5%），101-255 会被设备拒绝；
   * 彩虹的跨度 / 流光的尾长仍是 0-255（`span` / `tail`）。
   */
  minLevel: number;
  /** 呼吸波形 0-3（正弦 / 三角 / 锯齿 / 方波）。 */
  waveform: number;
  /** 彩虹跨度 0-255（协议 `p5`）。 */
  span: number;
  /** 流光尾长 0-255（协议 `p5`）。 */
  tail: number;
  /** 彩虹 / 流光的方向：true = 反转。 */
  reverse: boolean;
  /** 爆闪频率 1-10 Hz（面板单位；编码时换成周期毫秒）。 */
  frequencyHz: number;
  /** 爆闪占空比：协议 p5，只取 `DUTY_OPTIONS` 的三档。 */
  duty: number;
  /** 心跳节奏 40-120 BPM（面板单位；编码时换成周期毫秒）。 */
  bpm: number;
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
    frequencyHz: 4,
    duty: 90,
    bpm: 60,
  };
  switch (type) {
    case "breathing":
      return { ...base, periodMs: 2000, minLevel: 40 };
    case "rainbow":
      return { ...base, periodMs: 3000, span: 255 };
    case "comet":
      return { ...base, periodMs: 2000, tail: 120 };
    case "strobe":
      /* 爆闪的「周期」由频率决定，草稿里那个字段不参与（恒 0）。 */
      return { ...base, periodMs: 0, frequencyHz: 4, duty: 90 };
    case "heartbeat":
      return { ...base, periodMs: 0, bpm: 60 };
    case "off":
      return { ...base, periodMs: 0 };
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
    /* 0 是协议合法值（这一层不出光）：设备读回的 0 必须原样保留，
     * 否则「改个颜色」会把用户关掉的光区偷偷点亮。滑块下限只管拖动。 */
    level: clampZoneLevel(merged.level),
    periodMs: clampPeriodMs(merged.periodMs),
    minLevel: clampPercent(merged.minLevel),
    waveform: clampWaveform(merged.waveform),
    span: clampByte(merged.span),
    tail: clampByte(merged.tail),
    reverse: merged.reverse === true,
    frequencyHz: clampFrequency(merged.frequencyHz),
    duty: nearestDuty(merged.duty),
    bpm: clampBpm(merged.bpm),
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

/** 0-100 的百分比字段钳位（呼吸最低亮）。 */
function clampPercent(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.min(100, Math.round(value)));
}

/** 周期钳到滑块的区间。静态 / 熄灭的 0 也合法（表示「不需要周期」）。 */
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

/** 频率钳到 1-10 Hz。 */
export function clampFrequency(hz: number): number {
  if (!Number.isFinite(hz)) {
    return FREQUENCY_MIN;
  }
  return Math.max(FREQUENCY_MIN, Math.min(FREQUENCY_MAX, Math.round(hz)));
}

/** 节奏钳到 40-120 BPM。 */
export function clampBpm(bpm: number): number {
  if (!Number.isFinite(bpm)) {
    return 60;
  }
  return Math.max(BPM_MIN, Math.min(BPM_MAX, Math.round(bpm)));
}

/** 任意值落到最近的一档占空比（只认 40 / 90 / 153）。 */
function nearestDuty(value: number): number {
  if (!Number.isFinite(value)) {
    return 90;
  }
  let best = DUTY_OPTIONS[0].value;
  let bestGap = Math.abs(value - best);
  for (const option of DUTY_OPTIONS) {
    const gap = Math.abs(value - option.value);
    if (gap < bestGap) {
      best = option.value;
      bestGap = gap;
    }
  }
  return best;
}

/** 频率（Hz）→ 周期（毫秒），并钳到爆闪的协议下限。 */
export function strobePeriodMs(frequencyHz: number): number {
  const hz = clampFrequency(frequencyHz);
  return Math.max(STROBE_MIN_PERIOD_MS, Math.round(1000 / hz));
}

/** 节奏（BPM）→ 周期（毫秒），并钳到心跳的协议区间。 */
export function heartbeatPeriodMs(bpm: number): number {
  const beats = clampBpm(bpm);
  return Math.max(HEARTBEAT_MIN_PERIOD_MS, Math.min(HEARTBEAT_MAX_PERIOD_MS, Math.round(60000 / beats)));
}


/* ---------------- 每种类型用哪些旋钮 ---------------- */

/** 滑块键（顺序 = 面板上的显示顺序）。 */
export type PanelSliderKey =
  | "hue"
  | "sat"
  | "level"
  | "period"
  | "minLevel"
  | "span"
  | "tail"
  | "frequency"
  | "bpm";

/** 选择键（波形 / 方向 / 占空比）。 */
export type PanelChoiceKey = "waveform" | "direction" | "duty";

/**
 * 每种类型的滑块列表。
 *
 * 这张表就是「用户永远看不到当前类型用不上的旋钮」的唯一真相：参数区整体替换
 * 的依据是它，不是页面里的 `wx:if` 集合。熄灭一个滑块都没有——它下发的是全零
 * 参数块，给旋钮只会让人以为那些参数有用。
 */
export const SLIDER_KEYS: Record<PanelType, readonly PanelSliderKey[]> = {
  static: ["hue", "sat", "level"],
  breathing: ["hue", "sat", "level", "period", "minLevel"],
  rainbow: ["period", "span"],
  comet: ["hue", "sat", "level", "period", "tail"],
  strobe: ["hue", "sat", "frequency", "level"],
  heartbeat: ["hue", "sat", "bpm", "level"],
  off: [],
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
  "frequency",
  "bpm",
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
  strobe: ["duty"],
  heartbeat: [],
  off: [],
};

/** 一个滑块的展示态。 */
export interface PanelSliderView {
  key: PanelSliderKey;
  label: string;
  /** 滑块位置（色相是度、周期是秒、频率是 Hz、节奏是 BPM、其余是百分比）。 */
  value: number;
  min: number;
  max: number;
  step: number;
  /** 右侧读数（「40°」「62%」「2 秒」「整圈」「拖尾 47%」「4 Hz」「60 BPM」）。 */
  display: string;
  /** 滑轨是否画彩虹渐变（只有色相）。 */
  rainbow: boolean;
  /** 滑块是否真的会改变设备（现存滑块全部为 true）。 */
  sends: boolean;
  /** 不下发时的说明；空串表示正常生效。 */
  note: string;
}

/** 一个选择控件（波形 / 方向 / 占空比）。 */
export interface PanelChoiceView {
  key: PanelChoiceKey;
  label: string;
  options: ReadonlyArray<{ value: number; label: string }>;
  /** 当前选中的 option 值（方向：0 正转 / 1 反转）。 */
  value: number;
}

/** 七个类型按钮的展示态。 */
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
  /**
   * 没有旋钮时的说明（只有熄灭会用到：它下发全零参数块，界面上没有任何可调项）。
   * 空串表示参数区有滑块 / 选择控件。
   */
  notice: string;
}

/** 七个类型按钮（等宽一排）。 */
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
      /* 显示真实值（设备可能是 0）；`min` 只限制用户拖动到的下限。 */
      const level = clampZoneLevel(params.level);
      return {
        key,
        label: "亮度",
        value: level,
        min: LEVEL_MIN,
        max: LEVEL_MAX,
        step: 1,
        display: `${level}%`,
        rainbow: false,
        sends: true,
        note: "",
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
      /* v4 起 lowest 就是百分比本身（0-100），不再从 0-255 换算。 */
      const percent = clampPercent(params.minLevel);
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
    case "tail": {
      const percent = p5Percent(params.tail);
      return {
        key,
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
    case "frequency": {
      const hz = clampFrequency(params.frequencyHz);
      return {
        key,
        label: "频率",
        value: hz,
        min: FREQUENCY_MIN,
        max: FREQUENCY_MAX,
        step: FREQUENCY_STEP,
        display: `${hz} Hz`,
        rainbow: false,
        sends: true,
        note: "",
      };
    }
    default: {
      const bpm = clampBpm(params.bpm);
      return {
        key: "bpm",
        label: "节奏",
        value: bpm,
        min: BPM_MIN,
        max: BPM_MAX,
        step: BPM_STEP,
        display: `${bpm} BPM`,
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
  if (key === "duty") {
    return {
      key,
      label: "占空比",
      options: DUTY_OPTIONS,
      value: nearestDuty(params.duty),
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
  if (type === "off") {
    /* 熄灭没有可说的参数，只描述结果。 */
    parts.push("这一片不亮");
    return parts.join(" · ");
  }
  if (type === "static") {
    parts.push(`${hueDegreesOf(params.hue)}°`, satPercentOf(params.sat) + "%");
    return parts.join(" · ");
  }
  if (type === "strobe") {
    parts.push(`${clampFrequency(params.frequencyHz)} Hz`, `占空比 ${dutyLabel(nearestDuty(params.duty))}`);
    return parts.join(" · ");
  }
  if (type === "heartbeat") {
    parts.push(`${clampBpm(params.bpm)} BPM`, "双脉冲");
    return parts.join(" · ");
  }
  parts.push(secondsText(Math.max(PERIOD_MIN_MS, clampPeriodMs(params.periodMs))));
  if (type === "breathing") {
    parts.push(
      `最暗 ${clampPercent(params.minLevel)}%`,
      WAVEFORM_NAMES[clampWaveform(params.waveform)] ?? "正弦",
    );
  } else if (type === "rainbow") {
    parts.push(spanText(clampByte(params.span)), params.reverse ? "反转" : "正转");
  } else {
    parts.push(tailText(clampByte(params.tail)), params.reverse ? "反转" : "正转");
  }
  return parts.join(" · ");
}

/** 占空比档位 → 界面文案（「窄 / 中 / 宽」）。 */
function dutyLabel(duty: number): string {
  return DUTY_OPTIONS.find((option) => option.value === duty)?.label ?? "中";
}

/** 熄灭的说明：没有旋钮可调，只告诉用户这一片的观感。 */
export const PANEL_OFF_NOTICE =
  "这一片保持不亮：它不会随整组变亮或呼吸，写进方案后就是一片黑。";

/**
 * 类型 + 草稿 → 整个参数区。
 *
 * 参数区「整体替换」就是这里：滑块列表完全由 `SLIDER_KEYS[type]` 决定，
 * 页面不做任何按类型的条件渲染。没有滑块也没有选择控件时（熄灭），
 * `notice` 给出一行说明而不是留白。
 */
export function buildEffectPanel(type: PanelType, params: EffectParams): EffectPanelView {
  const normalized = normalizeParams(params);
  const sliders = SLIDER_KEYS[type].map((key) => sliderView(key, normalized));
  const choices = CHOICE_KEYS[type].map((key) => choiceView(key, normalized));
  return {
    type,
    types: buildTypeViews(type),
    sliders,
    choices,
    /* 「熄灭」不出任何颜色：色块会让人以为这一片是那个颜色。 */
    colorHex: type === "off" ? "" : rgbToHex(segmentHueSatToRgb(normalized.hue, normalized.sat)),
    summary: panelSummary(type, normalized),
    notice: type === "off" ? PANEL_OFF_NOTICE : "",
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
    /* 呼吸 / 彩虹 / 流光的周期抬到协议下限之上（与 applyLayerType 一致）；
     * 静态 / 熄灭恒 0；爆闪与心跳的周期由频率 / 节奏换算，草稿里也是 0。 */
    periodMs:
      to === "breathing" || to === "rainbow" || to === "comet"
        ? Math.max(
            base.periodMs,
            to === "breathing" ? BREATHING_MIN_PERIOD_MS : ANIMATION_MIN_PERIOD_MS,
          )
        : 0,
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
      return { ...params, minLevel: clampPercent(next) };
    case "span":
      return { ...params, span: p5FromPercent(next) };
    case "frequency":
      return { ...params, frequencyHz: clampFrequency(next) };
    case "bpm":
      return { ...params, bpm: clampBpm(next) };
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
    case "frequency":
      return clampFrequency(value);
    case "bpm":
      return clampBpm(value);
    default:
      return Math.max(PERCENT_MIN, Math.min(PERCENT_MAX, value));
  }
}

/** 改一个选择控件（波形 / 方向 / 占空比）。 */
export function applyChoice(
  params: EffectParams,
  key: PanelChoiceKey,
  value: number,
): EffectParams {
  if (key === "waveform") {
    return { ...params, waveform: clampWaveform(value) };
  }
  if (key === "duty") {
    return { ...params, duty: nearestDuty(value) };
  }
  return { ...params, reverse: Number(value) === 1 };
}

/* ---------------- 草稿 ↔ 协议层 ---------------- */

/**
 * 草稿 + 类型 → 协议层（`EffectLayer`）。
 *
 * **这是 `level` 唯一写进线上形状的地方。** `clampLevel` 把草稿的亮度钳到
 * 面板的显示区间（5-100），`buildZoneSpec` 再按协议规则归一一次（空层恒 0）。
 * 两层都经过它，所以「调了亮度却被设备拒」不会在真机上才暴露。
 */
export function panelLayer(type: PanelType, params: EffectParams): EffectLayer {
  const normalized = normalizeParams(params);
  const hue = normalized.hue;
  const sat = normalized.sat;
  const level = clampZoneLevel(normalized.level);
  switch (type) {
    case "breathing":
      return {
        type: SEGMENT_TYPE.BREATHING,
        hue,
        sat,
        periodMs: Math.max(clampPeriodMs(normalized.periodMs) || PERIOD_MIN_MS, BREATHING_MIN_PERIOD_MS),
        /* v4：呼吸的最低亮是百分比 0-100（不是 0-255）。 */
        p5: clampPercent(normalized.minLevel),
        /* 呼吸只有波形位（bit1-2）；bit0 是保留位，必须为 0。 */
        flags: breathingFlags(clampWaveform(normalized.waveform)),
        level,
      };
    case "rainbow":
      return {
        type: SEGMENT_TYPE.RAINBOW,
        hue,
        sat,
        periodMs: Math.max(clampPeriodMs(normalized.periodMs) || PERIOD_MIN_MS, ANIMATION_MIN_PERIOD_MS),
        p5: clampByte(normalized.span),
        flags: directionFlags(normalized.reverse),
        level,
      };
    case "comet":
      return {
        type: SEGMENT_TYPE.COMET,
        hue,
        sat,
        periodMs: Math.max(clampPeriodMs(normalized.periodMs) || PERIOD_MIN_MS, ANIMATION_MIN_PERIOD_MS),
        p5: clampByte(normalized.tail),
        flags: directionFlags(normalized.reverse),
        level,
      };
    case "strobe":
      /*
       * 爆闪（#74）：周期由频率换算（1000 / Hz，钳到 100ms 下限）；
       * p5 是占空比，flags 必须为 0（没有方向 / 波形位）。
       */
      return {
        type: SEGMENT_TYPE.STROBE,
        hue,
        sat,
        periodMs: strobePeriodMs(normalized.frequencyHz),
        p5: nearestDuty(normalized.duty),
        flags: 0,
        level,
      };
    case "heartbeat":
      /*
       * 心跳（#74）：周期由 BPM 换算（60000 / BPM，钳到 500-1500ms）；
       * p5 是脉冲宽度（界面不给入口，固定中等），flags bit0 = 双脉冲。
       */
      return {
        type: SEGMENT_TYPE.HEARTBEAT,
        hue,
        sat,
        periodMs: heartbeatPeriodMs(normalized.bpm),
        p5: HEARTBEAT_PULSE,
        flags: HEARTBEAT_FLAGS,
        level,
      };
    case "off":
      /* 熄灭（#74）：参数块与 level 全 0——它本来就是黑的，亮度没有意义。 */
      return {
        type: SEGMENT_TYPE.OFF,
        hue: 0,
        sat: 0,
        periodMs: 0,
        p5: 0,
        flags: 0,
        level: 0,
      };
    default:
      /* 静态层：period / p5 / flags 必须为 0（协议硬约束）；level 不受这条约束。 */
      return { type: SEGMENT_TYPE.STATIC, hue, sat, periodMs: 0, p5: 0, flags: 0, level };
  }
}

/**
 * 周期 → 该类型可用的毫秒值。
 *
 * 呼吸 / 彩虹 / 流光走滑块口径（0.5 秒步进，见 `clampPeriodMs`）；
 * 爆闪 / 心跳的周期由频率 / 节奏换算，粒度是毫秒级，**不能**过 `clampPeriodMs`
 * （200ms 会被圆到 0 再抬到 500ms，读回来频率就错了）。
 *
 * **0 必须原样返回 0**：0 在协议里表示「静止」，而爆闪 / 心跳的下限钳位
 * 会把 0 抬成 100ms / 500ms —— 那正是**最快**的两档（10Hz / 120BPM）。
 * 若不在这里短路，一台把爆闪设成静止的设备读回来会显示成最亮的爆闪，
 * 用户一碰滑块就把「静止」变成「10Hz」。
 */
function periodMsFor(type: PanelType, periodMs: number): number {
  if (!Number.isFinite(periodMs) || periodMs <= 0) {
    return 0;
  }
  if (type === "strobe") {
    return Math.max(STROBE_MIN_PERIOD_MS, Math.round(periodMs));
  }
  if (type === "heartbeat") {
    return Math.max(
      HEARTBEAT_MIN_PERIOD_MS,
      Math.min(HEARTBEAT_MAX_PERIOD_MS, Math.round(periodMs)),
    );
  }
  return clampPeriodMs(periodMs);
}

/**
 * 设备读回的层 → 面板草稿。
 *
 * 只取该类型真正用的字段；周期为 0（静止）时退回该类型的默认周期，避免面板上
 * 出现一个「0 秒」的滑块位置。
 *
 * v4：`level` 也一起读回——否则用户切到别的光区再切回来，自己调的亮度会被
 * 悄悄重置成 100%（#69 之前正是靠页面里的一张草稿表救场的）。
 */
export function paramsFromLayer(type: PanelType, layer: EffectLayer): EffectParams {
  const base = defaultParams(type);
  const period = periodMsFor(type, layer.periodMs);
  const level = clampZoneLevel(layer.level);
  switch (type) {
    case "breathing":
      return {
        ...base,
        hue: clampHue(layer.hue),
        sat: clampByte(layer.sat),
        level,
        periodMs: period === 0 ? base.periodMs : period,
        minLevel: clampPercent(layer.p5),
        waveform: breathingWaveform(layer.flags),
        reverse: false,
      };
    case "rainbow":
      return {
        ...base,
        hue: clampHue(layer.hue),
        sat: clampByte(layer.sat),
        level,
        periodMs: period === 0 ? base.periodMs : period,
        span: clampByte(layer.p5),
        reverse: (layer.flags & 0x01) !== 0,
      };
    case "comet":
      return {
        ...base,
        hue: clampHue(layer.hue),
        sat: clampByte(layer.sat),
        level,
        periodMs: period === 0 ? base.periodMs : period,
        tail: clampByte(layer.p5),
        reverse: (layer.flags & 0x01) !== 0,
      };
    case "strobe":
      /* 周期 → 频率（Hz）；设备上的 0（静止）退回默认频率，滑块不落在 0。 */
      return {
        ...base,
        hue: clampHue(layer.hue),
        sat: clampByte(layer.sat),
        level,
        frequencyHz: period === 0 ? base.frequencyHz : clampFrequency(roundHz(period)),
        duty: nearestDuty(layer.p5),
      };
    case "heartbeat":
      /* 周期 → 节奏（BPM）；设备上的 0（静止）退回默认节奏。 */
      return {
        ...base,
        hue: clampHue(layer.hue),
        sat: clampByte(layer.sat),
        level,
        bpm: period === 0 ? base.bpm : clampBpm(roundBpm(period)),
      };
    case "off":
      /* 熄灭层没有任何参数（设备上全 0），草稿直接用默认值：切回别的类型时
       * 亮度不会停在 0（那会让用户以为「切走了还是不亮」）。 */
      return { ...base };
    default:
      return { ...base, hue: clampHue(layer.hue), sat: clampByte(layer.sat), level };
  }
}

/** 周期毫秒 → 频率（Hz，四舍五入到整数；0 / 非有限值按 0）。 */
function roundHz(periodMs: number): number {
  if (!Number.isFinite(periodMs) || periodMs <= 0) {
    return 0;
  }
  return Math.round(1000 / periodMs);
}

/** 周期毫秒 → 节奏（BPM，四舍五入到整数；0 / 非有限值按 0）。 */
function roundBpm(periodMs: number): number {
  if (!Number.isFinite(periodMs) || periodMs <= 0) {
    return 0;
  }
  return Math.round(60000 / periodMs);
}

/* ---------------- 本地预检 ---------------- */

/** 预检结果：`ok = false` 时 `message` 是一句可以直接显示给用户的原因。 */
export interface PanelCheckResult {
  ok: boolean;
  message: string;
}

/**
 * 面板草稿的本地预检（#80）。
 *
 * 只有爆闪 / 心跳有会越界的旋钮：频率上限 10Hz（100ms 周期）、节奏 40-120 BPM
 * （500-1500ms）。越界时**不发帧**——`panelLayer` 会先钳位，但那样用户会以为
 * 「滑块拖到头了还是那个样子」；这里直接说清楚原因，按钮下方就地显示。
 *
 * 其余类型没有额外约束（合法草稿一律放行）；调用方仍然要过
 * `session.validateScriptForDevice`，两层各管一段。
 */
export function panelCheck(type: PanelType, params: EffectParams): PanelCheckResult {
  /* 用**原始**草稿值判断：`normalizeParams` 会先钳位，那样越界输入永远「合法」，
   * 用户拖动一个越界的滑块就看不到任何原因了。 */
  if (type === "strobe") {
    if (Number.isFinite(params.frequencyHz) && params.frequencyHz > FREQUENCY_MAX) {
      return { ok: false, message: `爆闪最快 ${FREQUENCY_MAX} Hz：再快灯珠就跟不上了。` };
    }
    return { ok: true, message: "" };
  }
  if (type === "heartbeat") {
    if (Number.isFinite(params.bpm) && params.bpm > BPM_MAX) {
      return { ok: false, message: `心跳最快 ${BPM_MAX} BPM：再快就不像心跳了。` };
    }
    if (Number.isFinite(params.bpm) && params.bpm < BPM_MIN) {
      return { ok: false, message: `心跳最慢 ${BPM_MIN} BPM：再慢就看不出是一次心跳。` };
    }
    return { ok: true, message: "" };
  }
  return { ok: true, message: "" };
}

/**
 * 按**层**预检：爆闪不要快过 10Hz、心跳不要超出 40-120 BPM。
 *
 * 这是真正拦帧的那一道：面板上的滑块已经被 `clampSliderValue` 钳住了，但
 * 草稿还可能来自设备读回、旧版本落盘、或将来别的入口（叠加层、导入）。写进
 * 设备前统一扫一遍，越界就不发帧。
 *
 * 周期 0 是「静止」（协议合法），不受这些区间约束。
 */
export function layerCheck(layer: EffectLayer): PanelCheckResult {
  if (layer.type === SEGMENT_TYPE.STROBE) {
    if (layer.periodMs !== 0 && layer.periodMs < STROBE_MIN_PERIOD_MS) {
      return { ok: false, message: `爆闪最快 ${FREQUENCY_MAX} Hz：再快灯珠就跟不上了。` };
    }
    return { ok: true, message: "" };
  }
  if (layer.type === SEGMENT_TYPE.HEARTBEAT) {
    if (layer.periodMs === 0) {
      return { ok: true, message: "" };
    }
    if (layer.periodMs < HEARTBEAT_MIN_PERIOD_MS) {
      return { ok: false, message: `心跳最快 ${BPM_MAX} BPM：再快就不像心跳了。` };
    }
    if (layer.periodMs > HEARTBEAT_MAX_PERIOD_MS) {
      return { ok: false, message: `心跳最慢 ${BPM_MIN} BPM：再慢就看不出是一次心跳。` };
    }
    return { ok: true, message: "" };
  }
  return { ok: true, message: "" };
}

/** 一组层一起预检：返回第一个越界原因（全部合法时 `ok = true`）。 */
export function layersCheck(layers: readonly EffectLayer[]): PanelCheckResult {
  for (const layer of layers) {
    const result = layerCheck(layer);
    if (!result.ok) {
      return result;
    }
  }
  return { ok: true, message: "" };
}

/**
 * 把一个光区的主效果（必要时连叠加层一起）换掉，其余字段一字不动。
 *
 * 装配走 `buildZoneSpec`：叠加层为空时叠加方式归一为覆盖、两层定宽、深拷贝——
 * 「面板只改颜色 / 效果，不该顺手把叠加层弄丢」。
 *
 * `overlay` 省略时**保留设备 / 草稿里原有的叠加层**（只改主效果的老行为）；
 * 传进来则连同叠加方式一起替换（#71 的叠加层编辑器走这条路）。
 */
export function applyPanelToZone(
  zones: readonly SegmentSpec[],
  segId: number,
  type: PanelType,
  params: EffectParams,
  overlay?: OverlayDraft,
): SegmentSpec[] {
  return zones.map((zone) =>
    zone.segId === segId
      ? buildZoneSpec({
          stripId: zone.stripId,
          segId: zone.segId,
          start: zone.start,
          end: zone.end,
          blend: overlay === undefined ? zone.blend : overlay.blend,
          layer0: panelLayer(type, params),
          layer1: overlay === undefined ? zone.layer1 : overlayLayer(overlay),
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
