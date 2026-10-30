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

**MVP 已完成并通过真机验收。** 13 张实现票（#2–#13）全部落地，端到端验收 #14 七条
全部通过（固件/代码侧 + 人眼/手机侧）。两端共用 37 条协议测试向量：固件 host 1426 项
断言、小程序 159 个 vitest 用例、`tsc --noEmit` 干净，固件分区余量 62%。

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

**硬件基线已确认**（#4）：64 灯 WS2812B 点亮，通道顺序 **GRB**，数据脚 GPIO3，
自检红→绿→蓝→白四色正确。**灯带必须独立 5V 供电、只与开发板共地**——首次接线时
开发板 5V 引脚只量到 0.3V，灯带完全不亮。

> 电流预算按**亮度上限 200** 算：64 灯满亮度（255）全白实测约 3.8A，按亮度线性
> 折算到 200 约 **3.0A**（估算，未实测）。这就是固件把 `max_brightness` 定在 200 的
> 原因——蓝通道 Vf 最高（3.0–3.4V），满亮度时最先被线损压掉。
> 另：3.3V 直驱 5V 灯带规格不达标（VIH=3.5V），画板时 74AHCT125 必须进 BOM。

**剩余的唯一未验证项是 RMT × BLE 共存（#7），用户决定暂不实测。** 方案、压力固件与
判定工具（`scripts/analyze-strip-video.py`，自检通过）都已就绪，随时可补跑，步骤见
[docs/rmt-ble-stability.md](docs/rmt-ble-stability.md) §1.4 / §3 / §10。
这不是「通过」，是「未验证」：C3 的 RMT 无 DMA 且单核，官方缓解措施（换核）不可用，
所以「偶发闪一下 / 单颗灯变色」属于默认应当怀疑的一类。已知缓解已在产品里
（`mem_block_symbols=48`、单渲染任务独占句柄、20Hz 上限 + latest-wins）。
