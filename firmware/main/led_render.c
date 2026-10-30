#include "led_render.h"

#include <stdbool.h>
#include <string.h>

#include "esp_log.h"

#include "gamma.h"
#include "led_strip_owner.h"

static const char *TAG = "lumen_engine";

/*
 * 上一次真正写进灯带的像素。状态未变时跳过 set_pixel + refresh。
 *
 * v2 起按整条像素缓冲逐字节比较（docs/v2-effects-engine.md §3.2）：分段后
 * 一帧最多 64 × 3 = 192 字节，比 v1 的单色三元组更细，且自然覆盖
 * 「一段动画 + 一段静态」时静态段不变的情况。
 */
static bool s_rendered_valid;
static uint16_t s_rendered_count;
static uint8_t s_rendered_frame[LUMEN_MAX_LEDS * 3];

void lumen_led_render_invalidate(void)
{
    s_rendered_valid = false;
}

/*
 * 合成一条灯带的像素（用户空间 RGB，已过 gamma + 亮度），不刷灯。
 *
 * 这是 #29 TDM 的基础：每条灯带各自调用一次，得到自己那一帧。
 * lumen_led_render_snapshot 也用本函数，保证单灯带与多灯带只有一套合成规则。
 *
 * 规则（docs/v2-effects-engine.md §4.2）：
 *   ① 未覆盖区清零 —— 由 lumen_segment_store_compose 的 memset 完成；
 *   ② 逐颗统一过 gamma + 亮度 —— **不在** effects 里做。
 *
 * 没有活动段时走 v1 单色路径（整条 state->r/g/b）。自检期间强制走单色（§7.1）。
 */
static uint16_t compose_frame(const lumen_state_t *snapshot,
                              const lumen_segment_store_t *segments,
                              const lumen_selftest_t *selftest, uint8_t max_brightness,
                              uint32_t now_ms, uint8_t strip_id, uint16_t strip_count_hint,
                              uint8_t *frame, uint16_t cap)
{
    if (snapshot == NULL || frame == NULL) {
        return 0;
    }

    uint8_t stored_rgb[3] = {snapshot->r, snapshot->g, snapshot->b};
    uint8_t brightness;
    uint8_t rgb[3];

    /* 关灯把亮度乘 0，但保留状态里的亮度值；Color 仍参与 gamma 计算。 */
    uint8_t clamped = lumen_state_clamp_brightness(snapshot->brightness, max_brightness);
    lumen_selftest_compose(selftest, snapshot->power, clamped, stored_rgb, max_brightness, rgb,
                           &brightness);

    /*
     * 灯珠数：strip 0 沿用 State 里的权威值；其它条用调用方给的 hint
     * （#29 每条独立，State 只有 strip 0 的 led_count 字段）。
     */
    uint16_t count = strip_id == 0 ? snapshot->led_count : strip_count_hint;
    if (count == 0) {
        count = 1; /* 防御：句柄至少 1 颗，避免 0 长度缓冲比较 */
    }
    if (count > LUMEN_MAX_LEDS) {
        count = LUMEN_MAX_LEDS;
    }
    if (count > cap) {
        count = cap;
    }

    bool selftest_on = selftest != NULL && lumen_selftest_active(selftest);
    bool segmented = !selftest_on && segments != NULL &&
                     lumen_segment_store_any_active(segments, strip_id) && snapshot->power != 0;

    if (segmented) {
        /* ① compose 内部先 memset(buf, 0, count*3)：未覆盖的灯珠必须是 0。 */
        (void)lumen_segment_store_compose(segments, strip_id, frame, count, now_ms);
    } else {
        for (uint16_t i = 0; i < count; ++i) {
            frame[i * 3u + 0] = rgb[0];
            frame[i * 3u + 1] = rgb[1];
            frame[i * 3u + 2] = rgb[2];
        }
    }

    /* ② 逐颗过 gamma + 亮度。关灯时 brightness 为 0，整帧归零（保留状态值）。 */
    for (uint16_t i = 0; i < count; ++i) {
        frame[i * 3u + 0] = lumen_gamma_apply(frame[i * 3u + 0], brightness);
        frame[i * 3u + 1] = lumen_gamma_apply(frame[i * 3u + 1], brightness);
        frame[i * 3u + 2] = lumen_gamma_apply(frame[i * 3u + 2], brightness);
    }
    return count;
}

uint16_t lumen_led_render_compose_strip(const lumen_state_t *snapshot,
                                        const lumen_segment_store_t *segments,
                                        const lumen_selftest_t *selftest,
                                        uint8_t max_brightness, uint32_t now_ms,
                                        uint8_t strip_id, uint16_t strip_count,
                                        uint8_t *out_frame, uint16_t out_cap)
{
    if (strip_id >= LUMEN_MAX_STRIPS) {
        return 0;
    }
    return compose_frame(snapshot, segments, selftest, max_brightness, now_ms, strip_id,
                         strip_count, out_frame, (uint16_t)(out_cap / 3u));
}

bool lumen_led_render_strip_is_animated(const lumen_segment_store_t *segments, uint8_t strip_id)
{
    if (segments == NULL || strip_id >= LUMEN_MAX_STRIPS) {
        return false;
    }
    /* 逐段问效果层「是否动画」：判据只有一处，不在渲染层另写一份类型表。 */
    for (uint8_t i = 0; i < LUMEN_MAX_SEGMENTS; ++i) {
        const lumen_segment_t *seg = lumen_segment_store_get(segments, strip_id, i);
        if (seg != NULL && seg->active && lumen_effect_is_animated(seg->type)) {
            return true;
        }
    }
    return false;
}

/*
 * 渲染一份快照（单灯带路径）。调用者是渲染任务，且持有句柄唯一所有权。
 *
 * 多灯带（#29）由渲染任务按 TDM 逐条调用 lumen_led_render_compose_strip 再刷，
 * 那条路径的去重由 led_engine 负责（每条灯带各自比较自己的上一帧）。
 */
void lumen_led_render_snapshot(led_strip_handle_t strip, const lumen_state_t *snapshot,
                               const lumen_segment_store_t *segments,
                               const lumen_selftest_t *selftest, uint8_t max_brightness,
                               uint32_t now_ms)
{
    if (snapshot == NULL) {
        return;
    }

    uint8_t frame[LUMEN_MAX_LEDS * 3];
    uint16_t count = compose_frame(snapshot, segments, selftest, max_brightness, now_ms, 0,
                                  snapshot->led_count, frame, LUMEN_MAX_LEDS);
    if (count == 0) {
        return;
    }

    bool segmented = (selftest == NULL || !lumen_selftest_active(selftest)) && segments != NULL &&
                     lumen_segment_store_any_active(segments, 0) && snapshot->power != 0;

    if (s_rendered_valid && count == s_rendered_count &&
        memcmp(frame, s_rendered_frame, (size_t)count * 3u) == 0) {
        ESP_LOGD(TAG, "render skip: 像素未变 n=%u seg=%d", count, segmented ? 1 : 0);
        return; /* 状态没变，不碰灯带 */
    }

    /* 渲染是灯带「有没有反应」唯一可观测的固件侧证据：开 INFO 是为了
     * 真机排障时能看到每一次真正写进灯带的像素。分段时打印首/中/末三颗
     * 作为抽样（整条 192 字节逐字节打印会淹掉串口），完整像素可对照日志
     * 里的段配置命令复现。 */
    if (segmented) {
        uint16_t mid = (uint16_t)(count / 2u);
        ESP_LOGI(TAG, "render seg: n=%u b=%u p=%u [0]=%u,%u,%u [%u]=%u,%u,%u [%u]=%u,%u,%u",
                 count, snapshot->brightness, snapshot->power, frame[0], frame[1], frame[2], mid,
                 frame[mid * 3u], frame[mid * 3u + 1], frame[mid * 3u + 2],
                 (unsigned)(count - 1), frame[(count - 1u) * 3u], frame[(count - 1u) * 3u + 1],
                 frame[(count - 1u) * 3u + 2]);
    } else {
        ESP_LOGI(TAG, "render: n=%u brightness=%u power=%u", count, snapshot->brightness,
                 snapshot->power);
    }

    if (lumen_led_strip_owner_push_pixels(strip, frame, count) != ESP_OK) {
        ESP_LOGW(TAG, "render: push_pixels 失败，灯带未更新");
        return;
    }

    memcpy(s_rendered_frame, frame, (size_t)count * 3u);
    s_rendered_count = count;
    s_rendered_valid = true;
}
