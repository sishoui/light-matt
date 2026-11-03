/**
 * 进阶档效果面板（#67）的纯逻辑。
 *
 * 五类断言，全部对应票面里「用户看得见」的规则：
 *  1. **参数区按类型整体替换**：静态正好三项，呼吸 / 彩虹 / 流光各自多出自己的
 *     参数，且**没有任何一个当前类型用不上的旋钮**；
 *  2. **切换类型保留颜色与亮度，其余回到新类型默认值**；
 *  3. **滑块刻度 ↔ 协议值**（色相度 / 饱和度百分比 / 周期秒 / 最低亮 / 跨度 /
 *     尾长），以及右侧「数值 + 单位」的格式；
 *  4. **装配光区**：叠加层为空时叠加方式归一、只改选中那一个、别的光区一字不动；
 *  5. **两条必须告知的事实与空态引导**文案存在且不含禁用术语。
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
  HUE_RAMP_GRADIENT,
  isPanelSliderKey,
  normalizeParams,
  PANEL_EMPTY_PLAN_GUIDE,
  PANEL_EMPTY_STEP_GUIDE,
  PANEL_FACTS,
  PANEL_NO_ZONE_GUIDE,
  PANEL_TYPE_OPTIONS,
  panelLayer,
  panelSummary,
  panelTypeOf,
  panelTypeValue,
  paramsFromLayer,
  sliderView,
  SLIDER_KEYS,
  switchPanelType,
  type EffectParams,
  type PanelType,
} from "../utils/control/effect-panel";
import { BLEND, NO_EFFECT, SEGMENT_TYPE, WAVEFORM } from "../utils/protocol/constants";
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
  it("四个等宽按钮的顺序是 静态 / 呼吸 / 彩虹 / 流光", () => {
    expect(PANEL_TYPE_OPTIONS.map((option) => option.name)).toEqual(["静态", "呼吸", "彩虹", "流光"]);
    expect(PANEL_TYPE_OPTIONS.map((option) => option.type)).toEqual([
      "static",
      "breathing",
      "rainbow",
      "comet",
    ]);
  });

  it("只有当前类型是高亮的", () => {
    const views = buildTypeViews("rainbow");
    expect(views.filter((view) => view.selected).map((view) => view.type)).toEqual(["rainbow"]);
    expect(views).toHaveLength(4);
  });

  it("类型与协议枚举一一对应（空层 / 未知按静态）", () => {
    expect(panelTypeValue("static")).toBe(SEGMENT_TYPE.STATIC);
    expect(panelTypeValue("breathing")).toBe(SEGMENT_TYPE.BREATHING);
    expect(panelTypeValue("rainbow")).toBe(SEGMENT_TYPE.RAINBOW);
    expect(panelTypeValue("comet")).toBe(SEGMENT_TYPE.COMET);
    expect(panelTypeOf(NO_EFFECT)).toBe("static");
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

  it("用户永远看不到当前类型用不上的旋钮（逐个类型穷举）", () => {
    const allowed: Record<PanelType, string[]> = {
      static: ["hue", "sat", "level"],
      breathing: ["hue", "sat", "level", "period", "minLevel"],
      rainbow: ["period", "span"],
      comet: ["hue", "sat", "level", "period", "tail"],
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
    for (const type of ["static", "breathing", "rainbow", "comet"] as PanelType[]) {
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

  it("动画类型的默认周期都高于协议下限（切过去立刻有动画）", () => {
    expect(defaultParams("breathing").periodMs).toBeGreaterThanOrEqual(334);
    expect(defaultParams("rainbow").periodMs).toBeGreaterThanOrEqual(200);
    expect(defaultParams("comet").periodMs).toBeGreaterThanOrEqual(200);
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

  it("面板的 key 白名单只认这七个滑块", () => {
    for (const key of ["hue", "sat", "level", "period", "minLevel", "span", "tail"]) {
      expect(isPanelSliderKey(key), key).toBe(true);
    }
    expect(isPanelSliderKey("waveform")).toBe(false);
    expect(isPanelSliderKey("blend")).toBe(false);
  });

  it("每次读数都带单位，色相用度、其余用百分号或秒", () => {
    const view = buildEffectPanel("breathing", params({ periodMs: 2000, minLevel: 102 }));
    const display = Object.fromEntries(view.sliders.map((slider) => [slider.key, slider.display]));
    expect(display.hue).toMatch(/°$/);
    expect(display.sat).toMatch(/%$/);
    expect(display.level).toMatch(/%$/);
    expect(display.period).toMatch(/ 秒$/);
    expect(display.minLevel).toMatch(/%$/);
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

  it("设备上周期为 0（静止）时退回该类型默认周期，滑块不落在 0", () => {
    const next = paramsFromLayer("comet", layer(SEGMENT_TYPE.COMET, { periodMs: 0 }));
    expect(next.periodMs).toBe(defaultParams("comet").periodMs);
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

describe("装配光区", () => {
  it("只改选中的那个光区，别的光区一字不动", () => {
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
    expect(panelSummary("static", params())).toContain("静态");
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

  it("界面必须显示两条事实：内容只在本机 + 换机要重编", () => {
    expect(PANEL_FACTS).toHaveLength(2);
    expect(PANEL_FACTS[0]).toContain("只存在这台手机");
    expect(PANEL_FACTS[0]).toContain("读不回来");
    expect(PANEL_FACTS[1]).toContain("重新编排");
  });

  it("空方案 / 空步骤 / 没选中各有自己的引导（不是一片空白）", () => {
    for (const guide of [PANEL_EMPTY_PLAN_GUIDE, PANEL_EMPTY_STEP_GUIDE, PANEL_NO_ZONE_GUIDE]) {
      expect(guide.length).toBeGreaterThan(8);
      expect(guide).toMatch(/光区/);
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
});

/** 亮度下限（`strip-simple` 的 5%）；测试里单独包一层，避免直接依赖实现常量名。 */
function coerceLevel(value: number): number {
  return applySlider(params(), "level", value).level;
}
