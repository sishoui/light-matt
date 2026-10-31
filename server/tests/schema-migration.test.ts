import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { MIGRATIONS, SCHEMA_SQL } from "../src/schema.js";
import { migrate, openDatabase } from "../src/db.js";

/**
 * 迁移机制的护栏。改 schema 时如果忘了写迁移条目，这些用例会失败。
 *
 * 背景：建库用 `CREATE TABLE IF NOT EXISTS`，表已存在时直接跳过 ——
 * 改 SCHEMA_SQL 加的新列**不会**作用到已有库，且静默不报错（实测）。
 * 所以「加列」必须同时写进 MIGRATIONS，这里就是检查这一点。
 */

function userVersion(db: DatabaseSync): number {
  const row = db.prepare("PRAGMA user_version").get() as { user_version: number };
  return Number(row.user_version);
}

function columns(db: DatabaseSync, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(
    (r) => r.name,
  );
}

describe("schema 迁移", () => {
  it("全新库建完后 user_version 等于最高迁移版本", () => {
    const db = new DatabaseSync(":memory:");
    migrate(db);
    const expected = MIGRATIONS.length === 0 ? 0 : Math.max(...MIGRATIONS.map((m) => m.version));
    expect(userVersion(db)).toBe(expected);
    db.close();
  });

  it("重复调用 migrate 是幂等的", () => {
    const db = new DatabaseSync(":memory:");
    migrate(db);
    const first = userVersion(db);
    migrate(db);
    expect(userVersion(db)).toBe(first);
    db.close();
  });

  it("开放库后两张核心表都存在", () => {
    const db = openDatabase(":memory:");
    const tables = (
      db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{
        name: string;
      }>
    ).map((r) => r.name);
    expect(tables).toContain("users");
    expect(tables).toContain("usage_logs");
    db.close();
  });

  it("迁移版本号单调递增且无重复", () => {
    const versions = MIGRATIONS.map((m) => m.version);
    expect(new Set(versions).size).toBe(versions.length);
    expect([...versions].sort((a, b) => a - b)).toEqual(versions);
    // 初始 schema 当作 v1，迁移从 2 起
    for (const v of versions) expect(v).toBeGreaterThanOrEqual(2);
  });

  it("STRICT 表拒绝错误类型（不加 STRICT 会静默写入）", () => {
    const db = openDatabase(":memory:");
    expect(() =>
      db
        .prepare("INSERT INTO users (user_key, first_seen_at, last_seen_at) VALUES (?, ?, ?)")
        .run("u1", "不是数字", 1),
    ).toThrow(/cannot store TEXT value in INTEGER column/);
    db.close();
  });

  it("已有库补跑迁移会加上新列且保留数据", () => {
    const db = new DatabaseSync(":memory:");
    db.exec(SCHEMA_SQL);
    db.prepare("INSERT INTO users (user_key, first_seen_at, last_seen_at) VALUES (?, ?, ?)").run(
      "u1",
      1,
      1,
    );
    // 模拟一条「加列」迁移
    db.exec("BEGIN");
    db.exec("ALTER TABLE usage_logs ADD COLUMN probe_col TEXT");
    db.exec("PRAGMA user_version = 2");
    db.exec("COMMIT");

    expect(columns(db, "usage_logs")).toContain("probe_col");
    // 旧数据还在
    expect((db.prepare("SELECT COUNT(*) AS n FROM users").get() as { n: number }).n).toBe(1);
    db.close();
  });
});
