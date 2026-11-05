/**
 * 进阶档效果面板（#67 / #80）的纯逻辑。
 *
 * 五类断言，全部对应票面里「用户看得见」的规则：
 *  1. **参数区按类型整体替换**：七种类型各自只出现自己用得上的旋钮，
 *     **没有任何一个当前类型用不上的旋钮**（熄灭只有一行说明，没有旋钮）；
 *  2. **切换类型保留颜色与亮度，其余回到新类型默认值**；
 *  3. **滑块刻度 ↔ 协议值**（色相度 / 饱和度百分比 / 周期秒 / 频率 Hz /
 *     节奏 BPM / 最低亮 / 跨度 / 尾长），以及右侧「数值 + 单位」的格式；
 *  4. **装配分区**：叠加层为空时叠加方式归一、只改选中那一个、别的分区一字不动；
 *  5. **本地预检**：频率过快、节奏过快或过慢都在本机拦住，不发帧；
 *     以及两条必须告知的事实与空态引导文案存在且不含禁用术语。
 */

import { describe, expect, it } from "vitest";
import {
  applyChoice,
  applyPanelToZone,
  applySlider,
  buildEffectPanel,
  buildTypeViews,
  clampPeriodMs,
  clampSliderValue,
  defaultParams,
  DUTY_OPTIONS,
  FREQUENCY_MAX,
  BPM_MAX,
  heartbeatPeriodMs,
  HUE_RAMP_GRADIENT,
  isPanelSliderKey,
  layerCheck,
  layersCheck,
  normalizeParams,
  PANEL_EMPTY_PLAN_GUIDE,
  PANEL_EMPTY_STEP_GUIDE,
  PANEL_FACTS,
  PANEL_NO_ZONE_GUIDE,
  PANEL_OFF_NOTICE,
  PANEL_OVERLAY_TYPE_OPTIONS,
  PANEL_TYPE_OPTIONS,
  panelCheck,
  panelLayer,
  panelSummary,
  panelTypeOf,
  panelTypeValue,
  paramsFromLayer,
  emptyOverlayDraft,
  overlayDraftOf,
  overlayEnabled,
  overlayLayer,
  overlaySummary,
  switchOverlayType,
  OVERLAY_BLEND_OPTIONS,
  OVERLAY_CHOICE_OPTIONS,
  type OverlayDraft,
  sliderView,
  SLIDER_KEYS,
  strobePeriodMs,
  switchPanelType,
  type EffectParams,
  type PanelType,
} from "../utils/control/effect-panel";
import {
  BLEND,
  FLICKER_MIN_PERIOD_MS,
  HEARTBEAT_MIN_PERIOD_MS,
  NO_EFFECT,
  SEGMENT_TYPE,
  STROBE_MIN_PERIOD_MS,
  WAVEFORM,
} from "../utils/protocol/constants";
import { cmdSetSegment } from "../utils/protocol/commands";
import { buildZoneSpec } from "../utils/control/zone-model";
import type { EffectLayer, SegmentSpec } from "../utils/protocol/types";

function params(overrides: Partial<EffectParams> = {}): EffectParams {
  return { ...defaultParams("static"), ...overrides };
}

function layer(type: number, overrides: Partial<EffectLayer> = {}): EffectLayer {
  return {
    type,
    hue: 0,
    sat: 0,
    periodMs: 0,
    p5: 0,
    flags: 0,
    /* 空层的 level 必须为 0；非空层默认满亮。 */
    level: type === NO_EFFECT ? 0 : 100,
    ...overrides,
  };
}

function zone(segId: number, overrides: Partial<SegmentSpec> = {}): SegmentSpec {
  return buildZoneSpec({
    stripId: 0,
    segId,
    start: segId * 10,
    end: segId * 10 + 9,
    blend: BLEND.OVER,
    layer0: layer(SEGMENT_TYPE.STATIC, { hue: 7281, sat: 255 }),
    layer1: null,
    ...overrides,
  });
}

describe("效果类型行", () => {
  it("类型按钮的名字不带颜色，「熄灭」显示为「空」（#100）", () => {
    expect(PANEL_TYPE_OPTIONS.map((option) => option.name)).toEqual([
      "常亮",
      "呼吸",
      "彩虹",
      "流星",
      "爆闪",
      "心跳",
      "随机闪烁",
      "空",
    ]);
    expect(PANEL_TYPE_OPTIONS.map((option) => option.type)).toEqual([
      "static",
      "breathing",
      "rainbow",
      "comet",
      "strobe",
      "heartbeat",
      "flicker",
      "off",
    ]);
    /* 界面上不出现「熄灭」「静态」「流光」这几个旧词。 */
    const names = PANEL_TYPE_OPTIONS.map((option) => option.name);
    expect(names).not.toContain("熄灭");
    expect(names).not.toContain("静态");
    expect(names).not.toContain("流光");
  });

  it("只有当前类型是高亮的", () => {
    const views = buildTypeViews("rainbow");
    expect(views.filter((view) => view.selected).map((view) => view.type)).toEqual(["rainbow"]);
    expect(views).toHaveLength(8);
  });

  it("类型与协议枚举一一对应（空层按静态、未知按静态）", () => {
    expect(panelTypeValue("static")).toBe(SEGMENT_TYPE.STATIC);
    expect(panelTypeValue("breathing")).toBe(SEGMENT_TYPE.BREATHING);
    expect(panelTypeValue("rainbow")).toBe(SEGMENT_TYPE.RAINBOW);
    expect(panelTypeValue("comet")).toBe(SEGMENT_TYPE.COMET);
    expect(panelTypeValue("strobe")).toBe(SEGMENT_TYPE.STROBE);
    expect(panelTypeValue("heartbeat")).toBe(SEGMENT_TYPE.HEARTBEAT);
    expect(panelTypeValue("off")).toBe(SEGMENT_TYPE.OFF);
    /* 空层（0xFF）不是「熄灭」：它表示这里没有效果，界面仍按静态显示。 */
    expect(panelTypeOf(NO_EFFECT)).toBe("static");
    expect(panelTypeOf(SEGMENT_TYPE.OFF)).toBe("off");
    expect(panelTypeOf(0x42)).toBe("static");
  });
});

describe("参数区按类型整体替换", () => {
  it("静态正好三项：色相 / 饱和度 / 亮度", () => {
    const view = buildEffectPanel("static", params());
    expect(view.sliders.map((slider) => slider.key)).toEqual(["hue", "sat", "level"]);
    expect(view.choices).toEqual([]);
    expect(view.sliders.map((slider) => slider.label)).toEqual(["色相", "饱和度", "亮度"]);
  });

  it("呼吸在静态三项之后多出周期与最低亮，另有波形选择", () => {
    const view = buildEffectPanel("breathing", params());
    expect(view.sliders.map((slider) => slider.key)).toEqual([
      "hue",
      "sat",
      "level",
      "period",
      "minLevel",
    ]);
    expect(view.choices.map((choice) => choice.key)).toEqual(["waveform"]);
    expect(view.choices[0].options.map((option) => option.label)).toEqual([
      "正弦",
      "三角",
      "锯齿",
      "方波",
    ]);
  });

  it("彩虹没有颜色与亮度滑块，只有周期 / 跨度 + 方向", () => {
    const view = buildEffectPanel("rainbow", params());
    expect(view.sliders.map((slider) => slider.key)).toEqual(["period", "span"]);
    expect(view.choices.map((choice) => choice.key)).toEqual(["direction"]);
    expect(view.choices[0].options.map((option) => option.label)).toEqual(["正转", "反转"]);
  });

  it("流光是色相 / 饱和度 / 亮度 + 周期 / 尾长 + 方向", () => {
    const view = buildEffectPanel("comet", params());
    expect(view.sliders.map((slider) => slider.key)).toEqual([
      "hue",
      "sat",
      "level",
      "period",
      "tail",
    ]);
    expect(view.choices.map((choice) => choice.key)).toEqual(["direction"]);
  });

  it("爆闪是色相 / 饱和度 / 频率 / 亮度，外加占空比三档", () => {
    const view = buildEffectPanel("strobe", params());
    expect(view.sliders.map((slider) => slider.key)).toEqual([
      "hue",
      "sat",
      "frequency",
      "level",
    ]);
    expect(view.sliders.map((slider) => slider.label)).toEqual([
      "色相",
      "饱和度",
      "频率",
      "亮度",
    ]);
    expect(view.choices.map((choice) => choice.key)).toEqual(["duty"]);
    expect(view.choices[0].label).toBe("占空比");
    expect(view.choices[0].options.map((option) => option.label)).toEqual(["窄", "中", "宽"]);
    /* 三档对应的协议值就是 effects-spec §2.5 的 ≈40 / 90 / 153。 */
    expect(DUTY_OPTIONS.map((option) => option.value)).toEqual([40, 90, 153]);
  });

  it("心跳是色相 / 饱和度 / 节奏 / 亮度，没有周期与波形", () => {
    const view = buildEffectPanel("heartbeat", params());
    expect(view.sliders.map((slider) => slider.key)).toEqual(["hue", "sat", "bpm", "level"]);
    expect(view.sliders.map((slider) => slider.label)).toEqual([
      "色相",
      "饱和度",
      "节奏",
      "亮度",
    ]);
    expect(view.choices).toEqual([]);
  });

  it("熄灭一个旋钮都没有，只有一行「这里不亮」的说明", () => {
    const view = buildEffectPanel("off", params());
    expect(view.sliders).toEqual([]);
    expect(view.choices).toEqual([]);
    expect(view.notice).toBe(PANEL_OFF_NOTICE);
    expect(view.notice).toMatch(/黑|不亮|熄灭/);
    /* 预览色块也不给：它会让用户以为这一片是那个颜色。 */
    expect(view.colorHex).toBe("");
  });

  it("其余类型的 notice 为空（说明只属于熄灭）", () => {
    for (const type of PANEL_TYPE_OPTIONS.map((option) => option.type)) {
      if (type === "off") {
        continue;
      }
      expect(buildEffectPanel(type, params()).notice, type).toBe("");
    }
  });

  it("熄灭的说明不是一句协议术语（不出现毫秒 / 段 / 阶段 / 剧本 / 下发 / 激活 / 层）", () => {
    expect(PANEL_OFF_NOTICE).not.toMatch(/毫秒|段|阶段|剧本|下发|激活|层/);
  });

  it("用户永远看不到当前类型用不上的旋钮（逐个类型穷举）", () => {
    const allowed: Record<PanelType, string[]> = {
      static: ["hue", "sat", "level"],
      breathing: ["hue", "sat", "level", "period", "minLevel"],
      rainbow: ["period", "span"],
      comet: ["hue", "sat", "level", "period", "tail"],
      strobe: ["hue", "sat", "frequency", "level"],
      heartbeat: ["hue", "sat", "bpm", "level"],
      flicker: ["hue", "sat", "level", "period", "density"],
      off: [],
    };
    for (const type of PANEL_TYPE_OPTIONS.map((option) => option.type)) {
      const keys = buildEffectPanel(type, params()).sliders.map((slider) => slider.key);
      expect(keys, type).toEqual(allowed[type]);
      expect(SLIDER_KEYS[type], type).toEqual(allowed[type]);
    }
  });

  it("彩虹不显示亮度滑块（它自己循环变色、没有单一亮度可调）", () => {
    expect(buildEffectPanel("rainbow", params()).sliders.some((s) => s.key === "level")).toBe(false);
  });
});

describe("切换类型：保留颜色，其余按新类型默认值", () => {
  const chosen = params({ hue: 40000, sat: 128, level: 42, periodMs: 4000, minLevel: 200, span: 90 });

  it("颜色（色相 / 饱和度）与亮度跨类型保留", () => {
    for (const type of PANEL_TYPE_OPTIONS.map((option) => option.type)) {
      const next = switchPanelType(chosen, "breathing", type);
      expect([next.hue, next.sat, next.level], type).toEqual([40000, 128, 42]);
    }
  });

  it("切到呼吸：周期 / 最低亮 / 波形取呼吸默认，跨度 / 尾长不带过来", () => {
    const next = switchPanelType(chosen, "static", "breathing");
    const defaults = defaultParams("breathing");
    expect(next.periodMs).toBe(defaults.periodMs);
    expect(next.minLevel).toBe(defaults.minLevel);
    expect(next.waveform).toBe(defaults.waveform);
    expect(next.span).toBe(defaults.span);
    expect(next.tail).toBe(defaults.tail);
  });

  it("切到彩虹：跨度与方向取彩虹默认，最低亮不再是呼吸那个值", () => {
    const next = switchPanelType(chosen, "breathing", "rainbow");
    const defaults = defaultParams("rainbow");
    expect(next.span).toBe(defaults.span);
    expect(next.reverse).toBe(defaults.reverse);
    expect(next.periodMs).toBe(defaults.periodMs);
    expect(next.minLevel).toBe(defaults.minLevel);
  });

  it("切到静态：周期归零（静态层协议要求 period 为 0）", () => {
    const next = switchPanelType(chosen, "comet", "static");
    expect(next.periodMs).toBe(0);
  });

  it("切到爆闪：频率 / 占空比取爆闪默认，周期归零（爆闪用频率字段）", () => {
    const next = switchPanelType(chosen, "comet", "strobe");
    const defaults = defaultParams("strobe");
    expect(next.periodMs).toBe(defaults.periodMs);
    expect(next.duty).toBe(defaults.duty);
    expect(next.duty).toBe(90);
    expect(next.bpm).toBe(defaults.bpm);
  });

  it("切到心跳：节奏取心跳默认（约 60 BPM 一带），其它参数按新类型", () => {
    const next = switchPanelType(chosen, "strobe", "heartbeat");
    const defaults = defaultParams("heartbeat");
    expect(next.bpm).toBe(defaults.bpm);
    /* 40-120 BPM 区间内，切过去就有一个能看见的心跳。 */
    expect(next.bpm).toBeGreaterThanOrEqual(40);
    expect(next.bpm).toBeLessThanOrEqual(120);
  });

  it("切到熄灭：颜色仍保留在草稿里（切回去不丢），但不再有任何旋钮", () => {
    const next = switchPanelType(chosen, "heartbeat", "off");
    expect([next.hue, next.sat]).toEqual([40000, 128]);
    const view = buildEffectPanel("off", next);
    expect(view.sliders).toEqual([]);
    expect(view.choices).toEqual([]);
  });

  it("动画类型的默认周期都高于协议下限（切过去立刻有动画）", () => {
    expect(defaultParams("breathing").periodMs).toBeGreaterThanOrEqual(334);
    expect(defaultParams("rainbow").periodMs).toBeGreaterThanOrEqual(200);
    expect(defaultParams("comet").periodMs).toBeGreaterThanOrEqual(200);
    /* #121：随机闪烁走 334 这条光敏线，默认周期不能是 0。 */
    expect(defaultParams("flicker").periodMs).toBeGreaterThanOrEqual(334);
  });

  it("类型没变时返回同一个对象（引用相等 = 什么都没变）", () => {
    expect(switchPanelType(chosen, "comet", "comet")).toBe(chosen);
  });

  it("越界的输入先被归一，不会被带进新类型", () => {
    const next = switchPanelType(params({ hue: 999999, sat: 900, level: 999 }), "static", "comet");
    expect(next.hue).toBeLessThan(0x10000);
    expect(next.sat).toBe(255);
    expect(next.level).toBe(100);
  });
});

describe("叠加层可选类型", () => {
  it("七个选项：常亮 / 呼吸 / 彩虹 / 流星 / 爆闪 / 心跳 / 随机闪烁", () => {
    expect(PANEL_OVERLAY_TYPE_OPTIONS.map((option) => option.type)).toEqual([
      "static",
      "breathing",
      "rainbow",
      "comet",
      "strobe",
      "heartbeat",
      "flicker",
    ]);
    expect(PANEL_OVERLAY_TYPE_OPTIONS.map((option) => option.name)).toEqual([
      "常亮",
      "呼吸",
      "彩虹",
      "流星",
      "爆闪",
      "心跳",
      "随机闪烁",
    ]);
  });

  it("没有熄灭（叠加一个「熄灭」等于什么都没做）", () => {
    expect(PANEL_OVERLAY_TYPE_OPTIONS.some((option) => option.type === "off")).toBe(false);
    expect(PANEL_OVERLAY_TYPE_OPTIONS).toHaveLength(PANEL_TYPE_OPTIONS.length - 1);
  });
});

describe("本地预检：越界不发帧", () => {
  it("爆闪频率超过 10Hz 被拦住，并给出人话原因", () => {
    const result = panelCheck("strobe", params({ frequencyHz: 12 }));
    expect(result.ok).toBe(false);
    expect(result.message).toContain("10");
    expect(result.message).toMatch(/频率|快/);
    /* 10Hz 是上界本身，合法。 */
    expect(panelCheck("strobe", params({ frequencyHz: 10 })).ok).toBe(true);
    expect(panelCheck("strobe", params({ frequencyHz: 1 })).ok).toBe(true);
  });

  it("心跳节奏过快或过慢都被拦住，40-120 BPM 之间放行", () => {
    expect(panelCheck("heartbeat", params({ bpm: 130 })).ok).toBe(false);
    expect(panelCheck("heartbeat", params({ bpm: 30 })).ok).toBe(false);
    for (const bpm of [40, 60, 120]) {
      expect(panelCheck("heartbeat", params({ bpm })).ok, String(bpm)).toBe(true);
    }
  });

  it("预检原因里不出现协议词（不用毫秒 / 频率字段名）", () => {
    for (const result of [
      panelCheck("strobe", params({ frequencyHz: 20 })),
      panelCheck("heartbeat", params({ bpm: 200 })),
      panelCheck("heartbeat", params({ bpm: 10 })),
    ]) {
      expect(result.message).not.toMatch(/毫秒|段|阶段|剧本|下发|激活|层|period/i);
    }
  });

  it("其余类型没有额外约束（合法的草稿一律放行）", () => {
    for (const type of ["static", "breathing", "rainbow", "comet", "off"] as PanelType[]) {
      expect(panelCheck(type, switchPanelType(params(), "static", type)).ok, type).toBe(true);
    }
  });

  it("层预检：写到设备前再拦一次（草稿可能来自读回 / 落盘，不只滑块）", () => {
    /* 爆闪 99ms 快过 10Hz（100ms）。 */
    expect(layerCheck(layer(SEGMENT_TYPE.STROBE, { periodMs: 99 })).ok).toBe(false);
    expect(layerCheck(layer(SEGMENT_TYPE.STROBE, { periodMs: 100 })).ok).toBe(true);
    /* 周期 0 = 静止，协议合法。 */
    expect(layerCheck(layer(SEGMENT_TYPE.STROBE, { periodMs: 0 })).ok).toBe(true);
    /* 心跳 500-1500ms。 */
    expect(layerCheck(layer(SEGMENT_TYPE.HEARTBEAT, { periodMs: 400 })).ok).toBe(false);
    expect(layerCheck(layer(SEGMENT_TYPE.HEARTBEAT, { periodMs: 1600 })).ok).toBe(false);
    expect(layerCheck(layer(SEGMENT_TYPE.HEARTBEAT, { periodMs: 1000 })).ok).toBe(true);
    /* 一组层里只要有越界的就整体拒绝，原因取第一条。 */
    const bad = layersCheck([
      layer(SEGMENT_TYPE.STATIC),
      layer(SEGMENT_TYPE.HEARTBEAT, { periodMs: 200 }),
    ]);
    expect(bad.ok).toBe(false);
    expect(bad.message).toMatch(/BPM/);
    expect(layersCheck([layer(SEGMENT_TYPE.STATIC), layer(SEGMENT_TYPE.COMET, { periodMs: 300 })]).ok).toBe(
      true,
    );
  });
});

describe("滑块刻度 ↔ 协议值", () => {
  it("色相：0-360 度 ↔ 0-65535，滑到哪就是哪个角度", () => {
    expect(applySlider(params(), "hue", 180).hue).toBe(0x8000);
    expect(applySlider(params(), "hue", 360).hue).toBe(0);
    expect(applySlider(params(), "hue", 0).hue).toBe(0);
    /* 任意值都能取到（不是只有几个档位）。 */
    const arbitrary = applySlider(params(), "hue", 137);
    expect(sliderView("hue", arbitrary).display).toBe("137°");
  });

  it("饱和度：0-100% ↔ 0-255", () => {
    expect(applySlider(params(), "sat", 50).sat).toBe(128);
    expect(applySlider(params(), "sat", 100).sat).toBe(255);
    expect(applySlider(params(), "sat", 0).sat).toBe(0);
    expect(sliderView("sat", params({ sat: 128 })).display).toBe("50%");
  });

  it("亮度：5-100%，读数带百分号", () => {
    expect(applySlider(params(), "level", 40).level).toBe(40);
    expect(sliderView("level", params({ level: 40 })).display).toBe("40%");
    /* 下限 5%：0 会让整组不出光，滑块不给这个位置。 */
    expect(sliderView("level", params()).min).toBe(5);
    expect(coerceLevel(-10)).toBe(5);
  });

  it("周期：滑块是秒，协议是毫秒；0 秒被抬到下限（0 = 静止，滑块不给）", () => {
    expect(applySlider(params(), "period", 2).periodMs).toBe(2000);
    expect(applySlider(params(), "period", 0).periodMs).toBe(500);
    expect(sliderView("period", params({ periodMs: 2500 })).display).toBe("2.5 秒");
  });

  it("最低亮：v4 起就是百分比 0-100；跨度 / 尾长仍是 0-255", () => {
    /* v4：呼吸的 p5 是相对百分比，滑块值原样写入（不再乘 255）。 */
    expect(applySlider(params(), "minLevel", 100).minLevel).toBe(100);
    expect(sliderView("minLevel", params({ minLevel: 50 })).display).toBe("50%");
    expect(sliderView("span", params({ span: 255 })).display).toBe("整圈");
    expect(sliderView("tail", params({ tail: 0 })).display).toBe("无拖尾");
  });

  it("滑块值越界 / 非有限值都被钳住（渲染层的数据不算可信）", () => {
    expect(clampSliderValue("hue", -30)).toBe(0);
    expect(clampSliderValue("hue", 900)).toBe(360);
    expect(clampSliderValue("sat", Number.NaN)).toBe(0);
    expect(clampSliderValue("level", 0)).toBe(5);
    expect(clampSliderValue("period", 99)).toBe(10);
    expect(clampPeriodMs(60_000)).toBe(10_000);
  });

  it("爆闪频率：滑块就是赫兹，读数带 Hz，拖动到底不超过 10", () => {
    const view = buildEffectPanel("strobe", params({ frequencyHz: 4 }));
    const frequency = view.sliders.find((slider) => slider.key === "frequency");
    expect(frequency?.display).toBe("4 Hz");
    expect(frequency?.max).toBe(10);
    expect(frequency?.min).toBe(1);
    expect(applySlider(params(), "frequency", 99).frequencyHz).toBe(10);
    expect(applySlider(params(), "frequency", 0).frequencyHz).toBe(1);
  });

  it("心跳节奏：滑块就是 BPM，读数带 BPM，区间 40-120", () => {
    const view = buildEffectPanel("heartbeat", params({ bpm: 72 }));
    const bpm = view.sliders.find((slider) => slider.key === "bpm");
    expect(bpm?.display).toBe("72 BPM");
    expect(bpm?.min).toBe(40);
    expect(bpm?.max).toBe(120);
    expect(applySlider(params(), "bpm", 500).bpm).toBe(120);
    expect(applySlider(params(), "bpm", 1).bpm).toBe(40);
  });

  it("占空比三档写入协议值（窄 40 / 中 90 / 宽 153）", () => {
    expect(applyChoice(params(), "duty", 40).duty).toBe(40);
    expect(applyChoice(params(), "duty", 90).duty).toBe(90);
    expect(applyChoice(params(), "duty", 153).duty).toBe(153);
    /* 只认这三档：其它值落到最近的合法档。 */
    expect(applyChoice(params(), "duty", 100).duty).toBe(90);
    expect(applyChoice(params(), "duty", 999).duty).toBe(153);
    /* 草稿里存着 90（中）时，占空比控件显示「中」。 */
    const view = buildEffectPanel("strobe", params({ duty: 90 }));
    expect(view.choices.find((choice) => choice.key === "duty")?.value).toBe(90);
  });

  it("面板的 key 白名单只认这九个滑块", () => {
    for (const key of [
      "hue",
      "sat",
      "level",
      "period",
      "minLevel",
      "span",
      "tail",
      "frequency",
      "bpm",
    ]) {
      expect(isPanelSliderKey(key), key).toBe(true);
    }
    expect(isPanelSliderKey("waveform")).toBe(false);
    expect(isPanelSliderKey("duty")).toBe(false);
    expect(isPanelSliderKey("blend")).toBe(false);
  });

  it("每次读数都带单位，色相用度、其余用百分号 / 秒 / Hz / BPM", () => {
    const view = buildEffectPanel("breathing", params({ periodMs: 2000, minLevel: 102 }));
    const display = Object.fromEntries(view.sliders.map((slider) => [slider.key, slider.display]));
    expect(display.hue).toMatch(/°$/);
    expect(display.sat).toMatch(/%$/);
    expect(display.level).toMatch(/%$/);
    expect(display.period).toMatch(/ 秒$/);
    expect(display.minLevel).toMatch(/%$/);
    const strobe = buildEffectPanel("strobe", params({ frequencyHz: 7 }));
    expect(strobe.sliders.find((slider) => slider.key === "frequency")?.display).toMatch(/Hz$/);
    const heartbeat = buildEffectPanel("heartbeat", params({ bpm: 60 }));
    expect(heartbeat.sliders.find((slider) => slider.key === "bpm")?.display).toMatch(/BPM$/);
  });
});

describe("草稿 → 协议层", () => {
  it("静态层：period / p5 / flags 全部为 0（协议硬约束），level 照常写入", () => {
    const built = panelLayer("static", params({ hue: 1234, sat: 200, periodMs: 3000 }));
    expect(built).toEqual({
      type: SEGMENT_TYPE.STATIC,
      hue: 1234,
      sat: 200,
      periodMs: 0,
      p5: 0,
      flags: 0,
      level: 100,
    });
    expect(panelLayer("static", params({ level: 30 })).level).toBe(30);
  });

  it("呼吸层：波形进 bit1-2，最低亮进 p5，周期不短于协议下限", () => {
    const built = panelLayer(
      "breathing",
      params({ periodMs: 500, minLevel: 51, waveform: WAVEFORM.TRIANGLE }),
    );
    expect(built.type).toBe(SEGMENT_TYPE.BREATHING);
    /* 滑块下限 0.5 秒已经高于呼吸的 334ms 协议下限，所以原值保留。 */
    expect(built.periodMs).toBe(500);
    expect(built.periodMs).toBeGreaterThanOrEqual(334);
    expect(built.p5).toBe(51);
    expect(built.flags).toBe((WAVEFORM.TRIANGLE & 0x03) << 1);
  });

  it("周期为 0 的呼吸草稿不会发出「静止」的非法层（抬到下限）", () => {
    const built = panelLayer("breathing", params({ periodMs: 0 }));
    expect(built.periodMs).toBeGreaterThanOrEqual(334);
  });

  it("彩虹 / 流光：方向位是 bit0，跨度 / 尾长进 p5", () => {
    const rainbow = panelLayer("rainbow", params({ span: 200, reverse: true, periodMs: 1000 }));
    expect(rainbow.flags).toBe(0x01);
    expect(rainbow.p5).toBe(200);
    const comet = panelLayer("comet", params({ tail: 80, reverse: false }));
    expect(comet.flags).toBe(0);
    expect(comet.p5).toBe(80);
  });

  it("亮度 level 写进九字节层（v4），且空层恒 0", () => {
    const built = panelLayer("static", params({ level: 30 }));
    expect(built.level).toBe(30);
    expect(Object.keys(built).sort()).toEqual([
      "flags",
      "hue",
      "level",
      "p5",
      "periodMs",
      "sat",
      "type",
    ]);
    /* 装配后空叠加层的 level 必须是 0（否则设备回 InvalidParam）。 */
    const spec = buildZoneSpec({
      stripId: 0,
      segId: 0,
      start: 0,
      end: 9,
      layer0: built,
      layer1: null,
    });
    expect(spec.layer0.level).toBe(30);
    expect(spec.layer1.level).toBe(0);
  });

  it("亮度滑块现在真实下发（sends = true、没有待生效标记）", () => {
    const view = buildEffectPanel("static", params({ level: 30 }));
    const level = view.sliders.find((slider) => slider.key === "level");
    expect(level?.sends).toBe(true);
    expect(level?.note).toBe("");
    expect(view.sliders.find((slider) => slider.key === "hue")?.sends).toBe(true);
  });

  it("设备读回 → 草稿：只取该类型用得上的字段", () => {
    const breathing = paramsFromLayer(
      "breathing",
      layer(SEGMENT_TYPE.BREATHING, { hue: 5000, sat: 100, periodMs: 1500, p5: 77, flags: 0x04 }),
    );
    expect(breathing.periodMs).toBe(1500);
    expect(breathing.minLevel).toBe(77);
    expect(breathing.waveform).toBe(WAVEFORM.SAWTOOTH);
    const rainbow = paramsFromLayer("rainbow", layer(SEGMENT_TYPE.RAINBOW, { p5: 255, flags: 0x01 }));
    expect(rainbow.reverse).toBe(true);
    expect(rainbow.span).toBe(255);
  });

  it("爆闪层：频率换算回周期，占空比进 p5，flags 恒 0", () => {
    const built = panelLayer("strobe", params({ hue: 1234, sat: 200, frequencyHz: 5, duty: 90, level: 40 }));
    expect(built).toEqual({
      type: SEGMENT_TYPE.STROBE,
      hue: 1234,
      sat: 200,
      /* 5Hz → 200ms。 */
      periodMs: 200,
      p5: 90,
      flags: 0,
      level: 40,
    });
    const read = paramsFromLayer("strobe", built);
    expect(read.frequencyHz).toBe(5);
    expect(read.duty).toBe(90);
    expect(read.level).toBe(40);
  });

  it("心跳层：BPM 换算回周期 60000/bpm，脉冲宽度用中等固定值，双脉冲开着", () => {
    const built = panelLayer("heartbeat", params({ bpm: 60, level: 55, hue: 999 }));
    expect(built.type).toBe(SEGMENT_TYPE.HEARTBEAT);
    expect(built.periodMs).toBe(1000);
    expect(built.p5).toBe(60);
    /* bit0 = 双脉冲；界面不给入口，但默认开着。 */
    expect(built.flags).toBe(0x01);
    expect(built.level).toBe(55);
    const read = paramsFromLayer("heartbeat", built);
    expect(read.bpm).toBe(60);
    expect(read.hue).toBe(999);
  });

  it("随机闪烁层：类型是 0x07（不是常亮）,密度进 p5,flags 恒 0", () => {
    /* #121：这里必须走真实装配路径。旧用例只断言「清单里有 flicker」
     * 「滑块表里有它」,恰好放过了 panelLayer 缺 case 的缺陷。 */
    expect(panelLayer("flicker", defaultParams("flicker")).type).toBe(SEGMENT_TYPE.FLICKER);
    const built = panelLayer("flicker", params({ hue: 1234, sat: 200, density: 96, level: 40 }));
    expect(built).toEqual({
      type: SEGMENT_TYPE.FLICKER,
      hue: 1234,
      sat: 200,
      /* params() 从 defaultParams("static") 起（periodMs 0 → 抬到滑块下限 500）。 */
      periodMs: 500,
      p5: 96,
      flags: 0,
      level: 40,
    });
    const read = paramsFromLayer("flicker", built);
    expect(read.density).toBe(96);
    expect(read.periodMs).toBe(500);
  });

  it("随机闪烁的默认周期不是 0（0 表示冻结在一张固定分布上）", () => {
    const defaults = defaultParams("flicker");
    expect(defaults.periodMs).not.toBe(0);
    expect(defaults.density).toBeGreaterThan(0);
    /* 周期从不低于 334 的光敏线。滑块网格从 500 起，所以下限由滑块兜住，
     * 这里的 max(..., FLICKER_MIN_PERIOD_MS) 是给读回 / 落盘的越界值兜底。 */
    expect(panelLayer("flicker", params({ periodMs: 200 })).periodMs).toBeGreaterThanOrEqual(
      FLICKER_MIN_PERIOD_MS,
    );
    expect(panelLayer("flicker", params({ periodMs: 1000 })).periodMs).toBe(1000);
  });

  it("熄灭层：参数全 0（协议硬约束），level 也归 0", () => {    const built = panelLayer("off", params({ hue: 1234, sat: 200, level: 80, periodMs: 3000 }));
    expect(built).toEqual({
      type: SEGMENT_TYPE.OFF,
      hue: 0,
      sat: 0,
      periodMs: 0,
      p5: 0,
      flags: 0,
      level: 0,
    });
    /* 读回时颜色回到默认（设备上本来就没有颜色）。 */
    const read = paramsFromLayer("off", built);
    expect(read.level).toBeGreaterThan(0);
  });

  it("爆闪 / 心跳的周期都不短于各自协议下限", () => {
    /* 频率滑到 10Hz 是 100ms，正好是爆闪下限。 */
    expect(panelLayer("strobe", params({ frequencyHz: 10 })).periodMs).toBe(100);
    expect(panelLayer("heartbeat", params({ bpm: 120 })).periodMs).toBe(500);
    expect(panelLayer("heartbeat", params({ bpm: 40 })).periodMs).toBe(1500);
  });

  it("面板产出的每一层都能被真正的编码器接受（不改协议层，走同一构造器）", () => {
    /* 这是「面板写出来的东西设备收不收」的最短闭环：cmdSetSegment 会按 §7.1
     * 逐项校验（周期下限、保留位、熄灭全零），抛错就说明面板产出了非法层。 */
    const hues = [0, 7281, 40000, 65535];
    for (const type of PANEL_TYPE_OPTIONS.map((option) => option.type)) {
      for (const hue of hues) {
        const spec = buildZoneSpec({
          stripId: 0,
          segId: 0,
          start: 0,
          end: 9,
          layer0: panelLayer(type, params({ hue, sat: 200, level: 60 })),
          layer1: null,
        });
        expect(() => cmdSetSegment(spec), `${type}@${hue}`).not.toThrow();
      }
    }
  });

  it("设备上周期为 0（静止）时退回该类型默认周期，滑块不落在 0", () => {
    const next = paramsFromLayer("comet", layer(SEGMENT_TYPE.COMET, { periodMs: 0 }));
    expect(next.periodMs).toBe(defaultParams("comet").periodMs);
  });

  /*
   * 爆闪 / 心跳的周期 0 是「静止」，**不是**最快档。
   *
   * 回归：`periodMsFor` 过去直接做下限钳位，于是 0 被抬成 100ms / 500ms ——
   * 前者正好是 10Hz（爆闪上限）、后者是 120BPM（心跳上限）。一台把爆闪设成
   * 静止的设备读回来会显示成最快的爆闪，用户一碰滑块就把静止变成 10Hz。
   */
  it("爆闪周期 0（静止）退回默认频率，不能显示成 10Hz", () => {
    const next = paramsFromLayer("strobe", layer(SEGMENT_TYPE.STROBE, { periodMs: 0 }));
    expect(next.frequencyHz).toBe(defaultParams("strobe").frequencyHz);
    expect(next.frequencyHz).toBeLessThan(FREQUENCY_MAX);
    expect(strobePeriodMs(next.frequencyHz)).not.toBe(STROBE_MIN_PERIOD_MS);
  });

  it("心跳周期 0（静止）退回默认节奏，不能显示成 120BPM", () => {
    const next = paramsFromLayer("heartbeat", layer(SEGMENT_TYPE.HEARTBEAT, { periodMs: 0 }));
    expect(next.bpm).toBe(defaultParams("heartbeat").bpm);
    expect(next.bpm).toBeLessThan(BPM_MAX);
    expect(heartbeatPeriodMs(next.bpm)).not.toBe(HEARTBEAT_MIN_PERIOD_MS);
  });

  it("非 0 周期仍按频率 / 节奏换算（0 的短路不影响正常值）", () => {
    const strobe = paramsFromLayer("strobe", layer(SEGMENT_TYPE.STROBE, { periodMs: 200 }));
    expect(strobe.frequencyHz).toBe(5);
    const heart = paramsFromLayer("heartbeat", layer(SEGMENT_TYPE.HEARTBEAT, { periodMs: 1000 }));
    expect(heart.bpm).toBe(60);
  });

  it("归一函数把外部值全钳进合法区间", () => {
    const next = normalizeParams({ hue: -1, sat: 999, level: 0, minLevel: 999, waveform: 9 });
    expect(next.hue).toBe(0xffff);
    expect(next.sat).toBe(255);
    /* 0 是协议合法值（这一层不出光），归一不能把它抬到滑块下限。 */
    expect(next.level).toBe(0);
    expect(normalizeParams({ level: 999 }).level).toBe(100);
    expect(normalizeParams({ level: -3 }).level).toBe(0);
    /* v4：呼吸最低亮是百分比，999 钳到 100。 */
    expect(next.minLevel).toBe(100);
    expect(next.waveform).toBe(WAVEFORM.SQUARE);
  });
});

describe("装配分区", () => {
  it("只改选中的那个分区，别的分区一字不动", () => {
    const zones = [zone(0), zone(1), zone(2)];
    const next = applyPanelToZone(zones, 1, "comet", params({ hue: 43690, tail: 200 }));
    expect(next[0]).toBe(zones[0]);
    expect(next[2]).toBe(zones[2]);
    expect(next[1].layer0.type).toBe(SEGMENT_TYPE.COMET);
    expect(next[1].layer0.hue).toBe(43690);
    expect(next[1].layer0.p5).toBe(200);
    expect([next[1].start, next[1].end, next[1].segId]).toEqual([10, 19, 1]);
  });

  it("叠加层为空时叠加方式被归一为覆盖（走 zone-model）", () => {
    const zones = [zone(0, { blend: BLEND.ADD as never })];
    const next = applyPanelToZone(zones, 0, "breathing", params());
    expect(next[0].blend).toBe(BLEND.OVER);
    expect(next[0].layer1.type).toBe(NO_EFFECT);
  });

  it("已有的叠加层原样保留（面板只改主效果）", () => {
    const overlay = layer(SEGMENT_TYPE.RAINBOW, { periodMs: 1200, p5: 255 });
    const zones = [
      buildZoneSpec({
        stripId: 0,
        segId: 0,
        start: 0,
        end: 9,
        blend: BLEND.MULTIPLY,
        layer0: layer(SEGMENT_TYPE.STATIC, { hue: 7281, sat: 255 }),
        layer1: overlay,
      }),
    ];
    const next = applyPanelToZone(zones, 0, "static", params({ hue: 0, sat: 255 }));
    expect(next[0].layer1.type).toBe(SEGMENT_TYPE.RAINBOW);
    expect(next[0].blend).toBe(BLEND.MULTIPLY);
  });

  it("装配结果是深拷贝（改草稿不会污染已经写好的 spec）", () => {
    const zones = [zone(0)];
    const next = applyPanelToZone(zones, 0, "static", params({ hue: 1111 }));
    next[0].layer0.hue = 2222;
    expect(zones[0].layer0.hue).toBe(7281);
  });

  it("找不到槽位时原样返回（各元素引用不变）", () => {
    const zones = [zone(0)];
    const next = applyPanelToZone(zones, 5, "static", params());
    expect(next[0]).toBe(zones[0]);
  });
});

describe("选择控件", () => {
  it("波形改的是 bit1-2 的枚举值，方向只有正转 / 反转", () => {
    const withSquare = applyChoice(params(), "waveform", WAVEFORM.SQUARE);
    expect(withSquare.waveform).toBe(WAVEFORM.SQUARE);
    expect(applyChoice(params(), "direction", 1).reverse).toBe(true);
    expect(applyChoice(params(), "direction", 0).reverse).toBe(false);
  });

  it("选择控件的当前值跟着草稿走", () => {
    const view = buildEffectPanel("breathing", params({ waveform: WAVEFORM.SAWTOOTH }));
    expect(view.choices[0].value).toBe(WAVEFORM.SAWTOOTH);
    const comet = buildEffectPanel("comet", params({ reverse: true }));
    expect(comet.choices[0].value).toBe(1);
  });
});

describe("摘要与两条事实", () => {
  it("摘要是人话，不含协议词", () => {
    expect(panelSummary("static", params())).toContain("常亮");
    const breathing = panelSummary("breathing", params({ periodMs: 2000, minLevel: 102 }));
    expect(breathing).toContain("2 秒");
    expect(breathing).toContain("正弦");
    expect(panelSummary("rainbow", params({ span: 255 }))).toContain("整圈");
    expect(panelSummary("comet", params({ tail: 0 }))).toContain("无拖尾");
    for (const summary of [
      breathing,
      panelSummary("rainbow", params()),
      panelSummary("comet", params()),
    ]) {
      expect(summary).not.toMatch(/毫秒|段|阶段|剧本|下发|激活|blend|层/);
    }
  });

  it("新三类各有自己的摘要，单位用 Hz / BPM / 结果描述", () => {
    const strobe = panelSummary("strobe", params({ frequencyHz: 6, duty: 40 }));
    expect(strobe).toContain("6 Hz");
    expect(strobe).toContain("占空比 窄");
    const heartbeat = panelSummary("heartbeat", params({ bpm: 72 }));
    expect(heartbeat).toContain("72 BPM");
    const off = panelSummary("off", params());
    expect(off).toContain("不亮");
    for (const summary of [strobe, heartbeat, off]) {
      expect(summary).not.toMatch(/毫秒|阶段|剧本|下发|激活|blend|层/);
    }
  });

  it("界面必须显示两条事实：内容只在本机 + 换机要重编", () => {
    expect(PANEL_FACTS).toHaveLength(2);
    expect(PANEL_FACTS[0]).toContain("只存在这台手机");
    expect(PANEL_FACTS[0]).toContain("读不回来");
    expect(PANEL_FACTS[1]).toContain("重新编排");
  });

  it("空方案 / 空步骤 / 没选中各有自己的引导（不是一片空白）", () => {
    for (const guide of [PANEL_EMPTY_PLAN_GUIDE, PANEL_EMPTY_STEP_GUIDE, PANEL_NO_ZONE_GUIDE]) {
      expect(guide.length).toBeGreaterThan(8);
      expect(guide).toMatch(/分区/);
      expect(guide).not.toMatch(/毫秒|阶段|剧本|下发|激活|blend|层/);
    }
    /* 三种场景不能共用同一句话，否则用户不知道下一步到底做什么。 */
    expect(new Set([PANEL_EMPTY_PLAN_GUIDE, PANEL_EMPTY_STEP_GUIDE, PANEL_NO_ZONE_GUIDE]).size).toBe(3);
  });

  it("色相滑轨的渐变用 hsl，不写死 hex", () => {
    expect(HUE_RAMP_GRADIENT).toContain("linear-gradient");
    expect(HUE_RAMP_GRADIENT).toContain("hsl(");
    expect(HUE_RAMP_GRADIENT).not.toMatch(/#[0-9a-fA-F]{6}/);
  });

  it("七种类型的所有界面文字都不出现协议词", () => {
    const forbidden = /毫秒|段|阶段|剧本|下发|激活|第.层|blend|script|period|strobe|heartbeat/i;
    for (const type of PANEL_TYPE_OPTIONS.map((option) => option.type)) {
      const view = buildEffectPanel(type, switchPanelType(params(), "static", type));
      const texts = [
        ...view.sliders.flatMap((slider) => [slider.label, slider.display]),
        ...view.choices.flatMap((choice) => [
          choice.label,
          ...choice.options.map((option) => option.label),
        ]),
        view.summary,
        view.notice,
      ];
      for (const text of texts) {
        expect(text, `${type}: ${text}`).not.toMatch(forbidden);
      }
    }
  });
});


/* ================= 叠加层（#71 US49 / US50） ================= */

describe("叠加层：选项、草稿与装配", () => {
  it("叠加层选项是「关闭」+ 七种类型，且不含熄灭", () => {
    const values = OVERLAY_CHOICE_OPTIONS.map((option) => option.value);
    expect(values[0]).toBe("none");
    expect(values).toContain("strobe");
    expect(values).toContain("heartbeat");
    /* US50：叠加层里没有「熄灭」——叠一层黑等于没做事。 */
    expect(values).not.toContain("off");
    expect(OVERLAY_CHOICE_OPTIONS).toHaveLength(8);
  });

  it("混合方式只剩相加 / 覆盖两种（#100 移除了相乘）", () => {
    expect(OVERLAY_BLEND_OPTIONS.map((option) => option.value)).toEqual([BLEND.ADD, BLEND.OVER]);
    expect(OVERLAY_BLEND_OPTIONS.map((option) => option.name)).toEqual(["相加", "覆盖"]);
    /* 界面上再也找不到「相乘」。 */
    expect(OVERLAY_BLEND_OPTIONS.map((option) => option.name)).not.toContain("相乘");
  });

  it("默认草稿是关闭状态，且不产出任何叠加层", () => {
    const draft = emptyOverlayDraft();
    expect(draft.type).toBe("none");
    expect(overlayEnabled(draft)).toBe(false);
    expect(overlayLayer(draft).type).toBe(NO_EFFECT);
    expect(overlaySummary(draft)).toBe("");
  });

  it("开启爆闪后产出的 layer1 是真实的爆闪层", () => {
    const draft = switchOverlayType(emptyOverlayDraft(), "strobe");
    expect(overlayEnabled(draft)).toBe(true);
    const built = overlayLayer(draft);
    expect(built.type).toBe(SEGMENT_TYPE.STROBE);
    expect(built.periodMs).toBeGreaterThanOrEqual(STROBE_MIN_PERIOD_MS);
    /* 叠加层也有自己的亮度（v4 的 level）。 */
    expect(built.level).toBeGreaterThan(0);
  });

  it("心跳可以当叠加层用（US49），且周期落在协议区间内", () => {
    const draft = switchOverlayType(emptyOverlayDraft(), "heartbeat");
    const built = overlayLayer(draft);
    expect(built.type).toBe(SEGMENT_TYPE.HEARTBEAT);
    expect(built.periodMs).toBeGreaterThanOrEqual(HEARTBEAT_MIN_PERIOD_MS);
    expect(layerCheck(built).ok).toBe(true);
  });

  it("关闭叠加层后保留原参数，再开回来还能接着调", () => {
    let draft = switchOverlayType(emptyOverlayDraft(), "breathing");
    draft = { ...draft, params: { ...draft.params, minLevel: 12, periodMs: 3000 } };
    const off = switchOverlayType(draft, "none");
    expect(overlayEnabled(off)).toBe(false);
    const back = switchOverlayType(off, "breathing");
    expect(back.params.minLevel).toBe(12);
    expect(back.params.periodMs).toBe(3000);
  });

  it("两种类型之间切换时按新类型语义重置，颜色留下", () => {
    const draft = switchOverlayType(emptyOverlayDraft(), "breathing");
    const moved = switchOverlayType(draft, "rainbow");
    expect(moved.type).toBe("rainbow");
    /* 颜色保留（与主效果的 switchPanelType 同一规则）。 */
    expect(moved.params.hue).toBe(draft.params.hue);
    expect(moved.params.sat).toBe(draft.params.sat);
  });

  it("从设备读回空层 → 关闭态", () => {
    const draft = overlayDraftOf(layer(NO_EFFECT), BLEND.OVER);
    expect(draft.type).toBe("none");
    expect(overlayEnabled(draft)).toBe(false);
  });

  it("从设备读回真实叠加层 → 原类型与参数", () => {
    const src = panelLayer("comet", { ...defaultParams("comet"), hue: 1234, sat: 200 });
    const draft = overlayDraftOf(src, BLEND.MULTIPLY);
    expect(draft.type).toBe("comet");
    expect(draft.blend).toBe(BLEND.MULTIPLY);
    expect(draft.params.hue).toBe(1234);
    expect(draft.params.sat).toBe(200);
  });

  it("设备上是「熄灭」叠加层时按关闭处理（界面不提供这个选项）", () => {
    const offLayer = panelLayer("off", defaultParams("off"));
    const draft = overlayDraftOf(offLayer, BLEND.OVER);
    expect(draft.type).toBe("none");
  });

  it("applyPanelToZone 传叠加层时同时替换 layer1 与叠加方式", () => {
    const zones: SegmentSpec[] = [
      buildZoneSpec({
        stripId: 0,
        segId: 0,
        start: 0,
        end: 9,
        blend: BLEND.OVER,
        layer0: panelLayer("static", params()),
        layer1: null,
      }),
    ];
    const overlay: OverlayDraft = {
      type: "strobe",
      params: defaultParams("strobe"),
      blend: BLEND.ADD,
    };
    const next = applyPanelToZone(zones, 0, "rainbow", defaultParams("rainbow"), overlay);
    expect(next[0].layer0.type).toBe(SEGMENT_TYPE.RAINBOW);
    expect(next[0].layer1.type).toBe(SEGMENT_TYPE.STROBE);
    expect(next[0].blend).toBe(BLEND.ADD);
  });

  it("applyPanelToZone 不传叠加层时保留设备上原有的叠加层", () => {
    const existing = panelLayer("heartbeat", defaultParams("heartbeat"));
    const zones: SegmentSpec[] = [
      buildZoneSpec({
        stripId: 0,
        segId: 0,
        start: 0,
        end: 9,
        blend: BLEND.MULTIPLY,
        layer0: panelLayer("static", params()),
        layer1: existing,
      }),
    ];
    const next = applyPanelToZone(zones, 0, "comet", defaultParams("comet"));
    expect(next[0].layer0.type).toBe(SEGMENT_TYPE.COMET);
    expect(next[0].layer1.type).toBe(SEGMENT_TYPE.HEARTBEAT);
    expect(next[0].blend).toBe(BLEND.MULTIPLY);
  });

  it("关闭叠加层后写出去的分区叠加方式归一为覆盖、layer1 为空层", () => {
    const zones: SegmentSpec[] = [
      buildZoneSpec({
        stripId: 0,
        segId: 0,
        start: 0,
        end: 9,
        blend: BLEND.ADD,
        layer0: panelLayer("static", params()),
        layer1: panelLayer("strobe", defaultParams("strobe")),
      }),
    ];
    const next = applyPanelToZone(zones, 0, "static", params(), emptyOverlayDraft());
    expect(next[0].layer1.type).toBe(NO_EFFECT);
    /* 空叠加层必须归一为覆盖，否则设备回 InvalidParam。 */
    expect(next[0].blend).toBe(BLEND.OVER);
  });

  it("两层一起过 layersCheck：叠加爆闪的超短周期会被拦住", () => {
    const fast = layer(SEGMENT_TYPE.STROBE, { periodMs: 50 });
    expect(layersCheck([layer(SEGMENT_TYPE.STATIC), fast]).ok).toBe(false);
  });

  it("叠加层摘要给出类型与参数，不含禁用术语", () => {
    const draft = switchOverlayType(emptyOverlayDraft(), "heartbeat");
    const summary = overlaySummary(draft);
    expect(summary).toContain("心跳");
    expect(summary).not.toMatch(/毫秒|段|阶段|剧本|下发|激活|第.层|blend/i);
  });
});

/** 亮度下限（`strip-simple` 的 5%）；测试里单独包一层，避免直接依赖实现常量名。 */
function coerceLevel(value: number): number {
  return applySlider(params(), "level", value).level;
}
