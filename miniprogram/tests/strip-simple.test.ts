/**
 * 灯组页简单档的纯派生（#64）。
 *
 * 断言：
 *  1. HSV 滑块 ↔ 协议值的换算（色相 0-360 ↔ 0-65535、饱和度 % ↔ 0-255），
 *     以及亮度滑块**真实下发**（v4 的逐光区 level）；
 *  2. 设备读回值只有在「整组一个光区 + 无叠加层」时才敢回填成某张卡。
 *
 * 方案槽位的文案与轮换已迁到 `plan-slots.ts`（#83 起方案按需增长），
 * 那里有自己的测试文件。
 */

import { describe, expect, it } from "vitest";
import {
  buildSimpleParams,
  clampLevel,
  hueDegreesOf,
  hueFromDegrees,
  inferSimpleState,
  LEVEL_DEFAULT,
  LEVEL_MAX,
  LEVEL_MIN,
  OFF_CARD_NOTICE,
  levelAfterCardTap,
  levelDraftFromDevice,
  satFromPercent,
  satPercentOf,
} from "../utils/control/strip-simple";
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
    type: layer0.type,
    hue: layer0.hue,
    sat: layer0.sat,
    periodMs: layer0.periodMs,
    p5: layer0.p5,
    flags: layer0.flags,
    ...overrides,
  };
}

describe("HSV 换算", () => {
  it("协议色相 0-65535 ↔ 滑块 0-360 度", () => {
    expect(hueDegreesOf(0)).toBe(0);
    expect(hueDegreesOf(0xffff)).toBe(0); // 65535/65536 四舍五入到 360 → 归 0
    expect(hueDegreesOf(0x8000)).toBe(180);
    expect(hueDegreesOf(7281)).toBe(40);
  });

  it("度数回到协议值是整数且在 0-65535 内", () => {
    expect(hueFromDegrees(0)).toBe(0);
    expect(hueFromDegrees(180)).toBe(0x8000);
    expect(hueFromDegrees(360)).toBe(0);
    expect(hueFromDegrees(-90)).toBe(0xc000);
    const value = hueFromDegrees(37);
    expect(value).toBeGreaterThan(0);
    expect(value).toBeLessThanOrEqual(0xffff);
  });

  it("色相往返在 1 度误差内稳定", () => {
    for (const degrees of [0, 17, 90, 200, 359]) {
      expect(hueDegreesOf(hueFromDegrees(degrees))).toBe(degrees);
    }
  });

  it("饱和度 % ↔ 0-255", () => {
    expect(satPercentOf(255)).toBe(100);
    expect(satPercentOf(0)).toBe(0);
    expect(satPercentOf(128)).toBe(50);
    expect(satFromPercent(100)).toBe(255);
    expect(satFromPercent(0)).toBe(0);
    expect(satFromPercent(50)).toBe(128);
    expect(satFromPercent(999)).toBe(255);
    expect(satFromPercent(-5)).toBe(0);
  });
});

describe("亮度滑块", () => {
  it("钳在 5-100（0 会让整组不出光）", () => {
    expect(clampLevel(0)).toBe(LEVEL_MIN);
    expect(clampLevel(-10)).toBe(LEVEL_MIN);
    expect(clampLevel(101)).toBe(LEVEL_MAX);
    expect(clampLevel(Number.NaN)).toBe(LEVEL_DEFAULT);
  });
});

describe("参数区：只显示该卡支持的滑块", () => {
  it("常亮卡：色相 + 饱和度 + 亮度", () => {
    const view = buildSimpleParams("warm");
    expect(view).not.toBeNull();
    expect(view!.cardName).toBe("暖白常亮");
    expect(view!.sliders.map((slider) => slider.key)).toEqual(["hue", "sat", "level"]);
  });

  it("彩虹卡没有色相（自己循环变色），但有饱和度", () => {
    const view = buildSimpleParams("rainbow");
    expect(view!.sliders.map((slider) => slider.key)).toEqual(["sat", "level"]);
  });

  it("呼吸 / 流光 / 冷蓝 / 紫色都有色相与饱和度", () => {
    for (const id of ["breathe", "comet", "ice", "violet"]) {
      const keys = buildSimpleParams(id)!.sliders.map((slider) => slider.key);
      expect(keys).toEqual(["hue", "sat", "level"]);
    }
  });

  it("亮度滑块真实下发（v4 的 level），没有待生效标记", () => {
    const view = buildSimpleParams("warm", {}, 60)!;
    const level = view.sliders.find((slider) => slider.key === "level")!;
    expect(level.sends).toBe(true);
    expect(level.note).toBe("");
    expect(level.value).toBe(60);
    expect(level.display).toBe("60%");
    /* 三个滑块都真的会改变设备。 */
    for (const key of ["hue", "sat", "level"] as const) {
      const slider = view.sliders.find((item) => item.key === key)!;
      expect(slider.sends, key).toBe(true);
      expect(slider.note, key).toBe("");
    }
  });

  it("设备读回的 level 原样回显（含合法的 0）", () => {
    expect(inferSimpleState([report({ end: 29, layer0: { ...report().layer0, level: 40 } })], 30)?.level).toBe(40);
    expect(inferSimpleState([report({ end: 29, layer0: { ...report().layer0, level: 0 } })], 30)?.level).toBe(0);
  });

  it("参数覆盖与卡片默认合并（色相读数跟着参数走）", () => {
    const view = buildSimpleParams("warm", { hue: 0x8000, sat: 0 })!;
    const hue = view.sliders.find((slider) => slider.key === "hue")!;
    const sat = view.sliders.find((slider) => slider.key === "sat")!;
    expect(hue.value).toBe(180);
    expect(hue.display).toBe("180°");
    expect(sat.value).toBe(0);
  });

  it("没有选中卡片时返回 null（界面只显示卡片列表）", () => {
    expect(buildSimpleParams(null)).toBeNull();
    expect(buildSimpleParams("not-a-card")).toBeNull();
  });

  it("预览色随参数变化", () => {
    const warm = buildSimpleParams("warm", { hue: 0, sat: 255 })!;
    const blue = buildSimpleParams("warm", { hue: 0xaaa0, sat: 255 })!;
    expect(warm.colorHex).not.toBe(blue.colorHex);
    expect(warm.colorHex).toMatch(/^#[0-9a-f]{6}$/i);
  });
});

describe("设备读回 → 当前卡片", () => {
  it("整组一个光区、无叠加层、类型可辨认时回填", () => {
    const state = inferSimpleState([report({ end: 29 })], 30);
    expect(state).not.toBeNull();
    expect(state!.cardId).toBe("warm");
    expect(state!.hue).toBe(7281);
    expect(state!.sat).toBe(255);
    expect(state!.colorHex).toMatch(/^#[0-9a-f]{6}$/i);
  });

  it("呼吸 / 彩虹 / 流光按层类型认得出", () => {
    const breathing = report({
      layer0: { type: SEGMENT_TYPE.BREATHING, hue: 0, sat: 255, periodMs: 2000, p5: 120, flags: 0, level: 100 },
    });
    expect(inferSimpleState([breathing], 30)!.cardId).toBe("breathe");
    expect(
      inferSimpleState([report({ layer0: { ...breathing.layer0, type: SEGMENT_TYPE.RAINBOW } })], 30)!
        .cardId,
    ).toBe("rainbow");
    expect(
      inferSimpleState([report({ layer0: { ...breathing.layer0, type: SEGMENT_TYPE.COMET } })], 30)!
        .cardId,
    ).toBe("comet");
  });

  it("多个光区认不出（不猜）", () => {
    expect(inferSimpleState([report(), report({ segId: 1, start: 15, end: 29 })], 30)).toBeNull();
  });

  it("只覆盖半条认不出", () => {
    expect(inferSimpleState([report({ end: 14 })], 30)).toBeNull();
  });

  it("有叠加层认不出（不是单纯的快捷卡）", () => {
    const layered = report({
      layer1: { type: SEGMENT_TYPE.STATIC, hue: 0, sat: 255, periodMs: 0, p5: 0, flags: 0, level: 100 },
    });
    expect(inferSimpleState([layered], 30)).toBeNull();
  });

  it("空层认不出（设备上没设效果）", () => {
    const empty = report({
      layer0: { type: NO_EFFECT, hue: 0, sat: 0, periodMs: 0, p5: 0, flags: 0, level: 0 },
    });
    expect(inferSimpleState([empty], 30)).toBeNull();
  });

  it("没有任何光区时返回 null", () => {
    expect(inferSimpleState([], 30)).toBeNull();
  });
});

describe("九张卡里的新三张（#81）", () => {
  it("熄灭卡不给亮度滑块（拖了也不起作用），改给一句说明", () => {
    const view = buildSimpleParams("off")!;
    expect(view.cardId).toBe("off");
    expect(view.sliders).toEqual([]);
    expect(view.title).toBe("熄灭黑");
    expect(view.notice).toBe(OFF_CARD_NOTICE);
    /* 说明必须点明「灯组仍开着」，否则用户会以为这是关灯。 */
    expect(view.notice).toContain("仍然开着");
    expect(view.notice).not.toMatch(/毫秒|段|阶段|剧本|下发|激活|层/);
    /* 预览色是黑，不是按 0/0 色算出的白。 */
    expect(view.colorHex).toBe("#000000");
  });

  it("爆闪 / 心跳仍然有亮度滑块（它们在发光，亮度有意义）", () => {
    for (const id of ["strobe", "heartbeat"]) {
      const view = buildSimpleParams(id, {}, 60)!;
      expect(view.sliders.map((slider) => slider.key), id).toEqual(["level"]);
      expect(view.sliders[0].value, id).toBe(60);
      expect(view.notice, id).toBe("");
      expect(view.title, id).toBe(`${view.cardName}的参数`);
    }
  });

  it("熄灭卡读回：整组一个光区、主效果熄灭、无叠加层 → 反推出 off", () => {
    const offLayer = { type: SEGMENT_TYPE.OFF, hue: 0, sat: 0, periodMs: 0, p5: 0, flags: 0, level: 0 };
    const state = inferSimpleState([report({ layer0: offLayer })], 30);
    expect(state).not.toBeNull();
    expect(state!.cardId).toBe("off");
    expect(state!.colorHex).toBe("#000000");
  });

  it("熄灭卡读回时不能把它当成静态暖白（否则界面会亮起一张错误的卡）", () => {
    /* STATIC 与 OFF 的差别只在类型字节上：写错就变成「点了熄灭却高亮暖白」。 */
    const offLayer = { type: SEGMENT_TYPE.OFF, hue: 0, sat: 0, periodMs: 0, p5: 0, flags: 0, level: 0 };
    expect(inferSimpleState([report({ layer0: offLayer })], 30)!.cardId).not.toBe("warm");
  });

  it("有多个光区时熄灭卡也认不出（只认整组一张卡）", () => {
    const offLayer = { type: SEGMENT_TYPE.OFF, hue: 0, sat: 0, periodMs: 0, p5: 0, flags: 0, level: 0 };
    expect(
      inferSimpleState(
        [report({ layer0: offLayer }), report({ segId: 1, start: 15, end: 29 })],
        30,
      ),
    ).toBeNull();
  });
});

describe("熄灭卡读回的 level = 0 不能传染给下一张卡", () => {
  it("设备上的 0（熄灭）在换卡时回到默认满亮", () => {
    expect(levelAfterCardTap(0)).toBe(LEVEL_DEFAULT);
    expect(levelAfterCardTap(-1)).toBe(LEVEL_DEFAULT);
    expect(levelAfterCardTap(Number.NaN)).toBe(LEVEL_DEFAULT);
  });

  it("用户自己调的亮度换卡后保留（不被重置成 100%）", () => {
    expect(levelAfterCardTap(60)).toBe(60);
    expect(levelAfterCardTap(5)).toBe(5);
    expect(levelAfterCardTap(999)).toBe(LEVEL_MAX);
  });

  it("读回熄灭卡时草稿保留上一次的亮度（不把协议的 0 当成用户选择）", () => {
    expect(levelDraftFromDevice("off", 0, 60)).toBe(60);
    expect(levelDraftFromDevice("off", 0, 0)).toBe(LEVEL_DEFAULT);
  });

  it("读回会发光的卡时以设备值为准（含合法的 0）", () => {
    expect(levelDraftFromDevice("warm", 40, 90)).toBe(40);
    expect(levelDraftFromDevice("warm", 0, 90)).toBe(0);
  });
});
