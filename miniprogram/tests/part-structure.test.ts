/**
 * 结构区（#156）：方格拖选 / 滚轮微调 / 段增删 / 冲突拒绝。
 *
 * 这些用例走的是**页面自己的处理器**（不是纯函数），因为票面的验收项一半是
 * 「界面阻止了没阻止」：拖选压到别的部位时，用户看到的提示与设备**没收到**
 * 任何帧是同一件事的两面。纯函数只能证明前半句。
 *
 * 演示设备 0 的 strip 0 出厂是两个部位：0 = 1–14（前半）、1 = 15–30（后半）。
 */

import { describe, expect, it } from "vitest";
import { openPage } from "./helpers/page-harness";

/** 以「演示设备 0 的 strip 0 / 部位 0」打开部位页。 */
async function openPart() {
  return openPage("part", { strip: "0", part: "0" });
}

/** 触摸事件（方格表用 clientX / clientY 命中）。 */
function touch(dataset: Record<string, any> = {}, x = 0, y = 0): any {
  return {
    currentTarget: { dataset },
    touches: [{ clientX: x, clientY: y }],
    changedTouches: [{ clientX: x, clientY: y }],
    detail: {},
  };
}

/** 等条件成立。 */
async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("等超时");
}

/** 读回设备上某条链的布局（设备权威，不是页面缓存）。 */
async function deviceLayout(harness: any, stripId = 0) {
  const read = await harness.session.queryLayout(stripId);
  if (read.kind !== "ok") {
    throw new Error(`读布局失败：${read.kind}`);
  }
  return read.layout;
}

describe("结构区：线视图与段数", () => {
  it("线视图的块与该部位实际占的灯珠一致，空闲灯珠留成灰缝", async () => {
    const harness = await openPart();
    try {
      const blocks = harness.page.data.lineBlocks as Array<{
        partId: number;
        start: number;
        end: number;
        current: boolean;
      }>;
      /* 出厂：部位 0 = 0..13，部位 1 = 14..29。 */
      expect(blocks.length).toBe(2);
      expect([blocks[0].start, blocks[0].end]).toEqual([0, 13]);
      expect([blocks[1].start, blocks[1].end]).toEqual([14, 29]);
      expect(blocks[0].current).toBe(true);
      expect(harness.page.data.coveredCount).toBe(30);
      expect(harness.page.data.stripLedCount).toBe(30);
    } finally {
      await harness.dispose();
    }
  });

  it("段数与颗数显示当前部位的真实值", async () => {
    const harness = await openPart();
    try {
      expect(harness.page.data.segCount).toBe(1);
      expect(harness.page.data.pixelCount).toBe(14);
      expect(harness.page.data.rangeText).toBe("1–14");
    } finally {
      await harness.dispose();
    }
  });
});

describe("方格表：拖选成段", () => {
  it("拖出一段松手后正确落库", async () => {
    const harness = await openPart();
    try {
      /* 先把部位 0 缩到 1–5，腾出 6–14 用来拖。 */
      harness.page.openGrid(0);
      harness.page.onStartPick({ detail: { value: 0 } });
      harness.page.onEndPick({ detail: { value: 4 } });
      await harness.page.onGridConfirm();
      await waitFor(() => harness.page.data.segCount === 1 && harness.page.data.pixelCount === 5);

      /* 再拖一段 6–10（0 起 5..9）。 */
      harness.page.onOpenGridAdd();
      harness.page.onGridTouchStart(touch({ index: 5 }));
      harness.page.onGridTouchMove(touch({ index: 9 }));
      harness.page.onGridTouchEnd();
      expect(harness.page.data.draftStartText).toBe("6");
      expect(harness.page.data.draftEndText).toBe("10");
      expect(harness.page.data.draftConflict).toBe("");

      await harness.page.onGridConfirm();
      await waitFor(() => harness.page.data.segCount === 2);

      const layout = await deviceLayout(harness);
      const part0 = layout.parts.find((part: any) => part.partId === 0);
      expect(part0?.segs).toEqual([
        [0, 4],
        [5, 9],
      ]);
    } finally {
      await harness.dispose();
    }
  });

  it("一个部位可以占多段不连续灯珠", async () => {
    const harness = await openPart();
    try {
      /* 把第一段改成 1–5，再加一段 20–24（部位 1 出厂占 15–30，先缩掉）。 */
      await harness.session.writeLayout(0, [
        { stripId: 0, partId: 0, nameLen: 0, name: "", segCount: 1, segs: [[0, 13]] },
      ]);
      await harness.page.load();

      harness.page.openGrid(0);
      harness.page.onStartPick({ detail: { value: 0 } });
      harness.page.onEndPick({ detail: { value: 4 } });
      await harness.page.onGridConfirm();
      await waitFor(() => harness.page.data.pixelCount === 5);

      harness.page.onOpenGridAdd();
      harness.page.onGridTouchStart(touch({ index: 19 }));
      harness.page.onGridTouchMove(touch({ index: 23 }));
      harness.page.onGridTouchEnd();
      expect(harness.page.data.draftConflict).toBe("");
      await harness.page.onGridConfirm();
      await waitFor(() => harness.page.data.segCount === 2);

      const layout = await deviceLayout(harness);
      const part0 = layout.parts.find((part: any) => part.partId === 0);
      /* 段按段号顺序写：第 0 段 0..4，第 1 段 19..23。 */
      expect(part0?.segs).toEqual([
        [0, 4],
        [19, 23],
      ]);
      /* 两段共享同一效果：颗数 = 5 + 5。 */
      expect(harness.page.data.pixelCount).toBe(10);
    } finally {
      await harness.dispose();
    }
  });

  it("数字滚轮能把一段微调到单颗", async () => {
    const harness = await openPart();
    try {
      harness.page.openGrid(0);
      harness.page.onStartPick({ detail: { value: 6 } });
      harness.page.onEndPick({ detail: { value: 6 } });
      expect(harness.page.data.draftStartText).toBe("7");
      expect(harness.page.data.draftEndText).toBe("7");
      await harness.page.onGridConfirm();
      await waitFor(() => harness.page.data.pixelCount === 1);

      const layout = await deviceLayout(harness);
      const part0 = layout.parts.find((part: any) => part.partId === 0);
      expect(part0?.segs).toEqual([[6, 6]]);
    } finally {
      await harness.dispose();
    }
  });

  it("反向拖动（锚点大于落点）也能成段", async () => {
    const harness = await openPart();
    try {
      harness.page.openGrid(0);
      harness.page.onGridTouchStart(touch({ index: 9 }));
      harness.page.onGridTouchMove(touch({ index: 4 }));
      expect(harness.page.data.draftStartText).toBe("5");
      expect(harness.page.data.draftEndText).toBe("10");
    } finally {
      await harness.dispose();
    }
  });
});

describe("方格表：压到别的部位 → 整体拒绝（S4）", () => {
  it("拖选压到别的部位：斜纹 + 提示，且设备一帧都没收到", async () => {
    const harness = await openPart();
    try {
      const before = await deviceLayout(harness);
      const sentBefore = harness.transport.writes?.length ?? 0;

      harness.page.onOpenGridAdd();
      /* 部位 0 自己占 0..13：拖 10..20 先撞上自己，再撞部位 1。 */
      harness.page.onGridTouchStart(touch({ index: 10 }));
      harness.page.onGridTouchMove(touch({ index: 20 }));
      harness.page.onGridTouchEnd();

      expect(harness.page.data.draftConflict).toContain("占用");
      /* 被占的格子画斜纹（只有重叠那几颗，选区其余部分照常高亮）。 */
      const cells = (harness.page.data.gridRows as any[]).flatMap((row) => row.cells);
      expect(cells[10].state).toBe("blocked");
      expect(cells[13].state).toBe("blocked");
      expect(cells[20].state).toBe("candidate");

      /* 按确认也不该发帧。 */
      await harness.page.onGridConfirm();
      const sentAfter = harness.transport.writes?.length ?? 0;
      expect(sentAfter).toBe(sentBefore);

      const after = await deviceLayout(harness);
      expect(after.parts).toEqual(before.parts);
    } finally {
      await harness.dispose();
    }
  });

  it("压到空隙上不算冲突（可以正常落库）", async () => {
    const harness = await openPart();
    try {
      /* 空隙只有第 14..29 之外没有——出厂时整条链被两个部位占满，
         所以先把部位 1 缩到 1 段让出尾部。 */
      await harness.session.writeLayout(0, [
        {
          stripId: 0,
          partId: 0,
          nameLen: 0,
          name: "",
          segCount: 1,
          segs: [[0, 9]],
        },
      ]);
      await harness.page.load();

      harness.page.onOpenGridAdd();
      harness.page.onGridTouchStart(touch({ index: 15 }));
      harness.page.onGridTouchMove(touch({ index: 20 }));
      expect(harness.page.data.draftConflict).toBe("");
    } finally {
      await harness.dispose();
    }
  });
});

describe("段的编辑与删除", () => {
  it("点已有的段 → 菜单里有编辑与删除；点删除后那几颗灯变黑", async () => {
    const harness = await openPart();
    try {
      harness.page.onLineBlockTap(touch({ partId: 0, segIndex: 0 }));
      expect(harness.sheets.at(-1)).toEqual(["编辑这一段", "删除这一段"]);

      harness.sheetAnswer.tapIndex = 1;
      harness.page.onLineBlockTap(touch({ partId: 0, segIndex: 0 }));
      await waitFor(() => harness.page.data.segCount === 0);

      const layout = await deviceLayout(harness);
      /* 0 段的部位不会出现在读回里（§7.2），但设备上仍在。 */
      const part0 = layout.parts.find((part: any) => part.partId === 0);
      expect(part0).toBeUndefined();
      /* 页面按 State.partCounts 把它补回来了，所以还能继续编辑。 */
      expect(harness.page.data.pixelCount).toBe(0);
      expect(harness.page.data.rangeText).toBe("未划灯珠");
      /* 那 14 颗不再归任何人 → 灰缝（覆盖数从 30 掉到 16）。 */
      expect(harness.page.data.coveredCount).toBe(16);
    } finally {
      await harness.dispose();
    }
  });

  it("点编辑只改这一段", async () => {
    const harness = await openPart();
    try {
      harness.sheetAnswer.tapIndex = 0;
      harness.page.onLineBlockTap(touch({ partId: 0, segIndex: 0 }));
      expect(harness.page.data.gridOpen).toBe(true);
      expect(harness.page.data.editingSegIndex).toBe(0);
      /* 打开时草稿就是那一段。 */
      expect(harness.page.data.draftStartText).toBe("1");
      expect(harness.page.data.draftEndText).toBe("14");

      harness.page.onEndPick({ detail: { value: 9 } });
      await harness.page.onGridConfirm();
      await waitFor(() => harness.page.data.pixelCount === 10);

      const layout = await deviceLayout(harness);
      const part0 = layout.parts.find((part: any) => part.partId === 0);
      expect(part0?.segs).toEqual([[0, 9]]);
      /* 别的部位一块灯珠都没变。 */
      const part1 = layout.parts.find((part: any) => part.partId === 1);
      expect(part1?.segs).toEqual([[14, 29]]);
    } finally {
      await harness.dispose();
    }
  });

  it("点别的部位的段不弹菜单（编辑只改当前部位）", async () => {
    const harness = await openPart();
    try {
      const before = harness.sheets.length;
      harness.page.onLineBlockTap(touch({ partId: 1, segIndex: 0 }));
      expect(harness.sheets.length).toBe(before);
    } finally {
      await harness.dispose();
    }
  });
});

describe("整份校验：越界与超限", () => {
  it("滚轮选到链尾之外被拒（滚轮候选只到链长，本地校验兜住）", async () => {
    const harness = await openPart();
    try {
      harness.page.openGrid(0);
      /* 伪造一个越界值（真实 picker 给不出，但校验必须在）。 */
      harness.page.onEndPick({ detail: { value: 99 } });
      await harness.page.onGridConfirm();
      expect(harness.page.data.applyError).toContain("超出");
    } finally {
      await harness.dispose();
    }
  });

  it("满 8 段时「+ 选区」直接提示而不是打开空弹窗", async () => {
    const harness = await openPart();
    try {
      harness.page.setData({ segCount: 8 });
      harness.page.onOpenGridAdd();
      expect(harness.page.data.gridOpen).toBe(false);
      expect(harness.page.data.applyError).toContain("8 段");
    } finally {
      await harness.dispose();
    }
  });
});
