/**
 * 测试共用的 State 夹具（docs/protocol-v5.md §7.3：32 字节）。
 *
 * 为什么集中一份：v5 的 `DeviceState` 有逐条灯珠数（8）与逐链部位数（8），
 * 多个测试文件里各抄一遍必然漂移。这里只保留 v5 真实存在的字段——
 * **没有 RGB、没有播放位置、没有活动段数**（那些随段 / 剧本模型一起退役）。
 */

import type { DeviceState } from "../../utils/protocol/types";

/** 8 槽位定长数组（State 的权威形状；未使用的槽位为 0）。 */
export function stripArray(first = 0): number[] {
  return [first, 0, 0, 0, 0, 0, 0, 0];
}

/**
 * 一台「开灯 / 亮度 128 / 1 条 30 灯 · 0 个部位」的设备。
 *
 * 传 `stripLedCounts` 会同时决定灯珠数数组；传 `partCounts` 决定部位数数组。
 * 两者都给了默认值，调用方只关心自己那一条。
 */
export function baseState(overrides: Partial<DeviceState> = {}): DeviceState {
  const { stripLedCounts, partCounts, ...rest } = overrides;
  return {
    power: 1,
    brightness: 128,
    maxBrightness: 255,
    stripCount: 1,
    stripPowerMask: 0x01,
    activeScene: 0,
    layoutValid: false,
    ...rest,
    stripLedCounts: stripLedCounts ?? stripArray(30),
    partCounts: partCounts ?? stripArray(0),
  };
}
