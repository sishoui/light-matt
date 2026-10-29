#pragma once

#include <stdbool.h>
#include <stdint.h>

#include "state.h"

/*
 * 灯珠数量重建任务的状态机（纯逻辑，可在 host 上单测）。
 *
 * 协议 docs/protocol.md §11.3 要求：
 *   - ACK 必须等 led_strip 句柄重建成功/失败之后才发；
 *   - 重建进行中收到第二个请求 → Busy，不排队；
 *   - 成功才把新数量写入共享状态；失败保留旧数量。
 *
 * 这里只表达「谁在什么时候排队 / 运行 / 完成」，不碰 led_strip、NVS 或锁。
 * led_engine 负责在渲染任务里调用 begin → create_strip → complete：
 * create_strip 成功后才调用 complete(..., true, &state) 改共享状态，
 * 失败时调用 complete(..., false, NULL) 保持状态不变（回滚）。
 */

typedef enum {
    LUMEN_LED_COUNT_ACCEPTED = 0, /* 已排队，ACK 由重建完成后回 */
    LUMEN_LED_COUNT_BUSY,         /* 已有重建在排队/进行中 → 0x05，不排队 */
    LUMEN_LED_COUNT_UNCHANGED,    /* 与当前数量相同，无需重建 → 直接 0x00 */
} lumen_led_count_request_t;

typedef struct {
    bool pending;    /* 已排队，等渲染任务开始 */
    bool running;    /* 渲染任务正在重建句柄 */
    uint16_t target; /* 目标数量（1-64） */
    uint8_t seq;     /* 请求的 seq，用于延迟 ACK 回显 */
} lumen_led_count_job_t;

void lumen_led_count_job_init(lumen_led_count_job_t *job);

/*
 * 请求把数量改为 count（调用方保证 1-64 已校验）。
 * 顺序很重要：先判忙（即使 count 与当前值相同也回 Busy），再判无变化。
 */
lumen_led_count_request_t lumen_led_count_job_request(lumen_led_count_job_t *job, uint16_t count,
                                                      uint16_t current_count, uint8_t seq);

/* pending → running。返回 false 表示当前没有排队的重建。 */
bool lumen_led_count_job_begin(lumen_led_count_job_t *job, uint16_t *target, uint8_t *seq);

/*
 * 结束一次重建。
 *   ok = true：只把 state->led_count 改成目标值，其余字段（开关/亮度/RGB）不动，
 *              返回 true；
 *   ok = false：state 不被修改（调用方传 NULL 即可），返回 false。
 * 无论成功失败都清 running，允许下一次请求。
 */
bool lumen_led_count_job_complete(lumen_led_count_job_t *job, bool ok, lumen_state_t *state);

/* 是否有重建在排队或进行中（Busy 判定）。 */
bool lumen_led_count_job_busy(const lumen_led_count_job_t *job);

/* 目标数量；没有重建时返回 0。 */
uint16_t lumen_led_count_job_target(const lumen_led_count_job_t *job);
