# lumen server —— 使用日志后端 + 设备登记 + 只读看板

对应 GitHub issue：[#23 后端数据模型与 API](https://github.com/sishoui/light-matt/issues/23)、
[#34 端到端：后端使用日志与只读看板](https://github.com/sishoui/light-matt/issues/34)、
[#43 后端：设备登记与会话 API](https://github.com/sishoui/light-matt/issues/43)。

**一句话定位**：两张用户数据表 + 两张设备登记表 + 两个只读视图。**不做归属、不做共享、不做权限、
不做远程控制、不做业务处理、不存任何灯光配置。** 控制路径始终是手机 ↔ 设备的本地 BLE 直连，
后端永远不在控制链路上，设备 NVS 是灯光配置的唯一真相。

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

### `devices` 与 `user_devices`（v3 迁移 version 2）

`devices` 是**设备实体**，`user_devices` 是「哪个用户登记过哪台设备」。

| `devices` 列 | 类型 | 说明 |
|---|---|---|
| `id` | INTEGER PK AUTOINCREMENT | 内部主键，对外以 `deviceId` 暴露 |
| `hardware_id` | TEXT NOT NULL UNIQUE | 48 位蓝牙 MAC，归一为大写冒号 `AA:BB:CC:DD:EE:FF` |
| `display_name` | TEXT NULL | **非权威的全局默认**备注名（最后一次改名留下的） |
| `last_seen_at` | INTEGER NOT NULL | 最近一次 `.../seen` 的时间 |
| `led_counts` | TEXT NULL | JSON 数组，**缓存，非权威** |
| `firmware_ver` | INTEGER NULL | **缓存，非权威** |
| `created_at` | INTEGER NOT NULL | 首次登记时间 |

| `user_devices` 列 | 类型 | 说明 |
|---|---|---|
| `user_id` | INTEGER NOT NULL → `users(id)` | |
| `device_id` | INTEGER NOT NULL → `devices(id)` | |
| `added_at` | INTEGER NOT NULL | 登记时间 |
| `display_name` | TEXT NULL | **每个用户自己的备注名，权威** |

主键 `(user_id, device_id)`；索引在 `device_id` 与 `devices.last_seen_at` 上。

**备注名为什么有两份**：#43 把 `display_name` 放在 `devices` 上，#44 要求「同一台设备在两台
手机上能各叫各的」。两者都要满足，所以读路径统一取
`COALESCE(user_devices.display_name, devices.display_name)`：改过名的人看到自己的名字，
没改过的人看到全局默认值。`PATCH` 只写调用者的那一条关联，同时刷新全局默认（非权威）。

**没有的列（有意）**：`rgb` / `brightness` / `segment` / `script` / `stage` / `power` / 任何
实时控制数据。`devices` 上只有登记信息与**明确标注非权威**的缓存；配置真相在设备 NVS
（`docs/spec-v3.md` §2.2）。`tests/devices.test.ts` 有两条用例从两个方向断言这一点：表结构
里没有这些列，请求体里塞进去也只会被忽略。

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
| `POST` | `/api/v1/session` | `x-lumen-app-token` | 换取身份。配了 `WX_APPID`/`WX_SECRET` 时用 `code` 换 openid，否则接受 `local-<16hex>` |
| `POST` | `/api/v1/devices/register` | app token + `x-lumen-user-key` | 登记一台设备。`201` = 新设备，`200` = 幂等重复 |
| `GET` | `/api/v1/devices` | app token + `x-lumen-user-key` | 当前用户登记的设备列表 |
| `PATCH` | `/api/v1/devices/:id` | app token + `x-lumen-user-key` | 改**自己的**备注名 |
| `DELETE` | `/api/v1/devices/:id` | app token + `x-lumen-user-key` | **只解除关联**，不删设备记录 |
| `POST` | `/api/v1/devices/:id/seen` | app token + `x-lumen-user-key` | 推进 `last_seen_at`，可选更新非权威缓存 |
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
    "hardwareId": "AA:BB:CC:DD:EE:FF",
    "deviceName": "Lumen-1A2B",
    "deviceId": "AA:BB:CC:DD:1A:2B",
    "platform": "android"
  }
}
```

- `startedAt` / `endedAt` 是**客户端毫秒时间戳**。服务端不信任顺序，只做 `endedAt >= startedAt` 校验；
  `reported_at` 单独记录服务端收到的时间，两者一起能看出补报延迟。
- `clientEventId` 必填。重复提交返回 `200 {duplicate: true}`，小程序可以无脑重试。
- `device` 里 `hardwareId`（可选，设备自报的 6 字节 BT MAC）、`deviceName`、`deviceId`
  至少给一个，否则 `400`。
  `hardwareId` **格式不认时当作没带**，不 `400`（见 §4.2）；老客户端完全不传它时行为不变。
- 响应：`{ id, duplicate, deviceKey, deviceKeyKind }`。`deviceKeyKind` 是 `hardware|name|raw`，
  让小程序端能自己看出这条日志落到了哪一档归一规则。

**`x-lumen-app-token` 携带的身份是什么**：它携带的是「这个构建出来的小程序实例」，**不是某个人**。
它只证明请求来自 app，无法防止逆向提取后的伪造——个人测试阶段明确接受这个强度
（真正的用户身份是请求体里的 `userKey`，而它同样可被伪造）。加微信 `code2session` 才能把令牌
绑到真人身份上，那属于上线前的工作，不在本票范围（见 §7）。

**小程序侧怎么配（#34）**：`baseUrl` 与 `appToken` 只在
`miniprogram/utils/usage/config.ts` 里定义一次，读取时允许用 storage 覆盖：

```js
// 开发者工具 Console 执行一次；不配 = 日志功能关闭，控制不受影响
wx.setStorageSync("lumen.usage.config.v1", JSON.stringify({
  baseUrl: "https://lumen.example.com",
  appToken: "<APP_TOKEN>",
}))
```

### 2.2 后台只读端

全部要求 HTTP Basic Auth（`ADMIN_USER` / `ADMIN_PASSWORD`）。**匿名一律 401**，
且 401 响应带 `WWW-Authenticate: Basic realm="lumen admin"`，浏览器会弹原生登录框。

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/admin/devices` | 设备列表：设备名、聚合键、使用次数、用户数、最后出现时间、可见 MAC 数 |
| `GET` | `/admin/users` | 用户列表：昵称、标识、使用次数、设备数、首末出现时间 |
| `GET` | `/admin/registry` | v3 设备登记表：硬件 ID、默认备注名、最后在线、登记人数量、非权威缓存 |
| `GET` | `/admin/` | `302` → `/admin/devices` |

**写方法在 `/admin/**` 上一律 `405`**，且带 `Allow: GET, HEAD`。这不是靠「没写路由所以 404」
兜底，而是显式注册了 `POST/PUT/PATCH/DELETE` 的通配处理器；`tests/readonly.test.ts` 用
36 条参数化用例逐格验证了这一点。页面 HTML 里也没有 `<form>` / `<input>` / `<button>`，
同样有测试断言。

鉴权先于路由匹配：匿名的 `POST /admin/devices` 得到 `401` 而不是 `405`，不泄露路由形状。

### 2.3 明确不存在的接口

- 没有控制/命令下发通道（控制只在 BLE 上）。
- 没有配置读取或同步接口（见 §5）。
- 没有用户注册、密码、OAuth、登录态、签名令牌。
- 后台（`/admin/**`）没有删除/编辑接口，任何一侧都没有。
- **设备路由的身份是可伪造的自称**：`x-lumen-user-key` 头配共享 app token，没有 HMAC、没有
  会话令牌、没有签名。这是刻意为之，见下方「安全边界」。

---

## 3. 身份方案（问题 1）

只回答「这是不是同一部手机/同一个人」，因此用户表只有 `user_key` + 展示名。

- **正式形态**：`user_key = wx.login() 拿到的 openid`。个人主体小程序可以拿到 `openid`，
  它天然按（小程序, 微信用户）唯一，正是我们要的粒度。`unionid` 不必要——本项目只有一个
  小程序，没有跨应用识别需求。
- **当前落地形态（#34 实现）**：小程序**还没有** `wx.login` 登录流程，所以写入端用的是
  **本机生成的稳定随机串** `local-<16 hex>`（首次使用时写入小程序 storage，之后同一安装
  永远复用，代码见 `miniprogram/utils/usage/event.ts` 的 `getOrCreateLocalUserKey`）。
  - 诚实地说：它**不是** openid，不能跨手机识别同一个人——同一人换手机 = 两个 `user_key`；
    清缓存/重装 = 新 `user_key`。
  - 它满足个人测试阶段真正的运维问题「这台设备最近有没有人用」，且不需要登录流程。
  - 接入 `code2session` 后只需替换这一个函数，`userKey` 字段与后端全部不用改。
- **v3 已实现 `code2session`（#43）**：`POST /api/v1/session` 在 `WX_APPID` + `WX_SECRET`
  都配置时用 `wx.login` 的 `code` 换 openid，响应 `identityKind: "openid"`、`trusted: true`；
  没配时回落到 `local-<16hex>`，响应 `identityKind: "local"`、`trusted: false`。
  两种模式下设备登记都能用，区别只是 openid 能跨手机对齐同一个人。
  **只配一半会启动失败**——避免运行期「永远 502 但看不出原因」。
- **不做的事**：不建账号密码、不发会话、不做角色。后台的唯一账号是环境变量里的那一个
  运营者，与用户表无关。

### 3.1 安全边界（v3 设备登记，必须理解）

- **不做访问控制**：`user_devices` 只回答「谁登记过」，不回答「谁能连」。任何人扫到设备
  都能连——这是个人测试阶段的前提（`docs/spec-v3.md` §2.3、`docs/agents/issue-tracker.md`）。
- **身份传输不做签名**：设备路由用 `x-lumen-user-key` 头 + 共享 app token。这个头是
  **可伪造的自称**，没有 HMAC、没有会话令牌、没有过期时间。加签名的前提是「设备归属即权限」，
  而本项目刻意不做归属，所以签名只会增加复杂度而不增加安全性。上线前若要加，改
  `src/app.ts` 里的 `resolveUser` 一处即可。
- **`local-<hex>` 身份可伪造**：此时设备列表只在单机有意义。`session` 响应用
  `identityKind` / `trusted` 明示当前是哪种身份，App 据此显示「仅本机可见」。
- **`led_counts` / `firmware_ver` 是缓存**：不可作为权威向 App 展示「设备当前配置」。

---

## 4. 设备标识与跨手机归一（问题 2，本票核心）

### 4.1 问题的事实边界

- 广播名 `Lumen-XXXX`（`docs/protocol.md` §2，固件实现见 `firmware/main/ble_link.c:381`）
  的 `XXXX` 是**蓝牙 MAC 的最后 2 个字节**。同一台设备跨手机**完全一致**，但只有 16 bit，
  **不唯一**：设备多了会重名（生日悖论下约 300 台就有 ~50% 概率撞名）。
- 连接后的 `deviceId` 由操作系统给：**Android 是 MAC，iOS 是每台手机各自不同的 UUID**。
  它既不能跨手机对齐，iOS 上换手机后还会变。**它不能作为聚合键**，这是本票的技术难点。

### 4.2 结论：按 BT MAC 归一（v3），广播名兜底，从不按 deviceId

日志的聚合键 `device_key` 按以下**固定优先级**生成（唯一实现：`src/identity.ts` 的
`resolveDeviceKey`）：

| 优先级 | 条件 | `device_key` | `deviceKeyKind` |
|---|---|---|---|
| 1 | 有 `hardwareId` | `hw:<小写硬件id>` | `hardware` |
| 2 | 有广播名 | `name:<大写广播名>` | `name` |
| 3 | 只有 `deviceId` | `raw:<platform>:<小写deviceId>` | `raw` |

**#50 起第 1 档真正落地**：小程序在 `QueryDeviceInfo`（0x88）读到 `hw_id` 后，
把它作为 `device.hardwareId` 上报，于是 `device_key = hw:aa:bb:cc:dd:ee:ff`，
与 `devices.hardware_id` 是**同一个 MAC 的两串写法**（只差大小写与 `hw:` 前缀）。
同一台设备因此不再出现「登记表一行 + 日志看板另一行」。

第 2 档仍是老客户端 / 读不到 `hw_id` 时的路径（旧固件没有 0x1D），行为与 v2 完全一致：

1. 广播名 `Lumen-XXXX` 由设备端从自己的蓝牙 MAC 算出，Android 与 iOS 断言同一个值，
   所以同一台物理设备在两部手机上的日志会落进同一个 `device_key`——聚合成立。
2. 第 1 档是更正确的方案，但旧固件不支持 0x1D 时拿不到 `hw_id`，需要靠广播名兜底。
3. 第 3 档是兜底：没有广播名（例如只拿到扫描结果的边缘情况）时仍要落库，宁可分组分裂也不丢数据。

`hardwareId` 的归一化在**两处**都做（小程序 `normalizeHardwareId`、后端
`resolveDeviceKey` → `normalizeMacAddress`）：日志是旁路，不能指望客户端一定守规矩；
同一个 MAC 以 `AA-BB-CC-DD-EE-FF` / `aabbccddeeff` 等形态到达也必须聚成一行。
格式不认时**当作没带**，不 `400`——丢一条使用事实比多一行分组更糟。

### 4.3 已知代价与看板上的处理

**接受「同名设备会被合并成一台」（仅第 2 档有这个问题）。** 这是有意识的取舍，不是待修的 bug：

- `v_devices.mac_count` 统计该 `device_key` 下出现过的不同 MAC 形态 `device_id`。
  `mac_count > 1` 就是在提示「这个广播名可能撞车了」。看板把它作为一列直接显示。
- 该列只能看到 **Android** 侧的撞车（iOS 的 `deviceId` 是 UUID，被 `instr(device_id, ':') > 0`
  排除在计数外）——所以它是**存在性提示**，不是精确计数。
- 因此看板上的「使用次数」口径是：**同一广播名下的连接会话数**。运营者看到 `mac_count > 1`
  时，应当认为这个数字偏大（多台设备被合并），而不是设备真的被用了这么多次。

### 4.4 明确写下来的聚合口径（一句话版）

> **一台设备 = 一个 `device_key` = 设备自报的 MAC（`hw:aa:bb:cc:dd:ee:ff`，v3 客户端）；
> 读不到 `hw_id` 时退化为一个大写广播名 `LUMEN-XXXX`（老客户端）。
> 不同手机上的 `deviceId` 只作为原始证据存档，不参与分组。同一广播名下的多台设备会被合并，
> 用 `mac_count` 观察。使用次数 = 连接会话数，不是心跳数。**

**v3 的两套标识（#50 起已经统一到同一串 MAC）**：

| | 用途 | 键 | 存储 |
|---|---|---|---|
| 日志聚合 | 「这台设备被用过几次」 | `hw:<小写 MAC>`（旧客户端 `name:LUMEN-XXXX`） | `usage_logs.device_key` |
| 设备实体 | 「这是哪台设备」 | 蓝牙 MAC 全地址 `AA:BB:CC:DD:EE:FF` | `devices.hardware_id` |

MAC 全地址是 48 位、跨手机一致、无碰撞，所以 v3 的设备登记用它当主键；
日志聚合在 #50 也改用同一个 MAC（`devices.hardware_id.toLowerCase()` 加 `hw:` 前缀）。
`POST /api/v1/usage-logs` 的请求体只多了一个可选字段，老客户端不受影响。

---

## 5. 配置真相源（问题 4）

**设备是唯一真相源，后端不存任何配置副本。**

- 分段配置、剧本库都持久化在设备 NVS 里（`docs/spec-v2.md`「持久化」）；小程序连上后从设备
  读回真实配置，State 是权威（`docs/protocol.md` §7：「设备是状态权威」）。
- 后端存副本会立刻产生第二个真相源和一致性问题，而 v2 没有任何「换手机恢复配置」的需求
  （用户故事里也没有）。换手机后重新连上同一台设备，配置本来就在设备上。
- **v3 的设备登记也不例外**：`devices.led_counts` / `devices.firmware_ver` 只是
  **明确标注非权威**的离线提示，不能当作「设备当前配置」展示；写入走
  `POST /api/v1/devices/:id/seen`，读回真相永远走 BLE 上的 `QueryStrip`/`QueryScript`。

这条结论的副作用：后端挂了不影响任何配置与控制——这正是 #34 的验收项「后端不可达时不影响
小程序的控制功能」。

---

## 6. 日志粒度（问题 3）

- **一条记录 = 一次连接会话**：`谁 × 哪台 × 开始时间 × 结束时间`。结束时间可为空，
  由下一次同用户同设备的记录自动收尾（`UPDATE ... SET ended_at = 下次 started_at`）。
- **不记心跳**。心跳会让数据量按连接时长线性膨胀，而看板只需要「用过没有、最近什么时候」。
- **断网补报**：`clientEventId` 是幂等键，小程序本地排队、联网后重放即可，不会产生重复行。
  **#34 已在小程序侧实现**：队列持久化在小程序 storage（上限 50 条，溢出丢最旧并计数），
  连接成功入队后立即尝试发送，失败保留；下次连接成功或页面 `onShow` 时补报。
  发送路径是 fire-and-forget + 硬超时，后端不可达对 BLE 控制零影响
  （实现见 `miniprogram/utils/usage/`）。
- 任何实时控制数据都不入库（§1 的列清单）。

---

## 7. 技术栈与部署（问题 5）

- **技术栈**：Node 22.5+ + TypeScript + Fastify 5 + **`node:sqlite`**（Node 内置），
  服务端渲染 HTML（无前端构建）—— 与小程序的工具链一致、单进程零外部依赖，
  一台最小 VPS 就能跑。
  > 之前用 better-sqlite3 13，它是原生模块，安装时要用 C++ 编译器现场编译；
  > Node 24 上没有预编译包，退到源码编译后因缺 VS 的「Desktop development with
  > C++」直接失败。`node:sqlite` 是内置模块，`npm install` 零编译。
  > 注意它标记为 experimental，但 API 已稳定（`prepare/run/all/get` 与
  > better-sqlite3 同形），差异见 `src/db.ts` 头部注释。
- **部署**：`npm ci && npm run build`，用环境变量启动 `node dist/index.js`，由 systemd 守护，
  SQLite 文件放本机卷，放在反向代理后面只暴露 443——就这一条。

### 数据库结构变更（重要）

建库用 `CREATE TABLE IF NOT EXISTS`，表已存在时会**直接跳过**。所以
**只改 `schema.ts` 里的 `SCHEMA_SQL` 加列是无效的** —— 已有库里新列不会出现，
而且不报错（实测）。加列/改表必须写进 `MIGRATIONS` 数组：

```ts
// src/schema.ts
export const MIGRATIONS = [
  // v2 已被设备登记表占用；新加列从 3 起
  { version: 3, sql: `ALTER TABLE usage_logs ADD COLUMN firmware_version TEXT;` },
];
```

`openDatabase()` 会按 `PRAGMA user_version` 自动补齐未执行的迁移，包在事务里，
失败回滚。迁移只追加、不改历史条目。`tests/schema-migration.test.ts` 是护栏。

四张表都用了 `STRICT`：SQLite 默认是动态类型，`INTEGER` 列能存进字符串且不报错，
`STRICT` 让类型检查真正生效。

### 环境变量

| 变量 | 必填 | 默认 | 说明 |
|---|---|---|---|
| `ADMIN_USER` | 是 | — | 看板 Basic Auth 用户名 |
| `ADMIN_PASSWORD` | 是 | — | 看板 Basic Auth 密码 |
| `APP_TOKEN` | 是 | — | 小程序写入端令牌 |
| `PORT` | 否 | `8787` | |
| `HOST` | 否 | `127.0.0.1` | 默认只听本机，由反代对外 |
| `DB_PATH` | 否 | `./data/lumen.db` | 目录不存在会自动创建 |
| `WX_APPID` | 否 | — | 小程序 AppID。与 `WX_SECRET` **同时**配或同时留空 |
| `WX_SECRET` | 否 | — | 小程序 AppSecret。都配了才走 `code2session`，否则回落 `local-<hex>` |

三个秘密都**没有默认值**：缺任何一个进程直接拒绝启动，避免「默认口令上线」。
微信凭据只配一半也会**启动失败**：否则外部只能看到「登录永远 502」，看不出原因。

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

133 条用例：

| 文件 | 覆盖 |
|---|---|
| `tests/api.test.ts` | 日志写入落库、幂等补报、会话自动收尾、token 缺失/错误 401、请求体校验 400、表里不含控制列；后台鉴权（匿名/错密码/错用户名/坏 header 全 401） |
| `tests/aggregation.test.ts` | **跨手机聚合**（Android MAC 与 iOS UUID → 同一 `device_key`）、广播名撞车的 `mac_count`、`hardwareId` 优先、`raw` 兜底、会话计数、`last_seen_at` 取 ended/started 较大者；`resolveDeviceKey` 优先级单测；**#50**：MAC 三种书写形态归一成一个键、`hw:` 键与 `devices.hardware_id` 对齐、不带/坏 `hardwareId` 不 400 且退化为广播名 |
| `tests/devices.test.ts` | 设备登记/列表/改名/解除关联/seen；`hardwareId` 归一与 400；幂等登记；**按 user 隔离**（列表与备注名）；超长/空白名 400；HTML 原样入库、看板转义；表结构无灯光列；`/admin/registry` |
| `tests/session.test.ts` | local 回落（`identityKind: "local"`）与幂等；code → openid（fake fetch，参数正确）；`errcode 40029` → 401；系统繁忙/网络失败/HTTP 500/无 openid → 502；`readEnv` 成对校验 |
| `tests/readonly.test.ts` | 看板三页内容；HTML 无表单/输入/按钮；36 条 `POST/PUT/PATCH/DELETE × 9 个路径` 全部 `405`；带凭据的写方法也改不动数据；`/health` 免鉴权 |

---

## 9. 本票没有做、也不该做

不存实时控制通道 · 不做归属 · 不做共享 · 不做角色权限 · 不做业务处理 · 后台只读 ·
不做签名会话令牌 · 不做访问控制 · 不存灯光配置 · 不做配置同步 · 不做迁移框架 · 不做 OTA。
