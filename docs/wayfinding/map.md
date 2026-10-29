# 地图：lumen — 微信小程序 BLE 控 ESP32-C3FH4 驱动 WS2812B

> **这是地图，不是规格。** 每条决策的细节在它自己的票里，这里只做索引与指向。

## Destination

一份可直接开工的技术方案，加一个**在真机上跑通**的端到端原型：
小程序扫到设备 → 连上 → 开关灯带 → 拖亮度实时跟随 → 色环选色 → 断线自动回连 → 断电记忆恢复。

抵达标准就是 `architecture-brief.md` 末尾那 7 条真机验收清单全部通过。

## Notes

- **架构基线**：[architecture-brief.md](./architecture-brief.md)。所有票的前提都在那里，开工前先读它。
- **允许实现票**：wayfinder 默认只产出决策。本 effort 的 Destination 是「打通的原型」，所以 **Notes 显式覆盖该默认**：允许少量 task / prototype 票直接写代码，但**每张票的边界是「验证一个决策」**，做到能跑通即止，不做产品化打磨（不写错误恢复的边角分支、不做 UI 美化、不写文档站）。
- **不做的事**：任何一票如果开始出现「重构」「优化」「美化」「补全异常分支」的冲动，说明已经越过边界，停下来收尾。
- **协议是唯一真相**：两端只通过 `docs/protocol.md` 耦合。改协议 → 两端改动进同一个 commit。
- **开发顺序**：协议先行 → 两端并行实现 → 一次真机联调。
- **硬件现状**：ESP32-C3FH4 裸芯片（用户自行画板）+ 现成 WS2812B 灯带（约 30 灯珠，GRB）。开发阶段用开发板 USB 5V 供电，暂不做电平转换。默认数据脚 GPIO3。
- **本机环境**：ESP-IDF v5.4 源码在 `C:\Users\13092\esp\v5.4\esp-idf`；`C:\Espressif\tools` 下**只有 git 与 python，没有 riscv32-esp-elf 工具链**，`idf.py` 尚不可用。Node v24.14.0、Python 3.12.10、微信开发者工具已装。
- **语言约定**：中文注释 + 英文标识符。
- **验证方式**：真机联调由用户配合操作并回传现象与串口日志。
- **地图入库**：`docs/wayfinding/` 随项目提交。

## 票（frontier 视图）

本地 markdown tracker 没有"查询"能力，所以这里放一个展开的 frontier。**Blocker 全部关闭的票就是可开工的。**
认领一票 = 把它标成 `in-progress` 并在 `docs/wayfinding/tickets/` 里写上你的名字。

| # | 票 | 类型 | 阻塞于 | 状态 |
|---|---|---|---|---|
| 01 | [开发环境就绪](./tickets/01-dev-environment.md) | task | — | ready |
| 02 | [协议规格定稿](./tickets/02-protocol-spec.md) | grilling | — | ready |
| 03 | [led_strip 点灯验证](./tickets/03-led-strip-smoke-test.md) | prototype | 01 | blocked |
| 04 | [小程序 BLE 探测](./tickets/04-miniprogram-ble-probe.md) | prototype | 01 | blocked |
| 05 | [固件 BLE 服务与分层骨架](./tickets/05-firmware-ble-skeleton.md) | task | 02, 03 | blocked |
| 06 | [固件协议实现与状态机](./tickets/06-firmware-protocol-impl.md) | task | 02, 05 | blocked |
| 07 | [小程序 BLE 传输层与协议 codec](./tickets/07-miniprogram-transport-codec.md) | task | 02, 04 | blocked |
| 08 | [小程序控制界面](./tickets/08-miniprogram-ui.md) | prototype | 07 | blocked |
| 09 | [端到端真机联调与验收](./tickets/09-end-to-end-acceptance.md) | task | 06, 08 | blocked |

**现在的 frontier 只有两张：01 与 02。** 它们互相独立，可以并行。

依赖形状说明：01（环境）与 02（协议）是两条独立的地基——一条通固件，一条通两端。它们在 05/07 处汇合。03 与 04 是两条平行的风险探针，一个摸硬件、一个摸平台，都只依赖 01。

## Decisions so far

<!-- 一票已关闭就追加一行：名称（链接）+ 一句话结论 -->

_（尚无已关闭的票）_

## Not yet specified

雾里的东西：能看出在 Destination 前方，但现在还问不出精确的问题。等前沿推进后再毕业成票。

- **3.3V 驱动 5V 灯带的稳定性**。GPIO3 的 3.3V 逻辑去驱动 5V 供电的 WS2812B 处在 ViH 阈值边缘，「能用」和「偶发闪烁」之间没有明确界线。【灯带点亮验证】的结果会告诉我们需不需要引入 SN74AHCT125 之类的电平缓冲，以及需不需要独立 5V 电源。这条雾只有跑完那一票才能变清。
- **灯珠数量在运行时变更的工程细节**。led_strip 句柄需要重建，重建期间的旧句柄释放、传输中的刷新、失败回滚都要想。现在不值得单独开票，等【固件灯控集成】写到这里时会自然浮出来。
- **协议版本号的实际用途**。帧头留了 version 字节，但「怎么用它做向后兼容」在只有两端、同时发版的现状下是个假问题。等真出现「固件先烧、小程序后更新」的现实约束时再谈。
- **iOS 与 Android 的 BLE 行为差异**。MTU 协商、`deviceId` 形态、系统缓存设备记录这几处两边不一样。已知会有坑，但具体坑要等真机跑过才知道要不要写进方案。【小程序 BLE 探测】那一票会摸出实际形态。
- **灯效引擎的架构**。呼吸、彩虹、流光这类动画需要帧率驱动，和现在的 latest-wins 单帧模型不是一回事。明确是 MVP 之后的事，但现在放置顶决定（比如状态机字段怎么留）会影响后续成本。
- **多设备管理**。广播名后缀已留好扩展位，但「一台手机管三条灯带」需要设备列表、分组、并发连接策略。等单设备跑通再说。

## Out of scope

明确排除在这次 effort 之外。它们不是「还没想清楚」，是「这次不做」。

- **WiFi / MQTT / 云端控制**。已选 BLE 直连，不做第二条通道，也不做 Broker 与备案域名。
- **账号体系、云同步、场景云端存储**。原型阶段无服务器。
- **产品化**：PCB 设计、外壳、3C 认证、量产 BOM、小程序审核上架、固件 OTA。
- **灯效库**（呼吸 / 彩虹 / 流光 / 音乐律动）。MVP 只有静态单色 + 亮度。
- **多灯带联动 / 分区控制 / 定时任务**。
- **BLE 配对与认证**。设备是开放式连接，同房间任何人都能控，这个取舍已在基线里明确接受。
