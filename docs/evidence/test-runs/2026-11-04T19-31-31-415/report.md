# 测试报告

> ⚠️ **发布级证据，但本轮发布未覆盖：渲染回归。**
>
> 渲染回归：缺微信开发者工具自动化端口（ws://127.0.0.1:9501：Failed connecting to ws://127.0.0.1:9501, check if target project window is opened with automation enabled）
>
> 这些层本轮没有跑，不能按通过计。下面每一段都是在「上述层未验证」的前提下写的。

- **运行**：2026-11-04T19:31:31.415Z
- **commit**：`6c3b4f5`（分支 `integration/test-flow`，**工作区有未提交改动**）
- **机器**：sishoui · win32 10.0.26200 · 12 核
- **触发了**：firmware / mp / server / ui / ble
- **五层结果**：固件 host 测试 ✅ PASS · 小程序单测 ✅ PASS · 后端单测 ✅ PASS · 渲染回归 ⏭️ SKIP · 真机 e2e ✅ PASS
- **结论**：✅ 通过
- **本轮未验证**：渲染回归

## 分层结果

| 层 | 结果 | 用例数 | 耗时 | 说明 |
|---|---|---|---|---|
| 固件 host 测试 | ✅ PASS | 13996 断言 | 1.4s | 13996 条断言通过 |
| 小程序单测 | ✅ PASS | 1834 用例 | 15.3s | 1834 个用例通过，类型检查干净 |
| 后端单测 | ✅ PASS | 140 用例 | 2.7s | 140 个用例通过，类型检查干净 |
| 渲染回归 | ⏭️ SKIP | — | 345ms | 缺微信开发者工具自动化端口（ws://127.0.0.1:9501：Failed connecting to ws://127.0.0.1:9501, check if target project window is opened with automation enabled） |
| 真机 e2e | ✅ PASS | 16 用例 | 66.3s | 16/16 个用例通过 |

## 未验证清单

- **渲染回归**：缺微信开发者工具自动化端口（ws://127.0.0.1:9501：Failed connecting to ws://127.0.0.1:9501, check if target project window is opened with automation enabled）

## 明细

### 固件 host 测试：按测试函数的断言数

共 117 个测试函数，13996 条断言（按条数降序）。

| 测试函数 | 断言数 |
|---|---|
| `test_effects_rainbow_hue` | 3378 |
| `vectors` | 2732 |
| `test_script_commit_too_large` | 1054 |
| `test_effects_static_rgb` | 1044 |
| `test_script_commit_implies_persistable` | 732 |
| `test_effects_comet_density` | 419 |
| `test_segment_store_compose` | 376 |
| `test_effects_comet_gain` | 304 |
| `test_gamma` | 285 |
| `test_effects_breathing_phase` | 260 |
| `test_effects_flicker` | 237 |
| `test_effects_breathing_envelope` | 134 |
| `test_encode_ack_all_results` | 123 |
| `test_apply_level_q8` | 108 |
| `test_segment_store_compose_100` | 105 |
| `test_retired_commands` | 98 |
| `test_effects_off` | 95 |
| `test_segment_commands` | 95 |
| `test_effects_breathing_gain_and_pixel` | 84 |
| `test_state_blob` | 84 |
| `test_script_playback_loop_last` | 78 |
| `test_set_led_count_reducer` | 77 |
| `test_two_layer_single_layer_regression` | 76 |
| `test_set_brightness_reducer` | 70 |
| `test_effects_rainbow_comet_coexist` | 69 |
| `test_effects_strobe` | 69 |
| `test_segment_real_slots` | 60 |
| `test_effects_comet_solid_tail` | 53 |
| `test_planar_round_robin` | 52 |
| `test_effects_dispatch` | 47 |
| `test_set_power_reducer` | 47 |
| `test_led_count_job` | 46 |
| `test_encode_event_storage_failed` | 45 |
| `test_script_blob_roundtrip` | 43 |
| `test_segment_store_validate` | 42 |
| `test_save_scheduler` | 41 |
| `test_script_store_download` | 41 |
| `test_encode_strip_config_report` | 38 |
| `test_state_blob_v4_two_layers` | 37 |
| `test_script_store_clear` | 36 |
| `test_script_store_prune_strip` | 35 |
| `test_blend_gamma_once` | 34 |
| `test_script_playback_hold_during_selftest` | 34 |
| `test_script_playback_advance` | 33 |
| `test_script_commit_failure_keeps_previous` | 32 |
| `test_selftest_cancel_rules` | 32 |
| `test_selftest_compose` | 31 |
| `test_layer_codec` | 30 |
| `test_selftest_sequence` | 30 |
| `test_effects_heartbeat` | 29 |
| `test_encode_segment_reports` | 29 |
| `test_reasm_orphan_and_helpers` | 29 |
| `test_effects_new_types_validation` | 28 |
| `test_two_layer_validation_matrix` | 26 |
| `test_script_prune_then_blob_roundtrip` | 24 |
| `test_strip_mask_allows` | 24 |
| `test_clear_script_command` | 23 |
| `test_effects_rainbow_pixel` | 23 |
| `test_script_playback_pause_resume` | 23 |
| `test_set_strip_power_command` | 21 |
| `test_gamma_hue_loss_clip` | 20 |
| `test_script_loop_blob_roundtrip` | 20 |
| `test_state_bytes_layout` | 20 |
| `test_per_strip_led_counts_30_60_10` | 19 |
| `test_segment_store_state_summary` | 18 |
| `test_loop_command_values` | 17 |
| `test_per_strip_led_counts_100_24` | 17 |
| `test_script_blob_encode_with_cleared` | 17 |
| `test_blend_math` | 15 |
| `test_encode_device_info_report` | 15 |
| `test_reject_v2_protocol_frames` | 15 |
| `test_script_two_layer_persist` | 15 |
| `test_blob_strip_counts` | 14 |
| `test_reasm_multi_chunk` | 14 |
| `test_reasm_timeout` | 14 |
| `test_two_layer_shared_phase` | 14 |
| `test_planar_parse_list` | 13 |
| `test_script_multiple_scripts` | 13 |
| `test_state_defaults_and_clamp` | 13 |
| `test_layer_level_validation` | 12 |
| `test_planar_init_validation` | 12 |
| `test_planar_set_count` | 12 |
| `test_reasm_overflow` | 12 |
| `test_script_fade_roundtrip` | 12 |
| `test_segment_store_needs_frames` | 11 |
| `test_set_strip_power_validation_edges` | 11 |
| `test_checksum` | 10 |
| `test_decode_bad_frames_echo_header` | 10 |
| `test_effects_new_types_animation` | 10 |
| `test_loop_flag_layout` | 10 |
| `test_planar_stats` | 10 |
| `test_segment_store_prune` | 10 |
| `test_selftest_restart` | 10 |
| `test_state_blob_100_leds` | 10 |
| `test_strip_anim_mask` | 10 |
| `test_breathing_floor_is_level_times_min_pct` | 9 |
| `test_decode_max_payload` | 9 |
| `test_global_power_leaves_strip_mask` | 9 |
| `test_selftest_leaves_state_untouched` | 9 |
| `test_set_segment_uses_own_strip_count` | 9 |
| `test_two_layer_needs_frames` | 9 |
| `test_reasm_first_reentry` | 8 |
| `test_planar_null_safety` | 7 |
| `test_script_clear_slot` | 7 |
| `test_script_should_deactivate` | 7 |
| `test_script_segment_clear_slot_level` | 6 |
| `test_state_blob_per_strip_bounds` | 6 |
| `test_encode_limits` | 5 |
| `test_level_times_brightness_then_gamma_once` | 5 |
| `test_reasm_single_chunk` | 5 |
| `test_script_store_clear_rejects_level` | 5 |
| `test_selftest_late_wake` | 5 |
| `test_decode_short` | 4 |
| `test_strip_tdm_plan` | 4 |
| `test_two_layer_ram_sizes` | 4 |
| `test_layer_level_static_steps` | 3 |
| `test_layer_level_independent_per_layer` | 2 |

### 固件 host 测试

| 文件 | 覆盖 | 用例数 |
|---|---|---|
| `firmware/test/test_skeleton.c` | 固件 host 测试全量：v4 协议向量逐字节、命令 reducer 语义、state 与 CRC、分片重组、gamma、段校验矩阵、剧本容量与 blob 往返、灯效两层合成 | 13996 |
| `scripts/check-protocol-testvectors-v4.mjs` | v4 向量与 protocol-v4.md 的独立一致性校验（帧宽、magic/version、分片重组、结果码、命令覆盖、逐层亮度规则）。不走生成器，专门抓生成器的错；断言数记在固件那层的 run-tests.cmd 输出里，不并入 13996 | 13996 |

### 小程序单测

| 文件 | 覆盖 | 用例数 |
|---|---|---|
| `miniprogram/tests/add-device.test.ts` | 发现页搜索匹配、名称预填、已添加判定与信号条 | 21 |
| `miniprogram/tests/advanced-draft.test.ts` | 进阶草稿纯逻辑：步骤时长、增删重排、多灯组隔离 | 22 |
| `miniprogram/tests/advanced-layers.test.ts` | 进阶档两层模型与八种灯效清单，含灯组页结构断言 | 23 |
| `miniprogram/tests/app-config.test.ts` | app.json 配置契约、路由常量一致、WXML 绑定在脚本里有同名方法 | 10 |
| `miniprogram/tests/brightness.test.ts` | 亮度纯函数、100Hz 到 20Hz 的 latest-wins、亮度与开关解耦 | 13 |
| `miniprogram/tests/chunk.test.ts` | 分片容量计算、单帧构造、分片重组器 | 24 |
| `miniprogram/tests/codec.test.ts` | v4 协议向量、CRC16、载荷与整帧边界 | 20 |
| `miniprogram/tests/color.test.ts` | HSV 到用户空间 RGB 的换算、颜色语义纯函数、写进选中段 | 14 |
| `miniprogram/tests/commands.test.ts` | 命令构造器、状态帧解析、段载荷解析 | 29 |
| `miniprogram/tests/delete-device.test.ts` | 删除设备的六处清理，演示设备删除后不再回来 | 9 |
| `miniprogram/tests/describe.test.ts` | 命令、回执与状态的可读文案 | 17 |
| `miniprogram/tests/device-api.test.ts` | 设备接口请求形状、重试、身份头，以及断网时的降级 | 36 |
| `miniprogram/tests/device-list.test.ts` | 本地优先的设备列表合并、已知标记、扫描行派生 | 18 |
| `miniprogram/tests/device-photo.test.ts` | 设备封面存储映射 | 9 |
| `miniprogram/tests/device-registry.test.ts` | 设备登记表默认值、备注名、启用掩码 | 17 |
| `miniprogram/tests/device-sync.test.ts` | 本地先写再同步后端，同步失败不阻塞本地 | 25 |
| `miniprogram/tests/deviceSwitch.test.ts` | 设备切换状态机、失败路径、最近连过列表 | 33 |
| `miniprogram/tests/effect-layout.test.ts` | 效果区间校验、重叠拦截、默认切分、逐灯珠归属 | 60 |
| `miniprogram/tests/effect-panel.test.ts` | 进阶档效果面板纯逻辑：类型行、参数区、叠加层 | 87 |
| `miniprogram/tests/effect-types.test.ts` | 灯效类型清单与段类型枚举保持同步 | 6 |
| `miniprogram/tests/effect-view.test.ts` | 灯效选项表、层模式文案、应用层类型 | 39 |
| `miniprogram/tests/errors.test.ts` | 错误分流与面向用户的错误文案 | 9 |
| `miniprogram/tests/home-actions.test.ts` | 首页搜索、长按菜单、亮度防抖后再下发 | 21 |
| `miniprogram/tests/home-view.test.ts` | 首页卡片派生视图与封面图回退 | 21 |
| `miniprogram/tests/led-count-plan.test.ts` | 灯珠数收敛与方案收缩的四组输入、受影响分区数 | 23 |
| `miniprogram/tests/led-count-ui.test.ts` | 灯珠数滑块的界面契约（源码结构断言） | 20 |
| `miniprogram/tests/led-picker.test.ts` | 灯珠弹窗纯规则：锚点、区间、取消，以及弹窗结构 | 84 |
| `miniprogram/tests/ledCount.test.ts` | 灯珠数输入校验、回执分支、超时处理 | 19 |
| `miniprogram/tests/log-panel.test.ts` | 点击序列模型与日志面板视图同源 | 13 |
| `miniprogram/tests/log.test.ts` | 帧日志环形缓冲 | 3 |
| `miniprogram/tests/mock-mode.test.ts` | 演示传输层与真机传输层同形、演示数据播种、开关收敛 | 28 |
| `miniprogram/tests/mock-session.test.ts` | 演示模式下的会话级链路 | 29 |
| `miniprogram/tests/module-resolution.test.ts` | 禁止相对导入指向目录（静态扫描全仓 import），自带变异测试 | 3 |
| `miniprogram/tests/page-fields.test.ts` | 页面的非 data 字段必须在 onLoad 初始化（静态扫描），自带变异测试 | 3 |
| `miniprogram/tests/plan-drafts.test.ts` | 方案草稿落盘键、读写、多灯组切片、旧键迁移 | 36 |
| `miniprogram/tests/plan-editor.test.ts` | 方案状态、步骤与灯组切片、空态、术语翻译 | 23 |
| `miniprogram/tests/plan-fill.test.ts` | 下发前补齐其它灯组切片、读回失败不下发 | 11 |
| `miniprogram/tests/plan-slots.test.ts` | 方案空位与最小空位、删除不重排、标签文案 | 39 |
| `miniprogram/tests/profile.test.ts` | 本机身份（头像与昵称）的存储纯逻辑 | 17 |
| `miniprogram/tests/protocol-v98.test.ts` | 流星密度与实色拖尾、随机闪烁命令、循环三值 | 19 |
| `miniprogram/tests/quick-effects.test.ts` | 快捷效果卡片表、档位到协议值、整组方案规格 | 49 |
| `miniprogram/tests/quick-selection.test.ts` | 灯效选中的权威来源，迟到的读回不覆盖刚选的 | 16 |
| `miniprogram/tests/reconnect.test.ts` | 断线反映、退避重连、重订阅通知、进前台静默回连 | 35 |
| `miniprogram/tests/scan-filter.test.ts` | 本产品设备名判定、扫描过滤、不带系统级服务 | 9 |
| `miniprogram/tests/script-capacity.test.ts` | 剧本容量预估四场景、段 id 唯一、帧序 | 16 |
| `miniprogram/tests/script-session.test.ts` | 剧本下发、播放控制、清空剧本命令 | 20 |
| `miniprogram/tests/script-view.test.ts` | 剧本草稿、状态字节的权威来源、进度文案 | 26 |
| `miniprogram/tests/scripts.test.ts` | 剧本命令与向量逐字节、下发计划、进度视图 | 23 |
| `miniprogram/tests/segment-color.test.ts` | 改色保留第二层与混合方式、无缓存时先查询 | 16 |
| `miniprogram/tests/segment-editor.test.ts` | 区间预检、同带重叠、周期下限、层合法性 | 42 |
| `miniprogram/tests/segments.test.ts` | 段编解码向量、逐分区亮度、扁平与两层模型互转 | 40 |
| `miniprogram/tests/selftest.test.ts` | 自检帧与会话自检入口 | 6 |
| `miniprogram/tests/session-strip.test.ts` | 灯组 id 必填、连接后重建、身份切换时清理 | 13 |
| `miniprogram/tests/session-v3.test.ts` | 逐带开关、引脚表、逐带灯珠数、当前灯组 | 15 |
| `miniprogram/tests/simple-effects.test.ts` | 八种灯效、空编码、一行式灯效与滚轮 | 24 |
| `miniprogram/tests/strip-head.test.ts` | 固定三套方案、拨盘刻度、灯珠数胶囊文案 | 21 |
| `miniprogram/tests/strip-meta.test.ts` | 灯组名称与封面存取、键与设备隔离 | 19 |
| `miniprogram/tests/strip-simple.test.ts` | 简单档纯派生、参数区可见性、读回后回填卡片 | 29 |
| `miniprogram/tests/test-manifest.test.ts` | 测试清单查漏工具自身：通配收集、未登记/已删/层不一致/空说明四类问题，自带变异测试 | 15 |
| `miniprogram/tests/test-run.test.ts` | 测试编排器自身：三态语义、报告六段、退出码，固件输出解析，vitest 结构化输出与 tsc 报错的按文件解析，以及发布级归档（未覆盖警告、目录唯一、基线池分开） | 111 |
| `miniprogram/tests/theme-sync.test.ts` | 雾蓝主色、无橙色残留、原生控件激活色、显示时重读主题 | 20 |
| `miniprogram/tests/theme.test.ts` | 双主题变量、无硬编码色、主题配置与 app.json 一致 | 7 |
| `miniprogram/tests/throttle.test.ts` | 20Hz latest-wins 节流 | 5 |
| `miniprogram/tests/timeline.test.ts` | 时间轴时长钳位、宽度比例、最小宽度、布局视图 | 119 |
| `miniprogram/tests/transport.test.ts` | 分片与重组、MTU、状态读取回落、单帧查询 | 21 |
| `miniprogram/tests/usage.test.ts` | 使用日志写入、离线补报、幂等 | 44 |
| `miniprogram/tests/writer.test.ts` | 写入器单飞与先进先出 | 3 |
| `miniprogram/tests/zone-axis.test.ts` | 分区轴按比例定位、块列表、起止手柄 | 48 |
| `miniprogram/tests/zone-editor.test.ts` | 拖动划选、新增预检、快捷切分、增删改 | 34 |
| `miniprogram/tests/zone-model.test.ts` | 建读分区、两层模型、混合方式归一 | 20 |
| `miniprogram/tests/zone-preview.test.ts` | 分区术语统一、预览条颜色、选中态、页面结构 | 15 |

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
| `miniprogram/tests/e2e/complex-plan.test.ts` | 真机复杂剧本端到端：分片下发、大剧本、结束后复位设备 | 8 |
| `miniprogram/tests/e2e/real-device.test.ts` | 真机扫描连接、开关、亮度、颜色、断线重连后继续播放 | 8 |

## 失败详情

本轮没有失败。

## 与上次运行

对比基线：`2026-11-04T19-29-50-569`（2026-11-04T19:29:50.569Z）

**无变化**：本次比对了 81 个测试文件的用例数，与上次一致；也没有新出现的失败或跳过。


