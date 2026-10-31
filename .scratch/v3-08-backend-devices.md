## 要构建什么

后端的设备登记表 + 会话 API，为「设备列表」提供跨设备同步能力。
**明确不存任何灯光配置** —— 设备 NVS 是唯一真相（理由见 `docs/spec-v3.md` §2.2）。

## 范围

1. **schema 迁移 version 2**（在 `server/src/schema.ts` 的 `MIGRATIONS` 里追加，不要改 `SCHEMA_SQL`）：

```
devices
  id            INTEGER PK
  hardware_id   TEXT NOT NULL UNIQUE      -- BT MAC，已规范化为大写 "AA:BB:CC:DD:EE:FF"
  display_name  TEXT                      -- 用户备注名
  last_seen_at  INTEGER NOT NULL
  led_counts    TEXT                      -- JSON 数组，仅缓存，非权威
  firmware_ver  INTEGER                   -- 仅缓存，非权威
  created_at    INTEGER NOT NULL

user_devices
  user_id       INTEGER NOT NULL REFERENCES users(id)
  device_id     INTEGER NOT NULL REFERENCES devices(id)
  added_at      INTEGER NOT NULL
  PRIMARY KEY (user_id, device_id)
```

2. **身份**：`POST /api/v1/session` 用 `wx.login` 的 code 换 openid（需 `WX_APPID` + `WX_SECRET`）。
   **可配置回落**：未配 AppSecret 时沿用现有 `local-<hex>`，响应 `identityKind: "local"`，
   并在响应里明示不可信。配了则 `identityKind: "openid"`。
3. **设备 API**（都要 app token）：
   - `POST /api/v1/devices/register` — `hardwareId` 必填，upsert，返回 `deviceId`
   - `GET /api/v1/devices` — 当前用户的设备列表
   - `PATCH /api/v1/devices/:id` — 改备注名
   - `DELETE /api/v1/devices/:id` — 仅解除关联，不删设备记录
   - `POST /api/v1/devices/:id/seen` — 更新 `last_seen_at` 与缓存字段
4. **保留现有 `POST /api/v1/usage-logs`**，行为不变（仍然记录使用会话）。
5. **admin 页面**新增设备列表（只读），沿用现有 HTML 渲染与转义。

## 安全边界（必须写进代码注释与 README）

- **不做访问控制**：`user_devices` 只回答「谁登记过」，不回答「谁能连」。
  任何人扫到设备都能连——这是个人测试阶段的前提。
- `local-<hex>` 身份可伪造，此时设备列表只在单机有意义。
- `led_counts` / `firmware_ver` 是**缓存**，不可作为权威向 App 展示"设备当前配置"。

## 验收

- [ ] 迁移可从 version 0 的库平滑升到 2，`user_version` 正确推进
- [ ] （现有 schema-migration 测试）迁移幂等、反复执行不破坏数据
- [ ] `register` 对同一 `hardwareId` 幂等，返回同一 `deviceId`
- [ ] 设备列表只返回当前 `user_key` 关联的设备
- [ ] 备注名超长 / 空串 / 含 HTML 的输入被正确处理（转义 + 校验）
- [ ] 未配 AppSecret 时 `session` 返回 `identityKind: "local"`，设备功能仍可用
- [ ] 所有新路由在 `readonly.test.ts` 的 405 契约下不被误伤
- [ ] 断言 `devices` 表无任何灯光配置字段（rgb/brightness/segment/script）

## 阻塞

无（与固件、小程序票并行）
