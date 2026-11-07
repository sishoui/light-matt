/**
 * #154 效果面板单元：**不依赖任何页面就能驱动**。
 *
 * prefactor（零行为变更）：把「换目标时从设备读回这一层的值 / 切类型 / 改参数 /
 * 回读当前值 / 装配成两层」抽成独立单元。用例只碰纯数据：给一层效果，断言类型
 * 切换与参数回读，不加载页面、不碰 wx、不碰设备。
 *
 * 判据是票面那三条里的第二条与第三条：「给定一层效果，能切换类型、能改参数、
 * 能回读当前值」+「参数控件定义只有一份」。
 *
 * v5 的形状：一层是 `EffectLayer`（9 字节层的内存形状），目标是
 * 「场景 / 灯组 / 部位 / 步骤 / 第几层」，没有 v4 的分区与方案槽位。
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  applyOverlayChoiceValue,
  applyOverlayChoiceParam,
  applyOverlaySliderValue,
  applyPanelChoiceValue,
  applyPanelSliderValue,
  createPanelUnit,
  newStepLayers,
  panelUnitCheck,
  panelUnitKey,
  panelUnitLayers,
  panelUnitParams,
  panelUnitView,
  resetPanelUnit,
  selectPanelStep,
  selectPanelTarget,
  setPanelUnitHint,
  switchPanelMode,
} from "../utils/control/panel-unit";
import {
  CHOICE_KEYS,
  SLIDER_KEYS,
  PANEL_EMPTY_STEP_GUIDE,
  PANEL_NO_STEP_GUIDE,
  PANEL_OFF_NOTICE,
  defaultParams,
  emptyOverlayDraft,
  paramsFromLayer,
  panelLayer,
} from "../utils/control/effect-panel";
import { EFFECT_TYPE, NO_EFFECT } from "../utils/protocol/constants";
import type { EffectLayer } from "../utils/protocol/types";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const TARGET = { sceneId: 0, stripId: 0, partId: 0, stepIndex: 0, layer: 0 } as const;
const LIVE = { hasLayer: true };
const EMPTY = { hasLayer: false };

/** 一层常亮：暖白、满亮。 */
function staticLayer(overrides: Partial<EffectLayer> = {}): EffectLayer {
  return {
    type: EFFECT_TYPE.STATIC,
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

/** 一步的两层。 */
function sceneStep(layer0: EffectLayer, layer1: EffectLayer = emptyLayer()) {
  return { layer0, layer1 };
}

describe("给定一层效果 → 回读当前值", () => {
  it("选中一个常亮层：类型是常亮，参数从层里读回（含亮度）", () => {
    const unit = selectPanelTarget(
      createPanelUnit(),
      TARGET,
      staticLayer({ hue: 30000, level: 42 }),
    );
    expect(unit.mode).toBe("static");
    expect(panelUnitParams(unit).hue).toBe(30000);
    expect(panelUnitParams(unit).level).toBe(42);
  });

  it("呼吸层读回周期与最低亮（协议值 → 面板单位）", () => {
    const layer = staticLayer({ type: EFFECT_TYPE.BREATHING, periodMs: 2000, p5: 40, level: 80 });
    const unit = selectPanelTarget(
      createPanelUnit(),
      { ...TARGET, stepIndex: 1 },
      layer,
    );
    expect(unit.mode).toBe("breathing");
    expect(panelUnitParams(unit)).toEqual(paramsFromLayer("breathing", layer));
  });

  it("同一目标重复选中不重读（拖动中的读数不会被一次重画冲掉）", () => {
    const first = selectPanelTarget(createPanelUnit(), TARGET, staticLayer());
    const edited = applyPanelSliderValue(first, "hue", 120);
    const again = selectPanelTarget(edited, TARGET, staticLayer({ hue: 7281 }));
    expect(again, "键没变就返回同一个状态").toBe(edited);
    expect(panelUnitParams(again).hue, "用户拖过的值还在").toBe(Math.round((120 / 360) * 0x10000));
  });

  it("换目标时清掉一次性反馈（切步骤不带着上一个的提示）", () => {
    const hinted = setPanelUnitHint(
      selectPanelTarget(createPanelUnit(), TARGET, staticLayer()),
      "写不进去",
    );
    expect(panelUnitView(hinted, LIVE).panelHint).toBe("写不进去");
    const moved = selectPanelTarget(hinted, { ...TARGET, stepIndex: 1 }, staticLayer());
    expect(moved.hint).toBe("");
    expect(panelUnitView(moved, LIVE).panelHint).toBe("");
  });

  it("读不到这一层：回到常亮默认值，不留任何滑块", () => {
    const unit = selectPanelTarget(createPanelUnit(), TARGET, null);
    expect(unit.mode).toBe("static");
    expect(panelUnitParams(unit)).toEqual(defaultParams("static"));
    const view = panelUnitView(unit, EMPTY);
    expect(view.panelSliders).toEqual([]);
    expect(view.panelChoices).toEqual([]);
    expect(view.panelHasLayer).toBe(false);
    expect(view.panelGuide).toBe(PANEL_NO_STEP_GUIDE);
  });

  it("「熄灭」没有旋钮，只给一行说明（没有目标时连说明都不给）", () => {
    const unit = selectPanelTarget(
      createPanelUnit(),
      TARGET,
      staticLayer({ type: EFFECT_TYPE.OFF }),
    );
    const view = panelUnitView(unit, LIVE);
    expect(view.panelSliders).toEqual([]);
    expect(view.panelChoices).toEqual([]);
    expect(view.panelNotice).toBe(PANEL_OFF_NOTICE);
    expect(view.panelColorHex).toBe("");
    /* 没读到目标时说明必须消失，否则它是一句凭空捏造的描述。 */
    expect(panelUnitView(unit, EMPTY).panelNotice).toBe("");
  });
});

describe("切换类型", () => {
  it("常亮 → 呼吸：保留颜色与亮度，其余回到新类型默认值", () => {
    const unit = selectPanelTarget(
      createPanelUnit(),
      TARGET,
      staticLayer({ hue: 20000, sat: 128, level: 55 }),
    );
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

  it("类型行永远八项（七个灯效 + 空），选中态跟着当前类型", () => {
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

  it("亮度记在目标键上（切步骤再切回来，还没下发的值不丢）", () => {
    const first = applyPanelSliderValue(
      selectPanelTarget(createPanelUnit(), TARGET, staticLayer({ level: 100 })),
      "level",
      20,
    );
    /* 切到别的步骤再切回来：层里还是 100，但用户刚拖的 20 要保住。 */
    const other = selectPanelTarget(first, { ...TARGET, stepIndex: 1 }, staticLayer());
    const back = selectPanelTarget(other, TARGET, staticLayer({ level: 100 }));
    expect(panelUnitParams(back).level).toBe(20);
  });

  it("非法键 / 非有限值原样返回", () => {
    const unit = createPanelUnit();
    expect(applyPanelSliderValue(unit, "nope", 10)).toBe(unit);
    expect(applyPanelSliderValue(unit, "hue", Number.NaN)).toBe(unit);
  });

  it("波形 / 方向 / 占空比 / 脉冲这些选项也走同一个入口", () => {
    const comet = switchPanelMode(createPanelUnit(), "comet");
    const reversed = applyPanelChoiceValue(comet, "direction", 1);
    expect(panelUnitParams(reversed).reverse).toBe(true);
    const breathing = switchPanelMode(createPanelUnit(), "breathing");
    const square = applyPanelChoiceValue(breathing, "waveform", 3);
    expect(panelUnitParams(square).waveform).toBe(3);
    const heartbeat = switchPanelMode(createPanelUnit(), "heartbeat");
    expect(panelUnitParams(applyPanelChoiceValue(heartbeat, "pulse", 0)).doublePulse).toBe(false);
  });

  it("改参数不换目标键（播放头与模型位置都不动）", () => {
    const target = { sceneId: 1, stripId: 2, partId: 3, stepIndex: 4, layer: 0 } as const;
    const unit = selectPanelTarget(createPanelUnit(), target, staticLayer());
    const tuned = applyPanelSliderValue(unit, "level", 50);
    expect(tuned.key).toBe(panelUnitKey(target));
    expect(tuned.mode).toBe(unit.mode);
  });
});

describe("叠加层（第二层）", () => {
  it("默认关闭；打开后有自己的参数区", () => {
    const unit = createPanelUnit();
    expect(unit.overlay).toEqual(emptyOverlayDraft());
    const withOverlay = applyOverlayChoiceValue(unit, "comet");
    const view = panelUnitView(withOverlay, LIVE);
    expect(view.overlayEnabled).toBe(true);
    expect(view.overlaySliders.map((slider) => slider.key)).toEqual([...SLIDER_KEYS.comet]);
    expect(view.overlayChoices2.map((choice) => choice.key)).toEqual([...CHOICE_KEYS.comet]);
    expect(view.overlaySummary.length).toBeGreaterThan(0);
  });

  it("叠加层参数与主效果互相独立", () => {
    const tuned = applyOverlaySliderValue(
      applyOverlayChoiceValue(createPanelUnit(), "comet"),
      "tail",
      30,
    );
    expect(panelUnitParams(tuned).tail, "主效果不受影响").toBe(defaultParams("static").tail);
    expect(tuned.overlay.params.tail).toBe(Math.round((30 / 100) * 255));
  });

  it("关闭时保留参数（再开回来还能接着调）", () => {
    const tuned = applyOverlaySliderValue(
      applyOverlayChoiceValue(createPanelUnit(), "comet"),
      "tail",
      30,
    );
    const closed = applyOverlayChoiceValue(tuned, "none");
    expect(closed.overlay.type).toBe("none");
    expect(closed.overlay.params.tail).toBe(tuned.overlay.params.tail);
    expect(panelUnitView(closed, LIVE).overlayEnabled).toBe(false);
    expect(panelUnitView(closed, LIVE).overlaySliders).toEqual([]);
  });

  it("没打开叠加层时滑块入口原样返回", () => {
    const unit = createPanelUnit();
    expect(applyOverlaySliderValue(unit, "tail", 50)).toBe(unit);
  });

  it("关闭状态下改选择项仍记住（再开回来是自己调过的样子）", () => {
    const unit = applyOverlayChoiceParam(createPanelUnit(), "waveform", 3);
    expect(unit.overlay.type, "没打开就没有参数区可拖").toBe("none");
    expect(unit.overlay.params.waveform).toBe(3);
  });

  it("非法叠加类型原样返回", () => {
    const unit = createPanelUnit();
    expect(applyOverlayChoiceValue(unit, "nope" as never)).toBe(unit);
  });

  it("从一步快照读回叠加层（空层 → 关闭）", () => {
    const layer1 = staticLayer({ type: EFFECT_TYPE.RAINBOW, periodMs: 3000 });
    const unit = selectPanelStep(createPanelUnit(), TARGET, sceneStep(staticLayer(), layer1));
    expect(unit.overlay.type).toBe("rainbow");
    expect(panelUnitView(unit, LIVE).overlayEnabled).toBe(true);

    const none = selectPanelStep(createPanelUnit(), TARGET, sceneStep(staticLayer()));
    expect(none.overlay).toEqual(emptyOverlayDraft());
  });
});

describe("装配成两层与本地预检", () => {
  it("改完装配成可直接下发的两层：主效果按草稿编码，叠加层关闭时空", () => {
    const unit = applyPanelSliderValue(
      selectPanelTarget(createPanelUnit(), TARGET, staticLayer()),
      "hue",
      45,
    );
    const layers = panelUnitLayers(unit);
    expect(layers.layer0.hue).toBe(Math.round((45 / 360) * 0x10000));
    expect(layers.layer0).toEqual(panelLayer("static", panelUnitParams(unit)));
    /* 叠加层关闭 → 空层（type = NO_EFFECT，其余全 0）。 */
    expect(layers.layer1.type).toBe(NO_EFFECT);
    expect(layers.layer1.level).toBe(0);
  });

  it("打开叠加层后 layer1 有真实内容（设备按亮度叠加）", () => {
    const unit = applyOverlayChoiceValue(createPanelUnit(), "comet");
    const layers = panelUnitLayers(unit);
    expect(layers.layer1.type).toBe(EFFECT_TYPE.COMET);
    expect(layers.layer1.periodMs).toBeGreaterThan(0);
  });

  it("越界的爆闪频率被本地预检拦住并给出原因", () => {
    const strobe = switchPanelMode(createPanelUnit(), "strobe");
    const unit = { ...strobe, params: { ...panelUnitParams(strobe), frequencyHz: 99 } };
    const check = panelUnitCheck(unit);
    expect(check.ok).toBe(false);
    expect(check.message.length).toBeGreaterThan(0);
  });

  it("越界的心跳节奏也被拦住（过快 / 过慢分别是不同原因）", () => {
    const heartbeat = switchPanelMode(createPanelUnit(), "heartbeat");
    const fast = { ...heartbeat, params: { ...panelUnitParams(heartbeat), bpm: 200 } };
    const slow = { ...heartbeat, params: { ...panelUnitParams(heartbeat), bpm: 5 } };
    expect(panelUnitCheck(fast).ok).toBe(false);
    expect(panelUnitCheck(slow).ok).toBe(false);
    expect(panelUnitCheck(fast).message).not.toBe(panelUnitCheck(slow).message);
  });

  it("正常参数通过预检", () => {
    expect(panelUnitCheck(createPanelUnit()).ok).toBe(true);
  });

  it("重置回到常亮默认值并清掉亮度记忆", () => {
    const unit = applyPanelSliderValue(
      selectPanelTarget(createPanelUnit(), TARGET, staticLayer()),
      "level",
      10,
    );
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

  it("单元自己不新增任何键表（全部从 effect-panel 取）", () => {
    const source = readFileSync(join(ROOT, "utils/control/panel-unit.ts"), "utf8");
    /* 参数控件的清单只能出现在 `effect-panel`：这里不出现字面量键数组。 */
    expect(source).not.toMatch(/\[\s*"hue"\s*,\s*"sat"/);
    expect(source).toContain("buildEffectPanel(");
    expect(source).toContain("applySlider(");
    expect(source).toContain("applyChoice(");
  });

  it("新步骤的两层与「切到常亮」是同一份编码（#157）", () => {
    const layers = newStepLayers();
    expect(layers.layer0.type).toBe(EFFECT_TYPE.STATIC);
    /* 叠加层必须是空层：空层 → 设备按「覆盖」合成（§6.2）。 */
    expect(layers.layer1.type).toBe(NO_EFFECT);
    expect(layers.layer1.level).toBe(0);
    /* 与切换类型到常亮得到的编码逐字节一致。 */
    const switched = panelUnitLayers(switchPanelMode(createPanelUnit(), "static"));
    expect(layers.layer0).toEqual(switched.layer0);
  });

  it("页面调的是单元，不是 effect-panel 的细节", () => {
    const page = readFileSync(join(ROOT, "pages/part/part.ts"), "utf8");
    expect(page).toContain("panelUnitView(");
    expect(page).toContain("selectPanelStep(");
    expect(page).toContain("applyPanelSliderValue(");
    expect(page).toContain("switchPanelMode(");
    /* 页面不直接调用 effect-panel 的装配 / 键表。 */
    expect(page).not.toContain("buildEffectPanel(");
    expect(page).not.toContain("panelLayer(");
  });

  it("面板单元不 import 页面，也不碰 wx / BLE", () => {
    const source = readFileSync(join(ROOT, "utils/control/panel-unit.ts"), "utf8");
    expect(source).not.toMatch(/from\s+["'][^"']*pages\//);
    expect(source).not.toMatch(/\bwx\./);
    expect(source).not.toMatch(/from\s+["'][^"']*\/ble\//);
  });

  it("不 import 任何 v4 模型（分区 / 叠加方式 / 方案槽位）", () => {
    const source = readFileSync(join(ROOT, "utils/control/panel-unit.ts"), "utf8");
    for (const gone of ["zone-model", "SegmentSpec", "planSlot", "blend"]) {
      expect(source, `不应再依赖 ${gone}`).not.toContain(gone);
    }
  });
});

describe("与协议层的装配一致性", () => {
  it("单元装配的底层与 panelLayer 逐字段一致", () => {
    const unit = switchPanelMode(createPanelUnit(), "rainbow");
    const layers = panelUnitLayers(unit);
    expect(layers.layer0).toEqual(panelLayer("rainbow", panelUnitParams(unit)));
  });

  it("关闭叠加层后装配成单层（layer1 是空层，设备按覆盖合成）", () => {
    const unit = switchPanelMode(createPanelUnit(), "breathing");
    const layers = panelUnitLayers(unit);
    expect(layers.layer1.type).toBe(NO_EFFECT);
  });

  it("「空」档编码成熄灭类型（全零参数块）", () => {
    const unit = switchPanelMode(createPanelUnit(), "off");
    const layers = panelUnitLayers(unit);
    expect(layers.layer0.type).toBe(EFFECT_TYPE.OFF);
    expect(layers.layer0.level).toBe(0);
    expect(layers.layer0.p5).toBe(0);
  });
});
