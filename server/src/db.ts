/**
 * 存储层。用 Node 内置的 `node:sqlite`，不用 better-sqlite3。
 *
 * 为什么换：better-sqlite3 是原生模块，装的时候要 C++ 编译器。Node 24 上它没有
 * 预编译包，退回源码编译后因缺 VS 的「Desktop development with C++」直接失败
 * （实测报 `gyp ERR! find VS`）。`node:sqlite` 是内置模块，零编译、零依赖。
 *
 * **API 差异（都是实测出来的，改动时必须知道）**：
 *   - 没有 `db.transaction(fn)`，要自己 `BEGIN` / `COMMIT` / `ROLLBACK`；
 *   - `get()` 返回 **null 原型对象**，`instanceof Object` 为 false，
 *     但属性访问、展开、`JSON.stringify` 都正常；
 *   - `lastInsertRowid` 在本环境是 number（文档标注可能是 bigint），统一 `Number()`；
 *   - `@name` 命名参数、`changes`、`pragma` 语义与 better-sqlite3 一致。
 */

import { DatabaseSync, type StatementSync } from "node:sqlite";
import { MIGRATIONS, SCHEMA_SQL } from "./schema.js";
import { resolveDeviceKey, type DeviceIdentityInput, type Platform } from "./identity.js";

export type Db = DatabaseSync;

export interface UsageLogInput {
  readonly userKey: string;
  readonly displayName?: string | null;
  readonly device: DeviceIdentityInput;
  readonly startedAt: number;
  readonly endedAt?: number | null;
  readonly clientEventId: string;
  readonly reportedAt: number;
}

export interface WriteResult {
  readonly id: number;
  readonly duplicate: boolean;
  readonly deviceKey: string;
  readonly deviceKeyKind: "hardware" | "name" | "raw";
}

export interface DeviceRow {
  readonly device_key: string;
  readonly device_name: string | null;
  readonly use_count: number;
  readonly user_count: number;
  readonly last_seen_at: number;
  readonly mac_count: number;
}

export interface UserRow {
  readonly id: number;
  readonly user_key: string;
  readonly display_name: string | null;
  readonly first_seen_at: number;
  readonly last_seen_at: number;
  readonly use_count: number;
  readonly device_count: number;
}

/** 读 `PRAGMA user_version`：SQLite 自带的 schema 版本号，不需要额外表。 */
function readUserVersion(db: Db): number {
  const row = db.prepare("PRAGMA user_version").get() as { user_version?: number } | undefined;
  return Number(row?.user_version ?? 0);
}

function writeUserVersion(db: Db, version: number): void {
  // PRAGMA 不能用参数绑定，只能拼字符串。version 由本文件的常量提供，不是外部输入。
  db.exec(`PRAGMA user_version = ${Math.trunc(version)}`);
}

/**
 * 建库 + 迁移。幂等：每次启动都调用，已是最新版时什么都不做。
 *
 * 顺序不能颠倒：先 `SCHEMA_SQL`（保证全新库有基础表），再跑增量迁移
 * （处理已有库需要补的列）。全新库跑完 SCHEMA_SQL 后 user_version 仍是 0，
 * 迁移条目必须能安全地在空表上重放 —— 所以迁移里统一用 `IF NOT EXISTS`
 * 或可重复执行的 DDL。
 */
export function migrate(db: Db): void {
  db.exec(SCHEMA_SQL);

  const current = readUserVersion(db);
  const pending = MIGRATIONS.filter((m) => m.version > current);
  if (pending.length === 0) return;

  db.exec("BEGIN");
  try {
    for (const m of pending) {
      db.exec(m.sql);
    }
    const target = Math.max(...pending.map((m) => m.version));
    writeUserVersion(db, target);
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

export function openDatabase(file: string): Db {
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  migrate(db);
  return db;
}

/**
 * 在事务里执行 fn。失败回滚并抛出原错误。
 *
 * better-sqlite3 的 `db.transaction(fn)` 在 node:sqlite 里没有，所以手写。
 * 注意不能嵌套调用（SQLite 不支持嵌套 BEGIN），当前调用链没有嵌套需求。
 */
function inTransaction<T>(db: Db, fn: () => T): T {
  db.exec("BEGIN");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

/** 预编译语句缓存：同一 SQL 在热点路径上反复执行，避免每帧重新 prepare。 */
const statementCache = new WeakMap<Db, Map<string, StatementSync>>();

function stmt(db: Db, sql: string): StatementSync {
  let perDb = statementCache.get(db);
  if (perDb === undefined) {
    perDb = new Map();
    statementCache.set(db, perDb);
  }
  let cached = perDb.get(sql);
  if (cached === undefined) {
    cached = db.prepare(sql);
    perDb.set(sql, cached);
  }
  return cached;
}

export function recordUsage(db: Db, input: UsageLogInput): WriteResult {
  const resolved = resolveDeviceKey(input.device);

  return inTransaction(db, () => {
    const now = input.reportedAt;
    stmt(
      db,
      `INSERT INTO users (user_key, display_name, first_seen_at, last_seen_at)
       VALUES (@userKey, @displayName, @startedAt, @startedAt)
       ON CONFLICT(user_key) DO UPDATE SET
         display_name = COALESCE(excluded.display_name, users.display_name),
         first_seen_at = MIN(users.first_seen_at, excluded.first_seen_at),
         last_seen_at  = MAX(users.last_seen_at, excluded.last_seen_at)`,
    ).run({
      userKey: input.userKey,
      displayName: input.displayName ?? null,
      startedAt: input.startedAt,
    });

    const user = stmt(db, "SELECT id FROM users WHERE user_key = ?").get(input.userKey) as
      | { id: number }
      | undefined;
    if (user === undefined) throw new Error("users 行刚写入却读不到");

    const info = stmt(
      db,
      `INSERT INTO usage_logs
         (user_id, device_key, device_name, device_id, platform,
          started_at, ended_at, reported_at, client_event_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(client_event_id) DO NOTHING`,
    ).run(
      user.id,
      resolved.key,
      resolved.name,
      input.device.deviceId ?? null,
      input.device.platform,
      input.startedAt,
      input.endedAt ?? null,
      now,
      input.clientEventId,
    );

    const changes = Number(info.changes);
    if (changes === 0) {
      const existing = stmt(db, "SELECT id FROM usage_logs WHERE client_event_id = ?").get(
        input.clientEventId,
      ) as { id: number } | undefined;
      return {
        id: existing?.id ?? 0,
        duplicate: true,
        deviceKey: resolved.key,
        deviceKeyKind: resolved.kind,
      };
    }

    const newId = Number(info.lastInsertRowid);

    // 自动收尾：同一 (用户, 设备) 上一条还开着（ended_at IS NULL）的会话，
    // 用本次开始时间关掉它。App 被杀不会留下永远开着的一行。
    stmt(
      db,
      `UPDATE usage_logs
          SET ended_at = ?
        WHERE user_id = ? AND device_key = ? AND ended_at IS NULL
          AND started_at <= ? AND id <> ?`,
    ).run(input.startedAt, user.id, resolved.key, input.startedAt, newId);

    return {
      id: newId,
      duplicate: false,
      deviceKey: resolved.key,
      deviceKeyKind: resolved.kind,
    };
  });
}

export function listDevices(db: Db): DeviceRow[] {
  // node:sqlite 的 all() 返回 Record<string, SQLOutputValue>，比 better-sqlite3 的
  // any 更严格，所以要显式转成目标类型（先经 unknown）。
  return stmt(db, "SELECT * FROM v_devices ORDER BY last_seen_at DESC, device_key ASC").all() as unknown as DeviceRow[];
}

export function listUsers(db: Db): UserRow[] {
  return stmt(db, "SELECT * FROM v_users ORDER BY last_seen_at DESC, id ASC").all() as unknown as UserRow[];
}

export function countRows(db: Db): { users: number; usage_logs: number } {
  const users = stmt(db, "SELECT COUNT(*) AS n FROM users").get() as { n: number };
  const logs = stmt(db, "SELECT COUNT(*) AS n FROM usage_logs").get() as { n: number };
  return { users: Number(users.n), usage_logs: Number(logs.n) };
}

export function isPlatform(value: unknown): value is Platform {
  return (
    value === "android" || value === "ios" || value === "devtools" || value === "unknown"
  );
}

// ------------------------------------------------------- 会话与设备登记（v3）
//
// 这套接口只处理「谁登记过哪台设备」与一份明确非权威的缓存。
// **任何灯光配置都不在这里，也不该在这里** —— 设备 NVS 是唯一真相。
//
// display_name 的双层设计（见 schema.ts v2 注释）：
//   user_devices.display_name 是本人备注名（权威），devices.display_name 是全局默认值。
//   读路径统一 COALESCE(user_devices.display_name, devices.display_name)。

export interface DeviceListRow {
  readonly id: number;
  readonly hardware_id: string;
  readonly display_name: string | null;
  readonly last_seen_at: number;
  readonly added_at: number;
  readonly led_counts: string | null;
  readonly firmware_ver: number | null;
}

export interface RegisteredDeviceRow {
  readonly id: number;
  readonly hardware_id: string;
  readonly display_name: string | null;
  readonly last_seen_at: number;
  readonly led_counts: string | null;
  readonly firmware_ver: number | null;
  readonly created_at: number;
  readonly user_count: number;
}

export interface DeviceCacheRow {
  readonly id: number;
  readonly hardware_id: string;
  readonly display_name: string | null;
  readonly last_seen_at: number;
  readonly led_counts: string | null;
  readonly firmware_ver: number | null;
  readonly created_at: number;
}

export interface RegisterDeviceInput {
  readonly userId: number;
  readonly hardwareId: string;
  readonly displayName: string | null;
  readonly now: number;
}

export interface RegisterDeviceResult {
  readonly deviceId: number;
  /** false = 设备早已存在（同一 MAC 重复登记）。决定 201 / 200。 */
  readonly created: boolean;
  readonly displayName: string | null;
}

export interface TouchDeviceInput {
  readonly userId: number;
  readonly deviceId: number;
  readonly ledCounts: number[] | null;
  readonly firmwareVer: number | null;
  readonly now: number;
}

/** 会话换取身份时用：没有就建，有就只推进 last_seen_at。 */
export function upsertUserForKey(db: Db, userKey: string, now: number): number {
  stmt(
    db,
    `INSERT INTO users (user_key, first_seen_at, last_seen_at)
     VALUES (?, ?, ?)
     ON CONFLICT(user_key) DO UPDATE SET
       last_seen_at = MAX(users.last_seen_at, excluded.last_seen_at)`,
  ).run(userKey, now, now);

  const row = stmt(db, "SELECT id FROM users WHERE user_key = ?").get(userKey) as
    | { id: number }
    | undefined;
  if (row === undefined) throw new Error("users 行刚写入却读不到");
  return Number(row.id);
}

/** 设备路由用：只认已存在的用户，不给自称身份顺手建行。 */
export function findUserIdByKey(db: Db, userKey: string): number | null {
  const row = stmt(db, "SELECT id FROM users WHERE user_key = ?").get(userKey) as
    | { id: number }
    | undefined;
  return row === undefined ? null : Number(row.id);
}

export function registerDevice(db: Db, input: RegisterDeviceInput): RegisterDeviceResult {
  // 设备与关联必须一起成功：外键要求 devices 行先存在，分开写会在中间状态留下
  // 一个「没有关联的设备」，而 register 的幂等语义依赖两者成对。
  return inTransaction(db, () => {
    const info = stmt(
      db,
      `INSERT INTO devices (hardware_id, last_seen_at, created_at)
       VALUES (@hardwareId, @now, @now)
       ON CONFLICT(hardware_id) DO NOTHING`,
    ).run({ hardwareId: input.hardwareId, now: input.now });
    const created = Number(info.changes) > 0;

    const device = stmt(db, "SELECT id FROM devices WHERE hardware_id = ?").get(
      input.hardwareId,
    ) as { id: number } | undefined;
    if (device === undefined) throw new Error("devices 行刚写入却读不到");
    const deviceId = Number(device.id);

    // 重复登记不覆盖已有备注名：displayName 为 null 时保留原值。
    stmt(
      db,
      `INSERT INTO user_devices (user_id, device_id, added_at, display_name)
       VALUES (@userId, @deviceId, @now, @displayName)
       ON CONFLICT(user_id, device_id) DO UPDATE SET
         display_name = COALESCE(excluded.display_name, user_devices.display_name)`,
    ).run({
      userId: input.userId,
      deviceId,
      now: input.now,
      displayName: input.displayName,
    });

    // 全局默认名只在本人显式给了名字时刷新，否则会把别人的默认值抹掉。
    if (input.displayName !== null) {
      stmt(db, "UPDATE devices SET display_name = ? WHERE id = ?").run(input.displayName, deviceId);
    }

    const effective = stmt(
      db,
      `SELECT COALESCE(ud.display_name, d.display_name) AS name
         FROM user_devices ud
         JOIN devices d ON d.id = ud.device_id
        WHERE ud.user_id = ? AND ud.device_id = ?`,
    ).get(input.userId, deviceId) as { name: string | null } | undefined;

    return { deviceId, created, displayName: effective?.name ?? null };
  });
}

export function listUserDevices(db: Db, userId: number): DeviceListRow[] {
  return stmt(
    db,
    `SELECT d.id            AS id,
            d.hardware_id   AS hardware_id,
            COALESCE(ud.display_name, d.display_name) AS display_name,
            d.last_seen_at  AS last_seen_at,
            ud.added_at     AS added_at,
            d.led_counts    AS led_counts,
            d.firmware_ver  AS firmware_ver
       FROM user_devices ud
       JOIN devices d ON d.id = ud.device_id
      WHERE ud.user_id = ?
      ORDER BY d.last_seen_at DESC, d.id ASC`,
  ).all(userId) as unknown as DeviceListRow[];
}

/** 改名。只改调用者自己的备注名，同时刷新 devices 上的非权威默认值。 */
export function renameDevice(
  db: Db,
  userId: number,
  deviceId: number,
  displayName: string,
): boolean {
  return inTransaction(db, () => {
    const link = stmt(db, "SELECT 1 AS ok FROM user_devices WHERE user_id = ? AND device_id = ?").get(
      userId,
      deviceId,
    );
    if (link === undefined) return false;
    stmt(db, "UPDATE user_devices SET display_name = ? WHERE user_id = ? AND device_id = ?").run(
      displayName,
      userId,
      deviceId,
    );
    stmt(db, "UPDATE devices SET display_name = ? WHERE id = ?").run(displayName, deviceId);
    return true;
  });
}

/**
 * 解除关联，**不删设备记录**。设备记录是跨用户共享的实体，别人可能还登记着；
 * 删掉会让重新登记拿到新的 deviceId，小程序本地的设备偏好就断了。
 */
export function unlinkDevice(db: Db, userId: number, deviceId: number): boolean {
  const info = stmt(db, "DELETE FROM user_devices WHERE user_id = ? AND device_id = ?").run(
    userId,
    deviceId,
  );
  return Number(info.changes) > 0;
}

export function touchDevice(db: Db, input: TouchDeviceInput): DeviceCacheRow | null {
  return inTransaction(db, () => {
    const link = stmt(db, "SELECT 1 AS ok FROM user_devices WHERE user_id = ? AND device_id = ?").get(
      input.userId,
      input.deviceId,
    );
    if (link === undefined) return null;

    // COALESCE 保证「这次没带缓存字段」不会把上一次的值清空。
    stmt(
      db,
      `UPDATE devices
          SET last_seen_at = @now,
              led_counts   = COALESCE(@ledCounts, led_counts),
              firmware_ver = COALESCE(@firmwareVer, firmware_ver)
        WHERE id = @deviceId`,
    ).run({
      now: input.now,
      ledCounts: input.ledCounts === null ? null : JSON.stringify(input.ledCounts),
      firmwareVer: input.firmwareVer,
      deviceId: input.deviceId,
    });

    const row = stmt(
      db,
      `SELECT id, hardware_id, display_name, last_seen_at, led_counts, firmware_ver, created_at
         FROM devices WHERE id = ?`,
    ).get(input.deviceId) as DeviceCacheRow | undefined;
    return row ?? null;
  });
}

export function listRegisteredDevices(db: Db): RegisteredDeviceRow[] {
  return stmt(
    db,
    `SELECT d.id, d.hardware_id, d.display_name, d.last_seen_at, d.led_counts,
            d.firmware_ver, d.created_at,
            (SELECT COUNT(*) FROM user_devices ud WHERE ud.device_id = d.id) AS user_count
       FROM devices d
      ORDER BY d.last_seen_at DESC, d.id ASC`,
  ).all() as unknown as RegisteredDeviceRow[];
}

/** 缓存列里的 JSON 数组可能被写坏（手工改库 / 旧版本），解析失败一律当 null。 */
export function parseLedCounts(raw: string | null): number[] | null {
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    if (!parsed.every((v) => typeof v === "number" && Number.isSafeInteger(v))) return null;
    return parsed as number[];
  } catch {
    return null;
  }
}
