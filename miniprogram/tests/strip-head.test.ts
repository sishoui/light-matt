/**
 * #95 灯组页头部的规则：固定三套方案 + 灯珠数拨盘。
 *
 * 锁四件用户可感知的事：
 *  1. 界面只用前三套（协议仍有四个槽位），没有新增 / 删除；
 *  2. 圆盘刻度 1–100、每 10 颗一条长刻度、转动按角度换算；
 *  3. 缩小会裁分区时 `willTrimZones` 说真话（决定要不要先问）；
 *  4. 空方案不写设备（点击时 `hasContent` 为 false）。
 */

import { describe, expect, it } from "vitest";
import {
  DIAL_MAJOR_STEP,
  DROPPED_PLAN_ID,
  VISIBLE_PLAN_COUNT,
  angleOfPoint,
  buildDialTicks,
  buildPlanCircles,
  clampDialValue,
  dialValueFromAngle,
  ledCapsuleText,
  visiblePlanIds,
  willTrimZones,
} from "../utils/control/strip-head";
import { MAX_LEDS, MIN_LEDS } from "../utils/protocol/constants";

describe("固定三套方案", () => {
  it("界面只用 0/1/2，第四个槽位被丢弃", () => {
    expect(VISIBLE_PLAN_COUNT).toBe(3);
    expect(visiblePlanIds()).toEqual([0, 1, 2]);
    expect(DROPPED_PLAN_ID).toBe(3);
  });

  it("每次都返回新数组（调用方能直接改）", () => {
    const a = visiblePlanIds();
    const b = visiblePlanIds();
    expect(a).not.toBe(b);
    a.push(9);
    expect(b).toEqual([0, 1, 2]);
  });

  it("圆形按钮的数字从 1 起，选中 / 播放 / 有内容各自独立", () => {
    const circles = buildPlanCircles({
      selectedId: 1,
      summaries: { 0: "3 步", 1: "空白", 2: "1 步" },
      withContent: [0, 2],
      playingId: 2,
    });
    expect(circles.map((item) => item.label)).toEqual(["1", "2", "3"]);
    expect(circles.map((item) => item.selected)).toEqual([false, true, false]);
    expect(circles.map((item) => item.hasContent)).toEqual([true, false, true]);
    expect(circles.map((item) => item.playing)).toEqual([false, false, true]);
    expect(circles[1].summary).toBe("空白");
  });

  it("没有摘要时按「空白」（不是「读取中」）", () => {
    const circles = buildPlanCircles({
      selectedId: 0,
      summaries: {},
      withContent: [],
      playingId: null,
    });
    expect(circles.every((item) => item.summary === "空白")).toBe(true);
    expect(circles.every((item) => item.hasContent === false)).toBe(true);
  });

  it("永远只有三套（即使传入四套内容）", () => {
    const circles = buildPlanCircles({
      selectedId: 0,
      summaries: {},
      withContent: [0, 1, 2, 3],
      playingId: null,
    });
    expect(circles.length).toBe(3);
  });
});

describe("灯珠数拨盘刻度", () => {
  it("覆盖 1–100 全部取值（转一格 = 一颗）", () => {
    const ticks = buildDialTicks();
    expect(ticks.length).toBe(MAX_LEDS - MIN_LEDS + 1);
    expect(ticks[0].value).toBe(MIN_LEDS);
    expect(ticks[ticks.length - 1].value).toBe(MAX_LEDS);
  });

  it("每 10 颗一条长刻度，长刻度带数字标签", () => {
    const ticks = buildDialTicks();
    const majors = ticks.filter((tick) => tick.major).map((tick) => tick.value);
    /* 1 与 100 是边界，也算长刻度；其余是 10 的倍数。 */
    expect(majors).toContain(10);
    expect(majors).toContain(50);
    expect(majors).toContain(100);
    expect(majors).toContain(1);
    expect(DIAL_MAJOR_STEP).toBe(10);
    for (const tick of ticks) {
      if (tick.major) {
        expect(tick.label).toBe(String(tick.value));
      } else {
        expect(tick.label).toBe("");
      }
    }
  });

  it("10 的倍数都是长刻度", () => {
    const ticks = buildDialTicks();
    for (const tick of ticks) {
      if (tick.value % DIAL_MAJOR_STEP === 0) {
        expect(tick.major, `value=${tick.value}`).toBe(true);
      }
    }
  });

  it("越界范围返回空（不造非法刻度）", () => {
    expect(buildDialTicks(50, 40)).toEqual([]);
  });
});

describe("拨盘取值", () => {
  it("钳到 1–100 的整数", () => {
    expect(clampDialValue(0)).toBe(1);
    expect(clampDialValue(-5)).toBe(1);
    expect(clampDialValue(101)).toBe(100);
    expect(clampDialValue(64.4)).toBe(64);
    expect(clampDialValue(Number.NaN)).toBe(1);
  });

  it("顺时针转动增加、逆时针减少", () => {
    const cw = dialValueFromAngle({ startAngleDeg: 0, currentAngleDeg: 40, startValue: 10 });
    expect(cw).toBeGreaterThan(10);
    const ccw = dialValueFromAngle({ startAngleDeg: 0, currentAngleDeg: -40, startValue: 10 });
    expect(ccw).toBeLessThan(10);
  });

  it("每 4° 一颗（默认灵敏度）", () => {
    expect(dialValueFromAngle({ startAngleDeg: 0, currentAngleDeg: 40, startValue: 50 })).toBe(60);
    expect(dialValueFromAngle({ startAngleDeg: 0, currentAngleDeg: -40, startValue: 50 })).toBe(40);
  });

  it("跨过 ±180° 时取最短弧（不会突然跳满量程）", () => {
    const jumped = dialValueFromAngle({ startAngleDeg: 175, currentAngleDeg: -175, startValue: 50 });
    expect(jumped).toBe(53);
  });

  it("结果永远在 1–100 之内", () => {
    /* 180° / 4° = 45 颗，足够把 50 顶到上限；负向顶到下限。 */
    expect(dialValueFromAngle({ startAngleDeg: 0, currentAngleDeg: 180, startValue: 50 })).toBe(95);
    expect(dialValueFromAngle({ startAngleDeg: 0, currentAngleDeg: -180, startValue: 50 })).toBe(5);
    expect(dialValueFromAngle({ startAngleDeg: 0, currentAngleDeg: 180, startValue: 95 })).toBe(100);
    expect(dialValueFromAngle({ startAngleDeg: 0, currentAngleDeg: -180, startValue: 3 })).toBe(1);
  });

  it("角度换算：正上方 0°、右侧 90°、下方 180°", () => {
    const center = { centerX: 100, centerY: 100 };
    expect(angleOfPoint({ ...center, x: 100, y: 50 })).toBeCloseTo(0, 5);
    expect(angleOfPoint({ ...center, x: 150, y: 100 })).toBeCloseTo(90, 5);
    expect(angleOfPoint({ ...center, x: 100, y: 150 })).toBeCloseTo(180, 5);
    expect(angleOfPoint({ ...center, x: 50, y: 100 })).toBeCloseTo(-90, 5);
    /* 圆心本身给 0（不产生 NaN）。 */
    expect(angleOfPoint({ ...center, x: 100, y: 100 })).toBe(0);
  });
});

describe("胶囊文案", () => {
  it("正常值给「N 颗」", () => {
    expect(ledCapsuleText(64)).toBe("64 颗");
    expect(ledCapsuleText(1)).toBe("1 颗");
    expect(ledCapsuleText(100)).toBe("100 颗");
  });

  it("还没读到给占位（不是 0 颗）", () => {
    expect(ledCapsuleText(0)).toBe("— 颗");
    expect(ledCapsuleText(Number.NaN)).toBe("— 颗");
  });
});

describe("缩小会裁分区的判定", () => {
  it("分区终点 ≥ 新灯珠数就会被裁", () => {
    expect(willTrimZones([{ start: 0, end: 29 }], 30)).toBe(false);
    expect(willTrimZones([{ start: 0, end: 30 }], 30)).toBe(true);
    expect(willTrimZones([{ start: 0, end: 19 }, { start: 20, end: 49 }], 40)).toBe(true);
  });

  it("没有分区时永远不用问", () => {
    expect(willTrimZones([], 1)).toBe(false);
    expect(willTrimZones([], 100)).toBe(false);
  });

  it("完全落在新范围内的分区不算被裁", () => {
    expect(
      willTrimZones(
        [
          { start: 0, end: 9 },
          { start: 10, end: 19 },
        ],
        20,
      ),
    ).toBe(false);
  });

  it("新灯珠数非法时：有分区就当作会被裁（保守）", () => {
    expect(willTrimZones([{ start: 0, end: 5 }], 0)).toBe(true);
    expect(willTrimZones([], 0)).toBe(false);
  });
});
