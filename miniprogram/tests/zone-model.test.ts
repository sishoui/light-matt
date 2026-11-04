/**
 * 分区的构造与读取（#53）：一份实现，三处复用。
 *
 * 这里锁住的是**协议硬约束**，不是风格：
 *  - 两层定宽（叠加效果为空时补空层）；
 *  - 叠加效果为空时叠加方式必须归一为覆盖（单层带非 0 blend 会被设备拒）；
 *  - 两层都是深拷贝（页面后续改草稿不能污染已下发的对象）。
 *
 * 同时锁住 `protocol/segment-shapes.specFromReport` 与 `zone-model` 的规则
 * 一致——协议层不能反向依赖控制层，两处实现必须逐字对齐。
 */

import { describe, expect, it } from "vitest";
import {
  buildZoneSpec,
  hasOverlay,
  normalizedBlend,
  readZone,
  zoneRange,
  zoneSpecOf,
} from "../utils/control/zone-model";
import { specFromReport } from "../utils/protocol/segment-shapes";
import { cmdSetSegment } from "../utils/protocol/commands";
import { BLEND, NO_EFFECT, SEGMENT_TYPE } from "../utils/protocol/constants";
import type { EffectLayer, SegmentReport, SegmentSpec } from "../utils/protocol/types";

function layer(type: number, overrides: Partial<EffectLayer> = {}): EffectLayer {
  return {
    type,
    hue: 0,
    sat: 0,
    periodMs: 0,
    p5: 0,
    flags: 0,
    /* 空层的 level 必须为 0；非空层默认满亮。 */
    level: type === NO_EFFECT ? 0 : 100,
    ...overrides,
  };
}

function report(overrides: Partial<SegmentReport> = {}): SegmentReport {
  const base: SegmentReport = {
    stripId: 2,
    segId: 1,
    start: 0,
    end: 9,
    blend: BLEND.OVER,
    layer0: layer(SEGMENT_TYPE.STATIC, { hue: 1000, sat: 255 }),
    layer1: layer(NO_EFFECT),
    type: SEGMENT_TYPE.STATIC,
    hue: 1000,
    sat: 255,
    periodMs: 0,
    p5: 0,
    flags: 0,
  };
  return { ...base, ...overrides };
}

describe("buildZoneSpec：单层 / 两层", () => {
  it("不传叠加效果 → 补空层、叠加方式归一为覆盖（即使调用方给了相加）", () => {
    const spec = buildZoneSpec({
      stripId: 2,
      segId: 3,
      start: 4,
      end: 19,
      layer0: layer(SEGMENT_TYPE.STATIC),
      blend: BLEND.ADD,
    });
    expect(spec.layer1.type).toBe(NO_EFFECT);
    expect(spec.blend).toBe(BLEND.OVER);
    /* 构造器是最后一道：这份 spec 必须能直接下发。 */
    expect(() => cmdSetSegment(spec)).not.toThrow();
  });

  it("layer1 传 null 与省略等价", () => {
    const a = buildZoneSpec({ stripId: 0, segId: 0, start: 0, end: 4, layer0: layer(SEGMENT_TYPE.STATIC), layer1: null });
    const b = buildZoneSpec({ stripId: 0, segId: 0, start: 0, end: 4, layer0: layer(SEGMENT_TYPE.STATIC) });
    expect(a).toEqual(b);
  });

  it("有叠加效果时保留叠加方式", () => {
    const spec = buildZoneSpec({
      stripId: 1,
      segId: 2,
      start: 0,
      end: 9,
      layer0: layer(SEGMENT_TYPE.RAINBOW, { periodMs: 1000, p5: 255 }),
      layer1: layer(SEGMENT_TYPE.BREATHING, { periodMs: 2000 }),
      blend: BLEND.MULTIPLY,
    });
    expect(spec.blend).toBe(BLEND.MULTIPLY);
    expect(spec.layer1.type).toBe(SEGMENT_TYPE.BREATHING);
  });

  it("有叠加效果但没给叠加方式 → 覆盖（保守默认）", () => {
    const spec = buildZoneSpec({
      stripId: 0,
      segId: 0,
      start: 0,
      end: 9,
      layer0: layer(SEGMENT_TYPE.STATIC),
      layer1: layer(SEGMENT_TYPE.COMET, { periodMs: 800 }),
    });
    expect(spec.blend).toBe(BLEND.OVER);
  });

  it("两层都是副本：改输入不会污染产出，改产出也不会污染输入", () => {
    const layer0 = layer(SEGMENT_TYPE.STATIC, { hue: 100 });
    const layer1 = layer(SEGMENT_TYPE.BREATHING, { periodMs: 1000 });
    const spec = buildZoneSpec({ stripId: 0, segId: 0, start: 0, end: 9, layer0, layer1 });

    layer0.hue = 999;
    expect(spec.layer0.hue).toBe(100);

    spec.layer1.periodMs = 5000;
    expect(layer1.periodMs).toBe(1000);
  });
});

describe("readZone / zoneSpecOf", () => {
  it("读出的叠加方式已归一（单层恒覆盖）", () => {
    const view = readZone(report({ blend: BLEND.ADD }));
    expect(view.hasOverlay).toBe(false);
    expect(view.blend).toBe(BLEND.OVER);
  });

  it("读出的两层是副本", () => {
    const source = report();
    const view = readZone(source);
    view.layer0.hue = 4242;
    expect(source.layer0.hue).toBe(1000);
  });

  it("zoneSpecOf 丢弃报告的扁平投影字段", () => {
    const spec = zoneSpecOf(report());
    expect(Object.keys(spec).sort()).toEqual(["blend", "end", "layer0", "layer1", "segId", "start", "stripId"]);
  });

  it("zoneRange 只投影区间三字段", () => {
    expect(zoneRange(report({ segId: 5, start: 10, end: 20 }))).toEqual({ segId: 5, start: 10, end: 20 });
  });
});

describe("hasOverlay / normalizedBlend", () => {
  it("空层 / null / undefined 都算没有叠加效果", () => {
    expect(hasOverlay(layer(NO_EFFECT))).toBe(false);
    expect(hasOverlay(null)).toBe(false);
    expect(hasOverlay(undefined)).toBe(false);
    expect(hasOverlay(layer(SEGMENT_TYPE.STATIC))).toBe(true);
  });

  it("没有叠加效果时归一为覆盖，不管传了什么", () => {
    for (const blend of [BLEND.OVER, BLEND.MULTIPLY, BLEND.ADD, undefined]) {
      expect(normalizedBlend(layer(NO_EFFECT), blend)).toBe(BLEND.OVER);
    }
  });
});

describe("与 protocol/segment-shapes.specFromReport 规则一致", () => {
  const cases: Array<[string, SegmentReport]> = [
    ["单层（blend 覆盖）", report()],
    ["单层但 blend 残留相加", report({ blend: BLEND.ADD })],
    [
      "两层 + 相乘",
      report({
        blend: BLEND.MULTIPLY,
        layer1: layer(SEGMENT_TYPE.BREATHING, { periodMs: 2000, p5: 30 }),
      }),
    ],
  ];

  it.each(cases)("%s：两个入口产出同一份 spec", (_label, input) => {
    expect(zoneSpecOf(input)).toEqual(specFromReport(input));
  });
});

describe("v4 逐分区亮度：装配时的结构不变量（#69）", () => {
  it("空叠加层的 level 恒为 0（即使调用方给了 50）", () => {
    const spec = buildZoneSpec({
      stripId: 0,
      segId: 0,
      start: 0,
      end: 9,
      layer0: layer(SEGMENT_TYPE.STATIC, { level: 40 }),
      layer1: layer(NO_EFFECT, { level: 50 }),
    });
    expect(spec.layer0.level).toBe(40);
    expect(spec.layer1.type).toBe(NO_EFFECT);
    expect(spec.layer1.level).toBe(0);
    /* 装配结果必须能直接下发。 */
    expect(() => cmdSetSegment(spec)).not.toThrow();
  });

  it("非空层的 level 钳到 0-100（越界不静默放大）", () => {
    const high = buildZoneSpec({
      stripId: 0,
      segId: 0,
      start: 0,
      end: 9,
      layer0: layer(SEGMENT_TYPE.STATIC, { level: 150 }),
    });
    expect(high.layer0.level).toBe(100);

    const negative = buildZoneSpec({
      stripId: 0,
      segId: 0,
      start: 0,
      end: 9,
      layer0: layer(SEGMENT_TYPE.STATIC, { level: -8 }),
    });
    expect(negative.layer0.level).toBe(0);
  });

  it("level 缺失（v3 形状的对象）按满亮补齐", () => {
    const legacy = { type: SEGMENT_TYPE.STATIC, hue: 100, sat: 255, periodMs: 0, p5: 0, flags: 0 };
    const spec = buildZoneSpec({
      stripId: 0,
      segId: 0,
      start: 0,
      end: 9,
      layer0: legacy as unknown as EffectLayer,
    });
    expect(spec.layer0.level).toBe(100);
  });

  it("0 / 50 / 100 原样保留，两层各自独立", () => {
    const spec = buildZoneSpec({
      stripId: 0,
      segId: 0,
      start: 0,
      end: 9,
      blend: BLEND.MULTIPLY,
      layer0: layer(SEGMENT_TYPE.STATIC, { level: 0 }),
      layer1: layer(SEGMENT_TYPE.BREATHING, { periodMs: 1000, p5: 20, level: 50 }),
    });
    expect(spec.layer0.level).toBe(0);
    expect(spec.layer1.level).toBe(50);
    /* 逐字节确认 level 落到了第 9 字节（层 0 偏移 13、层 1 偏移 22）。 */
    const payload = cmdSetSegment(spec).payload;
    expect(payload[13]).toBe(0);
    expect(payload[22]).toBe(50);
  });
});

describe("产出物一定能过构造器（这是拆 23 字节载荷的唯一目的）", () => {
  const specs: SegmentSpec[] = [
    buildZoneSpec({ stripId: 0, segId: 0, start: 0, end: 63, layer0: layer(SEGMENT_TYPE.STATIC) }),
    buildZoneSpec({
      stripId: 7,
      segId: 7,
      start: 10,
      end: 20,
      layer0: layer(SEGMENT_TYPE.COMET, { periodMs: 200, p5: 255, flags: 1 }),
      layer1: layer(SEGMENT_TYPE.RAINBOW, { periodMs: 200, p5: 255 }),
      blend: BLEND.ADD,
    }),
  ];

  it.each(specs.map((spec, index) => [index, spec] as const))("spec #%i 可下发", (_index, spec) => {
    expect(() => cmdSetSegment(spec)).not.toThrow();
  });
});
