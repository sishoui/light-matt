/**
 * #96 八个灯效清单 + 立即生效。
 *
 * 锁三件事：
 *  1. 恰好八个灯效，名字里没有颜色词（「彩虹」例外）；
 *  2. 「空」编码成既有的熄灭类型（协议要求每段背景层是真实灯效）；
 *  3. 页面没有「应用并播放」按钮，且生效顺序是「停播 → 写 → 恢复」。
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  FORBIDDEN_COLOR_WORDS,
  SIMPLE_EFFECTS,
  buildEffectRows,
  buildWheelOptions,
  effectTypeOf,
  emptyEffectType,
  hasColorWord,
  simpleEffectIdOfType,
  simpleEffectOf,
} from "../utils/control/simple-effects";
import { SEGMENT_TYPE } from "../utils/protocol/constants";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const STRIP_TS = readFileSync(join(ROOT, "pages/strip/strip.ts"), "utf8");
const STRIP_WXML = readFileSync(join(ROOT, "pages/strip/strip.wxml"), "utf8");

describe("八个灯效清单", () => {
  it("恰好八个，顺序符合票面", () => {
    expect(SIMPLE_EFFECTS.length).toBe(8);
    expect(SIMPLE_EFFECTS.map((effect) => effect.name)).toEqual([
      "空",
      "常亮",
      "呼吸",
      "彩虹",
      "流星",
      "爆闪",
      "心跳",
      "随机闪烁",
    ]);
  });

  it("名字里没有颜色词（「彩虹」是唯一例外）", () => {
    for (const effect of SIMPLE_EFFECTS) {
      expect(hasColorWord(effect.name), effect.name).toBe(false);
    }
    /* 反向验证：规则本身真的会拦住带颜色的名字。 */
    expect(hasColorWord("暖白常亮")).toBe(true);
    expect(hasColorWord("爆闪白")).toBe(true);
    expect(hasColorWord("心跳暖红")).toBe(true);
    expect(hasColorWord("熄灭黑")).toBe(true);
    expect(hasColorWord("彩虹")).toBe(false);
    expect(FORBIDDEN_COLOR_WORDS.length).toBeGreaterThan(5);
  });

  it("不再出现「熄灭」「脉冲」这两个词", () => {
    const names = SIMPLE_EFFECTS.map((effect) => effect.name);
    expect(names).not.toContain("熄灭");
    expect(names).not.toContain("脉冲");
    /* 「空」承担了原来的「熄灭」语义。 */
    expect(names).toContain("空");
  });

  it("除「空」外每项都指向一个真实的协议类型，且互不重复", () => {
    const types = SIMPLE_EFFECTS.filter((effect) => effect.id !== "empty").map(
      (effect) => effect.type,
    );
    expect(new Set(types).size).toBe(types.length);
    for (const type of types) {
      expect(Object.values(SEGMENT_TYPE)).toContain(type);
    }
  });

  it("随机闪烁用的是 #98 的新类型 0x07", () => {
    expect(simpleEffectOf("flicker")!.type).toBe(SEGMENT_TYPE.FLICKER);
  });

  it("心跳是独立项（「脉冲」并入心跳）", () => {
    expect(simpleEffectOf("heartbeat")!.type).toBe(SEGMENT_TYPE.HEARTBEAT);
  });

  it("每项都有 id / 名字 / 说明", () => {
    for (const effect of SIMPLE_EFFECTS) {
      expect(effect.id.length).toBeGreaterThan(0);
      expect(effect.name.length).toBeGreaterThan(0);
      expect(effect.hint.length).toBeGreaterThan(0);
    }
    expect(new Set(SIMPLE_EFFECTS.map((effect) => effect.id)).size).toBe(8);
  });
});

describe("「空」的编码", () => {
  it("空 = 既有的熄灭类型", () => {
    expect(emptyEffectType()).toBe(SEGMENT_TYPE.OFF);
    expect(effectTypeOf("empty")).toBe(SEGMENT_TYPE.OFF);
  });

  it("其余灯效的类型原样透传", () => {
    expect(effectTypeOf("solid")).toBe(SEGMENT_TYPE.STATIC);
    expect(effectTypeOf("breathe")).toBe(SEGMENT_TYPE.BREATHING);
    expect(effectTypeOf("rainbow")).toBe(SEGMENT_TYPE.RAINBOW);
    expect(effectTypeOf("comet")).toBe(SEGMENT_TYPE.COMET);
    expect(effectTypeOf("strobe")).toBe(SEGMENT_TYPE.STROBE);
    expect(effectTypeOf("heartbeat")).toBe(SEGMENT_TYPE.HEARTBEAT);
    expect(effectTypeOf("flicker")).toBe(SEGMENT_TYPE.FLICKER);
  });

  it("设备读回 OFF 时映射回「空」（不是「熄灭」）", () => {
    expect(simpleEffectIdOfType(SEGMENT_TYPE.OFF)).toBe("empty");
    expect(simpleEffectIdOfType(SEGMENT_TYPE.FLICKER)).toBe("flicker");
    expect(simpleEffectIdOfType(0x55)).toBeNull();
  });
});

describe("一行式视图与滚轮", () => {
  it("只有一行（灯效），左边名称右边当前值", () => {
    const rows = buildEffectRows("breathe");
    expect(rows.length).toBe(1);
    expect(rows[0].label).toBe("灯效");
    expect(rows[0].value).toBe("呼吸");
  });

  it("没选中时显示「空」", () => {
    expect(buildEffectRows(null)[0].value).toBe("空");
  });

  it("滚轮给出八个选项，当前选中带勾", () => {
    const options = buildWheelOptions("comet");
    expect(options.length).toBe(8);
    expect(options.filter((option) => option.check).map((option) => option.id)).toEqual(["comet"]);
    expect(options.every((option) => option.name.length > 0)).toBe(true);
  });

  it("滚轮选项名称同样不带颜色（彩虹除外）", () => {
    for (const option of buildWheelOptions(null)) {
      expect(hasColorWord(option.name), option.name).toBe(false);
    }
  });
});

describe("页面结构：一行式 + 无「应用并播放」", () => {
  it("页面没有色块网格（quick-grid / quick-card）", () => {
    expect(STRIP_WXML).not.toContain("quick-grid");
    expect(STRIP_WXML).not.toContain("quick-card");
  });

  it("有一行式灯效列表与滚轮弹层", () => {
    expect(STRIP_WXML).toContain('class="effect-list');
    expect(STRIP_WXML).toContain('class="effect-row');
    expect(STRIP_WXML).toContain('wx:if="{{effectWheelOpen}}"');
    expect(STRIP_WXML).toContain('class="wheel-row');
    expect(STRIP_TS).toContain("onEffectRowTap");
    expect(STRIP_TS).toContain("onEffectPick");
  });

  it("页面上没有「应用并播放」按钮", () => {
    /* 注释里提到这段文字是解释「为什么没有」，不算按钮。 */
    const body = STRIP_WXML.replace(/<!--[\s\S]*?-->/g, "");
    expect(body).not.toContain("应用并播放");
    expect(STRIP_WXML).not.toContain("onApplyAndPlay");
  });

  it("选中灯效立即写入（selectEffect → scheduleQuickWrite(true)）", () => {
    const body = /\n {2}selectEffect\(effectId: string\): void \{([\s\S]*?)\n {2}\},/.exec(
      STRIP_TS,
    );
    expect(body).not.toBeNull();
    expect(body![1]).toContain("scheduleQuickWrite(true)");
  });
});

describe("立即生效的顺序：停播 → 写 → 恢复", () => {
  it("写入前若在播放就先停，并记住「原来在播」", () => {
    const body = /async writeQuick\(\): Promise<void> \{([\s\S]*?)\n {2}\},/.exec(STRIP_TS);
    expect(body).not.toBeNull();
    const src = body![1];
    const wasAt = src.indexOf("const wasPlaying");
    const stopAt = src.indexOf("await session.setPlayback(0");
    const writeAt = src.indexOf("await session.setSegment");
    expect(wasAt).toBeGreaterThanOrEqual(0);
    expect(stopAt).toBeGreaterThan(wasAt);
    expect(writeAt).toBeGreaterThan(stopAt);
  });

  it("写完**不**恢复播放：改色 = 停播转实时灯效（#139）", () => {
    /* 这条以前锁的是「恢复播放」——那是 #139 之前的语义。票面裁决改了：
     * 简单档改色只改实时灯效，不重下方案、不恢复播放，否则用户以为自己
     * 只是临时换个颜色，实际动了自己编排的整份方案。 */
    const body = /async writeQuick\(\): Promise<void> \{([\s\S]*?)\n {2}\},/.exec(STRIP_TS);
    const src = body![1];
    expect(src).not.toMatch(/setPlayback\(1, loopMode\)/);
    expect(src).toContain("已停止播放");
  });

  it("停播用的是三值循环模式（#98），不是布尔", () => {
    const body = /async writeQuick\(\): Promise<void> \{([\s\S]*?)\n {2}\},/.exec(STRIP_TS);
    expect(body![1]).toContain("stateLoopMode(state)");
    expect(body![1]).not.toMatch(/setPlayback\(0, \(state\.flags & 0x01\)/);
  });

  it("写入失败时页面顶部有一行原因（不弹模态）", () => {
    const body = /async writeQuick\(\): Promise<void> \{([\s\S]*?)\n {2}\},/.exec(STRIP_TS);
    expect(body![1]).toContain("写入失败：");
    /* 不用 wx.showModal / showToast 报写入失败。 */
    expect(body![1]).not.toContain("wx.showModal");
  });

  it("空方案不写设备（silentDownloadPlans 先判断 planIsEmpty）", () => {
    const body = /\n {2}async silentDownloadPlans\(loop: LoopMode\): Promise<void> \{([\s\S]*?)\n {2}\},/.exec(
      STRIP_TS,
    );
    expect(body).not.toBeNull();
    expect(body![1]).toContain("planIsEmpty(draft)");
    const guard = body![1].indexOf("planIsEmpty(draft)");
    const download = body![1].indexOf("downloadScript");
    expect(guard).toBeGreaterThanOrEqual(0);
    expect(download).toBeGreaterThan(guard);
  });

  it("旁路下发保持调用方给的循环档位（#114：写死档位会篡改设备）", () => {
    const body = /\n {2}async silentDownloadPlans\(loop: LoopMode\): Promise<void> \{([\s\S]*?)\n {2}\},/.exec(
      STRIP_TS,
    );
    expect(body).not.toBeNull();
    expect(body![1]).toContain("{ activate: true, loop }");
    expect(body![1]).not.toContain("loop: false");
  });
});

describe("参数控件与进阶档一致", () => {
  it("简单档参数区与进阶档共用同一张模板（effect-controls）", () => {
    /* 三处引用同一张模板：简单档 / 背景层 / 特效层。 */
    const uses = STRIP_WXML.match(/is="effect-controls"/g) ?? [];
    expect(uses.length, "简单档 + 背景层 + 特效层三处都要引用模板").toBe(3);
    expect(STRIP_WXML).toMatch(/class="param-row"/);
    expect(STRIP_WXML).toMatch(/class="param-slider"/);
    /* 色相用色环色带（彩虹渐变），不是纯色滑块。 */
    expect(STRIP_TS).toContain("HUE_RAMP_GRADIENT");
  });

  it("模板里每个控件都带 data-scope（否则分派不到正确的层）", () => {
    /*
     * 这是 #135 那类缺陷的重演风险：模板参数只是数据，事件处理器读的是
     * `dataset`。少一个 `data-scope`，那一路的改动会静默落到「背景层」上
     * ——看起来点了有反应，改的却是另一层。
     */
    const tpl = /<template name="effect-controls">([\s\S]*?)<\/template>/.exec(STRIP_WXML);
    expect(tpl).not.toBeNull();
    const body = tpl![1];
    /*
     * 滑块有三个变体（彩虹轨 / 渐变轨 / 主题色轨），三个都绑同一组处理器；
     * 选项组一个。每个会触发事件的元素都要有 data-scope。
     */
    const sliders = body.split("<slider").length - 1;
    const elements = sliders + (body.includes('bindtap="onScopeChoiceTap"') ? 1 : 0);
    const scopes = body.match(/data-scope="\{\{scope\}\}"/g) ?? [];
    expect(scopes.length, "每个会触发事件的元素都要带 data-scope").toBe(elements);
    /* 三个滑块变体都要绑上，不能只有一个能拖动。 */
    expect(body.match(/bindchange="onScopeSliderChange"/g)?.length).toBe(3);
  });

  it("混合方式选择器已经删除（两层恒用按亮度叠加）", () => {
    expect(STRIP_WXML).not.toContain("混合方式");
    expect(STRIP_WXML).not.toContain("onOverlayBlendTap");
    expect(STRIP_TS).not.toContain("onOverlayBlendTap");
  });

  it("进阶档是两个独立的卡片，不是一个卡片里的两块", () => {
    /* 两张卡各自有 section-head 与独立的类型行。 */
    expect(STRIP_WXML).toContain('class="section panel-section overlay-card"');
    const titles = STRIP_WXML.match(/<text class="section-title">(背景层|特效层)<\/text>/g) ?? [];
    expect(titles.length).toBe(2);
  });
});
