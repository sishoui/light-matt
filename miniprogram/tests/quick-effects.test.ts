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
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildQuickCardViews,
  buildQuickLayer,
  buildQuickPanel,
  buildQuickSpec,
  defaultParams,
  inferQuickCard,
  paramsSummary,
  QUICK_CARDS,
  QUICK_GRID_COLUMNS,
  quickCardOf,
  quickColorHex,
  type QuickParams,
} from "../utils/control/quick-effects";
import {
  defaultParams as panelDefaultParams,
  heartbeatPeriodMs,
  panelLayer,
  strobePeriodMs,
} from "../utils/control/effect-panel";
import {
  ANIMATION_MIN_PERIOD_MS,
  BLEND,
  BREATHING_MIN_PERIOD_MS,
  HEARTBEAT_MAX_PERIOD_MS,
  HEARTBEAT_MIN_PERIOD_MS,
  NO_EFFECT,
  SEGMENT_TYPE,
  STROBE_MIN_PERIOD_MS,
  WAVEFORM,
} from "../utils/protocol/constants";
import {
  breathingWaveform,
  cmdSetSegment,
  parseSegmentPayload,
  segmentReverse,
} from "../utils/protocol/commands";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

describe("卡片表", () => {
  it("有 9 张卡，id 唯一", () => {
    expect(QUICK_CARDS).toHaveLength(9);
    const ids = QUICK_CARDS.map((card) => card.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("原有 6 张的顺序与 id 不变（用户记忆里的位置不能动）", () => {
    expect(QUICK_CARDS.slice(0, 6).map((card) => card.id)).toEqual([
      "warm",
      "breathe",
      "rainbow",
      "comet",
      "ice",
      "violet",
    ]);
  });

  it("新增三张：#81 爆闪白 / 心跳暖红 / 熄灭黑", () => {
    const added = QUICK_CARDS.slice(6);
    expect(added.map((card) => card.id)).toEqual(["strobe", "heartbeat", "off"]);
    expect(added.map((card) => card.name)).toEqual(["爆闪白", "心跳暖红", "熄灭黑"]);
    expect(added.map((card) => card.kind)).toEqual(["strobe", "heartbeat", "off"]);
  });

  it("九张卡按三列排（数量是列数的整数倍）", () => {
    expect(QUICK_GRID_COLUMNS).toBe(3);
    expect(QUICK_CARDS.length % QUICK_GRID_COLUMNS).toBe(0);
  });

  it("#96 起简单档不再是色块网格（页面上没有 quick-grid / quick-card）", () => {
    const wxss = readFileSync(join(ROOT, "pages/strip/strip.wxss"), "utf8");
    expect(wxss).not.toMatch(/\.quick-grid\s*\{/);
    const wxml = readFileSync(join(ROOT, "pages/strip/strip.wxml"), "utf8");
    expect(wxml).not.toContain("quick-grid");
    expect(wxml).not.toContain("quick-card");
  });

  it("一行式设置行不换行、超出截断（左侧名称 / 右侧当前值）", () => {
    const wxss = readFileSync(join(ROOT, "pages/strip/strip.wxss"), "utf8");
    const index = wxss.indexOf(".effect-row {");
    expect(index).toBeGreaterThanOrEqual(0);
    const body = wxss.slice(wxss.indexOf("{", index) + 1, wxss.indexOf("}", index));
    expect(body).toMatch(/justify-content:\s*space-between/);
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

describe("新增三张卡（#81）", () => {
  const strobe = quickCardOf("strobe")!;
  const heartbeat = quickCardOf("heartbeat")!;
  const off = quickCardOf("off")!;

  it("爆闪白：白色爆闪，中等频率、中等占空比", () => {
    const layer = buildQuickLayer(strobe, {});
    expect(layer.type).toBe(SEGMENT_TYPE.STROBE);
    expect(layer.periodMs).toBeGreaterThanOrEqual(STROBE_MIN_PERIOD_MS);
    /* 中等频率 = 面板默认 4Hz（250ms），中等占空比 = 90（≈35%）。 */
    expect(layer.periodMs).toBe(strobePeriodMs(4));
    expect(layer.p5).toBe(90);
    expect(layer.flags).toBe(0);
  });

  it("爆闪白用的是中性白（sat = 0，固件里 V 恒为 1 即纯白）", () => {
    const layer = buildQuickLayer(strobe, {});
    expect(layer.hue).toBe(0);
    expect(layer.sat).toBe(0);
    /* 卡片预览色块也是白，不会显示成红色。 */
    expect(quickColorHex(strobe)).toBe("#FFFFFF");
  });

  it("爆闪 / 心跳的固定档与进阶档面板的默认档一致（复用同一套数值）", () => {
    const strobePanel = panelLayer("strobe", panelDefaultParams("strobe"));
    expect(buildQuickLayer(strobe, {}).periodMs).toBe(strobePanel.periodMs);
    expect(buildQuickLayer(strobe, {}).p5).toBe(strobePanel.p5);

    const beatPanel = panelLayer("heartbeat", panelDefaultParams("heartbeat"));
    const beatQuick = buildQuickLayer(heartbeat, {});
    expect(beatQuick.periodMs).toBe(beatPanel.periodMs);
    expect(beatQuick.p5).toBe(beatPanel.p5);
    expect(beatQuick.flags).toBe(beatPanel.flags);
  });

  it("心跳暖红：暖红、约 60 BPM、双脉冲", () => {
    const layer = buildQuickLayer(heartbeat, {});
    expect(layer.type).toBe(SEGMENT_TYPE.HEARTBEAT);
    expect(layer.periodMs).toBe(heartbeatPeriodMs(60));
    expect(layer.periodMs).toBe(1000);
    expect(layer.periodMs).toBeGreaterThanOrEqual(HEARTBEAT_MIN_PERIOD_MS);
    expect(layer.periodMs).toBeLessThanOrEqual(HEARTBEAT_MAX_PERIOD_MS);
    expect(layer.flags).toBe(0x01);
    /* 暖红：色相落在红色扇区的暖侧（0-12°，不是纯 0 的冷红），饱和度接近满。 */
    expect(heartbeat.hue).toBeGreaterThan(0);
    expect(heartbeat.hue).toBeLessThan(2200);
    expect(heartbeat.sat).toBeGreaterThan(200);
  });

  it("熄灭黑：整组一个分区，主效果熄灭、参数全 0、无叠加层", () => {
    const spec = buildQuickSpec(off, {}, 1, 20);
    expect(spec.layer0.type).toBe(SEGMENT_TYPE.OFF);
    expect(spec.layer0.hue).toBe(0);
    expect(spec.layer0.sat).toBe(0);
    expect(spec.layer0.periodMs).toBe(0);
    expect(spec.layer0.p5).toBe(0);
    expect(spec.layer0.flags).toBe(0);
    expect(spec.layer1.type).toBe(NO_EFFECT);
    expect(spec.blend).toBe(BLEND.OVER);
    expect(spec.start).toBe(0);
    expect(spec.end).toBe(19);
  });

  it("熄灭黑不被亮度滑块点亮（level 恒 0）", () => {
    expect(buildQuickLayer(off, {}, 100).level).toBe(0);
    expect(buildQuickLayer(off, {}, 5).level).toBe(0);
  });

  it("三张新卡都能编成合法载荷（设备不会回 InvalidParam）", () => {
    for (const card of [strobe, heartbeat, off]) {
      const spec = buildQuickSpec(card, {}, 0, 30);
      /* cmdSetSegment 会做完整的协议校验，抛错即失败。 */
      const request = cmdSetSegment(spec);
      const roundTrip = parseSegmentPayload(request.payload);
      expect(roundTrip.layer0.type).toBe(spec.layer0.type);
      expect(roundTrip.end).toBe(29);
    }
  });

  it("三张新卡没有可调的档位控件（卡片只是一键成品）", () => {
    for (const id of ["strobe", "heartbeat", "off"]) {
      const panel = buildQuickPanel(id)!;
      expect(panel.choices).toEqual([]);
      expect(panel.summary).toBe("");
    }
  });

  it("卡片名称与提示都是一行能读的短句（三列宽度）", () => {
    for (const card of QUICK_CARDS) {
      expect(card.name.length).toBeLessThanOrEqual(6);
      expect(card.hint.length).toBeLessThanOrEqual(10);
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

  it("爆闪 / 心跳 / 熄灭按类型反推（#81）", () => {
    const base = { hue: 0, sat: 0, periodMs: 0, p5: 0, flags: 0, level: 100 };
    expect(inferQuickCard({ ...base, type: SEGMENT_TYPE.STROBE })).toBe("strobe");
    expect(inferQuickCard({ ...base, type: SEGMENT_TYPE.HEARTBEAT })).toBe("heartbeat");
    expect(inferQuickCard({ ...base, type: SEGMENT_TYPE.OFF, level: 0 })).toBe("off");
  });

  it("熄灭卡整组读回后反推出 off（无叠加层、整组一个分区）", () => {
    const off = buildQuickSpec(quickCardOf("off")!, {}, 0, 24);
    /* 设备报告就是 spec 的扁平投影，layer0 足够反推。 */
    expect(inferQuickCard(off.layer0)).toBe("off");
    expect(off.layer1.type).toBe(NO_EFFECT);
    expect(off.start).toBe(0);
    expect(off.end).toBe(23);
  });

  it("九张卡逐一往返：buildQuickLayer → inferQuickCard 回到同一个 id", () => {
    for (const card of QUICK_CARDS) {
      const layer = buildQuickLayer(card, {}, 60);
      expect(inferQuickCard(layer), card.id).toBe(card.id);
    }
  });

  it("换色静态卡按色相 + 饱和度认（冷蓝 / 紫色）", () => {
    expect(inferQuickCard(buildQuickLayer(quickCardOf("ice")!))).toBe("ice");
    expect(inferQuickCard(buildQuickLayer(quickCardOf("violet")!))).toBe("violet");
  });

  it("改过颜色的静态层退回暖白（界面随后回填真实颜色）", () => {
    expect(
      inferQuickCard({ type: SEGMENT_TYPE.STATIC, hue: 1234, sat: 99, periodMs: 0, p5: 0, flags: 0, level: 100 }),
    ).toBe("warm");
  });

  it("空层认不出（返回 null，让用户自选）", () => {
    expect(inferQuickCard({ type: NO_EFFECT, hue: 0, sat: 0, periodMs: 0, p5: 0, flags: 0, level: 0 })).toBeNull();
  });
});

describe("卡片视图（#54）", () => {
  it("九张卡都带名称、说明与预览色，且只有选中的高亮", () => {
    const views = buildQuickCardViews("breathe");
    expect(views).toHaveLength(9);
    for (const view of views) {
      expect(view.name.length).toBeGreaterThan(0);
      expect(view.hint.length).toBeGreaterThan(0);
      expect(view.hex).toMatch(/^#[0-9a-f]{6}$/i);
    }
    expect(views.filter((view) => view.selected).map((view) => view.id)).toEqual(["breathe"]);
  });

  it("熄灭卡的预览色是黑（不是按 0/0 色算出的白）", () => {
    const off = buildQuickCardViews(null).find((view) => view.id === "off")!;
    expect(off.hex).toBe("#000000");
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

  it("未选中的卡不受当前参数影响（避免「调一张卡、九张都变色」）", () => {
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
