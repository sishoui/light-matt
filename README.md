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

- **想了解架构**：[docs/wayfinding/architecture-brief.md](docs/wayfinding/architecture-brief.md)
- **想知道还剩什么没定**：[docs/wayfinding/map.md](docs/wayfinding/map.md)
- **想写 codec**：[docs/protocol.md](docs/protocol.md) —— 字节级协议规格与测试向量
- **想实现**：[docs/spec.md](docs/spec.md) —— MVP 实现规格（用户故事、实现决策、测试接缝）
- **想跑 RMT × BLE 共存实验**：[docs/rmt-ble-stability.md](docs/rmt-ble-stability.md) —— 五组实验方案、待填数据表与判定流程
- **想开工**：看 map 的「票（frontier 视图）」表格，从状态为 `ready` 的票开始

## 现状

固件骨架已落地：`ble_link → led_engine → state_store` 三层，NimBLE GATT 服务与单连接、
latest-wins 渲染任务、NVS debounce 都已就位（[firmware-architecture.md](docs/firmware-architecture.md)）。
灯带 bring-up 已烧录并通过 5 分钟 soak（[led-bringup.md](docs/led-bringup.md)），颜色顺序与
全白供电结论待肉眼确认。「设开关」（#8）与「设亮度」（#9）两条命令已端到端打通：固件命令层 + ACK、
小程序传输层/codec/单页开关与亮度滑块（20Hz latest-wins、连续量不重传、亮度按
设备 `max_brightness` 钳位）。颜色与预设控件仍留位待后续票。协议与测试向量见
[docs/protocol.md](docs/protocol.md)，执行票在 GitHub Issues。

RMT × BLE 共存验证（#7）已交付**实验固件 + 方案**：`CONFIG_LUMEN_RMT_STRESS_MODE`
（默认关闭）在同一份固件里提供 20Hz 刷新压力、串口可判定指标（refresh 返回码/耗时、
循环间隔抖动、heap、复位原因、BLE 连接/MTU/写入时间戳），五组实验与待填数据表见
[docs/rmt-ble-stability.md](docs/rmt-ble-stability.md)。**实测结论尚空，等真机数据。**
