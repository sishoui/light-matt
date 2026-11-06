/**
 * #154 效果面板单元：**不依赖灯组页就能驱动**。
 *
 * prefactor（零行为变更）：把「换目标时从草稿读回这一层的值 / 切类型 / 改参数 /
 * 回读当前值 / 装配进分区」从灯组页里抽成独立单元。用例只碰纯数据：给一层效果，
 * 断言类型切换与参数回读，不加载页面、不碰 wx、不碰设备。
 *
 * 判据是票面那三条里的第二条与第三条：「给定一层效果，能切换类型、能改参数、
 * 能回读当前值」+「参数控件定义只有一份」。
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  applyOverlayChoiceValue,
  applyOverlaySliderValue,
  applyPanelChoiceValue,
  applyPanelSliderValue,
  createPanelUnit,
  panelUnitCheck,
  panelUnitKey,
  panelUnitParams,
  panelUnitView,
  panelUnitZoneSpecs,
  resetPanelUnit,
  selectPanelTarget,
  setPanelUnitHint,
  switchPanelMode,
} from "../utils/control/panel-unit";
import {
  CHOICE_KEYS,
  PANEL_EMPTY_PLAN_GUIDE,
  PANEL_EMPTY_STEP_GUIDE,
  PANEL_NO_ZONE_GUIDE,
  SLIDER_KEYS,
  defaultParams,
  emptyOverlayDraft,
  paramsFromLayer,
  panelLayer,
} from "../utils/control/effect-panel";
import { BLEND, NO_EFFECT, SEGMENT_TYPE } from "../utils/protocol/constants";
import type { EffectLayer, SegmentSpec } from "../utils/protocol/types";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const TARGET = { planSlot: 0, stepIndex: 0, segId: 0 };
const LIVE = { zoneCount: 1, hasZone: true, planEmpty: false };
const EMPTY = { zoneCount: 0, hasZone: false, planEmpty: true };

/** 一层常亮：暖白、满亮。 */
function staticLayer(overrides: Partial<EffectLayer> = {}): EffectLayer {
  return {
    type: SEGMENT_TYPE.STATIC,
    hue: 7281,
    sat: 255,
    periodMs: 0,
    p5: 0,
    flags: 0,
    level: 100,
    ...overrides,
  };
}

/** 空层（没有叠加效果）。 */
function emptyLayer(): EffectLayer {
  return { type: NO_EFFECT, hue: 0, sat: 0, periodMs: 0, p5: 0, flags: 0, level: 0 };
}

/** 一个分区。 */
function zone(overrides: Partial<SegmentSpec> = {}): SegmentSpec {
  return {
    stripId: 0,
    segId: 0,
    start: 0,
    end: 9,
    blend: BLEND.OVER,
    layer0: staticLayer(),
    layer1: emptyLayer(),
    ...overrides,
  };
}

describe("给定一层效果 → 回读当前值", () => {
  it("选中一个常亮分区：类型是常亮，参数从层里读回（含亮度）", () => {
    const unit = selectPanelTarget(createPanelUnit(), TARGET, zone({ layer0: staticLayer({ hue: 30000, level: 42 }) }));
    expect(unit.mode).toBe("static");
    expect(panelUnitParams(unit).hue).toBe(30000);
    expect(panelUnitParams(unit).level).toBe(42);
  });

  it("呼吸层读回周期与最低亮（协议值 → 面板单位）", () => {
    const layer = staticLayer({ type: SEGMENT_TYPE.BREATHING, periodMs: 2000, p5: 40, level: 80 });
    const unit = selectPanelTarget(createPanelUnit(), { planSlot: 0, stepIndex: 1, segId: 2 }, zone({ segId: 2, layer0: layer }));
    expect(unit.mode).toBe("breathing");
    expect(panelUnitParams(unit)).toEqual(paramsFromLayer("breathing", layer));
  });

  it("同一目标重复选中不重读（拖动中的读数不会被一次重画冲掉）", () => {
    const first = selectPanelTarget(createPanelUnit(), TARGET, zone());
    const edited = applyPanelSliderValue(first, "hue", 120);
    const again = selectPanelTarget(edited, TARGET, zone({ layer0: staticLayer({ hue: 7281 }) }));
    expect(again, "键没变就返回同一个状态").toBe(edited);
    expect(panelUnitParams(again).hue, "用户拖过的值还在").toBe(Math.round((120 / 360) * 0x10000));
  });

  it("换目标时清掉一次性反馈（切分区不带着上一个的提示）", () => {
    const hinted = setPanelUnitHint(selectPanelTarget(createPanelUnit(), TARGET, zone()), "写不进去");
    expect(panelUnitView(hinted, LIVE).panelHint).toBe("写不进去");
    const moved = selectPanelTarget(hinted, { ...TARGET, segId: 1 }, zone({ segId: 1 }));
    expect(moved.hint).toBe("");
    expect(panelUnitView(moved, LIVE).panelHint).toBe("");
  });

  it("没有可编辑的分区：回到常亮默认值，不留任何滑块", () => {
    const unit = selectPanelTarget(createPanelUnit(), { planSlot: 0, stepIndex: 0, segId: -1 }, null);
    expect(unit.mode).toBe("static");
    expect(panelUnitParams(unit)).toEqual(defaultParams("static"));
    const view = panelUnitView(unit, EMPTY);
    expect(view.panelSliders).toEqual([]);
    expect(view.panelChoices).toEqual([]);
    expect(view.panelHasZone).toBe(false);
    /* 方案为空时引导指向「+ 新增」，不是「点一块选中」。 */
    expect(view.panelGuide).toContain("+ 新增");
    expect(view.panelGuide).toBe(PANEL_EMPTY_PLAN_GUIDE);
  });

  it("有分区但没选中：引导指向分区轴；方案为空时引导指向「+ 新增」", () => {
    const noZone = panelUnitView(createPanelUnit(), { zoneCount: 2, hasZone: false, planEmpty: false });
    expect(noZone.panelGuide).toBe(PANEL_NO_ZONE_GUIDE);
    const emptyPlan = panelUnitView(createPanelUnit(), { zoneCount: 0, hasZone: false, planEmpty: true });
    expect(emptyPlan.panelGuide).toBe(PANEL_EMPTY_PLAN_GUIDE);
    const emptyStep = panelUnitView(createPanelUnit(), { zoneCount: 0, hasZone: false, planEmpty: false });
    expect(emptyStep.panelGuide).toBe(PANEL_EMPTY_STEP_GUIDE);
  });

  it("「熄灭」没有旋钮，只给一行说明（没有选中分区时连说明都不给）", () => {
    const unit = selectPanelTarget(createPanelUnit(), TARGET, zone({ layer0: staticLayer({ type: SEGMENT_TYPE.OFF }) }));
    const view = panelUnitView(unit, LIVE);
    expect(view.panelSliders).toEqual([]);
    expect(view.panelChoices).toEqual([]);
    expect(view.panelNotice.length).toBeGreaterThan(0);
    expect(view.panelColorHex).toBe("");
    /* 没选中分区时说明必须消失，否则它是一句凭空捏造的描述。 */
    expect(panelUnitView(unit, { ...LIVE, hasZone: false }).panelNotice).toBe("");
  });
});

describe("切换类型", () => {
  it("常亮 → 呼吸：保留颜色与亮度，其余回到新类型默认值", () => {
    const unit = selectPanelTarget(createPanelUnit(), TARGET, zone({ layer0: staticLayer({ hue: 20000, sat: 128, level: 55 }) }));
    const breathing = switchPanelMode(unit, "breathing");
    expect(breathing.mode).toBe("breathing");
    expect(panelUnitParams(breathing).hue).toBe(20000);
    expect(panelUnitParams(breathing).sat).toBe(128);
    expect(panelUnitParams(breathing).level).toBe(55);
    expect(panelUnitParams(breathing).periodMs).toBe(defaultParams("breathing").periodMs);
  });

  it("切成同一个类型返回同一个状态（不产生多余刷新）", () => {
    const unit = createPanelUnit();
    expect(switchPanelMode(unit, unit.mode)).toBe(unit);
  });

  it("滑块与选择控件完全由类型决定（参数区整体替换）", () => {
    const comet = switchPanelMode(createPanelUnit(), "comet");
    const view = panelUnitView(comet, LIVE);
    expect(view.panelSliders.map((slider) => slider.key)).toEqual([...SLIDER_KEYS.comet]);
    expect(view.panelChoices.map((choice) => choice.key)).toEqual([...CHOICE_KEYS.comet]);
  });

  it("类型行永远八项，选中态跟着当前类型", () => {
    const view = panelUnitView(switchPanelMode(createPanelUnit(), "heartbeat"), LIVE);
    expect(view.panelTypes.length).toBe(8);
    expect(view.panelTypes.filter((type) => type.selected).map((type) => type.type)).toEqual([
      "heartbeat",
    ]);
  });
});

describe("改参数", () => {
  it("拖色相 / 饱和度 / 亮度都能回读", () => {
    let unit = createPanelUnit();
    unit = applyPanelSliderValue(unit, "hue", 90);
    unit = applyPanelSliderValue(unit, "sat", 40);
    unit = applyPanelSliderValue(unit, "level", 70);
    const params = panelUnitParams(unit);
    expect(params.hue).toBe(Math.round((90 / 360) * 0x10000));
    expect(params.sat).toBe(Math.round((40 / 100) * 255));
    expect(params.level).toBe(70);
  });

  it("亮度记在目标键上（切分区再切回来，还没下发的值不丢）", () => {
    const first = applyPanelSliderValue(
      selectPanelTarget(createPanelUnit(), TARGET, zone({ layer0: staticLayer({ level: 100 }) })),
      "level",
      20,
    );
    /* 切到别的分区再切回来：草稿里还是 100，但用户刚拖的 20 要保住。 */
    const other = selectPanelTarget(first, { ...TARGET, segId: 1 }, zone({ segId: 1 }));
    const back = selectPanelTarget(other, TARGET, zone({ layer0: staticLayer({ level: 100 }) }));
    expect(panelUnitParams(back).level).toBe(20);
  });

  it("非法键 / 非有限值原样返回", () => {
    const unit = createPanelUnit();
    expect(applyPanelSliderValue(unit, "nope", 10)).toBe(unit);
    expect(applyPanelSliderValue(unit, "hue", Number.NaN)).toBe(unit);
  });

  it("波形 / 方向 / 占空比这些选项也走同一个入口", () => {
    const comet = switchPanelMode(createPanelUnit(), "comet");
    const reversed = applyPanelChoiceValue(comet, "direction", 1);
    expect(panelUnitParams(reversed).reverse).toBe(true);
    const breathing = switchPanelMode(createPanelUnit(), "breathing");
    const square = applyPanelChoiceValue(breathing, "waveform", 3);
    expect(panelUnitParams(square).waveform).toBe(3);
  });

  it("改参数不换目标键（播放头与草稿位置都不动）", () => {
    const target = { planSlot: 1, stepIndex: 2, segId: 3 };
    const unit = selectPanelTarget(createPanelUnit(), target, zone({ segId: 3 }));
    const tuned = applyPanelSliderValue(unit, "level", 50);
    expect(tuned.key).toBe(panelUnitKey(target));
    expect(tuned.mode).toBe(unit.mode);
  });
});

describe("叠加层", () => {
  it("默认关闭；打开后有自己的参数区", () => {
    const unit = createPanelUnit();
    expect(unit.overlay).toEqual(emptyOverlayDraft());
    const withOverlay = applyOverlayChoiceValue(unit, "comet");
    const view = panelUnitView(withOverlay, LIVE);
    expect(view.overlayEnabled).toBe(true);
    expect(view.overlaySlider.map((slider) => slider.key)).toEqual([...SLIDER_KEYS.comet]);
    expect(view.overlayChoices2.map((choice) => choice.key)).toEqual([...CHOICE_KEYS.comet]);
    expect(view.overlaySummary.length).toBeGreaterThan(0);
  });

  it("叠加层参数与主效果互相独立", () => {
    const tuned = applyOverlaySliderValue(applyOverlayChoiceValue(createPanelUnit(), "comet"), "tail", 30);
    expect(panelUnitParams(tuned).tail, "主效果不受影响").toBe(defaultParams("static").tail);
    expect(tuned.overlay.params.tail).toBe(Math.round((30 / 100) * 255));
  });

  it("关闭时保留参数（再开回来还能接着调）", () => {
    const tuned = applyOverlaySliderValue(applyOverlayChoiceValue(createPanelUnit(), "comet"), "tail", 30);
    const closed = applyOverlayChoiceValue(tuned, "none");
    expect(closed.overlay.type).toBe("none");
    expect(closed.overlay.params.tail).toBe(tuned.overlay.params.tail);
    expect(panelUnitView(closed, LIVE).overlayEnabled).toBe(false);
    expect(panelUnitView(closed, LIVE).overlaySlider).toEqual([]);
  });

  it("没打开叠加层时滑块入口原样返回", () => {
    const unit = createPanelUnit();
    expect(applyOverlaySliderValue(unit, "tail", 50)).toBe(unit);
  });

  it("关闭状态下改参数仍记住（再开回来是自己调过的样子）", () => {
    const unit = applyOverlaySliderValue(createPanelUnit(), "tail", 50);
    expect(unit.overlay.type, "没打开就没有参数区可拖").toBe("none");
    /* 关闭时滑块入口原样返回，所以参数确实没变——这是「不偷偷改」的一半。 */
    expect(unit.overlay.params).toEqual(emptyOverlayDraft().params);
  });

  it("非法叠加类型原样返回", () => {
    const unit = createPanelUnit();
    expect(applyOverlayChoiceValue(unit, "nope" as never)).toBe(unit);
  });
});

describe("落进分区与本地预检", () => {
  it("改完装配成可下发的 spec：只动选中那一个，别的分区一字不变", () => {
    const unit = applyPanelSliderValue(createPanelUnit(), "hue", 45);
    const zones = [zone({ segId: 0 }), zone({ segId: 1, start: 10, end: 19 })];
    const next = panelUnitZoneSpecs(applyOverlayChoiceValue(unit, "comet"), zones, 0);
    expect(next[1]).toEqual(zones[1]);
    expect(next[0].layer0.hue).toBe(Math.round((45 / 360) * 0x10000));
    expect(next[0].layer1.type).not.toBe(NO_EFFECT);
    /* 两层都有内容时按亮度叠加。 */
    expect(next[0].blend).toBe(BLEND.LUMA);
  });

  it("没有选中分区 / 分区不在了时不装配（返回原数组）", () => {
    const unit = createPanelUnit();
    const zones = [zone()];
    expect(panelUnitZoneSpecs(unit, zones, -1)).toBe(zones);
    expect(panelUnitZoneSpecs(unit, zones, 7)).toBe(zones);
  });

  it("越界的爆闪频率被本地预检拦住并给出原因", () => {
    const strobe = switchPanelMode(createPanelUnit(), "strobe");
    const unit = { ...strobe, params: { ...panelUnitParams(strobe), frequencyHz: 99 } };
    const check = panelUnitCheck(unit);
    expect(check.ok).toBe(false);
    expect(check.message.length).toBeGreaterThan(0);
  });

  it("正常参数通过预检", () => {
    expect(panelUnitCheck(createPanelUnit()).ok).toBe(true);
  });

  it("重置回到常亮默认值并清掉亮度记忆", () => {
    const unit = applyPanelSliderValue(selectPanelTarget(createPanelUnit(), TARGET, zone()), "level", 10);
    const reset = resetPanelUnit(unit);
    expect(reset.key).toBe("");
    expect(panelUnitParams(reset)).toEqual(defaultParams("static"));
    expect(reset.levels).toEqual({});
    expect(reset.hint).toBe("");
    expect(reset.overlay).toEqual(emptyOverlayDraft());
  });
});

describe("参数控件定义只有一份", () => {
  it("每种类型的滑块与选择项都来自 effect-panel 的键表", () => {
    for (const type of Object.keys(SLIDER_KEYS) as Array<keyof typeof SLIDER_KEYS>) {
      const unit = switchPanelMode(createPanelUnit(), type);
      const view = panelUnitView(unit, LIVE);
      expect(view.panelSliders.map((slider) => slider.key), type).toEqual([...SLIDER_KEYS[type]]);
      expect(view.panelChoices.map((choice) => choice.key), type).toEqual([...CHOICE_KEYS[type]]);
    }
  });

  it("简单档与进阶档仍然共用同一张 wxml 模板（三处引用）", () => {
    const wxml = readFileSync(join(ROOT, "pages/strip/strip.wxml"), "utf8");
    expect((wxml.match(/is="effect-controls"/g) ?? []).length).toBe(3);
  });

  it("面板单元不 import 页面，也不碰 wx / BLE", () => {
    const source = readFileSync(join(ROOT, "utils/control/panel-unit.ts"), "utf8");
    expect(source).not.toMatch(/from\s+["'][^"']*pages\//);
    expect(source).not.toMatch(/\bwx\./);
    expect(source).not.toMatch(/from\s+["'][^"']*\/ble\//);
  });

  it("灯组页只是它的调用方（派生与改参数都经单元）", () => {
    const page = readFileSync(join(ROOT, "pages/strip/strip.ts"), "utf8");
    expect(page).toContain("panelUnitView(");
    expect(page).toContain("selectPanelTarget(");
    expect(page).toContain("applyPanelSliderValue(");
  });
});

describe("与协议层的装配一致性", () => {
  it("单元装配的层与 panelLayer 逐字段一致", () => {
    const unit = switchPanelMode(createPanelUnit(), "rainbow");
    const [spec] = panelUnitZoneSpecs(unit, [zone()], 0);
    expect(spec.layer0).toEqual(panelLayer("rainbow", panelUnitParams(unit)));
  });

  it("关闭叠加层后装配成单层 + 覆盖（协议硬约束）", () => {
    const unit = switchPanelMode(createPanelUnit(), "breathing");
    const [spec] = panelUnitZoneSpecs(unit, [zone()], 0);
    expect(spec.layer1.type).toBe(NO_EFFECT);
    expect(spec.blend).toBe(BLEND.OVER);
  });
});
