/**
 * 分区编辑器（#55）：拖动划选、快捷切分、增删改。
 *
 * 锁住三类「只有模拟器能看出来」的问题：
 *  1. 拖动方向 —— 从右往左拖必须得到 start <= end；
 *  2. 重叠拦截 —— 与已有分区相交时**一帧不发**，并且提示里带对方编号；
 *  3. 切分正确性 —— 整条 / 前半 / 后半 / 均分 2–4 必须互不重叠、覆盖完整。
 *
 * 同时锁住「改一个分区不影响别人」与「叠加层为空时叠加方式归一为覆盖」。
 */

import { describe, expect, it } from "vitest";
import {
  addZone,
  cellFromRatio,
  checkZoneAdd,
  DEFAULT_BLEND,
  defaultZoneLayer,
  draftConflicts,
  dragRange,
  EMPTY_DRAG,
  hasGap,
  removeZone,
  resizeZone,
  setZoneLayer0,
  setZoneOverlay,
  splitParts,
  splitWhole,
  zonesFromReports,
  zonesFromSplit,
} from "../utils/control/zone-editor";
import { buildZoneSpec } from "../utils/control/zone-model";
import { BLEND, MAX_SEGMENTS, NO_EFFECT, SEGMENT_TYPE } from "../utils/protocol/constants";
import type { EffectLayer, SegmentReport, SegmentSpec } from "../utils/protocol/types";

function layer(type: number, overrides: Partial<EffectLayer> = {}): EffectLayer {
  return {
    type,
    hue: 1000,
    sat: 255,
    periodMs: 0,
    p5: 0,
    flags: 0,
    /* 空层的 level 必须为 0；非空层默认满亮。 */
    level: type === NO_EFFECT ? 0 : 100,
    ...overrides,
  };
}

function zone(segId: number, start: number, end: number): SegmentSpec {
  return buildZoneSpec({
    stripId: 0,
    segId,
    start,
    end,
    blend: DEFAULT_BLEND,
    layer0: defaultZoneLayer(),
    layer1: null,
  });
}

describe("拖动划选", () => {
  it("没有拖动时返回 null", () => {
    expect(dragRange(EMPTY_DRAG)).toBeNull();
    expect(dragRange({ anchor: 3, cursor: null })).toBeNull();
  });

  it("从左往右拖：start <= end 原样保留", () => {
    expect(dragRange({ anchor: 3, cursor: 9 })).toEqual({ start: 3, end: 9 });
  });

  it("从右往左拖：自动交换（不能产生 start > end 的区间）", () => {
    expect(dragRange({ anchor: 9, cursor: 3 })).toEqual({ start: 3, end: 9 });
  });

  it("点一下（anchor == cursor）得到一个单灯珠区间", () => {
    expect(dragRange({ anchor: 4, cursor: 4 })).toEqual({ start: 4, end: 4 });
  });

  it("比例换算：左右边界与中间值都落在正确灯珠上", () => {
    expect(cellFromRatio(0, 10)).toBe(0);
    expect(cellFromRatio(0.05, 10)).toBe(0);
    expect(cellFromRatio(0.5, 10)).toBe(5);
    expect(cellFromRatio(0.99, 10)).toBe(9);
    /* 越界比例钳到两端，不返回 -1 以外的怪值。 */
    expect(cellFromRatio(-1, 10)).toBe(0);
    expect(cellFromRatio(2, 10)).toBe(9);
  });

  it("比例换算：灯珠数未知时不猜（返回 -1）", () => {
    expect(cellFromRatio(0.5, 0)).toBe(-1);
    expect(cellFromRatio(Number.NaN, 10)).toBe(-1);
  });
});

describe("新增预检（一帧不发的判据）", () => {
  it("空组可以加", () => {
    expect(checkZoneAdd([], 0, 9).ok).toBe(true);
  });

  it("与已有分区重叠被拦，提示里带对方编号（从 1 数）", () => {
    const existing = [{ segId: 0, start: 0, end: 9 }];
    const check = checkZoneAdd(existing, 5, 14);
    expect(check.ok).toBe(false);
    expect(check.message).toContain("分区 1");
  });

  it("相邻但不相交（0-9 与 10-19）可以加", () => {
    expect(checkZoneAdd([{ segId: 0, start: 0, end: 9 }], 10, 19).ok).toBe(true);
  });

  it("起点大于终点被拦", () => {
    expect(checkZoneAdd([], 8, 2).ok).toBe(false);
  });

  it("达到 8 个上限后不能再加", () => {
    const full = Array.from({ length: MAX_SEGMENTS }, (_, index) => ({
      segId: index,
      start: index * 4,
      end: index * 4 + 3,
    }));
    const check = checkZoneAdd(full, 32, 35);
    expect(check.ok).toBe(false);
    expect(check.message).toContain(String(MAX_SEGMENTS));
  });

  it("draftConflicts 只看有没有交叠", () => {
    const zones = [{ segId: 0, start: 0, end: 9 }];
    expect(draftConflicts(zones, { start: 5, end: 6 })).toBe(true);
    expect(draftConflicts(zones, { start: 10, end: 12 })).toBe(false);
    expect(draftConflicts(zones, null)).toBe(false);
  });
});

describe("快捷切分", () => {
  it("整条 = 0..ledCount-1 的单分区", () => {
    const zones = splitWhole("whole", 30, 0);
    expect(zones).toHaveLength(1);
    expect(zones[0].start).toBe(0);
    expect(zones[0].end).toBe(29);
  });

  it("前半 / 后半 首尾相接且覆盖整条", () => {
    const first = splitWhole("firstHalf", 30, 0)[0];
    const second = splitWhole("secondHalf", 30, 0)[0];
    expect(first.start).toBe(0);
    expect(second.end).toBe(29);
    expect(second.start).toBe(first.end + 1);
  });

  it.each([2, 3, 4])("均分 %i 段：互不重叠、首尾覆盖整条", (parts) => {
    const zones = splitParts(parts, 30, 0);
    expect(zones).toHaveLength(parts);
    expect(zones[0].start).toBe(0);
    expect(zones[zones.length - 1].end).toBe(29);
    for (let i = 1; i < zones.length; i += 1) {
      expect(zones[i].start).toBe(zones[i - 1].end + 1);
    }
    /* 槽位从 0 连续分配，全部单层且叠加方式覆盖。 */
    expect(zones.map((zone) => zone.segId)).toEqual(Array.from({ length: parts }, (_, i) => i));
    for (const zone of zones) {
      expect(zone.layer1.type).toBe(NO_EFFECT);
      expect(zone.blend).toBe(BLEND.OVER);
    }
  });

  it("余数给前面的块（不会出现最后一块特别短）", () => {
    /* 31 颗均分 3：11 / 10 / 10。 */
    const zones = splitParts(3, 31, 0);
    expect(zones.map((zone) => zone.end - zone.start + 1)).toEqual([11, 10, 10]);
  });

  it("切分时保留原有分区的灯效（按位置对应）", () => {
    const existing = [zone(0, 0, 14), zone(1, 15, 29)];
    existing[1].layer0 = { ...existing[1].layer0, hue: 50000 };
    const zones = splitParts(2, 30, 0, existing);
    expect(zones[0].layer0.hue).toBe(existing[0].layer0.hue);
    expect(zones[1].layer0.hue).toBe(50000);
  });

  it("灯珠数为 1 时不产生非法切分", () => {
    const zones = splitParts(4, 1, 0);
    expect(zones).toHaveLength(1);
    expect(zones[0]).toMatchObject({ start: 0, end: 0 });
  });
});

describe("增删改", () => {
  it("新增占用最小空闲槽位，且是单层覆盖", () => {
    const zones = [zone(0, 0, 9), zone(2, 20, 29)];
    const added = addZone(zones, 0, 10, 19)!;
    expect(added.segId).toBe(1);
    expect(added.start).toBe(10);
    expect(added.end).toBe(19);
    expect(added.layer1.type).toBe(NO_EFFECT);
    expect(added.blend).toBe(BLEND.OVER);
  });

  it("重叠时新增返回 null（不产出半成品）", () => {
    expect(addZone([zone(0, 0, 9)], 0, 5, 12)).toBeNull();
  });

  it("改区间不影响其它分区（逐字段对比）", () => {
    const zones = [zone(0, 0, 9), zone(1, 10, 19)];
    const resized = resizeZone(zones, 1, 12, 25)!;
    expect(resized.start).toBe(12);
    expect(resized.end).toBe(25);
    /* 另一个分区完全没动。 */
    expect(zones[0]).toEqual(zone(0, 0, 9));
  });

  it("改成与别人重叠返回 null", () => {
    const zones = [zone(0, 0, 9), zone(1, 10, 19)];
    expect(resizeZone(zones, 1, 5, 19)).toBeNull();
  });

  it("区间没变时返回 null（页面据此不重发）", () => {
    const zones = [zone(0, 0, 9)];
    expect(resizeZone(zones, 0, 0, 9)).toBeNull();
  });

  it("删除只挑掉目标，其余保留", () => {
    const zones = [zone(0, 0, 9), zone(1, 10, 19)];
    const next = removeZone(zones, 0);
    expect(next.map((zone) => zone.segId)).toEqual([1]);
  });

  it("删除不存在的槽位返回同一引用（避免无意义刷新）", () => {
    const zones = [zone(0, 0, 9)];
    expect(removeZone(zones, 5)).toBe(zones);
  });

  it("改主效果只动 layer0，叠加层与叠加方式保留", () => {
    const base = buildZoneSpec({
      stripId: 0,
      segId: 0,
      start: 0,
      end: 9,
      blend: BLEND.ADD,
      layer0: defaultZoneLayer(),
      layer1: layer(SEGMENT_TYPE.RAINBOW),
    });
    const changed = setZoneLayer0([base], 0, layer(SEGMENT_TYPE.COMET, { hue: 30000 }))[0];
    expect(changed.layer0.type).toBe(SEGMENT_TYPE.COMET);
    expect(changed.layer0.hue).toBe(30000);
    expect(changed.layer1.type).toBe(SEGMENT_TYPE.RAINBOW);
    expect(changed.blend).toBe(BLEND.ADD);
  });

  it("移除叠加层时叠加方式被归一为覆盖（协议硬约束）", () => {
    const base = buildZoneSpec({
      stripId: 0,
      segId: 0,
      start: 0,
      end: 9,
      blend: BLEND.MULTIPLY,
      layer0: defaultZoneLayer(),
      layer1: layer(SEGMENT_TYPE.RAINBOW),
    });
    const cleared = setZoneOverlay([base], 0, null, BLEND.MULTIPLY)[0];
    expect(cleared.layer1.type).toBe(NO_EFFECT);
    expect(cleared.blend).toBe(BLEND.OVER);
  });

  it("有叠加层时叠加方式按传入值生效", () => {
    const base = zone(0, 0, 9);
    const layered = setZoneOverlay([base], 0, layer(SEGMENT_TYPE.BREATHING), BLEND.ADD)[0];
    expect(layered.layer1.type).toBe(SEGMENT_TYPE.BREATHING);
    expect(layered.blend).toBe(BLEND.ADD);
  });
});

describe("设备报告 → 编辑态", () => {
  function report(segId: number, start: number, end: number, blend = BLEND.OVER): SegmentReport {
    return {
      stripId: 0,
      segId,
      start,
      end,
      blend: blend as SegmentReport["blend"],
      layer0: layer(SEGMENT_TYPE.STATIC),
      layer1: layer(NO_EFFECT),
      type: SEGMENT_TYPE.STATIC,
      hue: 1000,
      sat: 255,
      periodMs: 0,
      p5: 0,
      flags: 0,
    };
  }

  it("按槽位排序并归一叠加方式", () => {
    const zones = zonesFromReports([report(2, 20, 29), report(0, 0, 9)]);
    expect(zones.map((zone) => zone.segId)).toEqual([0, 2]);
    /* 单层带非 0 blend 的报告也要读成覆盖。 */
    const odd = zonesFromReports([report(0, 0, 9, BLEND.ADD)])[0];
    expect(odd.blend).toBe(BLEND.OVER);
  });

  it("hasGap：有未覆盖灯珠时为真，全覆盖时为假", () => {
    expect(hasGap(10, [zone(0, 0, 9)])).toBe(false);
    expect(hasGap(10, [zone(0, 0, 4)])).toBe(true);
    expect(hasGap(10, [])).toBe(true);
  });
});

describe("zonesFromSplit 的输入契约", () => {
  it("空切分列表产出空数组（灯珠数未知时不编造分区）", () => {
    expect(zonesFromSplit([], 0)).toEqual([]);
  });

  it("切分产出的每个区间都合法且不重叠", () => {
    const zones = splitParts(4, 17, 3);
    for (let i = 0; i < zones.length; i += 1) {
      for (let j = i + 1; j < zones.length; j += 1) {
        const a = zones[i];
        const b = zones[j];
        expect(a.end < b.start || b.end < a.start).toBe(true);
      }
      expect(zones[i].stripId).toBe(3);
    }
  });
});
