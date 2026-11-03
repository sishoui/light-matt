/**
 * 时间轴与时长（进阶档第一层，#65）。
 *
 * ## 为什么这层是纯逻辑
 *
 * 「时间轴按各步骤的时长分配宽度」看起来是一行 CSS，真正的坑在边界：一个
 * 0.5 秒的步骤在八个步骤并列时只有几个像素宽，手指点不到。
 *
 * 三个理由让它必须在 JS 里算：
 *
 *  1. **最小宽度与容器宽度会打架**。八个步骤时 8×24px 保底 + 7 个间隙 = 248px，
 *     窄屏或大字号下仍可能放不下。这里先压缩间隙（8px → 4px），再不行退化为
 *     均分——但**行宽永远等于容器宽**，页面不再横向滚动（#76）；
 *  2. **拖动重排要按块命中**。落点、`showLabel`、盒宽都是这一层算出来的具体
 *     数字，渲染层不复算，避免「显示宽度」与「命中宽度」两套真相；
 *  3. **边界只能单测**。0.4 秒 / 30.1 秒 / 单个步骤 / 八个步骤 / 越界拖动——在模拟器上
 *     全凭肉眼，规则本身必须能直接构造输入断言输出。
 *
 * 页面只负责事件与 `setData`，不做算术。纯函数、不碰 wx / BLE。
 *
 * ## 宽度分配：水位法到底做了什么
 *
 * 记 `available = 容器宽 - 间隙 × (块数 - 1)`，每个块按 `duration / 总时长` 得到
 * 理想宽度。凡是理想宽度低于 `MIN_BLOCK_PX` 的块，被**钉**在最小宽度；剩下的
 * 宽度在没被钉住的块之间按各自时长重新分配。重复直到没有新的块需要被钉住。
 *
 * 于是：
 *
 *  - 没触发保底时，宽度严格与时长成比例（水位法不会改变比例）；
 *  - 触发保底时，被钉住的块正好 `MIN_BLOCK_PX`，**其余块彼此之间仍然严格成比例**
 *    —— 这就是「极端分布下比例语义不变」的确切含义；
 *  - 保底的总和已经放不下时（例：八个块抢一个比 220px 还窄的可用宽度），
 *    水位法没有解，退化为**均分**：每块 `available / 块数`。此时时长不再决定
 *    宽度，但每个块都还有宽度、都点得到，界面不会溢出，用户仍能选中 / 拖动。
 *
 * 页面把分配结果以 `flex: <px> 0 0%` 交给 CSS：权重和就是可用宽度，浏览器
 * 复现的正是算出来的宽度；未测量到行宽时退回 `flex: <时长> 0 0%`（真正的
 * 时长比例）+ CSS `min-width`，只是首帧的临时形态。
 *
 * 行宽本身由 `timelineRowWidth` 决定：**恒等于容器宽**（未测量时退回
 * 「块数 × 最小宽 + 间隙」）。间隙由 `chooseGap` 在 8px / 4px 之间降级。
 */

/** 时长下限：0.5 秒。 */
export const MIN_DURATION_MS = 500;
/** 时长上限：30 秒。 */
export const MAX_DURATION_MS = 30000;
/** 时长的最小单位：0.5 秒。 */
export const DURATION_STEP_MS = 500;
/** 新步骤的默认时长：1 秒。 */
export const DEFAULT_STEP_MS = 1000;
/** 刚进进阶档时有几个步骤。光区轴按「当前步骤」取，默认给两个才看得出步骤间差异。 */
export const DEFAULT_STEP_COUNT = 2;
/** 时间轴最多 8 个步骤（与协议每套方案 8 个步骤一致）。 */
export const MAX_STEPS = 8;
/** 时间轴块的最小宽度（px）：0.5 秒的步骤在多块并列时仍然点得到。 */
export const MIN_BLOCK_PX = 24;
/** 块与块之间的间隙（px）；必须与 `strip.wxss` 的 `.timeline-row { gap }` 一致。 */
export const BLOCK_GAP_PX = 8;
/** 放不下时收缩到的间隙（px）。 */
export const COMPACT_BLOCK_GAP_PX = 4;
/**
 * 长按进入拖动状态的阈值（毫秒）。
 *
 * 300ms：够短，按住就有反应；又长于一次普通点击的按下时长，不会与「点一下
 * 选中」抢事件（#82 从 380ms 收紧）。
 */
export const LONG_PRESS_MS = 300;
/** 被拖的块抬起的放大倍数（#82）。 */
export const DRAG_LIFT_SCALE = 1.06;
/** 拖动结束后抑制紧随其后那次 tap 的时长（毫秒）。 */
export const DRAG_TAP_SUPPRESS_MS = 300;
/** 块窄到这个宽度以下就不画时长文字（会溢出到邻块上）。 */
export const LABEL_MIN_PX = 48;
/** 时长条的三个刻度（下方文字用）。 */
export const DURATION_TICKS_MS = [MIN_DURATION_MS, 15000, MAX_DURATION_MS] as const;

/* ---------------- 时长 ---------------- */

/**
 * 时长钳位：0.5–30 秒、四舍五入到最近的 0.5 秒。
 *
 * 非有限值（NaN / Infinity）当成「没说」→ 返回默认 1 秒，页面不会因为一次
 * 半个滑块事件把时长清成 0。
 */
export function clampDuration(ms: number): number {
  if (!Number.isFinite(ms)) {
    return DEFAULT_STEP_MS;
  }
  const stepped = Math.round(ms / DURATION_STEP_MS) * DURATION_STEP_MS;
  return Math.max(MIN_DURATION_MS, Math.min(MAX_DURATION_MS, stepped));
}

/** 一共多少个可选时长（0.5 / 1 / … / 30 秒，含两端）。 */
export function durationSteps(): number {
  return Math.round((MAX_DURATION_MS - MIN_DURATION_MS) / DURATION_STEP_MS) + 1;
}

/** 时长条的滑块值（秒）。 */
export function durationSeconds(ms: number): number {
  return clampDuration(ms) / 1000;
}

/** 「0.5 秒」/「15 秒」/「30 秒」。界面只用秒，不出现毫秒。 */
export function durationText(ms: number): string {
  return `${clampDuration(ms) / 1000} 秒`;
}

/**
 * 时长条上滑块的位置（0-100）。
 *
 * 线性映射：0.5 秒在左端、30 秒在右端，中间刻度 15 秒落在 49.2% 而不是正中
 * ——区间不是以 15 对称的（0.5–15 与 15–30 分别是 14.5 / 15 秒）。
 */
export function durationPercent(ms: number): number {
  const clamped = clampDuration(ms);
  return ((clamped - MIN_DURATION_MS) / (MAX_DURATION_MS - MIN_DURATION_MS)) * 100;
}

/** 时长条上的位置（0-1）→ 时长（已钳位到 0.5–30 秒、0.5 秒为单位）。 */
export function durationFromRatio(ratio: number): number {
  const value = Number.isFinite(ratio) ? Math.max(0, Math.min(1, ratio)) : 0;
  return clampDuration(MIN_DURATION_MS + value * (MAX_DURATION_MS - MIN_DURATION_MS));
}

/** 时长条上三个刻度的对齐方式（两端不越出容器）。 */
export type TickAlign = "first" | "mid" | "last";

/** 时长条下方的一个刻度。 */
export interface DurationTickView {
  key: string;
  /** 「0.5 秒」。 */
  label: string;
  /** 这一档的时长（毫秒）；点刻度直接跳到它。 */
  durationMs: number;
  /** 在轨道上的位置（0-100）。 */
  percent: number;
  align: TickAlign;
}

/**
 * 三个刻度：0.5 / 15 / 30 秒。
 *
 * 位置按时长线性换算（15 秒因此落在 49.2% 而不是正中），标签本身只是文字；
 * 两端用对齐方式贴边，避免文字被容器裁掉。
 */
export function durationTicks(): DurationTickView[] {
  const last = DURATION_TICKS_MS.length - 1;
  return DURATION_TICKS_MS.map((ms, index) => ({
    key: `tick-${ms}`,
    label: durationText(ms),
    durationMs: ms,
    percent: durationPercent(ms),
    align: index === 0 ? "first" : index === last ? "last" : "mid",
  }));
}

/* ---------------- 步骤与光区 ---------------- */

/** 一个步骤里的一条连续灯珠（用于画缩略色带）。 */
export interface TimelineZone {
  /** 起始灯珠下标（闭区间）。 */
  start: number;
  /** 结束灯珠下标（闭区间）。 */
  end: number;
  /** 展示色（"#RRGGBB"）。 */
  hex: string;
}

/** 时间轴上的一个步骤。本票的光区列表恒为空（#66 才接）。 */
export interface TimelineStep {
  /** 时长（毫秒）；渲染前会被钳位。 */
  durationMs: number;
  /** 这一步的光区。 */
  zones: TimelineZone[];
}

/** 缩略色带里的一条。 */
export interface ThumbBand {
  /** 稳定的 key（wx:key 用，同一块内唯一）。 */
  key: string;
  /** 占整条灯组的比例（0-1）；所有色带加起来 = 1。 */
  ratio: number;
  /** 展示色；空串表示这些灯珠没有被任何光区覆盖（留白，不画色）。 */
  hex: string;
  /** 直接塞进 style：宽度比例 + 颜色（留白不带 background，走 CSS 兜底）。 */
  style: string;
}

/** 色带样式：宽度按比例分，颜色只有真有光区时才写。 */
function bandStyle(ratio: number, hex: string): string {
  const flex = `flex: ${Math.max(0, ratio)} 0 0%;`;
  return hex === "" ? flex : `${flex} background: ${hex};`;
}

/**
 * 新建时间轴：两个 1 秒、没有光区的步骤。
 *
 * 两个是为了让「比例」一看就懂（一个块改时长，另一个跟着变），也不至于一进
 * 进阶档就只剩一个块、看不出时间轴是横向排列的。
 */
export function createTimeline(): TimelineStep[] {
  return [
    { durationMs: DEFAULT_STEP_MS, zones: [] },
    { durationMs: DEFAULT_STEP_MS, zones: [] },
  ];
}

/* ---------------- 缩略色带 ---------------- */

/**
 * 步骤里的光区 → 缩略色带。
 *
 * 色带**铺满整条灯组**：没有光区覆盖的灯珠也给一条 `hex === ""` 的留白带，
 * 否则色带会整体右移，看起来像是别的位置在发光。比例按灯珠数算（不是按光区
 * 个数），所以「前 15 颗红、后 15 颗蓝」在 30 颗的灯组上是 0.5 / 0.5。
 *
 * 非法输入一律跳过（`ledCount < 1`、起点大于终点、越界）；重叠的按先来的算，
 * 不重复计数。
 */
export function thumbBands(zones: readonly TimelineZone[], ledCount: number): ThumbBand[] {
  const total = Math.floor(ledCount);
  if (!Number.isFinite(total) || total < 1) {
    return [];
  }
  const valid = zones
    .map((zone) => ({
      start: Math.max(0, Math.floor(zone.start)),
      end: Math.min(total - 1, Math.floor(zone.end)),
      hex: typeof zone.hex === "string" ? zone.hex : "",
    }))
    .filter((zone) => zone.hex !== "" && zone.start <= zone.end)
    .sort((a, b) => a.start - b.start);

  const bands: ThumbBand[] = [];
  let cursor = 0;
  let index = 0;
  const push = (ratio: number, hex: string, prefix: string) => {
    bands.push({ key: `${prefix}-${index}`, ratio, hex, style: bandStyle(ratio, hex) });
    index += 1;
  };
  for (const zone of valid) {
    if (zone.end < cursor) {
      continue;
    }
    const start = Math.max(cursor, zone.start);
    if (start > cursor) {
      push((start - cursor) / total, "", "gap");
    }
    push((zone.end - start + 1) / total, zone.hex, "band");
    cursor = zone.end + 1;
    if (cursor >= total) {
      break;
    }
  }
  if (cursor < total) {
    push((total - cursor) / total, "", "gap");
  }
  return bands;
}

/* ---------------- 宽度分配 ---------------- */

/** 一个块渲染所需的全部数据（纯计算结果）。 */
export interface TimelineBlockView {
  /** 在时间轴里的位置。 */
  index: number;
  /** wx:key 用。 */
  key: string;
  /** 钳位后的时长。 */
  durationMs: number;
  /** 「0.5 秒」。 */
  durationText: string;
  /** 占整条时间轴的时长比例（0-1）。 */
  ratio: number;
  /** CSS 的 flex-grow：测量后是分配到的像素，未测量时是时长。 */
  flexGrow: number;
  /** 分配到的像素宽度；未测量（0）时没有意义。 */
  widthPx: number;
  /** 是否被最小宽度保底抬起。 */
  floored: boolean;
  /** 直接塞进 style 的样式串。 */
  style: string;
  /** 缩略色带。 */
  bands: ThumbBand[];
  /** 当前选中。 */
  selected: boolean;
  /** 正在被拖动。 */
  dragging: boolean;
  /** 拖动时的落点（松手后会排到这里）。 */
  dropTarget: boolean;
  /**
   * 拖动中的横向位移（px）；0 = 不动。
   *
   * 由 `dragOffsetFor` 算出：被拖的块跟手指走，原位置与落点之间的块挪到
   * 「重排后它该在的位置」让出插槽（等宽时正好是一个块宽）。纯函数是唯一
   * 真相——页面不复算。
   */
  dragOffsetPx: number;
  /**
   * 直接塞进 style 的位移串（`transform: …`）；没在拖动时为空串。
   *
   * 被拖的块在这里带上抬起放大，因为**内联 transform 会覆盖 CSS 类里的
   * transform**——放大和跟手必须是同一条 transform，否则松开手会跳。
   */
  dragStyle: string;
  /** 这么窄就别画时长文字了。 */
  showLabel: boolean;
}

export interface LayoutOptions {
  /** 时间轴行的真实宽度（px）；0 = 还没测量。行宽恒等于容器宽。 */
  widthPx: number;
  /** 块间隙（px）；不传时用 `chooseGap` 按容器宽在 8 / 4 之间降级。 */
  gapPx?: number;
  /** 最小宽度（px），默认 `MIN_BLOCK_PX`。 */
  minPx?: number;
  /** 当前选中的下标。 */
  selected?: number;
  /** 正在拖动的下标；-1 = 没有。 */
  dragIndex?: number;
  /** 拖动落点的下标；-1 = 没有。 */
  dropIndex?: number;
  /**
   * 被拖块「跟手指走」的横向位移（px）；由 `dragFollowOffset` 算出。
   *
   * 页面只把指尖坐标交给纯函数、再把结果原样传回来——不复算位移规则。
   */
  followPx?: number;
  /** 当前灯组的灯珠数（画色带用）。 */
  ledCount?: number;
}

/**
 * 水位法分配宽度。
 *
 * 返回每块的像素宽度，和 = `available`（除非没有可用宽度）。见文件头的算法说明。
 */
export function allocateWidths(
  weights: readonly number[],
  available: number,
  minPx: number,
): number[] {
  const count = weights.length;
  if (count === 0) {
    return [];
  }
  const usable = Number.isFinite(available) ? Math.max(0, available) : 0;
  if (usable <= 0) {
    return weights.map(() => 0);
  }
  const totalWeight = weights.reduce((sum, weight) => sum + Math.max(0, weight), 0);
  if (totalWeight <= 0) {
    return weights.map(() => usable / count);
  }

  const pinned = weights.map(() => false);
  const widths = new Array<number>(count).fill(0);
  for (let round = 0; round <= count; round += 1) {
    const pinnedCount = pinned.filter(Boolean).length;
    if (pinnedCount === count) {
      break;
    }
    const free = usable - pinnedCount * minPx;
    const freeWeight = weights.reduce(
      (sum, weight, index) => (pinned[index] ? sum : sum + Math.max(0, weight)),
      0,
    );
    /* 保底都放不下（或剩下的块没有权重）：水位法无解，均分兜底。 */
    if (free <= 0 || freeWeight <= 0) {
      return weights.map(() => usable / count);
    }
    let newlyPinned = 0;
    for (let index = 0; index < count; index += 1) {
      if (pinned[index]) {
        widths[index] = minPx;
        continue;
      }
      const share = (free * Math.max(0, weights[index])) / freeWeight;
      if (share < minPx) {
        pinned[index] = true;
        widths[index] = minPx;
        newlyPinned += 1;
      } else {
        widths[index] = share;
      }
    }
    if (newlyPinned === 0) {
      return widths;
    }
  }
  return weights.map(() => usable / count);
}

/** 把分配结果变成 flex 样式。测量后权重就是像素，未测量时是时长。 */
function flexStyle(weight: number, measured: boolean): string {
  const value = Math.max(0, weight);
  if (!measured) {
    return `flex: ${value} 0 0%; min-width: ${MIN_BLOCK_PX}px;`;
  }
  return `flex: ${value} 0 0%;`;
}

/**
 * 时间轴行需要多宽 —— **恒等于容器宽**（#76：永不横向滚动）。
 *
 * 块宽之和 + 间隙永远等于容器宽，所以页面不需要 `scroll-view`，也不需要把
 * 行撑宽来保留比例：比例由 `allocateWidths` 在容器内部表达（保底钉住最短的
 * 几块，其余块彼此仍严格成比例）。
 *
 * `containerPx <= 0`（还没测量）时退回「块数 × 最小宽 + 间隙」——那只是首帧
 * 或测量失败时的兜底，不会把行压成 0；一旦测到真实宽度就严格等于容器宽。
 */
export function timelineRowWidth(
  weights: readonly number[],
  containerPx: number,
  gapPx: number = BLOCK_GAP_PX,
  minPx: number = MIN_BLOCK_PX,
): number {
  const container = Number.isFinite(containerPx) ? Math.max(0, containerPx) : 0;
  if (container > 0) {
    return container;
  }
  const count = weights.length;
  if (count === 0) {
    return 0;
  }
  return count * minPx + gapPx * (count - 1);
}

/**
 * 块间隙：8px 放得下就用 8，否则降到 4；4 也放不下就仍返回 4（靠均分兜底）。
 *
 * 判定基准是「每块都能拿到最小宽度」：`count × minPx + gap × (count - 1) <= 容器`。
 * 单块（或空列表）没有间隙，永远返回宽间隙。
 */
export function chooseGap(
  count: number,
  containerPx: number,
  minPx: number = MIN_BLOCK_PX,
): number {
  if (!Number.isInteger(count) || count <= 1) {
    return BLOCK_GAP_PX;
  }
  /* NaN 当成「放不下」（走紧凑间隙）；Infinity 是「无限宽」，自然满足。 */
  const container = Number.isNaN(containerPx) ? 0 : Math.max(0, containerPx);
  const need = (gap: number) => count * minPx + gap * (count - 1);
  if (need(BLOCK_GAP_PX) <= container) {
    return BLOCK_GAP_PX;
  }
  return COMPACT_BLOCK_GAP_PX;
}

/**
 * 时间轴 → 每块的样式 / 宽度 / 色带 / 选中态。
 *
 * 页面拖时长条时只需要重新调用这个函数，块宽就跟着变——不重建页面。
 */
export function layoutBlocks(
  steps: readonly TimelineStep[],
  options: LayoutOptions,
): TimelineBlockView[] {
  const count = steps.length;
  if (count === 0) {
    return [];
  }
  const minPx = options.minPx ?? MIN_BLOCK_PX;
  const measured = Number.isFinite(options.widthPx) && options.widthPx > 0;
  /* 没显式给间隙时按容器宽自己降级：8px 放不下就 4px（未测量时无从判断，用宽间隙）。 */
  const gapPx = options.gapPx ?? (measured ? chooseGap(count, options.widthPx, minPx) : BLOCK_GAP_PX);
  const durations = steps.map((step) => clampDuration(step.durationMs));
  const totalDuration = durations.reduce((sum, value) => sum + value, 0);
  const available = measured ? Math.max(0, options.widthPx - gapPx * (count - 1)) : 0;
  const widths = measured
    ? allocateWidths(durations, available, minPx)
    : durations.map(() => 0);
  const selected = options.selected ?? -1;
  const dragIndex = options.dragIndex ?? -1;
  const dropIndex = options.dropIndex ?? -1;
  const ledCount = options.ledCount ?? 0;
  /*
   * 拖动是「这是一次拖动」而不是「容器量到了」：抬起（放大 / 投影 / 层级）
   * 只要在拖就该有；位移则需要像素宽度，没测量时一律 0（首帧不该有拖动）。
   */
  const draggingActive = dragIndex >= 0 && dropIndex >= 0;
  const offsets =
    measured && draggingActive ? dragOffsetFor(dragIndex, dropIndex, widths, gapPx) : widths.map(() => 0);
  /* 跟手位移由页面从纯函数拿来；没给就是 0（原地抬起）。 */
  const followPx = Number.isFinite(options.followPx) ? (options.followPx as number) : 0;

  return steps.map((step, index) => {
    const durationMs = durations[index];
    const widthPx = widths[index];
    const weight = measured ? widthPx : durationMs;
    const idealPx = measured && totalDuration > 0 ? (available * durationMs) / totalDuration : 0;
    const offsetPx = offsets[index];
    const dragging = index === dragIndex;
    return {
      index,
      key: `step-${index}`,
      durationMs,
      durationText: durationText(durationMs),
      ratio: totalDuration > 0 ? durationMs / totalDuration : 0,
      flexGrow: weight,
      widthPx,
      /* 被保底抬起 = 拿到的比比例份额多（保底总放不下时的均分不算「抬起」）。 */
      floored: measured && widthPx > idealPx + 1e-6,
      style: flexStyle(weight, measured),
      bands: thumbBands(step.zones, ledCount),
      selected: index === selected,
      dragging,
      /*
       * 落点高亮只给「会被挤开的那一块」：被拖块本身不标落点，否则两层阴影
       * 打架（抬起投影会被描边覆盖，看起来像没抬起来）。原地拖动（`from ===
       * to`）没有落点，什么都不高亮。
       */
      dropTarget: dropIndex >= 0 && dropIndex !== dragIndex && index === dropIndex,
      dragOffsetPx: offsetPx,
      /*
       * 被拖的块抬起来并跟手（内联 translateX + scale）；让位的块只平移；
       * 其余为空串。没在拖动时全是空串，交给 CSS 的回弹过渡。
       *
       * 放大必须写在**同一条内联 transform** 里：内联 transform 覆盖 CSS 类
       * 的 transform，拆成两处会让放大在拖动中丢掉、松手又突然出现。
       */
      dragStyle:
        !draggingActive
          ? ""
          : dragging
            ? dragStyleOf(followPx, true)
            : offsetPx === 0
              ? ""
              : dragStyleOf(offsetPx, false),
      showLabel: !measured || widthPx >= LABEL_MIN_PX,
    };
  });
}

/**
 * 横向坐标 → 落点下标（拖动重排用）。
 *
 * `x` 是相对时间轴行左边缘的像素。落在块之间的间隙里算右边那块，落到两端之外
 * 钳到首 / 末块——拖出边界不会越界，也不会出现「松手后回到原位」的意外。
 */
export function blockIndexAt(
  widths: readonly number[],
  x: number,
  gapPx: number = BLOCK_GAP_PX,
): number {
  if (widths.length === 0 || !Number.isFinite(x)) {
    return -1;
  }
  let cursor = 0;
  for (let index = 0; index < widths.length; index += 1) {
    const width = Math.max(0, widths[index]);
    if (x < cursor + width) {
      return index;
    }
    cursor += width + gapPx;
  }
  return widths.length - 1;
}

/** 屏幕坐标下的块矩形（`boundingClientRect` 的子集）。 */
export interface BlockRect {
  left: number;
  right: number;
}

/**
 * 屏幕坐标 → 落点下标（拖动中的实时命中）。
 *
 * 为什么不用 `blockIndexAt` + 宽度：`blockIndexAt` 假设坐标相对行左边缘，而
 * 页面拿到的是屏幕坐标；1px 取整也会累积。拖动开始时量一次每个块的真实屏幕
 * 矩形，之后全部按屏幕坐标比较，就与取整、缩放都无关。
 *
 * 先看指尖落在哪个块里；落在块之间的间隙里时取**离指尖最近**的块——与
 * 「间隙归右边那块」的直观一致，也不会在宽块左半边命中前一块。
 */
export function blockIndexAtRects(rects: readonly BlockRect[], x: number): number {
  if (rects.length === 0 || !Number.isFinite(x)) {
    return -1;
  }
  let fallback = 0;
  let fallbackDistance = Number.POSITIVE_INFINITY;
  for (let index = 0; index < rects.length; index += 1) {
    const rect = rects[index];
    if (x >= rect.left && x <= rect.right) {
      return index;
    }
    const distance = x < rect.left ? rect.left - x : x - rect.right;
    if (distance < fallbackDistance) {
      fallbackDistance = distance;
      fallback = index;
    }
  }
  return fallback;
}

/* ---------------- 拖动的物理反馈（#82） ---------------- */

/**
 * 拖动时每一块该平移多少像素（纯函数，页面不复算）。
 *
 * ## 语义
 *
 * 「`fromIndex` 那一块正被拖向 `toIndex`」时的**让位**：
 *
 *  - 被拖的块位移为 0 —— 它跟手指走（`dragFollowOffset`），落点由让位的块
 *    表达；把跟手和让位叠加到同一块上会变成双倍位移；
 *  - 原位置与落点**之间**的块挪到「重排后它该在的位置」，让出插槽；
 *  - 落点之外（`from` 与 `to` 的另一侧）的块不动；
 *  - `from === to`、越界、非整数下标：一律 0（块原地不动，松手回弹）。
 *
 * ## 为什么按「重排后的真实位置」算，而不是按固定一格
 *
 * 块宽按时长比例分配，**各块不等宽**。若所有让位的块都平移「被拖块宽 +
 * 间隙」，只有等宽时才对齐；不等宽时动画结束的位置与松手后的布局会差几像素
 * 到几十像素，看起来像「松手后跳了一下」。所以这里先排出重排后的顺序，再
 * 逐块算「目标 x − 当前 x」——**等宽时它就等于一个块宽**（票面的说法），
 * 不等宽时也精确对齐。这样「看到的位移」和「实际的落点」才是同一份真相。
 *
 * ## 边界
 *
 * `from === to`、越界、非整数下标、空列表时全部返回 0：拖回原位不该有任何
 * 让位，块正常回弹。
 *
 * 调用方只需要把返回值直接写成 `translateX(<n>px)`，不需要知道方向规则。
 */
export function dragOffsetFor(
  fromIndex: number,
  toIndex: number,
  widths: readonly number[],
  gapPx: number = BLOCK_GAP_PX,
): number[] {
  const count = widths.length;
  const offsets = widths.map(() => 0);
  if (
    count === 0 ||
    !Number.isInteger(fromIndex) ||
    !Number.isInteger(toIndex) ||
    fromIndex < 0 ||
    toIndex < 0 ||
    fromIndex >= count ||
    toIndex >= count ||
    fromIndex === toIndex
  ) {
    return offsets;
  }
  const gap = Number.isFinite(gapPx) ? Math.max(0, gapPx) : 0;
  const w = widths.map((width) => (Number.isFinite(width) ? Math.max(0, width) : 0));
  /* 当前每个块的行内起点。 */
  const positions: number[] = [];
  let cursor = 0;
  for (let index = 0; index < count; index += 1) {
    positions.push(cursor);
    cursor += w[index] + gap;
  }
  /* 重排后的顺序（与 `moveBlock` / `moveStepStage` 同一语义）。 */
  const order: number[] = [];
  for (let index = 0; index < count; index += 1) {
    if (index !== fromIndex) {
      order.push(index);
    }
  }
  order.splice(toIndex, 0, fromIndex);
  /* 每个块在重排后队列里的起点。 */
  let finalCursor = 0;
  for (const block of order) {
    offsets[block] = finalCursor - positions[block];
    finalCursor += w[block] + gap;
  }
  /* 被拖的块跟手指走，不吃让位位移。 */
  offsets[fromIndex] = 0;
  return offsets;
}

/** 位移串：`transform: translateX(3.5px) scale(1.06);`；对齐到 0.1px 避免抖。 */
export function dragStyleOf(offsetPx: number, lifted: boolean): string {
  const value = Math.round((Number.isFinite(offsetPx) ? offsetPx : 0) * 10) / 10;
  const scale = lifted ? ` scale(${DRAG_LIFT_SCALE})` : "";
  return `transform: translateX(${value}px)${scale};`;
}

/**
 * 被拖的块「跟手指走」时的横向位移（纯函数）。
 *
 * `startX` 是进入拖动那一刻的指尖横坐标，`currentX` 是当前指尖横坐标，
 * `rects` 是拖动开始时量到的块矩形。结果被钳在行内：块不能跟着手指滑出
 * 时间轴（行外就算「拖出边界」，见 `dragTargetAtRects`），否则块会跑到卡片外
 * 把 `overflow` 撑出滚动条。
 *
 * 没测量（矩形缺失 / 下标越界）时返回 0：宁可不动，也不跳到某个猜出来的位置。
 */
export function dragFollowOffset(
  startX: number,
  currentX: number,
  rects: readonly BlockRect[],
  fromIndex: number,
): number {
  if (!Number.isFinite(startX) || !Number.isFinite(currentX)) {
    return 0;
  }
  const rect = rects[fromIndex];
  if (rect === undefined || rects.length === 0) {
    return 0;
  }
  const width = Math.max(0, rect.right - rect.left);
  const rowLeft = rects[0].left;
  const rowRight = rects[rects.length - 1].right;
  const wanted = currentX - startX;
  /* 块整体留在行内：左不过行首，右不过行尾。 */
  const min = rowLeft - rect.left;
  const max = rowRight - (rect.left + width);
  return Math.max(min, Math.min(max, wanted));
}

/**
 * 拖动中的命中结果：预览用的下标 + 是否已经拖出时间轴。
 *
 * `blockIndexAtRects` 把行外钳到首 / 末块（选中手感更顺），拖动重排却要区分：
 * 拖出时间轴再松手应当**取消**，否则块会莫名跳到第一 / 最后一位。所以这里
 * 一次给出两件事——`index` 永远是可用的预览落点，`outside` 决定松手是否提交。
 */
export interface DragTarget {
  /** 预览落点（行外钳到首 / 末块，无矩形时 -1）。 */
  index: number;
  /** 指尖已经在时间轴行外（松手不提交）。 */
  outside: boolean;
}

/** 指尖坐标 → 拖动命中（预览落点 + 是否出界）。 */
export function dragTargetAtRects(rects: readonly BlockRect[], x: number): DragTarget {
  if (rects.length === 0 || !Number.isFinite(x)) {
    return { index: -1, outside: true };
  }
  const left = rects[0].left;
  const right = rects[rects.length - 1].right;
  return { index: blockIndexAtRects(rects, x), outside: x < left || x > right };
}

/**
 * 拖动结束时「吞掉紧随其后的 tap」到什么时候为止（纯函数，时间戳自愈）。
 *
 * 手指抬起会补发一次 `tap`；不吞掉它，`onStepTap` 会把选中改成被拖块落点的
 * 那块，顺序看起来「跳了一下」。用时间戳而不是布尔量：窗口一过自动恢复，
 * 不会把整条时间轴永久点死。
 */
export function dragTapSuppressUntil(now: number): number {
  return Number.isFinite(now) ? now + DRAG_TAP_SUPPRESS_MS : 0;
}

/** 这一次点击是否落在「拖动刚结束」的抑制窗口里。 */
export function tapSuppressedAt(now: number, suppressUntil: number): boolean {
  return Number.isFinite(now) && Number.isFinite(suppressUntil) && now < suppressUntil;
}

/* ---------------- 增删与重排 ---------------- */

/** 还能不能再加一个步骤。 */
export function canAddStep(steps: readonly TimelineStep[]): boolean {
  return steps.length < MAX_STEPS;
}

/** `addStep` 的结果：新的步骤列表 + 应该选中的下标。 */
export interface AddStepResult {
  steps: TimelineStep[];
  /** 新步骤的下标（= 列表末端）。 */
  selected: number;
}

/**
 * 加一个步骤：默认 1 秒、没有光区，并返回应该选中的下标。
 *
 * 已到 8 个返回 null——调用方据此禁用按钮，而不是悄悄忽略。
 */
export function addStep(
  steps: readonly TimelineStep[],
  durationMs: number = DEFAULT_STEP_MS,
): AddStepResult | null {
  if (!canAddStep(steps)) {
    return null;
  }
  const next: TimelineStep[] = [
    ...steps.map((step) => ({ durationMs: step.durationMs, zones: step.zones.slice() })),
    { durationMs: clampDuration(durationMs), zones: [] },
  ];
  return { steps: next, selected: next.length - 1 };
}

/**
 * 按索引重排（把 `from` 挪到 `to`）。
 *
 * 越界（负数 / 超出长度 / 非整数）与自身移动是**无操作**，原样返回同一个数组
 * ——调用方可以靠引用相等判断「什么都没发生」。
 */
export function moveBlock<T>(list: T[], from: number, to: number): T[] {
  if (!Number.isInteger(from) || !Number.isInteger(to)) {
    return list;
  }
  if (from === to) {
    return list;
  }
  if (from < 0 || to < 0 || from >= list.length || to >= list.length) {
    return list;
  }
  const next = list.slice();
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next;
}

/**
 * 块被挪动后，选中下标应该落在哪。
 *
 * 选中的就是被挪的那块 → 跟着它走；被挪的块跨过选中块 → 选中块让一位。
 */
export function selectionAfterMove(selected: number, from: number, to: number): number {
  if (!Number.isInteger(selected) || !Number.isInteger(from) || !Number.isInteger(to)) {
    return selected;
  }
  if (from === to || from < 0 || to < 0) {
    return selected;
  }
  if (selected === from) {
    return to;
  }
  if (from < selected && selected <= to) {
    return selected - 1;
  }
  if (to <= selected && selected < from) {
    return selected + 1;
  }
  return selected;
}

/** 把选中下标钳到 `[0, count - 1]`；空列表返回 0（没有可选的东西）。 */
export function clampSelected(index: number, count: number): number {
  if (!Number.isFinite(count) || count <= 0) {
    return 0;
  }
  if (!Number.isFinite(index)) {
    return 0;
  }
  return Math.max(0, Math.min(Math.floor(count) - 1, Math.floor(index)));
}

/** 删掉一个步骤后的列表与选中下标。 */
export interface RemoveStepResult {
  steps: TimelineStep[];
  selected: number;
}

/**
 * 删掉一个步骤（本票界面还没有删除按钮，规则照样做成纯函数并测好）。
 *
 * 越界下标是无操作；选中下标在删除后重新钳位，不会指向不存在的步骤。
 */
export function removeStep(
  steps: readonly TimelineStep[],
  index: number,
  selected: number,
): RemoveStepResult {
  if (!Number.isInteger(index) || index < 0 || index >= steps.length) {
    return { steps: steps.map((step) => ({ ...step })), selected: clampSelected(selected, steps.length) };
  }
  const next = steps
    .filter((_, position) => position !== index)
    .map((step) => ({ durationMs: step.durationMs, zones: step.zones.slice() }));
  const shifted = index < selected ? selected - 1 : selected;
  return { steps: next, selected: clampSelected(shifted, next.length) };
}

/**
 * 改某一步的时长（已钳位）。
 *
 * 越界下标是无操作（返回同一个数组）；不修改入参，方便页面拿旧值做比较。
 */
export function setStepDuration(
  steps: readonly TimelineStep[],
  index: number,
  durationMs: number,
): TimelineStep[] {
  if (!Number.isInteger(index) || index < 0 || index >= steps.length) {
    return steps as TimelineStep[];
  }
  const next = clampDuration(durationMs);
  return steps.map((step, position) =>
    position === index
      ? { durationMs: next, zones: step.zones.slice() }
      : { durationMs: step.durationMs, zones: step.zones.slice() },
  );
}
