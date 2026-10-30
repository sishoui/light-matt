# lumen server —— 使用日志后端 + 只读看板

对应 GitHub issue：[#23 后端数据模型与 API](https://github.com/sishoui/light-matt/issues/23)，
下游消费方是 [#34 端到端：后端使用日志与只读看板](https://github.com/sishoui/light-matt/issues/34)。

**一句话定位**：一张用户表 + 一张使用日志表 + 两个只读视图。**不做归属、不做共享、不做权限、
不做远程控制、不做业务处理。** 控制路径始终是手机 ↔ 设备的本地 BLE 直连，后端永远不在控制链路上。

本目录只有 `src/`（服务）、`tests/`（vitest）、三个配置文件和本文档。没有前端构建、没有
ORM、没有迁移框架、没有定时任务。

---

## 1. 数据模型

两张表，可原样建库（`src/schema.ts` 里的 `SCHEMA_SQL` 就是唯一真相，启动时
`CREATE TABLE IF NOT EXISTS` 幂等执行）。

### `users`

一个「能区分不同手机/人」的标识就够了，没有密码、没有邮箱、没有角色。

| 列 | 类型 | 说明 |
|---|---|---|
| `id` | INTEGER PK AUTOINCREMENT | 内部主键，不对外暴露 |
| `user_key` | TEXT NOT NULL UNIQUE | 外部身份标识。当前取微信 `openid`；个人测试阶段也可用开发者自填的稳定串（见 §3） |
| `display_name` | TEXT NULL | 展示用昵称，可为空；只由小程序写入端更新 |
| `first_seen_at` | INTEGER NOT NULL | 首次出现时间（Unix 毫秒） |
| `last_seen_at` | INTEGER NOT NULL | 最近一次出现时间（Unix 毫秒） |

写入时按 `user_key` upsert：`first_seen_at` 取 MIN、`last_seen_at` 取 MAX、
`display_name` 只在非空时覆盖。**没有 owner 列、没有用户↔设备关系表。**

### `usage_logs`

一条记录 = 一次「谁 × 哪台 × 什么时候连过」。**不是心跳**，一次连接一条。

| 列 | 类型 | 说明 |
|---|---|---|
| `id` | INTEGER PK AUTOINCREMENT | |
| `user_id` | INTEGER NOT NULL → `users(id)` | 外键，无级联删除（后台也没有删除入口） |
| `device_key` | TEXT NOT NULL | **聚合键**，归一后的设备标识，见 §4 |
| `device_name` | TEXT NULL | 归一化的广播名，如 `LUMEN-1A2B` |
| `device_id` | TEXT NULL | 原始平台 `deviceId`（Android=MAC，iOS=UUID），只作诊断证据，**从不用于分组** |
| `platform` | TEXT NOT NULL DEFAULT `'unknown'` | `android` / `ios` / `devtools` / `unknown` |
| `started_at` | INTEGER NOT NULL | 本次连接开始（Unix 毫秒） |
| `ended_at` | INTEGER NULL | 断开时间；App 被杀时为 NULL，由下一次同用户同设备的记录自动收尾 |
| `reported_at` | INTEGER NOT NULL | 服务端收到的时刻（用于识别补报延迟） |
| `client_event_id` | TEXT NOT NULL UNIQUE | 小程序生成的 UUID。**幂等键**：断网补报重复提交只会命中这一行 |

索引：`device_key`、`user_id`、`started_at` 各一个。
**没有的列（有意）**：颜色、亮度、开关、灯珠数量、剧本、分段、命令字节 —— 任何实时控制数据。
`tests/api.test.ts` 里有一条用例专门断言表结构里不存在这些列。

### 两个只读视图

两者都是 `CREATE VIEW`，没有对应的可写实体，后台只 `SELECT` 它们。

**`v_devices`** —— 设备列表，按 `device_key` 聚合：

| 列 | 含义 |
|---|---|
| `device_key` | 聚合键 |
| `device_name` | 该键下的广播名（同键通常只有一个值；`hardware` 档撞名时取字典序最大的一个） |
| `use_count` | **连接会话数**（行数），不是心跳数 |
| `user_count` | 用过它的不同用户数 |
| `last_seen_at` | `MAX(COALESCE(ended_at, started_at))` |
| `mac_count` | 该键下出现的不同 MAC 形态 `device_id` 数量。`> 1` 说明广播名撞车了（见 §4） |

**`v_users`** —— 用户列表，`users LEFT JOIN usage_logs`，所以「注册了但还没日志」的用户也列得出来：

`id, user_key, display_name, first_seen_at, last_seen_at, use_count, device_count`。

---

## 2. API 清单

两侧物理分离：写入端在 `/api/v1/**`，只读端在 `/admin/**`。**没有交叉**——写入端没有读接口，
只读端没有任何写路由。

### 2.1 小程序写入端

| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| `POST` | `/api/v1/usage-logs` | `x-lumen-app-token: <APP_TOKEN>` | 追加一条使用日志。`201` = 新建，`200` = 幂等重复 |
| `GET` | `/health` | 无 | 存活探针，无数据。小程序据此决定是否补报本地缓存 |

请求体：

```json
{
  "userKey": "oX7abc...",
  "displayName": "小明",
  "startedAt": 1760000000000,
  "endedAt": null,
  "clientEventId": "2f1c9d3a-...",
  "device": {
    "deviceName": "Lumen-1A2B",
    "deviceId": "AA:BB:CC:DD:1A:2B",
    "platform": "android"
  }
}
```

- `startedAt` / `endedAt` 是**客户端毫秒时间戳**。服务端不信任顺序，只做 `endedAt >= startedAt` 校验；
  `reported_at` 单独记录服务端收到的时间，两者一起能看出补报延迟。
- `clientEventId` 必填。重复提交返回 `200 {duplicate: true}`，小程序可以无脑重试。
- `device` 里 `hardwareId`（可选，设备自报的稳定硬件 id）、`deviceName`、`deviceId`
  至少给一个，否则 `400`。
- 响应：`{ id, duplicate, deviceKey, deviceKeyKind }`。`deviceKeyKind` 是 `hardware|name|raw`，
  让小程序端能自己看出这条日志落到了哪一档归一规则。

**`x-lumen-app-token` 携带的身份是什么**：它携带的是「这个构建出来的小程序实例」，**不是某个人**。
它只证明请求来自 app，无法防止逆向提取后的伪造——个人测试阶段明确接受这个强度
（真正的用户身份是请求体里的 `userKey`，而它同样可被伪造）。加微信 `code2session` 才能把令牌
绑到真人身份上，那属于上线前的工作，不在本票范围（见 §7）。

### 2.2 后台只读端

全部要求 HTTP Basic Auth（`ADMIN_USER` / `ADMIN_PASSWORD`）。**匿名一律 401**，
且 401 响应带 `WWW-Authenticate: Basic realm="lumen admin"`，浏览器会弹原生登录框。

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/admin/devices` | 设备列表：设备名、聚合键、使用次数、用户数、最后出现时间、可见 MAC 数 |
| `GET` | `/admin/users` | 用户列表：昵称、标识、使用次数、设备数、首末出现时间 |
| `GET` | `/admin/` | `302` → `/admin/devices` |

**写方法在 `/admin/**` 上一律 `405`**，且带 `Allow: GET, HEAD`。这不是靠「没写路由所以 404」
兜底，而是显式注册了 `POST/PUT/PATCH/DELETE` 的通配处理器；`tests/readonly.test.ts` 用
28 条参数化用例逐格验证了这一点。页面 HTML 里也没有 `<form>` / `<input>` / `<button>`，
同样有测试断言。

鉴权先于路由匹配：匿名的 `POST /admin/devices` 得到 `401` 而不是 `405`，不泄露路由形状。

### 2.3 明确不存在的接口

- 没有控制/命令下发通道（控制只在 BLE 上）。
- 没有配置读取或同步接口（见 §5）。
- 没有用户注册、密码、OAuth、`code2session`。
- 没有删除/编辑接口，任何一侧都没有。

---

## 3. 身份方案（问题 1）

只回答「这是不是同一部手机/同一个人」，因此用户表只有 `user_key` + 展示名。

- **正式形态**：`user_key = wx.login() 拿到的 openid`。个人主体小程序可以拿到 `openid`，
  它天然按（小程序, 微信用户）唯一，正是我们要的粒度。`unionid` 不必要——本项目只有一个
  小程序，没有跨应用识别需求。
- **个人测试阶段**：`wx.login` 在开发者工具和体验版里同样可用，所以测试阶段也直接用 `openid`，
  不需要退化成设备指纹。没有「匿名」分支：一条日志必须能回答「昨天是谁用过这台」，
  没有 `user_key` 的日志没有价值。
- **不做的事**：不建账号密码、不发会话、不做角色。后台的唯一账号是环境变量里的那一个
  运营者，与用户表无关。

---

## 4. 设备标识与跨手机归一（问题 2，本票核心）

### 4.1 问题的事实边界

- 广播名 `Lumen-XXXX`（`docs/protocol.md` §2，固件实现见 `firmware/main/ble_link.c:381`）
  的 `XXXX` 是**蓝牙 MAC 的最后 2 个字节**。同一台设备跨手机**完全一致**，但只有 16 bit，
  **不唯一**：设备多了会重名（生日悖论下约 300 台就有 ~50% 概率撞名）。
- 连接后的 `deviceId` 由操作系统给：**Android 是 MAC，iOS 是每台手机各自不同的 UUID**。
  它既不能跨手机对齐，iOS 上换手机后还会变。**它不能作为聚合键**，这是本票的技术难点。

### 4.2 结论：按广播名归一，不按 deviceId

日志的聚合键 `device_key` 按以下**固定优先级**生成（唯一实现：`src/identity.ts` 的
`resolveDeviceKey`）：

| 优先级 | 条件 | `device_key` | `deviceKeyKind` |
|---|---|---|---|
| 1 | 有 `hardwareId` | `hw:<小写硬件id>` | `hardware` |
| 2 | 有广播名 | `name:<大写广播名>` | `name` |
| 3 | 只有 `deviceId` | `raw:<platform>:<小写deviceId>` | `raw` |

**当前落地的是第 2 档**：`device_key = name:LUMEN-XXXX`。理由：

1. 它是目前**唯一同时满足「跨手机一致」和「不需要改固件」**的标识。`Lumen-XXXX` 由设备端
   从自己的蓝牙 MAC 算出，Android 与 iOS 断言的广播名是同一个值，所以同一台物理设备在
   两部手机上的日志会落进同一个 `device_key`——聚合成立。
2. 第 1 档 `hardwareId` 是更正确的方案（芯片 MAC 或 eFuse 派生的完整 id，通过新增一条只读
   命令或在 State 里加字段下发），但需要改 `docs/protocol.md`、固件、小程序三处，超出本票
   范围。协议一旦扩展，只需小程序在 `device.hardwareId` 里多传一个字段，**后端和
   `device_key` 优先级表都不用改**——第 1 档已经预留在代码里。
3. 第 3 档是兜底：没有广播名（例如只拿到扫描结果的边缘情况）时仍要落库，宁可分组分裂也不丢数据。

### 4.3 已知代价与看板上的处理

**接受「同名设备会被合并成一台」。** 这是有意识的取舍，不是待修的 bug：

- `v_devices.mac_count` 统计该 `device_key` 下出现过的不同 MAC 形态 `device_id`。
  `mac_count > 1` 就是在提示「这个广播名可能撞车了」。看板把它作为一列直接显示。
- 该列只能看到 **Android** 侧的撞车（iOS 的 `deviceId` 是 UUID，被 `instr(device_id, ':') > 0`
  排除在计数外）——所以它是**存在性提示**，不是精确计数。
- 因此看板上的「使用次数」口径是：**同一广播名下的连接会话数**。运营者看到 `mac_count > 1`
  时，应当认为这个数字偏大（多台设备被合并），而不是设备真的被用了这么多次。

### 4.4 明确写下来的聚合口径（一句话版）

> **一台设备 = 一个 `device_key` = 一个大写广播名 `LUMEN-XXXX`（未来有硬件 id 时改为硬件 id）。
> 不同手机上的 `deviceId` 只作为原始证据存档，不参与分组。同一广播名下的多台设备会被合并，
> 用 `mac_count` 观察。使用次数 = 连接会话数，不是心跳数。**

---

## 5. 配置真相源（问题 4）

**设备是唯一真相源，后端不存任何配置副本。**

- 分段配置、剧本库都持久化在设备 NVS 里（`docs/spec-v2.md`「持久化」）；小程序连上后从设备
  读回真实配置，State 是权威（`docs/protocol.md` §7：「设备是状态权威」）。
- 后端存副本会立刻产生第二个真相源和一致性问题，而 v2 没有任何「换手机恢复配置」的需求
  （用户故事里也没有）。换手机后重新连上同一台设备，配置本来就在设备上。
- **本票实现为零**：没有配置表、没有配置接口、没有同步任务。#34 也不需要它。

这条结论的副作用：后端挂了不影响任何配置与控制——这正是 #34 的验收项「后端不可达时不影响
小程序的控制功能」。

---

## 6. 日志粒度（问题 3）

- **一条记录 = 一次连接会话**：`谁 × 哪台 × 开始时间 × 结束时间`。结束时间可为空，
  由下一次同用户同设备的记录自动收尾（`UPDATE ... SET ended_at = 下次 started_at`）。
- **不记心跳**。心跳会让数据量按连接时长线性膨胀，而看板只需要「用过没有、最近什么时候」。
- **断网补报**：`clientEventId` 是幂等键，小程序本地排队、联网后重放即可，不会产生重复行。
  该机制由 #34 在小程序侧实现，本票提供幂等保证。
- 任何实时控制数据都不入库（§1 的列清单）。

---

## 7. 技术栈与部署（问题 5）

- **技术栈**：Node 24 + TypeScript + Fastify 5 + better-sqlite3 13，服务端渲染 HTML（无前端构建）——
  与小程序的工具链一致、单进程零外部依赖，一台最小 VPS 就能跑。
- **部署**：`npm ci && npm run build`，用环境变量启动 `node dist/index.js`，由 systemd 守护，
  SQLite 文件放本机卷，放在反向代理后面只暴露 443——就这一条。

### 环境变量

| 变量 | 必填 | 默认 | 说明 |
|---|---|---|---|
| `ADMIN_USER` | 是 | — | 看板 Basic Auth 用户名 |
| `ADMIN_PASSWORD` | 是 | — | 看板 Basic Auth 密码 |
| `APP_TOKEN` | 是 | — | 小程序写入端令牌 |
| `PORT` | 否 | `8787` | |
| `HOST` | 否 | `127.0.0.1` | 默认只听本机，由反代对外 |
| `DB_PATH` | 否 | `./data/lumen.db` | 目录不存在会自动创建 |

三个秘密都**没有默认值**：缺任何一个进程直接拒绝启动，避免「默认口令上线」。

### 本地跑

```bash
cd server
npm install
ADMIN_USER=admin ADMIN_PASSWORD=dev-pass APP_TOKEN=dev-token npm start
```

### 反代注意事项

看板用 HTTP Basic，**必须走 HTTPS**，否则口令是明文。个人测试阶段可只在
`127.0.0.1` + SSH 隧道里访问，不对外开端口。

---

## 8. 测试

```bash
npm test          # vitest，离线，不监听端口、不联网（fastify.inject + :memory: SQLite）
npm run typecheck # tsc --noEmit
```

57 条用例，覆盖本票要求的四类：

| 文件 | 覆盖 |
|---|---|
| `tests/api.test.ts` | 日志写入落库、幂等补报、会话自动收尾、token 缺失/错误 401、请求体校验 400、表里不含控制列；后台鉴权（匿名/错密码/错用户名/坏 header 全 401） |
| `tests/aggregation.test.ts` | **跨手机聚合**（Android MAC 与 iOS UUID → 同一 `device_key`）、广播名撞车的 `mac_count`、`hardwareId` 优先、`raw` 兜底、会话计数、`last_seen_at` 取 ended/started 较大者；`resolveDeviceKey` 优先级单测 |
| `tests/readonly.test.ts` | 看板两页内容；HTML 无表单/输入/按钮；28 条 `POST/PUT/PATCH/DELETE × 7 个路径` 全部 `405`；带凭据的写方法也改不动数据；`/health` 免鉴权 |

---

## 9. 本票没有做、也不该做

不存实时控制通道 · 不做归属 · 不做共享 · 不做角色权限 · 不做业务处理 · 后台只读 ·
不做 `code2session` · 不做配置同步 · 不做迁移框架 · 不做 OTA。
