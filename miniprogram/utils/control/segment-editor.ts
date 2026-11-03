/**
 * 段编辑页的纯逻辑（#42）：草稿模型、客户端预检、逐灯珠可视化。
 *
 * 为什么独立成模块：页面只负责把这里的结果画出来。所有「能不能下发」的判断
 * 都必须能在 vitest 里覆盖——不然「周期填 300ms 的呼吸」就只能等设备回
 * InvalidParam，而那时用户已经点了应用、帧已经发出去了（票面明确要求拦住）。
 *
 * 三条合同：
 *  1. **设备是权威**：这里的预检只保证「不与设备当前的段表明显冲突」；
 *     设备的 §7.1 七步校验仍是最终裁决。
 *  2. **两层定宽**：草稿永远有两层（layer1 为空用 `NO_EFFECT`），不存在第三层
 *     的入口；层 1 为空时 blend 被强制为 0（覆盖），与协议第 4 条一致。
 *  3. **草稿可丢弃**：`discardDraft` 用设备值重建草稿；页面离开时调用它即可，
 *     绝不在用户没点「应用」时静默下发（spec §3.4）。
 *
 * 本模块纯函数、不碰 wx / BLE，可在 node 环境直接测。
 */

import { rgbToHex, segmentHueSatToRgb } from "../color/hsv";
import {
  ANIMATION_MIN_PERIOD_MS,
  BLEND,
  BREATHING_MIN_PERIOD_MS,
  MAX_LEDS,
  NO_EFFECT,
  SEGMENT_TYPE,
} from "../protocol/constants";
import type { BlendMode, EffectLayer, SegmentReport, SegmentSpec } from "../protocol/types";
import {
  findStripConflict,
  parseRangeText,
  scanLedOwnership,
  type RangeResult,
} from "./effect-layout";
import { emptyLayer } from "./segment-model";
import { buildZoneSpec } from "./zone-model";

/** 编辑中的段草稿。区间用**原样的字符串**，解析失败也要能回显给用户。 */
export interface SegmentDraft {
  /** 灯带号（页面从 URL 拿，所有下发都以它为准）。 */
  stripId: number;
  /** 槽位号；-1 = 新建（应用时再分配空闲槽位）。 */
  segId: number;
  /** 起点输入框原文。 */
  startText: string;
  /** 终点输入框原文。 */
  endText: string;
  /** 层 1 的叠加方式；层 1 为空时下发改写为 0。 */
  blend: BlendMode;
  /** 必填层。 */
  layer0: EffectLayer;
  /** 可选层；`type === NO_EFFECT` 表示不用。 */
  layer1: EffectLayer;
}

export type DraftIssueCode =
  | "range"
  | "overlap"
  | "layer0-empty"
  | "layer-type"
  | "layer-period"
  | "layer-value"
  | "blend";

/** 一条可定位到控件的预检问题（页面据此高亮对应区块）。 */
export interface DraftIssue {
  code: DraftIssueCode;
  /** 0 / 1 表示哪一层；区间级问题不带。 */
  layer?: 0 | 1;
  message: string;
}

/** 预检结果：`spec` 只在 `ok === true` 时非空（不给调用方「半成品」）。 */
export interface DraftValidation {
  ok: boolean;
  issues: DraftIssue[];
  /** 第一条问题的文案（页面直接显示 / toast）。 */
  message: string;
  /** 解析出的闭区间；非法时为 -1。 */
  start: number;
  end: number;
  /** 实际会下发的 blend（层 1 为空时已归一为覆盖）。 */
  blend: BlendMode;
  spec: SegmentSpec | null;
}

export type RangeCheck = RangeResult;

/** 预检所需的设备上下文。 */
export interface DraftContext {
  /** 该带真实灯珠数（`State.stripCounts[stripId]`，不是 strip 0 的复制）。 */
  ledCount: number;
  /** 该带已有的段（QueryStrip 读回；必须已按 stripId 过滤）。 */
  existing: readonly SegmentReport[];
  /** 槽位覆盖（页面在新建时已分配好槽位时给出）。 */
  segId?: number;
}

/**
 * 解析区间输入（草稿的文本字段 → 闭区间）。
 *
 * 实现委托给 `effect-layout.parseRangeText`——区间规则只有一份，
 * 本页只是把草稿的两个字符串喂进去。
 */
export function parseDraftRange(draft: Pick<SegmentDraft, "startText" | "endText">, ledCount: number): RangeCheck {
  return parseRangeText(draft.startText, draft.endText, ledCount);
}

/**
 * 同带重叠预检。
 *
 * 只和 **同一 stripId** 的段比：编辑第 3 条带时，第 1、2 条带的段与它毫无关系，
 * 把它们算进来会误拒（协议里段区间本来就是「每带独立」）。
 * `ignoreSegId` 用于改自己的区间：槽位相同就是替换，不是冲突。
 *
 * 实现委托给 `effect-layout.findStripConflict`。
 */
export function findOverlap(
  stripId: number,
  ignoreSegId: number,
  start: number,
  end: number,
  existing: readonly SegmentReport[],
): SegmentReport | null {
  return findStripConflict({ start, end }, existing, stripId, ignoreSegId);
}


/** 该灯效类型的周期下限（0 = 没有下限，如静态 / 空层）。 */
export function layerPeriodFloor(type: number): number {
  if (type === SEGMENT_TYPE.BREATHING) {
    return BREATHING_MIN_PERIOD_MS;
  }
  if (type === SEGMENT_TYPE.RAINBOW || type === SEGMENT_TYPE.COMET) {
    return ANIMATION_MIN_PERIOD_MS;
  }
  return 0;
}

/** 层 1 非空时 blend 才有意义（契约：单层 blend 必须为 0）。 */
export function blendEnabled(layer1: EffectLayer): boolean {
  return layer1.type !== NO_EFFECT;
}

/** 实际要下发的 blend：层 1 为空一律归一为覆盖。 */
export function effectiveBlend(draft: Pick<SegmentDraft, "blend" | "layer1">): BlendMode {
  return blendEnabled(draft.layer1) ? draft.blend : BLEND.OVER;
}

function isKnownType(type: number): boolean {
  return (
    type === SEGMENT_TYPE.STATIC ||
    type === SEGMENT_TYPE.BREATHING ||
    type === SEGMENT_TYPE.RAINBOW ||
    type === SEGMENT_TYPE.COMET
  );
}

function isByte(value: number): boolean {
  return Number.isInteger(value) && value >= 0 && value <= 0xff;
}

function isUint16(value: number): boolean {
  return Number.isInteger(value) && value >= 0 && value <= 0xffff;
}

/**
 * 校验一层，返回问题列表（空数组 = 合法）。
 *
 * 规则与 `protocol/commands.writeLayer` 一一对应，但**不抛异常**：这里的要求
 * 是「提交前给出可读原因」，而不是在构造帧时崩掉。
 * `layerLabel` 只用于文案（「层 1」/「层 2」——UI 从 1 开始数）。
 */
function validateLayer(layer: EffectLayer, layerIndex: 0 | 1, layerLabel: string): DraftIssue[] {
  const issues: DraftIssue[] = [];
  const push = (code: DraftIssueCode, message: string) => {
    issues.push({ code, layer: layerIndex, message });
  };

  if (!isKnownType(layer.type)) {
    push("layer-type", `${layerLabel}的灯效类型未知（0x${layer.type.toString(16)}）`);
    return issues;
  }
  if (!isUint16(layer.hue)) {
    push("layer-value", `${layerLabel}的色相必须在 0-65535`);
  }
  if (!isByte(layer.sat)) {
    push("layer-value", `${layerLabel}的饱和度必须在 0-255`);
  }
  if (!isByte(layer.p5)) {
    push("layer-value", `${layerLabel}的参数必须在 0-255`);
  }
  if (!isByte(layer.flags)) {
    push("layer-value", `${layerLabel}的标志位必须在 0-255`);
  }
  if (!isUint16(layer.periodMs)) {
    push("layer-value", `${layerLabel}的周期必须在 0-65535ms`);
  }
  if (issues.length > 0) {
    return issues;
  }

  if (layer.type === SEGMENT_TYPE.STATIC) {
    /* 静态层的两个参数块必须全 0（§7.1 第 6 条），否则设备会拒。 */
    if (layer.periodMs !== 0 || layer.p5 !== 0 || layer.flags !== 0) {
      push("layer-value", `${layerLabel}是静态灯效，周期 / 参数 / 标志位必须为 0`);
    }
    return issues;
  }

  const floor = layerPeriodFloor(layer.type);
  /* period_ms = 0 是「静止」，不受下限约束。 */
  if (layer.periodMs !== 0 && layer.periodMs < floor) {
    push("layer-period", `${layerLabel}的周期不能短于 ${floor}ms（当前 ${layer.periodMs}ms）`);
  }

  if (layer.type === SEGMENT_TYPE.BREATHING) {
    /* 呼吸的 flags bit1-2 是波形，bit0 是保留的反向位，bit3-7 必须为 0。 */
    if ((layer.flags & 0xf8) !== 0) {
      push("layer-value", `${layerLabel}的呼吸标志位保留了 bit3-7，必须为 0`);
    }
  } else if ((layer.flags & 0xfe) !== 0) {
    /* 彩虹 / 流光只有 bit0（方向），bit1-7 保留。 */
    push("layer-value", `${layerLabel}的彩虹/流光标志位保留了 bit1-7，必须为 0`);
  }
  return issues;
}

/**
 * 草稿全量预检：区间 → 重叠 → 层 0 非空 → 两层参数 → blend。
 *
 * 顺序刻意与「用户改动的心理顺序」一致：先解决区间冲突，再看灯效参数，
 * 否则用户会被一串与当前操作无关的错误淹没。
 */
export function validateDraft(draft: SegmentDraft, ctx: DraftContext): DraftValidation {
  const issues: DraftIssue[] = [];
  const range = parseDraftRange(draft, ctx.ledCount);
  if (!range.ok) {
    issues.push({ code: "range", message: range.message });
    return failed(issues, range.start, range.end, effectiveBlend(draft));
  }

  const segId = ctx.segId ?? draft.segId;
  const overlap = findOverlap(draft.stripId, segId, range.start, range.end, ctx.existing);
  if (overlap !== null) {
    issues.push({
      code: "overlap",
      message: `与段 ${overlap.segId}（${overlap.start}-${overlap.end}）重叠，同一灯带的段不能重叠`,
    });
  }

  if (draft.layer0.type === NO_EFFECT) {
    issues.push({ code: "layer0-empty", layer: 0, message: "层 1 不能为空（至少要有一种灯效）" });
  } else {
    issues.push(...validateLayer(draft.layer0, 0, "层 1"));
  }

  if (blendEnabled(draft.layer1)) {
    issues.push(...validateLayer(draft.layer1, 1, "层 2"));
  }

  const blend = effectiveBlend(draft);
  if (blend !== BLEND.OVER && blend !== BLEND.MULTIPLY && blend !== BLEND.ADD) {
    issues.push({ code: "blend", message: "混合方式只有覆盖 / 相乘 / 相加" });
  }

  if (issues.length > 0) {
    return failed(issues, range.start, range.end, blend);
  }

  return {
    ok: true,
    issues,
    message: "",
    start: range.start,
    end: range.end,
    blend,
    spec: assembleSpec(draft, range.start, range.end, segId, blend),
  };
}

function failed(issues: DraftIssue[], start: number, end: number, blend: BlendMode): DraftValidation {
  return {
    ok: false,
    issues,
    message: issues.length > 0 ? issues[0].message : "",
    start,
    end,
    blend,
    spec: null,
  };
}

/** 装配线上形状（不做校验：调用方已确认合法）。委托给 `zone-model.buildZoneSpec`。 */
export function resolveSpec(
  draft: SegmentDraft,
  start: number,
  end: number,
  segId: number,
): SegmentSpec {
  return assembleSpec(draft, start, end, segId, effectiveBlend(draft));
}

function assembleSpec(
  draft: SegmentDraft,
  start: number,
  end: number,
  segId: number,
  blend: BlendMode,
): SegmentSpec {
  /* 装配（含深拷贝与单层 blend 归一）只有 `zone-model` 一份实现。 */
  return buildZoneSpec({
    stripId: draft.stripId,
    segId,
    start,
    end,
    blend,
    layer0: draft.layer0,
    layer1: blendEnabled(draft.layer1) ? draft.layer1 : null,
  });
}

/** 空层草稿（每次返回新对象，避免两处编辑共享同一实例）。 */
export function emptyLayerDraft(): EffectLayer {
  return emptyLayer();
}

/** 新建段的默认草稿：覆盖整条带、层 0 静态白、层 1 空、blend 覆盖。 */
export function defaultDraft(stripId: number, ledCount: number): SegmentDraft {
  const last = Math.max(0, Math.min(ledCount, MAX_LEDS) - 1);
  return {
    stripId,
    segId: -1,
    startText: ledCount > 0 ? "0" : "",
    endText: ledCount > 0 ? String(last) : "",
    blend: BLEND.OVER,
    layer0: { type: SEGMENT_TYPE.STATIC, hue: 0, sat: 0, periodMs: 0, p5: 0, flags: 0 },
    layer1: emptyLayer(),
  };
}

/** 设备权威的段 → 草稿（深拷贝；改草稿不会污染 QueryStrip 的返回值）。 */
export function draftFromSpec(spec: SegmentSpec): SegmentDraft {
  return {
    stripId: spec.stripId,
    segId: spec.segId,
    startText: String(spec.start),
    endText: String(spec.end),
    blend: spec.blend,
    layer0: { ...spec.layer0 },
    layer1: { ...spec.layer1 },
  };
}

/**
 * 草稿是否已偏离基线（页面据此在「返回」时提示「草稿将被丢弃」）。
 *
 * `device === null`（新建段）时的基线是该带的默认草稿：用户一旦动过区间 /
 * 参数就算脏，否则一个刚填好的新段会被无声丢掉。
 */
export function isDraftDirty(
  draft: SegmentDraft,
  device: SegmentSpec | null,
  ledCount = 0,
  stripId = draft.stripId,
): boolean {
  const baseline = device === null ? defaultDraft(stripId, ledCount) : draftFromSpec(device);
  return !draftEquals(draft, baseline);
}

/** 丢弃草稿：有设备值就回到设备值，没有就回到该带的默认草稿。 */
export function discardDraft(
  draft: SegmentDraft,
  device: SegmentSpec | null,
  stripId = draft.stripId,
  ledCount = 0,
): SegmentDraft {
  if (device !== null) {
    const restored = draftFromSpec(device);
    restored.stripId = stripId;
    return restored;
  }
  return defaultDraft(stripId, ledCount);
}

function draftEquals(a: SegmentDraft, b: SegmentDraft): boolean {
  return (
    a.stripId === b.stripId &&
    a.segId === b.segId &&
    a.startText.trim() === b.startText.trim() &&
    a.endText.trim() === b.endText.trim() &&
    effectiveBlend(a) === effectiveBlend(b) &&
    layerEquals(a.layer0, b.layer0) &&
    layerEqualsEmptyAware(a.layer1, b.layer1)
  );
}

function layerEquals(a: EffectLayer, b: EffectLayer): boolean {
  return (
    a.type === b.type &&
    a.hue === b.hue &&
    a.sat === b.sat &&
    a.periodMs === b.periodMs &&
    a.p5 === b.p5 &&
    a.flags === b.flags
  );
}

/** 空层只比 type：空层的其它字段没有语义，也算相等。 */
function layerEqualsEmptyAware(a: EffectLayer, b: EffectLayer): boolean {
  if (a.type === NO_EFFECT || b.type === NO_EFFECT) {
    return a.type === b.type;
  }
  return layerEquals(a, b);
}

/** 可视化条上的一格（一颗灯珠）。 */
export interface LedCell {
  /** 灯珠下标 0-63。 */
  index: number;
  /** 是否落在草稿区间内（高亮）。 */
  covered: boolean;
  /** 是否与同带已有段冲突（提交前就标出来）。 */
  conflict: boolean;
  /** 覆盖这颗灯珠的已有段槽位；没有则为 -1。 */
  ownerSegId: number;
  /** 覆盖段（或草稿）的展示色；无归属时为空串。 */
  hex: string;
}

export interface LedCellInput {
  /** 该带真实灯珠数。 */
  ledCount: number;
  /** 草稿区间；非法时传 -1。 */
  start: number;
  end: number;
  /** 当前编辑的槽位（-1 = 新建）：它自己的旧区间不算冲突。 */
  segId: number;
  /**
   * 正在编辑的灯带号。
   *
   * 传入它而不是「假定调用方已过滤」：`existing` 是否干净是调用方的责任，
   * 但一旦漏了过滤，画面上就会出现别的带的颜色——而这正是「编辑第 3 条带
   * 却看起来第 1 条也被改」的错觉来源。这里再挡一次，代价是一次整数比较。
   */
  stripId?: number;
  /** 该带已有的段。 */
  existing: readonly SegmentReport[];
}

/**
 * 生成逐灯珠可视化。
 *
 * 为什么一格一颗灯珠：64 颗的上限让「每格 1 颗」在 750rpx 宽度里仍然可读，
 * 而且用户数格子的成本最低。超出 64 的部分不存在（协议上限）。
 *
 * 归属扫描委托给 `effect-layout.scanLedOwnership`——逐灯珠逻辑只有一份。
 * 本函数额外做的事只有两件：按 `stripId` 过滤（防别的带的段混进来），
 * 以及把归属翻译成展示色。
 */
export function buildLedCells(input: LedCellInput): LedCell[] {
  const sameStrip =
    input.stripId === undefined
      ? input.existing
      : input.existing.filter((item) => item.stripId === input.stripId);
  const hasRange = input.start >= 0 && input.end >= input.start;
  const scan = scanLedOwnership(
    input.ledCount,
    sameStrip,
    hasRange ? { start: input.start, end: input.end } : null,
    input.segId,
  );
  return scan.owners.map((ownerSegId, index) => {
    const item = ownerSegId < 0 ? undefined : sameStrip.find((entry) => entry.segId === ownerSegId);
    return {
      index,
      covered: scan.inDraft[index],
      conflict: scan.conflicts[index],
      ownerSegId,
      hex: item === undefined ? "" : rgbToHex(segmentHueSatToRgb(item.hue, item.sat)),
    };
  });
}

