/**
 * #42 段编辑页的纯逻辑：区间预检 / 同带重叠 / 周期下限 / 空层 / blend 禁用 /
 * 两层往返 / 草稿丢弃 / 逐灯珠可视化。
 *
 * 这些断言就是「提交前拦下」的合同：页面只负责把 `validateDraft` 的结果画出来，
 * 任何一条规则都不允许等到设备的 InvalidParam 才告诉用户。
 */

import { describe, expect, it } from "vitest";

import {
  ANIMATION_MIN_PERIOD_MS,
  BLEND,
  BREATHING_MIN_PERIOD_MS,
  NO_EFFECT,
  SEGMENT_TYPE,
} from "../utils/protocol/constants";
import { cmdSetSegment } from "../utils/protocol/commands";
import type { EffectLayer, SegmentReport, SegmentSpec } from "../utils/protocol/types";
import {
  blendEnabled,
  buildLedCells,
  defaultDraft,
  discardDraft,
  draftFromSpec,
  effectiveBlend,
  emptyLayerDraft,
  findOverlap,
  isDraftDirty,
  layerPeriodFloor,
  parseDraftRange,
  resolveSpec,
  validateDraft,
  type SegmentDraft,
} from "../utils/control/segment-editor";

/** 一层的最简构造：未给的字段按「静态层」填 0。 */
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

/** 一台设备的段报告（画面只用 strip/seg/区间/色相，其余按静态填）。 */
function report(
  stripId: number,
  segId: number,
  start: number,
  end: number,
  overrides: Partial<SegmentReport> = {},
): SegmentReport {
  return {
    stripId,
    segId,
    start,
    end,
    blend: BLEND.OVER,
    layer0: layer(SEGMENT_TYPE.STATIC),
    layer1: layer(NO_EFFECT),
    type: SEGMENT_TYPE.STATIC,
    hue: 0,
    sat: 0,
    periodMs: 0,
    p5: 0,
    flags: 0,
    ...overrides,
  };
}

/** 草稿：默认 0-9、静态白、无第二层。 */
function draft(overrides: Partial<SegmentDraft> = {}): SegmentDraft {
  return {
    stripId: 2,
    segId: -1,
    startText: "0",
    endText: "9",
    blend: BLEND.OVER,
    layer0: layer(SEGMENT_TYPE.STATIC),
    layer1: layer(NO_EFFECT),
    ...overrides,
  };
}

const CTX = { ledCount: 30, existing: [] as SegmentReport[] };

describe("#42 区间预检：整数、非负、start≤end、end<该带灯珠数", () => {
  it("合法区间直接通过", () => {
    const range = parseDraftRange(draft({ startText: "3", endText: "12" }), 30);
    expect(range.ok).toBe(true);
    expect([range.start, range.end]).toEqual([3, 12]);
  });

  it("空串 / 非整数 / 负数 / start>end / 越界都被拦下", () => {
    const cases: Array<[string, string, RegExp]> = [
      ["", "9", /都要填/],
      ["1.5", "9", /整数/],
      ["-1", "9", /负数/],
      ["10", "9", /不能大于/],
      ["0", "30", /超出灯珠范围/],
    ];
    for (const [startText, endText, pattern] of cases) {
      const range = parseDraftRange(draft({ startText, endText }), 30);
      expect(range.ok, `${startText}-${endText}`).toBe(false);
      expect(range.message).toMatch(pattern);
    }
  });

  it("灯珠数未知时拒绝（不猜 0 号带的数量）", () => {
    const range = parseDraftRange(draft(), 0);
    expect(range.ok).toBe(false);
    expect(range.message).toMatch(/灯珠数量未知/);
  });
});

describe("#42 同带重叠：只和同一条带的其它槽位比", () => {
  it("同带不同段重叠 → 报冲突", () => {
    const hit = findOverlap(2, -1, 5, 10, [report(2, 1, 8, 15)]);
    expect(hit?.segId).toBe(1);
  });

  it("改自己时忽略自己的旧区间（槽位相同 = 替换）", () => {
    const hit = findOverlap(2, 1, 0, 29, [report(2, 1, 8, 15)]);
    expect(hit).toBeNull();
  });

  it("别的灯带上的同区间不算冲突（编辑第 3 条带不影响第 1、2 条）", () => {
    const hit = findOverlap(2, -1, 0, 9, [report(0, 1, 0, 9), report(1, 2, 0, 9)]);
    expect(hit).toBeNull();
  });

  it("编辑第 3 条带时，spec 的 stripId 恒为该带（不回流到 strip 0）", () => {
    const validation = validateDraft(
      draft({ stripId: 2, startText: "0", endText: "9" }),
      {
        ledCount: 30,
        /* 前两条带在整段上有满覆盖，第 3 条干净。 */
        existing: [report(0, 0, 0, 29), report(1, 0, 0, 29)],
      },
    );
    expect(validation.ok).toBe(true);
    expect(validation.spec?.stripId).toBe(2);
  });

  it("3 条带同区间的可视化只标本条带的归属（别的带的段不画）", () => {
    const cells = buildLedCells({
      ledCount: 10,
      start: 0,
      end: 9,
      segId: -1,
      stripId: 2,
      existing: [
        report(0, 0, 0, 9, { hue: 0, sat: 255 }),
        report(1, 1, 0, 9, { hue: 21845, sat: 255 }),
        report(2, 4, 0, 4),
      ],
    });
    expect(cells[0].ownerSegId).toBe(4);
    expect(cells[9].ownerSegId).toBe(-1);
  });

  it("相邻（首尾相接）不重叠", () => {
    expect(findOverlap(2, -1, 10, 19, [report(2, 1, 0, 9)])).toBeNull();
    expect(findOverlap(2, -1, 0, 9, [report(2, 1, 10, 19)])).toBeNull();
  });

  it("重叠在 validateDraft 里以 overlap 问题出现，并带上冲突段", () => {
    const result = validateDraft(draft({ startText: "5", endText: "12" }), {
      ledCount: 30,
      existing: [report(2, 3, 10, 20)],
    });
    expect(result.ok).toBe(false);
    const issue = result.issues.find((item) => item.code === "overlap");
    expect(issue?.message).toMatch(/段 3/);
  });
});

describe("#42 周期下限：呼吸 334ms / 彩虹·流光 200ms（0 = 静止不受限）", () => {
  it("呼吸 300ms 在提交前被拦下并写明下限", () => {
    const result = validateDraft(
      draft({ layer0: layer(SEGMENT_TYPE.BREATHING, { periodMs: 300 }) }),
      CTX,
    );
    expect(result.ok).toBe(false);
    expect(result.message).toContain(String(BREATHING_MIN_PERIOD_MS));
    expect(result.issues.some((item) => item.code === "layer-period" && item.layer === 0)).toBe(true);
  });

  it("呼吸恰好在 334ms 通过；0ms（静止）也通过", () => {
    for (const periodMs of [BREATHING_MIN_PERIOD_MS, 0]) {
      const result = validateDraft(
        draft({ layer0: layer(SEGMENT_TYPE.BREATHING, { periodMs }) }),
        CTX,
      );
      expect(result.ok, String(periodMs)).toBe(true);
    }
  });

  it("彩虹 / 流光 199ms 被拦，200ms 通过", () => {
    for (const type of [SEGMENT_TYPE.RAINBOW, SEGMENT_TYPE.COMET]) {
      const bad = validateDraft(draft({ layer0: layer(type, { periodMs: 199 }) }), CTX);
      expect(bad.ok, `type ${type}`).toBe(false);
      expect(bad.message).toContain(String(ANIMATION_MIN_PERIOD_MS));
      const good = validateDraft(draft({ layer0: layer(type, { periodMs: 200 }) }), CTX);
      expect(good.ok, `type ${type}`).toBe(true);
    }
  });

  it("第二层的周期下限同样生效", () => {
    const result = validateDraft(
      draft({
        blend: BLEND.MULTIPLY,
        layer1: layer(SEGMENT_TYPE.BREATHING, { periodMs: 100 }),
      }),
      CTX,
    );
    expect(result.ok).toBe(false);
    expect(result.issues.some((item) => item.code === "layer-period" && item.layer === 1)).toBe(true);
  });

  it("layerPeriodFloor 与协议常量同源", () => {
    expect(layerPeriodFloor(SEGMENT_TYPE.BREATHING)).toBe(BREATHING_MIN_PERIOD_MS);
    expect(layerPeriodFloor(SEGMENT_TYPE.RAINBOW)).toBe(ANIMATION_MIN_PERIOD_MS);
    expect(layerPeriodFloor(SEGMENT_TYPE.COMET)).toBe(ANIMATION_MIN_PERIOD_MS);
    expect(layerPeriodFloor(SEGMENT_TYPE.STATIC)).toBe(0);
    expect(layerPeriodFloor(NO_EFFECT)).toBe(0);
  });
});

describe("#42 层合法性：层 0 必填、未知类型与保留位一律拒绝", () => {
  it("层 0 为空 → 拦下（契约要求 layer0.type != 0xFF）", () => {
    const result = validateDraft(draft({ layer0: layer(NO_EFFECT) }), CTX);
    expect(result.ok).toBe(false);
    expect(result.issues.some((item) => item.code === "layer0-empty")).toBe(true);
  });

  it("层 1 为空是合法的（单层段）", () => {
    expect(validateDraft(draft({ layer1: layer(NO_EFFECT) }), CTX).ok).toBe(true);
  });

  it("未知类型被拦下（不静默降级）", () => {
    const result = validateDraft(draft({ layer0: layer(0x08) }), CTX);
    expect(result.ok).toBe(false);
    expect(result.issues.some((item) => item.code === "layer-type")).toBe(true);
  });

  it("颜色 / p5 越界被拦下（构造器会抛 RangeError，不能等到那一步）", () => {
    expect(validateDraft(draft({ layer0: layer(SEGMENT_TYPE.STATIC, { sat: 300 }) }), CTX).ok).toBe(
      false,
    );
    expect(
      validateDraft(draft({ layer0: layer(SEGMENT_TYPE.RAINBOW, { p5: 256, periodMs: 1000 }) }), CTX)
        .ok,
    ).toBe(false);
  });

  it("保留位非 0 被拦下（呼吸 bit3-7 / 彩虹·流光 bit1-7）", () => {
    expect(
      validateDraft(
        draft({ layer0: layer(SEGMENT_TYPE.BREATHING, { periodMs: 1000, flags: 0x10 }) }),
        CTX,
      ).ok,
    ).toBe(false);
    expect(
      validateDraft(
        draft({ layer0: layer(SEGMENT_TYPE.RAINBOW, { periodMs: 1000, flags: 0x02 }) }),
        CTX,
      ).ok,
    ).toBe(false);
  });

  it("静态层的 period / p5 / flags 必须为 0", () => {
    const result = validateDraft(draft({ layer0: layer(SEGMENT_TYPE.STATIC, { p5: 4 }) }), CTX);
    expect(result.ok).toBe(false);
    expect(result.issues.some((item) => item.code === "layer-value")).toBe(true);
  });
});

describe("#42 blend：层 1 为空时禁用，并强制覆盖", () => {
  it("单层时 blend 控件禁用", () => {
    expect(blendEnabled(layer(NO_EFFECT))).toBe(false);
    expect(blendEnabled(layer(SEGMENT_TYPE.BREATHING, { periodMs: 1000 }))).toBe(true);
  });

  it("单层时即便草稿里残留 blend=相加，下发也必须是覆盖（0）", () => {
    const single = draft({ blend: BLEND.ADD, layer1: layer(NO_EFFECT) });
    expect(effectiveBlend(single)).toBe(BLEND.OVER);
    const result = validateDraft(single, CTX);
    expect(result.ok).toBe(true);
    expect(result.blend).toBe(BLEND.OVER);
    expect(result.spec?.blend).toBe(BLEND.OVER);
  });

  it("两层时 blend 原样生效", () => {
    const two = draft({ blend: BLEND.MULTIPLY, layer1: layer(SEGMENT_TYPE.BREATHING, { periodMs: 2000 }) });
    expect(effectiveBlend(two)).toBe(BLEND.MULTIPLY);
    expect(validateDraft(two, CTX).spec?.blend).toBe(BLEND.MULTIPLY);
  });

  it("blend 值非法时拦下", () => {
    const bad = draft({ blend: 3 as never, layer1: layer(SEGMENT_TYPE.STATIC) });
    expect(validateDraft(bad, CTX).ok).toBe(false);
  });

  it("编辑器产出的单层 spec 一定能通过构造器（blend 已归一）", () => {
    const draftSingle = draft({ blend: BLEND.ADD, layer1: layer(NO_EFFECT) });
    const spec = resolveSpec(draftSingle, 0, 9, 0);
    expect(spec.blend).toBe(BLEND.OVER);
    expect(() => cmdSetSegment(spec)).not.toThrow();
  });

  it("绕过编辑器强行注入「单层 + 非 0 blend」会被协议层拒绝", () => {
    /* 这条覆盖票面的「强行下发（测试注入）被拒」：UI 禁用之外还有一道构造器校验，
     * 设备侧同样的规则回 InvalidParam（protocol §7.1 第 4 条）。 */
    const forced: SegmentSpec = {
      stripId: 2,
      segId: 0,
      start: 0,
      end: 9,
      blend: BLEND.MULTIPLY,
      layer0: layer(SEGMENT_TYPE.STATIC),
      layer1: layer(NO_EFFECT),
    };
    expect(() => cmdSetSegment(forced)).toThrow(RangeError);
  });
});

describe("#42 草稿 ⇄ 线上 spec：两层都保留", () => {
  const twoLayerSpec: SegmentSpec = {
    stripId: 3,
    segId: 5,
    start: 4,
    end: 19,
    blend: BLEND.MULTIPLY,
    layer0: layer(SEGMENT_TYPE.RAINBOW, { hue: 0x1234, sat: 200, periodMs: 4000, p5: 255 }),
    layer1: layer(SEGMENT_TYPE.BREATHING, { hue: 0, sat: 0, periodMs: 1500, p5: 20, flags: 0x02 }),
  };

  it("设备值 → 草稿 → spec 往返，两层与 blend 完全一致", () => {
    const draftFromDevice = draftFromSpec(twoLayerSpec);
    expect(draftFromDevice.startText).toBe("4");
    expect(draftFromDevice.endText).toBe("19");
    expect(draftFromDevice.layer1.type).toBe(SEGMENT_TYPE.BREATHING);

    const validation = validateDraft(draftFromDevice, {
      ledCount: 30,
      existing: [],
      segId: 5,
    });
    expect(validation.ok).toBe(true);
    expect(validation.spec).toEqual(twoLayerSpec);
  });

  it("草稿不共享设备对象的引用（改草稿不会污染权威值）", () => {
    const deviceSpec = { ...twoLayerSpec, layer0: { ...twoLayerSpec.layer0 } };
    const copied = draftFromSpec(deviceSpec);
    copied.layer0.hue = 0xffff;
    copied.layer1.type = NO_EFFECT;
    expect(deviceSpec.layer0.hue).toBe(0x1234);
    expect(deviceSpec.layer1.type).toBe(SEGMENT_TYPE.BREATHING);
  });

  it("resolveSpec 用页面解析出的区间与槽位（不信任字符串原样）", () => {
    const spec = resolveSpec(draft({ startText: "7", endText: "11" }), 7, 11, 4);
    expect([spec.start, spec.end, spec.segId]).toEqual([7, 11, 4]);
  });
});

describe("#42 草稿丢弃：未应用就离开，设备值不变", () => {
  const deviceSpec: SegmentSpec = {
    stripId: 2,
    segId: 1,
    start: 2,
    end: 8,
    blend: BLEND.OVER,
    layer0: layer(SEGMENT_TYPE.COMET, { periodMs: 900, p5: 32 }),
    layer1: layer(NO_EFFECT),
  };

  it("改动后的草稿被识别为 dirty", () => {
    const edited = draftFromSpec(deviceSpec);
    expect(isDraftDirty(edited, deviceSpec)).toBe(false);
    edited.endText = "9";
    expect(isDraftDirty(edited, deviceSpec)).toBe(true);
  });

  it("新建段：默认草稿不脏，改过才脏（否则新段会被无声丢掉）", () => {
    const fresh = defaultDraft(2, 30);
    expect(isDraftDirty(fresh, null, 30)).toBe(false);
    fresh.startText = "5";
    expect(isDraftDirty(fresh, null, 30)).toBe(true);
  });

  it("丢弃 = 回到设备值，且返回新对象（不是同一份引用）", () => {
    const edited = draftFromSpec(deviceSpec);
    edited.startText = "0";
    edited.layer0.p5 = 255;
    const restored = discardDraft(edited, deviceSpec);
    expect(restored.startText).toBe("2");
    expect(restored.layer0.p5).toBe(32);
    expect(restored).not.toBe(edited);
    expect(restored.layer0).not.toBe(edited.layer0);
  });

  it("没有任何设备值时丢弃 = 回到默认草稿（不编造段）", () => {
    const restored = discardDraft(draft({ startText: "1" }), null, 2, 30);
    expect(restored.startText).toBe("0");
    expect(restored.endText).toBe("29");
    expect(restored.segId).toBe(-1);
  });
});

describe("#42 逐灯珠可视化：覆盖范围 + 同带已有段着色 + 冲突标记", () => {
  const existing = [report(2, 0, 0, 4, { hue: 0, sat: 255 }), report(2, 1, 20, 24)];

  it("每一颗灯珠一格，数量 = 该带真实灯珠数", () => {
    const cells = buildLedCells({
      ledCount: 30,
      start: 10,
      end: 19,
      segId: -1,
      existing,
    });
    expect(cells).toHaveLength(30);
    expect(cells[0].index).toBe(0);
    expect(cells[29].index).toBe(29);
  });

  it("草稿区间内标记 covered，区间外不标记", () => {
    const cells = buildLedCells({ ledCount: 30, start: 10, end: 19, segId: -1, existing });
    expect(cells[9].covered).toBe(false);
    expect(cells[10].covered).toBe(true);
    expect(cells[19].covered).toBe(true);
    expect(cells[20].covered).toBe(false);
  });

  it("已有段给出归属槽位与颜色（同带不同段颜色不同）", () => {
    const cells = buildLedCells({ ledCount: 30, start: 25, end: 29, segId: -1, existing });
    expect(cells[2].ownerSegId).toBe(0);
    expect(cells[2].hex).toBe("#FF0000");
    expect(cells[22].ownerSegId).toBe(1);
    expect(cells[22].hex).not.toBe(cells[2].hex);
  });

  it("草稿压到已有段时该格标 conflict（提交前就能看见）", () => {
    const cells = buildLedCells({ ledCount: 30, start: 18, end: 22, segId: -1, existing });
    expect(cells[19].covered).toBe(true);
    expect(cells[20].conflict).toBe(true);
    expect(cells[21].conflict).toBe(true);
    expect(cells[22].conflict).toBe(true);
    expect(cells[23].conflict).toBe(false);
  });

  it("编辑自己时不把自己算成冲突", () => {
    const cells = buildLedCells({ ledCount: 30, start: 0, end: 8, segId: 0, existing });
    expect(cells[0].conflict).toBe(false);
    expect(cells[0].ownerSegId).toBe(-1);
  });

  it("区间非法（-1）时显示全部未覆盖，不画假范围", () => {
    const cells = buildLedCells({ ledCount: 30, start: -1, end: -1, segId: -1, existing });
    expect(cells.every((cell) => !cell.covered)).toBe(true);
  });
});

describe("#42 默认草稿与空层", () => {
  it("新建草稿默认覆盖整条带、层 0 静态白、层 1 空", () => {
    const fresh = defaultDraft(2, 30);
    expect(fresh.stripId).toBe(2);
    expect(fresh.segId).toBe(-1);
    expect(fresh.startText).toBe("0");
    expect(fresh.endText).toBe("29");
    expect(fresh.layer0.type).toBe(SEGMENT_TYPE.STATIC);
    expect(fresh.layer1.type).toBe(NO_EFFECT);
    expect(fresh.blend).toBe(BLEND.OVER);
  });

  it("空层是副本，改一处不会影响别处", () => {
    const first = emptyLayerDraft();
    const second = emptyLayerDraft();
    first.type = SEGMENT_TYPE.STATIC;
    expect(second.type).toBe(NO_EFFECT);
  });
});
