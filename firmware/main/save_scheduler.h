#pragma once

#include <stdbool.h>
#include <stdint.h>

#include "state.h"

/*
 * 500ms debounce 纯逻辑（可在 host 上用假时钟/假计数单测）。
 *
 * 语义（docs/protocol.md §12）：
 *   - 每次状态变更记录「最新快照 + 触发它的命令字」并把到期时间重置为 now + 500ms；
 *   - 只有到期且期间没有新请求时才允许写一次 NVS；
 *   - 连续拖动亮度/颜色只会写最后一次快照，不逐像素写 flash。
 *
 * 触发它的命令字用于 §10.3 的异步存储失败 Event（载荷 [0x01, 原命令字]）。
 * debounce 合并多帧时报告「最后一份快照对应的命令」，与最终写入内容一致。
 *
 * 时间源由调用方传入 32 位毫秒计数（可回绕）；所有比较用有符号差值，
 * 因此 0xFFFFFFFF → 0 的回绕不会让 debounce 卡死。
 */

#define LUMEN_SAVE_DEBOUNCE_MS 500

typedef struct {
    lumen_state_t snapshot; /* 最新待写快照 */
    uint8_t command;        /* 触发最新快照的命令字 */
    bool pending;           /* 是否有待写快照 */
    uint32_t deadline_ms;   /* 到期时刻（now_ms + debounce） */
} lumen_save_scheduler_t;

void lumen_save_scheduler_init(lumen_save_scheduler_t *sched);

/* 记录最新快照并重置 debounce。指针非法时返回 false。 */
bool lumen_save_scheduler_request(lumen_save_scheduler_t *sched, const lumen_state_t *state,
                                  uint8_t command, uint32_t now_ms);

/*
 * 距离下一次可写还有多少毫秒：0 表示已到期，UINT32_MAX 表示没有待写。
 * 调用方用它决定信号量等待时长。
 */
uint32_t lumen_save_scheduler_next_delay_ms(const lumen_save_scheduler_t *sched,
                                            uint32_t now_ms);

/*
 * 到期取走待写快照（清 pending）。未到期或没有待写时返回 false 且不写 out。
 */
bool lumen_save_scheduler_take_due(lumen_save_scheduler_t *sched, uint32_t now_ms,
                                   lumen_state_t *out, uint8_t *command);

/* 是否有待写快照（只用于测试与日志）。 */
bool lumen_save_scheduler_pending(const lumen_save_scheduler_t *sched);
