/**
 * #93 首页的搜索、长按菜单与亮度防抖。
 *
 * 锁三件用户能感知的行为：
 *  1. 搜索只匹配名称（备注名优先的展示名），不区分大小写，不匹配设备标识；
 *  2. 长按菜单五项，可用性随连接态与封面态变化；
 *  3. 亮度拖动期间只改本地，停手后**只发最后一条**。
 */

import { describe, expect, it, vi } from "vitest";
import {
  BRIGHTNESS_DEBOUNCE_MS,
  brightnessDragPercent,
  buildHomeMenu,
  buildSearchView,
  createDebouncer,
  filterCards,
} from "../utils/control/home-actions";
import { buildHomeView, type DeviceCard } from "../utils/control/home-view";
import type { RecentDevice } from "../utils/control/device-history";

function card(overrides: Partial<DeviceCard> & { key: string }): DeviceCard {
  return {
    deviceId: overrides.key,
    name: "Lumen-1",
    initial: "L",
    connected: false,
    selected: false,
    statusText: "未连接",
    metaText: "1 条灯带",
    tone: "offline",
    colorHex: "#8e8e93",
    glow: 0,
    powerOn: false,
    brightnessPercent: null,
    photo: "",
    photoIsUserPicked: false,
    ...overrides,
  };
}

describe("首页搜索", () => {
  const cards = [
    card({ key: "a", name: "客厅灯带" }),
    card({ key: "b", name: "书桌" }),
    card({ key: "c", name: "Lumen-9B77" }),
  ];

  it("空词返回全部（保持原顺序）", () => {
    expect(filterCards(cards, "").map((c) => c.key)).toEqual(["a", "b", "c"]);
    expect(filterCards(cards, "   ").map((c) => c.key)).toEqual(["a", "b", "c"]);
  });

  it("按名称子串匹配（中文与英文都行）", () => {
    expect(filterCards(cards, "灯带").map((c) => c.key)).toEqual(["a"]);
    expect(filterCards(cards, "书").map((c) => c.key)).toEqual(["b"]);
    expect(filterCards(cards, "lumen").map((c) => c.key)).toEqual(["c"]);
  });

  it("不区分大小写、忽略首尾空白", () => {
    expect(filterCards(cards, "  LUMEN  ").map((c) => c.key)).toEqual(["c"]);
  });

  it("不匹配设备标识（只看 name）", () => {
    const withId = [card({ key: "AA:BB:CC", name: "书桌" })];
    expect(filterCards(withId, "AA:BB")).toEqual([]);
  });

  it("搜索态给出命中结果与空态文案", () => {
    const hit = buildSearchView(cards, "书");
    expect(hit.searching).toBe(true);
    expect(hit.results.map((c) => c.key)).toEqual(["b"]);
    expect(hit.emptyText).toBe("");

    const miss = buildSearchView(cards, "zzz");
    expect(miss.searching).toBe(true);
    expect(miss.results).toEqual([]);
    expect(miss.emptyText).toContain("zzz");
  });

  it("非搜索态不显示空态文案（大卡 + 小图照旧）", () => {
    const view = buildSearchView(cards, "");
    expect(view.searching).toBe(false);
    expect(view.results.length).toBe(3);
    expect(view.emptyText).toBe("");
  });

  it("备注名优先体现在卡片 name 上（搜索跟着走）", () => {
    const recent: RecentDevice = {
      deviceId: "DEV-A",
      hardwareId: "AA:BB",
      name: "Lumen-9B77",
      lastConnectedAt: 1,
    };
    const view = buildHomeView({
      recent: [recent],
      registry: [{ deviceId: "DEV-A", hardwareId: "AA:BB", stripMask: 0xff, remark: "客厅灯带" }],
      currentDeviceId: "",
      state: null,
      selectedKey: "",
    });
    expect(filterCards(view.cards, "客厅")).toHaveLength(1);
    expect(filterCards(view.cards, "lumen-9b77")).toHaveLength(0);
  });
});

describe("长按菜单", () => {
  it("五项，顺序固定", () => {
    const menu = buildHomeMenu({ connected: true, photoIsUserPicked: true });
    expect(menu.map((item) => item.action)).toEqual([
      "rename",
      "pickPhoto",
      "clearPhoto",
      "disconnect",
      "delete",
    ]);
    expect(menu.every((item) => item.enabled)).toBe(true);
  });

  it("未连接时「断开连接」不可用", () => {
    const menu = buildHomeMenu({ connected: false, photoIsUserPicked: false });
    expect(menu.find((item) => item.action === "disconnect")!.enabled).toBe(false);
  });

  it("没有自定义封面时「移除封面」不可用", () => {
    const menu = buildHomeMenu({ connected: true, photoIsUserPicked: false });
    expect(menu.find((item) => item.action === "clearPhoto")!.enabled).toBe(false);
  });

  it("删除是唯一危险项", () => {
    const menu = buildHomeMenu({ connected: true, photoIsUserPicked: true });
    expect(menu.filter((item) => item.danger).map((item) => item.action)).toEqual(["delete"]);
  });

  it("每项都有可读文案（不出现空白标签）", () => {
    for (const item of buildHomeMenu({ connected: true, photoIsUserPicked: true })) {
      expect(item.label.trim().length).toBeGreaterThan(0);
      expect(item.sub.trim().length).toBeGreaterThan(0);
    }
  });
});

describe("亮度百分比换算", () => {
  it("按设备上限换算", () => {
    expect(brightnessDragPercent(200, 200)).toBe(100);
    expect(brightnessDragPercent(100, 200)).toBe(50);
    expect(brightnessDragPercent(0, 200)).toBe(0);
  });

  it("越界钳位，不产生负数或超过 100", () => {
    expect(brightnessDragPercent(-10, 200)).toBe(0);
    expect(brightnessDragPercent(400, 200)).toBe(100);
  });

  it("上限非法时按 0%（不产生 NaN）", () => {
    expect(brightnessDragPercent(10, 0)).toBe(0);
    expect(brightnessDragPercent(Number.NaN, 200)).toBe(0);
  });
});

describe("亮度防抖：只发最后一个值", () => {
  it("连续 push 只 commit 一次，且是最后那个值", () => {
    vi.useFakeTimers();
    try {
      const commit = vi.fn();
      const debouncer = createDebouncer<number>(commit, { delayMs: BRIGHTNESS_DEBOUNCE_MS });
      debouncer.push(10);
      debouncer.push(20);
      debouncer.push(30);
      expect(commit).not.toHaveBeenCalled();
      vi.advanceTimersByTime(BRIGHTNESS_DEBOUNCE_MS - 1);
      expect(commit).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(commit).toHaveBeenCalledTimes(1);
      expect(commit).toHaveBeenCalledWith(30);
    } finally {
      vi.useRealTimers();
    }
  });

  it("每次 push 重置计时器（拖动中不会提前下发）", () => {
    vi.useFakeTimers();
    try {
      const commit = vi.fn();
      const debouncer = createDebouncer<number>(commit, { delayMs: 300 });
      debouncer.push(1);
      vi.advanceTimersByTime(250);
      debouncer.push(2);
      vi.advanceTimersByTime(250);
      /* 距第一次 500ms，但距最后一次只有 250ms：不该发。 */
      expect(commit).not.toHaveBeenCalled();
      vi.advanceTimersByTime(50);
      expect(commit).toHaveBeenCalledWith(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("flush 立刻结算（页面卸载 / 切页）", () => {
    const commit = vi.fn();
    const debouncer = createDebouncer<number>(commit, {
      delayMs: 300,
      setTimer: () => 0 as unknown as ReturnType<typeof setTimeout>,
      clearTimer: () => undefined,
    });
    debouncer.push(42);
    expect(debouncer.pending).toBe(true);
    debouncer.flush();
    expect(commit).toHaveBeenCalledWith(42);
    expect(debouncer.pending).toBe(false);
  });

  it("cancel 之后不发（放弃这次操作）", () => {
    const commit = vi.fn();
    const debouncer = createDebouncer<number>(commit, {
      delayMs: 300,
      setTimer: () => 0 as unknown as ReturnType<typeof setTimeout>,
      clearTimer: () => undefined,
    });
    debouncer.push(7);
    debouncer.cancel();
    debouncer.flush();
    expect(commit).not.toHaveBeenCalled();
    expect(debouncer.pending).toBe(false);
  });

  it("没有待发送值时 flush 不触发 commit", () => {
    const commit = vi.fn();
    const debouncer = createDebouncer<number>(commit, { delayMs: 300 });
    debouncer.flush();
    expect(commit).not.toHaveBeenCalled();
  });

  it("默认等待 300ms，与票面「约 300ms 生效」一致", () => {
    expect(BRIGHTNESS_DEBOUNCE_MS).toBe(300);
  });
});
