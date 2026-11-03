/**
 * 发现页 / 添加设备表单的纯逻辑（#92）。
 *
 * 三件容易写错、又只能在渲染层才看得出的事：
 *  1. 搜索怎么匹配（备注名优先、其次广播名、不区分大小写、不匹配设备标识）；
 *  2. 表单名称怎么预填（已有备注 > 已有名称 > 广播名）；
 *  3. 「已添加过」怎么判定（按 deviceId 精确，或按广播名跨手机识别）。
 *
 * 全部是纯函数，零 wx 依赖：页面代码在 node 里跑不起来，而这三条规则是
 * 用户可感知的行为，必须能单测。
 */

import type { ScanRow } from "./device-list";
import type { DeviceRegistryEntry } from "./device-registry";

/** 搜索框的匹配键：名称去首尾空白、不区分大小写。 */
export function normalizeQuery(raw: string): string {
  return raw.trim().toLowerCase();
}

/**
 * 一行扫描结果是否命中搜索词。
 *
 * 只匹配**名称**（备注名与广播名），**不匹配设备标识**——用户记的是
 * 「客厅灯带」，不是 `Lumen-9B77` 或平台 UUID。
 */
export function matchesQuery(row: ScanRow, query: string): boolean {
  const needle = normalizeQuery(query);
  if (needle.length === 0) {
    return true;
  }
  if (row.name.toLowerCase().includes(needle)) {
    return true;
  }
  const label = (row.displayName ?? "").toLowerCase();
  return label.includes(needle);
}

/** 按搜索词过滤扫描结果；空词返回原数组（保持信号降序）。 */
export function filterScanRows(rows: readonly ScanRow[], query: string): ScanRow[] {
  const needle = normalizeQuery(query);
  if (needle.length === 0) {
    return rows.slice();
  }
  return rows.filter((row) => matchesQuery(row, needle));
}

/**
 * 表单里名称的预填值。
 *
 * 优先级：**已有备注 → 已有名称 → 广播名**。用户改过的名字永远不能被
 * 广播名盖掉——否则「重新添加」会把他起的名字退回出厂。
 */
export function prefillName(input: {
  remark?: string | null;
  displayName?: string | null;
  broadcastName: string;
}): string {
  const remark = (input.remark ?? "").trim();
  if (remark.length > 0) {
    return remark;
  }
  const display = (input.displayName ?? "").trim();
  if (display.length > 0) {
    return display;
  }
  return input.broadcastName.trim();
}

/** 表单预填结果（名称 + 是否已添加过 + 已有封面）。 */
export interface AddFormPrefill {
  name: string;
  /** 这台设备本机已经登记过：保存会更新资料而不是新建。 */
  alreadyAdded: boolean;
  /** 已有的封面路径（没有为空串）。 */
  photo: string;
}

/**
 * 组装表单预填。
 *
 * 「已添加过」的判定与 `buildNearby` 同源，但只看**本机**登记表：
 *  - `deviceId` 精确命中某条记录；或
 *  - 广播名与某条记录的备注 / 广播名相同（另一台手机登记过、或 UUID 变了）。
 */
export function buildAddPrefill(input: {
  row: ScanRow;
  registry: readonly DeviceRegistryEntry[];
  photo: string;
  broadcastName: string;
}): AddFormPrefill {
  const entry =
    input.registry.find((item) => item.deviceId === input.row.deviceId) ??
    input.registry.find(
      (item) =>
        (item.remark ?? "").length > 0 &&
        (item.remark ?? "").toUpperCase() === input.broadcastName.toUpperCase(),
    ) ??
    null;
  return {
    name: prefillName({
      remark: entry?.remark ?? null,
      displayName: input.row.name,
      broadcastName: input.broadcastName,
    }),
    alreadyAdded: entry !== null,
    photo: input.photo,
  };
}

/**
 * 扫描结果 → 每行的展示字段（封面 + 信号条格数）。
 *
 * 信号条四格：把 RSSI 映射到 1-4 格。分界取常见经验值——
 * -58 以上满格、-70 三格、-82 两格、更弱一格。太弱的行仍然显示一格，
 * 「一格都没有」会让人以为这行是坏的。
 */
export function signalBars(rssi: number): number {
  if (rssi >= -58) return 4;
  if (rssi >= -70) return 3;
  if (rssi >= -82) return 2;
  return 1;
}

/** 信号文案：四格之外给一句人话。 */
export function signalText(rssi: number): string {
  const bars = signalBars(rssi);
  if (bars >= 4) return "信号很强";
  if (bars === 3) return "信号良好";
  if (bars === 2) return "信号一般";
  return "信号较弱";
}

/** 一行的展示视图（页面直接 setData 的形态）。 */
export interface DiscoverRowView {
  deviceId: string;
  name: string;
  /** 名称的展示兜底（广播名为空时用设备标识）。 */
  primary: string;
  rssiText: string;
  signalBars: number;
  /** 每格是否点亮（WXML 直接 wx:for；带索引当 wx:key）。 */
  bars: Array<{ index: number; lit: boolean }>;
  signalText: string;
  /** 封面缩略图；空串时页面用首字渐变兜底。 */
  photo: string;
  known: boolean;
  current: boolean;
  /** 首字（无封面时的占位）。 */
  initial: string;
}

/** 扫描行 → 展示视图。 */
export function buildDiscoverRows(input: {
  rows: readonly ScanRow[];
  photoOf: (deviceId: string) => string;
}): DiscoverRowView[] {
  return input.rows.map((row) => {
    const primary = row.name.length > 0 ? row.name : row.deviceId;
    const bars = signalBars(row.rssi);
    return {
      deviceId: row.deviceId,
      name: row.name,
      primary,
      rssiText: `${row.rssi} dBm`,
      signalBars: bars,
      bars: [0, 1, 2, 3].map((index) => ({ index, lit: index < bars })),
      signalText: signalText(row.rssi),
      photo: input.photoOf(row.deviceId),
      known: row.known,
      current: row.current,
      initial: primary.slice(0, 1).toUpperCase(),
    };
  });
}
