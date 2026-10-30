#include "led_strip_owner.h"

#include <stdbool.h>

#include "esp_log.h"
#include "esp_timer.h"
#include "led_strip.h"
#include "sdkconfig.h"

#include "protocol.h"
#include "stress_metrics.h"

static const char *TAG = "lumen_engine";

#define LUMEN_RMT_RESOLUTION_HZ (10 * 1000 * 1000)

/* WS2812B 通常是 GRB；若实测红绿互换，改 Kconfig 的 LUMEN_LED_COLOR_ORDER。 */
#if CONFIG_LUMEN_LED_COLOR_ORDER_RGB
#define LUMEN_COLOR_FORMAT LED_STRIP_COLOR_COMPONENT_FMT_RGB
#else
#define LUMEN_COLOR_FORMAT LED_STRIP_COLOR_COMPONENT_FMT_GRB
#endif

/* 灯带句柄的唯一所有者是渲染任务：init 创建后立刻交给渲染任务，之后只有
 * 渲染任务调用 set_pixel / refresh / del / new_rmt_device（重建）。 */
static led_strip_handle_t s_strip;

esp_err_t lumen_led_strip_owner_create_on(uint8_t gpio, uint16_t max_count,
                                          led_strip_handle_t *out)
{
    if (out == NULL || max_count < 1 || max_count > LUMEN_MAX_LEDS) {
        return ESP_ERR_INVALID_ARG;
    }
    led_strip_config_t strip_config = {
        .strip_gpio_num = gpio,
        .max_leds = max_count,
        .led_model = LED_MODEL_WS2812,
        .color_component_format = LUMEN_COLOR_FORMAT,
        .flags.invert_out = false,
    };
    led_strip_rmt_config_t rmt_config = {
        .clk_src = RMT_CLK_SRC_DEFAULT,
        .resolution_hz = LUMEN_RMT_RESOLUTION_HZ,
        .mem_block_symbols = CONFIG_LUMEN_RMT_MEM_BLOCK_SYMBOLS,
        .flags.with_dma = false, /* C3 的 RMT 没有 DMA */
    };
    return led_strip_new_rmt_device(&strip_config, &rmt_config, out);
}

esp_err_t lumen_led_strip_owner_switch_gpio(led_strip_handle_t strip, uint8_t gpio)
{
    if (strip == NULL) {
        return ESP_ERR_INVALID_ARG;
    }
    /*
     * GPIO matrix 允许把同一个 RMT 输出信号路由到任意引脚，所以 8 条灯带
     * 共用一个 RMT 通道是可行的（docs/animation-baseline.md §3）。
     * WS2812B 会锁存最后收到的像素，切走后那条灯带保持原画面——这是 TDM
     * 的物理基础，不是副作用。
     */
    return led_strip_switch_gpio(strip, (gpio_num_t)gpio, false);
}

esp_err_t lumen_led_strip_owner_create(uint16_t count, led_strip_handle_t *out)
{
    led_strip_config_t strip_config = {
        .strip_gpio_num = CONFIG_LUMEN_LED_GPIO,
        .max_leds = count,
        .led_model = LED_MODEL_WS2812,
        .color_component_format = LUMEN_COLOR_FORMAT,
        .flags.invert_out = false,
    };
    led_strip_rmt_config_t rmt_config = {
        .clk_src = RMT_CLK_SRC_DEFAULT,
        .resolution_hz = LUMEN_RMT_RESOLUTION_HZ,
        .mem_block_symbols = CONFIG_LUMEN_RMT_MEM_BLOCK_SYMBOLS,
        .flags.with_dma = false, /* C3 的 RMT 没有 DMA */
    };
    return led_strip_new_rmt_device(&strip_config, &rmt_config, out);
}

esp_err_t lumen_led_strip_owner_init(uint16_t count)
{
    return lumen_led_strip_owner_create(count, &s_strip);
}

led_strip_handle_t lumen_led_strip_owner_get(void)
{
    return s_strip;
}

void lumen_led_strip_owner_set(led_strip_handle_t strip)
{
    s_strip = strip;
}

esp_err_t lumen_led_strip_owner_clear(led_strip_handle_t strip)
{
    /* led_strip_clear 用句柄自己的 max_leds。 */
    return led_strip_clear(strip);
}

void lumen_led_strip_owner_destroy(led_strip_handle_t strip)
{
    led_strip_del(strip);
}

esp_err_t lumen_led_strip_owner_push_pixels(led_strip_handle_t strip, const uint8_t *frame,
                                            uint16_t count)
{
    if (strip == NULL || frame == NULL) {
        return ESP_ERR_INVALID_ARG;
    }
    for (uint16_t i = 0; i < count; ++i) {
        led_strip_set_pixel(strip, i, frame[i * 3u + 0], frame[i * 3u + 1], frame[i * 3u + 2]);
    }

#if CONFIG_LUMEN_RMT_STRESS_MODE
    int64_t t0 = esp_timer_get_time();
#endif
    esp_err_t err = led_strip_refresh(strip);
#if CONFIG_LUMEN_RMT_STRESS_MODE
    lumen_stress_note_refresh(err, esp_timer_get_time() - t0);
#endif
    if (err != ESP_OK) {
        ESP_LOGW(TAG, "refresh failed: %s", esp_err_to_name(err));
    }
    return err;
}

esp_err_t lumen_led_strip_owner_push_pixels_n(led_strip_handle_t strip, const uint8_t *frame,
                                              uint16_t handle_max, uint16_t n)
{
    if (strip == NULL || frame == NULL) {
        return ESP_ERR_INVALID_ARG;
    }
    /*
     * TDM 路径：句柄按「所有条里最大的灯珠数」建，但每条灯带只点亮自己那 n 颗。
     *
     * refresh 会把句柄的整个 max_leds 缓冲都发出去，所以 n..handle_max 必须
     * 显式写 0——否则一条 30 灯的灯带在 64 灯句柄下会多收到 34 颗旧像素，
     * 表现为尾巴上多出几个不该亮的灯珠。这一条不能省。
     */
    if (n > handle_max) {
        n = handle_max;
    }
    for (uint16_t i = 0; i < n; ++i) {
        led_strip_set_pixel(strip, i, frame[i * 3u + 0], frame[i * 3u + 1], frame[i * 3u + 2]);
    }
    for (uint16_t i = n; i < handle_max; ++i) {
        led_strip_set_pixel(strip, i, 0, 0, 0);
    }

#if CONFIG_LUMEN_RMT_STRESS_MODE
    int64_t t0 = esp_timer_get_time();
#endif
    esp_err_t err = led_strip_refresh(strip);
#if CONFIG_LUMEN_RMT_STRESS_MODE
    lumen_stress_note_refresh(err, esp_timer_get_time() - t0);
#endif
    if (err != ESP_OK) {
        ESP_LOGW(TAG, "refresh failed: %s", esp_err_to_name(err));
    }
    return err;
}

esp_err_t lumen_led_strip_owner_push_frame(led_strip_handle_t strip, uint8_t r, uint8_t g,
                                           uint8_t b, uint16_t count)
{
    if (strip == NULL) {
        return ESP_ERR_INVALID_ARG;
    }
    /* v1 单色：整条同色。复用 push_pixels，保证两条路径只有一份 refresh 逻辑。 */
    uint8_t frame[LUMEN_MAX_LEDS * 3];
    uint16_t n = count > LUMEN_MAX_LEDS ? LUMEN_MAX_LEDS : count;
    for (uint16_t i = 0; i < n; ++i) {
        frame[i * 3u + 0] = r;
        frame[i * 3u + 1] = g;
        frame[i * 3u + 2] = b;
    }
    return lumen_led_strip_owner_push_pixels(strip, frame, n);
}
