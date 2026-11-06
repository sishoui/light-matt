/**
 * 时间轴单元（#154）：把「步骤时间轴」从灯组详情页里抽出来。
 *
 * ## 为什么要单独一层
 *
 * 时间轴手里有**一份交互状态**：选中哪一步、窗口宽多少、有没有在长按拖动、
 * 被拖的是哪一块、落点在哪、跟手位移多少、手指的零点在哪。以前这些是灯组页的
 * 十几个私有字段，散在 `onStepTap` / `onStepTouchStart` / `onStepTouchMove` /
 * `onStepTouchEnd` / `onStepTouchCancel` 之间；部位编辑器要复用同一条时间轴时，
 * 只能把那一堆字段再抄一份，或者继续往同一个三千行的文件里加代码。
 *
 * 现在状态收进一个普通对象（`TimelineUnit`），所有变更都是纯函数：给旧状态、
 * 返回新状态。于是「给定一组步骤 → 渲染 / 选中 / 长按重排 / 改时长」可以在
 * Node 里直接驱动，不需要页面、不需要 `wx`、不需要设备。
 *
 * ## 为什么几何计算仍然在 `timeline.ts`
 *
 * 宽度分配、落点命中、跟手位移是**纯几何**（水位法、屏幕矩形），已经有一整套
 * 单测。这一层只做两件事：
 *
 *  1. 状态机：按下 → 长按到点 → 拖动 → 松手（含代次作废，防「幽灵拖动」）；
 *  2. 派生：把状态与步骤一起交给 `layoutBlocks`，得到可以直接渲染的块。
 *
 * 所以这里不含任何一条新的几何规则，也不复算页面已经算过的东西。
 *
 * 纯函数、不碰 wx / BLE / 页面。
 */

import {
  COMPACT_BLOCK_GAP_PX,
  DEFAULT_STEP_MS,
  MAX_STEPS,
  MIN_BLOCK_PX,
  chooseGap,
  clampDuration,
  clampSelected,
  layoutBlocks,
  setStepDuration,
  timelineRowWidth,
  type DragTarget,
  type TimelineBlockView,
  type TimelineStep,
} from "./timeline";

/** 一次长按拖动的进行态。 */
export interface TimelineDragState {
  /** 被拖的源下标；-1 = 没有拖动。 */
  from: number;
  /** 落点下标；-1 = 没在拖。 */
  to: number;
  /** 被拖块「跟手指走」的横向位移（px），由 `dragFollowOffset` 算出。 */
  follow: number;
  /** 进入拖动那一刻的指尖横坐标；`follow` 的零点。 */
  startX: number;
  /** 这一次触摸是否已经拖出时间轴（出界松手 = 取消）。 */
  outside: boolean;
  /**
   * 触摸代次：按下 / 抬起 / 取消都会自增。
   *
   * 长按进入拖动前要先异步量块矩形；代次变了说明这次触摸已经结束，回调不能
   * 再挂拖动状态（否则会留下一个「幽灵拖动」，下次移动凭空拖起一块）。
   */
  epoch: number;
}

/** 时间轴的全部交互状态。 */
export interface TimelineUnit {
  /** 选中步骤的下标（0 起）。 */
  selected: number;
  /** 时间轴行的真实宽度（px）；0 = 还没测到。 */
  containerWidth: number;
  /** 是否问过渲染层（即使量回来是 0，也不必每次都问）。 */
  measured: boolean;
  /** 当前灯组的灯珠数（画缩略色带用）。 */
  ledCount: number;
  drag: TimelineDragState;
}

/** 时间轴的一段状态 + 按当前步骤集派生出的块。 */
export interface TimelineUnitView {
  blocks: TimelineBlockView[];
  stepCount: number;
  selected: number;
  /** 全部步骤的时长之和（毫秒）。 */
  totalMs: number;
  /** 块间隙（px）；未测量时为 `undefined`（交给 CSS 最小宽度兜底）。 */
  gapPx: number | undefined;
  /** 用上了收紧的间隙（与 wxss 的 `.timeline-row.compact` 对应）。 */
  compact: boolean;
  /** 还能不能再加一步（8 步上限）。 */
  canAdd: boolean;
}

/** 空的时间轴状态（没有选中、没有测量、没有拖动）。 */
export function createTimelineUnit(init: Partial<Pick<TimelineUnit, "selected" | "ledCount">> = {}): TimelineUnit {
  return {
    selected: Number.isInteger(init.selected) ? Math.max(0, init.selected as number) : 0,
    containerWidth: 0,
    measured: false,
    ledCount: Number.isFinite(init.ledCount) ? Math.max(0, init.ledCount as number) : 0,
    drag: { from: -1, to: -1, follow: 0, startX: 0, outside: false, epoch: 0 },
  };
}

/* ---------------- 派生：步骤集 → 可渲染的块 ---------------- */

/**
 * 步骤集 + 状态 → 时间轴的完整视图（`layoutBlocks` 的唯一调用点）。
 *
 * 容器宽没量到之前不能算像素（会把首帧算成每个块几像素），退回时长权重 +
 * CSS 最小宽度；量到之后行宽恒等于容器宽，块宽在容器内部按比例 / 最小宽度
 * 分配——任何步骤数都不出容器，页面不滚动（#76）。
 */
export function timelineUnitView(
  steps: readonly TimelineStep[],
  unit: TimelineUnit,
): TimelineUnitView {
  const measured = unit.containerWidth > 0;
  const durations = steps.map((step) => clampDuration(step.durationMs));
  const rowWidth = timelineRowWidth(durations, unit.containerWidth);
  /* 8px 间隙放不下最小块宽时收紧到 4px（`layoutBlocks` 也按同一规则兜底）。 */
  const gapPx = measured ? chooseGap(steps.length, rowWidth, MIN_BLOCK_PX) : undefined;
  const dragging = unit.drag.from >= 0;
  const blocks = layoutBlocks(steps, {
    widthPx: measured ? rowWidth : 0,
    ...(gapPx === undefined ? {} : { gapPx }),
    selected: clampSelected(unit.selected, steps.length),
    dragIndex: dragging ? unit.drag.from : -1,
    dropIndex: dragging ? unit.drag.to : -1,
    followPx: dragging ? unit.drag.follow : 0,
    ledCount: unit.ledCount,
  });
  return {
    blocks,
    stepCount: steps.length,
    selected: clampSelected(unit.selected, steps.length),
    totalMs: durations.reduce((sum, ms) => sum + ms, 0),
    gapPx,
    compact: gapPx === COMPACT_BLOCK_GAP_PX,
    canAdd: steps.length < MAX_STEPS,
  };
}

/* ---------------- 选中 ---------------- */

/** 选中某一步；越界或已经选中同一块时返回同一个状态（不产生多余刷新）。 */
export function selectTimelineStep(
  unit: TimelineUnit,
  index: number,
  count: number,
): TimelineUnit {
  if (!Number.isInteger(index) || index < 0 || index >= count) {
    return unit;
  }
  if (index === unit.selected) {
    return unit;
  }
  return { ...unit, selected: index };
}

/**
 * 步骤变少（删步骤 / 换方案 / 草稿重读）后把选中下标钳住。
 *
 * 不钳会让选中指向不存在的步骤：气泡不出现、时长条改的是空气。
 */
export function clampTimelineSelection(unit: TimelineUnit, count: number): TimelineUnit {
  const selected = clampSelected(unit.selected, count);
  if (selected === unit.selected) {
    return unit;
  }
  return { ...unit, selected };
}

/* ---------------- 长按拖动 ---------------- */

/** 这一次按下是否该起长按定时器（下标非法时不起）。 */
export interface TimelinePress {
  unit: TimelineUnit;
  /** 本次触摸的代次；长按到点后用它换拖动资格。 */
  epoch: number;
  /** 是否该起定时器。 */
  pending: boolean;
}

/**
 * 手指按下：记住起点、自增代次并给出新代次。
 *
 * 定时器到点才进入拖动状态——直接按下变拖动会与「点一下选中」抢事件，用户
 * 也没法「先看一眼再点」。300 毫秒（`LONG_PRESS_MS`，#82）。
 */
export function pressTimelineStep(
  unit: TimelineUnit,
  index: number,
  clientX: number,
  count: number,
): TimelinePress {
  if (!Number.isInteger(index) || index < 0 || index >= count) {
    return { unit, epoch: unit.drag.epoch, pending: false };
  }
  const epoch = unit.drag.epoch + 1;
  const startX = Number.isFinite(clientX) ? clientX : 0;
  return {
    unit: { ...unit, drag: { ...unit.drag, epoch, startX } },
    epoch,
    pending: true,
  };
}

/** 这次触摸是否还是「当前」的那一次（长按回调据此作废迟到的自己）。 */
export function isTimelinePressCurrent(unit: TimelineUnit, epoch: number): boolean {
  return unit.drag.epoch === epoch;
}

/**
 * 还没长按到点时手指在动：跟着挪「跟手位移的零点」。
 *
 * 于是块抬起的那一刻位移正好是 0，不会先跳一下。已经在拖动时不动这个零点
 * （否则跟手位移会突然缩水）。
 */
export function trackTimelinePress(unit: TimelineUnit, clientX: number): TimelineUnit {
  if (unit.drag.from >= 0) {
    return unit;
  }
  if (!Number.isFinite(clientX) || clientX === unit.drag.startX) {
    return unit;
  }
  return { ...unit, drag: { ...unit.drag, startX: clientX } };
}

/**
 * 长按到点：进入拖动状态，并选中被拖的块。
 *
 * 代次过期（手指已经抬起）时原样返回——绝不能留下幽灵拖动。
 *
 * 块矩形不在这里：它只能用渲染层的选择器查询去量，属于调用方。量的时候必须
 * **没有 transform**（被拖块的 1.06 放大也会进矩形，命中范围就偏了），所以
 * 顺序是「先量、再进拖动」。
 */
export function startTimelineDrag(
  unit: TimelineUnit,
  index: number,
  epoch: number,
): TimelineUnit {
  if (!isTimelinePressCurrent(unit, epoch)) {
    return unit;
  }
  if (!Number.isInteger(index) || index < 0) {
    return unit;
  }
  return {
    ...unit,
    selected: index,
    drag: { ...unit.drag, from: index, to: index, follow: 0, outside: false },
  };
}

/**
 * 拖动中：把「跟手位移 + 落点」记进状态。
 *
 * 位移与落点由调用方从纯函数（`dragFollowOffset` / `dragTargetAtRects`）拿来，
 * 这里只做状态搬运与去抖：四舍五入到 0.5px、落点与出界都没变时**返回同一个
 * 状态**（`touchmove` 每秒几十次，不必要一次重画）。
 *
 * 拖出时间轴时落点回到源下标：不给让位预览，松手后原地回弹。
 */
export function applyTimelineDrag(
  unit: TimelineUnit,
  followPx: number,
  target: DragTarget,
): TimelineUnit {
  const drag = unit.drag;
  if (drag.from < 0) {
    return unit;
  }
  const follow = Number.isFinite(followPx) ? followPx : 0;
  const to = target.outside || target.index < 0 ? drag.from : target.index;
  const changed =
    Math.round(follow * 2) !== Math.round(drag.follow * 2) ||
    to !== drag.to ||
    target.outside !== drag.outside;
  if (!changed) {
    return unit;
  }
  return { ...unit, drag: { ...drag, follow, to, outside: target.outside } };
}

/** 正在拖动（手指已长按到点并抬起一块）。 */
export function isTimelineDragging(unit: TimelineUnit): boolean {
  return unit.drag.from >= 0;
}

/**
 * 清空拖动状态（抬指 / 取消 / 页面隐藏都走这里）。
 *
 * 同时自增代次——还在路上的「长按 → 量矩形 → 挂拖动」回调据此作废。
 */
export function cancelTimelineDrag(unit: TimelineUnit): TimelineUnit {
  return {
    ...unit,
    drag: { ...unit.drag, epoch: unit.drag.epoch + 1, from: -1, to: -1, follow: 0, outside: false },
  };
}

/** 拖动结束的结果：清空后的状态 + 这次拖动指向哪。 */
export interface TimelineDragEnd {
  unit: TimelineUnit;
  /** 这一次触摸是否进入过拖动（没长按到点 = 只是按住了一下）。 */
  dragged: boolean;
  from: number;
  to: number;
  outside: boolean;
}

/** 只读：这次拖动指向哪（清状态交给 `cancelTimelineDrag`）。 */
export function readTimelineDrag(unit: TimelineUnit): Omit<TimelineDragEnd, "unit"> {
  return {
    dragged: unit.drag.from >= 0,
    from: unit.drag.from,
    to: unit.drag.to,
    outside: unit.drag.outside,
  };
}

/**
 * 手指抬起：一次给出「这次拖动指向哪」并清空拖动状态。
 *
 * 这里**不提交顺序**——重排要落到调用方自己的模型上（页面是草稿），规则仍在
 * `moveStepStage` / `selectionAfterMove`。单元只回答「指向哪」。
 */
export function endTimelineDrag(unit: TimelineUnit): TimelineDragEnd {
  return { unit: cancelTimelineDrag(unit), ...readTimelineDrag(unit) };
}

/** 回到第 1 步（换方案 / 断开设备 / 草稿重读后）。 */
export function resetTimelineSelection(unit: TimelineUnit): TimelineUnit {
  return unit.selected === 0 ? unit : { ...unit, selected: 0 };
}

/* ---------------- 测量与灯珠数 ---------------- */

/**
 * 记下时间轴行的真实宽度。
 *
 * 宽度 <= 0 / 非有限值（容器还不在 DOM 里）时只标记「问过了」，不改宽度——
 * 继续按未测量处理，首帧不会算成每个块几像素。
 */
export function measureTimelineWidth(unit: TimelineUnit, widthPx: number): TimelineUnit {
  const width = Number.isFinite(widthPx) ? Math.round(widthPx) : 0;
  if (width <= 0) {
    return unit.measured ? unit : { ...unit, measured: true };
  }
  if (unit.measured && width === unit.containerWidth) {
    return unit;
  }
  return { ...unit, measured: true, containerWidth: width };
}

/** 容器消失（离开进阶档）时退回未测量，下次进来会重新量。 */
export function forgetTimelineWidth(unit: TimelineUnit): TimelineUnit {
  if (!unit.measured && unit.containerWidth === 0) {
    return unit;
  }
  return { ...unit, measured: false, containerWidth: 0 };
}

/** 换一条灯组 / 灯珠数变了：缩略色带按新的颗数换算。 */
export function setTimelineLedCount(unit: TimelineUnit, ledCount: number): TimelineUnit {
  const next = Number.isFinite(ledCount) ? Math.max(0, Math.round(ledCount)) : 0;
  if (next === unit.ledCount) {
    return unit;
  }
  return { ...unit, ledCount: next };
}

/* ---------------- 改时长 ---------------- */

/**
 * 改某一步的时长（毫秒）。
 *
 * 钳位与「下标越界无操作（返回同一个数组）」交给 `setStepDuration`；这一层只
 * 补一条它没有的语义：**非有限值当没说**。`clampDuration` 把 NaN 当成默认
 * 1 秒，那样一次半截的滑块事件就会把用户的 3 秒改回 1 秒——宁可不动。
 */
export function setTimelineDuration(
  steps: readonly TimelineStep[],
  index: number,
  durationMs: number,
): TimelineStep[] {
  if (!Number.isFinite(durationMs)) {
    return steps as TimelineStep[];
  }
  return setStepDuration(steps, index, durationMs);
}

/**
 * 时长条的值（秒）→ 目标步骤的新列表。
 *
 * 页面的时长条给的是**秒**（滑块 0.1–60 秒），模型里存的是**毫秒**，所以
 * 「秒 → 毫秒」这一步留在这里，别让页面自己写一遍 `seconds * 1000`。
 *
 * 三条规则只在这一份里：非有限值不动、钳到协议区间（100ms–60s）、没变化
 * 返回原数组（引用相等 = 什么都不用刷新）。真机滑块可能给出 0.4999 这种值。
 */
export function applyTimelineDuration(
  steps: readonly TimelineStep[],
  stepIndex: number,
  seconds: number,
): TimelineStep[] {
  if (!Number.isFinite(seconds)) {
    return steps as TimelineStep[];
  }
  return setTimelineDuration(steps, stepIndex, seconds * 1000);
}

/** 某一步当前的时长（毫秒，已钳位）；越界下标给默认 1 秒。 */
export function timelineStepDurationMs(
  steps: readonly TimelineStep[],
  stepIndex: number,
): number {
  const step = steps[stepIndex];
  return step === undefined ? DEFAULT_STEP_MS : clampDuration(step.durationMs);
}
