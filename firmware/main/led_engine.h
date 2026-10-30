#pragma once

#include <stdbool.h>
#include <stdint.h>

#include "esp_err.h"

#include "protocol.h"
#include "segment_store.h"
#include "state.h"
#include "state_store.h"

/*
 * led_engine：共享状态的唯一所有者 + latest-wins 邮箱 + 渲染任务 + 段配置。
 *
 * 依赖方向：ble_link → led_engine → {effects, segment_store, state_store}。
 * led_engine 不调用任何 BLE API。
 * 灯带句柄只在渲染任务里使用：`led_strip_del` 旧句柄与 `led_strip_new_rmt_device`
 * 新句柄都只在渲染任务里执行（协议 §11.3 的异步重建）。
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

/* 把共享状态编码成 LUMEN_STATE_BYTES(14) 字节 State（docs/protocol.md §7），
 * 供 State read 使用。 */
void lumen_led_engine_state_bytes(uint8_t out[LUMEN_STATE_BYTES]);

/* 拷贝一份共享状态快照。 */
void lumen_led_engine_snapshot(lumen_state_t *out);

/*
 * 提交一份新状态：写入共享状态与 latest-wins 邮箱、置 dirty、发渲染信号，
 * 并请求 state_store 做 500ms debounce 持久化。
 *
 * command 是触发这次变更的命令字，只用于 NVS 写失败时的 Event 0x81 detail
 * （docs/protocol.md §10.3）；持久化内容本身是整份快照（状态 + 段配置）。
 */
void lumen_led_engine_commit(const lumen_state_t *next, uint8_t command);

/*
 * 段配置写入 / 清除（#25）。命令层已按 §11.3 第 4-9 步校验过参数，
 * 引擎在锁内做最终写入（防御性再校验一次）、重算 State 摘要
 * （seg_count 与字节 2-4 的 seg 0 基准色）、唤醒渲染并请求持久化。
 *
 * 返回 LUMEN_RESULT_OK 或 LUMEN_RESULT_INVALID_PARAM。
 * ACK 由调用方在返回后立即发出（段配置是 O(1) 的内存写，不需要等渲染）。
 */
uint8_t lumen_led_engine_set_segment(uint8_t strip_id, uint8_t seg_id,
                                     const lumen_segment_t *segment, uint8_t command);
uint8_t lumen_led_engine_clear_segment(uint8_t strip_id, uint8_t seg_id, uint8_t command);

/*
 * 拷出整份段配置快照（命令层做 §11.3 第 5-9 步校验用）。
 * 快照 1KB，只在 BLE 回调里拷贝，不唤醒渲染任务。
 */
void lumen_led_engine_segments_snapshot(lumen_segment_store_t *out);

/*
 * 拷出某灯带的活动段（QueryStrip → SegmentReport 用）。
 *
 * out 按 seg_id 升序填充活动段，最多 cap 个；返回写入个数。
 * 该函数在调用者上下文拷贝快照，不唤醒渲染任务。
 */
uint8_t lumen_led_engine_segments(uint8_t strip_id, lumen_segment_t *out, uint8_t cap);

/* 某灯带的 seg_mask（SegmentListEnd 用）。 */
uint8_t lumen_led_engine_segment_mask(uint8_t strip_id);

/* 注册 NVS 写失败回调（参数是触发写入的命令字）。BLE 层用它发 Event 0x81。 */
void lumen_led_engine_set_store_event_cb(lumen_store_event_cb cb);

/*
 * 请求把灯珠数量改为 count（调用方保证 1-64 已由命令层校验）。
 *
 * 返回：
 *   LUMEN_RESULT_OK            与当前数量相同，无需重建；调用方立即回 ACK 0x00；
 *   LUMEN_RESULT_BUSY          已有重建在排队/进行中（§11.3：不排队）；回 0x05；
 *   LUMEN_LED_ENGINE_DEFERRED  已排队；渲染任务重建完成后经 response 回执。
 *
 * 数量要等句柄重建成功后才写入共享状态；失败时旧句柄与旧数量原样保留。
 * 重建成功后会裁剪越界的段（end >= 新数量 → 该段失效，不自动缩短）。
 */
uint8_t lumen_led_engine_set_led_count(uint16_t count, uint8_t seq);

/*
 * #29：按灯带设置灯珠数。strip 0 与上面的单参数版本等价（走句柄重建）；
 * strip 1..7 只改该条的 count（TDM 共用一个按 max_count 建的句柄），
 * 同步完成并直接回 ACK 0x00 / 0x01（越界或灯带不存在）。
 */
uint8_t lumen_led_engine_set_led_count_for_strip(uint8_t strip_id, uint16_t count, uint8_t seq);

/* 当前生效的亮度上限（构建期常量）。 */
uint8_t lumen_led_engine_max_brightness(void);

/*
 * 自检（协议 §11.2）：红 → 绿 → 蓝 → 白，每色 500ms，2s 后自动结束。
 *
 * 自检是渲染层的临时覆盖：不写共享状态、不写 NVS、不改 s_state；结束后
 * 渲染任务自动回到存储状态（关灯态回关灯）。即使存储状态是关灯，自检
 * 期间也会点亮，亮度取当前 max_brightness。自检期间一律显示单色，不用分段。
 *
 * 调用顺序（ble_link 在命令分发后）：先 cancel（如命令改变状态）或 start，
 * 再 commit 新状态。重复 start 会重新从红色计时。
 */
void lumen_led_engine_start_selftest(void);

/*
 * 立即取消自检并重绘存储状态；未在自检时无副作用。
 * 返回 true 表示确实停掉了一个进行中的自检——串口日志据此区分
 * 「这条命令取消了自检」与「命令到来时本来就没在自检」，避免排查时误判。
 */
bool lumen_led_engine_cancel_selftest(void);

bool lumen_led_engine_selftest_active(void);
