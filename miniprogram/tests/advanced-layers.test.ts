/**
 * #100 两层模型 + 八个灯效清单。
 *
 * 锁四件用户能感知的事：
 *  1. 灯效清单恰好八个，名字里没有颜色词（彩虹除外）；
 *  2. 混合方式只剩「相加 / 覆盖」——界面里没有「相乘」；
 *  3. 界面里没有「叠加效果」区块，也没有「熄灭」这个词；
 *  4. 背景层能选「空」，且编码成既有的熄灭类型（输出等价于不贡献光）。
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BLEND_OPTIONS,
  LAYER_KIND,
  LOOP_MODE,
  backgroundBlendOf,
  buildLayerViews,
  clampLoopMode,
  clampUiBlend,
  defaultBlendFor,
  defaultLayers,
  encodeLayer,
  isLoopMode,
  isUiBlend,
  layerIsEmpty,
  layersInOrder,
  loopFlagsOf,
  loopLabel,
} from "../utils/control/advanced-layers";
import { BLEND, NO_EFFECT, SEGMENT_TYPE } from "../utils/protocol/constants";
import {
  PANEL_EFFECT_OPTIONS,
  PANEL_TYPE_OPTIONS,
  OVERLAY_BLEND_OPTIONS,
} from "../utils/control/effect-panel";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const STRIP_WXML = readFileSync(join(ROOT, "pages/strip/strip.wxml"), "utf8");

describe("八个灯效（进阶档）", () => {
  it("恰好八个：七个灯效 + 「空」", () => {
    /* 七个「有光」的灯效在 PANEL_EFFECT_OPTIONS 里；「空」是第八个。 */
    expect(PANEL_EFFECT_OPTIONS.length).toBe(7);
    expect(PANEL_EFFECT_OPTIONS.map((option) => option.name)).toEqual([
      "常亮",
      "呼吸",
      "彩虹",
      "流星",
      "爆闪",
      "心跳",
      "随机闪烁",
    ]);
    expect(PANEL_TYPE_OPTIONS.length).toBe(8);
    expect(PANEL_TYPE_OPTIONS.map((option) => option.name)).toContain("空");
  });

  it("面板类型清单也是八个，且没有「熄灭」「静态」「流光」", () => {
    expect(PANEL_TYPE_OPTIONS.length).toBe(8);
    const names = PANEL_TYPE_OPTIONS.map((option) => option.name);
    for (const banned of ["熄灭", "静态", "流光", "暖白", "冷蓝", "紫色", "爆闪白", "心跳暖红"]) {
      expect(names, banned).not.toContain(banned);
    }
    /* 只有「彩虹」允许带颜色语义。 */
    const colorWords = /[暖冷红绿蓝紫白黄橙青粉黑]/;
    for (const name of names) {
      if (name.includes("彩虹")) continue;
      expect(colorWords.test(name), name).toBe(false);
    }
  });

  it("随机闪烁是独立项（不复用「爆闪」）", () => {
    expect(PANEL_TYPE_OPTIONS.map((option) => option.type)).toContain("flicker");
  });

  it("心跳有单 / 双脉冲开关，没有独立的「脉冲」灯效", () => {
    const names = PANEL_TYPE_OPTIONS.map((option) => option.name);
    expect(names).not.toContain("脉冲");
    expect(names).toContain("心跳");
  });
});

describe("混合方式只有「按亮度叠加」", () => {
  it("界面上只有按亮度叠加", () => {
    expect(OVERLAY_BLEND_OPTIONS.map((option) => option.value)).toEqual([BLEND.LUMA]);
    expect(BLEND_OPTIONS.map((option) => option.value)).toEqual([BLEND.LUMA]);
  });

  it("没有「覆盖」「相加」「相乘」", () => {
    const labels = [...OVERLAY_BLEND_OPTIONS, ...BLEND_OPTIONS].map(
      (option) => option.label ?? option.name,
    );
    expect(labels).not.toContain("相乘");
    expect(labels).not.toContain("覆盖");
    expect(labels).not.toContain("相加");
  });

  it("设备读回旧值（覆盖 / 相乘 / 相加）时归一为按亮度叠加", () => {
    /* 界面不再产生这些值，但协议仍接受它们——读回时绝不能当非法值。 */
    expect(isUiBlend(BLEND.MULTIPLY)).toBe(false);
    expect(isUiBlend(BLEND.OVER)).toBe(false);
    expect(isUiBlend(BLEND.ADD)).toBe(false);
    expect(isUiBlend(BLEND.LUMA)).toBe(true);
    expect(clampUiBlend(BLEND.MULTIPLY)).toBe(BLEND.LUMA);
    expect(clampUiBlend(BLEND.ADD)).toBe(BLEND.LUMA);
    expect(clampUiBlend(BLEND.OVER)).toBe(BLEND.LUMA);
  });

  it("两层都有内容时恒为按亮度叠加（与「有没有颜色」无关）", () => {
    expect(defaultBlendFor(false)).toBe(BLEND.LUMA);
    expect(defaultBlendFor(true)).toBe(BLEND.LUMA);
  });
});

describe("两层的编码", () => {
  it("背景层的「空」编码成熄灭类型 + 全零参数", () => {
    const layer = encodeLayer({
      effectId: "empty",
      effectType: SEGMENT_TYPE.STATIC,
      empty: true,
      params: { hue: 1234, sat: 200, periodMs: 500, p5: 10, flags: 1, level: 80 },
    });
    expect(layer.type).toBe(SEGMENT_TYPE.OFF);
    expect(layer.hue).toBe(0);
    expect(layer.sat).toBe(0);
    expect(layer.periodMs).toBe(0);
    expect(layer.p5).toBe(0);
    expect(layer.flags).toBe(0);
    expect(layer.level).toBe(0);
  });

  it("非空层原样写类型与参数", () => {
    const layer = encodeLayer({
      effectId: "breathe",
      effectType: SEGMENT_TYPE.BREATHING,
      empty: false,
      params: { hue: 100, sat: 200, periodMs: 2000, p5: 20, flags: 0, level: 100 },
    });
    expect(layer).toEqual({
      type: SEGMENT_TYPE.BREATHING,
      hue: 100,
      sat: 200,
      periodMs: 2000,
      p5: 20,
      flags: 0,
      level: 100,
    });
  });

  it("两层都有内容时用按亮度叠加；特效层为空时协议要求 blend = 0", () => {
    /* 背景层为空也照样是 LUMA：`L0 = 0` 时它就退化成 `out = L1`，
     * 与「覆盖」等价，不需要特例。 */
    expect(backgroundBlendOf(true, false)).toBe(BLEND.LUMA);
    expect(backgroundBlendOf(false, false)).toBe(BLEND.LUMA);
    /* 特效层为空 → 单层段，协议硬要求 blend = 0（§7.1 第 5 步）。 */
    expect(backgroundBlendOf(true, true)).toBe(BLEND.OVER);
    expect(backgroundBlendOf(false, true)).toBe(BLEND.OVER);
  });

  it("空层判定覆盖 0xFF 与熄灭两种形态", () => {
    expect(layerIsEmpty(null)).toBe(true);
    expect(layerIsEmpty(undefined)).toBe(true);
    expect(layerIsEmpty({ type: NO_EFFECT } as never)).toBe(true);
    expect(layerIsEmpty({ type: SEGMENT_TYPE.OFF } as never)).toBe(true);
    expect(layerIsEmpty({ type: SEGMENT_TYPE.STATIC } as never)).toBe(false);
  });
});

describe("两层视图", () => {
  it("先背景层、后特效层；空的那层显示「空」", () => {
    const views = buildLayerViews({
      backgroundName: "呼吸",
      effectName: "流星",
      backgroundEmpty: false,
      effectEmpty: false,
    });
    expect(views.map((view) => view.kind)).toEqual([LAYER_KIND.BACKGROUND, LAYER_KIND.EFFECT]);
    expect(views.map((view) => view.label)).toEqual(["背景层", "特效层"]);
    expect(views[0].effectName).toBe("呼吸");

    const emptyEffect = buildLayerViews({
      backgroundName: "常亮",
      effectName: "流星",
      backgroundEmpty: false,
      effectEmpty: true,
    });
    expect(emptyEffect[1].effectName).toBe("空");
    expect(emptyEffect[1].empty).toBe(true);
  });

  it("默认两层：背景常亮、特效空", () => {
    const layers = defaultLayers();
    expect(layers.background.effectId).toBe("solid");
    expect(layers.background.empty).toBe(false);
    expect(layers.effect.effectId).toBe("empty");
    expect(layers.effect.empty).toBe(true);
  });

  it("层的顺序固定（背景 → 特效）", () => {
    expect(layersInOrder()).toEqual([LAYER_KIND.BACKGROUND, LAYER_KIND.EFFECT]);
  });
});

describe("循环三档", () => {
  it("三档的值与协议一致", () => {
    expect(LOOP_MODE.NONE).toBe(0);
    expect(LOOP_MODE.ALL).toBe(1);
    expect(LOOP_MODE.LAST).toBe(2);
  });

  it("合法值判定与兜底", () => {
    expect(isLoopMode(0)).toBe(true);
    expect(isLoopMode(2)).toBe(true);
    expect(isLoopMode(3)).toBe(false);
    expect(clampLoopMode(3)).toBe(LOOP_MODE.NONE);
    expect(clampLoopMode("x")).toBe(LOOP_MODE.NONE);
  });

  it("「最后一步循环」同时置 loop 与 lastStep 位", () => {
    expect(loopFlagsOf(LOOP_MODE.NONE)).toEqual({ loop: false, lastStep: false });
    expect(loopFlagsOf(LOOP_MODE.ALL)).toEqual({ loop: true, lastStep: false });
    expect(loopFlagsOf(LOOP_MODE.LAST)).toEqual({ loop: true, lastStep: true });
  });

  it("每档都有可读文案", () => {
    expect(loopLabel(LOOP_MODE.NONE)).toBe("不循环");
    expect(loopLabel(LOOP_MODE.ALL)).toBe("全部循环");
    expect(loopLabel(LOOP_MODE.LAST)).toBe("最后一步循环");
  });
});

describe("页面结构", () => {
  it("有「背景层」与「特效层」，没有「叠加效果」区块", () => {
    expect(STRIP_WXML).toContain("背景层");
    expect(STRIP_WXML).toContain("特效层");
    const body = STRIP_WXML.replace(/<!--[\s\S]*?-->/g, "");
    expect(body).not.toContain("叠加效果");
    expect(body).not.toContain("叠加方式");
  });

  it("界面上没有「相乘」", () => {
    const body = STRIP_WXML.replace(/<!--[\s\S]*?-->/g, "");
    expect(body).not.toContain("相乘");
  });

  it("界面上没有「熄灭」这个词", () => {
    const body = STRIP_WXML.replace(/<!--[\s\S]*?-->/g, "");
    expect(body).not.toContain("熄灭");
  });

  it("循环三档在时间轴标题右侧", () => {
    const headIndex = STRIP_WXML.indexOf('class="timeline-head"');
    const loopIndex = STRIP_WXML.indexOf('class="loop-options"');
    expect(headIndex).toBeGreaterThanOrEqual(0);
    expect(loopIndex).toBeGreaterThan(headIndex);
  });
});
