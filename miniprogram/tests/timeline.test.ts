/**
 * 时间轴与时长（#65）的纯逻辑单测。
 *
 * 这一层刻意不碰页面与 wx：边界的坑（单步骤 / 八步骤 / 0.5 秒 / 越界拖动）
 * 在模拟器上只能靠肉眼，规则本身必须能直接构造输入断言输出。
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  addStep,
  allocateWidths,
  blockIndexAt,
  blockIndexAtRects,
  BLOCK_GAP_PX,
  canAddStep,
  chooseGap,
  clampDuration,
  clampSelected,
  COMPACT_BLOCK_GAP_PX,
  createTimeline,
  DEFAULT_STEP_MS,
  DRAG_LIFT_SCALE,
  DRAG_TAP_SUPPRESS_MS,
  dragFollowOffset,
  dragOffsetFor,
  dragStyleOf,
  dragTapSuppressUntil,
  dragTargetAtRects,
  durationFromRatio,
  durationPercent,
  durationSeconds,
  durationSteps,
  durationText,
  durationTicks,
  DURATION_STEP_MS,
  LABEL_MIN_PX,
  layoutBlocks,
  LONG_PRESS_MS,
  MAX_DURATION_MS,
  MAX_STEPS,
  MIN_BLOCK_PX,
  MIN_DURATION_MS,
  moveBlock,  removeStep,
  selectionAfterMove,
  setStepDuration,
  tapSuppressedAt,
  thumbBands,
  timelineRowWidth,
  type TimelineStep,
} from "../utils/control/timeline";

/** 造一个步骤（默认 1 秒、无分区）。 */
function step(durationMs: number, zones: TimelineStep["zones"] = []): TimelineStep {
  return { durationMs, zones };
}

/** 浮点比较。 */
function near(actual: number, expected: number, epsilon = 1e-6): boolean {
  return Math.abs(actual - expected) <= epsilon;
}

describe("时长钳位", () => {
  it("下限 0.5 秒：0.4 / 0 / 负数都抬到 0.5", () => {
    expect(clampDuration(400)).toBe(MIN_DURATION_MS);
    expect(clampDuration(0)).toBe(MIN_DURATION_MS);
    expect(clampDuration(-900)).toBe(MIN_DURATION_MS);
    expect(MIN_DURATION_MS).toBe(500);
  });

  it("上限 30 秒：30.1 / 31 秒都压到 30", () => {
    expect(clampDuration(30100)).toBe(MAX_DURATION_MS);
    expect(clampDuration(31000)).toBe(MAX_DURATION_MS);
    expect(clampDuration(MAX_DURATION_MS)).toBe(MAX_DURATION_MS);
  });

  it("以 0.5 秒为单位四舍五入到最近一档", () => {
    expect(clampDuration(700)).toBe(500);
    expect(clampDuration(1000)).toBe(1000);
    expect(clampDuration(1200)).toBe(1000);
    expect(clampDuration(1249)).toBe(1000);
    expect(clampDuration(1250)).toBe(1500);
    expect(clampDuration(1749)).toBe(1500);
    expect(clampDuration(1750)).toBe(2000);
    expect(clampDuration(29400)).toBe(29500);
  });

  it("非法值当成「没说」，回到默认 1 秒（不会清成 0）", () => {
    expect(clampDuration(Number.NaN)).toBe(DEFAULT_STEP_MS);
    expect(clampDuration(Number.POSITIVE_INFINITY)).toBe(DEFAULT_STEP_MS);
    expect(DEFAULT_STEP_MS).toBe(1000);
  });

  it("可选档位数：0.5 到 30 秒共 60 档", () => {
    expect(durationSteps()).toBe(60);
    expect((MAX_DURATION_MS - MIN_DURATION_MS) / DURATION_STEP_MS + 1).toBe(durationSteps());
  });

  it("文案用秒，且只有一位以内小数", () => {
    expect(durationText(500)).toBe("0.5 秒");
    expect(durationText(1500)).toBe("1.5 秒");
    expect(durationText(15000)).toBe("15 秒");
    expect(durationText(30000)).toBe("30 秒");
    expect(durationText(99999)).toBe("30 秒");
    expect(durationSeconds(2500)).toBe(2.5);
  });

  it("时长条位置 0-100：两端是 0.5 / 30，中间 15 秒不在正中", () => {
    expect(durationPercent(MIN_DURATION_MS)).toBe(0);
    expect(durationPercent(MAX_DURATION_MS)).toBe(100);
    const mid = durationPercent(15000);
    expect(mid).toBeGreaterThan(49);
    expect(mid).toBeLessThan(50);
  });

  it("时长条位置回到时长是稳定的（不会漂移半格）", () => {
    for (const ms of [500, 1000, 2500, 15000, 29500, 30000]) {
      expect(durationFromRatio(durationPercent(ms) / 100)).toBe(ms);
    }
    expect(durationFromRatio(-1)).toBe(MIN_DURATION_MS);
    expect(durationFromRatio(2)).toBe(MAX_DURATION_MS);
  });
});

describe("宽度分配：比例", () => {
  it("没触发保底时严格按时长比例（水位法不改变比例）", () => {
    /* 1 : 2 : 4 秒，行宽 700 = 7×100 → 100 / 200 / 400。 */
    const widths = allocateWidths([1000, 2000, 4000], 700, MIN_BLOCK_PX);
    expect(widths.map((value) => Math.round(value))).toEqual([100, 200, 400]);
    expect(near(widths.reduce((a, b) => a + b, 0), 700)).toBe(true);
  });

  it("等长步骤均分（含 8 个步骤）", () => {
    const widths = allocateWidths(new Array(8).fill(1000), 320, MIN_BLOCK_PX);
    for (const width of widths) {
      expect(near(width, 40)).toBe(true);
    }
  });

  it("空列表 / 零宽不崩", () => {
    expect(allocateWidths([], 300, MIN_BLOCK_PX)).toEqual([]);
    expect(allocateWidths([1000, 1000], 0, MIN_BLOCK_PX)).toEqual([0, 0]);
    expect(allocateWidths([1000, 1000], Number.NaN, MIN_BLOCK_PX)).toEqual([0, 0]);
  });
});

describe("宽度分配：最小宽度保底", () => {
  it("单个极短块被抬到下限，其余块之间仍严格成比例", () => {
    /* 0.5 + 5 + 10 = 15.5 秒。可用 600px 时 0.5 秒的理想宽度只有 19.4px
     * （< 24）触发保底；剩余 576px 按 1:2 分给 5 秒 / 10 秒两块。 */
    const widths = allocateWidths([500, 5000, 10000], 600, MIN_BLOCK_PX);
    expect(near(widths[0], MIN_BLOCK_PX)).toBe(true);
    expect(near(widths[1], 192)).toBe(true);
    expect(near(widths[2], 384)).toBe(true);
    expect(near(widths.reduce((a, b) => a + b, 0), 600)).toBe(true);
    /* 关键：被抬起的块之外的块，比例仍然是 2:1。 */
    expect(near(widths[2] / widths[1], 2)).toBe(true);
  });

  it("八个步骤里只有一个长块：七个 0.5 秒的块正好钉在下限", () => {
    /* 7×0.5 + 30 = 33.5 秒。可用 584px，七个短块的理想宽度只有 8.7px
     * → 全部钉在下限，30 秒块吃掉剩下的。 */
    const widths = allocateWidths([500, 500, 500, 500, 500, 500, 500, 30000], 584, MIN_BLOCK_PX);
    for (let index = 0; index < 7; index += 1) {
      expect(near(widths[index], MIN_BLOCK_PX)).toBe(true);
    }
    expect(near(widths[7], 584 - 7 * MIN_BLOCK_PX)).toBe(true);
    expect(near(widths.reduce((a, b) => a + b, 0), 584)).toBe(true);
  });

  it("长块在短块多时仍是最宽的（短块只拿到下限）", () => {
    /* 一个 30 秒 + 七个 0.5 秒，可用 584：短块全部钉在下限，长块拿走剩下的。 */
    const widths = allocateWidths([30000, 500, 500, 500, 500, 500, 500, 500], 584, MIN_BLOCK_PX);
    expect(near(widths[0], 584 - 7 * MIN_BLOCK_PX)).toBe(true);
    for (let index = 1; index < 8; index += 1) {
      expect(near(widths[index], MIN_BLOCK_PX)).toBe(true);
    }
    expect(widths[0]).toBeGreaterThan(widths[1]);
  });

  it("保底总和放不下时退化为均分（每个块都还有点得动的宽度）", () => {
    /* 8 个块 × 24px = 192px > 只有 160px 的可用宽度：水位法无解。 */
    const widths = allocateWidths([500, 500, 500, 500, 500, 500, 500, 30000], 160, MIN_BLOCK_PX);
    for (const width of widths) {
      expect(near(width, 20)).toBe(true);
    }
    expect(near(widths.reduce((a, b) => a + b, 0), 160)).toBe(true);
  });

  it("自己给的保底值也生效（边界可配）", () => {
    const widths = allocateWidths([500, 9500], 300, 100);
    expect(near(widths[0], 100)).toBe(true);
    expect(near(widths[1], 200)).toBe(true);
  });
});

describe("时间轴布局视图", () => {
  const steps = [step(1000), step(3000)];

  it("未测量时用时长当 flex 权重，并对每块给 CSS 最小宽度", () => {
    const views = layoutBlocks(steps, { widthPx: 0 });
    expect(views.map((view) => view.flexGrow)).toEqual([1000, 3000]);
    expect(views[0].style).toBe(`flex: 1000 0 0%; min-width: ${MIN_BLOCK_PX}px;`);
    expect(views.every((view) => view.widthPx === 0)).toBe(true);
    /* 没测量就没有宽度信息，不能据此隐藏文字。 */
    expect(views.every((view) => view.showLabel)).toBe(true);
  });

  it("测量后用分配到的像素当 flex 权重（总和 = 可用宽度）", () => {
    /* 行宽 408、两个块一个间隙 8 → 可用 400 → 100 / 300。 */
    const views = layoutBlocks(steps, { widthPx: 408 });
    expect(views.map((view) => Math.round(view.widthPx))).toEqual([100, 300]);
    expect(views[0].style).toBe("flex: 100 0 0%;");
    expect(views.map((view) => view.flexGrow)).toEqual(views.map((view) => view.widthPx));
    expect(near(views[0].widthPx + views[1].widthPx, 408 - BLOCK_GAP_PX)).toBe(true);
  });

  it("比例、时长文案、选中态都在视图里", () => {
    const views = layoutBlocks(steps, { widthPx: 408, selected: 1, dragIndex: 0 });
    expect(views[0].ratio).toBe(0.25);
    expect(views[1].ratio).toBe(0.75);
    expect(views.map((view) => view.durationText)).toEqual(["1 秒", "3 秒"]);
    expect(views.map((view) => view.selected)).toEqual([false, true]);
    expect(views.map((view) => view.dragging)).toEqual([true, false]);
    expect(views.every((view) => view.index === views.indexOf(view))).toBe(true);
    expect(new Set(views.map((view) => view.key)).size).toBe(2);
  });

  it("窄到画不下文字时 showLabel 关掉（文字会压到邻块上）", () => {
    /* 1 秒 vs 29 秒，行宽 200 → 可用 192 → 短块 6.4px 被保底到 40。 */
    const views = layoutBlocks([step(500), step(29500)], { widthPx: 200 });
    expect(views[0].widthPx).toBe(MIN_BLOCK_PX);
    expect(views[0].showLabel).toBe(false);
    expect(views[0].floored).toBe(true);
    expect(views[1].showLabel).toBe(true);
    expect(views[1].floored).toBe(false);
    expect(LABEL_MIN_PX).toBeGreaterThan(MIN_BLOCK_PX - 1);
  });

  it("空时间轴返回空视图（页面显示引导而不是崩）", () => {
    expect(layoutBlocks([], { widthPx: 400 })).toEqual([]);
  });

  it("缩略色带跟着该步骤的分区走", () => {
    const withZones = [
      step(1000, [
        { start: 0, end: 14, hex: "#FF0000" },
        { start: 15, end: 29, hex: "#0000FF" },
      ]),
      step(1000),
    ];
    const views = layoutBlocks(withZones, { widthPx: 408, ledCount: 30 });
    expect(views[0].bands.map((band) => band.hex)).toEqual(["#FF0000", "#0000FF"]);
    expect(views[1].bands.map((band) => band.hex)).toEqual([""]);
    expect(views[1].bands[0].ratio).toBe(1);
  });
});

describe("横向坐标 → 落点", () => {
  it("落在块内、间隙里、两端之外都能给出确定结果", () => {
    const widths = [100, 300];
    expect(blockIndexAt(widths, 0)).toBe(0);
    expect(blockIndexAt(widths, 99)).toBe(0);
    /* 100–108 是间隙：算右边那块。 */
    expect(blockIndexAt(widths, 104)).toBe(1);
    expect(blockIndexAt(widths, 407)).toBe(1);
    expect(blockIndexAt(widths, 9999)).toBe(1);
    expect(blockIndexAt(widths, -20)).toBe(0);
  });

  it("空行 / 非法坐标返回 -1", () => {
    expect(blockIndexAt([], 10)).toBe(-1);
    expect(blockIndexAt([100], Number.NaN)).toBe(-1);
  });
});

describe("屏幕坐标 → 落点（拖动中按块矩形命中）", () => {
  /* 三个块的屏幕位置：0-100 / 108-200 / 208-400。 */
  const rects = [
    { left: 0, right: 100 },
    { left: 108, right: 200 },
    { left: 208, right: 400 },
  ];

  it("落在块内就是那一块", () => {
    expect(blockIndexAtRects(rects, 0)).toBe(0);
    expect(blockIndexAtRects(rects, 99)).toBe(0);
    expect(blockIndexAtRects(rects, 150)).toBe(1);
    expect(blockIndexAtRects(rects, 399)).toBe(2);
  });

  it("落在间隙里归最近的那块（间隙 100-108 归右边）", () => {
    expect(blockIndexAtRects(rects, 102)).toBe(0);
    expect(blockIndexAtRects(rects, 107)).toBe(1);
  });

  it("拖出两端钳到首 / 末块", () => {
    expect(blockIndexAtRects(rects, -200)).toBe(0);
    expect(blockIndexAtRects(rects, 9999)).toBe(2);
  });

  it("空矩形 / 非法坐标返回 -1", () => {
    expect(blockIndexAtRects([], 10)).toBe(-1);
    expect(blockIndexAtRects(rects, Number.NaN)).toBe(-1);
  });

  it("行被横向滚动过（矩形整体左移）不影响命中", () => {
    const scrolled = rects.map((rect) => ({ left: rect.left - 120, right: rect.right - 120 }));
    expect(blockIndexAtRects(scrolled, 30)).toBe(1);
    expect(blockIndexAtRects(scrolled, 200)).toBe(2);
  });
});

describe("按索引重排", () => {
  const list = ["a", "b", "c", "d"];

  it("把一块挪到目标位置，其余顺序保持", () => {
    expect(moveBlock(list, 0, 2)).toEqual(["b", "c", "a", "d"]);
    expect(moveBlock(list, 3, 0)).toEqual(["d", "a", "b", "c"]);
    expect(moveBlock(list, 1, 2)).toEqual(["a", "c", "b", "d"]);
    expect(list).toEqual(["a", "b", "c", "d"]); // 不改入参
  });

  it("自身移动是无操作，且返回同一个数组（可据此判断没发生）", () => {
    expect(moveBlock(list, 2, 2)).toBe(list);
  });

  it("越界 / 非整数下标都是无操作", () => {
    expect(moveBlock(list, -1, 1)).toBe(list);
    expect(moveBlock(list, 0, -1)).toBe(list);
    expect(moveBlock(list, 4, 0)).toBe(list);
    expect(moveBlock(list, 0, 4)).toBe(list);
    expect(moveBlock(list, 1.5, 2)).toBe(list);
    expect(moveBlock(list, 0, Number.NaN)).toBe(list);
  });

  it("空列表不崩", () => {
    const empty: string[] = [];
    expect(moveBlock(empty, 0, 0)).toBe(empty);
    expect(moveBlock(empty, 0, 1)).toBe(empty);
  });
});

describe("重排后的选中下标", () => {
  it("选中的就是被拖的那块 → 跟着走", () => {
    expect(selectionAfterMove(2, 2, 5)).toBe(5);
    expect(selectionAfterMove(2, 2, 0)).toBe(0);
  });

  it("拖动跨过选中块 → 选中块让一位", () => {
    /* 把 0 挪到 3：原来的 1 / 2 / 3 各前移一位，选中 2 变 1。 */
    expect(selectionAfterMove(2, 0, 3)).toBe(1);
    expect(selectionAfterMove(2, 3, 0)).toBe(3);
  });

  it("没跨过选中块 → 选中不动", () => {
    expect(selectionAfterMove(0, 2, 3)).toBe(0);
    expect(selectionAfterMove(3, 0, 1)).toBe(3);
    expect(selectionAfterMove(1, 1, 1)).toBe(1);
  });
});

describe("增段", () => {
  it("新建的时间轴是两段（让「比例」一眼可懂）", () => {
    const timeline = createTimeline();
    expect(timeline).toHaveLength(2);
    expect(timeline.every((item) => item.durationMs === DEFAULT_STEP_MS)).toBe(true);
    expect(timeline.every((item) => item.zones.length === 0)).toBe(true);
  });

  it("加一段：默认 1 秒、无分区，返回新列表并选中新段", () => {
    const result = addStep([step(2000)]);
    expect(result).not.toBeNull();
    expect(result!.steps).toHaveLength(2);
    expect(result!.steps[1].durationMs).toBe(DEFAULT_STEP_MS);
    expect(result!.steps[1].zones).toEqual([]);
    expect(result!.selected).toBe(1);
  });

  it("指定的时长也会被钳位", () => {
    expect(addStep([step(1000)], 99999)!.steps[1].durationMs).toBe(MAX_DURATION_MS);
    expect(addStep([step(1000)], 100)!.steps[1].durationMs).toBe(MIN_DURATION_MS);
  });

  it("不改入参（页面可以拿旧数组做比较）", () => {
    const original = [step(1000)];
    addStep(original, 2000);
    expect(original).toHaveLength(1);
  });

  it("上限 8 段：第 9 段加不进去，按钮据此禁用", () => {
    let timeline: TimelineStep[] = [];
    for (let index = 0; index < MAX_STEPS; index += 1) {
      expect(canAddStep(timeline)).toBe(true);
      timeline = addStep(timeline)!.steps;
    }
    expect(timeline).toHaveLength(MAX_STEPS);
    expect(MAX_STEPS).toBe(8);
    expect(canAddStep(timeline)).toBe(false);
    expect(addStep(timeline)).toBeNull();
  });
});

describe("选中下标钳位", () => {
  it("钳在 [0, count - 1]", () => {
    expect(clampSelected(-3, 4)).toBe(0);
    expect(clampSelected(0, 4)).toBe(0);
    expect(clampSelected(3, 4)).toBe(3);
    expect(clampSelected(9, 4)).toBe(3);
    expect(clampSelected(1.9, 4)).toBe(1);
  });

  it("空列表 / 非法值回到 0", () => {
    expect(clampSelected(2, 0)).toBe(0);
    expect(clampSelected(2, -1)).toBe(0);
    expect(clampSelected(Number.NaN, 4)).toBe(0);
  });
});

describe("删段（本票界面还没入口，规则先锁住）", () => {
  it("删掉的段在选中段之前 → 选中跟着前移", () => {
    const result = removeStep([step(1000), step(1000), step(1000)], 0, 2);
    expect(result.steps).toHaveLength(2);
    expect(result.selected).toBe(1);
  });

  it("删掉的就是选中段 → 钳到合法范围", () => {
    expect(removeStep([step(1000), step(1000)], 1, 1).selected).toBe(0);
    expect(removeStep([step(1000), step(1000), step(1000)], 0, 0).selected).toBe(0);
  });

  it("删到空时选中回到 0，不残留越界下标", () => {
    const result = removeStep([step(1000)], 0, 0);
    expect(result.steps).toEqual([]);
    expect(result.selected).toBe(0);
    expect(clampSelected(result.selected, result.steps.length)).toBe(0);
  });

  it("越界下标是无操作", () => {
    const steps = [step(1000), step(2000)];
    expect(removeStep(steps, 5, 1).steps).toHaveLength(2);
    expect(removeStep(steps, -1, 1).steps).toHaveLength(2);
    expect(removeStep(steps, 5, 1).selected).toBe(1);
  });
});

describe("改时长", () => {
  it("只改目标段并钳位，其它段原样", () => {
    const steps = [step(1000), step(5000)];
    const next = setStepDuration(steps, 1, 12345);
    expect(next.map((item) => item.durationMs)).toEqual([1000, 12500]);
    /* 不改入参：页面拿旧数组比较「有没有变」。 */
    expect(steps.map((item) => item.durationMs)).toEqual([1000, 5000]);
  });

  it("越界下标是无操作（原样返回）", () => {
    const steps = [step(1000)];
    expect(setStepDuration(steps, -1, 100)).toBe(steps);
    expect(setStepDuration(steps, 1, 100)).toBe(steps);
    expect(setStepDuration(steps, 3, 100)).toBe(steps);
    expect(setStepDuration(steps, 0.5, 100)).toBe(steps);
  });

  it("改了时长后宽度跟着变（页面拖动时不重建整页）", () => {
    const before = layoutBlocks([step(1000), step(1000)], { widthPx: 408 });
    expect(Math.round(before[0].widthPx)).toBe(200);
    const after = layoutBlocks(setStepDuration([step(1000), step(1000)], 0, 3000), {
      widthPx: 408,
    });
    expect(Math.round(after[0].widthPx)).toBe(300);
    expect(Math.round(after[1].widthPx)).toBe(100);
    /* 总和不变：块宽此消彼长，行不会溢出。 */
    expect(near(after[0].widthPx + after[1].widthPx, 400)).toBe(true);
  });
});

describe("缩略色带", () => {
  it("按灯珠比例铺满：前 15 红后 15 蓝 → 0.5 / 0.5", () => {
    const bands = thumbBands(
      [
        { start: 0, end: 14, hex: "#FF0000" },
        { start: 15, end: 29, hex: "#0000FF" },
      ],
      30,
    );
    expect(bands.map((band) => band.hex)).toEqual(["#FF0000", "#0000FF"]);
    expect(bands.map((band) => band.ratio)).toEqual([0.5, 0.5]);
  });

  it("没被分区覆盖的灯珠是留白色带（色带不会整体右移）", () => {
    const bands = thumbBands([{ start: 6, end: 14, hex: "#00FF00" }], 30);
    expect(bands.map((band) => band.hex)).toEqual(["", "#00FF00", ""]);
    expect(bands.map((band) => band.ratio)).toEqual([0.2, 0.3, 0.5]);
    expect(near(bands.reduce((sum, band) => sum + band.ratio, 0), 1)).toBe(true);
  });

  it("没有分区 → 一条整宽的留白（不是空白一片）", () => {
    const bands = thumbBands([], 30);
    expect(bands).toHaveLength(1);
    expect(bands[0].hex).toBe("");
    expect(bands[0].ratio).toBe(1);
  });

  it("一个分区覆盖全条 → 一条满宽色带", () => {
    const bands = thumbBands([{ start: 0, end: 29, hex: "#123456" }], 30);
    expect(bands).toHaveLength(1);
    expect(bands[0]).toEqual({
      key: "band-0",
      ratio: 1,
      hex: "#123456",
      style: "flex: 1 0 0%; background: #123456;",
    });
  });

  it("留白色带不带 background（走 CSS 兜底，主题切换才跟得上）", () => {
    const bands = thumbBands([{ start: 0, end: 14, hex: "#FF0000" }], 30);
    expect(bands[1].hex).toBe("");
    expect(bands[1].style).toBe("flex: 0.5 0 0%;");
    expect(bands[0].style).toContain("background: #FF0000;");
  });

  it("三个等长分区 → 三等分", () => {
    const bands = thumbBands(
      [
        { start: 0, end: 9, hex: "#111111" },
        { start: 10, end: 19, hex: "#222222" },
        { start: 20, end: 29, hex: "#333333" },
      ],
      30,
    );
    expect(bands.map((band) => band.ratio)).toEqual([1 / 3, 1 / 3, 1 / 3]);
  });

  it("越界 / 倒序 / 空色的分区被跳过或裁剪，不产生负数比例", () => {
    const bands = thumbBands(
      [
        { start: 25, end: 40, hex: "#ABCDEF" }, // 尾部裁剪到 29
        { start: 10, end: 4, hex: "#FF00FF" }, // 倒序 → 丢弃
        { start: 0, end: 3, hex: "" }, // 空色 → 丢弃
      ],
      30,
    );
    expect(bands.map((band) => band.hex)).toEqual(["", "#ABCDEF"]);
    expect(near(bands[0].ratio, 25 / 30)).toBe(true);
    expect(near(bands[1].ratio, 5 / 30)).toBe(true);
    expect(bands.every((band) => band.ratio > 0)).toBe(true);
  });

  it("重叠的分区按先来的算，不重复计数", () => {
    const bands = thumbBands(
      [
        { start: 0, end: 19, hex: "#111111" },
        { start: 10, end: 29, hex: "#222222" },
      ],
      30,
    );
    expect(bands.map((band) => band.hex)).toEqual(["#111111", "#222222"]);
    expect(near(bands[0].ratio, 20 / 30)).toBe(true);
    expect(near(bands[1].ratio, 10 / 30)).toBe(true);
  });

  it("灯珠数未知（0）时没有色带可画", () => {
    expect(thumbBands([{ start: 0, end: 4, hex: "#FFFFFF" }], 0)).toEqual([]);
    expect(thumbBands([{ start: 0, end: 4, hex: "#FFFFFF" }], Number.NaN)).toEqual([]);
  });

  it("色带 key 在同一块内唯一（wx:key 用）", () => {
    const bands = thumbBands(
      [
        { start: 2, end: 4, hex: "#A00000" },
        { start: 10, end: 12, hex: "#00A000" },
      ],
      20,
    );
    expect(new Set(bands.map((band) => band.key)).size).toBe(bands.length);
  });
});

describe("长按阈值", () => {
  it("300 毫秒（#82 从 380 收紧）：短到按住就有反应，又长于一次普通点击", () => {
    expect(LONG_PRESS_MS).toBe(300);
  });
});

describe("拖动让位的位移映射（#82）", () => {
  /* 三块等宽 100、间隙 8：移动一格 = 108px。 */
  const widths = [100, 100, 100];
  const oneSlot = 100 + BLOCK_GAP_PX;

  it("向右拖：中间的块左移一格让出插槽，被拖块自己不动", () => {
    expect(dragOffsetFor(0, 2, widths)).toEqual([0, -oneSlot, -oneSlot]);
    expect(dragOffsetFor(1, 2, widths)).toEqual([0, 0, -oneSlot]);
  });

  it("向左拖：中间的块右移一格让出插槽", () => {
    expect(dragOffsetFor(2, 0, widths)).toEqual([oneSlot, oneSlot, 0]);
    expect(dragOffsetFor(2, 1, widths)).toEqual([0, oneSlot, 0]);
  });

  it("原地（同一个下标）没有任何位移", () => {
    expect(dragOffsetFor(1, 1, widths)).toEqual([0, 0, 0]);
  });

  it("越界 / 非整数下标一律无位移（块原地回弹）", () => {
    expect(dragOffsetFor(-1, 1, widths)).toEqual([0, 0, 0]);
    expect(dragOffsetFor(0, 3, widths)).toEqual([0, 0, 0]);
    expect(dragOffsetFor(1.5, 0, widths)).toEqual([0, 0, 0]);
    expect(dragOffsetFor(0, Number.NaN, widths)).toEqual([0, 0, 0]);
    expect(dragOffsetFor(0, 1, [])).toEqual([]);
  });

  it("让位距离是**被拖块**的宽度 + 间隙（不是目标块的）", () => {
    /* 被拖块 40 宽，目标块 200 宽：插槽按 40 + 8 = 48 算。 */
    expect(dragOffsetFor(1, 2, [200, 40, 200])).toEqual([0, 0, -48]);
    /* 反过来拖 200 宽的那块到最前：让位距离是 200 + 8 = 208。 */
    expect(dragOffsetFor(2, 0, [200, 40, 200])).toEqual([208, 208, 0]);
  });

  it("自定义间隙（紧凑档 4px）时按传入的间隙算", () => {
    expect(dragOffsetFor(0, 1, [100, 100], COMPACT_BLOCK_GAP_PX)).toEqual([0, -104]);
  });

  it("八块一次跨到对面：中间的块全部让位、两端之外的不动", () => {
    const eight = new Array(8).fill(24);
    const offsets = dragOffsetFor(0, 7, eight);
    expect(offsets[0]).toBe(0);
    for (let index = 1; index <= 7; index += 1) {
      expect(offsets[index]).toBe(-(24 + BLOCK_GAP_PX));
    }
  });
});

describe("拖动位移直接进视图（页面不做算术）", () => {
  const steps = [step(1000), step(1000), step(1000)];
  const measured = { widthPx: 3 * 100 + 2 * BLOCK_GAP_PX };

  it("让位的块拿到内联 translateX，被拖的块只有放大", () => {
    const views = layoutBlocks(steps, { ...measured, dragIndex: 0, dropIndex: 2 });
    expect(views.map((view) => view.dragOffsetPx)).toEqual([0, -108, -108]);
    expect(views[1].dragStyle).toBe("transform: translateX(-108px);");
    expect(views[0].dragStyle).toBe(`transform: translateX(0px) scale(${DRAG_LIFT_SCALE});`);
    expect(views[0].dragging).toBe(true);
  });

  it("没在拖动时位移与位移串都是空（交给 CSS 回弹）", () => {
    const views = layoutBlocks(steps, measured);
    expect(views.every((view) => view.dragOffsetPx === 0)).toBe(true);
    expect(views.every((view) => view.dragStyle === "")).toBe(true);
  });

  it("原地拖动不产生位移（from === to）", () => {
    const views = layoutBlocks(steps, { ...measured, dragIndex: 1, dropIndex: 1 });
    expect(views.every((view) => view.dragOffsetPx === 0)).toBe(true);
    expect(views[1].dragStyle).toBe(`transform: translateX(0px) scale(${DRAG_LIFT_SCALE});`);
    /* 原地拖动没有落点高亮（被拖块自己不标落点）。 */
    expect(views.some((view) => view.dropTarget)).toBe(false);
  });

  it("落点高亮只给被挤开的那一块，被拖块不标落点", () => {
    const views = layoutBlocks(steps, { ...measured, dragIndex: 0, dropIndex: 2 });
    expect(views.map((view) => view.dropTarget)).toEqual([false, false, true]);
  });

  it("未测量时没有位移（像素宽度未知），抬起的块仍会放大", () => {
    const views = layoutBlocks(steps, { widthPx: 0, dragIndex: 0, dropIndex: 2 });
    expect(views.every((view) => view.dragOffsetPx === 0)).toBe(true);
    /* 让位要像素宽度，没测量就没有；被拖块自己只放大，不位移。 */
    expect(views[1].dragStyle).toBe("");
    expect(views[2].dragStyle).toBe("");
    expect(views[0].dragStyle).toBe(`transform: translateX(0px) scale(${DRAG_LIFT_SCALE});`);
  });

  it("跟手位移写进被拖块的 transform，和放大是同一条变换", () => {
    const views = layoutBlocks(steps, {
      ...measured,
      dragIndex: 1,
      dropIndex: 1,
      followPx: -37.44,
    });
    expect(views[1].dragStyle).toBe(
      `transform: translateX(-37.4px) scale(${DRAG_LIFT_SCALE});`,
    );
  });
});

describe("被拖块跟手与边界（#82）", () => {
  /* 三块屏幕位置：0-100 / 108-200 / 208-400。 */
  const rects = [
    { left: 0, right: 100 },
    { left: 108, right: 200 },
    { left: 208, right: 400 },
  ];

  it("跟手 = 指尖位移，0.1px 对齐", () => {
    expect(dragFollowOffset(150, 190, rects, 1)).toBe(40);
    expect(dragFollowOffset(150, 110, rects, 1)).toBe(-40);
    expect(dragFollowOffset(150, 150, rects, 1)).toBe(0);
  });

  it("块被钳在行内：左不过行首、右不过行尾", () => {
    /* 第 1 块（108-200）最左只能到 108-108 = 0，最右到 400-200 = 200。 */
    expect(dragFollowOffset(150, -500, rects, 1)).toBe(-108);
    expect(dragFollowOffset(150, 5000, rects, 1)).toBe(200);
  });

  it("没有矩形 / 非法坐标时不位移（宁可不动也不猜）", () => {
    expect(dragFollowOffset(0, 50, [], 0)).toBe(0);
    expect(dragFollowOffset(0, 50, rects, 9)).toBe(0);
    expect(dragFollowOffset(Number.NaN, 50, rects, 0)).toBe(0);
    expect(dragFollowOffset(0, Number.NaN, rects, 0)).toBe(0);
  });

  it("命中：行内按最近块，行外标记 outside", () => {
    expect(dragTargetAtRects(rects, 50)).toEqual({ index: 0, outside: false });
    expect(dragTargetAtRects(rects, 150)).toEqual({ index: 1, outside: false });
    expect(dragTargetAtRects(rects, 399)).toEqual({ index: 2, outside: false });
    /* 两侧之外：预览仍钳到首 / 末块，但松手算取消。 */
    expect(dragTargetAtRects(rects, -1)).toEqual({ index: 0, outside: true });
    expect(dragTargetAtRects(rects, 401)).toEqual({ index: 2, outside: true });
  });

  it("没有矩形 / 非法坐标：没有落点且算行外", () => {
    expect(dragTargetAtRects([], 10)).toEqual({ index: -1, outside: true });
    expect(dragTargetAtRects(rects, Number.NaN)).toEqual({ index: -1, outside: true });
  });
});

describe("拖动后的点击抑制（#82）", () => {
  it("抑制窗口是松手后 300ms", () => {
    expect(DRAG_TAP_SUPPRESS_MS).toBe(300);
    expect(dragTapSuppressUntil(1000)).toBe(1300);
  });

  it("窗口内的点击被吞，窗口外恢复正常", () => {
    const until = dragTapSuppressUntil(1000);
    expect(tapSuppressedAt(1000, until)).toBe(true);
    expect(tapSuppressedAt(1299, until)).toBe(true);
    expect(tapSuppressedAt(1300, until)).toBe(false);
    expect(tapSuppressedAt(5000, until)).toBe(false);
  });

  it("从没拖过（抑制点 0）时永远不吞点击（时间戳自愈）", () => {
    expect(tapSuppressedAt(Date.now(), 0)).toBe(false);
    expect(tapSuppressedAt(Number.NaN, 9999)).toBe(false);
  });
});

describe("位移串与抬起倍数", () => {
  it("抬起倍数 1.06，位移对齐到 0.1px", () => {
    expect(DRAG_LIFT_SCALE).toBe(1.06);
    expect(dragStyleOf(12.345, false)).toBe("transform: translateX(12.3px);");
    expect(dragStyleOf(-108, false)).toBe("transform: translateX(-108px);");
    expect(dragStyleOf(0, true)).toBe(`transform: translateX(0px) scale(${DRAG_LIFT_SCALE});`);
  });

  it("非法位移按 0 处理（不会写出 translateX(NaN)）", () => {
    expect(dragStyleOf(Number.NaN, false)).toBe("transform: translateX(0px);");
  });
});

describe("选中项跟随拖动的块（#82）", () => {
  const steps = [step(1000), step(1000), step(1000)];

  it("被拖的就是选中块 → 选中下标跟着它走", () => {
    /* 把第 0 块拖到第 2 位，选中项应该变成 2。 */
    const selected = selectionAfterMove(0, 0, 2);
    expect(selected).toBe(2);
    const after = moveBlock(steps, 0, 2);
    expect(after[selected]).toBe(steps[0]);
  });

  it("拖动跨过选中块 → 选中块让一位，仍指向原来那一步", () => {
    /* 选中 1，把 0 拖到 2：原来的第 1 步现在是第 0 位。 */
    const selected = selectionAfterMove(1, 0, 2);
    expect(selected).toBe(0);
    const after = moveBlock(steps, 0, 2);
    expect(after[selected]).toBe(steps[1]);
  });

  it("拖动没跨过选中块 → 选中不动，仍指向原来那一步", () => {
    const selected = selectionAfterMove(0, 1, 2);
    expect(selected).toBe(0);
    expect(moveBlock(steps, 1, 2)[selected]).toBe(steps[0]);
  });
});

describe("行宽：恒等于容器宽（永不横向滚动）", () => {
  const equal = (count: number, ms: number) => new Array(count).fill(ms);

  it("块少时行宽 = 容器宽", () => {
    expect(timelineRowWidth([1000, 1000], 360)).toBe(360);
    expect(timelineRowWidth([], 360)).toBe(360);
  });

  it("八个步骤也**不**撑出容器：行宽仍是容器宽", () => {
    expect(timelineRowWidth(equal(8, 1000), 320)).toBe(320);
    expect(timelineRowWidth(equal(8, 1000), 345)).toBe(345);
  });

  it("极端时长分布也不会把行撑宽", () => {
    const weights = [30000, ...equal(7, 500)];
    expect(timelineRowWidth(weights, 330)).toBe(330);
  });

  it("宽度未知（0）时退回一个下限（块数 × 最小宽 + 间隙），不会把行压成 0", () => {
    expect(timelineRowWidth(equal(8, 1000), 0)).toBe(8 * MIN_BLOCK_PX + 7 * BLOCK_GAP_PX);
    expect(timelineRowWidth([1000, 1000], Number.NaN)).toBe(2 * MIN_BLOCK_PX + BLOCK_GAP_PX);
    /* 单块没有间隙，也至少要一个最小宽。 */
    expect(timelineRowWidth([1000], 0)).toBe(MIN_BLOCK_PX);
  });

  it("八个步骤并列时每块都还有宽度、都点得中（下限 24px）", () => {
    const weights = equal(8, 500);
    const row = timelineRowWidth(weights, 345);
    const gap = chooseGap(8, row, MIN_BLOCK_PX);
    const views = layoutBlocks(
      weights.map((weight) => step(weight)),
      { widthPx: row, gapPx: gap },
    );
    for (const view of views) {
      expect(view.widthPx).toBeGreaterThanOrEqual(MIN_BLOCK_PX - 1e-6);
    }
    /* 总和 + 间隙正好填满容器：不溢出也没有空隙。 */
    const total = views.reduce((sum, view) => sum + view.widthPx, 0) + gap * 7;
    expect(near(total, row)).toBe(true);
  });

  it("30 秒 + 七个 0.5 秒：短块钉在下限，长块最宽，总和 = 容器宽", () => {
    const weights = [30000, ...equal(7, 500)];
    const row = timelineRowWidth(weights, 345);
    const gap = chooseGap(weights.length, row, MIN_BLOCK_PX);
    const views = layoutBlocks(
      weights.map((weight) => step(weight)),
      { widthPx: row, gapPx: gap },
    );
    for (let index = 1; index < 8; index += 1) {
      expect(near(views[index].widthPx, MIN_BLOCK_PX)).toBe(true);
      expect(views[index].floored).toBe(true);
    }
    expect(views[0].widthPx).toBeGreaterThan(views[1].widthPx);
    expect(views[0].floored).toBe(false);
    const total = views.reduce((sum, view) => sum + view.widthPx, 0) + gap * 7;
    expect(near(total, row)).toBe(true);
  });

  it("极窄容器（200px）下八块：均分兜底，总和仍 = 容器宽", () => {
    const weights = [30000, ...equal(7, 500)];
    const row = timelineRowWidth(weights, 200);
    const gap = chooseGap(weights.length, row, MIN_BLOCK_PX);
    /* 8×24 + 7×8 = 248 > 200，8×24 + 7×4 = 220 > 200 → 间隙取 4。 */
    expect(gap).toBe(COMPACT_BLOCK_GAP_PX);
    const views = layoutBlocks(
      weights.map((weight) => step(weight)),
      { widthPx: row, gapPx: gap },
    );
    for (const view of views) {
      expect(view.widthPx).toBeGreaterThan(0);
      expect(near(view.widthPx, (200 - 7 * gap) / 8)).toBe(true);
    }
    const total = views.reduce((sum, view) => sum + view.widthPx, 0) + gap * 7;
    expect(near(total, 200)).toBe(true);
  });

  it("步骤数从一变到八：每一步都不出容器", () => {
    for (let count = 1; count <= MAX_STEPS; count += 1) {
      const weights = new Array(count).fill(1000);
      const row = timelineRowWidth(weights, 320);
      const gap = chooseGap(count, row, MIN_BLOCK_PX);
      const views = layoutBlocks(
        weights.map((weight) => step(weight)),
        { widthPx: row, gapPx: gap },
      );
      const total = views.reduce((sum, view) => sum + view.widthPx, 0) + gap * (count - 1);
      expect(near(total, 320)).toBe(true);
      expect(views.every((view) => view.widthPx >= MIN_BLOCK_PX - 1e-6)).toBe(true);
    }
  });
});

describe("间隙降级", () => {
  it("宽容器用 8px", () => {
    expect(chooseGap(2, 345, MIN_BLOCK_PX)).toBe(BLOCK_GAP_PX);
    expect(chooseGap(8, 345, MIN_BLOCK_PX)).toBe(BLOCK_GAP_PX);
    expect(BLOCK_GAP_PX).toBe(8);
  });

  it("8px 放不下时降到 4px", () => {
    /* 8×24 + 7×8 = 248 > 240；8×24 + 7×4 = 220 ≤ 240 → 4。 */
    expect(chooseGap(8, 240, MIN_BLOCK_PX)).toBe(COMPACT_BLOCK_GAP_PX);
    /* 边界：248 正好放下 → 8。 */
    expect(chooseGap(8, 248, MIN_BLOCK_PX)).toBe(BLOCK_GAP_PX);
    expect(chooseGap(8, 247, MIN_BLOCK_PX)).toBe(COMPACT_BLOCK_GAP_PX);
  });

  it("4px 也放不下时仍返回 4（剩下靠均分兜底）", () => {
    expect(chooseGap(8, 200, MIN_BLOCK_PX)).toBe(COMPACT_BLOCK_GAP_PX);
    expect(chooseGap(8, 0, MIN_BLOCK_PX)).toBe(COMPACT_BLOCK_GAP_PX);
  });

  it("单块没有间隙：永远是宽间隙", () => {
    expect(chooseGap(1, 100, MIN_BLOCK_PX)).toBe(BLOCK_GAP_PX);
    expect(chooseGap(0, 100, MIN_BLOCK_PX)).toBe(BLOCK_GAP_PX);
  });

  it("非有限容器宽不崩", () => {
    expect(chooseGap(8, Number.NaN, MIN_BLOCK_PX)).toBe(COMPACT_BLOCK_GAP_PX);
    expect(chooseGap(8, Number.POSITIVE_INFINITY, MIN_BLOCK_PX)).toBe(BLOCK_GAP_PX);
  });
});

describe("最小块宽与标签阈值", () => {
  it("最小块宽 24px，标签阈值 48px（不跟着降）", () => {
    expect(MIN_BLOCK_PX).toBe(24);
    expect(LABEL_MIN_PX).toBe(48);
  });

  it("宽度 47 不显示时长文字，48 显示", () => {
    const views47 = layoutBlocks([step(500), step(500)], { widthPx: 47 * 2 + BLOCK_GAP_PX });
    expect(views47[0].widthPx).toBe(47);
    expect(views47[0].showLabel).toBe(false);
    const views48 = layoutBlocks([step(500), step(500)], { widthPx: 48 * 2 + BLOCK_GAP_PX });
    expect(views48[0].widthPx).toBe(48);
    expect(views48[0].showLabel).toBe(true);
  });
});

describe("页面只是单元的调用方（#154 判据：规则只有一份）", () => {
  const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const page = readFileSync(join(ROOT, "pages/part/part.ts"), "utf8");

  it("页面不自己调 layoutBlocks / timelineRowWidth / chooseGap", () => {
    expect(page).not.toContain("layoutBlocks(");
    expect(page).not.toContain("timelineRowWidth(");
    expect(page).not.toContain("chooseGap(");
  });

  it("渲染与改时长都经单元（timelineUnitView / applyTimelineDuration）", () => {
    expect(page).toContain("timelineUnitView(");
    expect(page).toContain("applyTimelineDuration(");
    expect(page).toContain("selectTimelineStep(");
    expect(page).toContain("setTimelineDuration(");
  });

  it("块的内联样式来自单元算出的 flex，页面不拼像素", () => {
    expect(page).not.toContain("flex: ");
    expect(page).not.toContain("widthPx +");
  });
});

describe("渲染层：时间轴的块来自单元输出（不再自己拼几何）", () => {
  const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const wxml = readFileSync(join(ROOT, "pages/part/part.wxml"), "utf8");
  const wxss = readFileSync(join(ROOT, "pages/part/part.wxss"), "utf8").replace(
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

  it("时间轴没有 scroll-view，也没有 scroll-x 绑定（永不横向滚动）", () => {
    expect(wxml).not.toContain("scroll-view");
    expect(wxml).not.toContain("scroll-x");
  });

  it("行宽恒为 100%，块宽全部来自单元给的内联 style", () => {
    expect(rule(".timeline-row")).toMatch(/width:\s*100%/);
    expect(wxml).toContain('class="timeline-row"');
    expect(wxml).toContain('style="{{item.style}}"');
  });

  it("块间隙与时间轴的 8px 常量一致", () => {
    expect(rule(".timeline-row")).toMatch(/gap:\s*8px/);
    expect(BLOCK_GAP_PX).toBe(8);
  });
});

describe("拖动位移直接进视图（单元派生，页面不复算）", () => {
  it("被拖块在同一条内联 transform 里抬起头与跟手位移", () => {
    const views = layoutBlocks([step(1000), step(1000)], {
      widthPx: 2 * 100 + BLOCK_GAP_PX,
      dragIndex: 0,
      dropIndex: 0,
    });
    expect(views[0].dragStyle).toContain("scale(1.06)");
  });

  it("落点块被标出，被拖块自己不算落点", () => {
    const views = layoutBlocks([step(1000), step(1000), step(1000)], {
      widthPx: 3 * 100 + BLOCK_GAP_PX * 2,
      dragIndex: 0,
      dropIndex: 2,
    });
    expect(views[0].dropTarget).toBe(false);
    expect(views[2].dropTarget).toBe(true);
  });
});

describe("时长刻度", () => {
  it("三个刻度：0.5 / 15 / 30 秒，两端贴边", () => {
    const ticks = durationTicks();
    expect(ticks.map((tick) => tick.label)).toEqual(["0.5 秒", "15 秒", "30 秒"]);
    expect(ticks.map((tick) => tick.durationMs)).toEqual([500, 15000, 30000]);
    expect(ticks.map((tick) => tick.align)).toEqual(["first", "mid", "last"]);
    expect(ticks[0].percent).toBe(0);
    expect(ticks[2].percent).toBe(100);
  });
});
