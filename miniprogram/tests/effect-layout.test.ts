/**
 * 光区布局（纯函数）：区间校验、重叠拦截、默认切分、逐灯珠归属。
 *
 * 这些规则直接决定「会不会发出一帧必定被设备拒绝的配置」，所以必须是
 * 纯函数并在 node 里锁死——靠模拟器点不出来。
 */

import { describe, expect, it } from "vitest";
import {
  buildZoneCells,
  canAddZone,
  checkRange,
  findConflict,
  nextFreeSegId,
  rangesOverlap,
  splitEvenly,
  splitPreset,
  uncoveredCount,
  validateZone,
  zoneColorMap,
  zonesFromReports,
  zonesSummary,
  type ZoneRange,
} from "../utils/control/effect-layout";
import { MAX_SEGMENTS } from "../utils/protocol/constants";
import type { SegmentReport } from "../utils/protocol/types";

function zones(...ranges: Array<[number, number, number]>): ZoneRange[] {
  return ranges.map(([segId, start, end]) => ({ segId, start, end }));
}

function report(segId: number, start: number, end: number, hue = 0, sat = 0): SegmentReport {
  const layer0 = { type: 0, hue, sat, periodMs: 0, p5: 0, flags: 0 };
  const layer1 = { type: 0xff, hue: 0, sat: 0, periodMs: 0, p5: 0, flags: 0 };
  return {
    stripId: 0,
    segId,
    start,
    end,
    blend: 0,
    layer0,
    layer1,
    type: layer0.type,
    hue,
    sat,
    periodMs: 0,
    p5: 0,
    flags: 0,
  };
}

describe("区间校验", () => {
  it("合法区间通过", () => {
    expect(checkRange(0, 29, 30)).toMatchObject({ ok: true, start: 0, end: 29 });
  });

  it("起点大于终点被拒", () => {
    expect(checkRange(10, 5, 30).ok).toBe(false);
  });

  it("终点超出灯珠数被拒（提示里带可用范围）", () => {
    const r = checkRange(0, 30, 30);
    expect(r.ok).toBe(false);
    expect(r.message).toContain("0-29");
  });

  it("负数与小数被拒", () => {
    expect(checkRange(-1, 5, 30).ok).toBe(false);
    expect(checkRange(0.5, 5, 30).ok).toBe(false);
  });

  it("灯珠数未知时给出可读原因", () => {
    expect(checkRange(0, 0, 0).ok).toBe(false);
    expect(checkRange(0, 0, 0).message).toContain("灯珠数量未知");
  });

  it("单颗灯组（0-0）合法", () => {
    expect(checkRange(0, 0, 1).ok).toBe(true);
  });
});

describe("重叠判定", () => {
  it("相接但不相交不算重叠（闭区间边界）", () => {
    expect(rangesOverlap({ start: 0, end: 9 }, { start: 10, end: 19 })).toBe(false);
  });

  it("共享一个端点算重叠", () => {
    expect(rangesOverlap({ start: 0, end: 9 }, { start: 9, end: 19 })).toBe(true);
  });

  it("完全包含算重叠", () => {
    expect(rangesOverlap({ start: 5, end: 6 }, { start: 0, end: 19 })).toBe(true);
  });

  it("找到冲突时返回那个光区（含槽位与区间，供提示）", () => {
    const conflict = findConflict({ start: 5, end: 10 }, zones([0, 0, 14], [1, 20, 29]));
    expect(conflict?.segId).toBe(0);
    expect(conflict?.start).toBe(0);
  });

  it("忽略正在编辑的那一个（改自己的区间不是冲突）", () => {
    expect(findConflict({ start: 0, end: 9 }, zones([0, 0, 9]), 0)).toBeNull();
  });

  it("不重叠时返回 null", () => {
    expect(findConflict({ start: 10, end: 19 }, zones([0, 0, 9]))).toBeNull();
  });
});

describe("validateZone", () => {
  it("合法且不重叠 → 通过并回显区间", () => {
    const r = validateZone(1, 10, 19, zones([0, 0, 9]), 30);
    expect(r).toMatchObject({ ok: true, start: 10, end: 19 });
  });

  it("重叠时提示里带「光区 N」（从 1 编号）", () => {
    const r = validateZone(2, 5, 10, zones([1, 0, 9]), 30);
    expect(r.ok).toBe(false);
    expect(r.message).toContain("光区 2");
  });

  it("区间非法时先报区间问题（不叠加重叠噪音）", () => {
    const r = validateZone(1, 0, 99, zones(), 30);
    expect(r.ok).toBe(false);
    expect(r.message).not.toContain("重叠");
  });
});

describe("槽位分配", () => {
  it("8 个槽位满后不能再加", () => {
    const full = zones(...Array.from({ length: MAX_SEGMENTS }, (_, i): [number, number, number] => [i, i, i]));
    expect(canAddZone(full)).toBe(false);
    expect(nextFreeSegId(full)).toBe(-1);
  });

  it("取最小的空闲槽位（删除中间槽位后可复用）", () => {
    expect(nextFreeSegId(zones([0, 0, 5], [2, 10, 15]))).toBe(1);
  });

  it("空列表取 0", () => {
    expect(nextFreeSegId([])).toBe(0);
  });
});

describe("默认切分", () => {
  it("整条覆盖 0..ledCount-1", () => {
    expect(splitPreset("whole", 30)).toEqual({ start: 0, end: 29 });
  });

  it("前半 / 后半不重叠且合起来覆盖整条", () => {
    const first = splitPreset("firstHalf", 30);
    const second = splitPreset("secondHalf", 30);
    expect(first).toEqual({ start: 0, end: 14 });
    expect(second).toEqual({ start: 15, end: 29 });
    expect(rangesOverlap(first, second)).toBe(false);
  });

  it("奇数灯珠时前半短一点、后半多一颗", () => {
    expect(splitPreset("firstHalf", 9)).toEqual({ start: 0, end: 3 });
    expect(splitPreset("secondHalf", 9)).toEqual({ start: 4, end: 8 });
  });

  it("均分 2 份：余数给前面", () => {
    expect(splitEvenly(9, 2)).toEqual([
      { start: 0, end: 4 },
      { start: 5, end: 8 },
    ]);
  });

  it("均分 3 份：区间连续、无空洞、无重叠", () => {
    const parts = splitEvenly(30, 3);
    expect(parts).toHaveLength(3);
    expect(parts[0].start).toBe(0);
    expect(parts[2].end).toBe(29);
    for (let i = 1; i < parts.length; i += 1) {
      expect(parts[i].start).toBe(parts[i - 1].end + 1);
    }
  });

  it("份数超过灯珠数时按灯珠数截断（不留空块）", () => {
    const parts = splitEvenly(3, 10);
    expect(parts).toHaveLength(3);
    expect(parts.every((part) => part.end >= part.start)).toBe(true);
  });

  it("灯珠数为 0 时返回空数组", () => {
    expect(splitEvenly(0, 4)).toEqual([]);
  });
});

describe("逐灯珠归属", () => {
  const zonesList = zones([0, 0, 9], [1, 10, 19]);

  it("每颗灯珠归属正确的光区", () => {
    const cells = buildZoneCells(25, zonesList, new Map(), null);
    expect(cells).toHaveLength(25);
    expect(cells[0].ownerSegId).toBe(0);
    expect(cells[9].ownerSegId).toBe(0);
    expect(cells[10].ownerSegId).toBe(1);
    expect(cells[19].ownerSegId).toBe(1);
  });

  it("未覆盖的灯珠 owner 为 -1（熄灭）", () => {
    const cells = buildZoneCells(25, zonesList, new Map(), null);
    expect(cells[20].ownerSegId).toBe(-1);
    expect(cells[24].ownerSegId).toBe(-1);
  });

  it("草稿区间优先显示，且与已有光区相交的部分标冲突", () => {
    const cells = buildZoneCells(25, zonesList, new Map(), { start: 5, end: 12 }, 2);
    expect(cells[6].editing).toBe(true);
    expect(cells[6].conflict).toBe(true); // 与光区 0 相交
    expect(cells[11].editing).toBe(true);
    expect(cells[11].conflict).toBe(true); // 与光区 1 相交
    expect(cells[5].editing).toBe(true);
  });

  it("草稿落在空白处不标冲突", () => {
    const cells = buildZoneCells(25, zonesList, new Map(), { start: 20, end: 24 }, 2);
    expect(cells[20].editing).toBe(true);
    expect(cells[20].conflict).toBe(false);
  });

  it("灯珠数超过协议上限（64）时截断", () => {
    expect(buildZoneCells(200, zones(), new Map(), null)).toHaveLength(64);
  });
});

describe("从设备读回的值派生", () => {
  it("zonesFromReports 按槽位排序并只取区间", () => {
    const list = zonesFromReports([report(2, 20, 29), report(0, 0, 9)]);
    expect(list).toEqual([
      { segId: 0, start: 0, end: 9 },
      { segId: 2, start: 20, end: 29 },
    ]);
  });

  it("zoneColorMap 给出每个光区的展示色", () => {
    const map = zoneColorMap([report(0, 0, 9, 0, 255), report(1, 10, 19, 0, 0)]);
    expect(map.get(0)).toMatch(/^#[0-9A-F]{6}$/i);
    expect(map.get(0)).not.toBe(map.get(1));
  });

  it("未覆盖计数与摘要文案", () => {
    expect(uncoveredCount(30, zones([0, 0, 19]))).toBe(10);
    expect(zonesSummary(30, zones([0, 0, 19]))).toContain("10 颗熄灭");
    expect(zonesSummary(30, zones([0, 0, 29]))).toContain("整组覆盖");
    expect(zonesSummary(30, [])).toContain("还没有光区");
  });
});
