/**
 * #79 渲染层契约：逐组灯珠数滑块 / 总灯珠数 / 缩小确认。
 *
 * 这几件事只有渲染层能看：滑块被删了、上下界写错、`bindchange` 写成 `bindinput`
 * （逐帧下发）、总数没绑到 `ledTotal`、确认流程被绕开——`tsc` 与纯函数单测
 * 全都发现不了。和 `app-config.test.ts` 的绑定检查同一种做法：直接读 WXML /
 * TS 文本，锁住结构，而不依赖模拟器是否开着。
 *
 * 行为本身（截断计划、受影响个数、去重口径）在 `led-count-plan.test.ts`。
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function src(relative: string): string {
  return readFileSync(join(ROOT, relative), "utf8");
}

describe("设备信息页：每组一条滑块 + 只读总数", () => {
  const wxml = src("pages/device-info/device-info.wxml");
  const ts = src("pages/device-info/device-info.ts");

  it("有 1–100 的滑块，且松手才下发（bindchange）", () => {
    expect(wxml).toContain('class="led-slider"');
    expect(wxml).toContain('min="{{ledMin}}"');
    expect(wxml).toContain('max="{{ledMax}}"');
    expect(wxml).toContain('step="1"');
    expect(wxml).toContain('bindchanging="onLedCountChanging"');
    expect(wxml).toContain('bindchange="onLedCountChange"');
    expect(wxml).toContain('data-strip-id="{{item.stripId}}"');
  });

  it("滑块在逐带循环里（每条灯组一条），不在单个输入框上", () => {
    /* `wx:for` 包住的行里有滑块：抽出 strip-info-row 到 `</view>` 之间的片段。 */
    const start = wxml.indexOf('wx:for="{{stripRows}}"');
    expect(start).toBeGreaterThan(0);
    const row = wxml.slice(start, wxml.indexOf("</slider>", start));
    expect(row).toContain('class="led-slider"');
    expect(row).toContain('value="{{item.ledCount}}"');
  });

  it("页面顶部是只读的总灯珠数，绑定 ledTotal", () => {
    expect(wxml).toContain("总灯珠数");
    expect(wxml).toContain("{{ledTotal}}");
    /* 只读：总数不是 input / slider。 */
    expect(/<input[^>]*ledTotal/.test(wxml)).toBe(false);
    expect(/<slider[^>]*ledTotal/.test(wxml)).toBe(false);
  });

  it("上下界来自协议常量（MIN_LEDS / MAX_LEDS）", () => {
    expect(ts).toContain("ledMin: MIN_LEDS");
    expect(ts).toContain("ledMax: MAX_LEDS");
  });

  it("拖动只改本地值：changing 分支不下发", () => {
    const changing = handlerBody(ts, "onLedCountChanging");
    expect(changing).toContain("clampLedCount");
    expect(changing).not.toContain("setLedCount");
  });

  it("缩小要二次确认，文案来自 shrinkConfirmText（带数量）", () => {
    expect(ts).toContain("shrinkConfirmText(precheck.affected, value)");
    expect(ts).toContain("showConfirm(");
    const change = handlerBody(ts, "onLedCountChange");
    /* 确认在前、下发在后：取消分支必须 return 且不调用 applyLedCount。 */
    const confirmAt = change.indexOf("showConfirm(");
    const applyAt = change.indexOf("this.applyLedCount(");
    expect(confirmAt).toBeGreaterThan(0);
    expect(applyAt).toBeGreaterThan(confirmAt);
    expect(change.slice(confirmAt, applyAt)).toContain("return;");
  });

  it("失败保留原值：ack-error / error 都走 revertLedCount", () => {
    const apply = handlerBody(ts, "applyLedCount");
    expect(apply).toContain("ledCountResultHint");
    expect(apply).toContain("this.revertLedCount(stripId, current");
    const revert = handlerBody(ts, "revertLedCount");
    expect(revert).toContain("ledCount: current");
  });
});

describe("灯组详情页：顶部当前组滑块", () => {
  const wxml = src("pages/strip/strip.wxml");
  const ts = src("pages/strip/strip.ts");

  it("滑块在页面顶部（灯组名之后、简单/进阶切换之前）", () => {
    const sliderAt = wxml.indexOf('class="led-count-slider"');
    expect(sliderAt).toBeGreaterThan(0);
    expect(sliderAt).toBeGreaterThan(wxml.indexOf('class="strip-head"'));
    expect(sliderAt).toBeLessThan(wxml.indexOf('class="mode-switch"'));
  });

  it("1–100、松手才下发", () => {
    expect(wxml).toContain('min="{{ledMin}}"');
    expect(wxml).toContain('max="{{ledMax}}"');
    expect(wxml).toContain('step="1"');
    expect(wxml).toContain('value="{{ledSliderValue}}"');
    expect(wxml).toContain('bindchanging="onLedCountChanging"');
    expect(wxml).toContain('bindchange="onLedCountChange"');
  });

  it("只改当前组：下发时显式传 stripId", () => {
    expect(ts).toContain("session.setLedCount(value, stripId)");
  });

  it("拖动中只改本地值（ledDraft），不逐帧下发", () => {
    const changing = handlerBody(ts, "onLedCountChanging");
    expect(changing).toContain("this.ledDraft = value");
    expect(changing).not.toContain("setLedCount");
  });

  it("缩小前确认，取消回到设备值且不动草稿", () => {
    const change = handlerBody(ts, "onLedCountChange");
    const confirmAt = change.indexOf("showModal(");
    expect(confirmAt).toBeGreaterThan(0);
    expect(change).toContain("shrinkConfirmText(affected, value)");
    const cancel = change.slice(confirmAt, change.indexOf("this.applyLedCount(", confirmAt));
    expect(cancel).toContain("this.backToDeviceLedCount();");
    expect(cancel).toContain("return;");
  });

  it("确认后草稿同步清理（shrinkDraft），只碰当前灯组", () => {
    const apply = handlerBody(ts, "applyLedCount");
    expect(apply).toContain("this.shrinkDraftsForStrip(applied)");
    const shrink = handlerBody(ts, "shrinkDraftsForStrip");
    expect(shrink).toContain("shrinkDraft(draft, stripId,");
  });

  it("失败就地显示原因并保留原数量", () => {
    const apply = handlerBody(ts, "applyLedCount");
    expect(apply).toContain("this.failLedCount(current, hint)");
    const fail = handlerBody(ts, "failLedCount");
    expect(fail).toContain("ledSliderValue: current");
    expect(fail).toContain("ledHint: hint");
  });
});

/** 取页面 TS 里某个方法的方法体（从 `名(` 到下一个顶层方法之前）。 */
function handlerBody(ts: string, name: string): string {
  const start = new RegExp(`\\n {2}(?:async\\s+)?${name}\\s*\\(`).exec(ts);
  if (start === null) {
    return "";
  }
  const from = start.index + 1;
  /* 顶层方法以两空格缩进开始；下一个两空格的 `word(` 就是它的结尾。 */
  const next = /\n {2}(?:async\s+)?[A-Za-z_$][\w$]*\s*\(/g;
  next.lastIndex = from + 1;
  const match = next.exec(ts);
  return ts.slice(from, match === null ? ts.length : match.index);
}
