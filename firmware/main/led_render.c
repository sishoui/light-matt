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

/* 帧循环计数（#30）：串口可判定的「真刷 / 跳过」累计值。 */
static uint32_t s_frames_drawn;
static uint32_t s_frames_skipped;

void lumen_led_render_invalidate(void)
{
    s_rendered_valid = false;
}

void lumen_led_render_counters(uint32_t *drawn, uint32_t *skipped)
{
    if (drawn != NULL) {
        *drawn = s_frames_drawn;
    }
    if (skipped != NULL) {
        *skipped = s_frames_skipped;
    }
}

/*
 * 渲染一份快照。调用者是渲染任务，且持有灯带句柄的唯一所有权。
 *
 * 合成两步（docs/v2-effects-engine.md §4.2）：
 *   ① 未覆盖区清零 —— 由 lumen_segment_store_compose 的 memset 完成；
 *   ② 每颗灯统一过 gamma + 亮度 —— 在下面的循环里，**不在** effects 里。
 *
 * 没有活动段时走 v1 单色路径：整条填充 state->r/g/b。这不是两套渲染循环，
 * 只是「同一个像素缓冲的两种填充方式」，去重、gamma、刷灯完全共用。
 *
 * selftest 是渲染任务在锁内拷出的一份自检快照（不能直接读 s_selftest：
 * BLE 回调可能并发取消/重启）。「自检覆盖 vs 存储状态」的规则集中在
 * lumen_selftest_compose()。自检期间必须走单色路径——自检的语义是让用户
 * 确认硬件没坏，此时不该显示分段颜色（§7.1）。
 */
void lumen_led_render_snapshot(led_strip_handle_t strip, const lumen_state_t *snapshot,
                               const lumen_segment_store_t *segments,
                               const lumen_selftest_t *selftest, uint8_t max_brightness,
                               uint32_t now_ms)
{
    if (snapshot == NULL) {
        return;
    }

    uint8_t stored_rgb[3] = {snapshot->r, snapshot->g, snapshot->b};
    uint8_t brightness;
    uint8_t rgb[3];

    /* 关灯把亮度乘 0，但保留状态里的亮度值；Color 仍参与 gamma 计算。 */
    uint8_t clamped = lumen_state_clamp_brightness(snapshot->brightness, max_brightness);
    lumen_selftest_compose(selftest, snapshot->power, clamped, stored_rgb, max_brightness, rgb,
                           &brightness);

    uint16_t count = snapshot->led_count;
    if (count == 0) {
        count = 1; /* 防御：句柄至少 1 颗，避免 0 长度缓冲比较 */
    }
    if (count > LUMEN_MAX_LEDS) {
        count = LUMEN_MAX_LEDS;
    }

    /* 是否走分段合成：自检期间一律单色（§7.1「自检是渲染层的最高优先级覆盖」）。 */
    bool segmented = selftest == NULL || !lumen_selftest_active(selftest);
    segmented = segmented && segments != NULL &&
                lumen_segment_store_any_active(segments, 0) && snapshot->power != 0;

    uint8_t frame[LUMEN_MAX_LEDS * 3];
    if (segmented) {
        /* ① compose 内部先 memset(buf, 0, count*3)：未覆盖的灯珠必须是 0。
         *    返回的是用户空间 RGB（不含 gamma / 亮度）。 */
        (void)lumen_segment_store_compose(segments, 0, frame, count, now_ms);
    } else {
        /* v1 路径：整条同一个用户空间颜色。 */
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

    if (s_rendered_valid && count == s_rendered_count &&
        memcmp(frame, s_rendered_frame, (size_t)count * 3u) == 0) {
        ++s_frames_skipped;
        /* docs/v2-effects-engine.md §3.2：跳过打 DEBUG，真刷打 INFO 带帧号。
         * 「一段呼吸 + 一段静态」时静态段的像素每帧重算但结果相同；
         * 若整帧都没变（例如周期极长或动画段恰好停在同值），这里就是证据。 */
        ESP_LOGD(TAG, "帧未变，跳过 refresh（drawn=%u skipped=%u）", (unsigned)s_frames_drawn,
                 (unsigned)s_frames_skipped);
        return; /* 状态没变，不碰灯带 */
    }

    /*
     * 渲染是灯带「有没有反应」唯一可观测的固件侧证据。
     *
     * 动画模式下画帧是连续的（默认 10fps）：逐帧 INFO 在 115200 下约
     * 5-15% 占空，会挤占 RMT×BLE 共存验证所需的串口带宽，也可能让日志本身
     * 影响帧间隔。所以动画模式按「每 10 帧一行」限流，行里带帧号与累计
     * drawn/skipped，足以判定帧循环确实在跑；非动画模式（状态变更驱动）
     * 仍然每帧一行，与 v1/#25 的行为一致。
     */
    bool animating = segmented && segments != NULL &&
                     lumen_segment_store_needs_frames(segments, snapshot->strip_count);
    if (animating && (s_frames_drawn % 10u) != 0u) {
        /* 限流窗口内不打印，但仍要真正刷灯。 */
    } else if (segmented) {
        uint16_t mid = (uint16_t)(count / 2u);
        ESP_LOGI(TAG,
                 "render seg: n=%u b=%u p=%u frame=%u [0]=%u,%u,%u [%u]=%u,%u,%u "
                 "[%u]=%u,%u,%u",
                 count, brightness, snapshot->power, (unsigned)s_frames_drawn, frame[0],
                 frame[1], frame[2], mid, frame[mid * 3u], frame[mid * 3u + 1],
                 frame[mid * 3u + 2], (unsigned)(count - 1), frame[(count - 1u) * 3u],
                 frame[(count - 1u) * 3u + 1], frame[(count - 1u) * 3u + 2]);
    } else {
        ESP_LOGI(TAG, "render: (%u,%u,%u) x %u brightness=%u power=%u", rgb[0], rgb[1], rgb[2],
                 count, brightness, snapshot->power);
    }

    if (lumen_led_strip_owner_push_pixels(strip, frame, count) != ESP_OK) {
        ESP_LOGW(TAG, "render: push_pixels 失败，灯带未更新");
        return;
    }

    ++s_frames_drawn;
    memcpy(s_rendered_frame, frame, (size_t)count * 3u);
    s_rendered_count = count;
    s_rendered_valid = true;
}
