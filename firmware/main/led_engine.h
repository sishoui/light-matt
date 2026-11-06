#pragma once

#include <stdbool.h>
#include <stdint.h>

#include "esp_err.h"

#include "layout_store.h"
#include "protocol.h"
#include "scene_compose.h"
#include "scene_store.h"
#include "state.h"
#include "state_store.h"

/*
 * led_engine：共享状态的唯一所有者 + latest-wins 邮箱 + 渲染任务 +
 * 布局 / 场景两张表的权威副本 + 64 个部位的播放头。
 *
 * 依赖方向：ble_link → led_engine → {effects, scene_compose, layout_store,
 * scene_store, state_store}。led_engine 不调用任何 BLE API。
 * 灯带句柄只在渲染任务里使用：`led_strip_del` 旧句柄与 `led_strip_new_rmt_device`
 * 新句柄都只在渲染任务里执行（§11.3 的异步重建）。
 *
 * v5 相比 v4 的结构变化：
 *   - 段表（8 × 8）与剧本表（~70KB）删除，换成**布局**（2696 B）与
 *     **三个场景**（31590 B）+ 64 个播放头（512 B），净省约 35 KB（§11）；
 *   - s_state.led_count 变成逐条数组（State 32 字节，§7.3）；
 *   - 渲染只走 lumen_scene_compose（§9.3）。
 */

/*
 * SetLedCount 的「延迟回执」哨兵：不是协议结果码，绝不能出现在帧里。
 * 收到它表示 ACK 由引擎在渲染任务重建完成 / 失败后通过 response 回调发出。
 */
#define LUMEN_LED_ENGINE_DEFERRED 0xFF

/*
 * 异步回执通道：引擎在渲染任务里（重建完成后）调用它发 ACK。
 * 回调实现由 ble_link 注册；必须是非阻塞的（只做协议编码 + notify 入队），
 * 且不得反向调用会等待渲染任务完成的接口。
 */
typedef void (*lumen_led_engine_response_cb)(uint8_t seq, uint8_t command, uint8_t result);

esp_err_t lumen_led_engine_init(void);

/* BLE 层注册：引擎用它在渲染任务里回 SetLedCount 的异步 ACK。 */
void lumen_led_engine_set_response_cb(lumen_led_engine_response_cb cb);

/* 把共享状态编码成 LUMEN_STATE_BYTES(32) 字节 State（docs/protocol-v5.md §7.3），
 * 供 State read 与 StateReport 使用。逐条灯珠数与部位数在同一临界区内填好。 */
void lumen_led_engine_state_bytes(uint8_t out[LUMEN_STATE_BYTES]);

/* 拷贝一份共享状态快照。 */
void lumen_led_engine_snapshot(lumen_state_t *out);

/*
 * 提交一份新状态：写入共享状态与 latest-wins 邮箱、置 dirty、发渲染信号，
 * 并请求 state_store 做 500ms debounce 持久化。
 *
 * command 是触发这次变更的命令字，只用于 NVS 写失败时的 Event 0x81 detail
 * （docs/protocol-v5.md §10.5）。
 */
void lumen_led_engine_commit(const lumen_state_t *next, uint8_t command);

/* 注册 NVS 写失败回调（参数是触发写入的命令字）。BLE 层用它发 Event 0x81。 */
void lumen_led_engine_set_store_event_cb(lumen_store_event_cb cb);

/* ---------------- 布局（§6.1） ---------------- */

/*
 * 写一条链的部位数并清空其部位（LayoutWrite 0x20 的语义）。
 * 只改 RAM，不落盘——LayoutCommit 才落盘。
 */
uint8_t lumen_led_engine_layout_write(uint8_t strip_id, uint8_t part_count);

/* 写一个部位的名字与段数（LayoutPart 0x21）。 */
uint8_t lumen_led_engine_layout_part(uint8_t strip_id, uint8_t part_id, uint8_t name_len,
                                     const uint8_t *name, uint8_t seg_count);

/*
 * 写一个部位的一段（LayoutSeg 0x22）。跨部位的互斥由引擎在持有布局表时判。
 */
uint8_t lumen_led_engine_layout_seg(uint8_t strip_id, uint8_t part_id, uint8_t seg_id,
                                    uint8_t start, uint8_t end);

/*
 * 整份校验并**立即落盘**（LayoutCommit 0x23）。
 *
 * 成功后：state.layout_valid = 1，part_count 摘要同步，并把该链所有部位的
 * 播放头重置到此刻（§6.1：唯一允许打断时钟的操作）。
 * 落盘失败回 StorageFailed 且 RAM 里的布局保留（不半套生效）。
 */
uint8_t lumen_led_engine_layout_commit(uint8_t command);

/*
 * 读一份布局快照（QueryLayout → LayoutReport 用）。
 * 只在调用者上下文拷贝，不唤醒渲染任务。
 */
void lumen_led_engine_layout_snapshot(lumen_layout_store_t *out);

/* 某链的部位数（State 的 part_count 来源）。 */
uint8_t lumen_led_engine_part_count(uint8_t strip_id);

/* ---------------- 场景（§6.2） ---------------- */

/* 写一个部位的时间轴头（ScenePart 0x25）。只有 step_count 真的变了才清空步骤。 */
uint8_t lumen_led_engine_scene_part(uint8_t scene_id, uint8_t strip_id, uint8_t part_id,
                                    uint8_t step_count, uint8_t loop, uint8_t on,
                                    uint8_t command);

/*
 * 单步增量写入（SceneStep 0x26）。两层是 9 字节定宽线格式，命令层已做形状校验；
 * 这里还判 step_index < step_count（需要场景表的上下文）。
 */
uint8_t lumen_led_engine_scene_step(uint8_t scene_id, uint8_t strip_id, uint8_t part_id,
                                    uint8_t step_index, uint16_t duration_ms,
                                    const uint8_t layer0[9], const uint8_t layer1[9],
                                    uint8_t command);

/* 写场景名（SceneName 0x27）。 */
uint8_t lumen_led_engine_scene_name(uint8_t scene_id, uint8_t name_len, const uint8_t *name,
                                    uint8_t command);

/*
 * 激活场景（ActivateScene 0x28）：硬切 + 全部部位从第 1 步重跳（T3/C4）。
 * 返回 INVALID_PARAM 表示 scene_id 越界；0-2 总是合法（空场景就是全黑）。
 */
uint8_t lumen_led_engine_activate_scene(uint8_t scene_id, uint8_t command);

/* 读一份场景快照（QueryScene → 三条报告用）。 */
void lumen_led_engine_scene_snapshot(uint8_t scene_id, lumen_scene_t *out);

/* 当前激活的场景 id（0-2）。 */
uint8_t lumen_led_engine_active_scene(void);

/* ---------------- 灯珠数与自检 ---------------- */

/*
 * 请求把某条灯带的灯珠数量改为 count（调用方保证 1-100 已由命令层校验）。
 *
 * 返回：
 *   LUMEN_RESULT_OK            与当前数量相同，无需重建；调用方立即回 ACK 0x00；
 *   LUMEN_RESULT_BUSY          已有重建在排队/进行中（§11.3：不排队）；回 0x05；
 *   LUMEN_LED_ENGINE_DEFERRED  已排队；渲染任务重建完成后经 response 回执。
 */
uint8_t lumen_led_engine_set_led_count_for_strip(uint8_t strip_id, uint16_t count, uint8_t seq);

/* 把每条灯带当前的灯珠数填进 out（长度须为 LUMEN_MAX_STRIPS）。 */
void lumen_led_engine_strip_counts(uint16_t out[LUMEN_MAX_STRIPS]);

/* 当前生效的亮度上限（构建期常量）。 */
uint8_t lumen_led_engine_max_brightness(void);

/*
 * 自检（§9.6）：红 → 绿 → 蓝 → 白，每色 500ms，2s 后自动结束。
 *
 * 自检是渲染层的临时覆盖：不写共享状态、不写 NVS。结束后渲染任务自动回到
 * 存储状态。自检期间忽略布局与场景，整条刷自检色。
 */
void lumen_led_engine_start_selftest(void);

/* 立即取消自检并重绘存储状态；未在自检时无副作用。 */
bool lumen_led_engine_cancel_selftest(void);

bool lumen_led_engine_selftest_active(void);
