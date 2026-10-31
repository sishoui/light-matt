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
