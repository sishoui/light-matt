/**
 * #98 的编解码：流星密度 / 实色拖尾、随机闪烁。
 *
 * 这几种灯效的字节语义在 v5 **原样保留**（层仍是 9 字节、flags 仍是 1 字节），
 * 只是宿主从「段」换成了「场景的一步」。这里只测「字节」与「拒绝规则」——
 * 固件的像素数学另有 host 测试。
 *
 * v4 的「段载荷 23 字节」「剧本循环三值」两部分随模型退役（0x10-0x1E 回 0x02），
 * 已删除；循环三值现在挂在**每部位**的 `ScenePart` 上（§7.5）。
 */

import { describe, expect, it } from "vitest";

import {
  EMPTY_LAYER,
  cmdScenePart,
  cmdSceneStep,
  cometFlags,
  cometHeads,
  cometSolidTail,
  encodeLayer,
  minPeriodMs,
  staticLayer,
} from "../utils/protocol/commands";
import {
  COMET_FLAG,
  COMET_FLAGS_RESERVED,
  COMET_HEADS_MAX,
  EFFECT_TYPE,
  LOOP,
  MAX_STEPS,
  NO_EFFECT,
  SCENE_STEP_BYTES,
} from "../utils/protocol/constants";

/** 一个流星层（只关心 flags / period）。 */
function cometLayer(flags: number, periodMs = 1200) {
  return {
    type: EFFECT_TYPE.COMET,
    hue: 0,
    sat: 255,
    periodMs,
    p5: 8,
    flags,
    level: 100,
  };
}

describe("#98 流星：密度与实色拖尾都进 flags 字节", () => {
  it("头数量 1-4 编码到 bit2-3，且能解回", () => {
    for (let heads = 1; heads <= COMET_HEADS_MAX; heads += 1) {
      /* cometFlags(reverse, solidTail, heads) 的第三参数是头数量。 */
      const flags = cometFlags(false, false, heads);
      /* 头数量绝不碰保留位，也绝不碰 direction / 拖尾位。 */
      expect(flags & COMET_FLAGS_RESERVED).toBe(0);
      expect(flags & 0x03).toBe(0);
      expect(cometHeads(flags)).toBe(heads);
    }
    expect(cometFlags(false, false, 1)).toBe(0x00);
    expect(cometFlags(false, false, 2)).toBe(0x04);
    expect(cometFlags(false, false, 3)).toBe(0x08);
    expect(cometFlags(false, false, 4)).toBe(0x0c);
  });

  it("实色拖尾是 bit1、反向是 bit0，两者可与密度叠加", () => {
    expect(cometFlags(false, true, 1)).toBe(COMET_FLAG.SOLID_TAIL);
    expect(cometSolidTail(cometFlags(false, true, 1))).toBe(true);
    expect(cometSolidTail(cometFlags(false, false, 1))).toBe(false);
    expect(cometFlags(true, true, 4)).toBe(0x0f);
    expect(cometHeads(0x0f)).toBe(4);
  });

  it("头数量越界直接抛错（不静默钳位）", () => {
    expect(() => cometFlags(false, false, 0)).toThrow(RangeError);
    expect(() => cometFlags(false, false, 5)).toThrow(RangeError);
    expect(() => cometFlags(false, false, 2.5)).toThrow(RangeError);
  });

  it("场景的一步仍是 24 字节，flags 原样落到层的第 8 个字节", () => {
    const flags = cometFlags(true, true, 4);
    const req = cmdSceneStep({
      sceneId: 0,
      stripId: 0,
      partId: 0,
      stepIndex: 0,
      durationMs: 1000,
      layer0: cometLayer(flags),
      layer1: EMPTY_LAYER,
    });
    expect(req.payload.length).toBe(SCENE_STEP_BYTES);
    /* 载荷：前缀 6 字节 + layer0（9）+ layer1（9）。 */
    expect(req.payload[6]).toBe(EFFECT_TYPE.COMET);
    expect(req.payload[6 + 7]).toBe(flags);
    expect(cometHeads(req.payload[6 + 7])).toBe(4);
    expect(cometSolidTail(req.payload[6 + 7])).toBe(true);
    expect(req.payload[15]).toBe(NO_EFFECT);
  });

  it("周期下限仍是 200ms（流星属于空间移动）", () => {
    expect(minPeriodMs(EFFECT_TYPE.COMET)).toBe(200);
    expect(minPeriodMs(EFFECT_TYPE.RAINBOW)).toBe(200);
    /* 随机闪烁是亮度闪烁，借用呼吸的 334ms。 */
    expect(minPeriodMs(EFFECT_TYPE.FLICKER)).toBe(334);
  });

  it("编码本身不校验 flags 保留位（命令层 / 设备判）", () => {
    /* encodeLayer 只做范围与形状，保留位由形状校验的同一份规则在设备侧
     *（以及 SceneStep 的形状校验里）判。这里确认它不吞错。 */
    const bytes = encodeLayer(cometLayer(0x10));
    expect(bytes[7]).toBe(0x10);
  });
});

describe("随机闪烁（0x07）的层编码", () => {
  it("type 0x07 可编码，flags 由调用方给 0", () => {
    const bytes = encodeLayer({
      type: EFFECT_TYPE.FLICKER,
      hue: 0,
      sat: 255,
      periodMs: 800,
      p5: 128,
      flags: 0,
      level: 100,
    });
    expect(bytes[0]).toBe(EFFECT_TYPE.FLICKER);
    expect(bytes[7]).toBe(0);
  });

  it("随机闪烁的周期下限是 334ms，0 表示静止", () => {
    expect(minPeriodMs(EFFECT_TYPE.FLICKER)).toBe(334);
  });
});

describe("循环三值（v5 挂在每部位，§7.5）", () => {
  it("0/1/2 合法，3 拒绝", () => {
    for (const loop of [LOOP.NONE, LOOP.ALL, LOOP.LAST]) {
      const req = cmdScenePart(0, 0, 0, 1, loop, true);
      expect(req.payload[4]).toBe(loop);
    }
    expect(() => cmdScenePart(0, 0, 0, 1, 3, true)).toThrow(RangeError);
  });

  it("步数 0-8；超过 MAX_STEPS 拒绝", () => {
    expect(cmdScenePart(0, 0, 0, 0, LOOP.NONE, false).payload[3]).toBe(0);
    expect(cmdScenePart(0, 0, 0, MAX_STEPS, LOOP.ALL, true).payload[3]).toBe(MAX_STEPS);
    expect(() => cmdScenePart(0, 0, 0, MAX_STEPS + 1, LOOP.ALL, true)).toThrow(RangeError);
  });

  it("静态层是 encodeLayer 的稳定基准（回归锚点）", () => {
    expect(Array.from(encodeLayer(staticLayer(0, 255, 100)))).toEqual([
      EFFECT_TYPE.STATIC,
      0,
      0,
      255,
      0,
      0,
      0,
      0,
      100,
    ]);
  });
});
