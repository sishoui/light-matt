/**
 * 灯珠弹窗的纯规则（#66）。
 *
 * 这里锁的是四条「不写单测就只能靠模拟器点」的规则：
 *  1. 第一次点只设锚点、第二次才定区间（顺序颠倒也对）；
 *  2. 同一颗点两次 = 取消，**绝不产生单灯珠光区**；
 *  3. 属于其它光区的格子点不动；
 *  4. 与其它光区重叠时当场报错、不落草稿。
 *
 * 另有一条元规则：`zone-editor.dragRange` 被 `zone-editor.test.ts` 锁住
 * （点一下给单颗区间），本模块**不得**改它——所以规则在这里另写一份。
 */

import { describe, expect, it } from "vitest";
import { MAX_LEDS } from "../utils/protocol/constants";
import { BLEND, SEGMENT_TYPE } from "../utils/protocol/constants";
import { buildZoneSpec } from "../utils/control/zone-model";
import { dragRange } from "../utils/control/zone-editor";
import {
  buildPickerCells,
  commitPicker,
  createPickerState,
  deletePickerZone,
  otherZones,
  ownerOf,
  PICKER_COLUMNS,
  pickerCheck,
  pickerRange,
  pickerRangeText,
  pickerTap,
  type PickerState,
} from "../utils/control/led-picker";
import type { SegmentSpec } from "../utils/protocol/types";

function zone(stripId: number, segId: number, start: number, end: number): SegmentSpec {
  return buildZoneSpec({
    stripId,
    segId,
    start,
    end,
    blend: BLEND.OVER,
    layer0: { type: SEGMENT_TYPE.STATIC, hue: 1234, sat: 255, periodMs: 0, p5: 0, flags: 0, level: 100 },
    layer1: null,
  });
}

/** 点一串灯珠，返回最终状态（默认 30 颗、没有别的光区）。 */
function tapAll(
  state: PickerState,
  indexes: number[],
  ctx: { ledCount?: number; others?: Array<{ segId: number; start: number; end: number }> } = {},
): PickerState {
  const context = { ledCount: ctx.ledCount ?? 30, others: ctx.others ?? [] };
  return indexes.reduce((acc, index) => pickerTap(acc, index, context).state, state);
}

describe("弹窗打开时的状态", () => {
  it("新建：锚点与光标都为空（第一次点之前没有区间）", () => {
    const state = createPickerState(null);
    expect(state).toEqual({ segId: null, anchor: null, cursor: null });
    expect(pickerRange(state)).toBeNull();
  });

  it("改已有光区：预填它的区间（打开就能看见原来划的是哪一段）", () => {
    const state = createPickerState(1, { start: 5, end: 12 });
    expect(state.segId).toBe(1);
    expect(pickerRange(state)).toEqual({ start: 5, end: 12 });
  });

  it("列数是 12（100 颗时 8 行余 4 格）", () => {
    expect(PICKER_COLUMNS).toBe(12);
    expect(MAX_LEDS % PICKER_COLUMNS).toBe(4);
  });
});

describe("第一次点只设锚点", () => {
  it("点一颗：anchor 有值、cursor 仍为空、**还没有区间**", () => {
    const outcome = pickerTap(createPickerState(null), 7, { ledCount: 30, others: [] });
    expect(outcome.state.anchor).toBe(7);
    expect(outcome.state.cursor).toBeNull();
    expect(outcome.completed).toBe(false);
    expect(pickerRange(outcome.state)).toBeNull();
  });
});

describe("第二次点定区间", () => {
  it("从左往右：3 → 9", () => {
    const state = tapAll(createPickerState(null), [3, 9]);
    expect(pickerRange(state)).toEqual({ start: 3, end: 9 });
  });

  it("从右往左：9 → 3 得到同一个区间（自动取 min/max）", () => {
    const state = tapAll(createPickerState(null), [9, 3]);
    expect(pickerRange(state)).toEqual({ start: 3, end: 9 });
  });

  it("第二次点把 completed 置为 true（页面据此知道区间已定）", () => {
    const first = pickerTap(createPickerState(null), 3, { ledCount: 30, others: [] });
    const second = pickerTap(first.state, 9, { ledCount: 30, others: [] });
    expect(second.completed).toBe(true);
    expect(second.cancelled).toBe(false);
  });

  it("第三次点重新开始（上一轮已定的区间被清掉，避免越点越大）", () => {
    const state = tapAll(createPickerState(null), [3, 9, 20]);
    expect(state.anchor).toBe(20);
    expect(state.cursor).toBeNull();
    expect(pickerRange(state)).toBeNull();
  });
});

describe("同一颗点两次 = 取消", () => {
  it("点同一颗：取消、回到空选择，**没有区间**", () => {
    const first = pickerTap(createPickerState(null), 4, { ledCount: 30, others: [] });
    const second = pickerTap(first.state, 4, { ledCount: 30, others: [] });
    expect(second.cancelled).toBe(true);
    expect(second.state.anchor).toBeNull();
    expect(second.state.cursor).toBeNull();
    expect(pickerRange(second.state)).toBeNull();
  });

  it("取消之后再点一次 → 只设锚点（又回到「等第二颗」）", () => {
    const state = tapAll(createPickerState(null), [4, 4, 4]);
    expect(state.anchor).toBe(4);
    expect(state.cursor).toBeNull();
  });

  it("单灯珠选择过不了校验（新建时拒绝只含一颗的光区）", () => {
    /* 绕过点击直接构造一个单颗区间：从别的入口进来也必须被拦下。 */
    const forced: PickerState = { segId: null, anchor: 5, cursor: 5 };
    const check = pickerCheck(forced, { ledCount: 30, others: [], zoneCount: 0 });
    expect(check.ok).toBe(false);
    expect(check.message).toContain("同一颗");
  });

  it("单颗区间也**不会**被 commit 进去", () => {
    const forced: PickerState = { segId: null, anchor: 5, cursor: 5 };
    const result = commitPicker(forced, [], 0, 30);
    expect(result.changed).toBe(false);
    expect(result.zones).toEqual([]);
    expect(result.error).not.toBe("");
  });

  it("与 `dragRange` 的旧语义互不干扰（那个锁在 zone-editor.test.ts）", () => {
    /* 旧编辑器：点一下 = 单颗区间。本模块：点一下 = 没有区间。 */
    expect(dragRange({ anchor: 4, cursor: 4 })).toEqual({ start: 4, end: 4 });
    expect(pickerRange({ segId: null, anchor: 4, cursor: null })).toBeNull();
  });
});

describe("属于其它光区的格子点不动", () => {
  const others = [{ segId: 1, start: 10, end: 19 }];

  it("点在别人的格子上：disabled、状态一点不变", () => {
    const start = createPickerState(null);
    const outcome = pickerTap(start, 12, { ledCount: 30, others });
    expect(outcome.disabled).toBe(true);
    expect(outcome.state).toBe(start);
  });

  it("先点空白处、再点别人的格子：锚点保留、区间仍未定", () => {
    const first = pickerTap(createPickerState(null), 3, { ledCount: 30, others });
    const second = pickerTap(first.state, 12, { ledCount: 30, others });
    expect(second.disabled).toBe(true);
    expect(second.state.anchor).toBe(3);
    expect(second.state.cursor).toBeNull();
  });

  it("逐灯珠归属：别人的格子标 disabled，空白处可点", () => {
    const cells = buildPickerCells(createPickerState(null), {
      ledCount: 30,
      others,
      colors: new Map([[1, "#00FF00"]]),
    });
    expect(cells[9].disabled).toBe(false);
    expect(cells[10].disabled).toBe(true);
    expect(cells[10].ownerSegId).toBe(1);
    expect(cells[10].ownerHex).toBe("#00FF00");
    expect(cells[19].disabled).toBe(true);
    expect(cells[20].disabled).toBe(false);
  });

  it("`otherZones` 排除正在编辑的那个（改自己不算冲突）", () => {
    const list = [
      { segId: 0, start: 0, end: 9 },
      { segId: 1, start: 10, end: 19 },
    ];
    expect(otherZones(list, 1)).toEqual([{ segId: 0, start: 0, end: 9 }]);
    expect(otherZones(list, null)).toHaveLength(2);
  });

  it("ownerOf 找不到归属返回 -1", () => {
    expect(ownerOf(5, others)).toBe(-1);
    expect(ownerOf(15, others)).toBe(1);
  });
});

describe("重叠当场报错、不落草稿", () => {
  const others = [{ segId: 0, start: 10, end: 19 }];

  it("选区跨过别人的格子 → 校验失败、消息带光区号与区间", () => {
    const state: PickerState = { segId: null, anchor: 5, cursor: 15 };
    const check = pickerCheck(state, { ledCount: 30, others, zoneCount: 0 });
    expect(check.ok).toBe(false);
    expect(check.message).toContain("光区 1");
    expect(check.message).toContain("10–19");
  });

  it("commit 失败时不产生任何光区（数组引用不变）", () => {
    const zones = [zone(0, 0, 10, 19)];
    const state: PickerState = { segId: null, anchor: 5, cursor: 15 };
    const result = commitPicker(state, zones, 0, 30);
    expect(result.changed).toBe(false);
    expect(result.zones).toBe(zones);
    expect(result.error).toContain("重叠");
  });

  it("相接不算重叠（0–9 与 10–19 可以并存）", () => {
    const zones = [zone(0, 0, 10, 19)];
    const state: PickerState = { segId: null, anchor: 0, cursor: 9 };
    const result = commitPicker(state, zones, 0, 30);
    expect(result.error).toBe("");
    expect(result.changed).toBe(true);
  });

  it("改自己时自己那块不算冲突", () => {
    const zones = [zone(0, 0, 10, 19)];
    const state = createPickerState(0, { start: 10, end: 19 });
    const check = pickerCheck(state, { ledCount: 30, others: otherZones(zones, 0), zoneCount: 1 });
    expect(check.ok).toBe(true);
  });

  it("逐格标 conflict：选区 ∩ 别人的格子", () => {
    const cells = buildPickerCells({ segId: null, anchor: 5, cursor: 15 }, {
      ledCount: 30,
      others,
    });
    expect(cells[5].conflict).toBe(false);
    expect(cells[10].conflict).toBe(true);
    expect(cells[15].conflict).toBe(true);
    expect(cells[5].selected).toBe(true);
    expect(cells[5].disabled).toBe(false);
  });
});

describe("校验与提交", () => {
  it("还没选满两次 → 不可确定并给引导语", () => {
    const check = pickerCheck(createPickerState(null), { ledCount: 30, others: [], zoneCount: 0 });
    expect(check.ok).toBe(false);
    expect(check.message).toContain("先点");
  });

  it("合法区间：新建占最小空闲槽位", () => {
    const zones = [zone(0, 0, 0, 4)];
    const result = commitPicker({ segId: null, anchor: 10, cursor: 19 }, zones, 0, 30);
    expect(result.error).toBe("");
    expect(result.changed).toBe(true);
    const added = result.zones.find((zone) => zone.start === 10)!;
    expect(added.segId).toBe(1);
    expect(added.stripId).toBe(0);
  });

  it("改已有光区只改区间，主效果原样保留", () => {
    const zones = [zone(0, 0, 0, 4)];
    const result = commitPicker(createPickerState(0, { start: 0, end: 9 }), zones, 0, 30);
    expect(result.changed).toBe(true);
    expect(result.zones[0].start).toBe(0);
    expect(result.zones[0].end).toBe(9);
    expect(result.zones[0].layer0.hue).toBe(1234);
  });

  it("范围没变 → changed=false、数组引用不变", () => {
    const zones = [zone(0, 0, 0, 9)];
    const result = commitPicker(createPickerState(0, { start: 0, end: 9 }), zones, 0, 30);
    expect(result.changed).toBe(false);
    expect(result.zones).toBe(zones);
  });

  it("8 个光区已满 → 新建被拒", () => {
    /* 八个单颗光区挤在 0–14，选区放在 20–25（不重叠，只触发数量上限）。 */
    const zones = Array.from({ length: 8 }, (_, index) => zone(0, index, index * 2, index * 2));
    const result = commitPicker({ segId: null, anchor: 20, cursor: 25 }, zones, 0, 30);
    expect(result.changed).toBe(false);
    expect(result.error).toContain("最多");
  });

  it("越界（超过灯珠数）被拒", () => {
    const check = pickerCheck({ segId: null, anchor: 20, cursor: 40 }, {
      ledCount: 30,
      others: [],
      zoneCount: 0,
    });
    expect(check.ok).toBe(false);
  });

  it("灯珠格子总数 = 该灯组真实灯珠数（有几颗画几颗）", () => {
    expect(buildPickerCells(createPickerState(null), { ledCount: 18, others: [] })).toHaveLength(18);
    expect(buildPickerCells(createPickerState(null), { ledCount: 64, others: [] })).toHaveLength(64);
    expect(buildPickerCells(createPickerState(null), { ledCount: 0, others: [] })).toEqual([]);
  });

  it("超过 100 颗被截断（#72 协议上限）", () => {
    expect(buildPickerCells(createPickerState(null), { ledCount: 200, others: [] })).toHaveLength(
      MAX_LEDS,
    );
    expect(buildPickerCells(createPickerState(null), { ledCount: 100, others: [] })).toHaveLength(
      100,
    );
  });

  it("编号从 1 起", () => {
    const cells = buildPickerCells(createPickerState(null), { ledCount: 3, others: [] });
    expect(cells.map((cell) => cell.label)).toEqual([1, 2, 3]);
    expect(cells.map((cell) => cell.index)).toEqual([0, 1, 2]);
  });
});

describe("删除与区间文字", () => {
  it("删除已有光区", () => {
    const zones = [zone(0, 0, 0, 4), zone(0, 1, 10, 19)];
    const next = deletePickerZone(zones, 1);
    expect(next.map((item) => item.segId)).toEqual([0]);
  });

  it("新建状态下没有可删的东西（引用不变）", () => {
    const zones = [zone(0, 0, 0, 4)];
    expect(deletePickerZone(zones, null)).toBe(zones);
  });

  it("区间文字：未选 / 已设锚点 / 已定区间三种形态", () => {
    expect(pickerRangeText(createPickerState(null))).toContain("起点");
    expect(pickerRangeText(createPickerState(null, { start: 3, end: 3 }))).toContain("共 1 颗");
    expect(
      pickerRangeText({ segId: null, anchor: 3, cursor: null }),
    ).toContain("起点是第 4 颗");
    const full = pickerRangeText({ segId: null, anchor: 3, cursor: 9 });
    expect(full).toContain("第 4–10 颗");
    expect(full).toContain("共 7 颗");
  });
});
