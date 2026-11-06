#include "save_scheduler.h"

#include <stddef.h>
#include <string.h>

void lumen_save_scheduler_init(lumen_save_scheduler_t *sched)
{
    if (sched == NULL) {
        return;
    }
    /* 不依赖 sdkconfig / 协议默认值（本模块要能在 host 上单测）。 */
    memset(sched, 0, sizeof(*sched));
}

bool lumen_save_scheduler_request(lumen_save_scheduler_t *sched, lumen_save_key_t key,
                                  const uint8_t *blob, uint32_t len, uint8_t command,
                                  uint32_t now_ms, uint32_t debounce_ms)
{
    if (sched == NULL || blob == NULL || len == 0) {
        return false;
    }
    if ((unsigned)key >= LUMEN_SAVE_KEY_COUNT) {
        return false;
    }
    lumen_save_slot_t *slot = &sched->slot[key];
    slot->blob = blob;
    slot->len = len;
    slot->command = command;
    slot->pending = true;
    slot->deadline_ms = now_ms + debounce_ms;
    return true;
}

uint32_t lumen_save_scheduler_next_delay_ms(const lumen_save_scheduler_t *sched,
                                            lumen_save_key_t key, uint32_t now_ms)
{
    if (sched == NULL || (unsigned)key >= LUMEN_SAVE_KEY_COUNT || !sched->slot[key].pending) {
        return UINT32_MAX;
    }
    int32_t remaining = (int32_t)(sched->slot[key].deadline_ms - now_ms);
    return remaining > 0 ? (uint32_t)remaining : 0;
}

uint32_t lumen_save_scheduler_earliest_delay_ms(const lumen_save_scheduler_t *sched,
                                                uint32_t now_ms)
{
    if (sched == NULL) {
        return UINT32_MAX;
    }
    uint32_t earliest = UINT32_MAX;
    for (unsigned k = 0; k < LUMEN_SAVE_KEY_COUNT; ++k) {
        uint32_t d = lumen_save_scheduler_next_delay_ms(sched, (lumen_save_key_t)k, now_ms);
        if (d < earliest) {
            earliest = d;
        }
    }
    return earliest;
}

bool lumen_save_scheduler_take_due(lumen_save_scheduler_t *sched, lumen_save_key_t key,
                                   uint32_t now_ms, const uint8_t **out_blob, uint32_t *out_len,
                                   uint8_t *out_command)
{
    if (sched == NULL || (unsigned)key >= LUMEN_SAVE_KEY_COUNT) {
        return false;
    }
    if (!sched->slot[key].pending) {
        return false;
    }
    if (lumen_save_scheduler_next_delay_ms(sched, key, now_ms) != 0) {
        return false;
    }
    lumen_save_slot_t *slot = &sched->slot[key];
    if (out_blob != NULL) {
        *out_blob = slot->blob;
    }
    if (out_len != NULL) {
        *out_len = slot->len;
    }
    if (out_command != NULL) {
        *out_command = slot->command;
    }
    slot->pending = false;
    /* 不清指针：调用方在 take_due 之后才写 NVS，blob 仍然有效。 */
    return true;
}

bool lumen_save_scheduler_pending(const lumen_save_scheduler_t *sched, lumen_save_key_t key)
{
    return sched != NULL && (unsigned)key < LUMEN_SAVE_KEY_COUNT && sched->slot[key].pending;
}
