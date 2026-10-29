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

本票没有任何命令路径会调用 `commit`；初始化时直接给一次信号量，按默认（或 NVS 恢复的）状态渲染一次，用于验证灯带句柄可用。

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
- RMT × BLE 的实测调优（`mem_block_symbols`、是否改 async + 双缓冲）属于 #10 的判定范围，本票不预支结论。

---

## 7. 本票范围与后续票

本票只钉骨架：

- ✅ GATT Service / RX / TX / State，广播名 `Lumen-XXXX`，广播包含 128-bit Service UUID，单连接，断开重广播，15-30ms 连接参数。
- ✅ RX 只解信封并打印「收到 N 字节」，不执行命令、不改变灯带、不回 ACK。
- ✅ 共享状态 + latest-wins + 渲染任务 + gamma + 亮度乘算。
- ✅ NVS 加载与 500ms debounce 保存骨架。
- ⏳ 命令分发、payload 校验、ACK / Event / StateReport 发送、QueryState 解码 → #8。
- ⏳ `SetLedCount` 句柄重建与异步 ACK → #8。
- ⏳ 自检 → #8。
- ⏳ RMT × BLE 共存调优 → #10。

`protocol.c` 只保留信封与设备→小程序编码；命令表、已知命令判断、载荷语义全部没有实现，留给 #8。

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
    firmware\main\state.c firmware\main\gamma.c -lm -o lumen_host_tests.exe
```

覆盖：合法帧、坏 magic、坏 version、坏 length（超上限 / 与声明不符 / 拖尾）、坏 checksum、短帧静默丢弃、14 字节最大载荷、未知命令回显 seq、ACK / Event / StateReport 编码与缓冲不足、State 默认值与 8 字节布局、gamma + 亮度乘算单调性。

### 固件构建

```cmd
scripts\build-firmware.cmd
```

只构建，不烧录。真机验收项（nRF Connect 看服务、写 RX 日志、单连接释放）见 issue #6。
