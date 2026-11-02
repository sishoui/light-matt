/**
 * 快捷 / 自定义两档之间的切换与快照。
 *
 * ## 为什么要快照
 *
 * 快捷档的语义是「整组覆盖成一个效果」——它会清掉自定义档好不容易编排的
 * 多光区配置。用户手滑切回去，编排就没了，这不可接受。
 *
 * 快照**只存在内存**（模块级 Map），理由：
 *  - 用户切回去的典型场景是「刚才那个编排哪去了」，是即时需求；
 *  - 落盘会引入「上次的编排无限期占存储」与「恢复出的配置与设备当前状态
 *    不一致」两个新问题，而不带来价值。
 * 刷新小程序后回到设备真实状态，这是符合预期的。
 *
 * 本模块纯逻辑（不碰 wx / BLE），可直接单测。
 */

import type { SegmentSpec } from "../protocol/types";

/** 编辑档位。 */
export type EffectMode = "quick" | "custom";

/** 自定义档的编排快照（按「设备 + 灯组」隔离）。 */
export interface CustomSnapshot {
  /** 该灯组当时的完整光区配置（设备读回的权威值）。 */
  zones: SegmentSpec[];
  /** 当时选中的方案槽位（0-3）。 */
  planId: number;
  /** 当时选中的步骤下标（0 起）。 */
  stepIndex: number;
  /** 保存时间戳（用于提示与调试，不参与判断）。 */
  savedAt: number;
}

/**
 * 快照键：设备 + 灯组。
 *
 * 必须带上设备：同一台手机可能连过多台灯控，灯组号相同但光区完全不同，
 * 串号会让用户看到别人的配置。
 */
export function snapshotKey(deviceKey: string, stripId: number): string {
  return `${deviceKey}#${stripId}`;
}

/** 模块级快照表（不进 data、不落存储）。 */
const snapshots = new Map<string, CustomSnapshot>();

/**
 * 切到快捷档前调用：记住当前编排。
 *
 * `zones` 传设备读回的权威 spec（不是页面草稿）——快照要能直接重放回设备。
 */
export function saveCustomSnapshot(
  deviceKey: string,
  stripId: number,
  snapshot: Omit<CustomSnapshot, "savedAt">,
  nowMs: number = Date.now(),
): void {
  if (deviceKey.length === 0) {
    return;
  }
  snapshots.set(snapshotKey(deviceKey, stripId), {
    zones: snapshot.zones.map((spec) => ({
      ...spec,
      layer0: { ...spec.layer0 },
      layer1: { ...spec.layer1 },
    })),
    planId: snapshot.planId,
    stepIndex: snapshot.stepIndex,
    savedAt: nowMs,
  });
}

/** 切回自定义档时取快照；没有返回 null（用户可重新编排）。 */
export function takeCustomSnapshot(
  deviceKey: string,
  stripId: number,
): CustomSnapshot | null {
  const found = snapshots.get(snapshotKey(deviceKey, stripId));
  if (found === undefined) {
    return null;
  }
  /* 深拷贝：调用方可能就地修改草稿，不能污染快照。 */
  return {
    zones: found.zones.map((spec) => ({
      ...spec,
      layer0: { ...spec.layer0 },
      layer1: { ...spec.layer1 },
    })),
    planId: found.planId,
    stepIndex: found.stepIndex,
    savedAt: found.savedAt,
  };
}

/** 有没有快照（页面据此显示「已恢复你之前的编排」还是新编排提示）。 */
export function hasCustomSnapshot(deviceKey: string, stripId: number): boolean {
  return snapshots.has(snapshotKey(deviceKey, stripId));
}

/** 丢弃某灯组的快照（用户显式「重新开始」时）。 */
export function dropCustomSnapshot(deviceKey: string, stripId: number): void {
  snapshots.delete(snapshotKey(deviceKey, stripId));
}

/** 清空全部快照（测试用；生产路径不会调用）。 */
export function clearAllSnapshots(): void {
  snapshots.clear();
}

/**
 * 切换档位的纯决策函数：页面据此决定「要不要存快照 / 要不要恢复」。
 *
 * 抽出来的原因：这段判断有三条分支（切到快捷、切回自定义且无快照、
 * 切回自定义且有快照），写在页面里就只能靠模拟器验证。
 */
export type ModeTransition =
  | { kind: "to-quick"; shouldSave: boolean }
  | { kind: "to-custom"; restore: CustomSnapshot | null };

export function planTransition(
  from: EffectMode,
  to: EffectMode,
  deviceKey: string,
  stripId: number,
): ModeTransition {
  if (to === "quick") {
    return { kind: "to-quick", shouldSave: from === "custom" };
  }
  return { kind: "to-custom", restore: takeCustomSnapshot(deviceKey, stripId) };
}
