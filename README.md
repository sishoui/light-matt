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
- **想开工**：看 map 的「票（frontier 视图）」表格，从状态为 `ready` 的票开始

## 现状

设计阶段。协议已定稿（[docs/protocol.md](docs/protocol.md)），实现规格在
[docs/spec.md](docs/spec.md)，执行票在 GitHub Issues。地图的前沿只剩「开发环境就绪」：
工具链已装好、hello_world 与 led_strip 编译通过，待接板子烧录与真机预览确认。
尚无产品代码。
