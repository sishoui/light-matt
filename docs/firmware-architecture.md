# 固件架构：三层边界与并发模型

**状态**：实现于 `feat/06-gatt-skeleton`（issue #6）
**相关**：[协议规格](./protocol.md)、[实现规格 §7](./spec.md)、[wayfinder 票 05](./wayfinding/tickets/05-firmware-ble-skeleton.md)、[BLE/固件事实研究](./wayfinding/research/ble-and-firmware-facts.md)

本文件记录固件骨架的边界决策。协议字节级契约以 `docs/protocol.md` 为唯一真相，这里不重复。

---

## 1. 三层结构与依赖方向

```
app_main.c
   │  初始化顺序：NVS → state_store → led_engine → ble_link
   ▼
ble_link  ──调用──▶  led_engine  ──调用──▶  state_store
   │                    │
   │                    └──调用──▶  gamma / state / protocol（纯函数）
   │
   └── GATT / 广播 / 帧收发
```

| 模块 | 职责 | 公开接口（`firmware/main/`） |
|---|---|---|
| `ble_link` | NimBLE GATT server、广播、RX 解帧信封与日志、TX notify | `lumen_ble_link_init` / `lumen_ble_link_is_connected` / `lumen_ble_link_notify` |
| `led_engine` | 共享状态的唯一所有者、latest-wins 邮箱、渲染任务、灯带句柄 | `lumen_led_engine_init` / `lumen_led_engine_commit` / `lumen_led_engine_state_bytes` / `lumen_led_engine_snapshot` / `lumen_led_engine_max_brightness` |
| `state_store` | NVS 加载与 500ms debounce 保存 | `lumen_state_store_init` / `lumen_state_store_load` / `lumen_state_store_request_save` |
| `protocol` | 帧信封解码、checksum、ACK/Event/StateReport 编码（纯函数） | 见 `protocol.h` |
| `state` | 状态默认值、亮度钳位、8 字节 State 编码（纯函数） | 见 `state.h` |
| `gamma` | gamma 表 + 亮度乘算（纯函数） | `lumen_gamma_init` / `lumen_gamma_apply` |

**依赖单向**：`ble_link → led_engine → state_store`。反向调用只有一种形式——`state_store` 通过编译期依赖拿到 `lumen_state_t`，但它从不调用 `led_engine` 或 `ble_link`。`led_engine` 不引用任何 NimBLE 头文件，因此渲染路径不依赖 BLE。

`app_main.c` 只做初始化编排，不含业务逻辑。

### 初始化顺序

```
nvs_flash_init()                // 失败时 erase 后重试
→ lumen_state_store_init()      // 起存储任务，注册 NVS namespace
→ lumen_led_engine_init()       // 恢复状态 → 建 led_strip → 起渲染任务 → 首次渲染
→ lumen_ble_link_init()         // nimble_port_init → ble_hs_cfg → GAP/GATT init
                                // → ble_gatts_count_cfg/add_svcs → 设备名
                                // → nimble_port_freertos_init
→ sync_cb 里 ble_gap_adv_start()
```

NVS 必须在 `led_engine_init` 之前初始化，因为恢复状态发生在引擎初始化内部。NimBLE 的 `nimble_port_init()` 内部也会调用 `nvs_flash_init()`，该调用幂等。

---

## 2. 任务模型（ESP32-C3 单核）

| 任务 | 创建者 | 优先级 | 栈 | 说明 |
|---|---|---|---|---|
| NimBLE 主机任务 `nimble_host` | `nimble_port_freertos_init` | `configMAX_PRIORITIES - 4` = **21**（IDF 硬编码） | `CONFIG_BT_NIMBLE_HOST_TASK_STACK_SIZE` = **4096** | 跑 `nimble_port_run()`，所有 GATT/GAP 回调、RX 写回调都在这个上下文 |
| 渲染任务 `lumen_render` | `led_engine` | `CONFIG_LUMEN_RENDER_TASK_PRIORITY` = **4** | `CONFIG_LUMEN_RENDER_TASK_STACK_SIZE` = **4096** | 等二值信号量；醒来取最新快照、gamma、`set_pixel + refresh` |
| 存储任务 `lumen_store` | `state_store` | `CONFIG_LUMEN_STORE_TASK_PRIORITY` = **2** | `CONFIG_LUMEN_STORE_TASK_STACK_SIZE` = **3072** | 等信号量 + 500ms debounce，然后写 NVS |
| `app_main` | IDF 启动流程 | 1 | IDF 默认 | 初始化完即返回 |
| IDLE | FreeRTOS | 0 | — | 空闲任务；渲染任务阻塞在信号量上时不空转 |

### 优先级取值理由

- **NimBLE 主机任务最高（21）。** 它承载射频事件、连接事件、GATT 回调。C3 只有一个核，任何比它高的任务长时间运行都会推迟连接事件处理，直接表现为断连或写入超时。它的优先级由 IDF 硬编码，固件不覆盖。
- **渲染任务（4）低于主机任务。** `led_strip_refresh()` 是阻塞调用（30 灯约 1.2 ms 数据 + 280 µs reset，见 `led_engine.c`），期间 RMT 编码在 ISR 里跑。如果渲染任务高于主机任务，刷新期间会压住协议栈；取 4 让主机任务随时抢占，保证 BLE 事件优先。同时 4 高于 IDLE(0) 与 `app_main`(1)，状态变化后能及时拿到 CPU，不会被饿死。
- **存储任务最低（2）。** NVS 写不是实时路径，延迟 500ms 本来就是设计的一部分；flash 写期间会短暂关 cache，优先级必须低于渲染与协议栈。取 2 仍高于 IDLE，避免 debounce 到期后长期不执行。

### 栈大小理由

- 主机任务 4096：IDF 默认值。GATT 回调里只有本地缓冲与一次 `led_engine` 快照拷贝，不引入深调用链。
- 渲染任务 4096：调用 `led_strip_set_pixel` 循环与 `led_strip_refresh` → RMT 驱动 → `rmt_transmit`/`rmt_tx_wait_all_done`。4 KB 覆盖驱动调用深度并留有日志余量。
- 存储任务 3072：`nvs_open` / `nvs_set_blob` / `nvs_commit` 的调用深度，加上 13 字节 blob，3 KB 足够。

---

## 3. BLE 回调允许 / 禁止做什么

RX 回调（`rx_access`）运行在 NimBLE 主机任务上。它**只**做以下事情：

允许：
1. 把 `ctxt->om`（mbuf）拷贝到栈上的定长缓冲（`LUMEN_RX_BUF_SIZE = 64`，超出直接丢弃并记一行警告）。
2. 调用 `lumen_protocol_decode()` 解帧信封（magic / version / length / checksum）。
3. 打一行短日志：`RX 收到 N 字节`、命令字、seq、结果码。
4. 在 State read 里拷贝一次 8 字节 RAM 快照（`lumen_led_engine_state_bytes`，持锁时间只够 memcpy）。

禁止：
1. **刷灯。** 不调用任何 `led_strip_*`。灯带句柄只有渲染任务持有。
2. **写 NVS / flash。** 不调用 `nvs_*`。持久化只通过 `state_store` 的 debounce 任务。
3. **大段日志 / hex dump 长帧。** 日志只允许一行级别；本票只在帧 ≤ 20 字节时打一次 hex。
4. **阻塞等待。** 不 `vTaskDelay`、不等渲染完成、不持锁做 IO。
5. **改变共享状态。** 本票 RX 回调不提交新状态；命令分发在 #8 落地后也只允许 `lumen_led_engine_commit()` 这种 O(1) 的邮箱操作。

对应地，`led_engine` 的锁只保护内存结构：
- `lumen_led_engine_state_bytes` / `snapshot` / `commit` 持锁时间都是常数级；
- 渲染任务在**释放锁之后**才调用 `set_pixel + refresh`，所以 State read 不会被刷新阻塞。

---

## 4. latest-wins 邮箱

```
BLE 回调 / 命令层                     渲染任务
     │                                   │
     │ commit(next)                      │ xSemaphoreTake(render_signal, ∞)
     ├─ lock                              │
     ├─ s_state = next        权威状态    ├─ lock
     ├─ s_mailbox = next      待渲染快照  ├─ dirty ? snapshot = mailbox : state
     ├─ s_mailbox_dirty = true            ├─ dirty = false
     ├─ unlock                            ├─ unlock
     ├─ give(render_signal)               └─ render_snapshot(snapshot)
     └─ request_save(next)                     （不持锁，阻塞 refresh）
```

- **互斥锁** `s_state_lock`：保护 `s_state`、`s_mailbox`、`s_mailbox_dirty`。
- **dirty 标志**：标记邮箱里有未渲染的快照。渲染任务取走时清零。
- **二值信号量** `s_render_signal`：只保留一个 pending 唤醒。连续 N 次 `commit` 只会让渲染任务醒一次——它醒来时 `s_mailbox` 已被最后一次提交覆盖，因此**永远不会排队旧帧**。
- **相同快照跳过**：渲染任务记住上次写进灯带的 `(r, g, b, brightness, count)`；状态没造成像素变化时不调用 `set_pixel` / `refresh`。
- **空闲不空转**：渲染任务唯一阻塞点是 `xSemaphoreTake(s_render_signal, portMAX_DELAY)`，没有固定帧率、没有轮询、没有 `vTaskDelay` 循环。

初始化时直接给一次信号量，按默认（或 NVS 恢复的）状态渲染一次，用于验证灯带句柄可用。
#8 之后，`SetPower` 命令路径会调用 `commit`（见 §9）。

---

## 5. 单连接与旧连接释放

- `CONFIG_BT_NIMBLE_MAX_CONNECTIONS=1`：主机层与 controller 都只维持一个连接。
- 广播在 `sync_cb` 里启动；`BLE_GAP_EVENT_CONNECT` 成功时记录 `s_conn_handle`。
- 收到 `BLE_GAP_EVENT_DISCONNECT`：把 `s_conn_handle` 置回 `BLE_HS_CONN_HANDLE_NONE`，立即重新 `ble_gap_adv_start()`。这是「旧连接释放后能重新连上」的实现。
- `BLE_GAP_EVENT_CONNECT` 里若发现 `s_conn_handle` 仍是有效值（防御性分支，正常不会发生），对旧句柄调用 `ble_gap_terminate(..., BLE_ERR_REM_USER_CONN_TERM)`；旧连接的 DISCONNECT 事件会走正常清理路径。
- `BLE_GAP_EVENT_ADV_COMPLETE` 也会重新广播，避免广播因为超时或 controller 原因静默停止。
- 连接参数请求：`itvl_min = 15 ms`、`itvl_max = 30 ms`、`latency = 0`、`supervision_timeout = 4 s`。拖动跟手优先，不追求省电。

TX notify 的所有权：`lumen_ble_link_notify()` 创建 mbuf 后交给 `ble_gatts_notify_custom()`；该函数无论成功失败都会释放 mbuf，调用方不能再 free。

---

## 6. 为什么用同步 `refresh()` 而不是 `refresh_async()`

- `led_strip_refresh()` 阻塞到 RMT 传输完成（`rmt_tx_wait_all_done`）。渲染任务是灯带句柄的唯一所有者，不存在并发刷新。
- `refresh_async()` 没有双缓冲：在 `refresh_async_done()` 之前不得改像素。要用它就必须自建双缓冲和完成回调，复杂度换来的收益只有「渲染任务在刷新期间能做别的事」——而它本来就没有别的活。
- 同步刷新期间主机任务（优先级 21）可以抢占渲染任务（4），BLE 事件不受影响。
- RMT × BLE 的实测调优（`mem_block_symbols`、是否改 async + 双缓冲）属于 #7 的判定范围，本票不预支结论。

---

## 7. 本票范围与后续票

本票只钉骨架：

- ✅ GATT Service / RX / TX / State，广播名 `Lumen-XXXX`，广播包含 128-bit Service UUID，单连接，断开重广播，15-30ms 连接参数。
- ✅ RX 解信封并打印帧日志（#6 只解信封；#8 起执行命令并回 ACK）。
- ✅ 共享状态 + latest-wins + 渲染任务 + gamma + 亮度乘算。
- ✅ NVS 加载与 500ms debounce 保存骨架。
- ✅ 命令分发、payload 校验、ACK 发送（#8；QueryState 的解码与 StateReport 留给 #13）。
- ✅ SetPower 语义与 state 写入（#8）。
- ✅ SetBrightness 语义与按 `max_brightness` 钳位（#9）。
- ⏳ `SetLedCount` 句柄重建与异步 ACK → #12。
- ⏳ 自检 → #13。
- ⏳ RMT × BLE 共存调优 → #7。

`protocol.c` 只保留信封与设备→小程序编码；命令表与载荷语义在 `command.c`（#8 起）。

---

## 8. 测试

### Host 单元测试（不连硬件）

```cmd
firmware\test\run-tests.cmd
```

或手动：

```cmd
gcc -std=c11 -Wall -Wextra -Werror -Ifirmware\main ^
    firmware\test\test_skeleton.c firmware\main\protocol.c ^
    firmware\main\command.c firmware\main\state.c firmware\main\gamma.c ^
    -lm -o lumen_host_tests.exe
lumen_host_tests.exe docs\protocol-testvectors.json
```

覆盖：`docs/protocol-testvectors.json` 全部 37 条用例（app 方向编码/解码与错误码、device 方向解码与 ACK / Event / StateReport 逐字节复现）、SetPower reducer 边界、未实现命令的 `0x02`、全部结果码的 ACK 编码与缓冲不足、State 默认值与 8 字节布局、gamma + 亮度乘算单调性。

### 固件构建

```cmd
scripts\build-firmware.cmd
```

只构建，不烧录。真机验收项（nRF Connect 看服务、写 RX 日志、单连接释放）见 issue #6。

---

## 9. #8 落地后的增量（walking skeleton）

issue #8 把「设开关」一条命令纵向打通，同时钉下后续票复用的命令层形状。

### 9.1 新增 `command` 模块（纯 reducer）

| 接口 | 说明 |
|---|---|
| `lumen_command_dispatch(frame, current, outcome)` | 旧状态 + 命令 → 新状态 + 结果码；不依赖 NimBLE / FreeRTOS / NVS，可在 host 上单测 |
| `lumen_command_is_known(command)` | 协议 §6 的 0x01-0x07 |
| `lumen_command_payload_len(command)` | 命令表里的载荷长度 |

`lumen_command_outcome_t` 带 `result_code` / `state_changed` / `next`。调用方只在
`state_changed` 为真时调用 `lumen_led_engine_commit()`；错误路径一律不改状态。

### 9.2 RX 路径（`ble_link.c`）

```
rx_access → handle_frame
  解码（magic → version → length → checksum）
  → lumen_led_engine_snapshot（短锁拷贝）
  → lumen_command_dispatch（command → payload 长度 → payload 取值）
  → state_changed ? lumen_led_engine_commit（写 RAM + 邮箱 + 渲染信号 + debounce 持久化）
  → send_ack（协议 §10.1：写入 RAM 后立刻回）
```

- 命令语义与 ACK 都在 NimBLE 主机任务的回调里完成；渲染仍由 `lumen_render` 异步执行，
  回调里不碰 `led_strip_*`、不写 NVS。
- 整帧 > 20 字节：先按 header 判 magic / version，再回 `0x04`；超过 64 字节本地缓冲的帧
  同样走 `reject_oversized`，不会截断执行。
- 不足 6 字节：静默丢弃（读不到可靠 seq）。
- ACK 载荷 `[原命令字, 结果码]`，seq 回显；串口日志打印 `cmd / seq / result`，与小程序日志按 seq 对齐。

### 9.3 本票的命令覆盖

| 命令 | 本票行为 |
|---|---|
| `0x01` SetPower | 完整实现：0/1 合法并提交；其他值 → `0x01`；载荷非 1 字节 → `0x04` |
| `0x02` SetBrightness | **#9 已实现**：0-255 全合法，按 `max_brightness` 钳位后提交，回 `0x00` |
| `0x03` SetColor | **#10 已实现**：3 字节 RGB 全合法，只写颜色，回 `0x00` |
| `0x04` SetAll | **#10 已实现**：5 字段原子生效；power 非 0/1 → `0x01` 且整帧不写；亮度按 §11.4 钳位 |
| `0x05`-`0x07` | 载荷长度先按命令表校验（错 → `0x04`），合法长度统一回 `0x02`（明确未实现） |
| `0x08`-`0xFF`（含小程序写 0x80） | `0x02` |

**仍是暂时的协议偏差**：协议 §6 已定义 0x05-0x07 的语义，后续票（#12 灯珠数量、
#13 自检/日志）会把它们替换成真实实现；替换前设备会对这些命令回 `0x02`，
小程序据此显示「设备不支持该命令」。

### 9.4 Host 测试

`firmware/test/test_skeleton.c` 直接读取 `docs/protocol-testvectors.json`（两端共用），
对全部 37 条用例断言：

- `app_to_device` 有效帧：解码字段 + payload 与向量一致，并对 SetPower 断言 reducer 结果码；
- `app_to_device` 无效帧：失败原因 / 结果码与向量一致（短帧静默丢弃）；
- `device_to_app` 帧：解码后能用 ACK / Event / StateReport 编码器逐字节复现 `frame_hex`。

另加 reducer 边界（重复设置同一 power 不重复 commit、非法取值、长度不符、0x08/0x7F/0x80/0xFF）
与全部结果码的 ACK 编码断言。

---

## 10. #9 落地后的增量（亮度端到端）

issue #9 把「设亮度」纵向打通：滑块 → 20Hz 节流 → BLE 写入 → 固件解码 →
状态更新 → gamma + 亮度乘算 → 灯带跟随。

### 10.1 命令层（`command.c` / `command.h`）

`lumen_command_dispatch()` 增加一个参数 `max_brightness`，调用方传
`lumen_led_engine_max_brightness()`（构造期常量；host 测试直接传测试值）：

```c
void lumen_command_dispatch(const lumen_frame_t *frame, const lumen_state_t *current,
                            uint8_t max_brightness, lumen_command_outcome_t *outcome);
```

SetBrightness 0x02 的语义（协议 §6 / §7 / §11.4）：

| 输入 | 行为 |
|---|---|
| 载荷 1 字节 0-255 | `lumen_state_clamp_brightness()` 钳位后写入 `next.brightness`，回 `0x00` |
| 钳位后与当前值相同 | 回 `0x00`，`state_changed = false`（不 commit、不刷新、不写 NVS） |
| 载荷长度 ≠ 1 | `0x04`，状态不变 |
| 任何取值 | **钳位而不是拒绝**——协议 §6 的 SetBrightness 没有 InvalidParam |

- **只写 brightness，绝不动 power**：亮度 0 是合法状态，视觉等于关灯，但 power 位保持 1。
- 关灯保留亮度：SetPower 0/1 的 reducer 只改 `power`（#8 语义，单测覆盖）。
- 钳位发生在 reducer 内（不是渲染时才钳），保证 `state_changed` 的判定也按生效值。

### 10.2 渲染路径

`led_engine.c` 的 `render_snapshot()` 保持不变（#6 已建）：

```
brightness = power ? clamp(state.brightness, max_brightness) : 0
pixel = lumen_gamma_apply(state.r/g/b, brightness)
```

gamma 与亮度乘算只用 `lumen_gamma_apply()` 一处实现；亮度 0 时它自然输出 0，
不需要清 power 位。相同像素快照会跳过 `set_pixel + refresh`（拖回同一值不重复刷灯）。

### 10.3 Host 测试（`test_skeleton.c`）

- 向量 `set_brightness_128` / `set_brightness_0` 走 `run_app_case` 的亮度分支，
  断言结果码、`next.brightness`、`state_changed`、power 不变。
- `test_set_brightness_reducer()`：边界 0/1/128/254/255、钳位到 180、
  `max_brightness = 0`、相同值不 commit、钳位后相同不 commit、长度不符 `0x04`、
  关灯再开保留亮度。
- 基线从 856 项增至 917 项（只增不减）。

---

## 11. #10 落地后的增量（颜色与预设端到端）

issue #10 把「设颜色」与「一次设全部」纵向打通：色环 HSV → 用户空间 RGB →
20Hz 节流 → BLE 写入 → 固件解码 → 状态更新 → gamma + 亮度乘算 → 灯带显示；
预设色块用一条 SetAll 原子下发开关 + 亮度 + RGB。

### 11.1 命令层（`command.c`）

SetColor 0x03 的语义（协议 §6 / §7）：

| 输入 | 行为 |
|---|---|
| 3 字节 R,G,B（各 0-255） | 写入 `next.r/g/b`，回 `0x00` |
| 三个字节都与当前值相同 | 回 `0x00`，`state_changed = false` |
| 载荷长度 ≠ 3 | `0x04`，状态不变 |

- **只写颜色**：不发散到 power / brightness。关灯时选颜色只保存，开灯即生效。
- **命令层不做 gamma**：载荷原样进入共享状态；gamma 只在 `led_engine` 的
  `lumen_gamma_apply()` 里发生（协议 §7、spec §6）。这样 State 与测试向量里的
  RGB 始终是用户空间值，App 与固件不会各算一次。

SetAll 0x04 的语义（协议 §6 / §7 / §11.1 / §11.4）：

| 输入 | 行为 |
|---|---|
| power 0/1 + 其余 0-255 | 五字段一起写入，回 `0x00` |
| power 非 0/1 | `0x01`，**brightness / RGB 一个都不写**（先校验后赋值） |
| brightness 超过 `max_brightness` | 钳位（与 SetBrightness 同一条规则），回 `0x00` |
| 五字段（钳位后）与当前值全同 | 回 `0x00`，`state_changed = false` |
| power = 0 | 亮度与 RGB 仍保存（§7：关灯保留亮度与颜色） |
| 载荷长度 ≠ 5 | `0x04`，整帧不生效 |

原子性的实现方式：所有取值校验都在第一次赋值之前完成，`outcome->next` 要么
五个字段全新，要么保持 `current` 原样。`state_changed` 为 false 时 `ble_link`
不 commit，因此渲染与 NVS debounce 都不会触发——相同 SetAll 重发是安全的。

### 11.2 渲染路径

`render_snapshot()` 无需改动：它本来就对 `state.r/g/b` 逐个调
`lumen_gamma_apply(value, brightness)`。颜色命令只改变共享状态里的 RGB，
渲染任务按 latest-wins 取最新快照，所以「拖色环」与「切预设」都不会排队。

低亮度色相正确性来自「app 不折亮度、固件统一做 gamma + 线性亮度乘算」：
三个通道走同一条曲线、乘同一个亮度，色相（通道间比例）保持不变。真机仍需
确认 LED 通道一致性与主观色相（见报告风险项）。

### 11.3 Host 测试（`test_skeleton.c`）

- 向量 `set_color_red` / `set_color_warm_white` / `set_all_on` / `set_all_off`
  走 `run_app_case` 的对应分支，断言结果码、五字段/三字段写入、`state_changed`、
  `led_count` 不变。
- `test_set_color_reducer()`：全黑 / 全白 / 三组单通道 / 中间值边界、
  不改 power 与 brightness、相同值不 commit、单通道变化也 commit、
  关灯态选色不点亮、命令层不做 gamma、长度 2/4 → `0x04`。
- `test_set_all_atomicity()`：power = 0x02 / 0xFF → `0x01` 且各字段都不变；
  非法 power 且其余字段恰与当前相同时也回 `0x01`；长度 4 → `0x04`。
- `test_set_all_reducer()`：正常路径五字段生效、power = 0 也保存亮度与 RGB、
  全同不 commit、只有 power 变化也 commit、亮度钳位（200/255 → 180）、
  钳位后相同不 commit、`max_brightness = 0` 时亮度 0 且颜色照常生效。
- 基线从 917 项增至 1024 项（只增不减）。

---

## 12. #12 落地后的增量（灯珠数量与断电记忆）

issue #12 让灯珠数量可在运行时修改并掉电保持。两条链路最容易出错的地方是
**谁拥有 `led_strip` 句柄** 和 **何时才允许把新数量写进共享状态**，所以核心逻辑
被拆成三个可在 host 上单测的纯模块，`led_engine` / `state_store` 只保留平台相关
的外壳。

| 新模块 | 职责 | 为什么独立 |
|---|---|---|
| `led_count_job` | 重建状态机（pending / running / target / seq） | 「第二个请求回 Busy、成功后只改数量」是纯状态转移，不需要 led_strip |
| `save_scheduler` | 500ms debounce（可回绕的 32 位时钟） | 用假时钟能精确测到期 / 推迟 / 回绕，不必真的 sleep 500ms |
| `state_blob` | NVS blob 的 13 字节显式编解码 | 布局与越界校验需要在没有 NVS 的 host 上验证 |

### 12.1 SetLedCount 的完整路径（协议 §11.3）

```
NimBLE RX 回调（主机任务）
  lumen_protocol_decode
  → lumen_command_dispatch            # command.c：校验 1-64，置 led_count_rebuild
  → lumen_led_engine_set_led_count    # 只判忙 / 判相同 + 登记 pending，绝不碰 led_strip
       ├─ UNCHANGED → 立即回 ACK 0x00
       ├─ BUSY      → 立即回 ACK 0x05
       └─ ACCEPTED  → give(render_signal)，本回调不发明 ACK
                    │
                    ▼
渲染任务（lumen_render，句柄唯一所有者）
  rebuild_led_count_if_pending
    job_begin（pending → running）
    → create_strip(target)              # led_strip_new_rmt_device
       ├─ 失败：job_complete(false)，旧句柄 / 旧数量原样，回 ACK 0x09
       └─ 成功：锁内 s_strip = fresh + job_complete(true, &s_state)
                → led_strip_del(old)    # 只有渲染任务碰句柄，del 不与刷新并发
                → 强制重绘（s_rendered_valid = false）
                → lumen_state_store_request_save(..., LUMEN_CMD_SET_LED_COUNT)
                → 回 ACK 0x00
```

关键约束与实现位置：

- **`create_strip` 与 `led_strip_del` 都只在渲染任务里**（`led_engine.c` 的
  `rebuild_led_count_if_pending`）。BLE 回调只做状态机登记，违反这条会发生在途
  RMT 事务被释放的崩溃。
- **新数量只在重建成功后写入共享状态**：命令层不写 `next.led_count`
  （`state_changed` 恒为 false），由 `lumen_led_count_job_complete(true, &s_state)`
  在锁内只覆盖 `led_count`，开关 / 亮度 / RGB 保持重建完成时的最新值。
- **ACK 由渲染任务发**：`lumen_led_engine_response_cb` 由 `ble_link` 注册为
  `engine_response` → `send_ack`。命令层返回哨兵 `LUMEN_LED_ENGINE_DEFERRED`
  （0xFF，绝不进帧），`handle_frame` 见到它就 return，不发普通 ACK。
- **不在 BLE 回调里等重建**：ACK 可能晚几百毫秒，绝不能在主机任务里阻塞。

### 12.2 重建并发（§11.3 第 4 条）

`lumen_led_count_job_request()` 的判定顺序是 **先判忙、后判相同**：

| 当前状态 | 新请求 | 结果 |
|---|---|---|
| pending 或 running | 任意（含与旧数量相同） | `BUSY` → ACK 0x05，不排队 |
| 空闲 | 与当前数量相同 | `UNCHANGED` → ACK 0x00，不重建、不写 NVS |
| 空闲 | 1-64 且不同 | `ACCEPTED` → 排队，ACK 延迟 |
| 空闲 | 越界 | 命令层已拦成 0x01；这里防御性回 `BUSY` |

先判忙的原因：重建期间共享状态里仍是旧数量，用旧值判「相同」没有意义。
重建期间到达的其它命令（开关 / 亮度 / 颜色）照常 commit 到邮箱，重建成功后
按最新 `s_state` 重绘，所以画面不会丢最新状态。

### 12.3 500ms debounce（§12）

`save_scheduler` 每次请求覆盖快照并重置 `deadline = now + 500`，用
`(int32_t)(deadline - now)` 的有符号差值判定剩余时间，因此 32 位毫秒时钟
从 `0xFFFFFFFF` 回绕到 0 时不会卡死（回绕后仍在窗口内就继续等，越过窗口就立即到期）。

存储任务不能用「信号量超时就写」——超时落在 tick 边界，可能比真正到期早不到
1ms 而漏写。实现改为先问 `lumen_save_scheduler_next_delay_ms()`，按精确剩余
时间等待，被新请求唤醒就重算并继续推迟。最终只写最后一次快照。

### 12.4 NVS blob 布局

`state_blob` 用显式字节布局，避开结构体 padding 随编译器变化：

| 偏移 | 宽度 | 字段 |
|---|---|---|
| 0..3 | 4 | magic `'L' 'M' 'E' 'N'` |
| 4..5 | 2 | version（小端，当前 1） |
| 6 | 1 | power（0/1） |
| 7 | 1 | brightness |
| 8..10 | 3 | r, g, b |
| 11..12 | 2 | led_count（小端） |

解码拒绝：长度 ≠ 13、magic 不符、version ≠ 1、`power > 1`、`led_count` 不在
1-64。任一失败都不写 `out`，调用方保留协议默认值（`state_store_load` 返回 false，
`led_engine_init` 继续用 Kconfig 默认的灯珠数）。旧固件留下的 8 字节或别的布局
一律视为损坏并按默认值启动，不做「尽量解析」。

### 12.5 Event 0x81 通道接线

NVS 写失败发生在 ACK 之后，只能异步上报（§10.3）：载荷 `[0x01, 原命令字]`，
seq 固定 `0x00`。整条链的接线位置：

```
命令字来源：ble_link.handle_frame → lumen_led_engine_commit(&next, frame.command)
                                    → lumen_state_store_request_save(state, command)
                                    → save_scheduler 记住 command
存储任务：write_blob 失败 → s_event_cb(command)
回调注册：lumen_ble_link_init → lumen_state_store_set_event_cb(on_store_failed)
发送：    send_event(LUMEN_EVENT_STORAGE_FAILED, command) → TX notify
```

`command` 跟着快照一起被 debounce 覆盖，所以合并多帧后上报的是「最后一份快照
对应的命令」，与真正写进去的内容一致。自检不写 NVS，因此不会产生这条 Event。

### 12.6 小程序侧

- 灯珠数量放在**设备 / 连接弹层**内（设备级低频设置，不占主控制流）。
- 输入框只接受十进制整数：`parseLedCountInput()` 拒绝空值、非数字、小数、
  `0`、`65`、`0x10`、`1e2` 等；非法时明确提示且**输入框恢复设备当前值**，
  绝不发帧。
- SetLedCount 的 ACK 超时是 **3000ms**（`LED_COUNT_ACK_TIMEOUT_MS`），不走普通
  命令的 600ms；**不重传**（重建是重操作，超时重发只会撞 0x05）。
- 成功才更新本地 `ledCount`；`0x05`（Busy）与 `0x09`（InternalError）保留旧值
  并给具体提示（`ledCountResultHint`）。

### 12.7 Host 测试（`test_skeleton.c`）

- 向量 `set_led_count_30` / `set_led_count_64` 走新增的 SetLedCount 分支：
  断言结果码、`led_count_rebuild == true`、`state_changed == false`、
  `next.led_count` 保持旧值。
- 向量 `invalid_led_count_0` / `invalid_led_count_65`：`0x01`、不请求重建。
- `test_set_led_count_reducer()`：1/30/64 合法标记、0/65/65535/256 越界、
  长度 0/1/3 → `0x04`、命令表项。
- `test_led_count_job()`：请求→Busy（排队中与运行中都判忙）、相同数量 →
  UNCHANGED、begin/complete 成功只改 `led_count`、失败回滚、完成后可再请求、
  越界防御、NULL 防御。
- `test_save_scheduler()`：500ms 到期、499ms 差 1ms、连续请求只写最后一份、
  时钟回绕（`0xFFFFFF00` → 越过零点）、`next_delay_ms` 语义、
  `out`/`command` 允许为 NULL。
- `test_state_blob()`：往返一致、显式布局逐字节、长度 12/14/0、坏 magic、
  版本 0/2/高位错位、`power` 2/0xFF、`led_count` 0/65/0xFFFF、失败不写 out、
  边界值 1。
- Event 0x81：与向量 `event_storage_failed` 逐字节一致，并枚举每个可能的
  触发命令字（含 `LUMEN_CMD_SET_LED_COUNT`）都能编码 + 解码回原字段。
- 计数基线：integration 的 1036 项 → **1289 项**（只增不减）。
