/**
 * 灯珠弹窗的纯规则（进阶档 #66）。
 *
 * ## 为什么不复用 `zone-editor.dragRange`
 *
 * `dragRange` 把「点一下」解释成**单颗灯珠区间**（`tests/zone-editor.test.ts` 锁住
 * 了这个行为，自定义档的拖动划选依赖它）。光区弹窗的规则正好相反：
 *
 *  - 第一次点击只设**锚点**，此时还没有区间；
 *  - 第二次点击才确定区间，并自动取两端之间的全部灯珠（顺序颠倒也对）；
 *  - **同一颗点两次 = 取消**，绝不会产生只含一颗灯珠的光区。
 *
 * 两条规则互斥，改 `dragRange` 会弄坏旧编辑器，所以这里另写一份状态机，并把
 * 它做成纯函数单测（页面里只转发点击）。
 *
 * ## 另外两条硬规则
 *
 *  - 属于**其它光区**的格子置灰且点不动。置灰不是装饰：它让「哪里能划」一眼
 *    可见，也避免了必然被设备拒绝的重叠；
 *  - 划出的区间若仍与其它光区相交（例如跨过别人的格子），当场给出错误、
 *    **弹窗保持打开、不写草稿**。判定与提交都在这里。
 *
 * 纯函数，不碰 wx / BLE。
 */

import { MAX_LEDS, MAX_SEGMENTS } from "../protocol/constants";
import type { SegmentSpec } from "../protocol/types";
import { findConflict, type ZoneRange } from "./effect-layout";
import { addZone, removeZone } from "./zone-editor";
import { buildZoneSpec } from "./zone-model";

/** 灯珠格子的列数（12 列；64 颗时是 6 行）。 */
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
  /** 正在编辑的光区槽位；`null` = 新建。 */
  segId: number | null;
  /** 第一次点击的灯珠。 */
  anchor: number | null;
  /** 第二次点击的灯珠。 */
  cursor: number | null;
}

/** 弹窗打开时的状态：新建为空选择，修改已有光区时预填它的区间。 */
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
  /** 点的是别的光区的格子：**点击无效**，状态不变。 */
  disabled: boolean;
  /** 同一颗点了第二次：选择被清空（不是「选中一颗」）。 */
  cancelled: boolean;
  /** 这次点击把区间定下来了（第二次点击且换了一颗）。 */
  completed: boolean;
}

/** 判断某颗灯珠归属哪个光区（`others` 必须已经排除正在编辑的那个）。 */
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

/** 除正在编辑的槽位以外的全部光区（弹窗判定「别人的格子」用的就是它）。 */
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
 *  2. 属于其它光区 → `disabled`，状态不变；
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
  /** 属于其它光区：置灰且点不动。 */
  disabled: boolean;
  /** 归属的光区槽位；-1 = 未被占用（可点）。 */
  ownerSegId: number;
  /** 归属光区的颜色；可点的格子为空串（走 CSS 默认色）。 */
  ownerHex: string;
  /** 落在当前区间里。 */
  selected: boolean;
  /** 是这次点击的锚点。 */
  anchor: boolean;
  /** 落在区间里、但被别的光区占着（冲突必须当场标出来）。 */
  conflict: boolean;
}

/**
 * 逐颗生成弹窗格子（一共 `ledCount` 颗，最多 64）。
 *
 * 页面不需要自己判断「哪颗被占」：`disabled` / `conflict` 都在这里算好，
 * 渲染层只负责画。
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

/**
 * 当前选择能否确定。
 *
 * 检查顺序按用户最常遇到的先后来：没有区间 → 区间太短 → 与别人重叠 →
 * 光区数满。**新建**的单灯珠区间被显式拒绝：它是「同一颗点两次」本该拦下的
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
    return { ok: false, message: "同一颗灯珠点两次是取消，一个光区至少要两颗" };
  }
  const conflict = findConflict(range, ctx.others);
  if (conflict !== null) {
    return {
      ok: false,
      message: `与光区 ${conflict.segId + 1}（${conflict.start}–${conflict.end}）重叠，同一灯组的光区不能重叠`,
    };
  }
  if (state.segId === null && ctx.zoneCount >= MAX_SEGMENTS) {
    return { ok: false, message: `每组最多 ${MAX_SEGMENTS} 个光区，请先删掉一个` };
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
  /** 新的光区列表；没改动时是**同一个数组引用**（页面据此不刷新）。 */
  zones: SegmentSpec[];
  /** 失败原因；空串表示成功。 */
  error: string;
  /** 是否真的改了东西（改到同一区间不算）。 */
  changed: boolean;
}

/**
 * 确定：把选择写进光区列表。
 *
 * 失败时返回**原数组**与原因——调用方保留弹窗、不落草稿。修改已有光区时只改
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
    return { zones: zones as SegmentSpec[], error: "这个光区已经不在了", changed: false };
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

/** 删除正在编辑的光区（新建状态下没有可删的东西）。 */
export function deletePickerZone(
  zones: readonly SegmentSpec[],
  segId: number | null,
): SegmentSpec[] {
  if (segId === null) {
    return zones as SegmentSpec[];
  }
  return removeZone(zones, segId);
}
