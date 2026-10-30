# lumen

微信小程序通过 BLE 直连控制 ESP32-C3FH4 驱动的 WS2812B 灯带。

## 目录

```
lumen/
  firmware/     ESP-IDF v5.4 工程（NimBLE + led_strip）
  miniprogram/  微信小程序（原生 + TypeScript）
  docs/
    wayfinding/ 设计决策地图与决策票
```

## 从这里开始

- **接手/继续开发**：[docs/handoff.md](docs/handoff.md) —— 当前状态、下一步、必须知道的坑
- **想了解架构**：[docs/wayfinding/architecture-brief.md](docs/wayfinding/architecture-brief.md)
- **想知道还剩什么没定**：[docs/wayfinding/map.md](docs/wayfinding/map.md)
- **想写 codec**：[docs/protocol.md](docs/protocol.md) —— 字节级协议规格与测试向量
- **想实现**：[docs/spec.md](docs/spec.md) —— MVP 实现规格（用户故事、实现决策、测试接缝）
- **想跑真机验收**：[docs/end-to-end-acceptance.md](docs/end-to-end-acceptance.md) —— 7 条清单的操作步骤与记录表
- **想跑 RMT × BLE 共存实验**：[docs/rmt-ble-stability.md](docs/rmt-ble-stability.md) —— 五组实验方案、待填数据表与判定流程
- **想继续开工**：看 map 的「票（frontier 视图）」表格

## 现状

**代码侧已完整，剩下的是真机验证。**

13 张实现票（#2–#13）全部落地在 `integration/lumen-mvp`。两端共用 37 条协议测试向量：
固件 host 1426 项断言、小程序 159 个 vitest 用例、`tsc --noEmit` 干净，固件分区余量 62%。

- **固件**：`ble_link → led_engine → state_store` 三层单向依赖；7 条命令全部实现
  （含 QueryState 的 StateReport、SetLedCount 的句柄重建与延迟 ACK、SelfTest 的临时覆盖）；
  latest-wins 邮箱；单连接；NVS 500ms debounce（写失败用 Event `0x81` 异步上报）。
  见 [firmware-architecture.md](docs/firmware-architecture.md)。
- **小程序**：transport / codec / throttle / log / session 分层；20Hz latest-wins 单通道
  （亮度与颜色共用，不会叠成 40Hz）；写入串行化；错误码分诊（10006 回连、10008 间隔重试
  一次、10001 非致命）；1s/2s/4s 退避回连；State 是唯一权威。
- **诊断**：自检 `0x07` 按 红→绿→蓝→白 各 500ms 走一遍（不依赖小程序即可验证接线与通道
  顺序）；串口每帧一行 `cmd / seq / len / result / 状态`；小程序 200 帧环形缓冲 + 隐藏面板
  （连点版本号 5 次开启）。

**硬件基线尚未确认**：固件能跑、命令能收到、渲染任务能执行到写灯带成功，但**灯带未被观察到点亮**。
当前优先级是排除硬件接线问题（共地、灯带 5V 供电、DIN 是否接 GPIO3），排查步骤见
[验收手册 §0.2.1](docs/end-to-end-acceptance.md)。灯带点亮之前，颜色顺序与供电边界都无法判定。

> 已知的硬约束（与是否点亮无关）：3.3V 直驱 5V 灯带规格不达标（VIH=3.5V），画板时
> 74AHCT125 必须进 BOM；全白 30 灯约 1.8A 而开发板 USB 通常限流 500mA–1A。

**接下来只有真机验收**（[验收手册](docs/end-to-end-acceptance.md)）：先让灯带亮，再跑 7 条清单。

RMT × BLE 共存（#7）交付的是**实验固件 + 方案**（`CONFIG_LUMEN_RMT_STRESS_MODE`，默认关闭），
五组实验与判定线见 [docs/rmt-ble-stability.md](docs/rmt-ble-stability.md)。**实测结论尚空。**
