/**
 * 灯组页简单档的纯派生。
 *
 * 断言：
 *  1. HSV 滑块 ↔ 协议值的换算（色相 0-360 ↔ 0-65535、饱和度 % ↔ 0-255），
 *     以及亮度滑块**真实下发**（v4 的逐分区 level）；
 *  2. 设备读回值只有在「整组一个分区 + 无叠加层」时才敢回填成某个灯效，
 *     并且回填的是**完整参数**（不再只有颜色与亮度）；
 *  3. 参数区与进阶档同源：滑块与选择项都来自 `effect-panel` 的
 *     `SLIDER_KEYS` / `CHOICE_KEYS`。
 *
 * 九张成品卡已退役（见 `strip-simple.ts` 模块注释），所以这里不再断言
 * 「某张卡有哪几个滑块」——那是卡片模型的产物。
 */

import { describe, expect, it } from "vitest";
import {
  buildSimpleParams,
  clampLevel,
  colorHexOf,
  hueDegreesOf,
  hueFromDegrees,
  inferSimpleState,
  LEVEL_DEFAULT,
  LEVEL_MAX,
  LEVEL_MIN,
  levelDraftFromEffect,
  OFF_CARD_NOTICE,
  panelTypeForEffectId,
  satFromPercent,
  satPercentOf,
  simpleEffectName,
} from "../utils/control/strip-simple";
import { CHOICE_KEYS, SLIDER_KEYS, defaultParams } from "../utils/control/effect-panel";
import { NO_EFFECT, SEGMENT_TYPE } from "../utils/protocol/constants";
import type { SegmentReport } from "../utils/protocol/types";

function report(overrides: Partial<SegmentReport> = {}): SegmentReport {
  const layer0 = overrides.layer0 ?? {
    type: SEGMENT_TYPE.STATIC,
    hue: 7281,
    sat: 255,
    periodMs: 0,
    p5: 0,
    flags: 0,
    level: 100,
  };
  return {
    stripId: 0,
    segId: 0,
    start: 0,
    end: 29,
    blend: 0,
    layer0,
    layer1: { type: NO_EFFECT, hue: 0, sat: 0, periodMs: 0, p5: 0, flags: 0, level: 0 },
    ...overrides,
  } as SegmentReport;
}

describe("HSV 滑块与协议值的换算", () => {
  it("色相 0-65535 ↔ 0-359 度（360 度回卷到 0）", () => {
    expect(hueDegreesOf(0)).toBe(0);
    expect(hueDegreesOf(0x10000 / 4)).toBe(90);
    expect(hueDegreesOf(0xffff)).toBe(0);
    expect(hueDegreesOf(0x10000)).toBe(0);
    expect(hueFromDegrees(0)).toBe(0);
    expect(hueFromDegrees(90)).toBe(0x4000);
    expect(hueFromDegrees(360)).toBe(0);
    expect(hueFromDegrees(-90)).toBe(0xc000);
  });

  it("饱和度 0-255 ↔ 0-100%", () => {
    expect(satPercentOf(0)).toBe(0);
    expect(satPercentOf(255)).toBe(100);
    expect(satPercentOf(128)).toBe(50);
    expect(satFromPercent(0)).toBe(0);
    expect(satFromPercent(100)).toBe(255);
    expect(satFromPercent(50)).toBe(128);
  });

  it("亮度滑块下限 5，但协议值 0 必须原样保留", () => {
    expect(clampLevel(0)).toBe(LEVEL_MIN);
    expect(clampLevel(100)).toBe(LEVEL_MAX);
    expect(clampLevel(NaN)).toBe(LEVEL_DEFAULT);
  });
});

describe("设备读回 → 当前灯效", () => {
  it("整组一个分区、无叠加层、类型可辨认时回填完整参数", () => {
    const state = inferSimpleState(
      [
        report({
          layer0: {
            type: SEGMENT_TYPE.STATIC,
            hue: 10922,
            sat: 200,
            periodMs: 0,
            p5: 0,
            flags: 0,
            level: 60,
          },
        }),
      ],
      30,
    );
    expect(state).not.toBeNull();
    expect(state?.effectId).toBe("solid");
    expect(state?.panelType).toBe("static");
    /* 完整参数：颜色 + 亮度都是设备值。 */
    expect(state?.params.hue).toBe(10922);
    expect(state?.params.sat).toBe(200);
    expect(state?.params.level).toBe(60);
  });

  it("呼吸读回时周期 / 最暗 / 波形都是设备值（不再是「只有颜色」）", () => {
    const state = inferSimpleState(
      [
        report({
          layer0: {
            type: SEGMENT_TYPE.BREATHING,
            hue: 1000,
            sat: 200,
            periodMs: 2000,
            p5: 40,
            /* 三角波。 */
            flags: 0x02,
            level: 80,
          },
        }),
      ],
      30,
    );
    expect(state?.effectId).toBe("breathe");
    expect(state?.params.periodMs).toBe(2000);
    expect(state?.params.minLevel).toBe(40);
    expect(state?.params.waveform).toBe(1);
    expect(state?.params.level).toBe(80);
  });

  it("流星读回时尾巴 / 方向都是设备值", () => {
    const state = inferSimpleState(
      [
        report({
          layer0: {
            type: SEGMENT_TYPE.COMET,
            hue: 43690,
            sat: 255,
            periodMs: 3000,
            p5: 200,
            /* 反转。 */
            flags: 0x01,
            level: 100,
          },
        }),
      ],
      30,
    );
    expect(state?.effectId).toBe("comet");
    expect(state?.params.tail).toBe(200);
    expect(state?.params.reverse).toBe(true);
  });

  it("只覆盖一部分时不回填（界面显示「空」）", () => {
    expect(inferSimpleState([report({ start: 0, end: 10 })], 30)).toBeNull();
  });

  it("有叠加层时不回填（那不是「整组一个灯效」）", () => {
    const withOverlay = report({
      layer1: {
        type: SEGMENT_TYPE.STATIC,
        hue: 0,
        sat: 255,
        periodMs: 0,
        p5: 0,
        flags: 0,
        level: 100,
      },
    });
    expect(inferSimpleState([withOverlay], 30)).toBeNull();
  });

  it("多个分区时不回填", () => {
    expect(inferSimpleState([report(), report({ segId: 1 })], 30)).toBeNull();
  });

  it("没有任何分区时返回 null（界面显示「空」）", () => {
    expect(inferSimpleState([], 30)).toBeNull();
  });

  it("熄灭类型认得出是「空」", () => {
    const state = inferSimpleState(
      [
        report({
          layer0: { type: SEGMENT_TYPE.OFF, hue: 0, sat: 0, periodMs: 0, p5: 0, flags: 0, level: 0 },
        }),
      ],
      30,
    );
    expect(state?.effectId).toBe("empty");
    expect(state?.colorHex).toBe("#000000");
  });
});

describe("参数区与进阶档同源", () => {
  it("滑块来自 SLIDER_KEYS，选择项来自 CHOICE_KEYS", () => {
    const types = [
      "static",
      "breathing",
      "rainbow",
      "comet",
      "strobe",
      "heartbeat",
      "flicker",
    ] as const;
    for (const type of types) {
      const view = buildSimpleParams(type, {});
      expect(view.sliders.map((s) => s.key)).toEqual([...SLIDER_KEYS[type]]);
      expect(view.choices.map((c) => c.key)).toEqual([...CHOICE_KEYS[type]]);
    }
  });

  it("彩虹也有色相 / 饱和度 / 亮度（与进阶档一致）", () => {
    const view = buildSimpleParams("rainbow", { hue: 1000, sat: 255, level: 80 });
    expect(view.sliders.map((s) => s.key)).toEqual(["hue", "sat", "level", "period", "span"]);
    expect(view.sliders.find((s) => s.key === "level")?.value).toBe(80);
  });

  it("心跳有单 / 双脉冲开关", () => {
    const view = buildSimpleParams("heartbeat", {});
    const pulse = view.choices.find((c) => c.key === "pulse");
    expect(pulse).toBeDefined();
    expect(pulse?.options.map((o) => o.label)).toEqual(["单脉冲", "双脉冲"]);
    /* 默认双脉冲。 */
    expect(pulse?.value).toBe(1);
  });

  it("「空」没有滑块，只给一句说明", () => {
    const view = buildSimpleParams("off", {});
    expect(view.sliders).toEqual([]);
    expect(view.choices).toEqual([]);
    expect(view.notice).toBe(OFF_CARD_NOTICE);
    expect(view.title).toBe("空");
  });

  it("参数覆盖与默认值合并（色相读数跟着参数走）", () => {
    const view = buildSimpleParams("static", { hue: 0x4000 });
    const hue = view.sliders.find((s) => s.key === "hue");
    expect(hue?.value).toBe(90);
    expect(hue?.display).toBe("90°");
  });

  it("滑轨颜色由当前色相 + 饱和度算出", () => {
    const view = buildSimpleParams("static", { hue: 0, sat: 255 });
    const sat = view.sliders.find((s) => s.key === "sat");
    expect(sat?.track).toContain("hsl(0, 0%");
    expect(sat?.track).toContain("hsl(0, 100%");
    const hue = view.sliders.find((s) => s.key === "hue");
    expect(hue?.track).toContain("linear-gradient");
  });

  it("预览色随参数变化；「空」恒为黑", () => {
    expect(colorHexOf("static", { ...defaultParams("static"), hue: 0, sat: 255 })).toBe("#FF0000");
    expect(colorHexOf("off", defaultParams("off"))).toBe("#000000");
  });
});

describe("亮度草稿的去向", () => {
  it("「空」不把协议的 0 当成用户的亮度选择", () => {
    expect(levelDraftFromEffect("off", 0, 90)).toBe(90);
  });

  it("会发光的灯效以设备值为准（含合法的 0）", () => {
    expect(levelDraftFromEffect("static", 40, 90)).toBe(40);
    expect(levelDraftFromEffect("static", 0, 90)).toBe(0);
  });
});

describe("灯效 id ↔ 面板类型", () => {
  it("八个灯效都有对应的面板类型", () => {
    const pairs: Array<[string, string]> = [
      ["empty", "off"],
      ["solid", "static"],
      ["breathe", "breathing"],
      ["rainbow", "rainbow"],
      ["comet", "comet"],
      ["strobe", "strobe"],
      ["heartbeat", "heartbeat"],
      ["flicker", "flicker"],
    ];
    for (const [effectId, type] of pairs) {
      expect(panelTypeForEffectId(effectId)).toBe(type);
    }
    expect(panelTypeForEffectId(null)).toBeNull();
    expect(panelTypeForEffectId("nope")).toBeNull();
  });

  it("灯效名字（含「空」）", () => {
    expect(simpleEffectName("solid")).toBe("常亮");
    expect(simpleEffectName("empty")).toBe("空");
    expect(simpleEffectName(null)).toBe("空");
  });
});
