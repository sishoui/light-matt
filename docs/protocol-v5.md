# lumen 协议规格 v5

**状态**：**实现中（2026-11-06，票 [#155](https://github.com/sishoui/light-matt/issues/155)）**。
本文件取代 `docs/protocol-v4.md`（v4 保留为历史对照，不再维护）。
固件 host 测试与 `docs/protocol-testvectors-v5.json` 的全部向量都对着本文件跑
（`scripts/check-protocol-testvectors-v5.mjs` 校验它与本文一致）。

**唯一真相**：本文件定义字节级契约，`docs/protocol-testvectors-v5.json` 是它的可执行副本。
改协议 = 本文件 + 测试向量 + 两端实现进同一个 commit。

**相关**：[灯效规格](./effects-spec.md)（参数块与层语义，v5 未改）、
[v4 规格](./protocol-v4.md)（历史，其中「分区 / 剧本」两套模型在 v5 已不存在）。

> **v5 不向后兼容，且不是「扩一版」而是换模型。**
> v4 的世界是「一条灯带的 8 个分区 + 全局步时钟 + 4 套剧本」；v5 的世界是
> 「灯组 → 部位 → 步骤 → 两层」+ 三个场景。两者的持久化语义无法共存，
> 因此旧 blob 一律整份拒绝、设备回默认值（§10）。
>
> **v5 删掉的命令**（收到回 `UnknownCommand` 0x02）：`SetSegment` 0x10、
> `ClearSegment` 0x11、`QueryStrip` 0x12、`SetPlayback` 0x13 与整个剧本族
> 0x14–0x1E。这些码**不复用**。
>
> **v4 → v5 变了什么**：
> - 协议版本 `0x04` → **`0x05`**，magic 不变；固件版本 `0x0400` → **`0x0500`**。
> - 新增**布局**命令族（0x20–0x24）与**场景**命令族（0x25–0x29）。
> - 新增报告 0x89–0x8D；删除 0x83–0x86（段报告 / 剧本摘要 / 剧本进度）。
> - State 从 37 字节改为 **32 字节**（不再有分区 / 剧本字段，新增 `active_scene`
>   与每链部位数）。
> - 持久化：state blob 版本 5 → **6**（32 字节）；新增布局键与三个场景键；
>   删除 scripts 键。
> - 渲染入口收敛到 `lumen_scene_compose()`（固件内部接缝，不是线上契约）。

---

## 1. 角色与链路

- **小程序**是 central：写 RX、订阅 TX、读 State。
- **设备**是 peripheral：单连接，不配对，不绑定。
- 所有多字节字段 **小端**，除了 `hw_id` 按 MAC 打印顺序原样给出。
- Kconfig 的引脚表决定物理灯带数，协议**不能改引脚映射**（只读）。

### 1.1 常量

| 常量 | 值 | 说明 |
|---|---|---|
| `MAX_LEDS` | 100 | 单条灯带的灯珠上限 |
| `MAX_STRIPS` | 8 | 灯组（引脚）数 |
| `MAX_PARTS` | 8 | **每条链**的部位数 |
| `MAX_PART_SEGS` | 8 | **每个部位**的灯珠段数 |
| `MAX_STEPS` | 8 | **每个部位**的步骤数 |
| `MAX_SCENES` | 3 | 设备侧场景数 |
| `MAX_LAYERS` | 2 | 每步最多两层（底层 + 叠加层） |
| `NAME_BYTES` | 24 | 部位名 / 场景名的字节上限（UTF-8，不强制字符边界） |
| `STEP_MIN_MS` | 100 | 步骤时长下限 |
| `STEP_MAX_MS` | 60000 | 步骤时长上限 |
| `NO_EFFECT` | `0xFF` | 层类型表示「该层为空」 |
| `LAYER_LEVEL_MAX` | 100 | 层亮度上限（百分比） |
| `MAX_PAYLOAD` | 232 | 单条逻辑帧的载荷上限 |
| `MAX_FRAME` | 240 | `8 + MAX_PAYLOAD` |
| `MAX_CHUNK_DATA` | 179 | 单次 BLE 写的数据上限（§3.2） |
| `LAYER_BYTES` | **9** | 层编码定宽（type + 7 字节参数 + level） |
| `STATE_BYTES` | **32** | v5 State（§7.3） |
| `LAYOUT_PART_BYTES` | **28** | `LayoutPart` 载荷 |
| `SCENE_STEP_BYTES` | **24** | `SceneStep` / `SceneStepReport` 载荷（§7.4） |

`strip_id` / `part_id` / `seg_id` / `step_index` / `scene_id` 均从 **0** 起。

---

## 2. GATT

UUID 与 v2–v4 完全一致（发现逻辑不用改）：

| 特征 | UUID | 属性 |
|---|---|---|
| Service | `6c756d65-6e00-4b1e-9a3c-000000000001` | primary |
| RX | `6c756d65-6e00-4b1e-9a3c-000000000002` | `WRITE_NO_RSP` |
| TX | `6c756d65-6e00-4b1e-9a3c-000000000003` | `NOTIFY` |
| State | `6c756d65-6e00-4b1e-9a3c-000000000004` | `READ` |

广播名仍是 `Lumen-XXXX`（BT MAC 末两字节），但**它不是设备身份**——身份用 `hw_id`。

### 2.1 MTU 协商

不变（v3 起）：设备 `ble_att_set_preferred_mtu(247)`；Android 侧小程序
`wx.setBLEMTU(deviceId, 185)`；两端在 MTU 未知时按 23 处理。
`chunk_capacity = min(mtu - 3, 180)`，单次写的数据上限 = `chunk_capacity - 1`
（1 字节分片头），下限 19。

---

## 3. 帧格式

### 3.1 逻辑帧

```
偏移  宽度  字段
0     1     magic   = 0xA6
1     1     version = 0x05
2     1     command
3     1     seq
4     2     length（载荷字节数，小端，0 ≤ length ≤ 232）
6     N     payload
6+N   2     crc16（小端）
```

整帧长度 = `8 + length`，上限 240。`crc16` 覆盖前 `6 + length` 字节。
CRC16 = CCITT-FALSE（poly `0x1021`、init `0xFFFF`、不反转、无末尾异或），
标准校验值 `"123456789"` → `0x29B1`。

### 3.2 BLE 分片

每个分片带 1 字节 ctrl：`bit7 FIRST`、`bit6 LAST`、`bit5..0` 序号。
容量 = `chunk_capacity - 1`；重组超时 1000ms（自上一个分片起算）。
单分片帧的 ctrl 恒为 `0xC0`（不许裸帧）。

### 3.3 帧示例

`SetPower(on)`、`seq = 1`：

```
A6 05 01 01 01 00 01 <CRC16 小端>
```

CRC16 覆盖 `A6 05 01 01 01 00 01`。

### 3.4 CRC16 参考实现

与 v4 §3.4 相同（`uint16_t crc = 0xFFFF; for each byte: crc ^= b << 8; 8× 移位…`）。

---

## 4. 版本

- 设备只接受 `version = 0x05`。其它版本回 `UnsupportedVersion` 0x07（含 v4 的 0x04）。
- 设备 `DeviceInfoReport` 的 `firmware_version` 报 `0x0500`（线上小端 `00 05`）。
  主版本 = `v >> 8`，次版本 = `v & 0xFF`。

---

## 5. 结果码

| 码 | 名称 | 说明 |
|---|---|---|
| `0x00` | OK | |
| `0x01` | InvalidParam | 取值越界 / 结构非法 / 区间重叠 |
| `0x02` | UnknownCommand | 未知命令或 v4 已退役命令 |
| `0x03` | BadChecksum | |
| `0x04` | BadLength | 载荷长度不符 |
| `0x05` | Busy | 灯珠数重建中 |
| `0x06` | StorageFailed | 落盘失败（含场景编码后超过 12 KB） |
| `0x07` | UnsupportedVersion | |
| `0x08` | BadMagic | |
| `0x09` | InternalError | |
| `0x0A` | *(retired)* | v4 的 `ScriptTooLarge`，v5 不再发送；编号不复用 |

校验顺序固定：`command`（0x02）→ 载荷长度（0x04）→ 载荷取值（0x01）。

---

## 6. 命令（小程序 → 设备）

| 码 | 名称 | 载荷 | 作用 |
|---|---|---|---|
| `0x01` | `SetPower` | 1 | 整机开关 `0/1` |
| `0x02` | `SetBrightness` | 1 | 整机亮度 0-255（按构建期上限钳位） |
| `0x05` | `QueryState` | 0 | ACK 后补一条 `StateReport` |
| `0x06` | `SetLedCount` | 3 | `strip_id, count_lo, count_hi`（1-100） |
| `0x07` | `SelfTest` | 0 | 红→绿→蓝→白，各 500ms |
| `0x1B` | `SetStripPower` | 2 | `strip_id, on`（整条链的开关） |
| `0x1C` | `QueryStripConfig` | 0 | ACK 后补 `StripConfigReport` |
| `0x1D` | `QueryDeviceInfo` | 0 | ACK 后补 `DeviceInfoReport` |
| `0x20` | `LayoutWrite` | 2 | `strip_id, part_count`：声明该链的部位数并清空其部位 |
| `0x21` | `LayoutPart` | 28 | `strip_id, part_id, name_len, name[24], seg_count` |
| `0x22` | `LayoutSeg` | 5 | `strip_id, part_id, seg_id, start, end` |
| `0x23` | `LayoutCommit` | 0 | 校验整份布局并**立即落盘** |
| `0x24` | `QueryLayout` | 1 | `strip_id`：ACK 后逐部位 `LayoutReport` + 一条 `LayoutListEnd` |
| `0x25` | `ScenePart` | 6 | `scene_id, strip_id, part_id, step_count, loop, on` |
| `0x26` | `SceneStep` | 24 | `scene_id, strip_id, part_id, step_index, duration_lo, duration_hi, layer0[9], layer1[9]` |
| `0x27` | `SceneName` | 26 | `scene_id, name_len, name[24]` |
| `0x28` | `ActivateScene` | 1 | `scene_id`：硬切 + 全部部位从第 1 步重跳 |
| `0x29` | `QueryScene` | 1 | `scene_id`：ACK 后逐部位 `ScenePartReport`、逐步骤 `SceneStepReport`、一条 `SceneListEnd` |

**已退役（一律 `UnknownCommand` 0x02）**：`0x03` `SetColor`、`0x04` `SetAll`
（v2 退役）、`0x10` `SetSegment`、`0x11` `ClearSegment`、`0x12` `QueryStrip`、
`0x13` `SetPlayback`、`0x14`–`0x1E` 旧剧本族。协议向量里保留这些帧作为
「退役命令必须回 0x02」的可执行证据。

### 6.1 布局写入的语义

布局是**全局一份**（三个场景共用），生命周期与场景分开。

1. `LayoutWrite(strip, n)`：把该链的部位数设为 `n`（0–8），并清空该链所有部位的
   名字与段。`n = 0` 表示这条链没有部位（未覆盖的灯珠恒黑）。
2. `LayoutPart(strip, part, name_len, name, seg_count)`：写名字与段数。
   `name_len ≤ 24`；`name` 不足 24 字节的部分**必须补 0**（解码端只信任 `name_len`）。
3. `LayoutSeg(strip, part, seg, start, end)`：写一段闭区间。设备校验
   `start ≤ end`、`end < led_count`、`seg < seg_count`、且**与同链其它所有部位
   的所有段互斥**（S3：一颗灯珠只属一个部位）。压到别的部位 → 整个命令
   `InvalidParam`，旧布局保持不变。
4. `LayoutCommit`：整份校验（每链部位数、每部位段数、段互斥）后**立即**落盘。
   失败回 `InvalidParam` / `StorageFailed`，RAM 里的布局**保留**（不半套生效）。

布局写入是「结构改动」，会打断该链时钟（U10）：设备在 `LayoutCommit` 成功后把
该链所有部位的播放头重置到此刻。这是唯一允许打断时钟的操作。

### 6.2 场景写入的语义

- `ScenePart`：写一个部位的时间轴头（步数 / 循环 / 开关）。这两个字节里
  `loop` 取 §7.5 的三值，`on ∈ {0,1}`。
- `SceneStep`：**单步增量**。直接写 RAM 表并标脏，2 秒防抖落盘（E4/E5），
  没有 staging。步号 ≥ `step_count` 时 `InvalidParam`。
  两层的混合方式**不在线上**：`layer1` 为空 → 覆盖；非空 → 按亮度叠加（E6）。
- `SceneName`：场景名（24 B）。
- `ActivateScene`：硬切，并把**所有部位**的播放头重置到此刻（T3/C4）。
- `QueryScene`：读回。三段（部位头 / 每步 / 收尾）与下发同 seq，顺序执行。

`ScenePart` 只改时间轴头，不改布局里该部位占哪几颗灯珠——布局与场景是两张表。

---

## 7. 数据布局

### 7.1 层（`layer0` / `layer1`，9 字节）

与 v4 §7.1 **完全一致**：`type(1) | param[7] | level(1)`。

- `type`：`0x00` 静态 / `0x01` 呼吸 / `0x02` 彩虹 / `0x03` 流光 / `0x04` 爆闪 /
  `0x05` 心跳 / `0x06` 熄灭 / `0x07` 随机闪烁 / `0xFF` 空层。
- 参数语义见 `effects-spec.md` §2；`level` 0–100 是本层母亮度。
- `layer0` 必须非空；`layer1` 可以为空。
- 空层的 8 字节参数与 `level` 必须全 0。

校验规则与 v4 同一份（周期下限、flags 保留位、静态层保留字节、呼吸 p5 ≤ 100）。

### 7.2 布局（`LayoutReport` 0x89，44 字节）

```
0      strip_id
1      part_id
2      name_len（0-24）
3..26  name[24]（NUL 填充）
27     seg_count（0-8）
28..43 8 × (start, end)，未用的段为 0/0
```

`LayoutListEnd` 0x8A（2 字节）：`strip_id, part_mask`（bit i = 部位 i 有段）。

> 只有 `seg_count > 0` 的部位才会被 `QueryLayout` 报出来；`part_mask` 与报告
> 条数一致。名字为空串的部位仍然可报（`name_len = 0`）。

### 7.3 State（32 字节）

```
偏移  字段
0     power（0/1）
1     brightness（已按 max_brightness 钳位的生效值）
2     max_brightness（构建期上限）
3     strip_count（1-8）
4     strip_power_mask（bit i = 第 i 条链的开关）
5     active_scene（0-2）
6     layout_valid（0/1：设备上是否有已提交的布局）
7     reserved = 0
8..23  led_count[8]（u16 小端，每条链自己的灯珠数；未用的槽位为 0）
24..31 part_count[8]（每条链的部位数；未用的槽位为 0）
```

State **不含**部位开关（属于场景）、不含播放位置、不含颜色摘要。
App 要显示部位明细用 `QueryLayout` / `QueryScene`。

### 7.4 设备 → 小程序帧

| 码 | 名称 | 载荷 | 说明 |
|---|---|---|---|
| `0x80` | `ACK` | 2 | `[原命令字, 结果码]`，seq 回显 |
| `0x81` | `Event` | 2 | `[event_code, detail]`，seq 恒 0 |
| `0x82` | `StateReport` | 32 | §7.3，seq 回显 `QueryState` |
| `0x87` | `StripConfigReport` | 24 | 8 × `[strip_id, gpio, flags]` |
| `0x88` | `DeviceInfoReport` | 15 | 见下 |
| `0x89` | `LayoutReport` | 44 | §7.2 |
| `0x8A` | `LayoutListEnd` | 2 | `[strip_id, part_mask]` |
| `0x8B` | `ScenePartReport` | 6 | `[scene_id, strip_id, part_id, step_count, loop, on]` |
| `0x8C` | `SceneStepReport` | 24 | 与 `SceneStep` **同构**（只是方向相反） |
| `0x8D` | `SceneListEnd` | 26 | `[scene_id, name_len, name[24]]` |

`DeviceInfoReport` 0x88（15 字节）：

```
0..1   firmware_version（u16 小端，v5 = 0x0500）
2..7   hw_id（6 字节 BT MAC，打印顺序）
8      max_leds（100）
9      max_strips（8）
10     max_parts（8）        —— 每条链
11     max_part_segs（8）    —— 每个部位
12     max_steps（8）        —— 每个部位
13     max_scenes（3）
14     caps：bit0 = 支持两层叠加；bit1 = fade（v5 仍为 0）
```

Event 0x81 的 `event_code`：`0x01` 存储失败（`detail` = 触发写入的命令字）；
`0x02` 预留（v4 的剧本提交失败，v5 不再发送）。

### 7.5 循环字段（`loop`）

| 值 | 语义 |
|---|---|
| `0` | 不循环：走完停在最后一帧（T4） |
| `1` | 全部循环：走完回到第 1 步 |
| `2` | 最后一步循环：前 N-1 步各播一次，之后原地重播末步 |

> 与 v4 的三值**数值相同**，但宿主从「剧本 / 方案级」变成了**每个部位一份**（T2）。
> `> 2` 一律 `InvalidParam`。

---

## 8. seq 语义

- 每条小程序 → 设备的命令带自己的 `seq`（0–255 循环）。
- ACK 的 `seq` 回显请求；多帧报告（`QueryLayout` / `QueryScene`）**全部用同一个
  `seq`**，以收尾帧（`LayoutListEnd` / `SceneListEnd`）判定结束。
- 设备主动帧（`Event`）的 `seq` 恒 `0x00`。
- 小程序一次只发一帧、等 ACK 再发下一帧（D12）；`SceneStep` 的串行化由会话层
  保证，设备侧不排队（超过一帧就由 App 自己等）。

---

## 9. 行为语义

### 9.1 重连重建 UI 的权威路径

1. 读 State 特征值（32 字节）→ 整机开关 / 亮度 / 链数 / 每链灯珠数与部位数 /
   当前场景。
2. `QueryStripConfig` → 引脚表（只读）。
3. 对每条 `part_count > 0` 的链 `QueryLayout(strip)` → 部位名与段。
4. 对当前场景 `QueryScene(active_scene)` → 三个场景里**只读当前那个**；
   切换场景后再读目标场景。
5. `QueryDeviceInfo` → 能力位与上限（不要在小程序里硬编码 8/8/8/3）。

### 9.2 部位模型

- 部位 = 若干**闭区间灯珠段**，同部位的多段共享全部参数（S5）。
- 一颗灯珠**只属一个部位**（S3）；未被任何部位覆盖的灯珠**恒黑**。
- 部位之间不重叠是**设备侧**权威校验（`LayoutSeg` 回 `InvalidParam`），
  App 侧预检只是提前提示。
- 相位模式（S6）是**布局**属性：`连续` = 多段按升序拼成一条逻辑灯带取样；
  `各自起点` = 每段从自己的 0 开始。`lumen_layout_logical_index` 实现两种映射，
  `lumen_scene_compose` 接收相位模式作为参数。
  **v5.0 固定为「连续」**：线上没有任何命令能改它，§10.3 的每链记录也只有
  `led_count | part_count | reserved(6)` 六个保留字节，而保留字节按契约必须为 0
  ——不能借来存相位。等有线上位的票再把其中一个保留字节升格并改 blob 版本。

### 9.3 合成顺序（`lumen_scene_compose`）

按链批量算（不按部位逐个遍历）：

1. 该链的像素缓冲先整块清零 → **灰缝恒黑**。
2. 逐部位：取「当前步的两层」构造临时段（`start = 0, end = n-1`，
   `t0_ms = now - 步内已用时间`），按相位模式求逻辑下标，调 `lumen_effect_pixel`。
3. 把逻辑像素按段的物理区间**散回**物理位置。
4. 全局亮度与 gamma **不在**这个函数里做——渲染层对整帧做**一次**
   （与 v4 §9.3 同一条顺序：先乘亮度、再 gamma）。

第 2 步的 `blend` 由「有无叠加层」决定：`layer1` 为空 → 覆盖；非空 →
`BLEND_LUMA`（按亮度叠加，E6）。线上**不传** blend 字节。

### 9.4 相位与播放头

- 每个部位一个播放头，起点是**场景激活时刻**或**部位新建时刻**（T3/T7）。
- 播放头不存相位变量，只存 `origin_ms`；步号与步内时间由
  `lumen_part_clock_advance(clock, part, now_ms)` 从 `(now - origin)` **一次性算出**，
  不做累加（防长时间漂移）。
- 循环按部位各走各的（T2）。`loop = 0` 走完停在最后一帧（T4）。
- 部位开关只灭灯、**不停时钟**（T8/T9）：关掉再打开，画面接着往下走。

### 9.5 每条链独立开关

`SetStripPower(strip, on)` 只改 `State.strip_power_mask` 的一位。实际出光 =
`power && 该位`；自检期间忽略它（全部点亮）。门控在渲染层（`strip_power.c`），
部位开关另有一层门控（在 `lumen_scene_compose` 里，按场景的部位 `on` 位）。

### 9.6 自检

红 → 绿 → 蓝 → 白，各 500ms，2 秒结束；期间覆盖整条链（忽略部位与布局）。
任何「改变状态」的命令都会取消自检（`SceneStep` / `LayoutSeg` 等也算）。

---

## 10. 持久化

### 10.1 分区表

不变（v3 起）：

```
# Name,   Type, SubType, Offset,   Size,     Flags
nvs,      data, nvs,     0x9000,   0x10000,
```

64 KB NVS，**不扩**。

### 10.2 State blob v6（32 字节）

```
0..3   'L' 'M' 'E' 'N'
4..5   version = 6（u16 小端）
6      power
7      brightness
8      strip_count
9      strip_power_mask
10     active_scene
11..15 reserved 0
16..31 led_count[8]（u16 小端）
```

解码校验：长度精确 32、magic、version == 6、`power ∈ {0,1}`、
`brightness` 任意、`strip_count ∈ [1,8]`、`active_scene ∈ [0,2]`、
已配置链的 `led_count ∈ [1,100]`。任一失败**整份拒绝**，调用方保留默认值。

### 10.3 Layout blob `LML1`（2760 字节，硬上限 4096）

```
0..3   'L' 'M' 'L' '1'
4      version = 1
5      strip_count
6..7   reserved 0
8..71  每链 8 字节：led_count(1) | part_count(1) | reserved(6)
72..   每个部位 42 字节（8 链 × 8 部位，固定顺序）：
         name_len(1) | name[24] | seg_count(1) | segs[8] × (start(1) | end(1))
```

总长 `8 + 64 + 64 × 42 = 2760`。解码校验每段的 `start ≤ end`、
`end < 该链 led_count`、段互斥；坏 blob 整份拒绝。

> **分帧下发时的「未写」段**：`LayoutPart` 先声明 `seg_count`，`LayoutSeg`
> 随后逐条到达。声明了但还没写的槽位**不能**当成 0-0（那会与合法的 1-2 冲突），
> 因此 RAM 里用 `0xFF/0xFF` 标记未写，只有 `LayoutCommit` 才要求 `seg_count`
> 条都已写齐，否则整份 `InvalidParam`。落盘时不存在未写段。

### 10.4 Scene blob `LMS5`（最大 10472 字节，硬上限 12288）

```
0..3   'L' 'M' 'S' '5'
4      version = 1
5      name_len
6..29  name[24]
30..31 reserved 0
32..39 每链 part_count(1)
40..   每链每部位：step_count(1) | loop(1) | on(1) | steps[step_count]
        步：duration_ms(u16 小端) | layer0 | layer1
        层编码：空 1 B（0xFF）| 静态/熄灭 5 B（type, hue2, sat, level）
                | 带动画 9 B（type, hue2, sat, period2, p5, flags, level）
```

最坏形态（8 链 × 8 部位 × 8 步 × 两层带动画）：
`40 + 64×3 + 512×20 = 10472` ≤ **12288**。编码后超过上限 → `StorageFailed`，
RAM 保留，不半套落盘。

### 10.5 上限与失败语义

| 键 | 上限 | 落盘时机 |
|---|---|---|
| `state` | 32 B | 变更后 **500 ms** 防抖 |
| `layout` | 4096 B | `LayoutCommit` 后**立即**（0 ms 防抖） |
| `scene0/1/2` | 12288 B | `SceneStep` / `ScenePart` / `SceneName` 后 **2 s** 防抖（E4） |

NVS 写失败异步上报 `Event 0x81`（`0x01`，detail = 触发命令字）。ACK 早已发出。

### 10.6 默认值

上电无有效 blob 时：`power = 0`、`brightness = 128`、`strip_power_mask = 0xFF`、
`strip_count = 1`、`led_count[0] = Kconfig 默认`、`active_scene = 0`、
`layout_valid = 0`、布局空、三个场景空（名字为空串、0 步）。
LED 全黑——「什么都没要求的时候设备状态不被改动」（U9）。

---

## 11. 渲染与 RAM

实测值（`_Static_assert` 钉住，`firmware/test/test_skeleton.c` 的
`test_layout_sizes` / `test_scene_sizes` 在运行时再核一次）：

| 量 | 值 |
|---|---|
| `lumen_part_layout_t` | 42 B |
| `lumen_layout_store_t` | **2696 B** = 8 + 64 × 42 |
| `lumen_part_scene_t` | 164 B = 3 + 填充 + 8 × 20 |
| `lumen_scene_t` | **10530 B** = 25 + 8 + 64 × 164 |
| `lumen_scene_set_t`（三个场景） | **31590 B** |
| 每部位播放头 | 8 B × 64 = 512 B |
| 场景 blob 最坏编码 | **10472 B**（预算 12288） |

v5 删掉 v4 的剧本表（约 70 KB）与 16 KB 剧本 blob 缓冲，新增约 34 KB 的状态与
场景，**净省约 35 KB**。播放头是 `origin_ms + started`，不做累加。

> 初稿写的 2568 / 10400 / 31200 是设计期估算：布局少算了每链的 `part_count`
> 字节，场景少算了每部位的 3 字节头与 2 字节对齐填充。实现按实测值落地，
> 结论（净省约 35 KB、最坏 10472 ≤ 12288）不变。
> `test_scene_blob_max_size` 在 host 上真写一遍 8 链 × 8 部位 × 8 步 × 两层，
> 断言 `lumen_scene_blob_size() == 10472` 并往返解码。

---

## 12. 测试向量

- `docs/protocol-testvectors-v5.json` —— 可执行副本，两端共用。
  生成器 `scripts/gen-protocol-testvectors-v5.mjs`，独立校验器
  `scripts/check-protocol-testvectors-v5.mjs`（只读 JSON，不信生成器）。
- 用例字段与 v4 相同（`name / direction / command / seq / payload_hex /
  frame_hex / chunks_hex / frame_valid / result_code`）。
- **v4 的退役命令用例也保留在 v5 文件里**（`retired_*` 前缀 + 原名两种），
  `result_code = 0x02`：这是「固件收到 v4 命令必须回未知命令」的可执行证据。
- 固件 host 测试（`firmware/test/test_skeleton.c`）与小程序 `tests/codec.test.ts`
  **消费同一份 JSON**。

---

## 13. 变更规则

改任何字节布局 = 本文件 + `docs/protocol-testvectors-v5.json`（重跑生成器）+
两端实现 + `scripts/check-protocol-testvectors-v5.mjs` 全绿，同一个 commit。
