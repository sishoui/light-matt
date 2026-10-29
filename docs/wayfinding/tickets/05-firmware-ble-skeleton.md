# 05：固件 BLE 服务与分层骨架

**类型**：`wayfinder:task`（AFK — 我能独立完成）

## Question

固件的三层结构（`ble_link` / `led_engine` / `state_store`）在 NimBLE 上怎么落成代码骨架，才能让 BLE 回调永不阻塞、渲染永远取最新一帧？

这一票**不实现协议命令的全部语义**，只把骨架和边界钉死。骨架对了，后面填命令表就是机械工作；骨架错了（比如回调里直接刷灯），后面每一步都在跟丢包和卡顿搏斗。

### 要钉死的结构

```
main/
  app_main.c        初始化顺序：NVS → led_engine → state_store 恢复 → ble_link 启动
  ble_link/         NimBLE GATT server：Service + RX/TX/State
                    RX 回调 → 解码 → 写入共享状态 → 发信号量（不做 IO，不做渲染）
  led_engine/       共享状态（互斥保护）+ latest-wins 邮箱 + 渲染任务
                    渲染任务：等信号量 → 取状态快照 → gamma → 刷新灯带
  state_store/      NVS 读写，带 debounce
```

### NimBLE 的标准初始化顺序（研究已确认，照这个来）

```
nvs_flash_init()
→ nimble_port_init()
→ 填 ble_hs_cfg（reset_cb / sync_cb / gatts_register_cb / store_status_cb）
→ ble_svc_gap_init() / ble_svc_gatt_init()
→ ble_gatts_count_cfg() + ble_gatts_add_svcs()
→ ble_svc_gap_device_name_set()
→ nimble_port_freertos_init(host_task)
→ 在 sync_cb 里 ble_gap_adv_start()
→ 主机任务里 nimble_port_run()
```

连接数：NimBLE 的 `BT_NIMBLE_MAX_CONNECTIONS` 默认 3，**本项目要显式设成 1**（基线里已经定了只允许单连接）。

### 要钉死的三个关键点

1. **BLE 回调的边界**：回调里允许做什么、禁止做什么（禁止：刷灯、写 NVS、printf 大段日志）
2. **latest-wins 邮箱的具体实现**：互斥锁 + 布尔 dirty 标志 + 二值信号量，还是别的方式；渲染任务怎么保证「醒来时总是取最新」
3. **NimBLE 的 GATT 定义方式**：用 `ble_gatt_svc_def` 数组描述服务与特征值；本票要产出**具体 UUID 值**；属性配置：RX = write-no-response，TX = notify，State = read

### 注意：C3 是单核，任务优先级要小心

C3 只有一个 32-bit RISC-V 核。NimBLE 主机任务和渲染任务共享这一个核。渲染任务的优先级**不应高于** NimBLE 主机任务，否则刷新期间阻塞协议栈；也不应太低，否则被饿死。本票要确定这两个任务的优先级与栈大小，并记录理由。

### 不做

不做灯效、不做协议校验逻辑的完整实现（那在下一票）、不做 MTU 协商的复杂分支（先用默认）、不做多连接。

## Blocked by

- 【协议规格定稿】——GATT 的 State 布局和 UUID 要在协议里先定
- 【led_strip 点灯验证】——渲染任务的刷新部分复用那一票的调用方式

## 交付

- `firmware/main/` 下的完整骨架，`idf.py build` 通过
- 串口能打印「GATT 服务已注册，等连接」
- 手机用任意 BLE 调试 App（如 nRF Connect）能看到服务与三个特征值

## 验收

- [ ] 编译通过，烧录后串口正常运行
- [ ] nRF Connect 能看到 Service 与 RX / TX / State 三个特征值，属性正确
- [ ] 写入 RX 触发串口打印「收到 N 字节」，但此时灯带不变（骨架验证）
- [ ] 渲染任务在空闲时不空转（可用 `idf.py monitor` 观察 CPU 占用或加计数验证）
- [ ] 三个模块的公开接口清晰，跨层调用只有一个方向
