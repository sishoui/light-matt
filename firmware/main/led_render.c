#include "led_render.h"

#include <stdbool.h>
#include <string.h>

#include "esp_log.h"
#include "sdkconfig.h"

#include "gamma.h"
#include "led_strip_owner.h"
#include "strip_power.h"

static const char *TAG = "lumen_engine";

/*
 * 上一次真正写进灯带的像素。状态未变时跳过 set_pixel + refresh。
 *
 * 按整条像素缓冲逐字节比较：一帧最多 100 × 3 = 300 字节，
 * 自然覆盖「一部分部位在动画、另一部分静止」时静止部分不变的情况。
 */
static bool s_rendered_valid;
static uint16_t s_rendered_count;
static uint8_t s_rendered_frame[LUMEN_MAX_LEDS * 3];

/* 帧循环计数：串口可判定的「真刷 / 跳过」累计值。 */
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

void lumen_led_render_note_drawn(void)
{
    ++s_frames_drawn;
}

void lumen_led_render_note_skipped(void)
{
    ++s_frames_skipped;
}

/*
 * 合成一条灯带的像素（用户空间 RGB，已过 gamma + 亮度），不刷灯。
 *
 * 顺序（docs/protocol-v5.md §9.3 第 4 步，与 v4 同一条）：
 *   ① `lumen_scene_compose()` 产出**用户空间** RGB（未覆盖灯珠恒黑、层亮度已乘）；
 *   ② 本函数对整帧**一次**施加全局亮度 + gamma。
 *
 * 自检是渲染层的最高优先级覆盖：整条单色，忽略布局与场景（§9.6）。
 */
static uint16_t compose_frame(const lumen_state_t *snapshot, const lumen_layout_store_t *layout,
                              const lumen_scene_t *scene, const lumen_part_clocks_t *clocks,
                              const lumen_selftest_t *selftest, uint8_t max_brightness,
                              uint32_t now_ms, uint8_t strip_id, uint16_t strip_count_hint,
                              uint8_t *frame, uint16_t cap)
{
    if (snapshot == NULL || frame == NULL) {
        return 0;
    }

    uint8_t brightness;
    uint8_t selftest_rgb[3];

    /*
     * 关灯把亮度乘 0，但保留状态里的亮度值。v5 的 State 不再有 RGB 摘要
     * （§7.3），所以存储色传全 0——未激活自检时这个参数不会被用到。
     */
    static const uint8_t k_no_stored_rgb[3] = {0, 0, 0};
    uint8_t clamped = lumen_state_clamp_brightness(snapshot->brightness, max_brightness);
    lumen_selftest_compose(selftest, snapshot->power, clamped, k_no_stored_rgb, max_brightness,
                           selftest_rgb, &brightness);

    uint16_t count = strip_count_hint;
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

    /*
     * 每带独立开关的门控（§9.5）：实际是否出光 = 全局 power && 该带掩码位；
     * 自检期间忽略每带开关（全部点亮）。门控在这里而不是调用方：单灯带路径
     * 没有 TDM 可跳过，只有这一处能保证「关掉的带」真的不亮。
     */
    if (!lumen_strip_mask_allows(snapshot, strip_id, selftest_on)) {
        memset(frame, 0, (size_t)count * 3u);
        return count;
    }

    if (selftest_on) {
        /* 自检覆盖整条（§9.6）：忽略布局与场景，整条刷自检色。 */
        for (uint16_t i = 0; i < count; ++i) {
            frame[i * 3u + 0] = selftest_rgb[0];
            frame[i * 3u + 1] = selftest_rgb[1];
            frame[i * 3u + 2] = selftest_rgb[2];
        }
    } else {
        /* ① 合成内部先 memset：未覆盖的灯珠必须是真黑（§9.3 第 1 步）。 */
        (void)lumen_scene_compose(layout, scene, clocks, now_ms, strip_id,
                                  frame, count);
    }

    /*
     * ② 先在用户空间乘全局亮度，再统一过 gamma **一次**（§9.3 第 4 步）。
     *    层亮度已经在 lumen_layer_pixel 里乘过，所以这里只剩全局亮度。
     */
    for (uint16_t i = 0; i < count; ++i) {
        uint8_t in[3] = {frame[i * 3u + 0], frame[i * 3u + 1], frame[i * 3u + 2]};
        uint8_t out[3];
        lumen_gamma_apply_pixel_scaled(in, brightness, out);
        frame[i * 3u + 0] = out[0];
        frame[i * 3u + 1] = out[1];
        frame[i * 3u + 2] = out[2];
    }
    return count;
}

uint16_t lumen_led_render_compose_strip(const lumen_state_t *snapshot,
                                        const lumen_layout_store_t *layout,
                                        const lumen_scene_t *scene,
                                        const lumen_part_clocks_t *clocks,
                                        const lumen_selftest_t *selftest, uint8_t max_brightness,
                                        uint32_t now_ms, uint8_t strip_id, uint16_t strip_count,
                                        uint8_t *out_frame, uint16_t out_cap)
{
    if (strip_id >= LUMEN_MAX_STRIPS) {
        return 0;
    }
    return compose_frame(snapshot, layout, scene, clocks, selftest, max_brightness, now_ms,
                         strip_id, strip_count, out_frame, (uint16_t)(out_cap / 3u));
}

/*
 * 渲染一份快照（单灯带路径）。调用者是渲染任务，且持有句柄唯一所有权。
 *
 * 多灯带由渲染任务按 TDM 逐条调用 lumen_led_render_compose_strip 再刷，
 * 那条路径的去重由 led_engine 负责（每条灯带各自比较自己的上一帧）。
 */
void lumen_led_render_snapshot(led_strip_handle_t strip, const lumen_state_t *snapshot,
                               const lumen_layout_store_t *layout, const lumen_scene_t *scene,
                               const lumen_part_clocks_t *clocks, const lumen_selftest_t *selftest,
                               uint8_t max_brightness, uint32_t now_ms)
{
    if (snapshot == NULL) {
        return;
    }

    uint8_t frame[LUMEN_MAX_LEDS * 3];
    uint16_t count = compose_frame(snapshot, layout, scene, clocks, selftest, max_brightness,
                                  now_ms, 0, snapshot->led_count[0], frame, LUMEN_MAX_LEDS);
    if (count == 0) {
        return;
    }

    bool selftest_on = selftest != NULL && lumen_selftest_active(selftest);
    /* 这条链是否有部位——只影响日志口径，不影响像素规则（未覆盖都是 0）。 */
    bool segmented = selftest_on || (layout != NULL && layout->part_count[0] > 0);

    /* CONFIG_LUMEN_FORCE_REFRESH：错色实验要求画面恒定但持续刷帧，跳过整帧去重。
     * 必须用 #ifdef：Kconfig 的 bool 关闭时**不定义宏**，直接写
     * `!CONFIG_LUMEN_FORCE_REFRESH` 在关闭状态下编译不过（实测）。 */
#ifdef CONFIG_LUMEN_FORCE_REFRESH
    const bool skip_dedup = true;
#else
    const bool skip_dedup = false;
#endif
    if (!skip_dedup && s_rendered_valid && count == s_rendered_count &&
        memcmp(frame, s_rendered_frame, (size_t)count * 3u) == 0) {
        ++s_frames_skipped;
        ESP_LOGD(TAG, "帧未变，跳过 refresh（drawn=%u skipped=%u）", (unsigned)s_frames_drawn,
                 (unsigned)s_frames_skipped);
        return; /* 状态没变，不碰灯带 */
    }

    /*
     * 动画模式按「每 10 帧一行」限流，非动画模式（状态变更驱动）每帧一行——
     * 与 v4 同一口径：逐帧 INFO 在 115200 下会挤占 RMT×BLE 共存验证所需的带宽。
     */
    bool animating = segmented && lumen_scene_strip_needs_frames(layout, scene, 0);
    if (animating && (s_frames_drawn % 10u) != 0u) {
        /* 限流窗口内不打印，但仍要真正刷灯。 */
    } else {
        uint16_t mid = (uint16_t)(count / 2u);
        ESP_LOGI(TAG, "render: n=%u b=%u p=%u frame=%u [0]=%u,%u,%u [%u]=%u,%u,%u [%u]=%u,%u,%u",
                 count, snapshot->brightness, snapshot->power, (unsigned)s_frames_drawn, frame[0],
                 frame[1], frame[2], mid, frame[mid * 3u], frame[mid * 3u + 1],
                 frame[mid * 3u + 2], (unsigned)(count - 1), frame[(count - 1u) * 3u],
                 frame[(count - 1u) * 3u + 1], frame[(count - 1u) * 3u + 2]);
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
