/**
 * #154 时间轴单元：**不依赖任何页面就能驱动**。
 *
 * 这一票是 prefactor（零行为变更）：把「选中步骤 / 长按重排 / 改时长 / 按容器宽
 * 分配块宽」从页面里抽成独立单元。所以这里的用例**不加载页面、不碰 wx、不碰
 * 设备**——给一组步骤，断言渲染结果、选中态、拖动的 from→to、时长钳位。
 *
 * 判据是票面那三条里的第一条：「给定一组步骤，能渲染、能选中、能长按重排、能改
 * 时长，不依赖页面」。
 *
 * v5 的形状：步骤只有「时长 + 分区色带」两个字段（没有剧本 / 方案 / 多灯组
 * 切片），所以 `applyTimelineDuration` 收的是步骤列表而不是 v4 的 `ScriptDraft`。
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  applyTimelineDrag,
  applyTimelineDuration,
  cancelTimelineDrag,
  clampTimelineSelection,
  createTimelineUnit,
  endTimelineDrag,
  isTimelineDragging,
  isTimelinePressCurrent,
  measureTimelineWidth,
  pressTimelineStep,
  selectTimelineStep,
  setTimelineDuration,
  setTimelineLedCount,
  startTimelineDrag,
  timelineStepDurationMs,
  timelineUnitView,
  trackTimelinePress,
} from "../utils/control/timeline-unit";
import { moveBlock, selectionAfterMove, type TimelineStep } from "../utils/control/timeline";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** 造一个步骤（默认 1 秒、无色带）。 */
function step(durationMs: number, zones: TimelineStep["zones"] = []): TimelineStep {
  return { durationMs, zones };
}

describe("步骤集 → 渲染", () => {
  it("空步骤：没有块、没有选中、还能加", () => {
    const view = timelineUnitView([], createTimelineUnit());
    expect(view.blocks).toEqual([]);
    expect(view.stepCount).toBe(0);
    expect(view.selected).toBe(0);
    expect(view.totalMs).toBe(0);
    expect(view.canAdd).toBe(true);
  });

  it("三个步骤各出一个块，时长文字与选中态跟着时长与下标走", () => {
    const steps = [step(500), step(1500), step(2000)];
    const view = timelineUnitView(steps, createTimelineUnit({ selected: 1 }));
    expect(view.blocks.map((block) => block.index)).toEqual([0, 1, 2]);
    expect(view.blocks.map((block) => block.durationText)).toEqual(["0.5 秒", "1.5 秒", "2 秒"]);
    expect(view.blocks.map((block) => block.selected)).toEqual([false, true, false]);
    expect(view.stepCount).toBe(3);
    expect(view.totalMs).toBe(4000);
    expect(view.canAdd).toBe(true);
  });

  it("块的缩略色带原样来自步骤（单元不做颜色推导）", () => {
    const band = { start: 0, end: 4, hex: "#112233" };
    const view = timelineUnitView([step(1000, [band])], createTimelineUnit({ ledCount: 10 }));
    /* 有颜色的那一段 + 未覆盖的留白段：两段都来自 `thumbBands`。 */
    const colored = view.blocks[0].bands.filter((item) => item.hex === "#112233");
    expect(colored.length).toBe(1);
    expect(colored[0].style).toContain("#112233");
  });

  it("八个步骤时宽度之和加间隙正好等于容器宽（永不横向滚动）", () => {
    const steps = Array.from({ length: 8 }, () => step(1000));
    const unit = measureTimelineWidth(createTimelineUnit(), 640);
    const view = timelineUnitView(steps, unit);
    const gapPx = view.gapPx ?? 0;
    const sum = view.blocks.reduce((total, block) => total + block.widthPx, 0);
    expect(view.gapPx).toBe(8);
    expect(Math.round(sum + gapPx * 7)).toBe(640);
    expect(view.compact).toBe(false);
    expect(view.canAdd, "8 步已满").toBe(false);
  });

  it("窄容器上收紧间隙并给出 compact（与 wxss 的 8px / 4px 降级一致）", () => {
    const steps = Array.from({ length: 8 }, () => step(1000));
    const unit = measureTimelineWidth(createTimelineUnit(), 8 * 24 + 4 * 7);
    const view = timelineUnitView(steps, unit);
    expect(view.compact).toBe(true);
    expect(view.gapPx).toBe(4);
  });

  it("还没测量容器宽时不出像素宽（退回时长权重 + CSS 最小宽度）", () => {
    const view = timelineUnitView([step(1000), step(3000)], createTimelineUnit());
    expect(view.gapPx).toBeUndefined();
    expect(view.blocks[0].flexGrow).toBe(1000);
    expect(view.blocks[1].flexGrow).toBe(3000);
    expect(view.blocks[0].widthPx).toBe(0);
  });
});

describe("选中步骤", () => {
  it("选中另一块返回新状态，选中自己 / 越界返回同一个对象", () => {
    const unit = createTimelineUnit();
    const next = selectTimelineStep(unit, 2, 3);
    expect(next.selected).toBe(2);
    expect(selectTimelineStep(next, 2, 3)).toBe(next);
    expect(selectTimelineStep(next, 5, 3)).toBe(next);
    expect(selectTimelineStep(next, -1, 3)).toBe(next);
  });

  it("步骤变少时选中下标被钳住（删掉当前步后还在合法位置）", () => {
    const unit = selectTimelineStep(createTimelineUnit(), 5, 8);
    expect(clampTimelineSelection(unit, 2).selected).toBe(1);
    expect(clampTimelineSelection(unit, 0).selected).toBe(0);
    expect(clampTimelineSelection(unit, 8), "没变就返回同一个状态").toBe(unit);
  });
});

describe("长按 300ms 后拖动重排", () => {
  it("按下 → 长按到点 → 拖动 → 松手：给出 from→to", () => {
    const pressed = pressTimelineStep(createTimelineUnit({ selected: 0 }), 1, 210, 3);
    expect(pressed.pending, "合法的按下要起长按定时器").toBe(true);
    expect(isTimelinePressCurrent(pressed.unit, pressed.epoch)).toBe(true);

    let unit = startTimelineDrag(pressed.unit, 1, pressed.epoch);
    expect(isTimelineDragging(unit)).toBe(true);
    expect(unit.selected, "进入拖动时选中被拖的块").toBe(1);

    /* 指尖移到第三块：跟手位移与落点由纯函数给出，单元只搬运。 */
    unit = applyTimelineDrag(unit, 440, { index: 2, outside: false });
    expect(unit.drag.follow).toBe(440);
    expect(unit.drag.to).toBe(2);
    expect(unit.drag.from).toBe(1);

    const ended = endTimelineDrag(unit);
    expect(ended.dragged).toBe(true);
    expect({ from: ended.from, to: ended.to }).toEqual({ from: 1, to: 2 });
    expect(ended.outside).toBe(false);
    expect(isTimelineDragging(ended.unit), "松手后回到空闲").toBe(false);
  });

  it("拖出时间轴松手 = 取消（落点回到源下标，不给顺序变更）", () => {
    const pressed = pressTimelineStep(createTimelineUnit(), 0, 0, 2);
    let unit = startTimelineDrag(pressed.unit, 0, pressed.epoch);
    unit = applyTimelineDrag(unit, -80, { index: 1, outside: true });
    expect(unit.drag.to, "出界时落点回到源下标").toBe(0);
    const ended = endTimelineDrag(unit);
    expect(ended.outside).toBe(true);
    expect(ended.from).toBe(0);
  });

  it("没到长按就抬起：不改顺序（这次触摸只是按住了一下）", () => {
    const pressed = pressTimelineStep(createTimelineUnit({ selected: 2 }), 0, 100, 3);
    const ended = endTimelineDrag(pressed.unit);
    expect(ended.dragged).toBe(false);
    expect(ended.unit.selected, "选中不该被按下的块抢走").toBe(2);
  });

  it("抬起后迟到的长按回调被代次作废（不会留下幽灵拖动）", () => {
    const pressed = pressTimelineStep(createTimelineUnit(), 1, 210, 3);
    const afterRelease = endTimelineDrag(pressed.unit).unit;
    expect(isTimelinePressCurrent(afterRelease, pressed.epoch)).toBe(false);
    const ghost = startTimelineDrag(afterRelease, 1, pressed.epoch);
    expect(ghost, "过期代次的回调不改状态").toBe(afterRelease);
    expect(isTimelineDragging(ghost)).toBe(false);
  });

  it("取消拖动也自增代次（页面隐藏 / 触摸取消）", () => {
    const pressed = pressTimelineStep(createTimelineUnit(), 1, 210, 3);
    const dragging = startTimelineDrag(pressed.unit, 1, pressed.epoch);
    const cancelled = cancelTimelineDrag(dragging);
    expect(isTimelineDragging(cancelled)).toBe(false);
    expect(isTimelinePressCurrent(cancelled, pressed.epoch)).toBe(false);
    expect(cancelled.drag.follow).toBe(0);
  });

  it("未进入拖动时移动手指只挪跟手零点（抬起那一刻不会跳）", () => {
    const pressed = pressTimelineStep(createTimelineUnit(), 1, 100, 3);
    const moved = trackTimelinePress(pressed.unit, 130);
    expect(moved.drag.startX).toBe(130);
    expect(isTimelineDragging(moved)).toBe(false);
  });

  it("落点与位移都没变时不返回新状态（touchmove 每秒几十次）", () => {
    const pressed = pressTimelineStep(createTimelineUnit(), 1, 0, 2);
    const unit = startTimelineDrag(pressed.unit, 1, pressed.epoch);
    const once = applyTimelineDrag(unit, 10, { index: 1, outside: false });
    expect(applyTimelineDrag(once, 10, { index: 1, outside: false })).toBe(once);
    /* 半像素抖动看不出来，也不值得一次重画。 */
    expect(applyTimelineDrag(once, 10.2, { index: 1, outside: false })).toBe(once);
  });

  it("越界的按下下标不起长按定时器", () => {
    const unit = createTimelineUnit();
    expect(pressTimelineStep(unit, 9, 0, 3).pending).toBe(false);
    expect(pressTimelineStep(unit, 3, 0, 3).pending).toBe(false);
  });

  it("重排后的顺序与选中交给调用方落地（单元只给 from→to，规则仍是纯函数）", () => {
    const steps = [step(1000), step(2000), step(3000)];
    const pressed = pressTimelineStep(createTimelineUnit({ selected: 0 }), 0, 0, 3);
    let unit = startTimelineDrag(pressed.unit, 0, pressed.epoch);
    unit = applyTimelineDrag(unit, 440, { index: 2, outside: false });
    const ended = endTimelineDrag(unit);

    const reordered = moveBlock(steps, ended.from, ended.to);
    const selected = selectionAfterMove(ended.unit.selected, ended.from, ended.to);
    const view = timelineUnitView(reordered, selectTimelineStep(ended.unit, selected, 3));
    expect(view.blocks.map((block) => block.durationMs)).toEqual([2000, 3000, 1000]);
    expect(view.blocks.map((block) => block.selected)).toEqual([false, false, true]);
  });
});

describe("改时长", () => {
  it("设成 2 秒，块宽与时长文字跟着变", () => {
    const steps = setTimelineDuration([step(1000)], 0, 2000);
    expect(steps[0].durationMs).toBe(2000);
    expect(timelineUnitView(steps, createTimelineUnit()).blocks[0].durationText).toBe("2 秒");
  });

  it("两端钳位：低于 0.5 秒 → 500，高于 30 秒 → 30000", () => {
    expect(setTimelineDuration([step(1000)], 0, 100)[0].durationMs).toBe(500);
    expect(setTimelineDuration([step(1000)], 0, 99_000)[0].durationMs).toBe(30_000);
    /* 真机滑块可能给出 0.4999 这种值：钳位后再落进模型。 */
    expect(setTimelineDuration([step(1000)], 0, 499.9)[0].durationMs).toBe(500);
    expect(setTimelineDuration([step(1000)], 0, 1400)[0].durationMs).toBe(1500);
  });

  it("下标越界 / 非有限值原样返回（引用相等 = 什么都没变）", () => {
    const steps = [step(1000)];
    expect(setTimelineDuration(steps, 3, 2000)).toBe(steps);
    expect(setTimelineDuration(steps, -1, 2000)).toBe(steps);
    /* 非有限值当成「没说」：不能因为一次半截的滑块事件把时长改回默认。 */
    expect(setTimelineDuration(steps, 0, Number.NaN)).toBe(steps);
  });

  it("只改目标那一步，别的不动", () => {
    const steps = [step(1000), step(1500)];
    const next = setTimelineDuration(steps, 1, 3000);
    expect(next[0].durationMs).toBe(1000);
    expect(next[1].durationMs).toBe(3000);
    expect(steps[1].durationMs, "入参不被就地改").toBe(1500);
  });
});

describe("时长条的秒 → 模型（页面不再自己写 seconds * 1000）", () => {
  it("2.5 秒落成 2500 毫秒", () => {
    const steps = applyTimelineDuration([step(1000)], 0, 2.5);
    expect(steps[0].durationMs).toBe(2500);
    expect(timelineStepDurationMs(steps, 0)).toBe(2500);
  });

  it("非有限值 / 越界下标原样返回同一个数组", () => {
    const steps = [step(1000)];
    expect(applyTimelineDuration(steps, 0, Number.NaN)).toBe(steps);
    expect(applyTimelineDuration(steps, 4, 2)).toBe(steps);
  });

  it("越界下标读时长给默认 1 秒，已钳位", () => {
    expect(timelineStepDurationMs([step(99_000)], 0)).toBe(30_000);
    expect(timelineStepDurationMs([], 3)).toBe(1000);
  });
});

describe("灯珠数与测量", () => {
  it("设备灯珠数不改变选中", () => {
    const unit = setTimelineLedCount(selectTimelineStep(createTimelineUnit(), 1, 2), 60);
    expect(unit.ledCount).toBe(60);
    expect(unit.selected).toBe(1);
  });

  it("容器宽为 0 / 非有限值时保持未测量状态", () => {
    expect(measureTimelineWidth(createTimelineUnit(), 0).containerWidth).toBe(0);
    expect(measureTimelineWidth(createTimelineUnit(), Number.NaN).containerWidth).toBe(0);
  });

  it("测到宽度后同值再测返回同一个状态（不重复重画）", () => {
    const once = measureTimelineWidth(createTimelineUnit(), 640);
    expect(once.containerWidth).toBe(640);
    expect(measureTimelineWidth(once, 640)).toBe(once);
    expect(measureTimelineWidth(once, 320).containerWidth).toBe(320);
  });
});

describe("单元不依赖页面", () => {
  const source = readFileSync(join(ROOT, "utils/control/timeline-unit.ts"), "utf8");

  it("不 import 任何页面，也不碰 wx / BLE", () => {
    expect(source).not.toMatch(/from\s+["'][^"']*pages\//);
    expect(source).not.toMatch(/\bwx\./);
    expect(source).not.toMatch(/from\s+["'][^"']*\/ble\//);
  });

  it("不 import 任何 v4 模型（剧本 / 方案草稿 / 分区）", () => {
    for (const gone of ["script-view", "advanced-draft", "plan-editor", "zone-model"]) {
      expect(source, `不应再依赖 ${gone}`).not.toContain(gone);
    }
  });

  it("页面只是它的调用方（渲染、选中与改时长都经单元）", () => {
    const page = readFileSync(join(ROOT, "pages/part/part.ts"), "utf8");
    expect(page).toContain("timelineUnitView(");
    expect(page).toContain("selectTimelineStep(");
    expect(page).toContain("applyTimelineDuration(");
  });

  it("块宽分配规则只有一份（页面不再自己调 layoutBlocks / timelineRowWidth / chooseGap）", () => {
    const page = readFileSync(join(ROOT, "pages/part/part.ts"), "utf8");
    expect(page).not.toContain("layoutBlocks(");
    expect(page).not.toContain("timelineRowWidth(");
    expect(page).not.toContain("chooseGap(");
  });
});
