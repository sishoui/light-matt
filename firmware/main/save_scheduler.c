#include "save_scheduler.h"

#include <stddef.h>
#include <string.h>

void lumen_save_scheduler_init(lumen_save_scheduler_t *sched)
{
    if (sched == NULL) {
        return;
    }
    /* 快照内容在第一次 request 时就被整份覆盖，这里清零只是为了可复现的初值，
     * 不依赖 sdkconfig / 协议默认值（本模块要能在 host 上单测）。 */
    memset(sched, 0, sizeof(*sched));
}

bool lumen_save_scheduler_request(lumen_save_scheduler_t *sched, const lumen_persist_t *snapshot,
                                  uint8_t command, uint32_t now_ms)
{
    if (sched == NULL || snapshot == NULL) {
        return false;
    }
    sched->snapshot = *snapshot;
    sched->command = command;
    sched->pending = true;
    sched->deadline_ms = now_ms + LUMEN_SAVE_DEBOUNCE_MS;
    return true;
}

uint32_t lumen_save_scheduler_next_delay_ms(const lumen_save_scheduler_t *sched,
                                            uint32_t now_ms)
{
    if (sched == NULL || !sched->pending) {
        return UINT32_MAX;
    }
    int32_t remaining = (int32_t)(sched->deadline_ms - now_ms);
    return remaining > 0 ? (uint32_t)remaining : 0;
}

bool lumen_save_scheduler_take_due(lumen_save_scheduler_t *sched, uint32_t now_ms,
                                   lumen_persist_t *out, uint8_t *command)
{
    if (sched == NULL || !sched->pending) {
        return false;
    }
    if (lumen_save_scheduler_next_delay_ms(sched, now_ms) != 0) {
        return false;
    }
    if (out != NULL) {
        *out = sched->snapshot;
    }
    if (command != NULL) {
        *command = sched->command;
    }
    sched->pending = false;
    return true;
}

bool lumen_save_scheduler_pending(const lumen_save_scheduler_t *sched)
{
    return sched != NULL && sched->pending;
}
