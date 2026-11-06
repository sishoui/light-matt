/**
 * 灯效类型清单的单一真相（#74 的尾巴，v5 形状）。
 *
 * 这个文件原本测 v4 的 `SEGMENT_TYPE`。v5 把它换成 `EFFECT_TYPE`（值没变、
 * 名字没变），但**要锁的东西一模一样**：`EFFECT_TYPE` 是个开放枚举，随时可能
 * 再加一种效果。每次扩展都要有人记得同步「哪些算已知类型」和「每种叫什么名字」
 * ——漏一次就是「用户能选到，但预检说非法 / 摘要显示成 0x04」。
 *
 * 所以这里把两份清单钉在枚举上：扩展枚举而不扩展它们会直接红。
 */

import { describe, expect, it } from "vitest";
import {
  EFFECT_TYPE,
  EFFECT_TYPE_NAMES,
  KNOWN_EFFECT_TYPES,
  NO_EFFECT,
  isKnownEffectType,
} from "../utils/protocol/constants";
import { PANEL_TYPE_OPTIONS, panelTypeOf, panelTypeValue } from "../utils/control/effect-panel";

/** 枚举里所有真实灯效（除空层）。 */
const REAL_TYPES = Object.entries(EFFECT_TYPE)
  .filter(([, value]) => value !== EFFECT_TYPE.EMPTY)
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
    expect(NO_EFFECT).toBe(EFFECT_TYPE.EMPTY);
  });

  it("未知值（0x08 / 0x99）不算已知类型", () => {
    /* 0x07 是「随机闪烁」，所以「未知」用下一个空洞 0x08。 */
    expect(isKnownEffectType(0x07)).toBe(true);
    expect(isKnownEffectType(0x08)).toBe(false);
    expect(isKnownEffectType(0x99)).toBe(false);
  });

  it("每种真实灯效都有中文名，三种新灯效也不例外", () => {
    for (const type of REAL_TYPES) {
      const name = EFFECT_TYPE_NAMES[type];
      expect(name, `类型 0x${type.toString(16)} 没有中文名`).toBeTruthy();
      expect(name).not.toMatch(/^0x/i);
    }
    expect(EFFECT_TYPE_NAMES[EFFECT_TYPE.STROBE]).toBe("爆闪");
    expect(EFFECT_TYPE_NAMES[EFFECT_TYPE.HEARTBEAT]).toBe("心跳");
    expect(EFFECT_TYPE_NAMES[EFFECT_TYPE.FLICKER]).toBe("随机闪烁");
    expect(EFFECT_TYPE_NAMES[NO_EFFECT]).toBe("无");
  });

  it("八个灯效清单恰好八项，且与协议枚举一一对应", () => {
    /* 七个「有光」的灯效 + 「空」（界面上就是熄灭类型）。 */
    expect(PANEL_TYPE_OPTIONS).toHaveLength(8);
    const values = PANEL_TYPE_OPTIONS.map((option) => panelTypeValue(option.type));
    expect(new Set(values).size).toBe(8);
    for (const value of values) {
      expect(isKnownEffectType(value), `清单里的 0x${value.toString(16)} 非法`).toBe(true);
    }
    /* 反向：每个真实灯效都在清单里（没有「能下发但选不到」的类型）。 */
    for (const type of REAL_TYPES) {
      expect(values, `类型 0x${type.toString(16)} 不在清单里`).toContain(type);
    }
  });

  it("名字不带颜色词（用户是来选效果的，不是来选颜色的）", () => {
    /* 「彩虹」是唯一例外：它本身就是彩色的。 */
    const colourWords = ["红", "橙", "黄", "绿", "蓝", "紫", "白", "青", "粉"];
    for (const option of PANEL_TYPE_OPTIONS) {
      for (const word of colourWords) {
        expect(option.name.includes(word), `${option.type} → ${option.name}`).toBe(false);
      }
    }
  });

  it("类型名与 EFFECT_TYPE_NAMES 是同一份（面板不另写一套文案）", () => {
    for (const option of PANEL_TYPE_OPTIONS) {
      expect(option.name).toBe(EFFECT_TYPE_NAMES[panelTypeValue(option.type)]);
    }
  });

  it("协议值 → 面板类型是双向稳定的", () => {
    for (const option of PANEL_TYPE_OPTIONS) {
      expect(panelTypeOf(panelTypeValue(option.type)), option.type).toBe(option.type);
    }
    /* 空层与未知值都按静态显示：空层不是「熄灭」，它表示这里没效果。 */
    expect(panelTypeOf(NO_EFFECT)).toBe("static");
    expect(panelTypeOf(0x99)).toBe("static");
  });
});
