/**
 * 部位布局（#156）：段互斥、逻辑下标、方格几何、段表编辑。
 *
 * 这些规则**固件里已经有一份**（`layout_store.c`），这里测的是客户端镜像。
 * 两边分叉的症状是「界面允许、设备回 InvalidParam」，所以每条规则都对着
 * 固件的判定顺序写：越界 → 冲突。
 */

import { describe, expect, it } from "vitest";
import {
  GRID_DECADE,
  PHASE,
  addSeg,
  findConflict,
  gridColumns,
  gridIndexAtPoint,
  gridRows,
  gridRowsView,
  isValidSeg,
  lineBlocks,
  logicalIndexOf,
  normalizeRange,
  ownershipOf,
  partColor,
  partPixelCount,
  rangeTextOf,
  replaceSeg,
  segLength,
  segsOverlap,
  validateLayout,
  withSegs,
  type CellRect,
} from "../utils/control/part-layout";import type { LayoutPart } from "../utils/protocol/types";

/** 造一个部位（只填这条用例关心的字段）。 */
function part(partId: number, segs: Array<[number, number]>, name = ""): LayoutPart {
  return {
    stripId: 0,
    partId,
    nameLen: name.length,
    name,
    segCount: segs.length,
    segs,
  };
}

describe("区间与单段", () => {
  it("区间必须两端都在链内且 start ≤ end", () => {
    expect(isValidSeg([0, 29], 30)).toBe(true);
    expect(isValidSeg([29, 29], 30)).toBe(true);
    expect(isValidSeg([0, 30], 30)).toBe(false);
    expect(isValidSeg([5, 4], 30)).toBe(false);
    expect(isValidSeg([-1, 4], 30)).toBe(false);
    expect(isValidSeg([0.5, 4], 30)).toBe(false);
  });

  it("端点相接也算冲突（闭区间）", () => {
    expect(segsOverlap([0, 5], [5, 9])).toBe(true);
    expect(segsOverlap([0, 4], [5, 9])).toBe(false);
  });

  it("拖选的锚点大于落点时自动摆正", () => {
    expect(normalizeRange(9, 3)).toEqual([3, 9]);
    expect(normalizeRange(3, 3)).toEqual([3, 3]);
    expect(normalizeRange(Number.NaN, 3)).toBeNull();
    expect(normalizeRange(3.5, 9)).toBeNull();
  });

  it("段长与部位总颗数", () => {
    expect(segLength([1, 5])).toBe(5);
    expect(partPixelCount(part(0, [[1, 5], [20, 24]]))).toBe(10);
    expect(partPixelCount(part(0, []))).toBe(0);
  });
});

describe("互斥（S3 / S4）", () => {
  const parts = [part(0, [[0, 9]]), part(1, [[10, 19]])];

  it("压到别的部位时给出重叠的那一小段（画斜纹只画它）", () => {
    const conflict = findConflict(parts, [5, 12], null);
    expect(conflict).not.toBeNull();
    expect(conflict?.partId).toBe(0);
    expect(conflict?.overlap).toEqual([5, 9]);
  });

  it("只与更靠后的部位重叠时也能找到", () => {
    const conflict = findConflict(parts, [15, 25], null);
    expect(conflict?.partId).toBe(1);
    expect(conflict?.overlap).toEqual([15, 19]);
  });

  it("压在空隙上不算冲突", () => {
    expect(findConflict(parts, [20, 24], null)).toBeNull();
  });

  it("编辑自己那一段时忽略自己，但仍检查同部位的其它段", () => {
    const split = [part(0, [[0, 4], [10, 14]])];
    expect(findConflict(split, [0, 4], { partId: 0, segIndex: 0 })).toBeNull();
    /* 想把自己扩到同部位第二段上 → 冲突。 */
    expect(findConflict(split, [0, 12], { partId: 0, segIndex: 0 })?.segIndex).toBe(1);
  });
});

describe("逻辑下标（与 lumen_layout_logical_index 同口径）", () => {
  const twoSegs = part(0, [[1, 5], [20, 25]]);

  it("连续相位 = 覆盖集合里的升序名次", () => {
    expect(logicalIndexOf(twoSegs, 1, PHASE.CONTINUOUS)).toBe(0);
    expect(logicalIndexOf(twoSegs, 5, PHASE.CONTINUOUS)).toBe(4);
    expect(logicalIndexOf(twoSegs, 20, PHASE.CONTINUOUS)).toBe(5);
    expect(logicalIndexOf(twoSegs, 25, PHASE.CONTINUOUS)).toBe(10);
  });

  it("各自起点相位 = 段内偏移（第二段的第一颗也是 0）", () => {
    expect(logicalIndexOf(twoSegs, 1, PHASE.PER_SEGMENT)).toBe(0);
    expect(logicalIndexOf(twoSegs, 20, PHASE.PER_SEGMENT)).toBe(0);
    expect(logicalIndexOf(twoSegs, 25, PHASE.PER_SEGMENT)).toBe(5);
  });

  it("段序乱写也给出正确名次（不依赖排序）", () => {
    const shuffled = part(0, [[20, 25], [1, 5]]);
    expect(logicalIndexOf(shuffled, 20, PHASE.CONTINUOUS)).toBe(5);
    expect(logicalIndexOf(shuffled, 3, PHASE.CONTINUOUS)).toBe(2);
  });

  it("不在覆盖范围内时给 0（调用方不该问）", () => {
    expect(logicalIndexOf(twoSegs, 10, PHASE.CONTINUOUS)).toBe(0);
    expect(logicalIndexOf(twoSegs, 10, PHASE.PER_SEGMENT)).toBe(0);
  });


});

describe("归属表", () => {
  it("空隙是 PART_NONE，每个部位只认自己的珠子", () => {
    const owner = ownershipOf([part(0, [[0, 2]]), part(2, [[5, 6]])], 10);
    expect(Array.from(owner.slice(0, 8))).toEqual([0, 0, 0, 0xff, 0xff, 2, 2, 0xff]);
  });

  it("越界的段被裁到链内，不写坏邻居", () => {
    const owner = ownershipOf([part(0, [[8, 20]])], 10);
    expect(Array.from(owner)).toEqual([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0, 0]);
  });
});

describe("方格表几何（U5 / U7）", () => {
  it("宽屏折成 10 的整数倍（每行正好是十年段）", () => {
    expect(gridColumns(100, 800)).toBe(20);
    expect(gridColumns(60, 420)).toBe(10);
    expect(gridColumns(30, 300)).toBe(10);
  });

  it("窄屏至少 5 列（再少一屏滚不完）", () => {
    expect(gridColumns(100, 60)).toBe(5);
  });

  it("灯珠不足 10 颗时按颗数折，不硬凑 5 列", () => {
    expect(gridColumns(3, 800)).toBe(3);
  });

  it("还没量到宽度时给 10 列（首帧就是常见形态）", () => {
    expect(gridColumns(100, 0)).toBe(10);
    expect(gridColumns(100, Number.NaN)).toBe(10);
  });

  it("折行覆盖全部灯珠，一格不重不漏（每十颗标一次）", () => {
    const rows = gridRows(23, 10);
    expect(rows.length).toBe(3);
    const cells = rows.flatMap((row) => row.cells);
    expect(cells.map((cell) => cell.index)).toEqual(
      Array.from({ length: 23 }, (_, index) => index),
    );
    expect(cells[0].label).toBe("1");
    expect(cells[GRID_DECADE].decadeStart).toBe(true);
    expect(cells[GRID_DECADE - 1].decadeStart).toBe(false);
  });

  it("手指在格子里 → 那一格", () => {
    const rects: CellRect[] = [
      { index: 0, left: 0, top: 0, right: 20, bottom: 20 },
      { index: 1, left: 22, top: 0, right: 42, bottom: 20 },
    ];
    expect(gridIndexAtPoint(rects, 5, 5)).toBe(0);
    expect(gridIndexAtPoint(rects, 30, 10)).toBe(1);
  });

  it("手指偏在行间 → 最近一格（横向划过时不频繁断选）", () => {
    const rects: CellRect[] = [
      { index: 0, left: 0, top: 0, right: 20, bottom: 20 },
      { index: 1, left: 22, top: 0, right: 42, bottom: 20 },
    ];
    /* y=26 在两格下方 6px，x=5 更贴第 0 格。 */
    expect(gridIndexAtPoint(rects, 5, 26)).toBe(0);
  });

  it("离得太远（不像在这张表上）→ 保持上一次落点", () => {
    const rects: CellRect[] = [{ index: 0, left: 0, top: 0, right: 20, bottom: 20 }];
    expect(gridIndexAtPoint(rects, 500, 500)).toBe(-1);
    expect(gridIndexAtPoint([], 1, 1)).toBe(-1);
    expect(gridIndexAtPoint(rects, Number.NaN, 1)).toBe(-1);
  });
});

describe("方格表的归属与选区", () => {
  const parts = [part(0, [[0, 4]]), part(1, [[10, 14]])];

  it("空闲 / 自己 / 别的部位三种状态分开", () => {
    const rows = gridRowsView(20, 10, parts, 0);
    const cells = rows.flatMap((row) => row.cells);
    expect(cells[0].state).toBe("own");
    expect(cells[0].color).toBe(partColor(0));
    expect(cells[5].state).toBe("free");
    expect(cells[5].color).toBe("");
    expect(cells[10].state).toBe("other");
    expect(cells[10].color).toBe(partColor(1));
  });

  it("拖选草稿高亮整段", () => {
    const rows = gridRowsView(20, 10, parts, 0, [5, 8]);
    const cells = rows.flatMap((row) => row.cells);
    expect(cells[5].state).toBe("candidate");
    expect(cells[8].state).toBe("candidate");
    expect(cells[4].state).toBe("own");
    expect(cells[9].state).toBe("free");
  });

  it("压到别的部位时只有重叠那几颗画斜纹（选区其余部分照常高亮）", () => {
    const draft: [number, number] = [8, 12];
    const conflict = findConflict(parts, draft, { partId: 0, segIndex: 0 });
    const rows = gridRowsView(20, 10, parts, 0, draft, conflict);
    const cells = rows.flatMap((row) => row.cells);
    expect(cells[8].state).toBe("candidate");
    expect(cells[10].state).toBe("blocked");
    expect(cells[12].state).toBe("blocked");
    /* 13–14 仍归部位 1（不在本次选区里），15 起是空闲。 */
    expect(cells[13].state).toBe("other");
    expect(cells[15].state).toBe("free");
  });
});

describe("线视图", () => {
  it("色块比例与它实际占的灯珠一致，空隙不产生块", () => {
    const blocks = lineBlocks([part(0, [[0, 4]]), part(1, [[20, 29]])], 30, 0);
    expect(blocks.length).toBe(2);
    expect(blocks[0].leftPercent).toBe(0);
    expect(blocks[0].widthPercent).toBeCloseTo((5 / 30) * 100, 6);
    expect(blocks[1].leftPercent).toBeCloseTo((20 / 30) * 100, 6);
    expect(blocks[1].widthPercent).toBeCloseTo((10 / 30) * 100, 6);
    /* 第 6..20 颗没块 = 灰缝。 */
    expect(blocks[0].end).toBe(4);
    expect(blocks[1].start).toBe(20);
  });

  it("按灯珠序号升序（即使部位里段是乱序写的）", () => {
    const blocks = lineBlocks([part(0, [[20, 25], [1, 5]])], 30);
    expect(blocks.map((block) => block.start)).toEqual([1, 20]);
  });

  it("当前编辑的部位被标出来，颜色按部位号稳定", () => {
    const blocks = lineBlocks([part(1, [[0, 4]]), part(2, [[5, 9]])], 10, 2);
    expect(blocks.find((block) => block.partId === 2)?.current).toBe(true);
    expect(blocks.find((block) => block.partId === 1)?.current).toBe(false);
    expect(partColor(1)).toBe(partColor(1));
    expect(partColor(1)).not.toBe(partColor(2));
  });

  it("区间文字从 1 起，整条时特别标注", () => {
    expect(rangeTextOf([[0, 29]], 30)).toBe("1–30（整条）");
    expect(rangeTextOf([[0, 4]], 30)).toBe("1–5");
    expect(rangeTextOf([[0, 4], [20, 24]], 30)).toBe("1–5、21–25");
    expect(rangeTextOf([], 30)).toBe("未划灯珠");
  });
});

describe("整份校验（固件同一份规则）", () => {
  it("合法布局通过", () => {
    expect(validateLayout([part(0, [[0, 9]]), part(1, [[10, 19]])], 30)).toBeNull();
  });

  it("越界比冲突更根本（先报越界）", () => {
    const issue = validateLayout([part(0, [[0, 40]])], 30);
    expect(issue?.partId).toBe(0);
    expect(issue?.message).toContain("超出");
  });

  it("部位数超 8 被拒", () => {
    const many = Array.from({ length: 9 }, (_, index) => part(index, [[index, index]]));
    expect(validateLayout(many, 30)?.message).toContain("8 个部位");
  });

  it("一个部位超 8 段被拒", () => {
    const segs = Array.from({ length: 9 }, (_, index) => [index * 2, index * 2] as [number, number]);
    expect(validateLayout([part(0, segs)], 30)?.message).toContain("8 段");
  });

  it("跨部位重叠被拒，并说清是谁", () => {
    const issue = validateLayout([part(0, [[0, 9]]), part(1, [[5, 19]])], 30);
    expect(issue?.partId).toBe(0);
    expect(issue?.message).toContain("部位 2");
  });
});

describe("段表编辑", () => {
  const parts = [part(0, [[0, 9]]), part(1, [[10, 19]])];

  it("加一段成功时返回新表，不改入参", () => {
    const result = addSeg(parts, 0, [20, 24], 30);
    expect("segs" in result && result.segs).toEqual([[0, 9], [20, 24]]);
    expect(parts[0].segs).toEqual([[0, 9]]);
  });

  it("压到别的部位 → 拒绝并说清重叠的那颗", () => {
    /* [8,12] 先撞上部位 0 的 [0,9]（第 9–10 颗，1 起）。 */
    const result = addSeg(parts, 0, [8, 12], 30);
    expect("error" in result && result.error).toContain("9–10 颗已被部位 1 占用");
  });

  it("超出链长 → 拒绝", () => {
    expect("error" in addSeg(parts, 0, [0, 99], 30)).toBe(true);
  });

  it("满 8 段 → 拒绝", () => {
    const full = [part(0, Array.from({ length: 8 }, (_, i) => [i, i] as [number, number]))];
    expect("error" in addSeg(full, 0, [20, 20], 30)).toBe(true);
  });

  it("删一段永远成功", () => {
    const result = replaceSeg(parts, 0, 0, null, 30);
    expect("segs" in result && result.segs).toEqual([]);
  });

  it("把一段改到别人的地盘 → 拒绝（不裁剪、不覆盖）", () => {
    const result = replaceSeg(parts, 0, 0, [5, 12], 30);
    expect("error" in result && result.error).toContain("占用");
  });

  it("改自己是允许的", () => {
    const result = replaceSeg(parts, 0, 0, [2, 7], 30);
    expect("segs" in result && result.segs).toEqual([[2, 7]]);
  });

  it("写回布局时 segCount 跟着段数走", () => {
    const next = withSegs(parts, 0, [[0, 4], [20, 24]]);
    expect(next[0].segCount).toBe(2);
    expect(next[1].segs).toEqual([[10, 19]]);
  });
});
