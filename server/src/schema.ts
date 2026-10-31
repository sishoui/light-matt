/**
 * 建库脚本。两张表 + 两个只读视图，没有 owner、没有权限、没有关系表。
 *
 * 唯一性约束只出现在「幂等补报」上（client_event_id），这是断网补报不产生
 * 重复记录的保证，不是业务约束。
 *
 * 关于 STRICT：SQLite 默认是动态类型，`INTEGER` 列可以存进字符串且**不报错**
 * （实测：`INSERT ... VALUES (1, '不是数字')` 成功）。STRICT 表让类型检查真正
 * 生效。这里两张表都加了 STRICT，新增的表也应该加。
 * 注意 STRICT 要求列类型必须是 INTEGER/REAL/TEXT/BLOB/ANY 之一。
 */
export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_key      TEXT    NOT NULL UNIQUE,
  display_name  TEXT,
  first_seen_at INTEGER NOT NULL,
  last_seen_at  INTEGER NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS usage_logs (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id         INTEGER NOT NULL REFERENCES users(id),
  device_key      TEXT    NOT NULL,
  device_name     TEXT,
  device_id       TEXT,
  platform        TEXT    NOT NULL DEFAULT 'unknown',
  started_at      INTEGER NOT NULL,
  ended_at        INTEGER,
  reported_at     INTEGER NOT NULL,
  client_event_id TEXT    NOT NULL UNIQUE
) STRICT;

CREATE INDEX IF NOT EXISTS idx_usage_logs_device ON usage_logs(device_key);
CREATE INDEX IF NOT EXISTS idx_usage_logs_user   ON usage_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_usage_logs_start  ON usage_logs(started_at);

-- 设备聚合：按 device_key 分组。use_count 是连接会话数，不是心跳数。
-- mac_count 是诊断列：同一 device_key 下出现多个不同 MAC 说明广播名撞车了。
CREATE VIEW IF NOT EXISTS v_devices AS
SELECT
  device_key,
  MAX(device_name)                                            AS device_name,
  COUNT(*)                                                    AS use_count,
  COUNT(DISTINCT user_id)                                     AS user_count,
  MAX(COALESCE(ended_at, started_at))                         AS last_seen_at,
  COUNT(DISTINCT CASE
                   WHEN device_id IS NOT NULL AND instr(device_id, ':') > 0
                   THEN upper(device_id)
                 END)                                         AS mac_count
FROM usage_logs
GROUP BY device_key;

-- 用户列表：一人一行，LEFT JOIN 保证「有用户但还没有日志」也列得出来。
CREATE VIEW IF NOT EXISTS v_users AS
SELECT
  u.id,
  u.user_key,
  u.display_name,
  u.first_seen_at,
  u.last_seen_at,
  COUNT(l.id)             AS use_count,
  COUNT(DISTINCT l.device_key) AS device_count
FROM users u
LEFT JOIN usage_logs l ON l.user_id = u.id
GROUP BY u.id;
`;

/**
 * 增量迁移。**这是加列/改列的唯一正确途径。**
 *
 * 为什么不能只改 SCHEMA_SQL：建库用的 `CREATE TABLE IF NOT EXISTS` 在表已存在时
 * 直接跳过，**新加的列会被静默忽略且不报错**（实测）。等代码读这一列时才炸，
 * 错误信息还跟真正原因无关。
 *
 * 规则：
 * - 只追加，不改历史条目。已发布的条目内容一旦改动，环境之间就会不一致。
 * - 每条是一个或多个 SQL 语句，用 `db.exec` 执行。
 * - 索引放这里时不要写 `IF NOT EXISTS` 之外的依赖顺序假设。
 * - 需要重建表才能做的改动（改列类型、加约束）SQLite 不支持 → 用
 *   `CREATE TABLE new_x ... ; INSERT INTO new_x SELECT ... ; DROP TABLE x ;
 *   ALTER TABLE new_x RENAME TO x` 四步，写成一个迁移条目。
 */
export const MIGRATIONS: ReadonlyArray<{ readonly version: number; readonly sql: string }> = [
  // v1 = SCHEMA_SQL 的初始形态（users / usage_logs / 两个视图）。
  // 后续迁移从 2 开始追加，例如：
  //
  // {
  //   version: 2,
  //   sql: `ALTER TABLE usage_logs ADD COLUMN firmware_version TEXT;`,
  // },
];
