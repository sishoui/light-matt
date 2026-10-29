#include "led_engine.h"

#include <stdbool.h>
#include <string.h>

#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "freertos/task.h"
#include "led_strip.h"
#include "sdkconfig.h"

#include "gamma.h"
#include "state_store.h"

static const char *TAG = "lumen_engine";

#define LUMEN_RMT_RESOLUTION_HZ (10 * 1000 * 1000)

/*
 * 共享状态由 s_state_lock 保护。s_state 是权威状态；s_mailbox 是最新待渲染
 * 快照，配 s_mailbox_dirty + 二值信号量 s_render_signal 构成 latest-wins 邮箱：
 * 无论 BLE 回调提交多快，渲染任务醒来永远只取最后一个快照，不排队旧帧。
 */
static SemaphoreHandle_t s_state_lock;
static SemaphoreHandle_t s_render_signal;
static lumen_state_t s_state;
static lumen_state_t s_mailbox;
static bool s_mailbox_dirty;

/* 灯带句柄的唯一所有者是渲染任务：init 创建后立刻交给渲染任务，之后只有
 * 渲染任务调用 set_pixel / refresh / del。 */
static led_strip_handle_t s_strip;

/* 上一次真正写进灯带的像素。状态未变时跳过 set_pixel + refresh。 */
static bool s_rendered_valid;
static uint8_t s_rendered_r;
static uint8_t s_rendered_g;
static uint8_t s_rendered_b;
static uint8_t s_rendered_brightness;
static uint16_t s_rendered_count;

static uint8_t max_brightness(void)
{
    /* 0 表示不限制，按 255 处理。 */
    uint8_t configured = (uint8_t)CONFIG_LUMEN_MAX_BRIGHTNESS;
    return configured == 0 ? 255 : configured;
}

static esp_err_t create_strip(uint16_t count, led_strip_handle_t *out)
{
    led_strip_config_t strip_config = {
        .strip_gpio_num = CONFIG_LUMEN_LED_GPIO,
        .max_leds = count,
        .led_model = LED_MODEL_WS2812,
        .color_component_format = LED_STRIP_COLOR_COMPONENT_FMT_GRB,
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

/*
 * 渲染一份快照。调用者是渲染任务，且持有灯带句柄的唯一所有权。
 * 同步 refresh() 而不是 refresh_async()：只有一个渲染任务、没有并发刷新，
 * 引入 async 就必须自建双缓冲，而本票没有任何收益。RMT × BLE 的调优在 #10。
 */
static void render_snapshot(const lumen_state_t *snapshot)
{
    /* 关灯把亮度乘 0，但保留状态里的亮度值；Color 仍参与 gamma 计算。 */
    uint8_t brightness = snapshot->power ? lumen_state_clamp_brightness(
                                               snapshot->brightness, max_brightness())
                                         : 0;

    uint8_t r = lumen_gamma_apply(snapshot->r, brightness);
    uint8_t g = lumen_gamma_apply(snapshot->g, brightness);
    uint8_t b = lumen_gamma_apply(snapshot->b, brightness);
    uint16_t count = snapshot->led_count;

    if (s_rendered_valid && r == s_rendered_r && g == s_rendered_g && b == s_rendered_b &&
        brightness == s_rendered_brightness && count == s_rendered_count) {
        return; /* 状态没变，不碰灯带 */
    }

    for (uint16_t i = 0; i < count; ++i) {
        led_strip_set_pixel(s_strip, i, r, g, b);
    }
    esp_err_t err = led_strip_refresh(s_strip);
    if (err != ESP_OK) {
        ESP_LOGW(TAG, "refresh failed: %s", esp_err_to_name(err));
        return;
    }

    s_rendered_r = r;
    s_rendered_g = g;
    s_rendered_b = b;
    s_rendered_brightness = brightness;
    s_rendered_count = count;
    s_rendered_valid = true;
}

static void render_task(void *arg)
{
    (void)arg;
    for (;;) {
        /* 空闲时阻塞在二值信号量上，不空转、不轮询。 */
        if (xSemaphoreTake(s_render_signal, portMAX_DELAY) != pdTRUE) {
            continue;
        }

        lumen_state_t snapshot;
        bool dirty;

        xSemaphoreTake(s_state_lock, portMAX_DELAY);
        dirty = s_mailbox_dirty;
        if (dirty) {
            snapshot = s_mailbox;
            s_mailbox_dirty = false;
        } else {
            snapshot = s_state;
        }
        xSemaphoreGive(s_state_lock);

        /* 渲染耗时（set_pixel + 阻塞 refresh）不持锁，State read 不会被拖住。 */
        render_snapshot(&snapshot);
    }
}

esp_err_t lumen_led_engine_init(void)
{
    s_state_lock = xSemaphoreCreateMutex();
    s_render_signal = xSemaphoreCreateBinary();
    if (s_state_lock == NULL || s_render_signal == NULL) {
        return ESP_ERR_NO_MEM;
    }

    lumen_gamma_init();

    lumen_state_defaults(&s_state, CONFIG_LUMEN_LED_COUNT);
    bool restored = lumen_state_store_load(&s_state);
    s_state.brightness = lumen_state_clamp_brightness(s_state.brightness, max_brightness());

    ESP_LOGI(TAG, "state %s: power=%u brightness=%u rgb=%u,%u,%u leds=%u max=%u",
             restored ? "restored" : "default", s_state.power, s_state.brightness, s_state.r,
             s_state.g, s_state.b, s_state.led_count, max_brightness());

    esp_err_t err = create_strip(s_state.led_count, &s_strip);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "strip init failed: %s", esp_err_to_name(err));
        return err;
    }

    BaseType_t created =
        xTaskCreate(render_task, "lumen_render", CONFIG_LUMEN_RENDER_TASK_STACK_SIZE, NULL,
                    CONFIG_LUMEN_RENDER_TASK_PRIORITY, NULL);
    if (created != pdPASS) {
        return ESP_ERR_NO_MEM;
    }

    /* 初始化后按当前（默认或恢复的）状态渲染一次，之后只等状态变化。 */
    xSemaphoreGive(s_render_signal);
    return ESP_OK;
}

void lumen_led_engine_state_bytes(uint8_t out[8])
{
    if (out == NULL) {
        return;
    }
    xSemaphoreTake(s_state_lock, portMAX_DELAY);
    lumen_state_to_bytes(&s_state, max_brightness(), out);
    xSemaphoreGive(s_state_lock);
}

void lumen_led_engine_snapshot(lumen_state_t *out)
{
    if (out == NULL) {
        return;
    }
    xSemaphoreTake(s_state_lock, portMAX_DELAY);
    *out = s_state;
    xSemaphoreGive(s_state_lock);
}

void lumen_led_engine_commit(const lumen_state_t *next)
{
    if (next == NULL) {
        return;
    }

    lumen_state_t accepted = *next;
    accepted.brightness = lumen_state_clamp_brightness(accepted.brightness, max_brightness());

    xSemaphoreTake(s_state_lock, portMAX_DELAY);
    s_state = accepted;
    s_mailbox = accepted;
    s_mailbox_dirty = true;
    xSemaphoreGive(s_state_lock);

    /* 二值信号量天然只保留一个 pending 唤醒，旧快照会被 s_mailbox 覆盖。 */
    xSemaphoreGive(s_render_signal);

    /* 持久化失败由 #8 接 Event 0x81 上报；本票只做 debounce 骨架。 */
    lumen_state_store_request_save(&accepted);
}

uint8_t lumen_led_engine_max_brightness(void)
{
    return max_brightness();
}
