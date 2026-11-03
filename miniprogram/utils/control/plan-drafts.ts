/**
 * 进阶档方案草稿的落盘（`lumen.planDrafts.v1`）。
 *
 * ## 为什么必须落盘
 *
 * 灯组页的进阶档对用户承诺「方案内容只存在这台手机上」（`PANEL_FACTS`）。
 * 这句话只有草稿真的留在本机时才成立——早期实现把 4 套草稿放在页面实例上，
 * 断线、切页、重启小程序都会把它们清空，用户编排一晚上的东西会无声消失。
 *
 * ## 键与形状
 *
 * 一个草稿的键是 `deviceKey#stripId#slot`：
 *  - **deviceKey** 是 hardwareId 优先的稳定标识（与 `device-history.deviceKeyOf`
 *    同口径），iOS 换 UUID 后不会串号；
 *  - **stripId** 必须带上：同一台设备的不同灯组各有各的 4 套方案；
 *  - **slot** 是方案槽位 0-3。
 *
 * 值是一个 `ScriptDraft`（4 套 × ≤8 步骤 × 光区）。存储按「一条键一个草稿」
 * 平铺，设备删除时按 `deviceKey#` 前缀整体清掉（`clearPlanDraftsForDevice`）。
 *
 * ## 校验
 *
 * 读到损坏的 JSON / 结构不对的条目一律丢弃（不抛错、不整体失败）：编排丢了
 * 比整页白屏可接受。逐字段重建对象而不是直接 `JSON.parse` 的结果——存储里
 * 的旧结构不会带着多余字段流进下发的帧。
 *
 * 纯逻辑：只依赖 `SessionStorage` 接口，不碰 wx / BLE，可直接单测。
 */

import type { SessionStorage } from "./device-cache";
import type { ScriptDraft, ScriptStageDraft } from "./script-view";
import type { ScriptSegment } from "./script-plan";
import { BLEND, NO_EFFECT } from "../protocol/constants";
import type { EffectLayer, SegmentSpec } from "../protocol/types";

/** 草稿存储键（带版本，避免读到旧结构）。 */
export const PLAN_DRAFTS_KEY = "lumen.planDrafts.v1";

/** 4 个方案槽位（与协议一致）。 */
const SLOT_COUNT = 4;

/** 一个草稿的存储键：`deviceKey#stripId#slot`。 */
export function planDraftKey(deviceKey: string, stripId: number, slot: number): string {
  return `${deviceKey}#${Math.max(0, Math.floor(stripId))}#${Math.max(0, Math.floor(slot))}`;
}

/** 整台设备的键前缀（删除设备时按它清干净）。 */
function devicePrefix(deviceKey: string): string {
  return `${deviceKey}#`;
}

function isFiniteInt(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && Number.isInteger(value);
}

/** 一个层是否是可用的层对象（未知字段一律丢弃）。 */
function parseLayer(value: unknown): EffectLayer | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const raw = value as Record<string, unknown>;
  const { type } = raw;
  if (!isFiniteInt(type)) {
    return null;
  }
  const layer: EffectLayer = {
    type,
    hue: isFiniteInt(raw.hue) ? raw.hue : 0,
    sat: isFiniteInt(raw.sat) ? raw.sat : 0,
    periodMs: isFiniteInt(raw.periodMs) ? raw.periodMs : 0,
    p5: isFiniteInt(raw.p5) ? raw.p5 : 0,
    flags: isFiniteInt(raw.flags) ? raw.flags : 0,
    /* 空层的 level 必须是 0（协议 v4）；非空层缺省满亮。 */
    level: type === NO_EFFECT ? 0 : isFiniteInt(raw.level) ? raw.level : 100,
  };
  return layer;
}

/** 一条段草稿（两层 spec 或扁平配置），结构不对返回 null。 */
function parseSegment(value: unknown): ScriptSegment | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const raw = value as Record<string, unknown>;
  if (!isFiniteInt(raw.stripId) || !isFiniteInt(raw.segId)) {
    return null;
  }
  if (!isFiniteInt(raw.start) || !isFiniteInt(raw.end) || raw.start < 0 || raw.end < raw.start) {
    return null;
  }
  const layer0 = parseLayer(raw.layer0);
  const layer1 = parseLayer(raw.layer1);
  if (layer0 === null || layer1 === null) {
    return null;
  }
  if (layer0.type === NO_EFFECT) {
    /* 主效果为空的光区没有意义（面板不会产生它）。 */
    return null;
  }
  return {
    stripId: raw.stripId,
    segId: raw.segId,
    start: raw.start,
    end: raw.end,
    blend: (isFiniteInt(raw.blend) ? raw.blend : BLEND.OVER) as SegmentSpec["blend"],
    layer0,
    layer1,
  };
}

/** 一个步骤草稿；`segments` 里坏掉的条目逐条丢弃，整步仍保留。 */
function parseStage(value: unknown): ScriptStageDraft | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const raw = value as Record<string, unknown>;
  const input = typeof raw.durationInput === "string" ? raw.durationInput : "";
  if (!Array.isArray(raw.segments)) {
    return { durationInput: input, segments: [] };
  }
  const segments: ScriptSegment[] = [];
  for (const item of raw.segments) {
    const segment = parseSegment(item);
    if (segment !== null) {
      segments.push(segment);
    }
  }
  return { durationInput: input, segments };
}

/** 一个方案草稿；结构不对（不是对象 / 没有 steps）返回 null。 */
export function parseScriptDraft(value: unknown): ScriptDraft | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const raw = value as Record<string, unknown>;
  if (!Array.isArray(raw.stages) || raw.stages.length === 0) {
    return null;
  }
  const stages: ScriptStageDraft[] = [];
  for (const item of raw.stages) {
    const stage = parseStage(item);
    if (stage === null) {
      return null;
    }
    stages.push(stage);
  }
  return {
    scriptId: isFiniteInt(raw.scriptId) ? raw.scriptId : 0,
    stages,
  };
}

/** 读整张表（损坏的 JSON / 非对象一律当空表）。 */
function readAll(storage: SessionStorage): Record<string, unknown> {
  const raw = storage.get(PLAN_DRAFTS_KEY);
  if (raw === null) {
    return {};
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return {};
    }
    return parsed as Record<string, unknown>;
  } catch {
    return {};
  }
}

function writeAll(storage: SessionStorage, table: Record<string, unknown>): void {
  /* 空表也要落盘：删除设备后残留的旧表会被 `loadPlanDrafts` 当成「有草稿」。 */
  storage.set(PLAN_DRAFTS_KEY, JSON.stringify(table));
}

/**
 * 读某台设备某条灯组的 4 套草稿。
 *
 * 返回**定长 4 的数组**；某槽位没有落盘时该位置为 null（页面据此保留默认
 * 草稿，而不是把「没存过」当成「用户清空了」）。整条键都没有时返回 null。
 */
export function loadPlanDrafts(
  storage: SessionStorage,
  deviceKey: string,
  stripId: number,
): Array<ScriptDraft | null> | null {
  if (deviceKey.length === 0) {
    return null;
  }
  const table = readAll(storage);
  const drafts: Array<ScriptDraft | null> = [];
  let found = false;
  for (let slot = 0; slot < SLOT_COUNT; slot += 1) {
    const entry = table[planDraftKey(deviceKey, stripId, slot)];
    const draft = entry === undefined ? null : parseScriptDraft(entry);
    if (draft !== null) {
      found = true;
    }
    drafts.push(draft);
  }
  return found ? drafts : null;
}

/** 写一个槽位的草稿（覆盖同键）。 */
export function savePlanDraft(
  storage: SessionStorage,
  deviceKey: string,
  stripId: number,
  slot: number,
  draft: ScriptDraft,
): void {
  if (deviceKey.length === 0) {
    return;
  }
  const table = readAll(storage);
  table[planDraftKey(deviceKey, stripId, slot)] = draft;
  writeAll(storage, table);
}

/** 写一整组 4 套草稿（首次落盘 / 换键迁移用）。 */
export function savePlanDrafts(
  storage: SessionStorage,
  deviceKey: string,
  stripId: number,
  drafts: readonly ScriptDraft[],
): void {
  if (deviceKey.length === 0) {
    return;
  }
  const table = readAll(storage);
  for (let slot = 0; slot < SLOT_COUNT; slot += 1) {
    const draft = drafts[slot];
    if (draft !== undefined) {
      table[planDraftKey(deviceKey, stripId, slot)] = draft;
    }
  }
  writeAll(storage, table);
}

/**
 * 删掉某台设备的全部草稿（**只在用户显式删除设备时调用**）。
 *
 * 断线、切灯组、退出页面都不清：草稿的卖点就是「编排不会因为一件小事消失」。
 * 返回删掉的键数（日志与测试用）。
 */
export function clearPlanDraftsForDevice(storage: SessionStorage, deviceKey: string): number {
  if (deviceKey.length === 0) {
    return 0;
  }
  const prefix = devicePrefix(deviceKey);
  const table = readAll(storage);
  let removed = 0;
  for (const key of Object.keys(table)) {
    if (key.startsWith(prefix)) {
      delete table[key];
      removed += 1;
    }
  }
  if (removed > 0) {
    writeAll(storage, table);
  }
  return removed;
}

/** 删掉某台设备某条灯组的 4 套草稿（「重新开始」用；当前页面不调用）。 */
export function clearPlanDrafts(
  storage: SessionStorage,
  deviceKey: string,
  stripId: number,
): number {
  if (deviceKey.length === 0) {
    return 0;
  }
  const table = readAll(storage);
  let removed = 0;
  for (let slot = 0; slot < SLOT_COUNT; slot += 1) {
    const key = planDraftKey(deviceKey, stripId, slot);
    if (key in table) {
      delete table[key];
      removed += 1;
    }
  }
  if (removed > 0) {
    writeAll(storage, table);
  }
  return removed;
}
