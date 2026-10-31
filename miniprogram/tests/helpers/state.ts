/**
 * 测试共用的 State 夹具（#40 起 State 是 37 字节的 v3 形状）。
 *
 * 为什么集中一份：v3 给 DeviceState 加了 4 个逐带字段（掩码 ×2、灯珠数 ×8、
 * 段数 ×8），8 个测试文件里各抄一遍必然漂移。派生字段 `ledCount` / `segCount`
 * 在这里与 `stripCounts[0]` / `stripSegCounts[0]` 保持一致——解析器也是这么
 * 派生的，夹具必须同构，否则「测试通过但设备上不对」。
 */

import type { DeviceState } from "../../utils/protocol/types";

/** 8 槽位定长数组（State 的权威形状；未使用的槽位为 0）。 */
export function stripArray(first = 0): number[] {
  return [first, 0, 0, 0, 0, 0, 0, 0];
}

/**
 * 一台「开灯 / 亮度 128 / 暖白 / 1 条 30 灯 · 0 段」的设备。
 *
 * 传 `ledCount` 会同时改 `stripCounts[0]`；传 `segCount` 会同时改
 * `stripSegCounts[0]`，保证派生字段不会与权威字段打架。
 */
export function baseState(overrides: Partial<DeviceState> = {}): DeviceState {
  const { ledCount = 30, segCount = 0, ...rest } = overrides;
  const stripCounts = rest.stripCounts ?? stripArray(ledCount);
  const stripSegCounts = rest.stripSegCounts ?? stripArray(segCount);
  return {
    power: 1,
    brightness: 128,
    r: 255,
    g: 180,
    b: 120,
    maxBrightness: 255,
    stripCount: 1,
    scriptId: 0xff,
    stageIndex: 0,
    playbackState: 0,
    flags: 0,
    stripPowerMask: 0x01,
    stripAnimMask: 0,
    ...rest,
    stripCounts,
    stripSegCounts,
    ledCount,
    segCount,
  };
}
