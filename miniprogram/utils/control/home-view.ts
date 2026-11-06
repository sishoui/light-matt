/**
 * 首页的卡片派生（纯函数，零 wx 依赖）。
 *
 * 首页要同时展示两样东西：
 *  1. **大设备卡** —— 当前选中设备的状态（光晕颜色由设备真实色 + 亮度决定）；
 *  2. **下方小图** —— 其余设备的切换入口。
 *
 * 这里只做「数据 → 展示」的投影，不发任何命令。点小图**只切预览**，不连接；
 * 连接发生在点大卡（进详情）或点卡上的电源键时。这样「浏览」与「操作」分开，
 * 用户想看一眼别的设备不必被强制断链。
 *
 * 为什么单独成模块：排序 / 选中项兜底 / 离线态判定都是容易写错的规则，
 * 而页面代码在 node 里跑不起来。这里纯函数，可直接单测。
 */

import type { RecentDevice } from "./device-history";
import type { DeviceRegistryEntry } from "./device-registry";
import { buildMyDevices, type MyDeviceRow } from "./device-list";
import type { DeviceState } from "../protocol/types";
import { mockSpecOf } from "./mock-devices";
import { photoKeyOf, type DevicePhotoMap } from "./device-photo";

/** 卡片的状态基调（决定配色与文案）。 */
export type CardTone = "on" | "off" | "offline" | "stale";

export interface DeviceCard {
  /** 稳定 key（hardwareId 优先），wx:key 用它。 */
  key: string;
  /** 平台 deviceId；空串表示只有后端记录（本机没连过）。 */
  deviceId: string;
  name: string;
  /** 首字缩写（离线设备的小图用）。 */
  initial: string;
  /** 是否是当前**已连接**的那台。 */
  connected: boolean;
  /** 是否已被用户选择（大卡展示它）。 */
  selected: boolean;
  /** 一行状态：已连接 / 离线 / 未连接过。 */
  statusText: string;
  /** 次要信息：灯带数 + 最近连接时间。 */
  metaText: string;
  tone: CardTone;
  /** 设备基准色（仅已连接时可信；其余给中性灰）。 */
  colorHex: string;
  /** 光晕强度 0-1（已连接且开灯才 > 0）。 */
  glow: number;
  /** 大卡上电源键的视觉态。 */
  powerOn: boolean;
  /** 已连接时的亮度百分比；未连接为 null。 */
  brightnessPercent: number | null;
  /**
   * 卡片封面图。优先级：**用户自选的图 > 演示设备的图 > 空串**。
   * 空串表示没有封面，页面用设备色画渐变兜底（不假装有照片）。
   */
  photo: string;
  /** 这张图是否是用户自己选的（决定显示「更换封面」还是「设置封面」）。 */
  photoIsUserPicked: boolean;
}

/** 首页大卡的内容（含只属于它的字段）。 */
export interface HomeView {
  cards: DeviceCard[];
  selectedKey: string;
  current: DeviceCard | null;
  /** 没有任何设备时的空态。 */
  empty: boolean;
}

/** 中性灰：离线设备不假装有灯光颜色。 */
const NEUTRAL_HEX = "#8e8e93";

/**
 * 选中项的兜底顺序：
 *  1. 用户上次选的（key 仍存在）；
 *  2. 当前已连接的设备；
 *  3. 列表第一台。
 *
 * 删除设备后必须能自愈，否则大卡会停在已经不存在的那台上。
 */
export function pickSelectedKey(
  cards: readonly DeviceCard[],
  preferred: string,
  currentDeviceId: string,
): string {
  if (cards.some((card) => card.key === preferred)) {
    return preferred;
  }
  const connected = cards.find((card) => card.deviceId.length > 0 && card.deviceId === currentDeviceId);
  if (connected !== undefined) {
    return connected.key;
  }
  return cards[0]?.key ?? "";
}

export interface BuildHomeInput {
  recent: readonly RecentDevice[];
  registry: readonly DeviceRegistryEntry[];
  /** 当前已连接的 deviceId（未连接为空串）。 */
  currentDeviceId: string;
  /** 当前设备的 State（未连接为 null）。 */
  state: DeviceState | null;
  /** 用户上次选中的 key；空串表示还没选过。 */
  selectedKey: string;
  /** 用户自选的封面（deviceKey → 本地文件路径）；缺省为空。 */
  photos?: DevicePhotoMap;
}

/**
 * 设备列表 → 首页视图。
 *
 * 顺序沿用「最近连接时间降序」（与发现页一致），大卡永远排在卡片数组里，
 * 小图行渲染时把大卡那台排除掉（页面用 `thumbnailsOf` 取）。
 */
export function buildHomeView(input: BuildHomeInput): HomeView {
  const rows = buildMyDevices({
    recent: input.recent,
    registry: input.registry,
    backend: null,
    live:
      input.state !== null && input.currentDeviceId.length > 0
        ? {
            deviceId: input.currentDeviceId,
            stripCount: input.state.stripCount,
            firmwareVer: null,
          }
        : null,
  });
  const cards = rows.map((row) => toCard(row, input));
  const selectedKey = pickSelectedKey(cards, input.selectedKey, input.currentDeviceId);
  for (const card of cards) {
    card.selected = card.key === selectedKey;
  }
  return {
    cards,
    selectedKey,
    current: cards.find((card) => card.key === selectedKey) ?? null,
    empty: cards.length === 0,
  };
}

/** 小图行：除大卡那台之外的所有设备（保留调用方的附加字段类型）。 */
export function thumbnailsOf<T extends DeviceCard>(cards: readonly T[]): T[] {
  return cards.filter((card) => !card.selected);
}
function toCard(row: MyDeviceRow, input: BuildHomeInput): DeviceCard {
  const deviceId = row.deviceId ?? "";
  const connected = deviceId.length > 0 && deviceId === input.currentDeviceId && input.state !== null;
  const state = connected ? input.state : null;
  const powerOn = state !== null && state.power === 1;
  const brightnessPercent =
    state === null
      ? null
      : Math.round((state.brightness / Math.max(1, state.maxBrightness)) * 100);

  const { statusText, tone } = statusOf({ connected, state, row });
  const stripsText =
    row.stripCount === null ? "灯带数未知" : `${row.stripCount} 条灯带`;
  const when = row.lastSeenAt > 0 ? formatWhen(new Date(row.lastSeenAt)) : "未连接过";

  return {
    key: row.key,
    deviceId,
    name: row.name,
    initial: initialOf(row.name),
    connected,
    selected: false,
    statusText,
    metaText: row.remoteOnly ? `仅云端记录 · ${stripsText}` : `${stripsText} · ${when}`,
    tone,
    /*
     * v5 的 State 不再带 RGB 摘要（§7.3：App 要颜色明细走 QueryScene），
     * 所以首页大卡的光晕用中性底色而不是「设备当前颜色」。这是一个**如实**
     * 的退让：以前那个颜色是 strip0/seg0 的投影，本来也不代表整台设备。
     */
    colorHex: NEUTRAL_HEX,
    glow:
      state === null || state.power !== 1
        ? 0
        : 0.18 + 0.62 * (state.brightness / Math.max(1, state.maxBrightness)),
    powerOn,
    brightnessPercent,
    ...photoOf(row, deviceId, input.photos ?? {}),
  };
}

/**
 * 卡片的封面图与来源标记。
 *
 * 优先级：
 *  1. **用户自选的图**（按 row.key 取，hardwareId 优先，iOS 换 UUID 也认得）；
 *  2. 演示设备自带的图（仅 mock）；
 *  3. 空串 —— 页面用设备色画渐变。**绝不**拿别人的图冒充这台设备的照片。
 */
function photoOf(
  row: MyDeviceRow,
  deviceId: string,
  photos: DevicePhotoMap,
): { photo: string; photoIsUserPicked: boolean } {
  const picked = photoKeyOf(photos, row.key);
  if (picked.length > 0) {
    return { photo: picked, photoIsUserPicked: true };
  }
  const spec = mockSpecOf(deviceId) ?? (row.hardwareId !== null ? mockSpecOf(row.hardwareId) : null);
  return { photo: spec?.photo ?? "", photoIsUserPicked: false };
}

function statusOf(input: {
  connected: boolean;
  state: DeviceState | null;
  row: MyDeviceRow;
}): { statusText: string; tone: CardTone } {
  if (input.connected && input.state !== null) {
    return input.state.power === 1
      ? { statusText: "已连接 · 灯光打开", tone: "on" }
      : { statusText: "已连接 · 灯光关闭", tone: "off" };
  }
  if (input.row.remoteOnly) {
    return { statusText: "仅云端记录", tone: "stale" };
  }
  return { statusText: "未连接", tone: "offline" };
}

/** 名字首字：中文取首字，英文取首字母大写。 */
function initialOf(name: string): string {
  const trimmed = name.trim();
  if (trimmed.length === 0) {
    return "?";
  }
  const first = trimmed[0];
  return /[a-z]/.test(first) ? first.toUpperCase() : first;
}

/** 「上次连接」的可读时间：今天只显示时分，更早显示月日。 */
export function formatWhen(date: Date): string {
  if (Number.isNaN(date.getTime())) {
    return "未知时间";
  }
  const now = new Date();
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();
  const hh = String(date.getHours()).padStart(2, "0");
  const mm = String(date.getMinutes()).padStart(2, "0");
  if (sameDay) {
    return `今天 ${hh}:${mm}`;
  }
  return `${date.getMonth() + 1}月${date.getDate()}日`;
}

/** 光晕的 inline style（渐变 + 阴影），供 WXML 直接用。 */
export function glowStyle(card: DeviceCard): string {
  if (card.glow <= 0) {
    return "";
  }
  const alpha = Math.min(1, card.glow);
  const soft = Math.round(alpha * 0.42 * 100) / 100;
  return [
    `background: radial-gradient(120% 90% at 78% 8%, ${hexAlpha(card.colorHex, soft)}, transparent 70%);`,
    `box-shadow: 0 24rpx 72rpx ${hexAlpha(card.colorHex, Math.round(alpha * 0.28 * 100) / 100)};`,
  ].join(" ");
}

/** `#RRGGBB` + alpha → `rgba(...)`（WXSS 不认 #RRGGBBAA 之外的写法，这里统一 rgba）。 */
export function hexAlpha(hex: string, alpha: number): string {
  const match = /^#?([0-9a-fA-F]{6})$/.exec(hex);
  if (match === null) {
    return `rgba(142, 142, 147, ${alpha})`;
  }
  const value = match[1];
  const r = parseInt(value.slice(0, 2), 16);
  const g = parseInt(value.slice(2, 4), 16);
  const b = parseInt(value.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}
