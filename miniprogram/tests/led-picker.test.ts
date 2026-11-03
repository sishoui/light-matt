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
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { MAX_LEDS } from "../utils/protocol/constants";
import { BLEND, SEGMENT_TYPE } from "../utils/protocol/constants";
import { buildZoneSpec } from "../utils/control/zone-model";
import { dragRange } from "../utils/control/zone-editor";
import {
  applyPickerEnd,
  applyPickerStart,
  buildPickerCells,
  commitPicker,
  createPickerState,
  deletePickerZone,
  firstFreeRun,
  freeRunAround,
  otherZones,
  ownerOf,
  PICKER_COLUMNS,
  pickerCanConfirm,
  pickerCheck,
  pickerOptionLed,
  pickerOptions,
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

/* ------------------------------------------------------------------ *
 * #78：起止滚轮与起止样式
 *
 * 滚轮的值域是「与锚点连通的连续空闲段」，被别的光区占着的序号根本不出现，
 * 所以非法区间在界面上不可选。这里逐条锁住：
 *   - 连续空闲段（左端 / 右端 / 两侧被占 / 整条空闲 / 零空闲 / 单颗空闲）；
 *   - 两个滚轮候选（1 基显示、0 基内部）；
 *   - 滚轮下标 ↔ 灯珠下标；
 *   - 任一端变更后的区间合法性与「确定」可用性；
 *   - 起点 / 终点的格子标记。
 * ------------------------------------------------------------------ */

/** 常用上下文：无占用。 */
function plain(ledCount: number): {
  ledCount: number;
  others: Array<{ segId: number; start: number; end: number }>;
} {
  return { ledCount, others: [] };
}

describe("#78 连续空闲段", () => {
  it("整条空闲：从第 0 颗到最后一颗", () => {
    expect(firstFreeRun(30, [])).toEqual({ start: 0, end: 29 });
    expect(freeRunAround(7, 30, [])).toEqual({ start: 0, end: 29 });
  });

  it("左端被占：空闲段从占用之后开始", () => {
    expect(firstFreeRun(30, [{ segId: 0, start: 0, end: 4 }])).toEqual({ start: 5, end: 29 });
  });

  it("两侧都被占：锚点落在中间那一段", () => {
    const others = [
      { segId: 0, start: 0, end: 9 },
      { segId: 1, start: 15, end: 19 },
    ];
    expect(freeRunAround(12, 20, others)).toEqual({ start: 10, end: 14 });
  });

  it("锚点落在空闲段的两端也返回同一段", () => {
    const others = [
      { segId: 0, start: 0, end: 9 },
      { segId: 1, start: 15, end: 19 },
    ];
    expect(freeRunAround(10, 20, others)).toEqual({ start: 10, end: 14 });
    expect(freeRunAround(14, 20, others)).toEqual({ start: 10, end: 14 });
  });

  it("零空闲：全被占时返回 null", () => {
    expect(firstFreeRun(5, [{ segId: 0, start: 0, end: 4 }])).toBeNull();
    expect(freeRunAround(2, 5, [{ segId: 0, start: 0, end: 4 }])).toBeNull();
  });

  it("单颗空闲：左端与右端是同一颗", () => {
    const others = [
      { segId: 0, start: 0, end: 9 },
      { segId: 1, start: 11, end: 29 },
    ];
    expect(freeRunAround(10, 30, others)).toEqual({ start: 10, end: 10 });
  });

  it("锚点本身被占 / 越界 / 灯珠数为零：null", () => {
    expect(freeRunAround(3, 10, [{ segId: 0, start: 0, end: 4 }])).toBeNull();
    expect(freeRunAround(-1, 10, [])).toBeNull();
    expect(freeRunAround(10, 10, [])).toBeNull();
    expect(firstFreeRun(0, [])).toBeNull();
  });

  it("灯珠数按协议上限截断（超过 100 不给多余候选）", () => {
    expect(firstFreeRun(200, [])).toEqual({ start: 0, end: MAX_LEDS - 1 });
  });
});

describe("#78 两个滚轮的值域", () => {
  it("锚点未定：起点滚轮给出整段空闲、终点滚轮不可用", () => {
    const options = pickerOptions({ segId: null, anchor: null, cursor: null }, plain(10));
    expect(options.startLeds).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(options.startLabels[0]).toBe("第 1 颗");
    expect(options.startLabels[9]).toBe("第 10 颗");
    expect(options.endLeds).toEqual([]);
    expect(options.endDisabled).toBe(true);
  });

  it("起点取「空闲段左端 → 锚点」，终点取「锚点 → 空闲段右端」", () => {
    const others = [
      { segId: 1, start: 0, end: 1 },
      { segId: 2, start: 6, end: 9 },
    ];
    const options = pickerOptions({ segId: null, anchor: 4, cursor: null }, { ledCount: 10, others });
    expect(options.startLeds).toEqual([2, 3, 4]);
    expect(options.endLeds).toEqual([4, 5]);
    expect(options.endDisabled).toBe(false);
  });

  it("被其它光区占着的序号**根本不出现**在两个滚轮里", () => {
    const others = [
      { segId: 1, start: 0, end: 2 },
      { segId: 2, start: 8, end: 11 },
    ];
    const options = pickerOptions({ segId: null, anchor: 5, cursor: null }, { ledCount: 12, others });
    const occupied = new Set([0, 1, 2, 8, 9, 10, 11]);
    for (const led of [...options.startLeds, ...options.endLeds]) {
      expect(occupied.has(led)).toBe(false);
    }
    expect(options.startLeds).toEqual([3, 4, 5]);
    expect(options.endLeds).toEqual([5, 6, 7]);
  });

  it("改自己的区间时，自己那块不算占用（值域不被自己截断）", () => {
    const own = [{ segId: 0, start: 4, end: 7 }];
    const options = pickerOptions(
      { segId: 0, anchor: 5, cursor: 6 },
      { ledCount: 10, others: otherZones(own, 0) },
    );
    expect(options.startLeds).toEqual([0, 1, 2, 3, 4, 5]);
    expect(options.endLeds).toEqual([5, 6, 7, 8, 9]);
  });

  it("反向点选（anchor 在高处）时起点滚轮仍从区间的低端往前给", () => {
    const options = pickerOptions({ segId: null, anchor: 9, cursor: 3 }, plain(12));
    expect(options.startLeds).toEqual([0, 1, 2, 3]);
    expect(options.endLeds).toEqual([3, 4, 5, 6, 7, 8, 9, 10, 11]);
    expect(options.startText).toBe("第 4 颗");
    expect(options.endText).toBe("第 10 颗");
  });

  it("零空闲灯珠：两个候选都为空", () => {
    const options = pickerOptions(
      { segId: null, anchor: null, cursor: null },
      { ledCount: 4, others: [{ segId: 0, start: 0, end: 3 }] },
    );
    expect(options.startLeds).toEqual([]);
    expect(options.startLabels).toEqual([]);
    expect(options.endLeds).toEqual([]);
    expect(options.endDisabled).toBe(true);
  });

  it("显示按第 1 颗起算：候选标签与灯珠下标一一对应", () => {
    const options = pickerOptions(
      { segId: null, anchor: 4, cursor: null },
      { ledCount: 10, others: [{ segId: 0, start: 0, end: 1 }] },
    );
    expect(options.startLeds.map((_, index) => options.startLabels[index])).toEqual([
      "第 3 颗",
      "第 4 颗",
      "第 5 颗",
    ]);
  });
});

describe("#78 滚轮下标 ↔ 灯珠下标", () => {
  const leds = [2, 3, 4];

  it("滚轮下标映射回 0 基灯珠下标", () => {
    expect(pickerOptionLed(leds, 0)).toBe(2);
    expect(pickerOptionLed(leds, 2)).toBe(4);
  });

  it("越界下标返回 -1（调用方据此忽略这次事件）", () => {
    expect(pickerOptionLed(leds, -1)).toBe(-1);
    expect(pickerOptionLed(leds, 3)).toBe(-1);
    expect(pickerOptionLed([], 0)).toBe(-1);
    expect(pickerOptionLed(leds, 1.5)).toBe(-1);
  });
});

describe("#78 用滚轮改起止", () => {
  it("锚点未定时选起点：锚点落到该颗，区间预览为同一颗（还不能确定）", () => {
    const ctx = plain(12);
    const state = applyPickerStart(createPickerState(null), 3, ctx);
    expect(state.anchor).toBe(3);
    expect(pickerRange(state)).toEqual({ start: 3, end: 3 });
    expect(pickerCanConfirm(state, ctx)).toBe(false);
  });

  it("再选终点：区间变成起点→终点，确定可用", () => {
    const ctx = plain(12);
    let state = applyPickerStart(createPickerState(null), 3, ctx);
    state = applyPickerEnd(state, 7, ctx);
    expect(pickerRange(state)).toEqual({ start: 3, end: 7 });
    expect(pickerCanConfirm(state, ctx)).toBe(true);
  });

  it("改起点会保住已选的终点（不是把终点拉回锚点）", () => {
    const ctx = plain(12);
    let state = applyPickerStart(createPickerState(null), 3, ctx);
    state = applyPickerEnd(state, 9, ctx);
    state = applyPickerStart(state, 1, ctx);
    expect(pickerRange(state)).toEqual({ start: 1, end: 9 });
  });

  it("改终点会保住已选的起点", () => {
    const ctx = plain(12);
    let state = applyPickerStart(createPickerState(null), 3, ctx);
    state = applyPickerEnd(state, 9, ctx);
    state = applyPickerEnd(state, 11, ctx);
    expect(pickerRange(state)).toEqual({ start: 3, end: 11 });
  });

  it("终点选成锚点本身 → 只剩一颗 → 确定不可用", () => {
    const ctx = plain(12);
    const state = applyPickerEnd({ segId: null, anchor: 5, cursor: null }, 5, ctx);
    expect(pickerRange(state)).toEqual({ start: 5, end: 5 });
    expect(pickerCanConfirm(state, ctx)).toBe(false);
  });

  it("起点选成锚点本身 → 只剩一颗 → 确定不可用", () => {
    const ctx = plain(12);
    const state = applyPickerStart({ segId: null, anchor: 5, cursor: null }, 5, ctx);
    expect(pickerRange(state)).toEqual({ start: 5, end: 5 });
    expect(pickerCanConfirm(state, ctx)).toBe(false);
  });

  it("锚点未定时终点滚轮禁用：applyPickerEnd 不改状态", () => {
    const ctx = plain(12);
    const state = createPickerState(null);
    expect(applyPickerEnd(state, 4, ctx)).toEqual(state);
  });

  it("选中被别的光区占着的序号：状态不变（值域里本就没有它）", () => {
    const ctx = { ledCount: 12, others: [{ segId: 1, start: 8, end: 11 }] };
    const state = applyPickerStart(createPickerState(null), 3, ctx);
    expect(applyPickerStart(state, 9, ctx)).toEqual(state);
    expect(applyPickerEnd(state, 9, ctx)).toEqual(state);
  });

  it("滚轮设完之后再点格子：重新进入锚点流程（滚轮值不残留）", () => {
    const ctx = plain(12);
    let state = applyPickerStart(createPickerState(null), 3, ctx);
    state = applyPickerEnd(state, 9, ctx);
    const tapped = pickerTap(state, 1, ctx).state;
    expect(pickerRange(tapped)).toBeNull();
    expect(tapped.anchor).toBe(1);
  });

  it("区间预览立刻反映在格子上（改任一端都重算）", () => {
    const ctx = plain(12);
    let state = applyPickerStart(createPickerState(null), 3, ctx);
    state = applyPickerEnd(state, 7, ctx);
    const cells = buildPickerCells(state, ctx);
    expect(cells[3].start).toBe(true);
    expect(cells[7].end).toBe(true);
    expect(cells[5].selected).toBe(true);
    state = applyPickerEnd(state, 9, ctx);
    const next = buildPickerCells(state, ctx);
    expect(next[7].end).toBe(false);
    expect(next[9].end).toBe(true);
    expect(next[8].selected).toBe(true);
  });
});

describe("#78 确定按钮的可用性", () => {
  const ctx = { ledCount: 30, others: [{ segId: 0, start: 10, end: 19 }], zoneCount: 1 };

  it("还没选区 → 不可用", () => {
    expect(pickerCanConfirm(createPickerState(null), ctx)).toBe(false);
  });

  it("只剩一颗（起点 = 终点） → 不可用", () => {
    expect(pickerCanConfirm({ segId: null, anchor: 5, cursor: 5 }, ctx)).toBe(false);
  });

  it("合法区间 → 可用", () => {
    expect(pickerCanConfirm({ segId: null, anchor: 2, cursor: 5 }, ctx)).toBe(true);
  });

  it("跨过别人的格子 → 不可用（与 `pickerCheck` 同一条判定）", () => {
    expect(pickerCanConfirm({ segId: null, anchor: 5, cursor: 15 }, ctx)).toBe(false);
  });

  it("光区已满（新建） → 不可用", () => {
    const full = { ledCount: 30, others: [], zoneCount: 8 };
    expect(pickerCanConfirm({ segId: null, anchor: 20, cursor: 25 }, full)).toBe(false);
  });
});

describe("#78 起止滚轮的回显", () => {
  it("锚点未定：起点滚轮回显第一个候选，终点无文案", () => {
    const options = pickerOptions(
      { segId: null, anchor: null, cursor: null },
      { ledCount: 10, others: [{ segId: 0, start: 0, end: 2 }] },
    );
    expect(options.startIndex).toBe(0);
    expect(options.startText).toBe("第 4 颗");
    expect(options.endText).toBe("");
  });

  it("已设锚点：两端分别回显真实端点（1 基）", () => {
    const options = pickerOptions({ segId: null, anchor: 3, cursor: 7 }, plain(10));
    expect(options.startText).toBe("第 4 颗");
    expect(options.endText).toBe("第 8 颗");
    expect(options.startIndex).toBe(3);
    expect(options.endIndex).toBe(4);
  });

  it("点出的区间跨过别人的格子：滚轮如实显示那端，而不是假装选了候选里的第一个", () => {
    const options = pickerOptions(
      { segId: null, anchor: 5, cursor: 15 },
      { ledCount: 30, others: [{ segId: 0, start: 10, end: 12 }] },
    );
    expect(options.endText).toBe("第 16 颗");
    expect(options.endLeds).not.toContain(15);
    expect(options.endIndex).toBe(0);
  });

  it("零空闲灯珠：起点无文案、也没有回显下标", () => {
    const options = pickerOptions(
      { segId: null, anchor: null, cursor: null },
      { ledCount: 4, others: [{ segId: 0, start: 0, end: 3 }] },
    );
    expect(options.startIndex).toBe(-1);
    expect(options.startText).toBe("");
    expect(options.endIndex).toBe(-1);
  });
});

describe("#78 起止格子的样式标记", () => {
  it("起点标 start、终点标 end，区间内都标 selected", () => {
    const cells = buildPickerCells({ segId: null, anchor: 2, cursor: 5 }, plain(8));
    expect(cells[2].start).toBe(true);
    expect(cells[2].end).toBe(false);
    expect(cells[5].start).toBe(false);
    expect(cells[5].end).toBe(true);
    expect([2, 3, 4, 5].every((index) => cells[index].selected)).toBe(true);
    expect(cells[1].start).toBe(false);
    expect(cells[1].selected).toBe(false);
    expect(cells[6].selected).toBe(false);
  });

  it("起点在右、终点在左（反向选择）也按区间两端标注", () => {
    const cells = buildPickerCells({ segId: null, anchor: 6, cursor: 4 }, plain(8));
    expect(cells[4].start).toBe(true);
    expect(cells[6].end).toBe(true);
  });

  it("只剩一颗时只画起点（不叠一个空心环）", () => {
    const cells = buildPickerCells({ segId: null, anchor: 3, cursor: 3 }, plain(8));
    expect(cells[3].start).toBe(true);
    expect(cells[3].end).toBe(false);
  });

  it("别人的格子既不标起点也不标终点", () => {
    const cells = buildPickerCells(
      { segId: null, anchor: null, cursor: null },
      { ledCount: 8, others: [{ segId: 0, start: 3, end: 4 }] },
    );
    expect(cells[3].disabled).toBe(true);
    expect(cells[3].start).toBe(false);
    expect(cells[3].end).toBe(false);
    expect(cells[3].selected).toBe(false);
  });

  it("没有选区时没有起点 / 终点标记", () => {
    const cells = buildPickerCells({ segId: null, anchor: 3, cursor: null }, plain(8));
    expect(cells.some((cell) => cell.start || cell.end)).toBe(false);
  });
});

describe("渲染层：起止样式与滚轮（#78）", () => {
  const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const wxml = readFileSync(join(ROOT, "pages/strip/strip.wxml"), "utf8");
  /* 去注释再断言：说明文字里出现同名 token 不该让规则变绿。 */
  const wxss = readFileSync(join(ROOT, "pages/strip/strip.wxss"), "utf8").replace(
    /\/\*[\s\S]*?\*\//g,
    "",
  );

  /**
   * 取**独享**选择器的声明块。
   *
   * 必须认 `选择器 + 空格 + {`：`.picker-cell.start::before, .picker-cell.end::before`
   * 这样的共用块只放几何属性，实心 / 空心在各自后面的块里；找共用块会读到
   * 空的 background，测试于是变成假红或假绿。
   */
  function rule(selector: string): string {
    const index = wxss.indexOf(`${selector} {`);
    expect(index, `wxss 里找不到独立的 ${selector} 块`).toBeGreaterThanOrEqual(0);
    const open = wxss.indexOf("{", index);
    const close = wxss.indexOf("}", open);
    return wxss.slice(open + 1, close);
  }

  it("格子挂上 start / end / selected 三个状态类", () => {
    expect(wxml).toContain("item.start ? 'start'");
    expect(wxml).toContain("item.end ? 'end'");
    expect(wxml).toContain("item.selected ? 'selected'");
  });

  it("起点是实心圆 + 加粗数字", () => {
    expect(rule(".picker-cell.start::before")).toMatch(/background:\s*var\(--accent\)/);
    expect(rule(".picker-cell.start .picker-cell-no")).toMatch(/font-weight:\s*700/);
  });

  it("终点是空心圆环（只有描边、无填充）", () => {
    const end = rule(".picker-cell.end::before");
    expect(end).toMatch(/border:\s*[^;]*var\(--accent\)/);
    expect(end).toMatch(/background:\s*transparent/);
  });

  it("区间内是半透明主题底色", () => {
    expect(rule(".picker-cell.selected")).toMatch(/background:\s*var\(--accent-soft\)/);
  });

  it("别人的格子仍然置灰且点不动", () => {
    expect(wxml).toContain("item.disabled ? 'disabled'");
    const disabled = rule(".picker-cell.disabled");
    expect(disabled).toMatch(/pointer-events:\s*none/);
    expect(disabled).toMatch(/opacity/);
  });

  it("底部有两个 selector 滚轮，绑定各自的事件", () => {
    expect(wxml.match(/mode="selector"/g)?.length).toBe(2);
    expect(wxml).toContain('bindchange="onPickerStartChange"');
    expect(wxml).toContain('bindchange="onPickerEndChange"');
    expect(wxml).toContain("pickerStartLabels");
    expect(wxml).toContain("pickerEndLabels");
  });

  it("终点滚轮在锚点未定时不渲染（wx:if 与 pickerEndDisabled 绑定）", () => {
    expect(wxml).toContain("!pickerEndDisabled");
  });

  it("滚轮候选只渲染文案列表（被占序号不进候选，见值域单测）", () => {
    expect(wxml).not.toContain("pickerStartOptions");
    expect(wxml).not.toContain("pickerEndOptions");
  });
});
