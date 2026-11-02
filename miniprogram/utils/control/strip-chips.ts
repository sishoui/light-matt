/**
 * 灯光页的灯带切换器视图派生（#41，纯函数）。
 *
 * 三条数据来源严格分开（混在一起就会把「设备权威」和「App 偏好」搞乱）：
 *  - **State（37B）**：逐带灯珠数 / 段数 / 开关位 / 动画位 —— 设备权威；
 *  - **QueryStripConfig（0x87）**：GPIO，只读展示；
 *  - **device-registry**：启用掩码（App 本地偏好），只决定显示谁，永不下发。
 *
 * 这一层存在的原因：老页面把 strip 0 的灯珠数复制给了所有带。切换器要显示
 * **每条带自己的**数量，这个派生必须可测。
 */

import { MAX_STRIPS } from "../protocol/constants";
import type { DeviceState, StripConfig } from "../protocol/types";

export interface StripChip {
  /** 灯带号 0-7（切带时原样回传给 session）。 */
  stripId: number;
  /** 该带真实灯珠数（State.stripCounts[stripId]）。 */
  ledCount: number;
  /** GPIO 展示文本：「GPIO 3」/「—」（未分配）/「GPIO ?」（还没读到引脚表）。 */
  gpioText: string;
  /** 该带独立开关位（State.stripPowerMask）。 */
  on: boolean;
  /** 该带当前有动画类段（State.stripAnimMask，仅作显示提示）。 */
  animating: boolean;
  /** 该带活动段数（State.stripSegCounts）。 */
  segCount: number;
  /** 是否是当前选中的带。 */
  selected: boolean;
}

export interface StripChipInput {
  /** 设备 State；未连接为 null（不编造 8 条空带）。 */
  state: DeviceState | null;
  /** 引脚表；未读到为 null（GPIO 显示未知，而不是 0）。 */
  config: StripConfig | null;
  /** 可见的灯带号（device-registry.enabledStripIds 的结果）。 */
  enabled: readonly number[];
  selectedStripId?: number;
}

function gpioTextOf(config: StripConfig | null, stripId: number): string {
  if (config === null) {
    return "GPIO ?";
  }
  const channel = config.channels[stripId];
  if (channel === undefined || !channel.assigned) {
    return "—";
  }
  return `GPIO ${channel.gpio}`;
}

/** 按 State + 引脚表 + 启用掩码生成切换器 chips（顺序 = 灯带号升序）。 */
export function buildStripChips(input: StripChipInput): StripChip[] {
  const { state, config, enabled } = input;
  if (state === null) {
    return [];
  }
  const stripCount = Math.max(0, Math.min(MAX_STRIPS, state.stripCount));
  const selected = input.selectedStripId ?? -1;
  const chips: StripChip[] = [];
  for (const stripId of enabled) {
    /* 越界的灯带号（登记表脏数据 / strip_count 变小）一律跳过：
     * 画出不存在的带会让用户点了没反应。 */
    if (!Number.isInteger(stripId) || stripId < 0 || stripId >= stripCount) {
      continue;
    }
    chips.push({
      stripId,
      ledCount: state.stripCounts[stripId] ?? 0,
      gpioText: gpioTextOf(config, stripId),
      on: (state.stripPowerMask & (1 << stripId)) !== 0,
      animating: (state.stripAnimMask & (1 << stripId)) !== 0,
      segCount: state.stripSegCounts[stripId] ?? 0,
      selected: stripId === selected,
    });
  }
  return chips;
}

/** 一条 chip 的文字摘要（窄屏与调试共用一份规则）。 */
export function stripChipSummary(chip: Pick<StripChip, "ledCount" | "segCount" | "on">): string {
  /* 术语（decisions §12）：界面不出现「段」，统一叫「光区」。 */
  return `${chip.ledCount} 灯 · ${chip.segCount} 个光区 · ${chip.on ? "开" : "关"}`;
}

/**
 * 重新计算「当前该操作哪条带」。
 *
 * 规则（协调者裁定：选择在会话里跨 tab 保留）：
 *  - 当前带仍然可见 → 保持不变（切页回来不跳带）；
 *  - 当前带被隐藏 / 越界 → 退到第一条可见带；
 *  - 一条可见带都没有 → -1（页面显示空态，绝不隐式写 strip 0）。
 */
export function pickStripId(
  state: DeviceState | null,
  enabled: readonly number[],
  currentStripId: number,
): number {
  if (state === null) {
    return -1;
  }
  const stripCount = Math.max(0, Math.min(MAX_STRIPS, state.stripCount));
  const visible = enabled.filter(
    (stripId) => Number.isInteger(stripId) && stripId >= 0 && stripId < stripCount,
  );
  if (visible.includes(currentStripId)) {
    return currentStripId;
  }
  return visible.length > 0 ? visible[0] : -1;
}
