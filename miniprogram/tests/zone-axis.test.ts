/**
 * 光区轴（#66）的纯布局单测。
 *
 * 光区轴只有「看着对不对」这一条路能验证的话，比例定位与灰条这类边界就只能
 * 靠肉眼。这里直接构造输入断言百分比与块顺序。
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { MAX_SEGMENTS } from "../utils/protocol/constants";
import {
  AXIS_LABEL_MIN_PERCENT,
  axisColorMap,
  axisHandles,
  axisRect,
  axisStyle,
  axisZonesOf,
  buildZoneAxis,
  canAddZoneAt,
  HANDLE_CROWDED_MAX_PERCENT,
  MAX_ZONES,
  selectedZoneAfter,
  zoneAxisGuide,
  zoneAxisSummary,
  zoneRangeDetail,
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

describe("起止手柄（axisHandles， #77）", () => {
  it("普通区间：起点 = start/灯珠数、终点 = (end+1)/灯珠数", () => {
    const handles = axisHandles(0, 9, 30);
    expect(handles).toHaveLength(2);
    expect(handles[0].kind).toBe("start");
    expect(handles[1].kind).toBe("end");
    expect(near(handles[0].percent, 0)).toBe(true);
    expect(near(handles[1].percent, (10 / 30) * 100)).toBe(true);
  });

  it("中间一段：两端都是独立定位串，起点在左、终点在右", () => {
    const handles = axisHandles(10, 19, 30);
    expect(handles[0].percent).toBeLessThan(handles[1].percent);
    expect(near(handles[0].percent, (10 / 30) * 100)).toBe(true);
    expect(near(handles[1].percent, (20 / 30) * 100)).toBe(true);
    /* 块内定位：两端各自贴块边，绝对定位不参与块宽计算。 */
    expect(handles[0].style).toContain("left: 0%");
    expect(handles[1].style).toContain("left: 100%");
  });

  it("整条覆盖：起点落 0%、终点落 100%", () => {
    const handles = axisHandles(0, 29, 30);
    expect(near(handles[0].percent, 0)).toBe(true);
    expect(near(handles[1].percent, 100)).toBe(true);
    expect(handles.some((handle) => handle.crowded)).toBe(false);
  });

  it("单颗光区：两个手柄是两个不同的锚点（不会算出同一个位置）", () => {
    const handles = axisHandles(4, 4, 20);
    expect(handles[0].percent).not.toBe(handles[1].percent);
    expect(near(handles[0].percent, 20)).toBe(true);
    expect(near(handles[1].percent, 25)).toBe(true);
  });

  it("单颗光区且灯珠很密：标记为拥挤（渲染层缩小手柄并向外错开）", () => {
    const dense = axisHandles(4, 4, 100);
    expect(dense.every((handle) => handle.crowded)).toBe(true);
    expect(dense[0].percent).toBeLessThan(dense[1].percent);
    /* 稀疏的灯组里单颗不算拥挤。 */
    const sparse = axisHandles(4, 4, 10);
    expect(sparse.some((handle) => handle.crowded)).toBe(false);
  });

  it("拥挤阈值是一个可断言的常量（两柄中心距小于它就算挤）", () => {
    expect(HANDLE_CROWDED_MAX_PERCENT).toBeGreaterThan(0);
    expect(HANDLE_CROWDED_MAX_PERCENT).toBeLessThanOrEqual(10);
    /* 单颗在 100 颗里占 1%，必然小于阈值；在 10 颗里占 10%，不小于阈值。 */
    expect(axisHandles(50, 50, 100).every((handle) => handle.crowded)).toBe(true);
    expect(axisHandles(5, 5, 10).some((handle) => handle.crowded)).toBe(false);
  });

  it("越界 / 非法灯珠数 → 空数组（不画假手柄）", () => {
    expect(axisHandles(0, 9, 0)).toEqual([]);
    expect(axisHandles(9, 3, 30)).toEqual([]);
    expect(axisHandles(30, 40, 30)).toEqual([]);
  });
});

describe("块上的手柄与区间文案（#77）", () => {
  it("只有选中的光区带手柄，未选中 / 灰条都不带", () => {
    const blocks = buildZoneAxis({
      zones: [zone(0, 0, 9), zone(1, 20, 29)],
      ledCount: 30,
      selectedSegId: 1,
    });
    const withHandles = blocks.filter((block) => block.handles.length > 0);
    expect(withHandles.map((block) => block.segId)).toEqual([1]);
    expect(withHandles[0].handles.map((handle) => handle.kind)).toEqual(["start", "end"]);
    expect(blocks.every((block) => block.kind === "zone" || block.handles.length === 0)).toBe(true);
  });

  it("选中不改变块宽：选中前后同一块的 left / width 完全一致（不跳动）", () => {
    const input = { zones: [zone(0, 0, 9), zone(1, 20, 29)], ledCount: 30 };
    const before = buildZoneAxis(input);
    const after = buildZoneAxis({ ...input, selectedSegId: 0 });
    const pick = (blocks: typeof before, segId: number) =>
      blocks.find((block) => block.kind === "zone" && block.segId === segId)!;
    expect(pick(after, 0).left).toBe(pick(before, 0).left);
    expect(pick(after, 0).width).toBe(pick(before, 0).width);
    expect(pick(after, 0).style).toBe(pick(before, 0).style);
    /* 旁边的块也不因为选中而移动。 */
    expect(pick(after, 1).style).toBe(pick(before, 1).style);
  });

  it("区间文案：「第 0–19 颗 · 20 颗」，颗数与设备区间一致", () => {
    const blocks = buildZoneAxis({ zones: [zone(0, 0, 19)], ledCount: 20 });
    const only = blocks.find((block) => block.kind === "zone")!;
    expect(only.rangeText).toBe("0–19");
    expect(only.rangeDetail).toBe("第 0–19 颗 · 20 颗");
    expect(only.span).toBe(20);
  });

  it("单颗光区的文案是「第 4–4 颗 · 1 颗」", () => {
    const blocks = buildZoneAxis({ zones: [zone(0, 4, 4)], ledCount: 20 });
    const only = blocks.find((block) => block.kind === "zone")!;
    expect(only.rangeDetail).toBe("第 4–4 颗 · 1 颗");
  });

  it("整条光区的文案覆盖完整区间", () => {
    const blocks = buildZoneAxis({ zones: [zone(0, 0, 29)], ledCount: 30 });
    expect(blocks[0].rangeDetail).toBe("第 0–29 颗 · 30 颗");
  });

  it("灰条没有手柄、没有区间详情（点不动的那一段不冒充光区）", () => {
    const blocks = buildZoneAxis({ zones: [zone(0, 10, 19)], ledCount: 30 });
    const gaps = blocks.filter((block) => block.kind === "gap");
    expect(gaps.map((gap) => [gap.start, gap.end])).toEqual([
      [0, 9],
      [20, 29],
    ]);
    for (const gap of gaps) {
      expect(gap.handles).toEqual([]);
      expect(gap.rangeDetail).toBe("");
      expect(gap.selected).toBe(false);
    }
  });
});

describe("零光区引导（zoneAxisGuide）", () => {
  it("零光区给引导而不是空白", () => {
    const guide = zoneAxisGuide(0, 30);
    expect(guide.length).toBeGreaterThan(0);
    expect(guide).toContain("新增");
    expect(guide).toContain("30");
  });

  it("有光区时没有引导（不重复提示）", () => {
    expect(zoneAxisGuide(1, 30)).toBe("");
  });

  it("灯珠数未知时说明还没有读到长度", () => {
    expect(zoneAxisGuide(0, 0)).toContain("灯珠");
  });
});

describe("渲染层：起止手柄与区间文案（#77）", () => {
  const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const wxml = readFileSync(join(ROOT, "pages/strip/strip.wxml"), "utf8");
  /* 去掉注释再断言：说明文字里出现同名 token 不该让规则变假 / 变绿。 */
  const wxss = readFileSync(join(ROOT, "pages/strip/strip.wxss"), "utf8").replace(
    /\/\*[\s\S]*?\*\//g,
    "",
  );

  /** 取一个选择器的声明块（第一个匹配）。 */
  function rule(selector: string): string {
    const index = wxss.indexOf(selector);
    expect(index, `wxss 里找不到 ${selector}`).toBeGreaterThanOrEqual(0);
    const open = wxss.indexOf("{", index);
    const close = wxss.indexOf("}", open);
    return wxss.slice(open + 1, close);
  }

  it("选中的光区块内渲染两个手柄（start / end）", () => {
    expect(wxml).toContain("item.selected");
    expect(wxml).toContain("item.handles");
    expect(wxml).toContain("zone-handle");
    expect(wxml).toContain("handle-start");
    expect(wxml).toContain("handle-end");
  });

  it("手柄是绝对定位的圆形，不占块宽", () => {
    expect(rule(".zone-handle")).toMatch(/position:\s*absolute/);
    expect(rule(".zone-handle")).toMatch(/border-radius:\s*50%/);
    expect(rule(".zone-handle")).not.toMatch(/width:\s*100%/);
    /* 块本身不能 overflow:hidden，否则手柄被裁掉。 */
    expect(rule(".zone-block")).toMatch(/overflow:\s*visible/);
  });

  it("轴下方渲染区间文案", () => {
    expect(wxml).toContain("selectedZoneRangeDetail");
    expect(wxml).toContain("zone-range-detail");
  });

  it("灰条仍然点不动", () => {
    expect(rule(".zone-gap")).toMatch(/pointer-events:\s*none/);
  });

  it("零光区渲染引导块", () => {
    expect(wxml).toContain("zoneGuide");
    expect(wxml).toContain("zone-guide");
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
