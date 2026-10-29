#include "led_count_job.h"

#include <stddef.h>

#include "protocol.h"

void lumen_led_count_job_init(lumen_led_count_job_t *job)
{
    if (job == NULL) {
        return;
    }
    job->pending = false;
    job->running = false;
    job->target = 0;
    job->seq = 0;
}

lumen_led_count_request_t lumen_led_count_job_request(lumen_led_count_job_t *job, uint16_t count,
                                                      uint16_t current_count, uint8_t seq)
{
    if (job == NULL) {
        return LUMEN_LED_COUNT_BUSY;
    }
    /* §11.3：重建进行中（含已排队未开始）收到第二个请求 → Busy，不排队。
     * 先于「与当前值相同」判断：此时共享状态还是旧数量，用旧值判断没有意义。 */
    if (job->pending || job->running) {
        return LUMEN_LED_COUNT_BUSY;
    }
    if (count == current_count) {
        return LUMEN_LED_COUNT_UNCHANGED;
    }
    if (count < 1 || count > LUMEN_MAX_LEDS) {
        /* 调用方应该已经拦下；这里防御性拒绝，不破坏状态机。 */
        return LUMEN_LED_COUNT_BUSY;
    }
    job->pending = true;
    job->target = count;
    job->seq = seq;
    return LUMEN_LED_COUNT_ACCEPTED;
}

bool lumen_led_count_job_begin(lumen_led_count_job_t *job, uint16_t *target, uint8_t *seq)
{
    if (job == NULL || !job->pending) {
        return false;
    }
    job->pending = false;
    job->running = true;
    if (target != NULL) {
        *target = job->target;
    }
    if (seq != NULL) {
        *seq = job->seq;
    }
    return true;
}

bool lumen_led_count_job_complete(lumen_led_count_job_t *job, bool ok, lumen_state_t *state)
{
    if (job == NULL || !job->running) {
        return false;
    }
    job->running = false;
    if (!ok || state == NULL) {
        return false;
    }
    /* 成功：只改数量，保留当前开关/亮度/颜色（§11.3「当前状态保持不变」）。 */
    state->led_count = job->target;
    return true;
}

bool lumen_led_count_job_busy(const lumen_led_count_job_t *job)
{
    return job != NULL && (job->pending || job->running);
}

uint16_t lumen_led_count_job_target(const lumen_led_count_job_t *job)
{
    return job == NULL ? 0 : job->target;
}
