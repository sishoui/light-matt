/**
 * 灯效类型清单的单一真相（#74 的尾巴）。
 *
 * 为什么单独一个文件：`SEGMENT_TYPE` 是个开放枚举，随时可能再加一种效果。
 * 每次扩展都要有人记得同步「哪些算已知类型」和「每种叫什么名字」——漏一次
 * 就是「用户能选到，但预检说非法 / 摘要显示成 0x04」。这里把两份清单钉在
 * 枚举上，扩展枚举而不扩展它们会直接红。
 */

import { describe, expect, it } from "vitest";
import {
  EFFECT_TYPE_NAMES,
  KNOWN_EFFECT_TYPES,
  isKnownEffectType,
  NO_EFFECT,
  SEGMENT_TYPE,
} from "../utils/protocol/constants";
import { typeName } from "../utils/control/script-view";

/** 枚举里所有真实灯效（除空层）。 */
const REAL_TYPES = Object.entries(SEGMENT_TYPE)
  .filter(([, value]) => value !== SEGMENT_TYPE.EMPTY)
  .map(([, value]) => value as number);

describe("灯效类型清单与枚举同步", () => {
  it("KNOWN_EFFECT_TYPES 覆盖枚举里的每一种真实灯效", () => {
    for (const type of REAL_TYPES) {
      expect(isKnownEffectType(type), `类型 0x${type.toString(16)} 不在清单里`).toBe(true);
    }
    expect(KNOWN_EFFECT_TYPES).toHaveLength(REAL_TYPES.length);
  });

  it("空层不算真实灯效", () => {
    expect(isKnownEffectType(NO_EFFECT)).toBe(false);
    expect(KNOWN_EFFECT_TYPES).not.toContain(NO_EFFECT);
  });

  it("未知值（0x08 / 0x99）不算已知类型", () => {
    /* 0x07 在 #98 成为「随机闪烁」，所以「未知」用下一个空洞 0x08。 */
    expect(isKnownEffectType(0x07)).toBe(true);
    expect(isKnownEffectType(0x08)).toBe(false);
    expect(isKnownEffectType(0x99)).toBe(false);
  });

  it("每种真实灯效都有中文名，#74 的三种新灯效也不例外", () => {
    for (const type of REAL_TYPES) {
      const name = EFFECT_TYPE_NAMES[type];
      expect(name, `类型 0x${type.toString(16)} 缺中文名`).toBeTruthy();
      expect(name).not.toMatch(/^0x/);
    }
    expect(EFFECT_TYPE_NAMES[SEGMENT_TYPE.STROBE]).toBe("爆闪");
    expect(EFFECT_TYPE_NAMES[SEGMENT_TYPE.HEARTBEAT]).toBe("心跳");
    expect(EFFECT_TYPE_NAMES[SEGMENT_TYPE.OFF]).toBe("熄灭");
    expect(EFFECT_TYPE_NAMES[SEGMENT_TYPE.FLICKER]).toBe("随机闪烁");
  });

  it("typeName 与名字表一致（不再自己 switch 四种类型）", () => {
    for (const type of REAL_TYPES) {
      expect(typeName(type)).toBe(EFFECT_TYPE_NAMES[type]);
    }
    expect(typeName(SEGMENT_TYPE.STROBE)).toBe("爆闪");
    expect(typeName(SEGMENT_TYPE.HEARTBEAT)).toBe("心跳");
    expect(typeName(SEGMENT_TYPE.OFF)).toBe("熄灭");
    /* 未知类型仍给 hex，不静默当成静态。 */
    expect(typeName(0x99)).toBe("0x99");
  });

  it("新灯效的类型名不含禁用术语", () => {
    const forbidden = /毫秒|段|阶段|剧本|下发|激活|第.层|blend/i;
    for (const type of REAL_TYPES) {
      expect(EFFECT_TYPE_NAMES[type]).not.toMatch(forbidden);
    }
  });
});
