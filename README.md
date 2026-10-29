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
- **想开工**：看 map 的「票（frontier 视图）」表格，从状态为 `ready` 的票开始

## 现状

设计阶段。地图已建，前沿票为「开发环境就绪」与「协议规格定稿」。尚无可用代码。
