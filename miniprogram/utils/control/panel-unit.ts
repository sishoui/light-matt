/**
 * 效果面板单元（#154）：把「一层（或两层）灯效的参数编辑」从灯组详情页抽出来。
 *
 * ## 这一层守的是什么
 *
 * 面板有三条容易被抄歪的规则：
 *
 *  1. **参数区按类型整体替换**——用哪几个旋钮由 `SLIDER_KEYS` / `CHOICE_KEYS`
 *     决定，页面不写任何按类型的条件渲染；
 *  2. **换目标时从草稿重新读层**，但**同一目标重画时不重读**（否则拖动中的
 *     读数会被一次 setData 冲掉）；
 *  3. **还没下发的亮度**按「方案:步骤:分区」记住，切走再切回来还在。
 *
 * 以前这三条和页面生命周期缠在一起，只能通过加载整页才能在 Node 里验。现在
 * 状态收进一个普通对象，`给一层效果 → 切类型 → 改参数 → 回读当前值` 全部是
 * 纯函数，不需要页面、不需要 `wx`、不需要设备。
 *
 * ## 参数控件定义只有一份
 *
 * 这一层**不新增**任何键表：滑块与选项列表完全来自 `effect-panel` 的
 * `SLIDER_KEYS` / `CHOICE_KEYS`，视图里的读数来自 `sliderView` / `choiceView`。
 * 简单档与进阶档的两张卡继续共用同一张 wxml 模板（`effect-controls`）。
 *
 * 纯函数、不碰 wx / BLE / 页面。
 */

import {
  OVERLAY_CHOICE_OPTIONS,
  HUE_RAMP_GRADIENT,
  PANEL_EMPTY_PLAN_GUIDE,
  PANEL_EMPTY_STEP_GUIDE,
  PANEL_FACTS,
  PANEL_NO_ZONE_GUIDE,
  applyChoice,
  applyPanelToZone,
  applySlider,
  buildEffectPanel,
  defaultParams,
  emptyOverlayDraft,
  isPanelChoiceKey,
  isPanelSliderKey,
  layersCheck,
  overlayDraftOf,
  overlayEnabled,
  overlayLayer,
  overlaySummary,
  panelCheck,
  panelTypeOf,
  paramsFromLayer,
  switchOverlayType,
  switchPanelType,
  type EffectPanelView,
  type EffectParams,
  type OverlayChoice,
  type OverlayDraft,
  type PanelChoiceView,
  type PanelSliderView,
  type PanelType,
  type PanelTypeView,
} from "./effect-panel";
import type { SegmentSpec } from "../protocol/types";

/** 面板现在编辑的是哪一片（方案槽位 × 步骤 × 分区）。 */
export interface PanelTarget {
  planSlot: number;
  stepIndex: number;
  /** 分区槽位；-1 = 还没选中任何分区。 */
  segId: number;
}

/** 面板的全部交互状态。 */
export interface PanelUnit {
  /** `planSlot:stepIndex:segId`；变化时才从草稿重读层。 */
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
   * 只记**用户刚拖过、但还没写进草稿**的值，用于跨「切分区再切回来」不丢。
   */
  levels: Record<string, number>;
  /** 一次性反馈（写入失败原因）；换目标时清空。 */
  hint: string;
}

/** 面板派生出的 `setData` 片段（键名与页面历史数据键一致，页面直接展开）。 */
export interface PanelUnitView {
  panelTypes: PanelTypeView[];
  panelType: PanelType;
  panelSliders: PanelSliderView[];
  panelChoices: PanelChoiceView[];
  panelColorHex: string;
  panelSummary: string;
  panelNotice: string;
  panelHasZone: boolean;
  panelGuide: string;
  panelFacts: readonly string[];
  hueRamp: string;
  panelHint: string;
  /* ---- 特效层（第二张卡）：没有分区时整块隐藏 ---- */
  overlayChoices: typeof OVERLAY_CHOICE_OPTIONS;
  overlayChoice: OverlayChoice;
  overlayEnabled: boolean;
  overlaySummary: string;
  overlaySlider: PanelSliderView[];
  overlayChoices2: PanelChoiceView[];
  overlayColorHex: string;
}

/** 派生视图需要从页面拿的两件事（面板单元不读草稿，避免与页面模型耦合）。 */
export interface PanelUnitContext {
  /** 当前步骤里当前灯组的分区数。 */
  zoneCount: number;
  /** 是否选中了其中一个分区。 */
  hasZone: boolean;
  /** 当前方案是否完全没有内容（引导文案三选一的依据）。 */
  planEmpty: boolean;
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

/** 面板的目标键（唯一性来自这三个维度）。 */
export function panelUnitKey(target: PanelTarget): string {
  return `${target.planSlot}:${target.stepIndex}:${target.segId}`;
}

/** 当前参数草稿（只读语义：调用方不要就地改）。 */
export function panelUnitParams(unit: PanelUnit): EffectParams {
  return unit.params;
}

/**
 * 换目标：**只在键变化时**从草稿重读那一层的值。
 *
 * 键没变时原样返回：拖动中的读数不该被一次重画冲掉。
 * `zone` 为 `null`（没有选中分区）时回到常亮默认值——面板上没有可编辑的东西。
 */
export function selectPanelTarget(
  unit: PanelUnit,
  target: PanelTarget,
  zone: SegmentSpec | null,
): PanelUnit {
  const key = panelUnitKey(target);
  if (key === unit.key) {
    return unit;
  }
  let mode: PanelType;
  let params: EffectParams;
  let overlay: OverlayDraft;
  if (zone === null) {
    mode = "static";
    params = defaultParams("static");
    overlay = emptyOverlayDraft();
  } else {
    mode = panelTypeOf(zone.layer0.type);
    params = paramsFromLayer(mode, zone.layer0);
    /* 叠加层从设备权威值还原（空层 → 关闭）。混合方式恒为按亮度叠加。 */
    overlay = overlayDraftOf(zone.layer1);
  }
  /* 还没写进草稿的滑块值：按目标记着，切回来还在。 */
  const remembered = unit.levels[key];
  if (remembered !== undefined) {
    params = { ...params, level: remembered };
  }
  return { ...unit, key, mode, params, overlay, hint: "" };
}

/** 面板的一次性反馈（与 `data.panelHint` 一起写，重画时不会又冒出来 / 又消失）。 */
export function setPanelUnitHint(unit: PanelUnit, text: string): PanelUnit {
  if (text === unit.hint) {
    return unit;
  }
  return { ...unit, hint: text };
}

/**
 * 忘掉「现在编辑哪一片」，下一次派生会从草稿重读那一层的值。
 *
 * 与 `resetPanelUnit` 的区别：**保留**亮度记忆与叠加层。草稿被整体换掉（换方案、
 * 从存储重读、灯珠数被别处改小）时用这个——目标是新的，但用户拖过还没落盘的
 * 亮度仍然有效。
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
 * 没有可编辑分区时**不留任何滑块 / 选择控件**：用户不该看到一个改不动的旋钮，
 * 引导文字会告诉他下一步做什么。预览色块与摘要也一起消失——没有目标时的
 * 「常亮 · 40°」是一句凭空捏造的描述。
 */
export function panelUnitView(unit: PanelUnit, context: PanelUnitContext): PanelUnitView {
  const view = currentView(unit);
  const hasZone = context.hasZone;
  const overlayOn = hasZone && overlayEnabled(unit.overlay);
  return {
    panelTypes: view.types,
    panelType: view.type,
    panelSliders: hasZone ? view.sliders : [],
    panelChoices: hasZone ? view.choices : [],
    panelColorHex: hasZone ? view.colorHex : "",
    panelSummary: hasZone ? view.summary : "",
    /* 「熄灭」没有任何旋钮：说明必须跟着分区一起出现 / 消失。 */
    panelNotice: hasZone ? view.notice : "",
    panelHasZone: hasZone,
    panelGuide: hasZone
      ? ""
      : context.zoneCount > 0
        ? PANEL_NO_ZONE_GUIDE
        : context.planEmpty
          ? PANEL_EMPTY_PLAN_GUIDE
          : PANEL_EMPTY_STEP_GUIDE,
    panelFacts: PANEL_FACTS,
    hueRamp: HUE_RAMP_GRADIENT,
    panelHint: unit.hint,
    overlayChoices: hasZone ? OVERLAY_CHOICE_OPTIONS : [],
    overlayChoice: unit.overlay.type,
    overlayEnabled: overlayOn,
    overlaySummary: hasZone ? overlaySummary(unit.overlay) : "",
    overlaySlider: hasZone ? overlaySliders(unit.overlay) : [],
    overlayChoices2: hasZone ? overlayChoiceViews(unit.overlay) : [],
    overlayColorHex: overlayOn
      ? buildEffectPanel(unit.overlay.type as PanelType, unit.overlay.params).colorHex
      : "",
  };
}

/* ---------------- 落进草稿 ---------------- */

/**
 * 把面板草稿写进「当前分区」那一片，别的分区一字不动。
 *
 * 装配走 `applyPanelToZone` → `buildZoneSpec`：叠加层为空时叠加方式归一为
 * 覆盖、两层定宽、深拷贝——面板只改效果，不顺手把叠加层弄丢。
 *
 * 没有选中分区 / 分区不在了时**返回原数组**（引用相等 = 什么都不用写）。
 */
export function panelUnitZoneSpecs(
  unit: PanelUnit,
  zones: readonly SegmentSpec[],
  segId: number,
): SegmentSpec[] {
  if (!Number.isInteger(segId) || segId < 0) {
    return zones as SegmentSpec[];
  }
  if (!zones.some((zone) => zone.segId === segId)) {
    return zones as SegmentSpec[];
  }
  return applyPanelToZone(zones, segId, unit.mode, unit.params, unit.overlay);
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
