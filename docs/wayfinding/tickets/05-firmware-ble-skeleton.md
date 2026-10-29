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

### 要钉死的三个关键点

1. **BLE 回调的边界**：回调里允许做什么、禁止做什么（禁止：刷灯、写 NVS、printf 大段日志）
2. **latest-wins 邮箱的具体实现**：互斥锁 + 布尔 dirty 标志 + 二值信号量，还是别的方式；渲染任务怎么保证「醒来时总是取最新」
3. **NimBLE 的 GATT 定义方式**：用 NimBLE 的 GATT server API，服务 UUID / 特征值 UUID 从哪里来（本票要产出具体 UUID 值），属性怎么配（RX = write-no-response，TX = notify，State = read）

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
