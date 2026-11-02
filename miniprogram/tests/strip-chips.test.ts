/**
 * #41 灯带切换器的视图派生（纯函数）：每条 chip 显示什么。
 *
 * 数据来源严格分开：
 *  - State（37B）：逐带灯珠数 / 段数 / 开关位 / 动画位；
 *  - QueryStripConfig（0x87）：GPIO，只读；
 *  - 设备登记表（App 本地）：启用掩码，只决定显示谁。
 *
 * 这里只测纯派生，不碰 wx / BLE。灯珠数必须**逐带真实值**——陈旧实现把
 * strip 0 的数量复制给所有带，那是这一票要消灭的缺陷。
 */

import { describe, expect, it } from "vitest";

import {
  buildStripChips,
  pickStripId,
  stripChipSummary,
} from "../utils/control/strip-chips";
import type { DeviceState, StripConfig } from "../utils/protocol/types";
import { baseState } from "./helpers/state";

function state(overrides: Partial<DeviceState> = {}): DeviceState {
  return baseState({
    stripCount: 3,
    stripCounts: [30, 45, 60, 0, 0, 0, 0, 0],
    stripSegCounts: [2, 0, 5, 0, 0, 0, 0, 0],
    stripPowerMask: 0b101,
    stripAnimMask: 0b100,
    ...overrides,
  });
}

function config(): StripConfig {
  const channels = [];
  for (let id = 0; id < 8; id += 1) {
    /* 只有 0 / 2 号带真正分配了引脚；其余 flags=0 且 gpio=0xFF（§7.4）。 */
    const assigned = id === 0 || id === 2;
    channels.push({
      stripId: id,
      gpio: id === 0 ? 3 : id === 2 ? 5 : 0xff,
      flags: assigned ? 1 : 0,
      assigned,
    });
  }
  return { channels };
}

describe("#41 strip chips：逐带真实灯珠数与 GPIO", () => {
  it("每条带显示自己的灯珠数（不是 strip 0 的复制）", () => {
    const chips = buildStripChips({ state: state(), config: config(), enabled: [0, 1, 2] });
    expect(chips.map((chip) => chip.ledCount)).toEqual([30, 45, 60]);
  });

  it("GPIO 来自 QueryStripConfig；未分配显示 —", () => {
    const chips = buildStripChips({ state: state(), config: config(), enabled: [0, 1, 2] });
    expect(chips[0].gpioText).toBe("GPIO 3");
    expect(chips[1].gpioText).toBe("—");
  });

  it("没有配置缓存时 GPIO 是未知而不是 0", () => {
    const chips = buildStripChips({ state: state(), config: null, enabled: [0] });
    expect(chips[0].gpioText).toBe("GPIO ?");
  });

  it("开关状态与动画标记按位取", () => {
    const chips = buildStripChips({ state: state(), config: config(), enabled: [0, 1, 2] });
    expect(chips.map((chip) => chip.on)).toEqual([true, false, true]);
    expect(chips.map((chip) => chip.animating)).toEqual([false, false, true]);
  });

  it("段数来自 State 的逐带字段", () => {
    const chips = buildStripChips({ state: state(), config: config(), enabled: [0, 1, 2] });
    expect(chips.map((chip) => chip.segCount)).toEqual([2, 0, 5]);
  });

  it("未连接（state 为 null）时给空列表，不编造 8 条空带", () => {
    expect(buildStripChips({ state: null, config: null, enabled: [0, 1, 2] })).toEqual([]);
  });

  it("启用掩码只过滤显示，不改变其余带的数值", () => {
    const all = buildStripChips({ state: state(), config: config(), enabled: [0, 1, 2] });
    const hidden = buildStripChips({ state: state(), config: config(), enabled: [0, 2] });
    expect(hidden.map((chip) => chip.stripId)).toEqual([0, 2]);
    expect(hidden[1]).toEqual(all[2]);
  });

  it("越界的 enabled 值被忽略（登记表脏数据不能画出不存在的带）", () => {
    const chips = buildStripChips({ state: state(), config: config(), enabled: [0, 7] });
    expect(chips.map((chip) => chip.stripId)).toEqual([0]);
  });

  it("selected 只标在当前选中的带上", () => {
    const chips = buildStripChips({
      state: state(),
      config: config(),
      enabled: [0, 1, 2],
      selectedStripId: 1,
    });
    expect(chips.map((chip) => chip.selected)).toEqual([false, true, false]);
  });

  it("摘要文本包含灯珠数 / 光区数 / 开关（调试与窄屏共用一份规则）", () => {
    const chip = buildStripChips({ state: state(), config: config(), enabled: [0, 1, 2] })[2];
    expect(stripChipSummary(chip)).toBe("60 灯 · 5 个光区 · 开");
    expect(stripChipSummary({ ...chip, on: false, animating: false })).toBe("60 灯 · 5 个光区 · 关");
  });
});

describe("#41 pickStripId：切换后选中哪条带", () => {
  const state3 = state();
  it("当前带仍可见就保持（切页回来不跳带）", () => {
    expect(pickStripId(state3, [0, 1, 2], 1)).toBe(1);
  });

  it("当前带被隐藏时退到第一条可见带", () => {
    expect(pickStripId(state3, [0, 2], 1)).toBe(0);
  });

  it("没有任何可见带时返回 -1（页面给空态而不是写设备）", () => {
    expect(pickStripId(state3, [], 1)).toBe(-1);
    expect(pickStripId(null, [0], 0)).toBe(-1);
  });

  it("没有选中（-1）时取第一条可见带", () => {
    expect(pickStripId(state3, [0, 1, 2], -1)).toBe(0);
  });
});
