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
