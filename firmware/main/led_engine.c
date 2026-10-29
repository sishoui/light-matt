#include "led_engine.h"

#include <stdbool.h>
#include <string.h>

#include "esp_log.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "freertos/task.h"
#include "led_strip.h"
#include "sdkconfig.h"

#include "gamma.h"
#include "state_store.h"
#include "stress_metrics.h"

static const char *TAG = "lumen_engine";

#define LUMEN_RMT_RESOLUTION_HZ (10 * 1000 * 1000)

/* WS2812B 通常是 GRB；若实测红绿互换，改 Kconfig 的 LUMEN_LED_COLOR_ORDER。 */
#if CONFIG_LUMEN_LED_COLOR_ORDER_RGB
#define LUMEN_COLOR_FORMAT LED_STRIP_COLOR_COMPONENT_FMT_RGB
#else
#define LUMEN_COLOR_FORMAT LED_STRIP_COLOR_COMPONENT_FMT_GRB
#endif

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

/*
 * 把一帧像素写进驱动并阻塞等待 RMT 发完。
 * 只有渲染任务调用（灯带句柄唯一所有者）。
 * 压力模式开启时顺带记录返回码与阻塞耗时；关闭时两次 esp_timer 调用
 * 都被编译掉，产品路径与 #6 骨架一致。
 */
static esp_err_t push_frame(uint8_t r, uint8_t g, uint8_t b, uint16_t count)
{
    for (uint16_t i = 0; i < count; ++i) {
        led_strip_set_pixel(s_strip, i, r, g, b);
    }

#if CONFIG_LUMEN_RMT_STRESS_MODE
    int64_t t0 = esp_timer_get_time();
#endif
    esp_err_t err = led_strip_refresh(s_strip);
#if CONFIG_LUMEN_RMT_STRESS_MODE
    lumen_stress_note_refresh(err, esp_timer_get_time() - t0);
#endif
    if (err != ESP_OK) {
        ESP_LOGW(TAG, "refresh failed: %s", esp_err_to_name(err));
    }
    return err;
}

/*
 * 渲染一份快照。调用者是渲染任务，且持有灯带句柄的唯一所有权。
 * 同步 refresh() 而不是 refresh_async()：只有一个渲染任务、没有并发刷新，
 * 引入 async 就必须自建双缓冲，而本票没有任何收益。RMT × BLE 的调优在 #7。
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

    if (push_frame(r, g, b, count) != ESP_OK) {
        return;
    }

    s_rendered_r = r;
    s_rendered_g = g;
    s_rendered_b = b;
    s_rendered_brightness = brightness;
    s_rendered_count = count;
    s_rendered_valid = true;
}

#if CONFIG_LUMEN_RMT_STRESS_MODE
/*
 * ===== issue #7 专用：RMT × BLE 共存压力阶段 =====
 *
 * 与产品路径的区别只有两点：
 *   1. 不等 latest-wins 信号量，而是按固定周期强制刷新（制造持续 RMT 负载）；
 *   2. 每帧的返回码/耗时、循环间隔抖动、heap、BLE 计数打到串口。
 *
 * 压力模式不读共享状态的颜色：它用固定序列/固定色，确保每组的刺激可复现。
 * BLE 服务本身照常工作（连接、读 State、写 RX 日志），因此五组实验可以在
 * 同一份固件上只改 Kconfig 跑完。
 */

typedef struct {
    uint8_t r;
    uint8_t g;
    uint8_t b;
} stress_color_t;

/*
 * CYCLE 模式每周期换一帧。颜色亮度统一由 CONFIG_LUMEN_STRESS_BRIGHTNESS
 * 缩放（默认 64），避免全白高亮把开发板 USB 5V 拉垮、把「错色」和「掉压」
 * 混在一起。STEADY 模式固定用第 0 帧（暗红），便于肉眼数错色帧。
 */
static const stress_color_t k_stress_colors[] = {
    {255, 0, 0},  {0, 255, 0},   {0, 0, 255}, {255, 180, 120},
    {255, 255, 0}, {0, 255, 255}, {255, 0, 255}, {0, 0, 0},
};
#define STRESS_COLOR_COUNT (sizeof(k_stress_colors) / sizeof(k_stress_colors[0]))

/* 运行压力阶段；到时（CONFIG_LUMEN_STRESS_DURATION_MIN）返回后走普通渲染循环。 */
static void run_stress_phase(void)
{
    const int64_t duration_us = (int64_t)CONFIG_LUMEN_STRESS_DURATION_MIN * 60 * 1000000;

    /* 灯珠数量当前不会在压力阶段变化（SetLedCount 在 #8），启动时读一次。 */
    uint16_t count;
    xSemaphoreTake(s_state_lock, portMAX_DELAY);
    count = s_state.led_count;
    xSemaphoreGive(s_state_lock);

    ESP_LOGI(TAG, "压力循环开始：%dms/帧（约 %dHz），亮度=%d，灯数=%u，"
                  "时长=%d 分钟（0=无限），async=%s",
             CONFIG_LUMEN_STRESS_PERIOD_MS, 1000 / CONFIG_LUMEN_STRESS_PERIOD_MS,
             CONFIG_LUMEN_STRESS_BRIGHTNESS, count, CONFIG_LUMEN_STRESS_DURATION_MIN,
#if CONFIG_LUMEN_STRESS_REFRESH_ASYNC
             "on"
#else
             "off"
#endif
    );

#if CONFIG_LUMEN_STRESS_START_DELAY_S > 0
    /* 给手机留出连接并开始写入的时间：组 2/3 的 BLE 活动必须与刷新重叠。 */
    ESP_LOGI(TAG, "等待 %d 秒后开始压力循环（这段时间灯带静止，便于手机连接）",
             CONFIG_LUMEN_STRESS_START_DELAY_S);
    vTaskDelay(pdMS_TO_TICKS(CONFIG_LUMEN_STRESS_START_DELAY_S * 1000));
#endif

    TickType_t last_wake = xTaskGetTickCount();
    const int64_t started = esp_timer_get_time();
    int64_t last_loop_us = 0;
    uint32_t frame = 0;
#if CONFIG_LUMEN_STRESS_REFRESH_ASYNC
    bool async_inflight = false;
#endif

    for (;;) {
        /* 固定节拍唤醒；间隔测量放在唤醒后，量到的是真实周期。 */
        vTaskDelayUntil(&last_wake, pdMS_TO_TICKS(CONFIG_LUMEN_STRESS_PERIOD_MS));

        int64_t now = esp_timer_get_time();
        if (duration_us > 0 && now - started >= duration_us) {
            break;
        }
        if (last_loop_us != 0) {
            lumen_stress_note_loop_interval(now - last_loop_us);
        }
        last_loop_us = now;

#if CONFIG_LUMEN_STRESS_REFRESH_ASYNC
        /*
         * 组 5：把上一帧的完成等待推迟到下一次改像素之前。
         * led_strip 3.1.1 无双缓冲，发送期间像素缓冲属于在途事务，
         * 所以必须先 wait 再 set_pixel——这是 async 的唯一合法用法。
         */
        if (async_inflight) {
            int64_t wait_t0 = esp_timer_get_time();
            esp_err_t werr = led_strip_refresh_async_done(s_strip);
            lumen_stress_note_async_wait(werr, esp_timer_get_time() - wait_t0);
            async_inflight = false;
            if (werr != ESP_OK) {
                ESP_LOGW(TAG, "refresh_async_done failed: %s", esp_err_to_name(werr));
            }
        }
#endif

#if CONFIG_LUMEN_STRESS_PATTERN_STEADY
        const stress_color_t *color = &k_stress_colors[0];
#else
        const stress_color_t *color = &k_stress_colors[frame % STRESS_COLOR_COUNT];
#endif
        uint8_t r = lumen_gamma_apply(color->r, CONFIG_LUMEN_STRESS_BRIGHTNESS);
        uint8_t g = lumen_gamma_apply(color->g, CONFIG_LUMEN_STRESS_BRIGHTNESS);
        uint8_t b = lumen_gamma_apply(color->b, CONFIG_LUMEN_STRESS_BRIGHTNESS);

        for (uint16_t i = 0; i < count; ++i) {
            led_strip_set_pixel(s_strip, i, r, g, b);
        }

#if CONFIG_LUMEN_STRESS_REFRESH_ASYNC
        int64_t t0 = esp_timer_get_time();
        esp_err_t err = led_strip_refresh_async(s_strip);
        lumen_stress_note_refresh(err, esp_timer_get_time() - t0);
        if (err == ESP_OK) {
            async_inflight = true;
        } else {
            ESP_LOGW(TAG, "refresh_async failed: %s", esp_err_to_name(err));
        }
#else
        int64_t t0 = esp_timer_get_time();
        esp_err_t err = led_strip_refresh(s_strip);
        lumen_stress_note_refresh(err, esp_timer_get_time() - t0);
        if (err != ESP_OK) {
            ESP_LOGW(TAG, "refresh failed: %s", esp_err_to_name(err));
        }
#endif

        frame++;
    }

#if CONFIG_LUMEN_STRESS_REFRESH_ASYNC
    /* 退出前必须把在途事务收干净，之后普通渲染路径才能安全改像素。 */
    if (async_inflight) {
        int64_t wait_t0 = esp_timer_get_time();
        esp_err_t werr = led_strip_refresh_async_done(s_strip);
        lumen_stress_note_async_wait(werr, esp_timer_get_time() - wait_t0);
    }
#endif
    lumen_stress_final_report();
}
#endif /* CONFIG_LUMEN_RMT_STRESS_MODE */

static void render_task(void *arg)
{
    (void)arg;

#if CONFIG_LUMEN_RMT_STRESS_MODE
    /* 压力阶段结束后自动回到普通 latest-wins 渲染路径。 */
    run_stress_phase();
#endif

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
        ESP_LOGE(TAG, "strip init failed: %s (mem_block_symbols=%d, leds=%u)",
                 esp_err_to_name(err), CONFIG_LUMEN_RMT_MEM_BLOCK_SYMBOLS, s_state.led_count);
#if CONFIG_LUMEN_RMT_STRESS_MODE
        if (CONFIG_LUMEN_RMT_MEM_BLOCK_SYMBOLS > 192) {
            ESP_LOGE(TAG, "C3 每个 RMT group 只有 4x48=192 word，mem_block_symbols>192 "
                          "无法分配；这是组 4（384）的预期失败，记录后换回 48/96/192");
        }
#endif
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

#if CONFIG_LUMEN_RMT_STRESS_MODE
    /* 压力模式的心跳打印跑在独立低优先级任务里，必须晚于指标锁创建。 */
    esp_err_t stress_err = lumen_stress_start();
    if (stress_err != ESP_OK) {
        ESP_LOGW(TAG, "压力指标心跳任务创建失败: %s", esp_err_to_name(stress_err));
    }
#endif
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
