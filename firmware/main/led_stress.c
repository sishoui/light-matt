#include "led_stress.h"

#include <inttypes.h>
#include <stdbool.h>

#include "esp_log.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "led_strip.h"
#include "sdkconfig.h"

#include "gamma.h"
#include "led_strip_owner.h"
#include "protocol.h"
#include "stress_metrics.h"

#if CONFIG_LUMEN_RMT_STRESS_MODE
/* 压力模式复用 command.c 的唯一命令语义入口（纯 reducer）。
 * 只在实验编译单元里引入，产品路径的依赖方向不变。 */
#include "command.h"

static const char *TAG = "lumen_engine";

/*
 * ===== issue #7 专用：RMT × BLE 共存压力阶段 =====
 *
 * 与产品路径的区别只有三点：
 *   1. 不等 latest-wins 信号量，而是按固定周期强制刷新（制造持续 RMT 负载）；
 *   2. 每帧的返回码/耗时、循环间隔抖动、heap、BLE 计数打到串口；
 *   3. 颜色刺激通过「真实协议帧 → lumen_command_dispatch（command.c 的纯
 *      reducer）→ lumen_led_engine_commit」产生，不在压力模式里另写一套
 *      命令语义。state_changed 为 false（该命令尚未由 #10 实现）时，
 *      才退回内置调色板作为实验刺激，并在串口明确标注。
 *
 * 压力模式的所有代码都在 CONFIG_LUMEN_RMT_STRESS_MODE 内，产品固件不编译；
 * led_engine 依赖 command.h 也只在这段里出现，产品路径的分层不变。
 */

typedef struct {
    uint8_t r;
    uint8_t g;
    uint8_t b;
} stress_color_t;

/*
 * 内置调色板（实验刺激的兜底，以及 STEADY 的固定色）。
 * 亮度统一由 CONFIG_LUMEN_STRESS_BRIGHTNESS 缩放（默认 64），避免全白高亮
 * 把开发板 USB 5V 拉垮、把「错色」和「掉压」混在一起。
 */
static const stress_color_t k_stress_colors[] = {
    {255, 0, 0},  {0, 255, 0},   {0, 0, 255}, {255, 180, 120},
    {255, 255, 0}, {0, 255, 255}, {255, 0, 255}, {0, 0, 0},
};
#define STRESS_COLOR_COUNT (sizeof(k_stress_colors) / sizeof(k_stress_colors[0]))

/*
 * 构造一条真实协议帧并跑完整链路：
 *   lumen_protocol_encode（含 checksum）
 *   → lumen_protocol_decode（信封校验）
 *   → lumen_command_dispatch（command.c 的唯一命令语义入口）
 *   → state_changed 时 lumen_led_engine_commit
 *
 * 返回 true 表示命令改变了共享状态，调用方应使用 *out 作为渲染数据；
 * false 表示该命令当前未被 reducer 实现或不改变状态（例如 #10 之前的
 * SetColor），调用方退回实验调色板。
 */
static bool stress_dispatch(const lumen_led_stress_engine_t *engine, uint8_t command,
                            const uint8_t *payload, uint8_t payload_len, lumen_state_t *out)
{
    /* 压力帧不经过 BLE，但仍按协议的 seq 语义递增（0x01 → 0xFF → 0x00）。 */
    static uint8_t s_stress_seq;
    s_stress_seq++;

    uint8_t bytes[LUMEN_MAX_FRAME];
    size_t len = lumen_protocol_encode(command, s_stress_seq, payload, payload_len, bytes,
                                       sizeof(bytes));
    if (len == 0) {
        return false;
    }

    lumen_frame_t frame;
    uint8_t result_code = 0xFF;
    if (lumen_protocol_decode(bytes, len, &frame, &result_code) != LUMEN_DECODE_OK) {
        return false;
    }

    lumen_state_t current;
    engine->snapshot(&current);

    lumen_command_outcome_t outcome;
    lumen_command_dispatch(&frame, &current, engine->max_brightness(), &outcome);

    if (!outcome.state_changed) {
        /* 命令未被 reducer 实现（或与当前状态相同）。不 commit，不改灯带状态。 */
        return false;
    }
    engine->commit(&outcome.next, command);
    *out = outcome.next;
    return true;
}

void lumen_led_stress_run(const lumen_led_stress_engine_t *engine)
{
    const int64_t duration_us = (int64_t)CONFIG_LUMEN_STRESS_DURATION_MIN * 60 * 1000000;

    /* 灯珠数量当前不会在压力阶段变化（SetLedCount 在 #9/#12），启动时读一次。 */
    lumen_state_t initial;
    engine->snapshot(&initial);
    uint16_t count = initial.led_count;

    ESP_LOGI(TAG, "压力循环开始：%dms/帧（约 %dHz），亮度覆盖=%d，灯数=%u，"
                  "时长=%d 分钟（0=无限），async=%s",
             CONFIG_LUMEN_STRESS_PERIOD_MS, 1000 / CONFIG_LUMEN_STRESS_PERIOD_MS,
             CONFIG_LUMEN_STRESS_BRIGHTNESS, count, CONFIG_LUMEN_STRESS_DURATION_MIN,
#if CONFIG_LUMEN_STRESS_REFRESH_ASYNC
             "on"
#else
             "off"
#endif
    );
#if CONFIG_LUMEN_STRESS_PATTERN_STEADY
    ESP_LOGW(TAG, "注意：STEADY 期间灯带固定暗红，不受协议状态控制。"
                  "手机写入仍会走完整链路（解帧/reducer/commit/ACK），只是画面不变——"
                  "这是为了让颜色恒定、便于肉眼数错色。");
#else
    ESP_LOGW(TAG, "注意：CYCLE 期间颜色来自压力循环，不是协议状态；"
                  "手机写入仍会走完整链路（解帧/reducer/commit/ACK）。");
#endif

    /* 先把灯打开，否则默认状态是 power=0，压力阶段全黑、肉眼无从判定。 */
    {
        uint8_t power_on = 1;
        lumen_state_t ignored;
        bool changed = stress_dispatch(engine, LUMEN_CMD_SET_POWER, &power_on, 1, &ignored);
        ESP_LOGI(TAG, "启动命令 SetPower(1)：%s", changed ? "已生效" : "未生效（reducer 未实现）");
    }

#if CONFIG_LUMEN_STRESS_START_DELAY_S > 0
    /* 给手机留出连接并开始写入的时间：组 2/3 的 BLE 活动必须与刷新重叠。 */
    ESP_LOGI(TAG, "等待 %d 秒后开始压力循环（这段时间灯带静止，便于手机连接）",
             CONFIG_LUMEN_STRESS_START_DELAY_S);
    vTaskDelay(pdMS_TO_TICKS(CONFIG_LUMEN_STRESS_START_DELAY_S * 1000));
#endif

    TickType_t last_wake = xTaskGetTickCount();
    const int64_t started = esp_timer_get_time();
    int64_t last_loop_us = 0;
    uint32_t frame_no = 0;
    uint32_t command_changed_count = 0;
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
            esp_err_t werr = led_strip_refresh_async_done(lumen_led_strip_owner_get());
            lumen_stress_note_async_wait(werr, esp_timer_get_time() - wait_t0);
            async_inflight = false;
            if (werr != ESP_OK) {
                ESP_LOGW(TAG, "refresh_async_done failed: %s", esp_err_to_name(werr));
            }
        }
#endif

        /*
         * 决定本帧的像素。
         *
         * STEADY：不产生状态变化，固定用调色板第 0 帧（暗红）+ 配置亮度。
         *         这是「肉眼数错色帧」必须的模式——颜色恒定，任何一闪即错。
         *
         * CYCLE ：每周期都发真实协议帧走 reducer，同时切换颜色与亮度：
         *           - SetBrightness（#9 已实现）→ 每帧都改变共享状态；
         *           - SetColor（#10 之后才实现）→ 未实现时退回内置调色板。
         *         RMT 负载与 STEADY 完全一样（每周期都完整发送 30x24 bit），
         *         只是像素与共享状态在动，对应票里的「20Hz 循环切换颜色/亮度」。
         */
        stress_color_t color;
        uint8_t brightness = CONFIG_LUMEN_STRESS_BRIGHTNESS;
#if CONFIG_LUMEN_STRESS_PATTERN_STEADY
        color = k_stress_colors[0];
        (void)command_changed_count;
#else
        {
            /*
             * 亮度档位刻意压低：最高 128，配合暖白/饱和色远低于全白电流，
             * 避免开发板 USB 5V 掉压混进「错色」统计。
             */
            static const uint8_t k_brightness_levels[] = {32, 64, 96, 128};
            uint8_t level = k_brightness_levels[frame_no %
                                                (sizeof(k_brightness_levels) /
                                                 sizeof(k_brightness_levels[0]))];
            lumen_state_t accepted;
            if (stress_dispatch(engine, LUMEN_CMD_SET_BRIGHTNESS, &level, 1, &accepted)) {
                /* #9 之后这条分支生效：亮度来自 reducer 生效后的状态。 */
                brightness = accepted.brightness;
                command_changed_count++;
            }

            const stress_color_t *palette = &k_stress_colors[frame_no % STRESS_COLOR_COUNT];
            uint8_t payload[3] = {palette->r, palette->g, palette->b};
            if (stress_dispatch(engine, LUMEN_CMD_SET_COLOR, payload, sizeof(payload), &accepted)) {
                /* #10 之后这条分支生效：颜色来自共享状态。 */
                color.r = accepted.r;
                color.g = accepted.g;
                color.b = accepted.b;
            } else {
                color = *palette;
            }
        }
#endif

        uint8_t r = lumen_gamma_apply(color.r, brightness);
        uint8_t g = lumen_gamma_apply(color.g, brightness);
        uint8_t b = lumen_gamma_apply(color.b, brightness);

        led_strip_handle_t strip = lumen_led_strip_owner_get();
        for (uint16_t i = 0; i < count; ++i) {
            led_strip_set_pixel(strip, i, r, g, b);
        }

#if CONFIG_LUMEN_STRESS_REFRESH_ASYNC
        int64_t t0 = esp_timer_get_time();
        esp_err_t err = led_strip_refresh_async(strip);
        lumen_stress_note_refresh(err, esp_timer_get_time() - t0);
        if (err == ESP_OK) {
            async_inflight = true;
        } else {
            ESP_LOGW(TAG, "refresh_async failed: %s", esp_err_to_name(err));
        }
#else
        int64_t t0 = esp_timer_get_time();
        esp_err_t err = led_strip_refresh(strip);
        lumen_stress_note_refresh(err, esp_timer_get_time() - t0);
        if (err != ESP_OK) {
            ESP_LOGW(TAG, "refresh failed: %s", esp_err_to_name(err));
        }
#endif

        frame_no++;
    }

#if CONFIG_LUMEN_STRESS_REFRESH_ASYNC
    /* 退出前必须把在途事务收干净，之后普通渲染路径才能安全改像素。 */
    if (async_inflight) {
        int64_t wait_t0 = esp_timer_get_time();
        esp_err_t werr = led_strip_refresh_async_done(lumen_led_strip_owner_get());
        lumen_stress_note_async_wait(werr, esp_timer_get_time() - wait_t0);
    }
#endif
#if !CONFIG_LUMEN_STRESS_PATTERN_STEADY
    ESP_LOGI(TAG, "CYCLE：%" PRIu32 " 帧中 %" PRIu32 " 帧由 reducer 改变了状态"
                  "（其余来自内置调色板）",
             frame_no, command_changed_count);
#endif
    lumen_stress_final_report();
}
#else  /* !CONFIG_LUMEN_RMT_STRESS_MODE */
void lumen_led_stress_run(const lumen_led_stress_engine_t *engine)
{
    (void)engine;
}
#endif /* CONFIG_LUMEN_RMT_STRESS_MODE */
