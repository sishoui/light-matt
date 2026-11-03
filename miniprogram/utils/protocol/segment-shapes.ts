/**
 * 段的「扁平 UI 草稿 ⇄ 线上两层形状」转换（纯函数，属于协议层）。
 *
 * 为什么在协议层：`commands.ts` 的构造器同时接受两种输入（页面沿用的扁平
 * `SegmentConfig`、v3 的 `SegmentSpec`），转换必须比构造器更底层，否则
 * 协议层会反过来依赖 `utils/control/`（方向错了）。
 *
 * 对外门面是 `utils/control/segment-model.ts`（#40 的接缝）；这里只放
 * 不依赖任何控制逻辑的纯转换，便于协议层与页面层双向复用。
 */

import { BLEND, NO_EFFECT, SEGMENT_TYPE } from "./constants";
import { EMPTY_EFFECT } from "./types";
import type { EffectLayer, SegmentConfig, SegmentReport, SegmentSpec } from "./types";

/**
 * 空层：type = 0xFF、其余全 0。
 *
 * 返回新对象（不共享常量实例）：段对象会被反复读写，共享会引入别名 bug。
 */
export function emptyLayer(): EffectLayer {
  /* 值取自 EMPTY_EFFECT（唯一真相），但**返回副本**：段对象会被原地读写。 */
  return { ...EMPTY_EFFECT };
}

/** 扁平草稿的灯效字段 → 一层。静态层强制 period / p5 / flags 为 0。 */
export function layerFromFlat(segment: SegmentConfig): EffectLayer {
  if (segment.type === SEGMENT_TYPE.STATIC) {
    return { type: segment.type, hue: segment.hue, sat: segment.sat, periodMs: 0, p5: 0, flags: 0 };
  }
  return {
    type: segment.type,
    hue: segment.hue,
    sat: segment.sat,
    periodMs: segment.periodMs,
    p5: segment.p5,
    flags: segment.flags,
  };
}

/** 扁平草稿 → 线上两层（layer1 空、blend 覆盖）。 */
export function toSpec(segment: SegmentConfig): SegmentSpec {
  return {
    stripId: segment.stripId,
    segId: segment.segId,
    start: segment.start,
    end: segment.end,
    blend: BLEND.OVER,
    layer0: layerFromFlat(segment),
    layer1: emptyLayer(),
  };
}

/**
 * 线上两层 → 扁平草稿（只投影 layer0）。
 *
 * 返回的 `SegmentConfig` 丢了 layer1 / blend，**只应喂给只编辑层 0 的旧 UI**；
 * 需要完整信息时直接用 `SegmentSpec`。
 */
export function toFlat(spec: SegmentSpec): SegmentConfig {
  const layer = spec.layer0;
  return {
    stripId: spec.stripId,
    segId: spec.segId,
    start: spec.start,
    end: spec.end,
    type: layer.type,
    hue: layer.hue,
    sat: layer.sat,
    periodMs: layer.periodMs,
    p5: layer.p5,
    flags: layer.flags,
  };
}

/**
 * 运行时判别：`SegmentSpec` 一定带 `layer0`，扁平草稿一定不带。
 *
 * 两个类型都是普通对象，TS 的结构类型无法在值层面区分，所以构造器接受
 * `SegmentSpec | SegmentConfig` 时必须靠这个守卫。
 */
export function isSegmentSpec(value: SegmentSpec | SegmentConfig): value is SegmentSpec {
  return (value as SegmentSpec).layer0 !== undefined;
}

/** 段是否有第二层（#42 的 blend 控件据此启用/禁用）。 */
export function hasSecondLayer(spec: SegmentSpec | SegmentReport): boolean {
  return spec.layer1.type !== NO_EFFECT;
}

/**
 * 报告 → 可下发的 spec（丢掉报告特有的扁平投影字段）。
 *
 * 用途：QueryStrip 读回后原地改一层再写回（#42 的「读-改-写」），
 * 避免把 `type/hue/sat/...` 这些冗余字段也塞进命令载荷。
 *
 * 装配沿用 `zone-model.buildZoneSpec` 的同一条规则（两层定宽、单层 blend
 * 归一、深拷贝）。协议层不能反向依赖 `utils/control/`，所以这里显式展开
 * ——两处规则由 `tests/zone-model.test.ts` 锁住一致性。
 */
export function specFromReport(report: SegmentReport): SegmentSpec {
  const layer1 = report.layer1.type === NO_EFFECT ? emptyLayer() : { ...report.layer1 };
  return {
    stripId: report.stripId,
    segId: report.segId,
    start: report.start,
    end: report.end,
    blend: layer1.type === NO_EFFECT ? BLEND.OVER : report.blend,
    layer0: { ...report.layer0 },
    layer1,
  };
}
