/**
 * 灯珠弹窗的纯规则（进阶档 #66）。
 *
 * ## 为什么不复用 `zone-editor.dragRange`
 *
 * `dragRange` 把「点一下」解释成**单颗灯珠区间**（`tests/zone-editor.test.ts` 锁住
 * 了这个行为，自定义档的拖动划选依赖它）。分区弹窗的规则正好相反：
 *
 *  - 第一次点击只设**锚点**，此时还没有区间；
 *  - 第二次点击才确定区间，并自动取两端之间的全部灯珠（顺序颠倒也对）；
 *  - **同一颗点两次 = 取消**，绝不会产生只含一颗灯珠的分区。
 *
 * 两条规则互斥，改 `dragRange` 会弄坏旧编辑器，所以这里另写一份状态机，并把
 * 它做成纯函数单测（页面里只转发点击）。
 *
 * ## 另外两条硬规则
 *
 *  - 属于**其它分区**的格子置灰且点不动。置灰不是装饰：它让「哪里能划」一眼
 *    可见，也避免了必然被设备拒绝的重叠；
 *  - 划出的区间若仍与其它分区相交（例如跨过别人的格子），当场给出错误、
 *    **弹窗保持打开、不写草稿**。判定与提交都在这里。
 *
 * 纯函数，不碰 wx / BLE。
 */

import { MAX_LEDS, MAX_SEGMENTS } from "../protocol/constants";
import type { SegmentSpec } from "../protocol/types";
import { findConflict, type ZoneRange } from "./effect-layout";
import { addZone, removeZone } from "./zone-editor";
import { buildZoneSpec } from "./zone-model";

/** 灯珠格子的列数（12 列；100 颗时是 8 行余 4 格）。 */
export const PICKER_COLUMNS = 12;

/**
 * 弹窗的选择状态机。
 *
 * 三种形态由两个字段决定：
 *  - `anchor` 与 `cursor` 都为空 → 还没开始选；
 *  - 只有 `anchor` → 已设锚点，等第二次点击（**此时没有区间**）；
 *  - 两个都有 → 区间已确定（`cursor` 可能小于 `anchor`，取 min/max）。
 */
export interface PickerState {
  /** 正在编辑的分区槽位；`null` = 新建。 */
  segId: number | null;
  /** 第一次点击的灯珠。 */
  anchor: number | null;
  /** 第二次点击的灯珠。 */
  cursor: number | null;
}

/** 弹窗打开时的状态：新建为空选择，修改已有分区时预填它的区间。 */
export function createPickerState(
  segId: number | null,
  existing: { start: number; end: number } | null = null,
): PickerState {
  if (existing === null) {
    return { segId, anchor: null, cursor: null };
  }
  return { segId, anchor: existing.start, cursor: existing.end };
}

/** 一次点击的结果。 */
export interface PickerTapOutcome {
  state: PickerState;
  /** 点的是别的分区的格子：**点击无效**，状态不变。 */
  disabled: boolean;
  /** 同一颗点了第二次：选择被清空（不是「选中一颗」）。 */
  cancelled: boolean;
  /** 这次点击把区间定下来了（第二次点击且换了一颗）。 */
  completed: boolean;
}

/** 判断某颗灯珠归属哪个分区（`others` 必须已经排除正在编辑的那个）。 */
export function ownerOf(
  index: number,
  others: ReadonlyArray<{ segId: number; start: number; end: number }>,
): number {
  for (const zone of others) {
    if (index >= zone.start && index <= zone.end) {
      return zone.segId;
    }
  }
  return -1;
}

/** 除正在编辑的槽位以外的全部分区（弹窗判定「别人的格子」用的就是它）。 */
export function otherZones(
  zones: ReadonlyArray<{ segId: number; start: number; end: number }>,
  editingSegId: number | null,
): ZoneRange[] {
  return zones
    .filter((zone) => editingSegId === null || zone.segId !== editingSegId)
    .map((zone) => ({ segId: zone.segId, start: zone.start, end: zone.end }));
}

/** 当前区间（闭区间，自动取 min/max）；还没选满两次时返回 null。 */
export function pickerRange(state: PickerState): { start: number; end: number } | null {
  if (state.anchor === null || state.cursor === null) {
    return null;
  }
  return {
    start: Math.min(state.anchor, state.cursor),
    end: Math.max(state.anchor, state.cursor),
  };
}

/**
 * 点一颗灯珠。
 *
 * 顺序（这是本票最容易写错的一处，单测逐条锁住）：
 *  1. 越界 → 无操作；
 *  2. 属于其它分区 → `disabled`，状态不变；
 *  3. 已设锚点、还没定区间、又点了**同一颗** → 清空选择（`cancelled`）；
 *  4. 已设锚点、还没定区间 → 定下区间（`completed`，方向随便）；
 *  5. 其它情况（还没选 / 上一轮已确定）→ 这一颗成为**新锚点**，区间清空。
 */
export function pickerTap(
  state: PickerState,
  index: number,
  ctx: { ledCount: number; others: ReadonlyArray<{ segId: number; start: number; end: number }> },
): PickerTapOutcome {
  const count = Math.max(0, Math.min(MAX_LEDS, Math.floor(ctx.ledCount)));
  const noop: PickerTapOutcome = { state, disabled: false, cancelled: false, completed: false };
  if (!Number.isInteger(index) || index < 0 || index >= count) {
    return noop;
  }
  if (ownerOf(index, ctx.others) >= 0) {
    return { state, disabled: true, cancelled: false, completed: false };
  }
  if (state.anchor !== null && state.cursor === null) {
    if (state.anchor === index) {
      return {
        state: { segId: state.segId, anchor: null, cursor: null },
        disabled: false,
        cancelled: true,
        completed: false,
      };
    }
    return {
      state: { ...state, cursor: index },
      disabled: false,
      cancelled: false,
      completed: true,
    };
  }
  return {
    state: { segId: state.segId, anchor: index, cursor: null },
    disabled: false,
    cancelled: false,
    completed: false,
  };
}

/** 弹窗里的一格灯珠。 */
export interface LedPickerCell {
  /** 灯珠下标。 */
  index: number;
  /** 界面上显示的编号（1 起）。 */
  label: number;
  /** 属于其它分区：置灰且点不动。 */
  disabled: boolean;
  /** 归属的分区槽位；-1 = 未被占用（可点）。 */
  ownerSegId: number;
  /** 归属分区的颜色；可点的格子为空串（走 CSS 默认色）。 */
  ownerHex: string;
  /** 落在当前区间里。 */
  selected: boolean;
  /** 是这次点击的锚点。 */
  anchor: boolean;
  /** 是当前区间的起点（实心圆点 + 加粗数字）。 */
  start: boolean;
  /** 是当前区间的终点（空心圆环）；区间只剩一颗时为 false。 */
  end: boolean;
  /** 落在区间里、但被别的分区占着（冲突必须当场标出来）。 */
  conflict: boolean;
}

/**
 * 逐颗生成弹窗格子（一共 `ledCount` 颗，最多 100，见 #72）。
 *
 * 页面不需要自己判断「哪颗被占」：`disabled` / `conflict` 都在这里算好，
 * 渲染层只负责画。
 *
 * `start` / `end` 按**区间的两端**标注（与点击顺序无关）：反向选择时起点仍
 * 是编号小的那一颗。只剩一颗时有 `start` 而没有 `end`——一个空心环叠在实心
 * 点上只会让人误以为「区间还没结束」。
 */
export function buildPickerCells(
  state: PickerState,
  ctx: {
    ledCount: number;
    others: ReadonlyArray<{ segId: number; start: number; end: number }>;
    colors?: ReadonlyMap<number, string>;
  },
): LedPickerCell[] {
  const count = Math.max(0, Math.min(MAX_LEDS, Math.floor(ctx.ledCount)));
  const range = pickerRange(state);
  const colors = ctx.colors ?? new Map<number, string>();
  const cells: LedPickerCell[] = [];
  for (let index = 0; index < count; index += 1) {
    const ownerSegId = ownerOf(index, ctx.others);
    const selected = range !== null && index >= range.start && index <= range.end;
    cells.push({
      index,
      label: index + 1,
      disabled: ownerSegId >= 0,
      ownerSegId,
      ownerHex: ownerSegId >= 0 ? colors.get(ownerSegId) ?? "" : "",
      selected,
      anchor: index === state.anchor,
      start: range !== null && index === range.start,
      end: range !== null && index === range.end && range.end > range.start,
      conflict: selected && ownerSegId >= 0,
    });
  }
  return cells;
}

/** 弹窗当下的校验结果。 */
export interface PickerCheck {
  ok: boolean;
  /** 不可确定时的原因（就地显示在弹窗里）。 */
  message: string;
}

/** 一段连续的灯珠（闭区间，0 基）。 */
export interface FreeRun {
  start: number;
  end: number;
}

/** 灯珠数按协议上限截断（负数 / 小数 / 超限一律归一）。 */
function clampLedCount(ledCount: number): number {
  return Math.max(0, Math.min(MAX_LEDS, Math.floor(ledCount)));
}

/** 某颗灯珠能不能选：在范围内且不属于别的分区。 */
function selectable(
  led: number,
  ctx: { ledCount: number; others: ReadonlyArray<{ segId: number; start: number; end: number }> },
): boolean {
  return (
    Number.isInteger(led) &&
    led >= 0 &&
    led < clampLedCount(ctx.ledCount) &&
    ownerOf(led, ctx.others) < 0
  );
}

/**
 * 与 `anchor` 连通的那一段连续空闲灯珠（#78 的滚轮值域）。
 *
 * 从锚点向左右各走一步，**遇到属于其它分区的序号就停**——所以返回的区间里
 * 没有任何一颗会与别人重叠，滚轮因此不可能给出非法值。锚点本身被占 / 越界
 * / 没有空闲时返回 `null`。
 */
export function freeRunAround(
  anchor: number,
  ledCount: number,
  others: ReadonlyArray<{ segId: number; start: number; end: number }>,
): FreeRun | null {
  const count = clampLedCount(ledCount);
  if (!Number.isInteger(anchor) || anchor < 0 || anchor >= count) {
    return null;
  }
  if (ownerOf(anchor, others) >= 0) {
    return null;
  }
  let start = anchor;
  while (start > 0 && ownerOf(start - 1, others) < 0) {
    start -= 1;
  }
  let end = anchor;
  while (end < count - 1 && ownerOf(end + 1, others) < 0) {
    end += 1;
  }
  return { start, end };
}

/**
 * 整条灯带上**最左边**的那一段连续空闲（锚点还没定时的起点滚轮值域）。
 *
 * 用最左而不是最长的一段：用户从左边开始选是阅读顺序，而且确定性的选择比
 * 「猜哪个区间更好」更容易解释。没有空闲灯珠时返回 `null`。
 */
export function firstFreeRun(
  ledCount: number,
  others: ReadonlyArray<{ segId: number; start: number; end: number }>,
): FreeRun | null {
  const count = clampLedCount(ledCount);
  let index = 0;
  while (index < count && ownerOf(index, others) >= 0) {
    index += 1;
  }
  if (index >= count) {
    return null;
  }
  return freeRunAround(index, count, others);
}

/** 两个滚轮的候选（灯珠下标 + 显示文案）。 */
export interface PickerOptions {
  /** 起点滚轮的候选灯珠（0 基、升序）。 */
  startLeds: number[];
  /** 起点滚轮的显示文案（「第 N 颗」，1 基）。 */
  startLabels: string[];
  /** 起点滚轮回显的候选下标；`-1` = 当前起点不在候选里（见 `startText`）。 */
  startIndex: number;
  /** 起点滚轮当前显示的文案（始终是**真实**的那一端）。 */
  startText: string;
  /** 终点滚轮的候选灯珠（0 基、升序）。 */
  endLeds: number[];
  /** 终点滚轮的显示文案。 */
  endLabels: string[];
  /** 终点滚轮回显的候选下标；`-1` = 当前终点不在候选里。 */
  endIndex: number;
  /** 终点滚轮当前显示的文案。 */
  endText: string;
  /** 终点滚轮不可用（锚点还没定 / 没有空闲灯珠）。 */
  endDisabled: boolean;
  /** 锚点所在的连续空闲段；`null` = 没有可选的空闲段。 */
  run: FreeRun | null;
}

/** 闭区间展开成下标数组。 */
function expandLeds(start: number, end: number): number[] {
  const out: number[] = [];
  for (let index = start; index <= end; index += 1) {
    out.push(index);
  }
  return out;
}

/** 0 基灯珠下标 → 「第 N 颗」；界面从 1 起算。 */
export function ledOptionLabel(led: number): string {
  return `第 ${led + 1} 颗`;
}

/**
 * 两个数字滚轮的值域（#78）。
 *
 * 硬约束：候选**只**来自与锚点连通的连续空闲段——
 *  - 起点滚轮 = 「空闲段左端 → 锚点」；
 *  - 终点滚轮 = 「锚点 → 空闲段右端」；
 *  - 锚点未定：起点滚轮给出整段空闲（最左的一段），终点滚轮禁用。
 *
 * 被别的分区占着的序号根本不出现在候选里，所以用户选不出非法区间。
 *
 * 回显（`startText` / `endText`）用的是**真实**的当前端点，不是候选里的第一个：
 * 用户点格子跨过别人的分区时，那一端本就不在合法候选里，滚轮必须如实显示它
 * （同时确定按钮是灰的、错误也在弹窗里），而不是假装用户选了别处。
 */
export function pickerOptions(
  state: PickerState,
  ctx: { ledCount: number; others: ReadonlyArray<{ segId: number; start: number; end: number }> },
): PickerOptions {
  /* 「锚点」在这里指**区间的起点**（`range.start`），不是 `state.anchor`：
   * 反向点选（先点 9 再点 3）时 anchor 在高处，但起点滚轮必须从 3 往前给。 */
  const range = pickerRange(state);
  const startLed = range === null ? state.anchor : range.start;
  const endLed = range === null ? null : range.end;
  const run =
    startLed === null
      ? firstFreeRun(ctx.ledCount, ctx.others)
      : freeRunAround(startLed, ctx.ledCount, ctx.others);
  if (run === null) {
    return {
      startLeds: [],
      startLabels: [],
      startIndex: -1,
      startText: startLed === null ? "" : ledOptionLabel(startLed),
      endLeds: [],
      endLabels: [],
      endIndex: -1,
      endText: endLed === null ? "" : ledOptionLabel(endLed),
      endDisabled: true,
      run: null,
    };
  }
  const startLeds = expandLeds(run.start, startLed === null ? run.end : startLed);
  /* 终点滚轮 = 「起点 → 空闲段右端」；锚点未定时没有可用区间。 */
  const endLeds = startLed === null ? [] : expandLeds(startLed, run.end);
  const startLabels = startLeds.map(ledOptionLabel);
  const endLabels = endLeds.map(ledOptionLabel);
  const startIndex = startLed === null ? 0 : Math.max(0, startLeds.indexOf(startLed));
  const endIndex = endLed === null ? 0 : Math.max(0, endLeds.indexOf(endLed));
  return {
    startLeds,
    startLabels,
    startIndex,
    startText: startLed === null ? startLabels[startIndex] ?? "" : ledOptionLabel(startLed),
    endLeds,
    endLabels,
    endIndex,
    endText: endLed === null ? endLabels[endIndex] ?? "" : ledOptionLabel(endLed),
    endDisabled: startLed === null,
    run,
  };
}

/** 滚轮下标 → 灯珠下标；越界返回 -1（调用方据此忽略这次事件）。 */
export function pickerOptionLed(leds: readonly number[], option: number): number {
  if (!Number.isInteger(option) || option < 0 || option >= leds.length) {
    return -1;
  }
  return leds[option];
}

/**
 * 用起点滚轮设起点（#78）。
 *
 * 只改**起点这一端**：已选的终点原样保留，所以「先选终点再改起点」不会把
 * 终点拉回锚点。还没有区间时，锚点就是另一端：刚打开时两端都落在这一颗
 * （网格只剩一颗、确定仍不可用——与「同一颗点两次」同一条规则）。
 *
 * 落在别人的格子上 / 越界 → 状态不变（滚轮值域里本来也不会有它）。
 */
export function applyPickerStart(
  state: PickerState,
  led: number,
  ctx: { ledCount: number; others: ReadonlyArray<{ segId: number; start: number; end: number }> },
): PickerState {
  if (!selectable(led, ctx)) {
    return state;
  }
  const range = pickerRange(state);
  const cursor = range === null ? state.anchor ?? led : range.end;
  return { segId: state.segId, anchor: led, cursor };
}

/**
 * 用终点滚轮设终点（#78）。
 *
 * 锚点未定时终点滚轮是禁用的：直接返回原状态。起点原样保留（反向选择过的
 * 区间先归一成「起点 → 终点」，再只动终点）。
 */
export function applyPickerEnd(
  state: PickerState,
  led: number,
  ctx: { ledCount: number; others: ReadonlyArray<{ segId: number; start: number; end: number }> },
): PickerState {
  if (state.anchor === null || !selectable(led, ctx)) {
    return state;
  }
  const range = pickerRange(state);
  const anchor = range === null ? state.anchor : range.start;
  return { segId: state.segId, anchor, cursor: led };
}

/** 「确定」是否可用（与 `pickerCheck` 同一条判定，页面只读这个布尔值）。 */
export function pickerCanConfirm(
  state: PickerState,
  ctx: {
    ledCount: number;
    others: ReadonlyArray<{ segId: number; start: number; end: number }>;
    zoneCount: number;
  },
): boolean {
  return pickerCheck(state, ctx).ok;
}

/**
 * 当前选择能否确定。
 *
 * 检查顺序按用户最常遇到的先后来：没有区间 → 区间太短 → 与别人重叠 →
 * 分区数满。**新建**的单灯珠区间被显式拒绝：它是「同一颗点两次」本该拦下的
 * 形状，从别的入口进来（例如直接调用）也不能产生。
 */
export function pickerCheck(
  state: PickerState,
  ctx: {
    ledCount: number;
    others: ReadonlyArray<{ segId: number; start: number; end: number }>;
    zoneCount: number;
  },
): PickerCheck {
  const range = pickerRange(state);
  if (range === null) {
    return { ok: false, message: "先点一颗灯珠做起点，再点另一颗确定范围" };
  }
  if (state.segId === null && range.end === range.start) {
    return { ok: false, message: "同一颗灯珠点两次是取消，一个分区至少要两颗" };
  }
  const conflict = findConflict(range, ctx.others);
  if (conflict !== null) {
    return {
      ok: false,
      message: `与分区 ${conflict.segId + 1}（${conflict.start}–${conflict.end}）重叠，同一灯组的分区不能重叠`,
    };
  }
  if (state.segId === null && ctx.zoneCount >= MAX_SEGMENTS) {
    return { ok: false, message: `每组最多 ${MAX_SEGMENTS} 个分区，请先删掉一个` };
  }
  const count = Math.max(0, Math.min(MAX_LEDS, Math.floor(ctx.ledCount)));
  if (range.end > count - 1) {
    return { ok: false, message: `灯珠只到第 ${count} 颗，范围超出了这一组` };
  }
  return { ok: true, message: "" };
}

/** 「0–9（10 颗）」；还没选满两次时给引导语。 */
export function pickerRangeText(state: PickerState): string {
  const range = pickerRange(state);
  if (range === null) {
    return state.anchor === null
      ? "点一颗灯珠做起点"
      : `起点是第 ${state.anchor + 1} 颗，再点一颗确定范围`;
  }
  const count = range.end - range.start + 1;
  return `第 ${range.start + 1}–${range.end + 1} 颗 · 共 ${count} 颗`;
}

/** 弹窗提交的结果。 */
export interface PickerCommit {
  /** 新的分区列表；没改动时是**同一个数组引用**（页面据此不刷新）。 */
  zones: SegmentSpec[];
  /** 失败原因；空串表示成功。 */
  error: string;
  /** 是否真的改了东西（改到同一区间不算）。 */
  changed: boolean;
}

/**
 * 确定：把选择写进分区列表。
 *
 * 失败时返回**原数组**与原因——调用方保留弹窗、不落草稿。修改已有分区时只改
 * 区间，主效果 / 叠加层 / 叠加方式一字不动（`buildZoneSpec` 负责深拷贝）。
 */
export function commitPicker(
  state: PickerState,
  zones: readonly SegmentSpec[],
  stripId: number,
  ledCount: number,
): PickerCommit {
  const ranges = zones.map((zone) => ({
    segId: zone.segId,
    start: zone.start,
    end: zone.end,
  }));
  const others = otherZones(ranges, state.segId);
  const check = pickerCheck(state, { ledCount, others, zoneCount: zones.length });
  if (!check.ok) {
    return { zones: zones as SegmentSpec[], error: check.message, changed: false };
  }
  const range = pickerRange(state)!;

  if (state.segId === null) {
    const added = addZone(zones, stripId, range.start, range.end);
    if (added === null) {
      return { zones: zones as SegmentSpec[], error: "没能加进这个范围，请重选", changed: false };
    }
    return { zones: [...zones, added], error: "", changed: true };
  }

  const target = zones.find((zone) => zone.segId === state.segId);
  if (target === undefined) {
    return { zones: zones as SegmentSpec[], error: "这个分区已经不在了", changed: false };
  }
  if (target.start === range.start && target.end === range.end) {
    return { zones: zones as SegmentSpec[], error: "", changed: false };
  }
  const resized = buildZoneSpec({
    stripId: target.stripId,
    segId: target.segId,
    start: range.start,
    end: range.end,
    blend: target.blend,
    layer0: target.layer0,
    layer1: target.layer1,
  });
  return {
    zones: zones.map((zone) => (zone.segId === state.segId ? resized : zone)),
    error: "",
    changed: true,
  };
}

/** 删除正在编辑的分区（新建状态下没有可删的东西）。 */
export function deletePickerZone(
  zones: readonly SegmentSpec[],
  segId: number | null,
): SegmentSpec[] {
  if (segId === null) {
    return zones as SegmentSpec[];
  }
  return removeZone(zones, segId);
}
