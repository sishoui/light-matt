/**
 * 分区轴（进阶档第二层，#66）的纯布局逻辑。
 *
 * ## 为什么单独一层
 *
 * 分区轴看起来只是「一排带颜色的方块」，真正的规则都在边上：
 *
 *  1. **位置按灯珠下标比例**，不是按分区个数。30 颗灯里的 0–9 占左边三分之一，
 *     而不是「第一个分区所以占左边一半」。走百分比的好处是：灯珠数从 18 变成
 *     30 时，同一套比例翻译出来的位置自然跟着变；
 *  2. **没被覆盖的灯珠要画成灰条**。`uncoveredCount` 只回答「几颗不亮」，
 *     画轴要知道「哪几颗、连成几段」，所以用 `effect-layout.uncoveredRanges`；
 *  3. **选中态不能靠颜色**。分区本身就是有颜色的，再改底色就分不清「这是它的
 *     颜色」还是「它被选中了」——选中一律靠 2px 描边（样式在 strip.wxss）。
 *
 * 页面只把结果塞进 `setData`，不做算术；本模块不碰 wx / BLE。
 */

import { MAX_SEGMENTS } from "../protocol/constants";
import { rgbToHex, segmentHueSatToRgb } from "../color/hsv";
import { uncoveredRanges } from "./effect-layout";

/** 每条灯组最多 8 个分区（协议槽位数）。 */
export const MAX_ZONES = MAX_SEGMENTS;

/** 块宽达到这个百分比才画文字（再窄就压到邻块上了）。 */
export const AXIS_LABEL_MIN_PERCENT = 18;

/**
 * 两端手柄挨得比这个百分比还近就算「挤」（#77）。
 *
 * 手柄是绝对定位的圆，宽度与块宽无关：30 颗里的一颗只占 3.33%，两个圆会完全
 * 叠在一起。低于 4% 时渲染层缩小手柄并向外错开，保证「起点 / 终点」仍然可读。
 */
export const HANDLE_CROWDED_MAX_PERCENT = 4;

/** 画轴需要的最小输入（`SegmentSpec` 与设备报告都能投影成它）。 */
export interface AxisZoneInput {
  /** 槽位号 0-7；界面显示为「分区 槽位+1」。 */
  segId: number;
  start: number;
  end: number;
  /** 展示色（"#RRGGBB"）；空串表示取不到颜色时走 CSS 兜底。 */
  hex: string;
}

/** 分区轴上的一个块：一个分区，或一段没被覆盖的灯珠。 */
export interface ZoneAxisBlock {
  /** wx:key 用，同一块内唯一。 */
  key: string;
  /** `zone` = 分区；`gap` = 没有被覆盖（灰条，点不动）。 */
  kind: "zone" | "gap";
  /** 分区槽位；灰条为 -1。 */
  segId: number;
  start: number;
  end: number;
  /** 这一段包含多少颗灯珠（闭区间所以是 `end - start + 1`）。 */
  span: number;
  /** 左边缘占整条灯组的比例（0-100）。 */
  left: number;
  /** 宽度占整条灯组的比例（0-100）；最短一段 = 100 / 灯珠数。 */
  width: number;
  /** 直接塞进 style 的定位串。 */
  style: string;
  /** 展示色；灰条为空串（走 `.zone-axis-gap` 的背景）。 */
  hex: string;
  /** 当前选中（只对分区有意义）。 */
  selected: boolean;
  /** 块标题（「分区 1」）；灰条为空串。 */
  label: string;
  /** 「0–9」/「20–29」。 */
  rangeText: string;
  /** 「第 0–19 颗 · 20 颗」；灰条为空串（它不是可选区间，别冒充）。 */
  rangeDetail: string;
  /** 块够宽才画标题。 */
  showLabel: boolean;
  /** 起止手柄；**只有选中的分区才有**（两头各一个，空数组 = 不画）。 */
  handles: AxisHandle[];
}

/**
 * 分区一端的手柄（#77）。
 *
 * `percent` 是绝对位置（占整条灯组的百分比，起点 = `start/灯珠数`，
 * 终点 = `(end+1)/灯珠数`）；`style` 是**块内**的定位串——手柄是块的绝对定位
 * 子元素，`left: 0%` 贴块左、`left: 100%` 贴块右，不参与块宽计算，所以选中
 * 不会让块变宽、位置不会跳。
 */
export interface AxisHandle {
  /** `start` = 起点（这一段的第一颗）；`end` = 终点（最后一颗的右边缘）。 */
  kind: "start" | "end";
  /** 绝对位置占整条灯组的百分比（0-100，调试与断言用）。 */
  percent: number;
  /** 块内定位串（`left: 0%;` / `left: 100%;`）。 */
  style: string;
  /** 两个手柄挤在一起时渲染层缩小尺寸并向外错开。 */
  crowded: boolean;
}

/** 一个闭区间占整条灯组的百分比（左边缘与宽度）。 */
export interface AxisRect {
  left: number;
  width: number;
}

/**
 * 区间 → 百分比矩形。
 *
 * `left = start / 灯珠数`、`width = 颗数 / 灯珠数`（闭区间所以要 +1）。
 * 越界（负数 / 超过灯珠数）按 `0..ledCount-1` 裁剪；完全在范围外的返回 null，
 * 而不是画一条钳到边上的假块。
 */
export function axisRect(start: number, end: number, ledCount: number): AxisRect | null {
  const count = Number.isFinite(ledCount) ? Math.floor(ledCount) : 0;
  if (count < 1) {
    return null;
  }
  const rawStart = Number.isFinite(start) ? Math.floor(start) : 0;
  const rawEnd = Number.isFinite(end) ? Math.floor(end) : -1;
  if (rawEnd < 0 || rawStart > count - 1 || rawStart > rawEnd) {
    return null;
  }
  const from = Math.max(0, rawStart);
  const to = Math.min(count - 1, rawEnd);
  return {
    left: (from / count) * 100,
    width: ((to - from + 1) / count) * 100,
  };
}

/** 「0–9」：区间的人话写法（用短横线，不用连字符，避免与负数混淆）。 */
export function zoneRangeText(start: number, end: number): string {
  return `${start}–${end}`;
}

/**
 * 「第 0–19 颗 · 20 颗」：轴下方给用户核对用的整句（#77）。
 *
 * 与灯珠弹窗的 `pickerRangeText` 同一套口径（0 基下标、闭区间），这样
 * 「轴上看到的一段」与「弹窗里选的那一段」用数字对得上。
 */
export function zoneRangeDetail(start: number, end: number): string {
  const from = Math.max(0, Math.floor(start));
  const to = Math.max(from, Math.floor(end));
  return `第 ${from}–${to} 颗 · ${to - from + 1} 颗`;
}

/**
 * 分区两端的起止手柄（#77）。
 *
 * 纯计算：起点 = `start / 灯珠数`，终点 = `(end+1) / 灯珠数`——终点要包住
 * 最后一颗灯珠，所以用 `end + 1` 而不是 `end`。手柄以绝对定位挂在块里，
 * 位置是块内的 0% / 100%，因此**不改变块宽**、选中不会引起布局跳动。
 *
 * 越界 / 非法输入返回空数组：宁可不画，也不画一个钳到边上的假手柄。
 */
export function axisHandles(start: number, end: number, ledCount: number): AxisHandle[] {
  const count = Number.isFinite(ledCount) ? Math.floor(ledCount) : 0;
  if (count < 1) {
    return [];
  }
  const rect = axisRect(start, end, count);
  if (rect === null) {
    return [];
  }
  const from = Math.max(0, Math.floor(start));
  const to = Math.min(count - 1, Math.floor(end));
  const startPercent = (from / count) * 100;
  const endPercent = ((to + 1) / count) * 100;
  /* 两柄中心距小于阈值 → 圆会叠成一坨，渲染层缩尺寸并向外错开。 */
  const crowded = endPercent - startPercent < HANDLE_CROWDED_MAX_PERCENT;
  return [
    { kind: "start", percent: startPercent, style: "left: 0%;", crowded },
    { kind: "end", percent: endPercent, style: "left: 100%;", crowded },
  ];
}

/**
 * 零分区时的引导文案（#77）：轴里不该是一片空白。
 *
 * 有分区时返回空串——引导只在「真的没东西可看」时出现，否则页面会一直
 * 顶着一句「点新增」。
 */
export function zoneAxisGuide(zoneCount: number, ledCount: number): string {
  if (zoneCount > 0) {
    return "";
  }
  const count = Number.isFinite(ledCount) ? Math.max(0, Math.floor(ledCount)) : 0;
  return count > 0
    ? `还没有分区，点「+ 新增」划出第一段（这条灯组有 ${count} 颗）`
    : "还没有分区，先等设备报到灯珠数量";
}

/** 百分比数字 → CSS 串；保留 4 位小数，避免 33.333333% 这类噪声。 */
function percentText(value: number): string {
  const rounded = Math.round(value * 10000) / 10000;
  return `${rounded}%`;
}

/** 绝对定位的样式串（left / width）。 */
export function axisStyle(rect: AxisRect): string {
  return `left: ${percentText(rect.left)}; width: ${percentText(rect.width)};`;
}

/** 分区轴的输入。 */
export interface ZoneAxisInput {
  /** 当前步骤里这一组的全部分区（顺序无所谓）。 */
  zones: readonly AxisZoneInput[];
  /** 当前灯组的真实灯珠数（`State.stripCounts[stripId]`）。 */
  ledCount: number;
  /** 当前选中的槽位；-1 = 没有选中。 */
  selectedSegId?: number;
}

/**
 * 分区轴 → 按位置排序的块列表（分区 + 灰条）。
 *
 * 灰条来自 `uncoveredRanges`：零分区时是整条一根，整条覆盖时一根都没有。
 * 灰条永远排在它的起点位置，所以「哪里还有暗区」一眼可见。
 */
export function buildZoneAxis(input: ZoneAxisInput): ZoneAxisBlock[] {
  const count = Number.isFinite(input.ledCount) ? Math.max(0, Math.floor(input.ledCount)) : 0;
  if (count < 1) {
    return [];
  }
  const selected = input.selectedSegId ?? -1;
  const blocks: ZoneAxisBlock[] = [];

  const zoneRects = input.zones
    .map((zone) => {
      const rect = axisRect(zone.start, zone.end, count);
      if (rect === null) {
        return null;
      }
      const span = Math.min(count - 1, Math.max(0, Math.floor(zone.end))) -
        Math.max(0, Math.floor(zone.start)) +
        1;
      return {
        zone,
        rect,
        span,
        start: Math.max(0, Math.floor(zone.start)),
        end: Math.min(count - 1, Math.floor(zone.end)),
      };
    })
    .filter((entry): entry is NonNullable<typeof entry> => entry !== null)
    .sort((a, b) => a.start - b.start);

  for (const entry of zoneRects) {
    const isSelected = entry.zone.segId === selected;
    blocks.push({
      key: `zone-${entry.zone.segId}`,
      kind: "zone",
      segId: entry.zone.segId,
      start: entry.start,
      end: entry.end,
      span: entry.span,
      left: entry.rect.left,
      width: entry.rect.width,
      style: axisStyle(entry.rect),
      hex: entry.zone.hex,
      selected: isSelected,
      label: `分区 ${entry.zone.segId + 1}`,
      rangeText: zoneRangeText(entry.start, entry.end),
      rangeDetail: zoneRangeDetail(entry.start, entry.end),
      showLabel: entry.rect.width >= AXIS_LABEL_MIN_PERCENT,
      /* 手柄只挂在选中的那一块上：未选中时块内没有多余节点，也就没有布局影响。 */
      handles: isSelected ? axisHandles(entry.start, entry.end, count) : [],
    });
  }

  /* 灰条要和分区按起点混排：单独按 kind 拼会把灰条全挤到右边。 */
  for (const gap of uncoveredRanges(input.zones, count)) {
    const rect = axisRect(gap.start, gap.end, count);
    if (rect === null) {
      continue;
    }
    blocks.push({
      key: `gap-${gap.start}-${gap.end}`,
      kind: "gap",
      segId: -1,
      start: gap.start,
      end: gap.end,
      span: gap.end - gap.start + 1,
      left: rect.left,
      width: rect.width,
      style: axisStyle(rect),
      hex: "",
      selected: false,
      label: "",
      rangeText: zoneRangeText(gap.start, gap.end),
      rangeDetail: "",
      showLabel: false,
      handles: [],
    });
  }

  return blocks.sort((a, b) => a.left - b.left);
}

/**
 * 分区轴右上角的摘要。
 *
 * 零分区时写「还没有分区」而不是「0 个分区」——后者像是一个错误状态。
 */
export function zoneAxisSummary(zones: readonly AxisZoneInput[], ledCount: number): string {
  const count = Number.isFinite(ledCount) ? Math.max(0, Math.floor(ledCount)) : 0;
  if (zones.length === 0) {
    return count > 0 ? `还没有分区 · ${count} 颗全暗` : "还没有分区";
  }
  const gapCount = uncoveredRanges(zones, count).reduce(
    (sum, range) => sum + (range.end - range.start + 1),
    0,
  );
  return gapCount > 0
    ? `${zones.length} 个分区 · ${gapCount} 颗未覆盖`
    : `${zones.length} 个分区 · 整组覆盖`;
}

/** 还能不能再加一个分区（8 个上限）。 */
export function canAddZoneAt(zones: readonly AxisZoneInput[]): boolean {
  return zones.length < MAX_ZONES;
}

/**
 * 草稿里的分区 → 分区轴的输入（展示色取自主效果的色相 / 饱和度）。
 *
 * 分区轴与弹窗共用同一份输入，颜色只在这里换算一次；页面不再自己算 hex，
 * 免得「轴上是一种颜色、弹窗里是另一种」。
 */
export function axisZonesOf(
  zones: ReadonlyArray<{ segId: number; start: number; end: number; layer0: { hue: number; sat: number } }>,
): AxisZoneInput[] {
  return zones.map((zone) => ({
    segId: zone.segId,
    start: zone.start,
    end: zone.end,
    hex: rgbToHex(segmentHueSatToRgb(zone.layer0.hue, zone.layer0.sat)),
  }));
}

/** 分区列表里的展示色表（弹窗里「别人的格子」用它上色）。 */
export function axisColorMap(
  zones: ReadonlyArray<{ segId: number; layer0: { hue: number; sat: number } }>,
): Map<number, string> {
  const map = new Map<number, string>();
  for (const zone of zones) {
    map.set(zone.segId, rgbToHex(segmentHueSatToRgb(zone.layer0.hue, zone.layer0.sat)));
  }
  return map;
}

/**
 * 分区列表变化后，光标应该落在哪。
 *
 * 选中的那个还在 → 保持（改范围后仍是同一个分区）；不在了 → **-1**，
 * 而不是自动挑第一个：自动选中会让「点一块选中它」这件事永远看不见
 * （每次重画都已经选好了）。新增分区后由调用方显式指定新槽位。
 */
export function selectedZoneAfter(
  zones: readonly AxisZoneInput[],
  previousSegId: number,
): number {
  return zones.some((zone) => zone.segId === previousSegId) ? previousSegId : -1;
}
