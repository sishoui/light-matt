/**
 * 光区轴（#66）的纯布局单测。
 *
 * 光区轴只有「看着对不对」这一条路能验证的话，比例定位与灰条这类边界就只能
 * 靠肉眼。这里直接构造输入断言百分比与块顺序。
 */

import { describe, expect, it } from "vitest";
import { MAX_SEGMENTS } from "../utils/protocol/constants";
import {
  AXIS_LABEL_MIN_PERCENT,
  axisColorMap,
  axisRect,
  axisStyle,
  axisZonesOf,
  buildZoneAxis,
  canAddZoneAt,
  MAX_ZONES,
  selectedZoneAfter,
  zoneAxisSummary,
  zoneRangeText,
  type AxisZoneInput,
} from "../utils/control/zone-axis";

function zone(segId: number, start: number, end: number, hex = "#FF0000"): AxisZoneInput {
  return { segId, start, end, hex };
}

function near(actual: number, expected: number, epsilon = 1e-6): boolean {
  return Math.abs(actual - expected) <= epsilon;
}

describe("比例定位（axisRect）", () => {
  it("30 颗灯里的 0–9 → left 0%、宽 1/3", () => {
    const rect = axisRect(0, 9, 30)!;
    expect(near(rect.left, 0)).toBe(true);
    expect(near(rect.width, (10 / 30) * 100)).toBe(true);
  });

  it("后 10 颗 → left 2/3、宽 1/3（右边缘正好 100%）", () => {
    const rect = axisRect(20, 29, 30)!;
    expect(near(rect.left, (20 / 30) * 100)).toBe(true);
    expect(near(rect.left + rect.width, 100)).toBe(true);
  });

  it("单颗灯珠 = 1/灯珠数 的宽度", () => {
    const rect = axisRect(4, 4, 20)!;
    expect(near(rect.left, 20)).toBe(true);
    expect(near(rect.width, 5)).toBe(true);
  });

  it("起点大于终点 / 完全越界 → null（不画假块）", () => {
    expect(axisRect(9, 3, 30)).toBeNull();
    expect(axisRect(30, 40, 30)).toBeNull();
    expect(axisRect(-5, -1, 30)).toBeNull();
  });

  it("部分越界被裁剪到 0..ledCount-1", () => {
    const rect = axisRect(-5, 9, 30)!;
    expect(near(rect.left, 0)).toBe(true);
    expect(near(rect.width, (10 / 30) * 100)).toBe(true);
  });

  it("灯珠数 0 / 非法 → null", () => {
    for (const count of [0, -1, Number.NaN]) {
      expect(axisRect(0, 0, count), String(count)).toBeNull();
    }
  });

  it("样式串保留 4 位小数（不出现长尾浮点）", () => {
    expect(axisStyle({ left: 100 / 3, width: 100 / 3 })).toBe(
      "left: 33.3333%; width: 33.3333%;",
    );
  });
});

describe("块列表（buildZoneAxis）", () => {
  it("零光区：一根占满整条的灰条", () => {
    const blocks = buildZoneAxis({ zones: [], ledCount: 30 });
    expect(blocks).toHaveLength(1);
    expect(blocks[0].kind).toBe("gap");
    expect(blocks[0].start).toBe(0);
    expect(blocks[0].end).toBe(29);
    expect(blocks[0].segId).toBe(-1);
    expect(blocks[0].hex).toBe("");
  });

  it("整条覆盖：只有光区，没有灰条", () => {
    const blocks = buildZoneAxis({ zones: [zone(0, 0, 29)], ledCount: 30 });
    expect(blocks).toHaveLength(1);
    expect(blocks[0].kind).toBe("zone");
    expect(blocks.every((block) => block.kind === "zone")).toBe(true);
  });

  it("相邻两块覆盖之间没有灰条", () => {
    const blocks = buildZoneAxis({
      zones: [zone(0, 0, 9), zone(1, 10, 19)],
      ledCount: 20,
    });
    expect(blocks.filter((block) => block.kind === "gap")).toHaveLength(0);
  });

  it("按位置排序：灰条夹在光区之间（不会被挤到两端）", () => {
    const blocks = buildZoneAxis({
      zones: [zone(0, 0, 4), zone(1, 20, 29)],
      ledCount: 30,
    });
    expect(blocks.map((block) => `${block.kind}:${block.start}`)).toEqual([
      "zone:0",
      "gap:5",
      "zone:20",
    ]);
  });

  it("被乱序给出的光区仍然按起点排（渲染顺序稳定）", () => {
    const blocks = buildZoneAxis({
      zones: [zone(2, 20, 29), zone(0, 0, 4)],
      ledCount: 30,
    });
    const zones = blocks.filter((block) => block.kind === "zone");
    expect(zones.map((block) => block.segId)).toEqual([0, 2]);
  });

  it("选中态只挂在对应的那一块上（灰条永不选中）", () => {
    const blocks = buildZoneAxis({
      zones: [zone(0, 0, 9), zone(1, 20, 29)],
      ledCount: 30,
      selectedSegId: 1,
    });
    expect(blocks.filter((block) => block.selected).map((block) => block.segId)).toEqual([1]);
  });

  it("块太窄时不画标题（免得压到邻块）", () => {
    /* 30 颗里的一颗 = 3.33%，低于阈值。 */
    const blocks = buildZoneAxis({ zones: [zone(0, 4, 4)], ledCount: 30 });
    const single = blocks.find((block) => block.kind === "zone")!;
    expect(single.showLabel).toBe(false);
    expect(single.width).toBeLessThan(AXIS_LABEL_MIN_PERCENT);
  });

  it("够宽的块画「光区 N」标题（槽位 1 起）", () => {
    const blocks = buildZoneAxis({ zones: [zone(2, 0, 29)], ledCount: 30 });
    const only = blocks.find((block) => block.kind === "zone")!;
    expect(only.showLabel).toBe(true);
    expect(only.label).toBe("光区 3");
    expect(only.rangeText).toBe("0–29");
  });

  it("灯珠数未知 → 空列表（不画一条假轴）", () => {
    expect(buildZoneAxis({ zones: [zone(0, 0, 9)], ledCount: 0 })).toEqual([]);
  });

  it("单颗灯组：一个光区 + 没有灰条", () => {
    const blocks = buildZoneAxis({ zones: [zone(0, 0, 0)], ledCount: 1 });
    expect(blocks).toHaveLength(1);
    expect(blocks[0].kind).toBe("zone");
    expect(near(blocks[0].left, 0)).toBe(true);
    expect(near(blocks[0].width, 100)).toBe(true);
  });
});

describe("摘要与上限", () => {
  it("零光区写「还没有光区」并报全暗颗数", () => {
    expect(zoneAxisSummary([], 30)).toBe("还没有光区 · 30 颗全暗");
  });

  it("有未覆盖时报「N 颗未覆盖」", () => {
    expect(zoneAxisSummary([zone(0, 0, 9)], 30)).toBe("1 个光区 · 20 颗未覆盖");
  });

  it("整组覆盖时明确说出来", () => {
    expect(zoneAxisSummary([zone(0, 0, 29)], 30)).toBe("1 个光区 · 整组覆盖");
  });

  it("8 个上限（与协议槽位数一致）", () => {
    expect(MAX_ZONES).toBe(MAX_SEGMENTS);
    const seven = Array.from({ length: 7 }, (_, index) => zone(index, index, index));
    expect(canAddZoneAt(seven)).toBe(true);
    expect(canAddZoneAt([...seven, zone(7, 7, 7)])).toBe(false);
  });
});

describe("选中槽位的自愈（selectedZoneAfter）", () => {
  const zones = [zone(0, 0, 9), zone(2, 20, 29)];

  it("原槽位还在 → 保持不变（改范围后仍是同一个光区）", () => {
    expect(selectedZoneAfter(zones, 2)).toBe(2);
  });

  it("原槽位被删 → -1（**不**自动挑第一个，否则「点一块选中」永远看不见）", () => {
    expect(selectedZoneAfter(zones, 1)).toBe(-1);
  });

  it("没有光区 → -1（没有可选的）", () => {
    expect(selectedZoneAfter([], 3)).toBe(-1);
  });
});

describe("草稿 → 轴输入（axisZonesOf / axisColorMap）", () => {
  const zones = [
    { segId: 0, start: 0, end: 9, layer0: { hue: 0, sat: 255 } },
    { segId: 3, start: 20, end: 29, layer0: { hue: 43690, sat: 255 } },
  ];

  it("颜色按主效果换算（每人一个 #RRGGBB）", () => {
    const input = axisZonesOf(zones);
    expect(input).toHaveLength(2);
    for (const item of input) {
      expect(item.hex).toMatch(/^#[0-9A-F]{6}$/i);
    }
    expect(input[0].hex).not.toBe(input[1].hex);
  });

  it("色表与轴输入的颜色一致（弹窗与轴不会两套颜色）", () => {
    const colors = axisColorMap(zones);
    const input = axisZonesOf(zones);
    for (const item of input) {
      expect(colors.get(item.segId)).toBe(item.hex);
    }
  });

  it("区间文字用短横线（不与负数混淆）", () => {
    expect(zoneRangeText(0, 9)).toBe("0–9");
  });
});
