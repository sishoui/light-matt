/**
 * #97 分区：改名、预览条颜色映射、选中态。
 *
 * 锁三件事：
 *  1. 界面上不再出现「光区」（统一「分区」）；
 *  2. 预览条逐颗画灯珠，颜色与分区一致，未覆盖的是空格子；
 *  3. 分区弹窗没有「取消」按钮（点空白就关），也没有「改范围」按钮。
 */

import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildPreviewLeds,
  isEndNode,
  isZoneSelected,
  previewAvailable,
  zoneColorsOf,
} from "../utils/control/zone-preview";
import { axisColorMap } from "../utils/control/zone-axis";
import type { SegmentSpec } from "../utils/protocol/types";
import { SEGMENT_TYPE } from "../utils/protocol/constants";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function zone(overrides: Partial<SegmentSpec> & { segId: number }): SegmentSpec {
  return {
    stripId: 0,
    segId: overrides.segId,
    start: 0,
    end: 9,
    blend: 0,
    layer0: { type: SEGMENT_TYPE.STATIC, hue: 0, sat: 255, periodMs: 0, p5: 0, flags: 0, level: 100 },
    layer1: null,
    ...overrides,
  } as SegmentSpec;
}

describe("术语：界面里不再出现「光区」", () => {
  function walk(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
      if (["node_modules", ".auto", "dist"].includes(entry)) continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full, out);
      else if (/\.(wxml|wxss|ts)$/.test(entry)) out.push(full);
    }
    return out;
  }

  it("页面与工具模块里一个「光区」都没有", () => {
    const offenders: string[] = [];
    for (const file of walk(join(ROOT, "pages")).concat(walk(join(ROOT, "utils")))) {
      const src = readFileSync(file, "utf8");
      if (src.includes("光区")) {
        offenders.push(relative(ROOT, file).replace(/\\/g, "/"));
      }
    }
    expect(offenders).toEqual([]);
  });

  it("页面上出现「分区」", () => {
    const wxml = readFileSync(join(ROOT, "pages/strip/strip.wxml"), "utf8");
    expect(wxml).toContain("分区");
  });
});

describe("预览条的颜色映射", () => {
  it("逐颗对应：分区范围内是分区颜色，未覆盖是空串", () => {
    const zones = [
      zone({ segId: 0, start: 0, end: 4, layer0: { ...zone({ segId: 0 }).layer0, hue: 0 } }),
      zone({ segId: 1, start: 5, end: 9, layer0: { ...zone({ segId: 1 }).layer0, hue: 32768 } }),
    ];
    const leds = buildPreviewLeds(zones, 10);
    expect(leds.length).toBe(10);
    const colors = zoneColorsOf(zones);
    expect(leds[0].hex).toBe(colors.get(0));
    expect(leds[4].hex).toBe(colors.get(0));
    expect(leds[5].hex).toBe(colors.get(1));
    expect(leds[9].hex).toBe(colors.get(1));
    expect(leds.every((led) => led.hex.length > 0)).toBe(true);
  });

  it("未覆盖的灯珠是空格子（segId -1、无颜色）", () => {
    const leds = buildPreviewLeds([zone({ segId: 0, start: 2, end: 5 })], 10);
    expect(leds[0]).toMatchObject({ index: 0, hex: "", segId: -1 });
    expect(leds[1].hex).toBe("");
    expect(leds[2].segId).toBe(0);
    expect(leds[5].segId).toBe(0);
    expect(leds[6].hex).toBe("");
  });

  it("起点 / 终点标记逐段标注", () => {
    const leds = buildPreviewLeds([zone({ segId: 0, start: 2, end: 5 })], 10);
    expect(leds[2].start).toBe(true);
    expect(leds[5].end).toBe(true);
    expect(leds[3].start).toBe(false);
    expect(leds[4].end).toBe(false);
  });

  it("颜色与分区轴用同一张色表（三处永远同色）", () => {
    const zones = [zone({ segId: 2, start: 0, end: 3, layer0: { ...zone({ segId: 2 }).layer0, hue: 43690, sat: 200 } })];
    const previewColors = zoneColorsOf(zones);
    const axisColors = axisColorMap(zones);
    expect(previewColors.get(2)).toBe(axisColors.get(2));
  });

  it("越界的旧分区被裁到范围内（不画出不存在的灯珠）", () => {
    const leds = buildPreviewLeds([zone({ segId: 0, start: 0, end: 50 })], 10);
    expect(leds.length).toBe(10);
    expect(leds[9].end).toBe(true);
  });

  it("灯珠数为 0 时返回空（不造虚空灯珠）", () => {
    expect(buildPreviewLeds([zone({ segId: 0 })], 0)).toEqual([]);
  });

  it("预览可用的条件：有分区且有灯珠", () => {
    expect(previewAvailable([zone({ segId: 0 })], 10)).toBe(true);
    expect(previewAvailable([], 10)).toBe(false);
    expect(previewAvailable([zone({ segId: 0 })], 0)).toBe(false);
  });
});

describe("选中态", () => {
  it("只有选中的分区算选中", () => {
    expect(isZoneSelected(2, 2)).toBe(true);
    expect(isZoneSelected(1, 2)).toBe(false);
    expect(isZoneSelected(-1, -1)).toBe(false);
  });

  it("结束节点判定只认 end 标记", () => {
    expect(isEndNode({ end: true })).toBe(true);
    expect(isEndNode({ end: false })).toBe(false);
  });
});

describe("页面结构：预览条 + 简化后的弹窗", () => {
  const wxml = readFileSync(join(ROOT, "pages/strip/strip.wxml"), "utf8");

  it("有预览按钮与逐颗灯珠的预览条", () => {
    expect(wxml).toContain("onPreviewToggle");
    expect(wxml).toContain('class="preview-strip"');
    expect(wxml).toContain("{{previewLeds}}");
  });

  it("预览条不绑任何 touch / tap 事件（只读）", () => {
    const block = wxml.slice(wxml.indexOf('class="preview-strip"'), wxml.indexOf("</view>", wxml.indexOf('class="preview-strip"')));
    expect(block).not.toContain("bindtap");
    expect(block).not.toContain("bindtouch");
    expect(block).not.toContain("bindlongpress");
  });

  it("分区弹窗没有「取消」按钮", () => {
    expect(wxml).not.toContain("onPickerCancel");
    const foot = wxml.slice(wxml.indexOf('class="picker-foot"'), wxml.indexOf("</view>", wxml.indexOf('class="picker-foot"')));
    expect(foot).not.toContain(">取消<");
  });

  it("没有「改范围」按钮", () => {
    expect(wxml).not.toContain("onZoneEditSelected");
    expect(wxml).not.toContain(">改范围<");
  });
});
