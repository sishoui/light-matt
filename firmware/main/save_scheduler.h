#pragma once

#include <stdbool.h>
#include <stdint.h>

#include "state.h"

/*
 * 按 key 的 debounce 纯逻辑（可在 host 上用假时钟单测）。
 *
 * v5 有**五个**独立持久化键（docs/protocol-v5.md §10.5）：
 *   state（32 B，500 ms）| layout（4096 B，0 ms）| scene0/1/2（12288 B，2 s）
 *
 * 所以调度器不再是 v4 的「单键单快照」。这里按 key 存**一份指针 + 长度 +
 * 到期时刻**，blob 内存归调用方所有——**绝不在本结构里放值拷贝**：
 *   - 12 KB 的场景 blob 放进按值拷贝的结构会被两份地拷进 5120 字节的存储
 *     任务栈（seams.md §B7 已算过只剩约 1.8 KB 余量），必然爆栈；
 *   - commit 路径在 NimBLE 主机任务（4 KB 栈）里，同样不能再放一份。
 *
 * 语义（§10.5）：
 *   - 每次 request 记录「最新 blob 指针 + 长度 + 触发命令字」并把到期时间重置为
 *     now + debounce；
 *   - 只有到期且期间没有新请求时才允许写一次 NVS；
 *   - 连续编辑同一个键只写最后一次快照。
 *
 * 时间源由调用方传入 32 位毫秒计数（可回绕）；所有比较用有符号差值，
 * 因此 0xFFFFFFFF → 0 的回绕不会让 debounce 卡死。
 */

#define LUMEN_SAVE_DEBOUNCE_MS 500
/* 场景键的 debounce（§10.5 E4：2 秒）。布局键用 0（立即落盘）。 */
#define LUMEN_SAVE_SCENE_DEBOUNCE_MS 2000

/* v5 的持久化键下标。顺序即 §10.5 的表格顺序。 */
typedef enum {
    LUMEN_SAVE_KEY_STATE = 0,
    LUMEN_SAVE_KEY_LAYOUT,
    LUMEN_SAVE_KEY_SCENE0,
    LUMEN_SAVE_KEY_SCENE1,
    LUMEN_SAVE_KEY_SCENE2,
    LUMEN_SAVE_KEY_COUNT,
} lumen_save_key_t;

/* 每个键自己的一份待写状态。**不持有 blob 内容**（见上面的栈说明）。 */
typedef struct {
    const uint8_t *blob; /* 调用方持有的只读 blob */
    uint32_t len;        /* 字节数 */
    bool pending;
    uint32_t deadline_ms;
    uint8_t command; /* 触发最新快照的命令字，用于 Event 0x81 的 detail */
} lumen_save_slot_t;

typedef struct {
    lumen_save_slot_t slot[LUMEN_SAVE_KEY_COUNT];
} lumen_save_scheduler_t;

void lumen_save_scheduler_init(lumen_save_scheduler_t *sched);

/*
 * 记录某个键的最新待写 blob 并重置它的 debounce。
 *
 * debounce_ms 由调用方按 §10.5 传（layout 传 0 = 立即落盘）。
 * 指针非法（blob 为 NULL 或 len 为 0）、key 越界时返回 false 且不改状态。
 *
 * **blob 必须在写入完成前保持有效**：调度器只存指针，不拷贝。
 */
bool lumen_save_scheduler_request(lumen_save_scheduler_t *sched, lumen_save_key_t key,
                                  const uint8_t *blob, uint32_t len, uint8_t command,
                                  uint32_t now_ms, uint32_t debounce_ms);

/*
 * 某个键距离下一次可写还有多少毫秒：0 表示已到期，UINT32_MAX 表示没有待写。
 * 调用方用它决定信号量等待时长。
 */
uint32_t lumen_save_scheduler_next_delay_ms(const lumen_save_scheduler_t *sched,
                                            lumen_save_key_t key, uint32_t now_ms);

/*
 * 所有键里最早的到期剩余毫秒（UINT32_MAX = 一个都不待写）。
 * 存储任务用它决定一次唤醒要等多久。
 */
uint32_t lumen_save_scheduler_earliest_delay_ms(const lumen_save_scheduler_t *sched,
                                                uint32_t now_ms);

/*
 * 到期取走某个键的待写 blob（清 pending）。未到期或没有待写时返回 false
 * 且不写任何出参。
 */
bool lumen_save_scheduler_take_due(lumen_save_scheduler_t *sched, lumen_save_key_t key,
                                   uint32_t now_ms, const uint8_t **out_blob, uint32_t *out_len,
                                   uint8_t *out_command);

/* 某个键是否有待写快照（只用于测试与日志）。 */
bool lumen_save_scheduler_pending(const lumen_save_scheduler_t *sched, lumen_save_key_t key);
