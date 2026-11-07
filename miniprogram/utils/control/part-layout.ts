/**
 * 部位布局（#156）：灯珠段怎么划、方格表怎么折行、拖选落在哪一颗。
 *
 * ## 为什么单独一层
 *
 * 「一颗灯珠只能属一个部位」这条规则在固件里已经实现（`layout_store.c` 的
 * `seg_conflicts` / `lumen_layout_store_validate`），但界面**不能等设备拒绝**：
 *
 *  - 拖选压到别的部位时要**整体拒绝**并画斜纹（S4），那得在松手之前就知道；
 *  - 方格表的折行、每 10 颗的分隔、单元格矩形命中都是纯几何，改一次要验一次；
 *  - 逻辑下标（连续相位 / 各自起点）必须与 `lumen_layout_logical_index` 逐字节一致，
 *    否则「多段跑波」在手机上和在灯上会是两种样子。
 *
 * 所以这里放的是**设备规则的客户端镜像**，不是新规则。两边分叉的话，症状是
 * 「界面允许、设备回 InvalidParam」，而 `tests/part-layout.test.ts` 会先红。
 *
 * 纯函数、不碰 wx / BLE / 页面。
 */

import { MAX_PARTS, MAX_PART_SEGS, NAME_BYTES, PART_NONE, PHASE, type PhaseMode } from "../protocol/constants";
import type { LayoutPart } from "../protocol/types";

/** 一个闭区间灯珠段 `[start, end]`，与 `LayoutPart.segs` 的元素同形。 */
export type PartSeg = [number, number];

/* 相位模式的常量住在协议层（它随 LayoutPart 上线、也进 blob），这里只转发。 */
export { PHASE, type PhaseMode } from "../protocol/constants";

/* ---------------- 单段与区间 ---------------- */

/** 区间是否合法（两颗都在 0..ledCount-1，且 start ≤ end）。 */
export function isValidSeg(seg: PartSeg, ledCount: number): boolean {
  const [start, end] = seg;
  return (
    Number.isInteger(start) &&
    Number.isInteger(end) &&
    start >= 0 &&
    end >= start &&
    end < ledCount
  );
}

/** 两段是否有交集（闭区间，端点相接算冲突）。 */
export function segsOverlap(a: PartSeg, b: PartSeg): boolean {
  return a[0] <= b[1] && b[0] <= a[1];
}

/**
 * 把两个端点整理成 `[start, end]`（拖选时锚点可能大于落点）。
 *
 * 非有限值 / 非整数返回 `null`——宁可不动，也不要把一次半截的触摸事件
 * 变成一次「从第 NaN 颗开始」的写入。
 */
export function normalizeRange(a: number, b: number): PartSeg | null {
  if (!Number.isInteger(a) || !Number.isInteger(b)) {
    return null;
  }
  return a <= b ? [a, b] : [b, a];
}

/** 段覆盖的灯珠数。 */
export function segLength(seg: PartSeg): number {
  return seg[1] >= seg[0] ? seg[1] - seg[0] + 1 : 0;
}

/** 一个部位覆盖的灯珠总数（与固件 `lumen_layout_part_pixel_count` 同口径）。 */
export function partPixelCount(part: Pick<LayoutPart, "segs">): number {
  let total = 0;
  for (const seg of part.segs) {
    total += segLength(seg);
  }
  return total;
}

/* ---------------- 互斥：S3 / S4 ---------------- */

/** 一段冲突的详情（谁挡住了这一次拖选）。 */
export interface SegConflict {
  /** 挡住它的部位号。 */
  partId: number;
  /** 挡住它的段在**那个部位**里的下标。 */
  segIndex: number;
  /** 挡住它的区间。 */
  seg: PartSeg;
  /** 与候选区间重叠的那一小段（画斜纹只画这一段）。 */
  overlap: PartSeg;
}

/**
 * 候选段是否压到了任何**别的**段。
 *
 * `ignore` 用于「编辑自己这一段」：改自己的区间时不该被自己挡住。
 * 同一部位的其它段**也要检查**（一个部位内部同样不能重叠——那会让逻辑下标
 * 出现重号，固件同样会拒）。
 */
export function findConflict(
  parts: readonly Pick<LayoutPart, "partId" | "segs">[],
  candidate: PartSeg,
  ignore: { partId: number; segIndex: number } | null,
): SegConflict | null {
  for (const part of parts) {
    for (let segIndex = 0; segIndex < part.segs.length; segIndex += 1) {
      if (
        ignore !== null &&
        part.partId === ignore.partId &&
        segIndex === ignore.segIndex
      ) {
        continue;
      }
      const seg = part.segs[segIndex];
      if (!segsOverlap(candidate, seg)) {
        continue;
      }
      return {
        partId: part.partId,
        segIndex,
        seg,
        overlap: [
          Math.max(candidate[0], seg[0]),
          Math.min(candidate[1], seg[1]),
        ],
      };
    }
  }
  return null;
}

/* ---------------- 归属矩阵与逻辑下标 ---------------- */

/**
 * 「第 i 颗灯归哪个部位」的归属表（空闲为 `PART_NONE`）。
 *
 * 与固件 `lumen_layout_part_of_pixel` 同语义：按部位号升序、段号升序取第一个
 * 命中者。正常布局里不会有两个部位抢同一颗（互斥已校验），这里保留「先到先得」
 * 只是为了让坏数据也有确定行为。
 */
export function ownershipOf(
  parts: readonly Pick<LayoutPart, "partId" | "segs">[],
  ledCount: number,
): Uint8Array {
  const owner = new Uint8Array(Math.max(0, ledCount));
  owner.fill(PART_NONE);
  for (const part of parts) {
    for (const seg of part.segs) {
      const start = Math.max(0, seg[0]);
      const end = Math.min(ledCount - 1, seg[1]);
      for (let i = start; i <= end; i += 1) {
        if (owner[i] === PART_NONE) {
          owner[i] = part.partId;
        }
      }
    }
  }
  return owner;
}

/**
 * 某颗灯在该部位里的**逻辑下标**——固件 `lumen_layout_logical_index` 的镜像。
 *
 * 连续相位：数「所有段里严格小于它的灯珠有多少颗」，也就是升序名次。
 * 各自起点：段内偏移（第二段的第一颗也是 0）。
 *
 * 与固件一样**不排序**段（`LayoutSeg` 是逐条写的，顺序不可信），所以两种相位
 * 都用「计数」而不是「累加前面段长」——后者对乱序段会算错。
 *
 * 不在该部位覆盖范围内时返回 0（调用方不该问）。
 */
export function logicalIndexOf(
  part: Pick<LayoutPart, "segs">,
  index: number,
  phase: PhaseMode = PHASE.CONTINUOUS,
): number {
  if (phase === PHASE.PER_SEGMENT) {
    for (const seg of part.segs) {
      if (index >= seg[0] && index <= seg[1]) {
        return index - seg[0];
      }
    }
    return 0;
  }
  let offset = 0;
  let inside = false;
  for (const seg of part.segs) {
    if (index >= seg[0] && index <= seg[1]) {
      inside = true;
    }
    if (seg[0] < index) {
      /* 只数到 index-1 为止，避免跨过 index 之后多算。 */
      const upper = Math.min(seg[1], index - 1);
      if (seg[0] <= upper) {
        offset += upper - seg[0] + 1;
      }
    }
  }
  return inside ? offset : 0;
}

/**
 * 逻辑下标 → 物理灯珠序号（`logicalIndexOf` 的反函数）。
 *
 * 渲染用不着它（固件按物理位置散回），但「部位内的波从哪一颗起」在界面上要
 * 能指出来；预览条也按它逐颗上色。越界返回 -1。
 */
export function pixelAtLogical(
  part: Pick<LayoutPart, "segs">,
  logical: number,
  phase: PhaseMode = PHASE.CONTINUOUS,
): number {
  if (!Number.isInteger(logical) || logical < 0) {
    return -1;
  }
  const total = partPixelCount(part);
  if (logical >= total) {
    return -1;
  }
  /* 灯珠总数 ≤ 100，直接逐颗问比维护一张反查表更省事，也没有排序假设。 */
  for (let index = 0; index < 100; index += 1) {
    const inside = part.segs.some((seg) => index >= seg[0] && index <= seg[1]);
    if (inside && logicalIndexOf(part, index, phase) === logical) {
      return index;
    }
  }
  return -1;
}

/* ---------------- 方格表几何（U5 / U7） ---------------- */

/** 十年段（每 10 颗一个加粗分隔并标序号）。 */
export const GRID_DECADE = 10;
/** 方格表最少列数（太窄会让一屏滚不完）。 */
export const GRID_MIN_COLUMNS = 5;
/** 方格表最多列数（再宽单格就太小，手指点不准）。 */
export const GRID_MAX_COLUMNS = 20;
/** 单格的最小边长（px，与 time-line 的 `MIN_BLOCK_PX` 同一量级）。 */
export const GRID_CELL_MIN_PX = 26;

/**
 * 方格表折成几列。
 *
 * 优先折成 `GRID_DECADE` 的整数倍：这样每一行正好是一个或几个十年段，
 * 「每 10 颗加粗分隔」落在行首而不是行中间。灯珠不足 10 颗时没有十年段可言，
 * 直接按可用宽度折。
 *
 * **对齐只能向下**：向上补到 20 列会让单格挤到最小边长以下（420px 只放得下
 * 16 格），手指就点不准了。宁可每行少一个十年段。
 *
 * `availablePx <= 0`（还没量到）时退回一屏 10 列——100 颗灯的常见形态下首帧
 * 就是对的，不会先画成一根。
 */
export function gridColumns(ledCount: number, availablePx: number): number {
  const total = Math.max(1, Math.floor(ledCount));
  if (!Number.isFinite(availablePx) || availablePx <= 0) {
    return Math.min(total, GRID_DECADE);
  }
  const fit = Math.max(1, Math.floor(availablePx / GRID_CELL_MIN_PX));
  const ceiling = Math.min(GRID_MAX_COLUMNS, total);
  /* 「至少 5 列」是下限，但灯珠不够时不能超过总数（3 颗不该画成 5 格）。 */
  const floorColumns = Math.min(GRID_MIN_COLUMNS, ceiling);
  let columns = Math.min(ceiling, Math.max(floorColumns, fit));
  if (total >= GRID_DECADE * 2) {
    const snapped = Math.floor(columns / GRID_DECADE) * GRID_DECADE;
    if (snapped >= GRID_DECADE) {
      columns = snapped;
    }
  }
  return Math.max(1, columns);
}

/** 方格表里的一格。 */
export interface GridCell {
  /** 物理灯珠序号（0 起）。 */
  index: number;
  /** 用户看到的序号（1 起）。 */
  label: string;
  /** 是不是十年段的起点（渲染时左侧加粗分隔）。 */
  decadeStart: boolean;
}

/**
 * 带归属与选区的格子（渲染用的完整形态）。
 *
 * 四类状态是**互斥**的，页面只按一个 `state` 上样式，不需要在 wxml 里拼条件：
 *
 *  - `free`      空闲（灰）；
 *  - `own`       属于当前编辑的部位（该部位色）；
 *  - `other`     被别的部位占着（别的部位色，通常还压暗）；
 *  - `candidate` 在本次拖选里（高亮）；
 *  - `blocked`   在本次拖选里、但与别的部位重叠（斜纹 + 提示，S4）。
 */
export type GridCellState = "free" | "own" | "other" | "candidate" | "blocked";

export interface GridCellView extends GridCell {
  state: GridCellState;
  /** 归属部位号；空闲为 `PART_NONE`。 */
  ownerPartId: number;
  /** 归属部位的色（空闲为默认灰，由 wxss 决定）。 */
  color: string;
}

/** 方格表的一行。 */
export interface GridRow {
  key: string;
  cells: GridCell[];
}

/** 把 0..ledCount-1 折成多行（行内按序号升序）。 */
export function gridRows(ledCount: number, columns: number): GridRow[] {
  const total = Math.max(0, Math.floor(ledCount));
  const perRow = Math.max(1, Math.floor(columns));
  const rows: GridRow[] = [];
  for (let start = 0; start < total; start += perRow) {
    const cells: GridCell[] = [];
    for (let index = start; index < Math.min(total, start + perRow); index += 1) {
      cells.push({
        index,
        label: String(index + 1),
        decadeStart: index > 0 && index % GRID_DECADE === 0,
      });
    }
    rows.push({ key: `row-${start}`, cells });
  }
  return rows;
}

/** 一个格子在屏幕上的矩形（`createSelectorQuery` 的量测结果）。 */
export interface CellRect {
  index: number;
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/**
 * 方格表的一行（带归属与本次拖选的高亮）。
 *
 * `state` 决定样式：空闲灰 / 自己的部位色 / 别的部位色 / 本次选区高亮 /
 * 本次选区压到别人（斜纹）。**斜纹只画在真正重叠的那几颗上**（S4），
 * 所以用户的选区仍完整可见，只是有一段被标红。
 */
export interface GridRowView {
  key: string;
  cells: GridCellView[];
}

/**
 * 把方格表算成可直接渲染的行（`gridRows` + 归属 + 选中态）。
 *
 * `draft` 是本次拖选按住的区间（松手前为草稿，松手才落库）；
 * `conflict` 是它对别的部位的侵占。两者都为 null 时就是静态的归属视图。
 */
export function gridRowsView(
  ledCount: number,
  columns: number,
  parts: readonly Pick<LayoutPart, "partId" | "segs">[],
  currentPartId: number,
  draft: PartSeg | null = null,
  conflict: SegConflict | null = null,
): GridRowView[] {
  const owner = ownershipOf(parts, ledCount);
  const rows = gridRows(ledCount, columns);
  return rows.map((row) => ({
    key: row.key,
    cells: row.cells.map((cell): GridCellView => {
      const ownerPartId = owner[cell.index] ?? PART_NONE;
      const inDraft =
        draft !== null && cell.index >= draft[0] && cell.index <= draft[1];
      const blocked =
        inDraft &&
        conflict !== null &&
        cell.index >= conflict.overlap[0] &&
        cell.index <= conflict.overlap[1];
      let state: GridCellState;
      if (blocked) {
        state = "blocked";
      } else if (inDraft) {
        state = "candidate";
      } else if (ownerPartId === PART_NONE) {
        state = "free";
      } else if (ownerPartId === currentPartId) {
        state = "own";
      } else {
        state = "other";
      }
      return {
        ...cell,
        state,
        ownerPartId,
        color: ownerPartId === PART_NONE ? "" : partColor(ownerPartId),
      };
    }),
  }));
}

/**
 * 手指落在哪一格。
 *
 * 先找真正包含它的格子；都不包含（手指在两行之间、或滑出边界）时退回**最近的
 * 一格**——拖选横向划过一行时手指难免偏上偏下，直接返回 -1 会让选区频繁断开。
 *
 * 连最近的都够不着（远到不像是在这张表上）时返回 -1，调用方保持上一次的落点。
 */
export function gridIndexAtPoint(
  rects: readonly CellRect[],
  x: number,
  y: number,
  maxDistancePx = 64,
): number {
  if (rects.length === 0 || !Number.isFinite(x) || !Number.isFinite(y)) {
    return -1;
  }
  let best = -1;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const rect of rects) {
    if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) {
      return rect.index;
    }
    /* 到矩形的最短距离（点在矩形外时才有正值）。 */
    const dx = x < rect.left ? rect.left - x : x > rect.right ? x - rect.right : 0;
    const dy = y < rect.top ? rect.top - y : y > rect.bottom ? y - rect.bottom : 0;
    const distance = Math.hypot(dx, dy);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = rect.index;
    }
  }
  return bestDistance <= maxDistancePx ? best : -1;
}

/* ---------------- 线视图（U5） ---------------- */

/**
 * 线视图里的一块：某个部位占的一段灯珠。
 *
 * `leftPercent` / `widthPercent` 是相对整条链的比例，页面直接写进 `style`；
 * 空闲灯珠显示为灰缝（**不产生块**），所以「漏掉的灯珠」在线上一眼就看得见。
 */
export interface LineBlock {
  key: string;
  partId: number;
  segIndex: number;
  start: number;
  end: number;
  leftPercent: number;
  widthPercent: number;
  /** 色块颜色（`hsl()`，按部位号稳定派生）。 */
  color: string;
  /** 是不是当前正在编辑的部位。 */
  current: boolean;
  /** 用户看到的区间文字（1 起）：`1–5`。 */
  rangeText: string;
}

/**
 * 部位色：按部位号稳定派生的色相。
 *
 * 用 `hsl()` 而不是 hex——与 `effect-panel.ts` 的滑轨同一约定：它不写进 wxss，
 * 所以不违反「页面 wxss 不写死颜色」。相邻部位号相差 47°，8 个部位也不会有
 * 两个挨得太近的颜色。
 */
export function partColor(partId: number): string {
  const hue = (Math.max(0, Math.floor(partId)) * 47) % 360;
  return `hsl(${hue}, 62%, 52%)`;
}

/** 线视图的块（按灯珠序号升序；同一部位的多段各是一块）。 */
export function lineBlocks(
  parts: readonly Pick<LayoutPart, "partId" | "segs">[],
  ledCount: number,
  currentPartId = -1,
): LineBlock[] {
  const total = Math.max(1, Math.floor(ledCount));
  const blocks: LineBlock[] = [];
  for (const part of parts) {
    part.segs.forEach((seg, segIndex) => {
      const start = Math.max(0, Math.min(total - 1, seg[0]));
      const end = Math.max(start, Math.min(total - 1, seg[1]));
      blocks.push({
        key: `p${part.partId}-s${segIndex}`,
        partId: part.partId,
        segIndex,
        start,
        end,
        leftPercent: (start / total) * 100,
        widthPercent: ((end - start + 1) / total) * 100,
        color: partColor(part.partId),
        current: part.partId === currentPartId,
        rangeText: `${start + 1}–${end + 1}`,
      });
    });
  }
  blocks.sort((a, b) => a.start - b.start || a.partId - b.partId);
  return blocks;
}

/* ---------------- 整体校验（与固件同一份规则） ---------------- */

/** 一条校验失败的原因。 */
export interface LayoutIssue {
  /** 出问题的部位号；-1 = 整份（部位数超限）。 */
  partId: number;
  message: string;
}

/**
 * 一份布局能不能提交（`lumen_layout_store_validate` 的客户端镜像）。
 *
 * 顺序与固件一致：部位数 → 每部位段数 / 名字长度 → 每段区间 → 段互斥。
 * 返回**第一条**问题就够了——界面一次只提示一件事，而且「越界」比「冲突」
 * 更根本。
 */
export function validateLayout(
  parts: readonly LayoutPart[],
  ledCount: number,
): LayoutIssue | null {
  if (parts.length > MAX_PARTS) {
    return { partId: -1, message: `一条链最多 ${MAX_PARTS} 个部位` };
  }
  for (const part of parts) {
    if (part.segs.length > MAX_PART_SEGS) {
      return { partId: part.partId, message: `一个部位最多 ${MAX_PART_SEGS} 段` };
    }
    if (part.nameLen > NAME_BYTES) {
      return { partId: part.partId, message: `名字最多 ${NAME_BYTES} 字节` };
    }
    for (const seg of part.segs) {
      if (!isValidSeg(seg, ledCount)) {
        return {
          partId: part.partId,
          message: `第 ${seg[0] + 1}–${seg[1] + 1} 颗超出这条链（共 ${ledCount} 颗）`,
        };
      }
    }
  }
  for (const part of parts) {
    for (let segIndex = 0; segIndex < part.segs.length; segIndex += 1) {
      const conflict = findConflict(parts, part.segs[segIndex], {
        partId: part.partId,
        segIndex,
      });
      if (conflict !== null) {
        return {
          partId: part.partId,
          message: `第 ${part.segs[segIndex][0] + 1}–${part.segs[segIndex][1] + 1} 颗与部位 ${conflict.partId + 1} 重叠`,
        };
      }
    }
  }
  return null;
}

/* ---------------- 段表编辑 ---------------- */

/**
 * 把一段加进部位（不改入参）。成功返回新段表，失败返回 `null` 与原因。
 *
 * 三段上限、互斥、区间合法三条都在这里判；调用方拿到 `null` 就把 `message`
 * 显示给用户（S4：整体拒绝，不自动裁剪）。
 */
export function addSeg(
  parts: readonly LayoutPart[],
  partId: number,
  seg: PartSeg,
  ledCount: number,
): { segs: PartSeg[] } | { error: string } {
  const part = parts.find((item) => item.partId === partId);
  if (part === undefined) {
    return { error: "这个部位已经不存在" };
  }
  if (part.segs.length >= MAX_PART_SEGS) {
    return { error: `一个部位最多 ${MAX_PART_SEGS} 段` };
  }
  if (!isValidSeg(seg, ledCount)) {
    return { error: `区间超出 1–${ledCount}` };
  }
  const conflict = findConflict(parts, seg, null);
  if (conflict !== null) {
    return {
      error: `第 ${conflict.overlap[0] + 1}–${conflict.overlap[1] + 1} 颗已被部位 ${conflict.partId + 1} 占用`,
    };
  }
  return { segs: [...part.segs, seg] };
}

/**
 * 改某一段（换区间或删掉）。
 *
 * `next === null` 表示删除。删除与编辑都要重新跑互斥——编辑成别人的地盘一样
 * 要被拒（S4），而删除永远成功。
 */
export function replaceSeg(
  parts: readonly LayoutPart[],
  partId: number,
  segIndex: number,
  next: PartSeg | null,
  ledCount: number,
): { segs: PartSeg[] } | { error: string } {
  const part = parts.find((item) => item.partId === partId);
  if (part === undefined) {
    return { error: "这个部位已经不存在" };
  }
  if (segIndex < 0 || segIndex >= part.segs.length) {
    return { error: "这一段已经不存在" };
  }
  if (next === null) {
    return { segs: part.segs.filter((_, index) => index !== segIndex) };
  }
  if (!isValidSeg(next, ledCount)) {
    return { error: `区间超出 1–${ledCount}` };
  }
  const conflict = findConflict(parts, next, { partId, segIndex });
  if (conflict !== null) {
    return {
      error: `第 ${conflict.overlap[0] + 1}–${conflict.overlap[1] + 1} 颗已被部位 ${conflict.partId + 1} 占用`,
    };
  }
  return {
    segs: part.segs.map((seg, index) => (index === segIndex ? next : seg)),
  };
}

/** 把新的段表写回一份布局（不改入参；`segCount` 跟着段数走）。 */
export function withSegs(
  parts: readonly LayoutPart[],
  partId: number,
  segs: readonly PartSeg[],
): LayoutPart[] {
  return parts.map((part) =>
    part.partId === partId
      ? { ...part, segs: segs.map((seg) => [seg[0], seg[1]] as PartSeg), segCount: segs.length }
      : { ...part },
  );
}

/** 区间文字（用户视角 1 起）；空段表说「未划灯珠」。 */
export function rangeTextOf(
  segs: readonly PartSeg[],
  ledCount: number,
): string {
  if (segs.length === 0) {
    return "未划灯珠";
  }
  const pieces = segs.map(([start, end]) => `${start + 1}–${end + 1}`);
  const whole =
    segs.length === 1 && segs[0][0] === 0 && segs[0][1] >= Math.max(0, ledCount - 1);
  return whole ? `${pieces[0]}（整条）` : pieces.join("、");
}

/* ---------------- 读回补全 ---------------- */

/**
 * 把 `QueryLayout` 的读回补成「这条链上全部部位」。
 *
 * §7.2：**只有 `seg_count > 0` 的部位才会被报出来**。于是删掉一个部位的最后一
 * 段之后，它就从读回里消失了——但设备上它仍然存在（`State.partCounts` 里有），
 * 只是没有灯珠。不补的话页面会报「部位已不存在」，用户再也加不回去。
 *
 * `declared` 是 `State.partCounts[strip]`；低于它的空槽位补成「空段表」的部位。
 * 多报的部位（不该发生）原样保留，不丢数据。
 */
export function mergeDeclaredParts(
  reported: readonly LayoutPart[],
  declared: number,
  stripId: number,
): LayoutPart[] {
  const byId = new Map<number, LayoutPart>();
  for (const part of reported) {
    byId.set(part.partId, part);
  }
  const count = Math.max(0, Math.min(MAX_PARTS, Math.floor(declared) || 0));
  for (let partId = 0; partId < count; partId += 1) {
    if (!byId.has(partId)) {
      byId.set(partId, {
        stripId,
        partId,
        nameLen: 0,
        name: "",
        segCount: 0,
        /* 声明了但没划灯珠的部位：相位取默认的「连续」。 */
        phase: PHASE.CONTINUOUS,
        segs: [],
      });
    }
  }
  return [...byId.values()].sort((a, b) => a.partId - b.partId);
}
