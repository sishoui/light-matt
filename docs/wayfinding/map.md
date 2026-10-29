# 地图：lumen — 微信小程序 BLE 控 ESP32-C3FH4 驱动 WS2812B

> **这是地图，不是规格。** 每条决策的细节在它自己的票里，这里只做索引与指向。

## Destination

一份可直接开工的技术方案，加一个**在真机上跑通**的端到端原型：
小程序扫到设备 → 连上 → 开关灯带 → 拖亮度实时跟随 → 色环选色 → 断线自动回连 → 断电记忆恢复。

抵达标准就是 `architecture-brief.md` 末尾那 7 条真机验收清单全部通过。

## Notes

- **架构基线**：[architecture-brief.md](./architecture-brief.md)。所有票的前提都在那里，开工前先读它。
- **实现规格**：[spec.md](../spec.md)。由基线、本图与研究笔记合成，汇总 MVP 范围、实现决策与测试接缝；**不取代本图**，协议字节细节仍以 `docs/protocol.md` 为唯一真相。
- **允许实现票**：wayfinder 默认只产出决策。本 effort 的 Destination 是「打通的原型」，所以 **Notes 显式覆盖该默认**：允许少量 task / prototype 票直接写代码，但**每张票的边界是「验证一个决策」**，做到能跑通即止，不做产品化打磨（不写错误恢复的边角分支、不做 UI 美化、不写文档站）。
- **不做的事**：任何一票如果开始出现「重构」「优化」「美化」「补全异常分支」的冲动，说明已经越过边界，停下来收尾。
- **协议是唯一真相**：两端只通过 `docs/protocol.md` 耦合。改协议 → 两端改动进同一个 commit。
- **开发顺序**：协议先行 → 两端并行实现 → 一次真机联调。
- **硬件现状**：目标芯片 ESP32-C3FH4（你后续自行画 PCB）。开发阶段先用手上的 C3 开发板验证，固件按 C3FH4 的引脚约束写（GPIO12-17 是封装内 flash、18/19 是 USB-JTAG、20/21 是 UART0、4-7 是 JTAG、2/8/9 是 strapping）。WS2812B 灯带约 30 灯珠、GRB 顺序。开发阶段用开发板 USB 5V 供电、暂不做电平转换，**但画板时 74AHCT125 必须进 BOM**（研究确认 3.3V 驱动 5V 灯带规格不达标，VIH=3.5V）。默认数据脚 GPIO3。
- **本机环境**：ESP-IDF v5.4 源码在 `C:\Users\13092\esp\v5.4\esp-idf`；`C:\Espressif\tools` 下**只有 git 与 python，没有 riscv32-esp-elf 工具链**，`idf.py` 尚不可用。Node v24.14.0、Python 3.12.10、微信开发者工具已装。
- **语言约定**：中文注释 + 英文标识符。
- **验证方式**：真机联调由用户配合操作并回传现象与串口日志。
- **地图入库**：`docs/wayfinding/` 随项目提交。

## 票（frontier 视图）

本地 markdown tracker 没有"查询"能力，所以这里放一个展开的 frontier。**Blocker 全部关闭的票就是可开工的。**
认领一票 = 把它标成 `in-progress` 并在 `docs/wayfinding/tickets/` 里写上你的名字。

| # | 票 | 类型 | 阻塞于 | 状态 |
|---|---|---|---|---|
| 01 | [开发环境就绪](./tickets/01-dev-environment.md) | task | — | done |
| 02 | [协议规格定稿](./tickets/02-protocol-spec.md) | grilling | — | done |
| 03 | [led_strip 点灯验证](./tickets/03-led-strip-smoke-test.md) | prototype | 01 | 代码完成，待肉眼确认 |
| 04 | [小程序 BLE 探测](./tickets/04-miniprogram-ble-probe.md) | prototype | 01 | done |
| 05 | [固件 BLE 服务与分层骨架](./tickets/05-firmware-ble-skeleton.md) | task | 02, 03 | done |
| 06 | [固件协议实现与状态机](./tickets/06-firmware-protocol-impl.md) | task | 02, 05 | done（合并进 #8/#9/#10） |
| 07 | [小程序 BLE 传输层与协议 codec](./tickets/07-miniprogram-transport-codec.md) | task | 02, 04 | done（合并进 #8） |
| 08 | [小程序控制界面](./tickets/08-miniprogram-ui.md) | prototype | 07 | done（合并进 #8/#9/#10） |
| 09 | [端到端真机联调与验收](./tickets/09-end-to-end-acceptance.md) | task | 06, 08, 10 | 待真机 |
| 10 | [RMT × BLE 共存稳定性验证](./tickets/10-rmt-ble-coexistence.md) | prototype | 03, 05 | 方案与固件完成，待用户实测 |

**frontier：03 的肉眼确认、10 的五组长跑实测、09 的端到端验收。** 三者的共同点是都需要真机与人眼；
代码侧的实现票（05–08 与 GitHub #11–#13）已全部落到 `integration/lumen-mvp`。

GitHub 实现票（13 张）与本地 wayfinder 票的对应关系：本地 06/07/08 被拆成了更细的 GitHub 票
（#8 开关、#9 亮度、#10 颜色、#11 状态同步、#12 灯珠数与持久化、#13 日志与自检），按纵向切片
逐条打通，而不是按层实现。

依赖形状说明：01（环境）与 02（协议）是两条独立的地基——一条通固件，一条通两端。它们在 05/07 处汇合。03 与 04 是两条平行的风险探针，一个摸硬件、一个摸平台，都只依赖 01。

**10 是后加的，位置很关键。** 它故意排在 05 之后、09 之前：只有两端都还没联调时，才分得清「灯闪」是协议问题还是 RMT 中断问题。09 也已经改成被 10 阻塞，因为 10 若判定不可接受，09 的验收没有意义。

## Decisions so far

<!-- 一票已关闭就追加一行：名称（链接）+ 一句话结论 -->

- **BLE × 固件 × WS2812 事实核查**（调研，[研究笔记](./research/ble-and-firmware-facts.md)）：确认 20 字节是硬约束且 iOS 超长写会静默失败；C3 的 RMT 无 DMA 且单核，与 BLE 共存存在波形损坏风险；3.3V 驱动 5V WS2812B 在规格上不达标（VIH=3.5V）。详见研究笔记，已并入架构基线。
- **开发环境就绪**（[GitHub #3](https://github.com/sishoui/light-matt/issues/3)，[环境文档](../dev-environment.md)）：ESP-IDF v5.4 工具链装好；hello_world 烧录 COM6 并输出；led_strip 依赖编译通过；微信开发者工具真机预览通过。芯片实际 4MB flash，正式固件按 4MB 配置。
- **小程序 BLE 探测**（[GitHub #5](https://github.com/sishoui/light-matt/issues/5)，[实测笔记](../ble-notes.md)）：Android 16 真机验证扫描/连接/MTU/notify/写/回显；deviceId 是 MAC，`setBLEMTU(185)` 实际回包 256；连接间隔 30ms；20/50/100ms 各 20 帧全部回显；重连成功。iOS 未测（无设备），按官方文档记录，留到端到端验收。
- **协议规格定稿**（[GitHub #2](https://github.com/sishoui/light-matt/issues/2)，规格见 [protocol.md](../protocol.md)）：帧 ≤20 字节、小端、校验和覆盖 magic..payload 后取反；7 条命令 + ACK/Event/StateReport；State 固定 8 字节；结果码 0x00-0x09；ACK 在写入 RAM 后回，NVS 失败用 Event 0x81；自检与灯珠数量重建语义已定。测试向量在 `docs/protocol-testvectors.json`。
- **led_strip 点灯验证**（[GitHub #4](https://github.com/sishoui/light-matt/issues/4)，接线与验收步骤见 [led-bringup.md](../led-bringup.md)）：GPIO3 + RMT 10MHz + `mem_block_symbols=48` + 无 DMA，30 灯序列跑通；连续 5 分钟 soak 中 10/10 心跳准点、`refresh_errors=0`、heap 稳定、无重启。颜色顺序、闪烁与全白掉压仍需人眼确认；亮度 1/255 时 `(255,180,120)` 量化成 `(1,1,0)` 属整数取整。
- **固件 BLE 服务与分层骨架**（[GitHub #6](https://github.com/sishoui/light-matt/issues/6)，见 [firmware-architecture.md](../firmware-architecture.md)）：`ble_link → led_engine → state_store` 单向依赖；RX 回调只解信封打日志，不刷灯/不写 NVS；latest-wins 邮箱（互斥锁 + dirty + 二值信号量）；单连接、断开重新广播；渲染任务 4096B/优先级 4，存储任务 3072B/优先级 2；host 单测 341 项通过。
- **开关端到端**（[GitHub #8](https://github.com/sishoui/light-matt/issues/8)）：命令层抽成纯 reducer（`command.c`），RX 回调只做「解码 → 分发 → 写 RAM → 回 ACK」；小程序建 transport / codec / throttle / log / session 分层；20Hz latest-wins 与写入串行化就位；两端共用 37 条测试向量。
- **亮度端到端**（[GitHub #9](https://github.com/sishoui/light-matt/issues/9)）：20Hz 节流接真，`bindchanging` 拖动实时跟随；亮度按 State 的 `max_brightness` 钳位；亮度 0 保留 power 位，开灯时用最近非 0 亮度恢复。
- **颜色与预设**（[GitHub #10](https://github.com/sishoui/light-matt/issues/10)）：色相环 + 饱和度滑块（V 恒为 1，亮度只走滑块，绝不折进 RGB）；8 个预设走 SetAll 单帧下发；颜色与亮度共用同一个节流通道，不会叠成 40Hz。
- **状态同步与回连**（[GitHub #11](https://github.com/sishoui/light-matt/issues/11)）：State 是唯一权威；断线立即清空设备状态；1s/2s/4s 退避回连（修掉了「只走第一次」的排程 bug 与「主动断开被误标可回连」的 bug）；退避耗尽停住并给手动入口。
- **灯珠数量与断电记忆**（[GitHub #12](https://github.com/sishoui/light-matt/issues/12)）：重建状态机保证 ACK 等句柄重建结果才发，重建中再请求回 Busy；`new`/`del` 句柄只在渲染任务里；500ms debounce 用有符号差值比较时间，32 位回绕不卡死；NVS blob 13 字节显式布局。
- **Event 0x81 跨票缺口**（[GitHub #1](https://github.com/sishoui/light-matt/issues/1) 范围内的补丁）：协议 §10.3 要求的 NVS 写失败上报，从 #6 到 #10 都没有调用点（每张票都假设别人接）。补通 `state_store → led_engine → ble_link` 整条链，并加逐字节断言。

## Not yet specified

雾里的东西：能看出在 Destination 前方，但现在还问不出精确的问题。等前沿推进后再毕业成票。

- **若 RMT × BLE 判定不可接受，SPI 驱动 WS2812 的迁移成本**。C3 可以用 SPI 硬件外设按 3.2MHz 生成 WS2812 波形（每 bit 扩展成 4 个 SPI bit），绕开 RMT 的 ISR 依赖。这是备选路线，但现在评估没意义——【RMT × BLE 共存稳定性验证】会给出答案。
- **全白电流预算**。研究给出的数字：单灯全白 60mA，30 灯 ≈ 1.8A，而开发板 USB 5V 通常限流 500mA-1A。全白高亮度会拉爆电源。要么固件限亮度上限，要么接受「全白只短暂测试」。这条要不要变成票，取决于【led_strip 点灯验证】里实测的供电表现。
- **iOS 与 Android 的 BLE 行为差异**。已知形态：`setBLEMTU` 仅 Android；iOS 超长写静默失败；Android 上 notify 后立即写报 10008；Android 6.0+ 扫描需定位权限。这些已写进基线。但**具体机型**的差异（尤其国产 Android 的权限弹窗与蓝牙开关行为）要等【小程序 BLE 探测】真机摸过才知道要不要再票。
- **灯效引擎的架构**。呼吸、彩虹、流光这类动画需要帧率驱动，和现在的 latest-wins 单帧模型不是一回事。明确是 MVP 之后的事，但现在放置顶决定（比如状态机字段怎么留）会影响后续成本。注意：固定帧率驱动会加重上面那条 RMT 风险。
- **多设备管理**。广播名后缀已留好扩展位，但「一台手机管三条灯带」需要设备列表、分组、并发连接策略。微信 BLE 的同时连接上限**官方无数字**，只能实测。等单设备跑通再说。
- **ESP32-C3FH4 的物料状态**。研究发现的旁支信息：datasheet 里 `ESP32-C3FH4X` 才是 Recommended，`FH4AZ` 标为 NRND（不推荐新设计），FH4 是 rev v0.4。你要自己画板，这颗料选型值得再确认一次——但它是采购/硬件决策，不是软件决策，暂时留在雾里。

## Out of scope

明确排除在这次 effort 之外。它们不是「还没想清楚」，是「这次不做」。

- **WiFi / MQTT / 云端控制**。已选 BLE 直连，不做第二条通道，也不做 Broker 与备案域名。
- **账号体系、云同步、场景云端存储**。原型阶段无服务器。
- **产品化**：PCB 设计、外壳、3C 认证、量产 BOM、小程序审核上架、固件 OTA。
- **灯效库**（呼吸 / 彩虹 / 流光 / 音乐律动）。MVP 只有静态单色 + 亮度。
- **多灯带联动 / 分区控制 / 定时任务**。
- **BLE 配对与认证**。设备是开放式连接，同房间任何人都能控，这个取舍已在基线里明确接受。
