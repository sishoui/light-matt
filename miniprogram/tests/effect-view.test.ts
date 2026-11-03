/**
 * 灯效编辑的纯视图逻辑（#53）：从 `pages/segment-edit` 下沉出来。
 *
 * 这些断言原来的位置是「只有模拟器能验证」的页面里。下沉到纯函数后，
 * 四条最容易出错的规则可以在 node 里锁死：
 *  - 切换灯效类型时保留颜色、只清该类型用不到的 flags 位；
 *  - 从静态切到动画必须给一个可感知的默认周期（否则「周期 0 = 静止」会误导）；
 *  - 预设高亮按 hue+sat 判定，不比 hex 字符串；
 *  - 叠加效果为空时折叠态不生效、叠加方式被归一为覆盖。
 */

import { describe, expect, it } from "vitest";
import {
  BLEND_OPTIONS,
  MAIN_MODE_OPTIONS,
  OVERLAY_MODE_OPTIONS,
  applyLayerType,
  blendName,
  buildLayerPanel,
  defaultCollapsed,
  layerModeOf,
  layerView,
  presetSelectedFlags,
  setCollapsed,
  toggleCollapsed,
} from "../utils/control/effect-view";
import { BLEND, BREATHING_MIN_PERIOD_MS, NO_EFFECT, SEGMENT_TYPE, WAVEFORM } from "../utils/protocol/constants";
import { PRESETS, rgbToSegmentParams } from "../utils/color/hsv";
import type { EffectLayer } from "../utils/protocol/types";

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

describe("灯效选项表", () => {
  it("主效果只有四种灯效，没有「关闭」（必填）", () => {
    expect(MAIN_MODE_OPTIONS.map((option) => option.mode)).toEqual([
      "static",
      "breathing",
      "rainbow",
      "comet",
    ]);
    expect(MAIN_MODE_OPTIONS.some((option) => option.type === NO_EFFECT)).toBe(false);
  });

  it("叠加效果多一个「关闭」，且 Close 是唯一能成为空层的入口", () => {
    expect(OVERLAY_MODE_OPTIONS).toHaveLength(MAIN_MODE_OPTIONS.length + 1);
    expect(OVERLAY_MODE_OPTIONS.filter((option) => option.type === NO_EFFECT)).toHaveLength(1);
  });

  it("选项的 type 与协议常量一一对应", () => {
    const types = MAIN_MODE_OPTIONS.map((option) => option.type);
    expect(types).toEqual([
      SEGMENT_TYPE.STATIC,
      SEGMENT_TYPE.BREATHING,
      SEGMENT_TYPE.RAINBOW,
      SEGMENT_TYPE.COMET,
    ]);
  });

  it("叠加方式只有三种，顺序 = 协议值", () => {
    expect(BLEND_OPTIONS.map((option) => option.value)).toEqual([BLEND.OVER, BLEND.MULTIPLY, BLEND.ADD]);
    expect(blendName(BLEND.ADD)).toBe("相加");
    expect(blendName(9 as never)).toBe("覆盖");
  });
});

describe("layerModeOf", () => {
  it("四种类型与空层映射正确", () => {
    expect(layerModeOf(SEGMENT_TYPE.STATIC)).toBe("static");
    expect(layerModeOf(SEGMENT_TYPE.BREATHING)).toBe("breathing");
    expect(layerModeOf(SEGMENT_TYPE.RAINBOW)).toBe("rainbow");
    expect(layerModeOf(SEGMENT_TYPE.COMET)).toBe("comet");
    expect(layerModeOf(NO_EFFECT)).toBe("off");
  });

  it("未知类型按静态显示（不让界面空掉）", () => {
    expect(layerModeOf(0x42)).toBe("static");
  });
});

describe("切换灯效类型（applyLayerType）", () => {
  it("切到静态：周期 / 参数 / 标志位全部清零", () => {
    const target = layer(SEGMENT_TYPE.RAINBOW, { periodMs: 1000, p5: 255, flags: 1 });
    applyLayerType(target, SEGMENT_TYPE.STATIC);
    expect(target).toMatchObject({ type: SEGMENT_TYPE.STATIC, periodMs: 0, p5: 0, flags: 0 });
  });

  it("切到呼吸：只保留波形位（bit1-2），方向位清零", () => {
    const target = layer(SEGMENT_TYPE.RAINBOW, { flags: 0x01 }); /* 方向位 */
    applyLayerType(target, SEGMENT_TYPE.BREATHING);
    expect(target.flags & 0x01).toBe(0);
  });

  it("切到彩虹 / 流光：只保留方向位（bit0），波形位清零", () => {
    for (const type of [SEGMENT_TYPE.RAINBOW, SEGMENT_TYPE.COMET]) {
      const target = layer(SEGMENT_TYPE.BREATHING, { flags: 0x06 }); /* 波形位 */
      applyLayerType(target, type);
      expect(target.flags & 0x06, String(type)).toBe(0);
      expect(target.flags & 0x01).toBe(0);
    }
  });

  it("从静态（周期 0）切到动画：给一个可感知的默认周期", () => {
    const breathing = layer(SEGMENT_TYPE.STATIC);
    applyLayerType(breathing, SEGMENT_TYPE.BREATHING);
    expect(breathing.periodMs).toBeGreaterThanOrEqual(BREATHING_MIN_PERIOD_MS);

    const rainbow = layer(SEGMENT_TYPE.STATIC);
    applyLayerType(rainbow, SEGMENT_TYPE.RAINBOW);
    expect(rainbow.periodMs).toBeGreaterThan(0);
  });

  it("已有周期低于新类型下限时抬到下限（不产生一条必被拒的草稿）", () => {
    const target = layer(SEGMENT_TYPE.RAINBOW, { periodMs: 200 });
    applyLayerType(target, SEGMENT_TYPE.BREATHING);
    expect(target.periodMs).toBeGreaterThanOrEqual(BREATHING_MIN_PERIOD_MS);
  });

  it("已有周期高于下限时保持不变", () => {
    const target = layer(SEGMENT_TYPE.RAINBOW, { periodMs: 5000 });
    applyLayerType(target, SEGMENT_TYPE.COMET);
    expect(target.periodMs).toBe(5000);
  });

  it("类型没变时整层原样返回（不悄悄重置参数）", () => {
    const target = layer(SEGMENT_TYPE.BREATHING, { periodMs: 1234, p5: 77, flags: 0x04 });
    const before = { ...target };
    applyLayerType(target, SEGMENT_TYPE.BREATHING);
    expect(target).toEqual(before);
  });

  it("保留颜色（hue / sat 不被动过）", () => {
    const target = layer(SEGMENT_TYPE.STATIC, { hue: 12345, sat: 200 });
    applyLayerType(target, SEGMENT_TYPE.COMET);
    expect([target.hue, target.sat]).toEqual([12345, 200]);
  });
});

describe("预设高亮（presetSelectedFlags）", () => {
  it("与当前层色完全相等的预设才高亮，长度与预设表一致", () => {
    const flags = PRESETS.map((preset) => {
      const params = rgbToSegmentParams(preset.rgb);
      return presetSelectedFlags(layer(SEGMENT_TYPE.STATIC, { hue: params.hue, sat: params.sat }));
    });
    for (const [index, selected] of flags.entries()) {
      expect(selected, PRESETS[index].name).toHaveLength(PRESETS.length);
      /* 每个预设都必须高亮它自己（否则「点了预设却没选中」）。 */
      expect(selected[index], `${PRESETS[index].name} 应高亮自身`).toBe(true);
    }
  });

  it("改一点点色相就不再高亮（按 hue+sat 判定，不比 hex）", () => {
    const params = rgbToSegmentParams(PRESETS[0].rgb);
    const exact = presetSelectedFlags(layer(SEGMENT_TYPE.STATIC, { hue: params.hue, sat: params.sat }));
    expect(exact[0]).toBe(true);

    const nudged = presetSelectedFlags(
      layer(SEGMENT_TYPE.STATIC, { hue: params.hue + 1, sat: params.sat }),
    );
    expect(nudged[0]).toBe(false);
    expect(nudged.some(Boolean)).toBe(false);
  });

  it("灰阶（sat = 0）不会误命中任何彩色预设", () => {
    const gray = presetSelectedFlags(layer(SEGMENT_TYPE.STATIC, { hue: 0, sat: 0 }));
    expect(gray.some(Boolean)).toBe(false);
  });
});

describe("折叠态", () => {
  it("默认主效果展开、叠加效果为空时收起", () => {
    expect(defaultCollapsed(layer(NO_EFFECT))).toEqual([false, true]);
  });

  it("叠加效果有内容时默认展开（让用户看到设备上的真实值）", () => {
    expect(defaultCollapsed(layer(SEGMENT_TYPE.BREATHING, { periodMs: 1000 }))).toEqual([false, false]);
  });

  it("toggle 只翻转指定那一层", () => {
    expect(toggleCollapsed([false, true], 0)).toEqual([true, true]);
    expect(toggleCollapsed([false, true], 1)).toEqual([false, false]);
  });

  it("set 显式赋值只改指定那一层", () => {
    expect(setCollapsed([true, false], 1, true)).toEqual([true, true]);
    expect(setCollapsed([true, false], 0, false)).toEqual([false, false]);
  });

  it("toggle / set 都不就地改输入", () => {
    const original: [boolean, boolean] = [false, true];
    toggleCollapsed(original, 0);
    setCollapsed(original, 1, false);
    expect(original).toEqual([false, true]);
  });
});

describe("一层视图（layerView）", () => {
  it("主效果 / 叠加效果的标题不同", () => {
    /* 术语（decisions §12）：界面不出现「层」，两层改叫主效果 / 叠加效果。 */
    expect(layerView(layer(SEGMENT_TYPE.STATIC), 0, false).label).toBe("主效果（必填）");
    expect(layerView(layer(NO_EFFECT), 1, false).label).toBe("叠加效果（可选）");
  });

  it("空层永远展开（否则找不到打开它的入口）", () => {
    expect(layerView(layer(NO_EFFECT), 1, true).collapsed).toBe(false);
  });

  it("主效果拿到四种选项，叠加效果拿到五种", () => {
    expect(layerView(layer(SEGMENT_TYPE.STATIC), 0, false).modeOptions).toHaveLength(4);
    expect(layerView(layer(NO_EFFECT), 1, false).modeOptions).toHaveLength(5);
  });

  it("参数文本按类型派生（呼吸周期 / 最暗 / 波形）", () => {
    const view = layerView(
      layer(SEGMENT_TYPE.BREATHING, { periodMs: 1000, p5: 51, flags: (WAVEFORM.TRIANGLE & 0x03) << 1 }),
      0,
      false,
    );
    expect(view.breathing).toBe(true);
    expect(view.periodText).toBe("1000ms");
    /* v4：呼吸的 p5 是相对百分比，51 就是 51%。 */
    expect(view.minLevelText).toBe("51%");
    expect(view.waveform).toBe(WAVEFORM.TRIANGLE);
    expect(view.periodFloor).toBe(BREATHING_MIN_PERIOD_MS);
  });

  it("周期 0 显示「静止」而不是 0ms", () => {
    expect(layerView(layer(SEGMENT_TYPE.BREATHING, { periodMs: 0 }), 0, false).periodText).toBe("静止");
  });

  it("空层的周期显示占位符（没有可编辑的参数）", () => {
    expect(layerView(layer(NO_EFFECT), 1, false).periodText).toBe("—");
  });

  it("彩虹 / 流光的方向位正确读出", () => {
    expect(layerView(layer(SEGMENT_TYPE.COMET, { flags: 0x01 }), 0, false).reverse).toBe(true);
    expect(layerView(layer(SEGMENT_TYPE.RAINBOW, { flags: 0x00 }), 0, false).reverse).toBe(false);
  });

  it("给出展示色（四类灯效都有基准色）", () => {
    for (const type of [SEGMENT_TYPE.STATIC, SEGMENT_TYPE.BREATHING, SEGMENT_TYPE.RAINBOW, SEGMENT_TYPE.COMET]) {
      expect(layerView(layer(type, { hue: 21845, sat: 255 }), 0, false).colorHex).toMatch(/^#[0-9A-F]{6}$/i);
    }
  });
});

describe("整个面板（buildLayerPanel）", () => {
  const main = layer(SEGMENT_TYPE.STATIC);
  const overlay = layer(SEGMENT_TYPE.BREATHING, { periodMs: 1000 });

  it("叠加效果为空时叠加方式被归一为覆盖并禁用", () => {
    const panel = buildLayerPanel(BLEND.ADD, main, layer(NO_EFFECT), [false, true]);
    expect(panel.blendEnabled).toBe(false);
    expect(panel.blend).toBe(BLEND.OVER);
    expect(panel.blendHint).toContain("固定为覆盖");
    expect(panel.blendHint).not.toContain("层");
  });

  it("有叠加效果时保留草稿选的叠加方式", () => {
    const panel = buildLayerPanel(BLEND.MULTIPLY, main, overlay, [false, false]);
    expect(panel.blendEnabled).toBe(true);
    expect(panel.blend).toBe(BLEND.MULTIPLY);
    expect(panel.blendHint).toBe(BLEND_OPTIONS[1].hint);
  });

  it("视图元组的顺序是「主效果 / 叠加效果」", () => {
    const panel = buildLayerPanel(BLEND.OVER, main, overlay, [false, false]);
    expect(panel.views[0].label).toBe("主效果（必填）");
    expect(panel.views[1].label).toBe("叠加效果（可选）");
  });

  it("折叠态原样透传给对应的层", () => {
    const panel = buildLayerPanel(BLEND.OVER, main, overlay, [true, true]);
    expect(panel.views[0].collapsed).toBe(true);
    expect(panel.views[1].collapsed).toBe(true);
  });
});
