/**
 * 首页的搜索、亮度拖动与长按菜单的纯逻辑（#93）。
 *
 * ## 为什么搜索只匹配名称
 *
 * 用户记的是「客厅灯带」，不是 `Lumen-9B77` 或平台 UUID。匹配规则与发现页
 * 同源（见 `add-device.matchesQuery`）：备注名优先、其次广播名、不区分
 * 大小写、去首尾空白。**不匹配设备标识**——那只会让搜索结果看起来随机。
 *
 * ## 为什么亮度要防抖
 *
 * 拖动一次会触发几十个 `changing` 事件。每个都下发就是几十条 BLE 命令，
 * 设备端会被刷屏，而且中途的值用户根本看不清。所以：拖动期间**只改本地
 * 显示**，停手 `DEBOUNCE_MS` 之后才发**最后一个值**。
 *
 * 这与设备页的「节流 + 松手提交」不同：首页大卡没有独立的滑条松手事件
 * （触摸开始在卡片上），所以用时间窗判定「停手」。
 */

import type { DeviceCard } from "./home-view";

/** 停手多久之后下发（毫秒）。 */
export const BRIGHTNESS_DEBOUNCE_MS = 300;

/** 首页长按菜单的动作。 */
export type HomeMenuAction = "rename" | "pickPhoto" | "clearPhoto" | "disconnect" | "delete";

/** 菜单项（WXML 直接渲染；顺序就是显示顺序）。 */
export interface HomeMenuItem {
  action: HomeMenuAction;
  label: string;
  /** 次要说明（灰字）。 */
  sub: string;
  /** 是否可点（未连接时「断开连接」不可用）。 */
  enabled: boolean;
  /** 是否是危险动作（红色）。 */
  danger: boolean;
}

/**
 * 长按菜单的项（#93 票面：修改名称 / 更换封面 / 移除封面 / 断开连接 / 删除设备）。
 *
 * `connected` 与 `photoIsUserPicked` 影响可用性：
 *  - 未连接时「断开连接」置灰（点了不会有任何事）；
 *  - 没有自定义封面时「移除封面」置灰。
 */
export function buildHomeMenu(input: {
  connected: boolean;
  photoIsUserPicked: boolean;
}): HomeMenuItem[] {
  return [
    { action: "rename", label: "修改名称", sub: "只改这台手机上的叫法", enabled: true, danger: false },
    { action: "pickPhoto", label: "更换封面", sub: "从相册选择", enabled: true, danger: false },
    {
      action: "clearPhoto",
      label: "移除封面",
      sub: input.photoIsUserPicked ? "恢复默认外观" : "当前是默认封面",
      enabled: input.photoIsUserPicked,
      danger: false,
    },
    {
      action: "disconnect",
      label: "断开连接",
      sub: input.connected ? "回到未连接" : "未连接",
      enabled: input.connected,
      danger: false,
    },
    { action: "delete", label: "删除设备", sub: "断开并清掉本机记录", enabled: true, danger: true },
  ];
}

/**
 * 按名称过滤首页设备卡。
 *
 * 与 `add-device.matchesQuery` 同一规则，只是输入是卡片而不是扫描行：
 * 看 `name`（已经是备注名优先的展示名）。空词返回全部（保持原顺序）。
 */
export function filterCards<T extends DeviceCard>(cards: readonly T[], query: string): T[] {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) {
    return cards.slice();
  }
  return cards.filter((card) => card.name.toLowerCase().includes(needle));
}

/** 搜索结果视图（搜索时整页变成一列设备卡）。 */
export interface SearchView<T extends DeviceCard = DeviceCard> {
  /** 是否处于搜索态（有关键字）。 */
  searching: boolean;
  /** 命中的卡片。 */
  results: T[];
  /** 搜索态下的空态文案（非搜索态为空串）。 */
  emptyText: string;
}

export function buildSearchView<T extends DeviceCard>(
  cards: readonly T[],
  query: string,
): SearchView<T> {
  const needle = query.trim();
  if (needle.length === 0) {
    return { searching: false, results: cards.slice(), emptyText: "" };
  }
  const results = filterCards(cards, needle);
  return {
    searching: true,
    results,
    emptyText: results.length === 0 ? `没有名称包含「${needle}」的设备` : "",
  };
}

/** 拖动中的亮度视图（立即更新数字与条宽）。 */
export interface BrightnessDragView {
  /** 百分比（0-100，四舍五入）。 */
  percent: number;
  /** 是否在拖动中（决定是否显示「松手生效」）。 */
  dragging: boolean;
}

/** 把滑块值换算成展示百分比。max ≤ 0 时按 0% 处理（不产生 NaN）。 */
export function brightnessDragPercent(value: number, max: number): number {
  if (!Number.isFinite(value) || !Number.isFinite(max) || max <= 0) {
    return 0;
  }
  const ratio = Math.max(0, Math.min(1, value / max));
  return Math.round(ratio * 100);
}

/**
 * 「停手才下发」的定时器封装（纯逻辑，注入时钟）。
 *
 * 页面只调 `push(value)`；最后一个值在 `delayMs` 后被 `commit` 一次。
 * 中间值不落地——这正是「拖动一次只发一条命令」的实现。
 */
export interface Debouncer<T> {
  push(value: T): void;
  /** 立刻结算（页面卸载 / 切页时用，避免丢最后一个值）。 */
  flush(): void;
  /** 取消（不发送）。 */
  cancel(): void;
  /** 有没有待发送的值。 */
  readonly pending: boolean;
}

export function createDebouncer<T>(
  commit: (value: T) => void,
  opts: {
    delayMs: number;
    setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
    clearTimer?: (handle: ReturnType<typeof setTimeout>) => void;
  },
): Debouncer<T> {
  const setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = opts.clearTimer ?? ((handle) => clearTimeout(handle));
  let handle: ReturnType<typeof setTimeout> | null = null;
  let last: { value: T } | null = null;

  const clear = (): void => {
    if (handle !== null) {
      clearTimer(handle);
      handle = null;
    }
  };

  const settle = (): void => {
    clear();
    if (last === null) {
      return;
    }
    const value = last.value;
    last = null;
    commit(value);
  };

  return {
    push(value: T) {
      last = { value };
      clear();
      handle = setTimer(settle, opts.delayMs);
    },
    flush() {
      settle();
    },
    cancel() {
      clear();
      last = null;
    },
    get pending() {
      return last !== null;
    },
  };
}
