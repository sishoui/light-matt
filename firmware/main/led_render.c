#include "led_render.h"

#include <stdbool.h>
#include <string.h>

#include "esp_log.h"
#include "sdkconfig.h"

#include "gamma.h"
#include "led_strip_owner.h"
#include "script_scope.h"
#include "strip_power.h"

static const char *TAG = "lumen_engine";

/*
 * 上一次真正写进灯带的像素。状态未变时跳过 set_pixel + refresh。
 *
 * v2 起按整条像素缓冲逐字节比较（docs/v2-effects-engine.md §3.2）：分段后
 * 一帧最多 100 × 3 = 300 字节（#72 从 64 抬高），比 v1 的单色三元组更细，且自然覆盖
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
 * 这是 #29 TDM 的基础：每条灯带各自调用一次，得到自己那一帧。
 * lumen_led_render_snapshot 也用本函数，保证单灯带与多灯带只有一套合成规则。
 *
 * 规则（docs/v2-effects-engine.md §4.2）：
 *   ① 未覆盖区清零 —— 由 lumen_segment_store_compose 的 memset 完成；
 *   ② 逐颗统一过 gamma + 亮度 —— **不在** effects 里做。
 *
 * **没有活动段就是全黑**（docs/protocol-v4.md §9.3 第 2 条）。这里曾经有一条
 * v1 单色回退：整条刷 `state->r/g/b`。那条回退制造了三个 bug——没设过灯效的带
 * 亮成暖白（看着是黄）；`state_summary_apply` 把 strip0/seg0 的颜色写进 State，
 * 于是改第一组的颜色会让所有无分区的带一起变色；调第一组的饱和度等于调这个
 * 全局兜底色。自检仍然要覆盖整条，但那是 `lumen_selftest` 自己的输出通道，
 * 由下面 `selftest_on` 分支处理，不再借用单色回退。
 *
 * `script_mask` 是方案作用域的归属位（#122）。**像素规则不看它**：没有段一律
 * 全黑，归不归方案管都一样。它只用于日志口径（区分「分段渲染」与「空段表」），
 * 「这一点归谁管」由上游 `lumen_scope_compose` 已经选好了段配置。
 */
static uint16_t compose_frame(const lumen_state_t *snapshot,
                              const lumen_segment_store_t *segments,
                              const lumen_selftest_t *selftest, uint8_t max_brightness,
                              uint32_t now_ms, uint8_t strip_id, uint16_t strip_count_hint,
                              uint8_t script_mask, uint8_t *frame, uint16_t cap)
{
    (void)script_mask; /* 只影响日志口径，见上面的注释。 */
    if (snapshot == NULL || frame == NULL) {
        return 0;
    }

    uint8_t stored_rgb[3] = {snapshot->r, snapshot->g, snapshot->b};
    uint8_t brightness;
    uint8_t selftest_rgb[3];

    /* 关灯把亮度乘 0，但保留状态里的亮度值；Color 仍参与 gamma 计算。 */
    uint8_t clamped = lumen_state_clamp_brightness(snapshot->brightness, max_brightness);
    lumen_selftest_compose(selftest, snapshot->power, clamped, stored_rgb, max_brightness,
                           selftest_rgb, &brightness);

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

    /*
     * 每带独立开关的门控（#38，§7.3 / §9.5）：实际是否出光 = 全局 power &&
     * 该带掩码位；自检期间忽略每带开关（全部点亮，§9.7）。
     *
     * 门控在这里而不是调用方：单灯带路径（strip_count == 1）没有 TDM 可跳过，
     * 只有这一处能保证「关掉的带」真的不亮。被判为不出光时整帧清零
     * （包括尾部的空灯珠），调用方照常推送/比较，不会再出现残影。
     */
    if (!lumen_strip_mask_allows(snapshot, strip_id, selftest_on)) {
        memset(frame, 0, (size_t)count * 3u);
        return count;
    }

    if (selftest_on) {
        /* 自检覆盖整条（§11.2）：忽略段配置，整条刷自检色。 */
        for (uint16_t i = 0; i < count; ++i) {
            frame[i * 3u + 0] = selftest_rgb[0];
            frame[i * 3u + 1] = selftest_rgb[1];
            frame[i * 3u + 2] = selftest_rgb[2];
        }
    } else {
        /* ① compose 内部先 memset(buf, 0, count*3)：未覆盖的灯珠必须是 0。
         * 没有活动段时整帧全 0，这就是「没设灯效 = 空 = 黑」。 */
        (void)lumen_segment_store_compose(segments, strip_id, frame, count, now_ms);
    }

    /*
     * ② v4 合成顺序：**先在用户空间乘全局亮度，再统一过 gamma 一次**
     *    （docs/protocol-v4.md §9.3）。level 已经在 lumen_layer_pixel 里乘过，
     *    所以这里只剩全局亮度；色相丢失截断由 lumen_gamma_apply_pixel_scaled
     *    统一处理（纯函数、host 可测）。
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
                                        const lumen_segment_store_t *segments,
                                        const lumen_selftest_t *selftest,
                                        uint8_t max_brightness, uint32_t now_ms,
                                        uint8_t strip_id, uint16_t strip_count,
                                        uint8_t script_mask, uint8_t *out_frame, uint16_t out_cap)
{
    if (strip_id >= LUMEN_MAX_STRIPS) {
        return 0;
    }
    return compose_frame(snapshot, segments, selftest, max_brightness, now_ms, strip_id,
                         strip_count, script_mask, out_frame, (uint16_t)(out_cap / 3u));
}

bool lumen_led_render_strip_is_animated(const lumen_segment_store_t *segments, uint8_t strip_id)
{
    if (segments == NULL || strip_id >= LUMEN_MAX_STRIPS) {
        return false;
    }
    /* 逐段问效果层「是否动画」：判据只有一处，不在渲染层另写一份类型表。 */
    for (uint8_t i = 0; i < LUMEN_MAX_SEGMENTS; ++i) {
        const lumen_segment_t *seg = lumen_segment_store_get(segments, strip_id, i);
        /* 两层都可能是动画：#37 起 layer1（例如呼吸叠加）也要驱动帧循环。 */
        if (seg != NULL && lumen_segment_is_animated(seg)) {
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
                               uint32_t now_ms, uint8_t script_mask)
{
    if (snapshot == NULL) {
        return;
    }

    uint8_t frame[LUMEN_MAX_LEDS * 3];
    uint16_t count = compose_frame(snapshot, segments, selftest, max_brightness, now_ms, 0,
                                  snapshot->led_count, script_mask, frame, LUMEN_MAX_LEDS);
    if (count == 0) {
        return;
    }

    bool selftest_on = selftest != NULL && lumen_selftest_active(selftest);
    /* 有分区或有归属位才叫「分段」；这只影响日志口径，不影响像素规则——
     * 两条路径现在都是「未覆盖 = 0」。 */
    bool segmented =
        script_mask != 0 || selftest_on ||
        (segments != NULL && lumen_segment_store_any_active(segments, 0));

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
    } else {
        uint16_t mid = (uint16_t)(count / 2u);
        ESP_LOGI(TAG,
                 "render seg: n=%u b=%u p=%u frame=%u [0]=%u,%u,%u [%u]=%u,%u,%u "
                 "[%u]=%u,%u,%u",
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
