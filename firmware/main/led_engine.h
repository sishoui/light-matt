#pragma once

#include <stdbool.h>
#include <stdint.h>

#include "esp_err.h"

#include "state.h"
#include "state_store.h"

/*
 * led_engine：共享状态的唯一所有者 + latest-wins 邮箱 + 渲染任务。
 *
 * 依赖方向：ble_link → led_engine → state_store。led_engine 不调用任何 BLE API。
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
 * （docs/protocol.md §10.3）；持久化内容本身是整份状态快照。
 */
void lumen_led_engine_commit(const lumen_state_t *next, uint8_t command);

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
 */
uint8_t lumen_led_engine_set_led_count(uint16_t count, uint8_t seq);

/* 当前生效的亮度上限（构建期常量）。 */
uint8_t lumen_led_engine_max_brightness(void);

/*
 * 自检（协议 §11.2）：红 → 绿 → 蓝 → 白，每色 500ms，2s 后自动结束。
 *
 * 自检是渲染层的临时覆盖：不写共享状态、不写 NVS、不改 s_state；结束后
 * 渲染任务自动回到存储状态（关灯态回关灯）。即使存储状态是关灯，自检
 * 期间也会点亮，亮度取当前 max_brightness。
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
