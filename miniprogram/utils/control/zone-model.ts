/**
 * 一个「分区」的完整形状：构造与读取的唯一入口（#53）。
 *
 * ## 为什么要有这个模块
 *
 * 分区的线上形状是 `SegmentSpec`（v4 是 23 字节：灯组 / 槽位 / 区间 / 叠加方式 +
 * 两层各 9 字节灯效）。此前有三处各自拼这个对象：
 *
 *  - `segment-editor.assembleSpec`（段编辑页的草稿 → spec）
 *  - `quick-effects.buildQuickSpec`（快捷档整组 → spec）
 *  - `segment-shapes.specFromReport`（设备报告 → 可下发的 spec）
 *
 * 三份实现都带同一条协议约束（**叠加效果为空时叠加方式必须是覆盖**），
 * 也都要做深拷贝防止页面后续改草稿时连带改已下发的对象。重复三遍意味着
 * 任何一处漏了约束就是一次 `InvalidParam`，所以收敛到这里。
 *
 * ## 职责边界（#53 的验收要求）
 *
 *  - **区间与布局**归 `effect-layout`（校验 / 重叠 / 切分 / 逐灯珠）
 *  - **灯效参数校验**归 `segment-editor`
 *  - **本模块只做装配与读取**，不判断灯效参数是否合法——那是预检的事；
 *    这里只保证结构正确（层数定宽、空层叠加方式归一、**level 归一**、字段深拷贝）。
 *
 * v4 的 `level`（逐分区亮度）在装配时统一归一（`normalizeLayerLevel`）：
 * 空层恒 0、非空层钳到 0-100 且缺失按满亮。**所有构造分区的路径都必须经过
 * 这里**，否则「用户调了亮度却被设备拒」只会在真机上暴露。
 *
 * 纯函数、不碰 wx / BLE。
 */

import { BLEND, NO_EFFECT } from "../protocol/constants";
import { normalizeLayerLevel } from "../protocol/segment-shapes";
import type { BlendMode, EffectLayer, SegmentReport, SegmentSpec } from "../protocol/types";
import { emptyLayer } from "./segment-model";

/** 构造一个分区所需的输入。`layer1` 省略 / null 表示单层。 */
export interface ZoneInput {
  /** 灯组号 0-7。 */
  stripId: number;
  /** 槽位号 0-7。 */
  segId: number;
  /** 闭区间起点。 */
  start: number;
  /** 闭区间终点。 */
  end: number;
  /** 主效果（必填）。 */
  layer0: EffectLayer;
  /** 叠加效果；省略 = 单层。 */
  layer1?: EffectLayer | null;
  /** 叠加方式；单层时会被归一为覆盖。 */
  blend?: BlendMode;
}

/** 读出的分区视图（两层定宽，叠加方式已归一）。 */
export interface ZoneView {
  stripId: number;
  segId: number;
  start: number;
  end: number;
  /** 主效果。 */
  layer0: EffectLayer;
  /** 叠加效果；`type === NO_EFFECT` 表示单层。 */
  layer1: EffectLayer;
  /** 实际生效的叠加方式（单层恒为覆盖）。 */
  blend: BlendMode;
  /** 是否有叠加效果（UI 据此启用叠加方式控件）。 */
  hasOverlay: boolean;
}

/** 是否提供了叠加效果（type 非空）。 */
export function hasOverlay(layer1: EffectLayer | null | undefined): boolean {
  return layer1 !== null && layer1 !== undefined && layer1.type !== NO_EFFECT;
}

/**
 * 实际要下发的叠加方式：没有叠加效果时一律归一为覆盖，有叠加效果时默认按亮度叠加。
 *
 * 前半句是协议的硬约束（§7.1 第 4 条），不是风格问题——单层带非 0 的 blend
 * 会被设备直接拒。后半句是界面口径：两层都有内容时只有「按亮度叠加」是正确
 * 语义（特效层只盖住自己亮着的地方），见 `advanced-layers.ts` 的模块注释。
 */
export function normalizedBlend(layer1: EffectLayer | null | undefined, blend: BlendMode | undefined): BlendMode {
  if (!hasOverlay(layer1)) {
    return BLEND.OVER;
  }
  return blend ?? BLEND.LUMA;
}

function copyLayer(layer: EffectLayer): EffectLayer {
  return normalizeLayerLevel(layer);
}

/**
 * 构造一个分区（`SegmentSpec`）。
 *
 * 保证四件事：两层定宽（没有叠加效果时补空层）、叠加方式已归一、
 * 两层都是副本（改调用方的草稿不会污染已下发的对象）、**level 已归一**
 * （空层恒 0、非空层 0-100、缺失按满亮）。
 */
export function buildZoneSpec(zone: ZoneInput): SegmentSpec {
  const layer1 = hasOverlay(zone.layer1) ? copyLayer(zone.layer1 as EffectLayer) : emptyLayer();
  return {
    stripId: zone.stripId,
    segId: zone.segId,
    start: zone.start,
    end: zone.end,
    blend: normalizedBlend(zone.layer1, zone.blend),
    layer0: copyLayer(zone.layer0),
    layer1,
  };
}

/** 读取一个分区（设备报告或 spec 都接受），归一成 `ZoneView`。 */
export function readZone(spec: SegmentSpec | SegmentReport): ZoneView {
  return {
    stripId: spec.stripId,
    segId: spec.segId,
    start: spec.start,
    end: spec.end,
    layer0: copyLayer(spec.layer0),
    layer1: copyLayer(spec.layer1),
    blend: normalizedBlend(spec.layer1, spec.blend),
    hasOverlay: hasOverlay(spec.layer1),
  };
}

/** 读取一个分区并直接产出可下发的 spec（等价于 readZone → 重新装配）。 */
export function zoneSpecOf(spec: SegmentSpec | SegmentReport): SegmentSpec {
  return buildZoneSpec(readZone(spec));
}

/**
 * 把分区的区间抽出来（喂给 `effect-layout` 的布局逻辑）。
 *
 * 只是字段投影，不做校验——校验在 `effect-layout`。
 */
export function zoneRange(spec: Pick<SegmentSpec, "segId" | "start" | "end">): {
  segId: number;
  start: number;
  end: number;
} {
  return { segId: spec.segId, start: spec.start, end: spec.end };
}
