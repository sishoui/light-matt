/**
 * 建库脚本。两张表 + 两个只读视图，没有 owner、没有权限、没有关系表。
 *
 * 唯一性约束只出现在「幂等补报」上（client_event_id），这是断网补报不产生
 * 重复记录的保证，不是业务约束。
 */
export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_key      TEXT    NOT NULL UNIQUE,
  display_name  TEXT,
  first_seen_at INTEGER NOT NULL,
  last_seen_at  INTEGER NOT NULL
);

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
);

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
