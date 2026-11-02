/**
 * 灯组页简单档的纯派生（#64）。
 *
 * 三类断言：
 *  1. 方案槽位按钮的文案与轮换（空槽位必须明说「空白」）；
 *  2. HSV 滑块 ↔ 协议值的换算（色相 0-360 ↔ 0-65535、饱和度 % ↔ 0-255），
 *     以及亮度滑块**不下发**、带「固件更新后可用」标记；
 *  3. 设备读回值只有在「整组一个光区 + 无叠加层」时才敢回填成某张卡。
 */

import { describe, expect, it } from "vitest";
import {
  buildSimpleParams,
  clampLevel,
  cyclePlanSlot,
  hueDegreesOf,
  hueFromDegrees,
  inferSimpleState,
  LEVEL_DEFAULT,
  LEVEL_MAX,
  LEVEL_MIN,
  LEVEL_UNAVAILABLE_NOTE,
  planSlotLabel,
  planSlotSub,
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
  };
  return {
    stripId: 0,
    segId: 0,
    start: 0,
    end: 29,
    blend: 0,
    layer0,
    layer1: { type: NO_EFFECT, hue: 0, sat: 0, periodMs: 0, p5: 0, flags: 0 },
    type: layer0.type,
    hue: layer0.hue,
    sat: layer0.sat,
    periodMs: layer0.periodMs,
    p5: layer0.p5,
    flags: layer0.flags,
    ...overrides,
  };
}

describe("方案槽位按钮", () => {
  it("四个槽位各有自己的圈码，文案是「方案 ①」", () => {
    expect(planSlotLabel(0)).toBe("方案 ①");
    expect(planSlotLabel(1)).toBe("方案 ②");
    expect(planSlotLabel(2)).toBe("方案 ③");
    expect(planSlotLabel(3)).toBe("方案 ④");
  });

  it("越界 / 非法槽位号不会崩（按 4 取模）", () => {
    expect(planSlotLabel(4)).toBe("方案 ①");
    expect(planSlotLabel(-1)).toBe("方案 ④");
    expect(planSlotLabel(Number.NaN)).toBe("方案 ①");
    expect(planSlotLabel(2.7)).toBe("方案 ③");
  });

  it("空槽位标「空白」，有内容显示步骤数", () => {
    expect(planSlotSub(0)).toBe("空白");
    expect(planSlotSub(3)).toBe("3 个步骤");
    expect(planSlotSub(-2)).toBe("空白");
    expect(planSlotSub(Number.NaN)).toBe("空白");
  });

  it("点一下在 0→1→2→3→0 之间轮换", () => {
    expect(cyclePlanSlot(0)).toBe(1);
    expect(cyclePlanSlot(1)).toBe(2);
    expect(cyclePlanSlot(2)).toBe(3);
    expect(cyclePlanSlot(3)).toBe(0);
  });

  it("槽位数可配（测试用 2 槽位也不会越界）", () => {
    expect(cyclePlanSlot(1, 2)).toBe(0);
    expect(cyclePlanSlot(0, 0)).toBe(1);
  });
});

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

  it("亮度滑块不下发，并带「固件更新后可用」", () => {
    const view = buildSimpleParams("warm", {}, 60)!;
    const level = view.sliders.find((slider) => slider.key === "level")!;
    expect(level.sends).toBe(false);
    expect(level.note).toBe(LEVEL_UNAVAILABLE_NOTE);
    expect(level.value).toBe(60);
    expect(level.display).toBe("60%");
    /* 色相与饱和度是真的会下发的。 */
    for (const key of ["hue", "sat"] as const) {
      const slider = view.sliders.find((item) => item.key === key)!;
      expect(slider.sends).toBe(true);
      expect(slider.note).toBe("");
    }
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
      layer0: { type: SEGMENT_TYPE.BREATHING, hue: 0, sat: 255, periodMs: 2000, p5: 120, flags: 0 },
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
      layer1: { type: SEGMENT_TYPE.STATIC, hue: 0, sat: 255, periodMs: 0, p5: 0, flags: 0 },
    });
    expect(inferSimpleState([layered], 30)).toBeNull();
  });

  it("空层认不出（设备上没设效果）", () => {
    const empty = report({
      layer0: { type: NO_EFFECT, hue: 0, sat: 0, periodMs: 0, p5: 0, flags: 0 },
    });
    expect(inferSimpleState([empty], 30)).toBeNull();
  });

  it("没有任何光区时返回 null", () => {
    expect(inferSimpleState([], 30)).toBeNull();
  });
});
