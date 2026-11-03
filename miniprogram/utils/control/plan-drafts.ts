/**
 * 进阶档方案草稿的落盘（`lumen.planDrafts.v1`）。
 *
 * ## 为什么必须落盘
 *
 * 灯组页的进阶档对用户承诺「方案内容只存在这台手机上」（`PANEL_FACTS`）。
 * 这句话只有草稿真的留在本机时才成立——早期实现把 4 套草稿放在页面实例上，
 * 断线、切页、重启小程序都会把它们清空，用户编排一晚上的东西会无声消失。
 *
 * ## 键与形状（#75 起是设备级）
 *
 * 一个草稿的键是 `deviceKey#slot`：
 *  - **deviceKey** 是 hardwareId 优先的稳定标识（与 `device-history.deviceKeyOf`
 *    同口径），iOS 换 UUID 后不会串号；
 *  - **slot** 是方案槽位 0-3，同时也是设备上的 `script_id`。
 *
 * **键里没有灯组**：设备上的方案是设备级事实（4 个固定 `script_id`，一套覆盖
 * 所有灯组），灯组只是编辑视角。页面读写的是同一份草稿里「当前灯组」的切片
 * （`advanced-draft.writeStepZones` 只替换那一片），所以两条灯组不会互相清空。
 *
 * 早期版本把灯组号写进键（`deviceKey#stripId#slot`），并且把槽位号直接当
 * `script_id`——灯组 A 与灯组 B 的「方案①」写的是设备上同一个编号，后写的
 * 覆盖前一个，另一条灯组在那套方案里变成全暗。旧键在第一次读取时**一次性迁移**：
 * 同一槽位若有多个灯组的内容，取**灯组号最小**的那份，其余与旧键一起丢掉
 * （不做长期双读）。迁移规则是纯函数 `migrateLegacyDrafts`，可直接单测。
 *
 * 值是一个 `ScriptDraft`（4 套 × ≤8 步骤 × 分区）。存储按「一条键一个草稿」
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

/** 一个草稿的存储键：`deviceKey#slot`（设备级；#75 起不带灯组）。 */
export function planDraftKey(deviceKey: string, slot: number): string {
  return `${deviceKey}#${Math.max(0, Math.floor(slot))}`;
}

/** 整台设备的键前缀（删除设备时按它清干净）。 */
function devicePrefix(deviceKey: string): string {
  return `${deviceKey}#`;
}

/**
 * 旧版键的形状：`deviceKey#stripId#slot`。
 *
 * 去掉 `deviceKey#` 之后必须是两个非负整数、用 `#` 分隔。新键只有一个整数，
 * 所以这里不会匹配到新键。
 */
function parseLegacyKey(deviceKey: string, key: string): { stripId: number; slot: number } | null {
  const prefix = devicePrefix(deviceKey);
  if (!key.startsWith(prefix)) {
    return null;
  }
  const parts = key.slice(prefix.length).split("#");
  if (parts.length !== 2) {
    return null;
  }
  if (!/^\d+$/.test(parts[0]) || !/^\d+$/.test(parts[1])) {
    return null;
  }
  const stripId = Number(parts[0]);
  const slot = Number(parts[1]);
  if (!Number.isInteger(stripId) || !Number.isInteger(slot)) {
    return null;
  }
  if (stripId < 0 || slot < 0) {
    return null;
  }
  return { stripId, slot };
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
    /* 主效果为空的分区没有意义（面板不会产生它）。 */
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
  /* #99：步骤名是可选字段；空白视为「没起名」，界面回落到「第 N 步」。 */
  const rawName = typeof raw.name === "string" ? raw.name.trim() : "";
  const name = rawName.length > 0 ? rawName : undefined;
  if (!Array.isArray(raw.segments)) {
    return { durationInput: input, ...(name === undefined ? {} : { name }), segments: [] };
  }
  const segments: ScriptSegment[] = [];
  for (const item of raw.segments) {
    const segment = parseSegment(item);
    if (segment !== null) {
      segments.push(segment);
    }
  }
  return { durationInput: input, ...(name === undefined ? {} : { name }), segments };
}

/**
 * 一个方案草稿；结构不对（不是对象 / 没有 steps）返回 null。
 *
 * `scriptId` 不从存储里读：**键是唯一真相**（`deviceKey#slot` 的 slot 就是
 * 设备上的 `script_id`）。旧数据里若写了不一致的值，以槽位为准。
 */
export function parseScriptDraft(value: unknown, scriptId = 0): ScriptDraft | null {
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
  /* #99：循环模式是方案级设置；坏值交给页面钳到「不循环」（这里不抛错）。 */
  const loop =
    typeof raw.loop === "number" && Number.isInteger(raw.loop) && raw.loop >= 0 && raw.loop <= 2
      ? raw.loop
      : undefined;
  return {
    scriptId: Math.max(0, Math.floor(scriptId)),
    stages,
    ...(loop === undefined ? {} : { loop }),
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
 * 一次性迁移旧键（`deviceKey#stripId#slot`）到设备级键（`deviceKey#slot`）。
 *
 * 规则（#75 票面要求）：
 *  - 同一槽位若有多个灯组的旧草稿，取**灯组号最小**的那份作为初始内容；
 *    坏掉的条目跳过（继续看下一个灯组号），其余全部丢弃；
 *  - 新键已经存在时以新键为准（迁移不覆盖更新过的数据）；
 *  - 这台设备的**所有**旧键都从表里删掉，不留双读路径。
 *
 * **纯函数**：不碰存储、不改入参，返回新表与「是否有变化」。
 */
export function migrateLegacyDrafts(
  deviceKey: string,
  table: Record<string, unknown>,
): { table: Record<string, unknown>; changed: boolean } {
  if (deviceKey.length === 0) {
    return { table, changed: false };
  }
  /** 每个槽位：灯组号最小、且**能解析出草稿**的那份。 */
  const best = new Map<number, { stripId: number; draft: ScriptDraft }>();
  let legacyFound = false;
  for (const [key, value] of Object.entries(table)) {
    const legacy = parseLegacyKey(deviceKey, key);
    if (legacy === null) {
      continue;
    }
    legacyFound = true;
    /* 槽位越界（协议只有 4 套）的旧键不是方案：不迁移，随旧键一起丢掉。 */
    if (legacy.slot >= SLOT_COUNT) {
      continue;
    }
    /* 坏掉的旧条目不算「内容」：跳过它，顺延到下一个灯组号。 */
    const draft = parseScriptDraft(value, legacy.slot);
    if (draft === null) {
      continue;
    }
    const prev = best.get(legacy.slot);
    if (prev === undefined || legacy.stripId < prev.stripId) {
      best.set(legacy.slot, { stripId: legacy.stripId, draft });
    }
  }
  if (!legacyFound) {
    return { table, changed: false };
  }

  /* 新键优先：先把表里所有非旧键条目原样搬过去。 */
  const next: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(table)) {
    if (parseLegacyKey(deviceKey, key) === null) {
      next[key] = value;
    }
  }
  for (const [slot, entry] of best) {
    const key = planDraftKey(deviceKey, slot);
    if (key in next) {
      continue;
    }
    next[key] = entry.draft;
  }
  return { table: next, changed: true };
}

/** 把存储里的表读出来并顺手完成一次旧键迁移。 */
function readTableMigrated(storage: SessionStorage, deviceKey: string): Record<string, unknown> {
  const table = readAll(storage);
  if (deviceKey.length === 0) {
    return table;
  }
  const migrated = migrateLegacyDrafts(deviceKey, table);
  if (migrated.changed) {
    writeAll(storage, migrated.table);
  }
  return migrated.table;
}

/**
 * 读某台设备的 4 套草稿。
 *
 * 返回**定长 4 的数组**；某槽位没有落盘时该位置为 null（页面据此保留默认
 * 草稿，而不是把「没存过」当成「用户清空了」）。整台设备都没有时返回 null。
 *
 * 读到旧版键（带灯组维度）时原地迁移一次：同一槽位取灯组号最小的那份，
 * 其余丢弃，旧键从存储里消失。
 */
export function loadPlanDrafts(
  storage: SessionStorage,
  deviceKey: string,
): Array<ScriptDraft | null> | null {
  if (deviceKey.length === 0) {
    return null;
  }
  const table = readTableMigrated(storage, deviceKey);
  const drafts: Array<ScriptDraft | null> = [];
  let found = false;
  for (let slot = 0; slot < SLOT_COUNT; slot += 1) {
    const entry = table[planDraftKey(deviceKey, slot)];
    const draft = entry === undefined ? null : parseScriptDraft(entry, slot);
    if (draft !== null) {
      found = true;
    }
    drafts.push(draft);
  }
  return found ? drafts : null;
}

/**
 * 写一个槽位的草稿（覆盖同键）。
 *
 * 页面传入的是**整份设备级草稿**（含其它灯组的切片，`writeStepZones` 只改了
 * 当前那一片），所以这里不需要知道灯组。
 */
export function savePlanDraft(
  storage: SessionStorage,
  deviceKey: string,
  slot: number,
  draft: ScriptDraft,
): void {
  if (deviceKey.length === 0) {
    return;
  }
  const table = readTableMigrated(storage, deviceKey);
  const index = Math.max(0, Math.floor(slot));
  table[planDraftKey(deviceKey, index)] = { ...draft, scriptId: index };
  writeAll(storage, table);
}

/** 写一整组 4 套草稿（首次落盘 / 换键迁移用）。 */
export function savePlanDrafts(
  storage: SessionStorage,
  deviceKey: string,
  drafts: readonly ScriptDraft[],
): void {
  if (deviceKey.length === 0) {
    return;
  }
  const table = readTableMigrated(storage, deviceKey);
  for (let slot = 0; slot < SLOT_COUNT; slot += 1) {
    const draft = drafts[slot];
    if (draft !== undefined) {
      table[planDraftKey(deviceKey, slot)] = { ...draft, scriptId: slot };
    }
  }
  writeAll(storage, table);
}

/**
 * 删掉某台设备的**一套**方案草稿（#83 删除方案时调用）。
 *
 * 只删这一个键：同设备其它方案原样保留，编号也不动。返回是否真的删掉了
 * （没存过的槽位返回 false，调用方据此不必重写存储）。
 *
 * 注意这是**本机**的删除；设备上的内容由页面另外走 `ClearScript`，两者
 * 失败时的先后顺序由页面决定（设备拒绝时不删本机草稿）。
 */
export function removePlanDraft(storage: SessionStorage, deviceKey: string, slot: number): boolean {
  if (deviceKey.length === 0) {
    return false;
  }
  const table = readTableMigrated(storage, deviceKey);
  const key = planDraftKey(deviceKey, slot);
  if (!(key in table)) {
    return false;
  }
  delete table[key];
  writeAll(storage, table);
  return true;
}

/**
 * 删掉某台设备的全部草稿（**只在用户显式删除设备时调用**）。
 *
 * 断线、切灯组、退出页面都不清：草稿的卖点就是「编排不会因为一件小事消失」。
 * 前缀匹配同时覆盖新版键与残留的旧版键（还没被读取迁移过的那批）。
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

/**
 * 删掉某台设备的 4 套方案草稿（「重新开始」用；当前页面不调用）。
 *
 * #75 起草稿是设备级的，所以这和 `clearPlanDraftsForDevice` 是同一件事——
 * 保留两个名字是因为调用点表达的是不同意图，且前缀清理天然覆盖旧键。
 */
export function clearPlanDrafts(storage: SessionStorage, deviceKey: string): number {
  return clearPlanDraftsForDevice(storage, deviceKey);
}
