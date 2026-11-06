/**
 * 效果面板单元（#154）：把「一层的参数编辑」从页面里抽出来（v5 形状）。
 *
 * ## 这一层守的是什么
 *
 * 面板有三条容易被抄歪的规则：
 *
 *  1. **参数区按类型整体替换**——用哪几个旋钮由 `SLIDER_KEYS` / `CHOICE_KEYS`
 *     决定，页面不写任何按类型的条件渲染；
 *  2. **换目标时从设备读回重新读层**，但**同一目标重画时不重读**（否则拖动中的
 *     读数会被一次 setData 冲掉）；
 *  3. **还没下发的亮度**按「场景:灯组:部位:步骤:层」记住，切走再切回来还在。
 *
 * 判据是 #154 的三条之一：**给一层效果 → 切类型 → 改参数 → 回读当前值**，全部
 * 是纯函数，不需要页面、不需要 `wx`、不需要设备。
 *
 * ## 参数控件定义只有一份
 *
 * 这一层**不新增**任何键表：滑块与选项列表完全来自 `effect-panel` 的
 * `SLIDER_KEYS` / `CHOICE_KEYS`，视图里的读数来自 `sliderView` / `choiceView`。
 *
 * ## v5 的要点
 *
 * 一个部位在场景里的一步有**两层**（`layer0` / `layer1`），混合方式由「叠加层
 * 是否为空」推出（§6.2），不在线上。所以这一层有「第几层」这个维度，但**没有**
 * 分区、方案槽位、叠加方式这些 v4 概念。
 *
 * 纯函数、不碰 wx / BLE / 页面。
 */

import {
  HUE_RAMP_GRADIENT,
  OVERLAY_CHOICE_OPTIONS,
  PANEL_EMPTY_STEP_GUIDE,
  PANEL_NO_STEP_GUIDE,
  PANEL_OFF_NOTICE,
  applyChoice,
  applySlider,
  buildEffectPanel,
  defaultParams,
  emptyLayer,
  emptyOverlayDraft,
  isPanelChoiceKey,
  isPanelSliderKey,
  layerIsEmpty,
  layersCheck,
  overlayDraftOf,
  overlayEnabled,
  overlayLayer,
  overlaySummary,
  panelCheck,
  panelLayer,
  panelTypeOf,
  paramsFromLayer,
  switchOverlayType,
  switchPanelType,
  type EffectParams,
  type EffectPanelView,
  type OverlayChoice,
  type OverlayDraft,
  type PanelChoiceKey,
  type PanelChoiceView,
  type PanelSliderView,
  type PanelType,
  type PanelTypeView,
} from "./effect-panel";
import type { EffectLayer } from "../protocol/types";

/**
 * 面板现在编辑的是哪一层。
 *
 * `layer` 0 = 底层（必有内容），1 = 叠加层（可以为空层）。
 */
export interface PanelTarget {
  sceneId: number;
  stripId: number;
  partId: number;
  stepIndex: number;
  layer: 0 | 1;
}

/** 面板的全部交互状态。 */
export interface PanelUnit {
  /** `scene:strip:part:step:layer`；变化时才从设备读回重读层。 */
  key: string;
  /** 当前效果类型（同时决定参数区里有哪几个控件）。 */
  mode: PanelType;
  /** 本地参数草稿（颜色与亮度跨类型保留）。 */
  params: EffectParams;
  /** 叠加层草稿：跟随 `key`，与主效果参数互相独立。 */
  overlay: OverlayDraft;
  /**
   * 逐目标的亮度草稿（`key → level`）。
   *
   * 只记**用户刚拖过、但还没写进草稿**的值，用于跨「切步骤再切回来」不丢。
   */
  levels: Record<string, number>;
  /** 一次性反馈（写入失败原因）；换目标时清空。 */
  hint: string;
}

/** 面板派生出的 `setData` 片段（键名与页面数据键一致，页面直接展开）。 */
export interface PanelUnitView {
  panelTypes: PanelTypeView[];
  panelType: PanelType;
  panelSliders: PanelSliderView[];
  panelChoices: PanelChoiceView[];
  panelColorHex: string;
  panelSummary: string;
  panelNotice: string;
  panelHasLayer: boolean;
  panelGuide: string;
  hueRamp: string;
  panelHint: string;
  /* ---- 叠加层（第二层） ---- */
  overlayChoices: typeof OVERLAY_CHOICE_OPTIONS;
  overlayChoice: OverlayChoice;
  overlayEnabled: boolean;
  overlaySummary: string;
  overlaySliders: PanelSliderView[];
  overlayChoices2: PanelChoiceView[];
  overlayColorHex: string;
}

/** 派生视图需要从页面拿的两件事（面板单元不读设备模型，避免与页面耦合）。 */
export interface PanelUnitContext {
  /** 是否已经读到了这一层（设备未连接 / 读取失败时为 false）。 */
  hasLayer: boolean;
}

/** 空面板：常亮 + 默认参数 + 无叠加层。 */
export function createPanelUnit(): PanelUnit {
  return {
    key: "",
    mode: "static",
    params: defaultParams("static"),
    overlay: emptyOverlayDraft(),
    levels: {},
    hint: "",
  };
}

/** 面板的目标键（唯一性来自这五个维度）。 */
export function panelUnitKey(target: PanelTarget): string {
  return `${target.sceneId}:${target.stripId}:${target.partId}:${target.stepIndex}:${target.layer}`;
}

/** 当前参数草稿（只读语义：调用方不要就地改）。 */
export function panelUnitParams(unit: PanelUnit): EffectParams {
  return unit.params;
}

/**
 * 换目标：**只在键变化时**从读回的那一层重新读值。
 *
 * 键没变时原样返回：拖动中的读数不该被一次重画冲掉。
 * `layer` 为 `null`（这一层读不到）时回到常亮默认值——面板上没有可编辑的东西。
 *
 * 这个入口只管「主效果那一个层」，**不碰叠加层草稿**；页面拿到整步快照时用
 * `selectPanelStep` 一次把两层都读回来。
 */
export function selectPanelTarget(
  unit: PanelUnit,
  target: PanelTarget,
  layer: EffectLayer | null,
): PanelUnit {
  const key = panelUnitKey(target);
  if (key === unit.key) {
    return unit;
  }
  let mode: PanelType;
  let params: EffectParams;
  const empty = layer === null || layerIsEmpty(layer);
  if (empty) {
    mode = "static";
    params = defaultParams("static");
  } else {
    mode = panelTypeOf((layer as EffectLayer).type);
    params = paramsFromLayer(mode, layer as EffectLayer);
  }
  /* 还没写进草稿的滑块值：按目标记着，切回来还在。 */
  const remembered = unit.levels[key];
  if (remembered !== undefined) {
    params = { ...params, level: remembered };
  }
  return { ...unit, key, mode, params, hint: "" };
}

/**
 * 换目标并一次读回**这一步的两层**（页面拿 `SceneStepReport` 后调它）。
 *
 * 「主效果」永远是 `layer0`（协议：底层不得为空），叠加层是 `layer1`。
 * `step` 为 `null`（还没读到这一步）时两层都回到空态。
 */
export function selectPanelStep(
  unit: PanelUnit,
  target: PanelTarget,
  step: { layer0: EffectLayer; layer1: EffectLayer } | null,
): PanelUnit {
  const primary = selectPanelTarget(
    unit,
    { ...target, layer: 0 },
    step === null ? null : step.layer0,
  );
  /* 键没变（同一目标重画）时两层都不该被重读冲掉——拖动中的读数才是用户的意图。 */
  if (primary === unit) {
    return unit;
  }
  const overlay = step === null ? emptyOverlayDraft() : overlayDraftOf(step.layer1);
  return { ...primary, overlay };
}

/** 面板的一次性反馈（与 `data.panelHint` 一起写，重画时不会又冒出来 / 又消失）。 */
export function setPanelUnitHint(unit: PanelUnit, text: string): PanelUnit {
  if (text === unit.hint) {
    return unit;
  }
  return { ...unit, hint: text };
}

/**
 * 忘掉「现在编辑哪一层」，下一次派生会从读回的值重读。
 *
 * 与 `resetPanelUnit` 的区别：**保留**亮度记忆与叠加层草稿。
 */
export function forgetPanelTarget(unit: PanelUnit): PanelUnit {
  return unit.key === "" ? unit : { ...unit, key: "" };
}

/** 面板草稿回到「常亮 + 默认色」，并清掉亮度记忆与反馈。 */
export function resetPanelUnit(_unit: PanelUnit): PanelUnit {
  return createPanelUnit();
}

/* ---------------- 切换类型 / 改参数 ---------------- */

/**
 * 切换效果类型：保留颜色与亮度，其余回到新类型的默认值。
 *
 * 类型没变时返回同一个状态（不产生多余刷新）。
 */
export function switchPanelMode(unit: PanelUnit, type: PanelType): PanelUnit {
  if (type === unit.mode) {
    return unit;
  }
  return { ...unit, mode: type, params: switchPanelType(unit.params, unit.mode, type) };
}

/** 改一个滑块；非法键 / 非有限值原样返回。 */
export function applyPanelSliderValue(unit: PanelUnit, key: string, value: number): PanelUnit {
  if (!isPanelSliderKey(key) || !Number.isFinite(value)) {
    return unit;
  }
  const params = applySlider(unit.params, key, value);
  /* 亮度按目标记一份：还没落进草稿就切走时，回来还能看到自己拖到的值。 */
  const levels =
    key === "level" && unit.key.length > 0
      ? { ...unit.levels, [unit.key]: params.level }
      : unit.levels;
  return { ...unit, params, levels };
}

/** 改一个选择控件（波形 / 方向 / 占空比 / 脉冲）；非法键 / 非有限值原样返回。 */
export function applyPanelChoiceValue(unit: PanelUnit, key: string, value: number): PanelUnit {
  if (!isPanelChoiceKey(key) || !Number.isFinite(value)) {
    return unit;
  }
  const params = applyChoice(unit.params, key, value);
  return params === unit.params ? unit : { ...unit, params };
}

/** 选叠加层类型（「关闭」或某个效果）；非法值原样返回。 */
export function applyOverlayChoiceValue(unit: PanelUnit, next: OverlayChoice): PanelUnit {
  if (!OVERLAY_CHOICE_OPTIONS.some((option) => option.value === next)) {
    return unit;
  }
  const overlay = switchOverlayType(unit.overlay, next);
  return overlay === unit.overlay ? unit : { ...unit, overlay };
}

/** 改叠加层的一个滑块；没打开叠加层时原样返回。 */
export function applyOverlaySliderValue(unit: PanelUnit, key: string, value: number): PanelUnit {
  if (!isPanelSliderKey(key) || !Number.isFinite(value) || !overlayEnabled(unit.overlay)) {
    return unit;
  }
  const params = applySlider(unit.overlay.params, key, value);
  return { ...unit, overlay: { ...unit.overlay, params } };
}

/**
 * 改叠加层的一个选择项（波形 / 方向 / 占空比 / 脉冲）。
 *
 * 与滑块不同，这里**不要求叠加层已打开**：关闭状态下改参数是空操作（装配时
 * 叠空层），但参数本身要留住——用户再开回来看到的还是自己调过的样子。
 */
export function applyOverlayChoiceParam(unit: PanelUnit, key: string, value: number): PanelUnit {
  if (!isPanelChoiceKey(key) || !Number.isFinite(value)) {
    return unit;
  }
  const params = applyChoice(unit.overlay.params, key, value);
  if (params === unit.overlay.params) {
    return unit;
  }
  return { ...unit, overlay: { ...unit.overlay, params } };
}

/* ---------------- 派生成视图 ---------------- */

/** 叠加层的参数滑块：关闭时给空列表（不是一堆灰色旋钮）。 */
function overlaySliders(draft: OverlayDraft): PanelSliderView[] {
  if (!overlayEnabled(draft)) {
    return [];
  }
  return buildEffectPanel(draft.type as PanelType, draft.params).sliders;
}

/** 叠加层的选择控件（波形 / 方向 / 占空比 / 脉冲），与滑块同源。 */
function overlayChoiceViews(draft: OverlayDraft): PanelChoiceView[] {
  if (!overlayEnabled(draft)) {
    return [];
  }
  return buildEffectPanel(draft.type as PanelType, draft.params).choices;
}

/** 当前类型的那一份视图（类型行 / 滑块 / 选项 / 摘要 / 说明）。 */
function currentView(unit: PanelUnit): EffectPanelView {
  return buildEffectPanel(unit.mode, unit.params);
}

/**
 * 面板的完整派生（页面 `setData` 的片段）。
 *
 * 没读到这一层时**不留任何滑块 / 选择控件**：用户不该看到一个改不动的旋钮，
 * 引导文字会告诉他下一步做什么。预览色块与摘要也一起消失——没有目标时的
 * 「常亮 · 40°」是一句凭空捏造的描述。
 */
export function panelUnitView(unit: PanelUnit, context: PanelUnitContext): PanelUnitView {
  const view = currentView(unit);
  const hasLayer = context.hasLayer;
  const overlayOn = hasLayer && overlayEnabled(unit.overlay);
  return {
    panelTypes: view.types,
    panelType: view.type,
    panelSliders: hasLayer ? view.sliders : [],
    panelChoices: hasLayer ? view.choices : [],
    panelColorHex: hasLayer ? view.colorHex : "",
    panelSummary: hasLayer ? view.summary : "",
    /* 「熄灭」没有任何旋钮：说明必须跟着目标一起出现 / 消失。 */
    panelNotice: hasLayer ? view.notice : "",
    panelHasLayer: hasLayer,
    panelGuide: hasLayer ? "" : PANEL_NO_STEP_GUIDE,
    hueRamp: HUE_RAMP_GRADIENT,
    panelHint: unit.hint,
    overlayChoices: hasLayer ? OVERLAY_CHOICE_OPTIONS : [],
    overlayChoice: unit.overlay.type,
    overlayEnabled: overlayOn,
    overlaySummary: hasLayer ? overlaySummary(unit.overlay) : "",
    overlaySliders: hasLayer ? overlaySliders(unit.overlay) : [],
    overlayChoices2: hasLayer ? overlayChoiceViews(unit.overlay) : [],
    overlayColorHex: overlayOn
      ? buildEffectPanel(unit.overlay.type as PanelType, unit.overlay.params).colorHex
      : "",
  };
}

/* ---------------- 落进两层 ---------------- */

/**
 * 面板草稿 → 这一步的**两层**（可直接塞进 `setSceneStep`）。
 *
 * 装配规则只有一份：
 *  - `layer0` 由主效果草稿编码（`panelLayer`）；
 *  - `layer1` 由叠加层草稿编码，关闭时是空层（`type = 0xFF`，其余字段全 0）；
 *  - 叠加层为空 → 设备按「覆盖」合成；非空 → 按亮度叠加（§6.2，不在线上）。
 *
 * 返回的对象**不共享**面板的状态：调用方可以安全地改它。
 */
export function panelUnitLayers(unit: PanelUnit): { layer0: EffectLayer; layer1: EffectLayer } {
  return { layer0: panelLayer(unit.mode, unit.params), layer1: overlayLayer(unit.overlay) };
}

/**
 * 本地预检：主效果与叠加层一起过（两层都是真实帧内容，越界一样会被设备拒）。
 *
 * 返回第一个越界原因；调用方据此**不发帧**并把原因显示出来。
 */
export function panelUnitCheck(unit: PanelUnit): { ok: boolean; message: string } {
  const primary = panelCheck(unit.mode, unit.params);
  if (!primary.ok) {
    return primary;
  }
  return layersCheck([overlayLayer(unit.overlay)]);
}

/* ---------------- 空态文案 ---------------- */

/** 空态引导（页面直接显示 `panelGuide`；这里再导出一次便于测试引用）。 */
export const PANEL_GUIDES = {
  noStep: PANEL_NO_STEP_GUIDE,
  emptyStep: PANEL_EMPTY_STEP_GUIDE,
  offNotice: PANEL_OFF_NOTICE,
} as const;

/** 一个未使用的层（叠加层「关闭」时的形状），供页面与测试断言引用。 */
export function emptyPanelLayer(): EffectLayer {
  return emptyLayer();
}

/** 代理导出：页面只需要从这一层认一个入口。 */
export type { EffectLayer, PanelChoiceKey };
