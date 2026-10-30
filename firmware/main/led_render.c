#include "led_render.h"

#include <stdbool.h>

#include "esp_log.h"

#include "gamma.h"
#include "led_strip_owner.h"

static const char *TAG = "lumen_engine";

/* 上一次真正写进灯带的像素。状态未变时跳过 set_pixel + refresh。 */
static bool s_rendered_valid;
static uint8_t s_rendered_r;
static uint8_t s_rendered_g;
static uint8_t s_rendered_b;
static uint8_t s_rendered_brightness;
static uint16_t s_rendered_count;

void lumen_led_render_invalidate(void)
{
    s_rendered_valid = false;
}

/*
 * 渲染一份快照。调用者是渲染任务，且持有灯带句柄的唯一所有权。
 * 同步 refresh() 而不是 refresh_async()：只有一个渲染任务、没有并发刷新，
 * 引入 async 就必须自建双缓冲，而本票没有任何收益。RMT × BLE 的调优在 #7。
 *
 * selftest 是渲染任务在锁内拷出的一份自检快照（不能直接读 s_selftest：
 * BLE 回调可能并发取消/重启）。「自检覆盖 vs 存储状态」的规则集中在
 * lumen_selftest_compose()，本函数只负责 gamma、去重与刷灯。
 */
void lumen_led_render_snapshot(led_strip_handle_t strip, const lumen_state_t *snapshot,
                               const lumen_selftest_t *selftest, uint8_t max_brightness)
{
    uint8_t stored_rgb[3] = {snapshot->r, snapshot->g, snapshot->b};
    uint8_t brightness;
    uint8_t rgb[3];

    /* 关灯把亮度乘 0，但保留状态里的亮度值；Color 仍参与 gamma 计算。 */
    uint8_t clamped = lumen_state_clamp_brightness(snapshot->brightness, max_brightness);
    lumen_selftest_compose(selftest, snapshot->power, clamped, stored_rgb, max_brightness, rgb,
                           &brightness);

    uint8_t r = lumen_gamma_apply(rgb[0], brightness);
    uint8_t g = lumen_gamma_apply(rgb[1], brightness);
    uint8_t b = lumen_gamma_apply(rgb[2], brightness);
    uint16_t count = snapshot->led_count;

    if (s_rendered_valid && r == s_rendered_r && g == s_rendered_g && b == s_rendered_b &&
        brightness == s_rendered_brightness && count == s_rendered_count) {
        ESP_LOGD(TAG, "render skip: 像素未变 (%u,%u,%u) b=%u n=%u", r, g, b, brightness, count);
        return; /* 状态没变，不碰灯带 */
    }

    /* 渲染是灯带「有没有反应」唯一可观测的固件侧证据：开 INFO 是为了
     * 真机排障时能看到每一次真正写进灯带的像素（只在状态变化时触发，
     * 20Hz 拖动下最多 20 行/秒，且不影响未变化时的静默）。 */
    ESP_LOGI(TAG, "render: (%u,%u,%u) x %u brightness=%u power=%u", r, g, b, count, brightness,
             snapshot->power);

    if (lumen_led_strip_owner_push_frame(strip, r, g, b, count) != ESP_OK) {
        ESP_LOGW(TAG, "render: push_frame 失败，灯带未更新");
        return;
    }

    s_rendered_r = r;
    s_rendered_g = g;
    s_rendered_b = b;
    s_rendered_brightness = brightness;
    s_rendered_count = count;
    s_rendered_valid = true;
}
