/**
 * 快捷灯效（纯函数）：卡片 → 协议值的映射。
 *
 * 这里锁住两类容易出错的事：
 *  1. **档位必须落在协议合法范围内**：呼吸周期 ≥334ms、动画 ≥200ms、
 *     静态层的 period/p5/flags 必须为 0（否则设备直接回 InvalidParam）；
 *  2. **快捷档的语义是整组覆盖**：区间恒为 0..ledCount-1、槽位 0、单层、
 *     叠加方式覆盖。
 */

import { describe, expect, it } from "vitest";
import {
  buildQuickCardViews,
  buildQuickLayer,
  buildQuickPanel,
  buildQuickSpec,
  defaultParams,
  inferQuickCard,
  paramsSummary,
  QUICK_CARDS,
  quickCardOf,
  type QuickParams,
} from "../utils/control/quick-effects";
import {
  ANIMATION_MIN_PERIOD_MS,
  BLEND,
  BREATHING_MIN_PERIOD_MS,
  NO_EFFECT,
  SEGMENT_TYPE,
  WAVEFORM,
} from "../utils/protocol/constants";
import { breathingWaveform, segmentReverse } from "../utils/protocol/commands";

describe("卡片表", () => {
  it("有 6 张卡，id 唯一", () => {
    expect(QUICK_CARDS).toHaveLength(6);
    const ids = QUICK_CARDS.map((card) => card.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("四张原型卡覆盖协议四种灯效", () => {
    const kinds = QUICK_CARDS.map((card) => card.kind);
    for (const kind of ["solid", "breathing", "rainbow", "comet"] as const) {
      expect(kinds).toContain(kind);
    }
  });

  it("每张卡都有名称与说明（界面直接渲染，不能为空）", () => {
    for (const card of QUICK_CARDS) {
      expect(card.name.length).toBeGreaterThan(0);
      expect(card.hint.length).toBeGreaterThan(0);
    }
  });

  it("按 id 能取到卡片，未知 id 返回 null", () => {
    expect(quickCardOf("breathe")?.name).toBe("呼吸");
    expect(quickCardOf("nope")).toBeNull();
  });
});

describe("档位 → 协议值", () => {
  const solid = quickCardOf("warm")!;
  const breathing = quickCardOf("breathe")!;
  const rainbow = quickCardOf("rainbow")!;
  const comet = quickCardOf("comet")!;

  it("常亮：静态层，period/p5/flags 全为 0", () => {
    const layer = buildQuickLayer(solid, {});
    expect(layer.type).toBe(SEGMENT_TYPE.STATIC);
    expect(layer.periodMs).toBe(0);
    expect(layer.p5).toBe(0);
    expect(layer.flags).toBe(0);
  });

  it("呼吸：周期不低于 334ms 下限，且带正弦波形", () => {
    for (const speed of ["slow", "normal", "fast"] as const) {
      const layer = buildQuickLayer(breathing, { speed });
      expect(layer.type).toBe(SEGMENT_TYPE.BREATHING);
      expect(layer.periodMs).toBeGreaterThanOrEqual(BREATHING_MIN_PERIOD_MS);
      expect(breathingWaveform(layer.flags)).toBe(WAVEFORM.SINE);
    }
  });

  it("呼吸最暗档越大越暗（p5 单调递增）", () => {
    const dim = buildQuickLayer(breathing, { level: "dim" }).p5;
    const mid = buildQuickLayer(breathing, { level: "mid" }).p5;
    const dark = buildQuickLayer(breathing, { level: "dark" }).p5;
    expect(dim).toBeLessThan(mid);
    expect(mid).toBeLessThan(dark);
  });

  it("彩虹：跨度铺满整圈，周期不低于 200ms", () => {
    for (const speed of ["slow", "normal", "fast"] as const) {
      const layer = buildQuickLayer(rainbow, { speed });
      expect(layer.type).toBe(SEGMENT_TYPE.RAINBOW);
      expect(layer.p5).toBe(255);
      expect(layer.periodMs).toBeGreaterThanOrEqual(ANIMATION_MIN_PERIOD_MS);
    }
  });

  it("彩虹的饱和度可调（0-255），并映射到 sat", () => {
    expect(buildQuickLayer(rainbow, { sat: 0 }).sat).toBe(0);
    expect(buildQuickLayer(rainbow, { sat: 255 }).sat).toBe(255);
    /* 越界被钳位，不抛错（滑杆理论上不会越界，但防御）。 */
    expect(buildQuickLayer(rainbow, { sat: -10 }).sat).toBe(0);
    expect(buildQuickLayer(rainbow, { sat: 999 }).sat).toBe(255);
  });

  it("流光：尾长档单调递增，方向写入 flags bit0", () => {
    const short = buildQuickLayer(comet, { tail: "short" }).p5;
    const mid = buildQuickLayer(comet, { tail: "mid" }).p5;
    const long = buildQuickLayer(comet, { tail: "long" }).p5;
    expect(short).toBeLessThan(mid);
    expect(mid).toBeLessThan(long);
    expect(segmentReverse(buildQuickLayer(comet, { direction: "reverse" }).flags)).toBe(true);
    expect(segmentReverse(buildQuickLayer(comet, { direction: "forward" }).flags)).toBe(false);
  });

  it("所有档位组合都产出合法字节（不越界）", () => {
    for (const card of QUICK_CARDS) {
      for (const speed of ["slow", "normal", "fast"] as const) {
        for (const level of ["dim", "mid", "dark"] as const) {
          for (const tail of ["short", "mid", "long"] as const) {
            const layer = buildQuickLayer(card, { speed, level, tail });
            expect(layer.hue).toBeGreaterThanOrEqual(0);
            expect(layer.hue).toBeLessThanOrEqual(0xffff);
            expect(layer.sat).toBeGreaterThanOrEqual(0);
            expect(layer.sat).toBeLessThanOrEqual(255);
            expect(layer.p5).toBeGreaterThanOrEqual(0);
            expect(layer.p5).toBeLessThanOrEqual(255);
            expect(layer.flags).toBeGreaterThanOrEqual(0);
            expect(layer.flags).toBeLessThanOrEqual(255);
          }
        }
      }
    }
  });
});

describe("整组 spec（快捷档的语义）", () => {
  const card = quickCardOf("breathe")!;

  it("区间恒为整条，槽位 0", () => {
    const spec = buildQuickSpec(card, {}, 2, 30);
    expect(spec.stripId).toBe(2);
    expect(spec.segId).toBe(0);
    expect(spec.start).toBe(0);
    expect(spec.end).toBe(29);
  });

  it("单层 + 叠加方式覆盖（协议要求）", () => {
    const spec = buildQuickSpec(card, {}, 0, 10);
    expect(spec.layer1.type).toBe(NO_EFFECT);
    expect(spec.blend).toBe(BLEND.OVER);
  });

  it("灯珠数为 1 时区间是 0-0（不产生负区间）", () => {
    const spec = buildQuickSpec(card, {}, 0, 1);
    expect(spec.start).toBe(0);
    expect(spec.end).toBe(0);
  });

  it("灯珠数未知（0）时不产出负区间", () => {
    const spec = buildQuickSpec(card, {}, 0, 0);
    expect(spec.end).toBe(0);
  });

  it("超过 100 颗按协议上限截断（#72）", () => {
    const spec = buildQuickSpec(card, {}, 0, 200);
    expect(spec.end).toBe(99);
  });
});

describe("参数回显", () => {
  it("默认参数取自卡片", () => {
    const card = quickCardOf("warm")!;
    const p = defaultParams(card);
    expect(p.hue).toBe(card.hue);
    expect(p.sat).toBe(card.sat);
    expect(p.speed).toBe("normal");
  });

  it("摘要只包含该卡片显示的参数", () => {
    const solid = quickCardOf("warm")!;
    expect(paramsSummary(solid, {})).toBe("");

    const breathing = quickCardOf("breathe")!;
    const text = paramsSummary(breathing, { speed: "fast", level: "dark" });
    expect(text).toContain("快");
    expect(text).toContain("全暗");

    const rainbow = quickCardOf("rainbow")!;
    const rainbowText = paramsSummary(rainbow, { sat: 128 });
    expect(rainbowText).toContain("饱和度");
    expect(rainbowText).toContain("50%");
  });
});

describe("从设备值反推卡片", () => {
  it("四种类型分别对应四张原型卡", () => {
    const base = { hue: 0, sat: 0, periodMs: 0, p5: 0, flags: 0 };
    expect(inferQuickCard({ ...base, type: SEGMENT_TYPE.STATIC })).toBe("warm");
    expect(inferQuickCard({ ...base, type: SEGMENT_TYPE.BREATHING })).toBe("breathe");
    expect(inferQuickCard({ ...base, type: SEGMENT_TYPE.RAINBOW })).toBe("rainbow");
    expect(inferQuickCard({ ...base, type: SEGMENT_TYPE.COMET })).toBe("comet");
  });

  it("空层认不出（返回 null，让用户自选）", () => {
    expect(inferQuickCard({ type: NO_EFFECT, hue: 0, sat: 0, periodMs: 0, p5: 0, flags: 0, level: 0 })).toBeNull();
  });
});

describe("卡片视图（#54）", () => {
  it("六张卡都带名称、说明与预览色，且只有选中的高亮", () => {
    const views = buildQuickCardViews("breathe");
    expect(views).toHaveLength(6);
    for (const view of views) {
      expect(view.name.length).toBeGreaterThan(0);
      expect(view.hint.length).toBeGreaterThan(0);
      expect(view.hex).toMatch(/^#[0-9a-f]{6}$/i);
    }
    expect(views.filter((view) => view.selected).map((view) => view.id)).toEqual(["breathe"]);
  });

  it("没有选中时全部不高亮", () => {
    expect(buildQuickCardViews(null).some((view) => view.selected)).toBe(false);
  });

  it("选中卡的预览色跟随参数变化（换颜色后色块要变）", () => {
    const warm = buildQuickCardViews("warm").find((view) => view.id === "warm")!;
    const shifted = buildQuickCardViews("warm", { hue: 30000, sat: 255 }).find(
      (view) => view.id === "warm",
    )!;
    expect(shifted.hex).not.toBe(warm.hex);
  });

  it("未选中的卡不受当前参数影响（避免「调一张卡、六张都变色」）", () => {
    const base = buildQuickCardViews("warm").find((view) => view.id === "rainbow")!;
    const withParams = buildQuickCardViews("warm", { hue: 50000 }).find(
      (view) => view.id === "rainbow",
    )!;
    expect(withParams.hex).toBe(base.hex);
  });

  it("没有选中卡时参数区为 null", () => {
    expect(buildQuickPanel(null)).toBeNull();
    expect(buildQuickPanel("nope")).toBeNull();
  });

  it("参数区只显示该卡支持的控件", () => {
    /* 常亮：只有颜色（hasChoices=false，且没有饱和度滑杆）。 */
    const solid = buildQuickPanel("warm")!;
    expect(solid.hasChoices).toBe(false);
    expect(solid.choices).toEqual([]);
    expect(solid.showsSaturation).toBe(false);

    /* 呼吸：快慢 + 最暗，没有尾长/方向。 */
    const breathing = buildQuickPanel("breathe")!;
    expect(breathing.choices.map((choice) => choice.key)).toEqual(["speed", "level"]);

    /* 彩虹：快慢 + 方向 + 饱和度滑杆，没有颜色/最暗/尾长。 */
    const rainbow = buildQuickPanel("rainbow")!;
    expect(rainbow.choices.map((choice) => choice.key)).toEqual(["speed", "direction"]);
    expect(rainbow.showsSaturation).toBe(true);

    /* 流光：快慢 + 尾长 + 方向。 */
    const comet = buildQuickPanel("comet")!;
    expect(comet.choices.map((choice) => choice.key)).toEqual(["speed", "tail", "direction"]);
  });

  it("当前档位在选项里被标为 active，且只有一个", () => {
    const panel = buildQuickPanel("breathe", { speed: "fast", level: "dark" })!;
    const speed = panel.choices.find((choice) => choice.key === "speed")!;
    expect(speed.value).toBe("fast");
    expect(speed.options.filter((option) => option.active).map((option) => option.value)).toEqual([
      "fast",
    ]);
    const level = panel.choices.find((choice) => choice.key === "level")!;
    expect(level.options.filter((option) => option.active).map((option) => option.value)).toEqual([
      "dark",
    ]);
  });

  it("彩虹饱和度按百分比显示（0-100），并与 sat 双向对应", () => {
    expect(buildQuickPanel("rainbow", { sat: 0 })!.saturation).toBe(0);
    expect(buildQuickPanel("rainbow", { sat: 255 })!.saturation).toBe(100);
    expect(buildQuickPanel("rainbow", { sat: 128 })!.saturation).toBe(50);
  });

  it("参数区摘要与 paramsSummary 一致", () => {
    const params: QuickParams = { speed: "slow", tail: "long", direction: "reverse" };
    expect(buildQuickPanel("comet", params)!.summary).toBe(paramsSummary(quickCardOf("comet")!, params));
  });
});
