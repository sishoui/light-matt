# 测试报告

> ⚠️ **发布级证据，但本轮发布未覆盖：真机 e2e。**
>
> 真机 e2e：收到 DeviceInfoReport 0x88
>
> 这些层本轮没有跑，不能按通过计。下面每一段都是在「上述层未验证」的前提下写的。

- **运行**：2026-11-07T06:12:04.494Z
- **commit**：`679d58f`（分支 `integration/lumen-v5`，**工作区有未提交改动**）
- **机器**：sishoui · win32 10.0.26200 · 12 核
- **触发了**：firmware / mp / server / ui / ble
- **五层结果**：固件 host 测试 ✅ PASS · 小程序单测 ✅ PASS · 后端单测 ✅ PASS · 渲染回归 ✅ PASS · 真机 e2e ⏭️ SKIP
- **结论**：⚠️ 未全验证（真机 e2e 未跑）
- **本轮未验证**：真机 e2e

## 分层结果

| 层 | 结果 | 用例数 | 耗时 | 说明 |
|---|---|---|---|---|
| 固件 host 测试 | ✅ PASS | 12976 断言 | 1.6s | 12976 条断言通过 |
| 小程序单测 | ✅ PASS | 1200 用例 | 19.3s | 1200 个用例通过，类型检查干净 |
| 后端单测 | ✅ PASS | 140 用例 | 3.6s | 140 个用例通过，类型检查干净 |
| 渲染回归 | ✅ PASS | 48 断言 | 118.7s | 48 条断言通过 |
| 真机 e2e | ⏭️ SKIP | — | 15.0s | 收到 DeviceInfoReport 0x88 |

## 未验证清单

- **真机 e2e**：收到 DeviceInfoReport 0x88

## 明细

### 固件 host 测试：按测试函数的断言数

共 114 个测试函数，12976 条断言（按条数降序）。

| 测试函数 | 断言数 |
|---|---|
| `test_effects_rainbow_hue` | 3378 |
| `vectors` | 3083 |
| `test_effects_static_rgb` | 1044 |
| `test_scene_blob_max_size` | 586 |
| `test_effects_comet_density` | 419 |
| `test_effects_comet_gain` | 304 |
| `test_retired_commands` | 291 |
| `test_gamma` | 285 |
| `test_effects_breathing_phase` | 260 |
| `test_effects_flicker` | 237 |
| `test_effects_breathing_envelope` | 134 |
| `test_compose_uncovered_is_black` | 123 |
| `test_encode_ack_all_results` | 112 |
| `test_apply_level_q8` | 108 |
| `test_set_brightness_reducer` | 100 |
| `test_effects_off` | 95 |
| `test_set_led_count_reducer` | 92 |
| `test_effects_breathing_gain_and_pixel` | 84 |
| `test_state_blob` | 79 |
| `test_scene_commands` | 78 |
| `test_two_layer_single_layer_regression` | 76 |
| `test_save_scheduler` | 71 |
| `test_effects_rainbow_comet_coexist` | 69 |
| `test_effects_strobe` | 69 |
| `test_part_clock_loop_last` | 69 |
| `test_led_count_job` | 58 |
| `test_effects_comet_solid_tail` | 53 |
| `test_planar_round_robin` | 52 |
| `test_layout_commands` | 49 |
| `test_effects_dispatch` | 47 |
| `test_set_power_reducer` | 47 |
| `test_encode_event_storage_failed` | 45 |
| `test_encode_v5_reports` | 44 |
| `test_per_strip_led_counts_30_60_10` | 42 |
| `test_encode_strip_config_report` | 38 |
| `test_layout_blob_roundtrip` | 37 |
| `test_layout_blob_rejects_bad` | 35 |
| `test_blend_gamma_once` | 34 |
| `test_compose_multi_segment_shared_phase` | 32 |
| `test_selftest_cancel_rules` | 32 |
| `test_selftest_compose` | 31 |
| `test_layer_codec` | 30 |
| `test_selftest_sequence` | 30 |
| `test_effects_heartbeat` | 29 |
| `test_layout_part_name_padding` | 29 |
| `test_reasm_orphan_and_helpers` | 29 |
| `test_effects_new_types_validation` | 28 |
| `test_scene_blob_roundtrip` | 28 |
| `test_per_strip_led_counts_100_24` | 27 |
| `test_two_layer_validation_matrix` | 27 |
| `test_state_defaults_and_clamp` | 26 |
| `test_strip_mask_allows` | 24 |
| `test_effects_rainbow_pixel` | 23 |
| `test_scene_blob_rejects_bad` | 23 |
| `test_blend_math` | 22 |
| `test_compose_null_safety` | 22 |
| `test_layout_seg_rejects_overlap` | 22 |
| `test_layout_write_clears` | 21 |
| `test_set_strip_power_command` | 21 |
| `test_compose_part_switch` | 20 |
| `test_gamma_hue_loss_clip` | 20 |
| `test_layout_multi_segment_logical_index` | 19 |
| `test_compose_needs_frames` | 18 |
| `test_scene_encode_capacity` | 18 |
| `test_state_bytes_layout` | 18 |
| `test_compose_isolated_parts` | 17 |
| `test_layout_part_of_pixel` | 17 |
| `test_scene_set_step_rules` | 17 |
| `test_encode_device_info_report` | 16 |
| `test_scene_set_part_clears` | 16 |
| `test_reject_v2_protocol_frames` | 15 |
| `test_scene_loop_and_clock` | 15 |
| `test_layout_validate_whole` | 14 |
| `test_part_clock_basics` | 14 |
| `test_reasm_multi_chunk` | 14 |
| `test_reasm_timeout` | 14 |
| `test_two_layer_shared_phase` | 14 |
| `test_planar_parse_list` | 13 |
| `test_layer_level_validation` | 12 |
| `test_part_clock_no_drift` | 12 |
| `test_planar_init_validation` | 12 |
| `test_planar_set_count` | 12 |
| `test_reasm_overflow` | 12 |
| `test_layout_partial_write` | 11 |
| `test_set_strip_power_validation_edges` | 11 |
| `test_checksum` | 10 |
| `test_compose_phase_not_reset_by_edit` | 10 |
| `test_decode_bad_frames_echo_header` | 10 |
| `test_effects_new_types_animation` | 10 |
| `test_planar_stats` | 10 |
| `test_selftest_restart` | 10 |
| `test_breathing_floor_is_level_times_min_pct` | 9 |
| `test_compose_two_layers` | 9 |
| `test_decode_max_payload` | 9 |
| `test_global_power_leaves_strip_mask` | 9 |
| `test_layout_seg_range` | 9 |
| `test_selftest_leaves_state_untouched` | 9 |
| `test_two_layer_needs_frames` | 9 |
| `test_reasm_first_reentry` | 8 |
| `test_planar_null_safety` | 7 |
| `test_scene_layer_sizes` | 7 |
| `test_part_clock_no_loop` | 6 |
| `test_scene_sizes` | 6 |
| `test_encode_limits` | 5 |
| `test_layout_sizes` | 5 |
| `test_level_times_brightness_then_gamma_once` | 5 |
| `test_reasm_single_chunk` | 5 |
| `test_selftest_late_wake` | 5 |
| `test_decode_short` | 4 |
| `test_strip_tdm_plan` | 4 |
| `test_two_layer_ram_sizes` | 4 |
| `test_layer_level_static_steps` | 3 |
| `test_part_clock_zero_steps` | 3 |
| `test_layer_level_independent_per_layer` | 2 |

### 固件 host 测试

| 文件 | 覆盖 | 用例数 |
|---|---|---|
| `firmware/test/test_skeleton.c` | 固件 host 测试全量：v5 协议向量逐字节（含 14 条 retired_* 退役命令必须回 0x02）、命令 reducer 语义（整机 / 灯组 / 布局 0x20-0x24 / 场景 0x25-0x29）、State 32 字节与 blob v6、布局 blob LML1 与场景 blob LMS5 的往返与损坏拒绝、CRC、分片重组、gamma、灯效两层合成与层亮度、播放头推进与唯一渲染接缝 lumen_scene_compose | 12976 |
| `scripts/check-protocol-testvectors-v4.mjs` | v4 向量与 protocol-v4.md 的独立一致性校验（保留对照：v4 已作废但仍可回归）。不走生成器，专门抓生成器的错 | 12976 |
| `scripts/check-protocol-testvectors-v5.mjs` | v5 向量与 protocol-v5.md 的独立一致性校验：帧宽 / magic / version、命令表载荷宽度、退役命令必须回 0x02、布局与场景语义约束、层编码规则、State 32 字节布局、报告宽度与 0x0500 版本、分片重组。不走生成器，专门抓生成器的错 | 12976 |

### 小程序单测

| 文件 | 覆盖 | 用例数 |
|---|---|---|
| `miniprogram/tests/add-device.test.ts` | 发现页搜索匹配、名称预填、已添加判定与信号条 | 21 |
| `miniprogram/tests/app-config.test.ts` | app.json 配置契约、路由常量一致、WXML 绑定在脚本里有同名方法 | 10 |
| `miniprogram/tests/brightness.test.ts` | 亮度纯函数、100Hz 到 20Hz 的 latest-wins、亮度与开关解耦 | 13 |
| `miniprogram/tests/chunk.test.ts` | 分片容量计算、单帧构造、分片重组器 | 24 |
| `miniprogram/tests/codec.test.ts` | v5 协议向量（111 条，含 14 条退役命令必须回 0x02）、CRC16、分片重组、232/240 帧长上限、32 字节 State 示例 | 20 |
| `miniprogram/tests/color.test.ts` | HSV 到用户空间 RGB 的换算、颜色语义纯函数、写进选中段 | 9 |
| `miniprogram/tests/commands.test.ts` | v5 命令构造器与解析器：整机 / 灯组 / 布局族 0x20-0x24 / 场景族 0x25-0x29 的载荷宽度与范围校验，层编码 9 字节，名字 UTF-8 编解码，三条新报告的字节布局，以及 v4 入口已整体删除 | 32 |
| `miniprogram/tests/delete-device.test.ts` | 删除设备是一组动作：断开 + 清缓存 + 清最近 + 清登记 + 清灯组元数据（含封面）+ 删封面文件；会话为 null / 连的是别的设备 / 断开抛错都继续清；演示设备额外写「显式删除过」标记；v5 无方案草稿所以 planDraftsCleared 恒为 0 | 12 |
| `miniprogram/tests/describe.test.ts` | 日志描述器对齐 v5：两族新命令的参数文本、32 字节 State（无 RGB / 无播放位置）、0x89-0x8D 五条新报告、v4 四条报告已删除 | 23 |
| `miniprogram/tests/device-api.test.ts` | 设备接口请求形状、重试、身份头，以及断网时的降级 | 36 |
| `miniprogram/tests/device-info-page.test.ts` | 设备信息页的逐组灯珠数 / 自检 / 身份：每灯组一条 1–100 滑块（上下界来自协议常量）、拖动只改本地值、松手才发 SetLedCount 且只改目标组、缩小会截断部位时先确认、非法值钳位、未连接不发帧；自检发一帧 0x07 且不改 State；hwId / 固件 / 能力 / 五条上限都来自 QueryDeviceInfo | 14 |
| `miniprogram/tests/device-list.test.ts` | 本地优先的设备列表合并、已知标记、扫描行派生 | 18 |
| `miniprogram/tests/device-page-actions.test.ts` | 设备页自己的事件处理器真的把命令发到设备：电源键翻 power 位且不动亮度、松手下发 SetBrightness（拖动中 20Hz 节流且不绑值）、亮度按设备 maxBrightness 钳位且不碰开关、灯组开关只翻一位且不影响别的组、部位开关只改 on 一位（步数与循环不变） | 14 |
| `miniprogram/tests/device-photo.test.ts` | 设备封面存储映射 | 9 |
| `miniprogram/tests/device-registry.test.ts` | 设备登记表默认值、备注名、启用掩码 | 17 |
| `miniprogram/tests/device-scenes.test.ts` | #159 三个场景（走真实页面处理器）：场景条画出 3 个并标出当前、点一下就切且设备 activeScene 跟着变、来回切 10 次不累积、点已选的场景不发帧、三个场景各自不同的时间轴互不影响、A 场景关掉的部位切到 B 再切回 A 仍然关着（开关属于场景）、0 步的部位不出现在读回里、改名落到设备与界面、清缓存后能从设备读回、空名与超 24 字节被拒、改名预填、未连接时不响应、三场景全空时给引导 | 16 |
| `miniprogram/tests/device-sync.test.ts` | 本地先写再同步后端，同步失败不阻塞本地 | 25 |
| `miniprogram/tests/deviceSwitch.test.ts` | 设备切换状态机、失败路径、最近连过列表 | 33 |
| `miniprogram/tests/effect-types.test.ts` | 灯效类型清单的单一真相：KNOWN_EFFECT_TYPES 覆盖 EFFECT_TYPE 的每种真实灯效、空层不算、未知值 (0x08/0x99) 不算、八项清单与枚举一一对应且名字不带颜色词、协议值 ↔ 面板类型双向稳定 | 8 |
| `miniprogram/tests/errors.test.ts` | 错误分流与面向用户的错误文案 | 9 |
| `miniprogram/tests/home-actions.test.ts` | 首页搜索、长按菜单、亮度防抖后再下发 | 21 |
| `miniprogram/tests/home-view.test.ts` | 首页卡片派生视图与封面图回退 | 21 |
| `miniprogram/tests/ledCount.test.ts` | 灯珠数输入校验、回执分支、超时处理 | 19 |
| `miniprogram/tests/log-panel.test.ts` | 点击序列模型与日志面板视图同源 | 13 |
| `miniprogram/tests/log.test.ts` | 帧日志环形缓冲 | 3 |
| `miniprogram/tests/loop-mode.test.ts` | 循环三档真的到达设备（v5 宿主 = 部位）：ScenePart 的 loop 字节就是入参、三档互不相同、写完读回就是那一档、改循环不重写步数、关部位不动循环档、越界档位不发帧、写成功作废场景读回缓存而失败保留 | 13 |
| `miniprogram/tests/migrations.test.ts` | #161 旧世界清理：v4 的方案草稿 / 旧演示开关 / 旧档位键在首次启动时被删、本来不存在的键不算删掉、只删白名单里的键（未知键不碰）、**灯组名与封面逐字节保留（P3）**、保留清单与退役清单不重叠、只跑一次（第二次 skipped）、标记是 JSON 数组且保留别的迁移 id、标记坏掉当作没跑过、重复 mark 不产生重复 id | 10 |
| `miniprogram/tests/mock-mode.test.ts` | 演示传输层与真机传输层同形、演示数据播种、开关收敛 | 30 |
| `miniprogram/tests/mock-session.test.ts` | 演示模式会话级连通性：connect 后 ready 与 State、QueryDeviceInfo / QueryStripConfig / QueryLayout / QueryScene 都读回设备权威值、开关与亮度真的生效、自检不改状态、切换设备、断开清空；扫描出三台演示设备；播种写真实存储键；逐组灯珠数与灯组开关掩码；循环三档在会话层生效 | 17 |
| `miniprogram/tests/module-resolution.test.ts` | 禁止相对导入指向目录（静态扫描全仓 import），自带变异测试 | 3 |
| `miniprogram/tests/page-fields.test.ts` | 页面的非 data 字段必须在 onLoad 初始化（静态扫描），自带变异测试 | 3 |
| `miniprogram/tests/page-harness.test.ts` | 页面测试底座自查：wx 桩的存储与 toast / modal 记录、事件构造器形状、六个页面都能被捕获注册、能注入已连上的演示会话、settle 不卡满超时、收尾真的解绑 | 6 |
| `miniprogram/tests/page-runtime.test.ts` | 页面测试底座自身：路径键、data 独立性、渲染期桩、waitFor 语义 | 9 |
| `miniprogram/tests/panel-unit.test.ts` | #154 效果面板单元可独立驱动：给一层效果 → 切类型（保留颜色与亮度）、改滑块与选择项、按目标记住未下发的亮度、叠加层独立草稿、装配成两层、爆闪频率与心跳节奏的本地预检；并锁住参数控件定义只在 effect-panel 一份 | 37 |
| `miniprogram/tests/part-layers.test.ts` | #158 两层与叠加开关：新步骤的叠加层是空层、打开后 layer1 变成真实效果、关掉回到空层、界面里没有任何混合方式字样（E6 由系统决定）、没内容的步骤禁用叠加开关、两层的 level 各自独立；相位模式两个选项都能选/都落到设备/改相位不丢灯珠段/不动别的部位（每部位一份，S6） | 11 |
| `miniprogram/tests/part-layout.test.ts` | 部位布局的固件规则镜像：区间合法性与闭区间相接、跨部位与同部位内互斥（编辑忽略自己那一段）、连续 / 各自起点两种相位的逻辑下标（段序乱写也正确）+ 反函数、归属表与灰缝、方格表折列（对齐十年段只能向下、窄屏保底、灯珠不足不硬凑）与最近一格命中、线视图色块比例与颜色稳定、整份校验的判定顺序（越界先于冲突）、段表增删改与读回补全 | 42 |
| `miniprogram/tests/part-page.test.ts` | 部位编辑页真的用上两个单元：时间轴块来自 timelineUnitView、改时长与点刻度经 applyTimelineDuration / setTimelineDuration、切类型与改滑块经 panel-unit（参数区按类型整体替换）、下发把 panelUnitLayers 装配的两层送到设备、部位开关只改 on 位、结构区改名整份重写布局且不抹掉别的部位、名字 24 字节 UTF-8 校验 | 18 |
| `miniprogram/tests/part-structure.test.ts` | 部位页结构区（走真实页面处理器）：线视图与该部位占的灯珠一致、方格拖选成段落库（含反向拖动）、多段不连续、数字滚轮微调到单颗、压到别的部位时整段被拒且设备一帧未收到、被占格子画斜纹、点已有段弹编辑 / 删除且删除后变灰缝、点编辑只改这一段且不动别的部位、越界与超段数的本地拒绝 | 13 |
| `miniprogram/tests/part-timeline.test.ts` | 每部位独立时间轴（走真实页面处理器）：设备 0 步时给默认步、多步读回时时间轴一块对一步、加一步立刻下发且新步是 1 秒常亮、删当前步后设备步数 -1 且选中下标被钳住、只剩一步与满 8 步时拒绝、选中别的步时面板换那一步的参数而不改另一组 | 7 |
| `miniprogram/tests/profile.test.ts` | 本机身份（头像与昵称）的存储纯逻辑 | 17 |
| `miniprogram/tests/protocol-v98.test.ts` | 流星密度与实色拖尾 flags、随机闪烁层编码、循环三值挂在 ScenePart 上（§7.5） | 11 |
| `miniprogram/tests/reconnect.test.ts` | 断线反映、退避重连、重订阅通知、进前台静默回连 | 35 |
| `miniprogram/tests/scan-filter.test.ts` | 本产品设备名判定、扫描过滤、不带系统级服务 | 9 |
| `miniprogram/tests/scene-bar.test.ts` | #159 场景条纯逻辑：空名回落成「场景 N」、改名校验（空 / 24 字节 / 中文 3 字节）、三个按钮始终画出来（读不到也不消失）、hasContent 看有部位带步骤、切场景的越界与重复点击语义、名字以设备为准（读到空名就清空、读不到才保留本地）、空态提示只在三个都读到且都空时出现 | 12 |
| `miniprogram/tests/selftest.test.ts` | 自检帧与会话自检入口 | 6 |
| `miniprogram/tests/session-strip.test.ts` | 灯带维度必须显式传参（setStripPower / queryLayout）、断线与切设备清空逐带布局缓存 | 13 |
| `miniprogram/tests/session-v3.test.ts` | 逐带开关、引脚表、逐带灯珠数、当前灯组 | 13 |
| `miniprogram/tests/strip-head.test.ts` | 固定三套方案、拨盘刻度、灯珠数胶囊文案 | 21 |
| `miniprogram/tests/strip-meta.test.ts` | 灯组名称与封面存取、键与设备隔离 | 19 |
| `miniprogram/tests/switch-hierarchy.test.ts` | #160 开关层级：灯组开关只翻 strip_power_mask 那位且不动别的链、部位开关只改场景里的 on 且不动灯组掩码、只改 on 一位（步数与循环不动）、关掉再开不退回第 1 步、**父关再开后原来关着的部位仍然关着（T9）**、父开关全程不写场景数据、部位开关跟着场景切换还原、三个场景各记各的、页面上没有播放/暂停按钮。这一票不需要改代码——两层住在不同的表里，所以测的是「以后别把两者并进同一张表」 | 11 |
| `miniprogram/tests/test-manifest.test.ts` | 测试清单查漏工具自身：通配收集、未登记/已删/层不一致/空说明四类问题，自带变异测试 | 15 |
| `miniprogram/tests/test-run.test.ts` | 测试编排器自身：三态语义、报告六段、退出码，固件输出解析，vitest 结构化输出与 tsc 报错的按文件解析，以及发布级归档（未覆盖警告、目录唯一、基线池分开） | 116 |
| `miniprogram/tests/theme-sync.test.ts` | 雾蓝主色、无橙色残留、原生控件激活色、显示时重读主题 | 20 |
| `miniprogram/tests/theme.test.ts` | 双主题变量、无硬编码色、主题配置与 app.json 一致 | 7 |
| `miniprogram/tests/throttle.test.ts` | 20Hz latest-wins 节流 | 5 |
| `miniprogram/tests/timeline-unit.test.ts` | #154 时间轴单元可独立驱动：步骤集 → 渲染（块宽/时长文字/色带）、选中与钳位、长按 300ms → 拖动 → 松手给 from→to、代次作废迟到的长按回调、拖出界回到源下标、改时长与「秒 → 毫秒」入口；并锁住页面不自己调 layoutBlocks / timelineRowWidth / chooseGap | 31 |
| `miniprogram/tests/timeline.test.ts` | 时间轴与时长纯几何：水位法宽度分配、最小宽度保底与均分兜底、行宽恒等于容器宽（永不横向滚动）、落点命中、重排与选中跟随、缩略色带、长按阈值与拖动位移映射、时长钳位与三刻度；页面只是单元的调用方 | 112 |
| `miniprogram/tests/transport.test.ts` | 分片与重组、MTU、状态读取回落、单帧查询 | 21 |
| `miniprogram/tests/usage.test.ts` | 使用日志写入、离线补报、幂等 | 44 |
| `miniprogram/tests/writer.test.ts` | 写入器单飞与先进先出 | 3 |

### 后端单测

| 文件 | 覆盖 | 用例数 |
|---|---|---|
| `server/tests/aggregation.test.ts` | 使用日志的聚合查询与视图数据 | 15 |
| `server/tests/api.test.ts` | HTTP 路由与鉴权契约 | 13 |
| `server/tests/devices.test.ts` | 设备登记、归属与设备键归一 | 36 |
| `server/tests/readonly.test.ts` | 只读看板对写方法的拒绝 | 44 |
| `server/tests/schema-migration.test.ts` | 数据库结构与迁移 | 11 |
| `server/tests/session.test.ts` | 微信 code2session 与会话身份，注入假网络调用 | 21 |

### 真机 e2e

| 文件 | 覆盖 | 用例数 |
|---|---|---|
| `miniprogram/tests/e2e/real-device.test.ts` | v5 真机往返：32 字节 State、SetPower / SetBrightness、布局写入与读回、越界段被设备拒绝、每带开关、DeviceInfo 的五个上限 | — |

## 失败详情

本轮没有失败。

## 与上次运行

对比基线：`2026-11-05T04-34-55-393`（2026-11-05T04:34:55.393Z）

### 新出现的跳过（1 项）

- **真机 e2e**（整层）：收到 DeviceInfoReport 0x88

### 用例数变化（14 个文件）

| 文件 | 上次 | 本次 | 差值 |
|---|---|---|---|
| `firmware/test/test_skeleton.c` | 13996 | 12976 | -1020 |
| `miniprogram/tests/color.test.ts` | 14 | 9 | -5 |
| `miniprogram/tests/commands.test.ts` | 29 | 32 | +3 |
| `miniprogram/tests/delete-device.test.ts` | 9 | 12 | +3 |
| `miniprogram/tests/describe.test.ts` | 17 | 23 | +6 |
| `miniprogram/tests/effect-types.test.ts` | 6 | 8 | +2 |
| `miniprogram/tests/loop-mode.test.ts` | 17 | 13 | -4 |
| `miniprogram/tests/mock-mode.test.ts` | 28 | 30 | +2 |
| `miniprogram/tests/mock-session.test.ts` | 29 | 17 | -12 |
| `miniprogram/tests/protocol-v98.test.ts` | 19 | 11 | -8 |
| `miniprogram/tests/session-v3.test.ts` | 15 | 13 | -2 |
| `miniprogram/tests/test-run.test.ts` | 115 | 116 | +1 |
| `miniprogram/tests/timeline.test.ts` | 119 | 112 | -7 |
| `scripts/check-protocol-testvectors-v4.mjs` | 13996 | 12976 | -1020 |

### 新增文件（15 个）

- `miniprogram/tests/device-info-page.test.ts`（mp 层，本次 14 用例）
- `miniprogram/tests/device-page-actions.test.ts`（mp 层，本次 14 用例）
- `miniprogram/tests/device-scenes.test.ts`（mp 层，本次 16 用例）
- `miniprogram/tests/migrations.test.ts`（mp 层，本次 10 用例）
- `miniprogram/tests/page-harness.test.ts`（mp 层，本次 6 用例）
- `miniprogram/tests/panel-unit.test.ts`（mp 层，本次 37 用例）
- `miniprogram/tests/part-layers.test.ts`（mp 层，本次 11 用例）
- `miniprogram/tests/part-layout.test.ts`（mp 层，本次 42 用例）
- `miniprogram/tests/part-page.test.ts`（mp 层，本次 18 用例）
- `miniprogram/tests/part-structure.test.ts`（mp 层，本次 13 用例）
- `miniprogram/tests/part-timeline.test.ts`（mp 层，本次 7 用例）
- `miniprogram/tests/scene-bar.test.ts`（mp 层，本次 12 用例）
- `miniprogram/tests/switch-hierarchy.test.ts`（mp 层，本次 11 用例）
- `miniprogram/tests/timeline-unit.test.ts`（mp 层，本次 31 用例）
- `scripts/check-protocol-testvectors-v5.mjs`（firmware 层，本次 12976 用例）

### 消失文件（29 个）

- `miniprogram/tests/advanced-draft.test.ts`（mp 层，上次 22 用例）
- `miniprogram/tests/advanced-layers.test.ts`（mp 层，上次 23 用例）
- `miniprogram/tests/e2e/complex-plan.test.ts`（ble 层，上次 8 用例）
- `miniprogram/tests/e2e/page-click.test.ts`（ble 层，上次 5 用例）
- `miniprogram/tests/effect-layout.test.ts`（mp 层，上次 60 用例）
- `miniprogram/tests/effect-panel.test.ts`（mp 层，上次 87 用例）
- `miniprogram/tests/effect-view.test.ts`（mp 层，上次 39 用例）
- `miniprogram/tests/led-count-plan.test.ts`（mp 层，上次 23 用例）
- `miniprogram/tests/led-count-ui.test.ts`（mp 层，上次 20 用例）
- `miniprogram/tests/led-picker.test.ts`（mp 层，上次 84 用例）
- `miniprogram/tests/plan-drafts.test.ts`（mp 层，上次 36 用例）
- `miniprogram/tests/plan-editor.test.ts`（mp 层，上次 23 用例）
- `miniprogram/tests/plan-fill.test.ts`（mp 层，上次 11 用例）
- `miniprogram/tests/plan-slots.test.ts`（mp 层，上次 39 用例）
- `miniprogram/tests/quick-effects.test.ts`（mp 层，上次 49 用例）
- `miniprogram/tests/quick-selection.test.ts`（mp 层，上次 16 用例）
- `miniprogram/tests/script-capacity.test.ts`（mp 层，上次 16 用例）
- `miniprogram/tests/script-session.test.ts`（mp 层，上次 20 用例）
- `miniprogram/tests/script-view.test.ts`（mp 层，上次 26 用例）
- `miniprogram/tests/scripts.test.ts`（mp 层，上次 23 用例）
- `miniprogram/tests/segment-color.test.ts`（mp 层，上次 16 用例）
- `miniprogram/tests/segment-editor.test.ts`（mp 层，上次 42 用例）
- `miniprogram/tests/segments.test.ts`（mp 层，上次 40 用例）
- `miniprogram/tests/simple-effects.test.ts`（mp 层，上次 25 用例）
- `miniprogram/tests/strip-simple.test.ts`（mp 层，上次 29 用例）
- `miniprogram/tests/zone-axis.test.ts`（mp 层，上次 48 用例）
- `miniprogram/tests/zone-editor.test.ts`（mp 层，上次 34 用例）
- `miniprogram/tests/zone-model.test.ts`（mp 层，上次 20 用例）
- `miniprogram/tests/zone-preview.test.ts`（mp 层，上次 15 用例）

### 层变化（1 层）

| 层 | 上次 | 本次 | 上次用例数 | 本次用例数 |
|---|---|---|---|---|
| 真机 e2e | ✅ PASS | ⏭️ SKIP | 21 | — |

### 无法比对（1 个文件）

- `miniprogram/tests/e2e/real-device.test.ts`：上次 8，本次 —（有一侧没拿到用例数）

本次共比对 54 个测试文件的用例数。

