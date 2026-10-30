import Database from "better-sqlite3";
import { SCHEMA_SQL } from "./schema.js";
import { resolveDeviceKey, type DeviceIdentityInput, type Platform } from "./identity.js";

export type Db = Database.Database;

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

export function openDatabase(file: string): Db {
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA_SQL);
  return db;
}

export function recordUsage(db: Db, input: UsageLogInput): WriteResult {
  const resolved = resolveDeviceKey(input.device);
  const tx = db.transaction((row: UsageLogInput): WriteResult => {
    const now = row.reportedAt;
    const upsertUser = db.prepare(
      `INSERT INTO users (user_key, display_name, first_seen_at, last_seen_at)
       VALUES (@userKey, @displayName, @startedAt, @startedAt)
       ON CONFLICT(user_key) DO UPDATE SET
         display_name = COALESCE(excluded.display_name, users.display_name),
         first_seen_at = MIN(users.first_seen_at, excluded.first_seen_at),
         last_seen_at  = MAX(users.last_seen_at, excluded.last_seen_at)`,
    );
    upsertUser.run({
      userKey: row.userKey,
      displayName: row.displayName ?? null,
      startedAt: row.startedAt,
    });

    const user = db.prepare("SELECT id FROM users WHERE user_key = ?").get(row.userKey) as
      | { id: number }
      | undefined;
    if (user === undefined) throw new Error("users 行刚写入却读不到");

    const insert = db.prepare(
      `INSERT INTO usage_logs
         (user_id, device_key, device_name, device_id, platform,
          started_at, ended_at, reported_at, client_event_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(client_event_id) DO NOTHING`,
    );
    const info = insert.run(
      user.id,
      resolved.key,
      resolved.name,
      row.device.deviceId ?? null,
      row.device.platform,
      row.startedAt,
      row.endedAt ?? null,
      now,
      row.clientEventId,
    );

    if (info.changes === 0) {
      const existing = db
        .prepare("SELECT id FROM usage_logs WHERE client_event_id = ?")
        .get(row.clientEventId) as { id: number } | undefined;
      return {
        id: existing?.id ?? 0,
        duplicate: true,
        deviceKey: resolved.key,
        deviceKeyKind: resolved.kind,
      };
    }

    // 自动收尾：同一 (用户, 设备) 上一条还开着（ended_at IS NULL）的会话，
    // 用本次开始时间关掉它。App 被杀不会留下永远开着的一行。
    db.prepare(
      `UPDATE usage_logs
          SET ended_at = ?
        WHERE user_id = ? AND device_key = ? AND ended_at IS NULL
          AND started_at <= ? AND id <> ?`,
    ).run(row.startedAt, user.id, resolved.key, row.startedAt, info.lastInsertRowid);

    return {
      id: Number(info.lastInsertRowid),
      duplicate: false,
      deviceKey: resolved.key,
      deviceKeyKind: resolved.kind,
    };
  });

  return tx(input);
}

export function listDevices(db: Db): DeviceRow[] {
  return db
    .prepare("SELECT * FROM v_devices ORDER BY last_seen_at DESC, device_key ASC")
    .all() as DeviceRow[];
}

export function listUsers(db: Db): UserRow[] {
  return db
    .prepare("SELECT * FROM v_users ORDER BY last_seen_at DESC, id ASC")
    .all() as UserRow[];
}

export function countRows(db: Db): { users: number; usage_logs: number } {
  const users = db.prepare("SELECT COUNT(*) AS n FROM users").get() as { n: number };
  const logs = db.prepare("SELECT COUNT(*) AS n FROM usage_logs").get() as { n: number };
  return { users: users.n, usage_logs: logs.n };
}

export function isPlatform(value: unknown): value is Platform {
  return (
    value === "android" || value === "ios" || value === "devtools" || value === "unknown"
  );
}
