#include "led_engine.h"

#include <inttypes.h>
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
#include "led_count_job.h"
#include "protocol.h"
#include "selftest.h"
#include "state_store.h"
#include "stress_metrics.h"

#if CONFIG_LUMEN_RMT_STRESS_MODE
/* 压力模式复用 command.c 的唯一命令语义入口（纯 reducer）与协议编解码。
 * 只在实验编译单元里引入，产品路径的依赖方向不变。 */
#include "command.h"
#endif

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

/*
 * 自检进度（协议 §11.2）。与 s_state 分开保存：自检是渲染层的临时覆盖，
 * 绝不写共享状态、绝不触发 NVS。s_state_lock 同时保护这个结构。
 */
static lumen_selftest_t s_selftest;

/* 灯带句柄的唯一所有者是渲染任务：init 创建后立刻交给渲染任务，之后只有
 * 渲染任务调用 set_pixel / refresh / del / new_rmt_device（重建）。 */
static led_strip_handle_t s_strip;

/*
 * SetLedCount 异步重建状态机（§11.3）。请求在 BLE 回调里只登记，
 * 真正的 create_strip / del 与 ACK 都在渲染任务里。
 * s_response_cb 由 ble_link 注册，用来在渲染任务里发延迟 ACK。
 */
static lumen_led_count_job_t s_led_count_job;
static lumen_led_engine_response_cb s_response_cb;

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
 *
 * selftest 是渲染任务在锁内拷出的一份自检快照（不能直接读 s_selftest：
 * BLE 回调可能并发取消/重启）。「自检覆盖 vs 存储状态」的规则集中在
 * lumen_selftest_compose()，本函数只负责 gamma、去重与刷灯。
 */
static void render_snapshot(const lumen_state_t *snapshot, const lumen_selftest_t *selftest)
{
    uint8_t stored_rgb[3] = {snapshot->r, snapshot->g, snapshot->b};
    uint8_t brightness;
    uint8_t rgb[3];

    /* 关灯把亮度乘 0，但保留状态里的亮度值；Color 仍参与 gamma 计算。 */
    uint8_t clamped =
        lumen_state_clamp_brightness(snapshot->brightness, max_brightness());
    lumen_selftest_compose(selftest, snapshot->power, clamped, stored_rgb, max_brightness(),
                           rgb, &brightness);

    uint8_t r = lumen_gamma_apply(rgb[0], brightness);
    uint8_t g = lumen_gamma_apply(rgb[1], brightness);
    uint8_t b = lumen_gamma_apply(rgb[2], brightness);
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

/*
 * SetLedCount 的句柄重建（协议 §11.3）。只在渲染任务里执行。
 *
 * 并发模型：
 *  - BLE 回调里的 lumen_led_engine_set_led_count() 只做三件事：判忙、登记
 *    pending、给渲染信号量。它绝不调 led_strip_*（句柄唯一所有者是渲染任务）。
 *  - 渲染任务在每次醒来时调用本函数：取走 pending → create_strip 新句柄 →
 *    成功才在锁内替换 s_strip 并写 s_state.led_count（保留其它字段），
 *    然后 del 旧句柄、强制重绘、debounce 持久化、回 ACK 0x00；
 *    失败则什么都替换（旧句柄、旧数量原样保留），回 ACK 0x09。
 *  - 重建期间到达的其它命令照常 commit 到 s_mailbox；本函数成功后按最新
 *    s_state 重绘（render_snapshot 用强制标志），因此画面不会丢最新状态。
 *
 * 为什么在渲染任务里：led_strip_new_rmt_device 会申请 RMT 通道与内存，
 * led_strip_del 会释放；与 set_pixel / refresh 并发会直接损坏在途事务。
 * 把「重建 + 旧句柄释放 + 立即重绘」放在同一个任务里，句柄生命周期天然串行。
 */
static void rebuild_led_count_if_pending(void)
{
    uint16_t target = 0;
    uint8_t seq = 0;

    xSemaphoreTake(s_state_lock, portMAX_DELAY);
    bool have_job = lumen_led_count_job_begin(&s_led_count_job, &target, &seq);
    xSemaphoreGive(s_state_lock);
    if (!have_job) {
        return;
    }

    ESP_LOGI(TAG, "led count rebuild begin: %u leds (seq=0x%02X)", target, seq);

    led_strip_handle_t fresh = NULL;
    esp_err_t err = create_strip(target, &fresh);
    if (err != ESP_OK || fresh == NULL) {
        ESP_LOGE(TAG, "led count rebuild failed: %u leds err=%s（保留旧句柄与旧数量）", target,
                 esp_err_to_name(err));
        xSemaphoreTake(s_state_lock, portMAX_DELAY);
        lumen_led_count_job_complete(&s_led_count_job, false, NULL);
        xSemaphoreGive(s_state_lock);
        if (s_response_cb != NULL) {
            s_response_cb(seq, LUMEN_CMD_SET_LED_COUNT, LUMEN_RESULT_INTERNAL_ERROR);
        }
        return;
    }

    led_strip_handle_t old;
    lumen_state_t snapshot;
    xSemaphoreTake(s_state_lock, portMAX_DELAY);
    old = s_strip;
    s_strip = fresh;
    /* 只改数量：重建期间其它命令可能已改过开关/亮度/颜色，那些值原样保留。 */
    bool committed = lumen_led_count_job_complete(&s_led_count_job, true, &s_state);
    snapshot = s_state;
    xSemaphoreGive(s_state_lock);

    if (old != NULL) {
        /* 旧句柄只有渲染任务碰，del 不会与任何刷新并发。 */
        led_strip_del(old);
    }

    /* 新句柄的像素缓冲是空的：清掉「已渲染」标记，强制按最新状态重绘。
     * 放在 committed 判定之前，任何返回路径都不会留下「以为已渲染」的状态。 */
    s_rendered_valid = false;

    if (!committed) {
        /* 状态机异常（不该发生）：新句柄已经接管，但状态没更新，按失败回。 */
        ESP_LOGE(TAG, "led count job complete rejected after swap");
        if (s_response_cb != NULL) {
            s_response_cb(seq, LUMEN_CMD_SET_LED_COUNT, LUMEN_RESULT_INTERNAL_ERROR);
        }
        return;
    }

    {
        lumen_state_t latest;
        lumen_selftest_t selftest;
        xSemaphoreTake(s_state_lock, portMAX_DELAY);
        latest = s_state;
        /* 重建期间 commit 过的快照已经被这一帧覆盖，邮箱不再需要。 */
        s_mailbox_dirty = false;
        /*
         * SetLedCount 已在命令层取消自检（§11.2 第 5 条），这里读到的一般是
         * 未激活状态；仍然传一份快照而不是 NULL，保持 render_snapshot 的入参
         * 语义统一（自检激活时新句柄也该显示自检色）。
         */
        selftest = s_selftest;
        xSemaphoreGive(s_state_lock);
        render_snapshot(&latest, &selftest);
    }

    /* 成功后才持久化（§11.3 第 2 条）；触发命令是 SetLedCount。 */
    lumen_state_store_request_save(&snapshot, LUMEN_CMD_SET_LED_COUNT);

    ESP_LOGI(TAG, "led count -> %u (seq=0x%02X)", snapshot.led_count, seq);
    if (s_response_cb != NULL) {
        s_response_cb(seq, LUMEN_CMD_SET_LED_COUNT, LUMEN_RESULT_OK);
    }
}

#if CONFIG_LUMEN_RMT_STRESS_MODE
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
static bool stress_dispatch(uint8_t command, const uint8_t *payload, uint8_t payload_len,
                            lumen_state_t *out)
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
    lumen_led_engine_snapshot(&current);

    lumen_command_outcome_t outcome;
    lumen_command_dispatch(&frame, &current, max_brightness(), &outcome);

    if (!outcome.state_changed) {
        /* 命令未被 reducer 实现（或与当前状态相同）。不 commit，不改灯带状态。 */
        return false;
    }
    lumen_led_engine_commit(&outcome.next, command);
    *out = outcome.next;
    return true;
}

/* 运行压力阶段；到时（CONFIG_LUMEN_STRESS_DURATION_MIN）返回后走普通渲染循环。 */
static void run_stress_phase(void)
{
    const int64_t duration_us = (int64_t)CONFIG_LUMEN_STRESS_DURATION_MIN * 60 * 1000000;

    /* 灯珠数量当前不会在压力阶段变化（SetLedCount 在 #9/#12），启动时读一次。 */
    uint16_t count;
    xSemaphoreTake(s_state_lock, portMAX_DELAY);
    count = s_state.led_count;
    xSemaphoreGive(s_state_lock);

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
        bool changed = stress_dispatch(LUMEN_CMD_SET_POWER, &power_on, 1, &ignored);
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
            esp_err_t werr = led_strip_refresh_async_done(s_strip);
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
            if (stress_dispatch(LUMEN_CMD_SET_BRIGHTNESS, &level, 1, &accepted)) {
                /* #9 之后这条分支生效：亮度来自 reducer 生效后的状态。 */
                brightness = accepted.brightness;
                command_changed_count++;
            }

            const stress_color_t *palette = &k_stress_colors[frame_no % STRESS_COLOR_COUNT];
            uint8_t payload[3] = {palette->r, palette->g, palette->b};
            if (stress_dispatch(LUMEN_CMD_SET_COLOR, payload, sizeof(payload), &accepted)) {
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

        frame_no++;
    }

#if CONFIG_LUMEN_STRESS_REFRESH_ASYNC
    /* 退出前必须把在途事务收干净，之后普通渲染路径才能安全改像素。 */
    if (async_inflight) {
        int64_t wait_t0 = esp_timer_get_time();
        esp_err_t werr = led_strip_refresh_async_done(s_strip);
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
#endif /* CONFIG_LUMEN_RMT_STRESS_MODE */

static void render_task(void *arg)
{
    (void)arg;

#if CONFIG_LUMEN_RMT_STRESS_MODE
    /* 压力阶段结束后自动回到普通 latest-wins 渲染路径。 */
    run_stress_phase();
#endif

    /*
     * 自检开始后渲染任务必须按步醒来，因此等待超时取「距离下一次换色的
     * tick 数」；没有自检时仍然 portMAX_DELAY 阻塞在信号量上，不轮询。
     */
    uint8_t logged_step = 0xFF;

    for (;;) {
        TickType_t wait = portMAX_DELAY;
        xSemaphoreTake(s_state_lock, portMAX_DELAY);
        if (lumen_selftest_active(&s_selftest)) {
            int64_t remaining_us =
                lumen_selftest_next_step_in_us(&s_selftest, esp_timer_get_time());
            /* FreeRTOS 里 0 表示「不等待」，至少等 1 tick 才不会死锁在自检中。 */
            TickType_t ticks =
                remaining_us > 0
                    ? pdMS_TO_TICKS((uint32_t)((remaining_us + 999) / 1000))
                    : 1;
            wait = ticks > 0 ? ticks : 1;
        }
        xSemaphoreGive(s_state_lock);

        /* 超时（自检换色）与状态信号都会走到这里；不区分来源，统一重渲染。 */
        (void)xSemaphoreTake(s_render_signal, wait);

        /* 先处理 SetLedCount 的重建：它会重建句柄、强制重绘并回延迟 ACK。
         * 重建期间的其它命令已进邮箱，下面的 latest-wins 取最新快照兜底。 */
        rebuild_led_count_if_pending();

        lumen_state_t snapshot;
        lumen_selftest_t selftest;
        bool dirty;
        bool selftest_active;
        uint8_t selftest_rgb[3] = {0, 0, 0};

        xSemaphoreTake(s_state_lock, portMAX_DELAY);
        dirty = s_mailbox_dirty;
        if (dirty) {
            snapshot = s_mailbox;
            s_mailbox_dirty = false;
        } else {
            snapshot = s_state;
        }
        /*
         * 推进自检步骤（持锁：与取消/重启自检的命令互斥），并把整份自检状态
         * 拷出来给渲染用——出锁后不能再用 s_selftest，BLE 回调随时可能改它。
         * 序列走完后 active 自动变 false，渲染就会回到存储状态，这就是
         * 「结束后恢复自检前的开关/亮度/颜色」（§11.2 第 3/4 条）。
         */
        lumen_selftest_advance(&s_selftest, esp_timer_get_time());
        selftest = s_selftest;
        selftest_active = lumen_selftest_color(&selftest, selftest_rgb);
        uint8_t step = lumen_selftest_step(&selftest);
        xSemaphoreGive(s_state_lock);

        if (!selftest_active) {
            if (logged_step != 0xFF) {
                /* 序列走完或被取消：串口上要能看到「已经回到存储状态」。 */
                ESP_LOGI(TAG, "自检结束，恢复存储状态 power=%u brightness=%u rgb=%u,%u,%u",
                         snapshot.power, snapshot.brightness, snapshot.r, snapshot.g,
                         snapshot.b);
            }
            logged_step = 0xFF;
        } else if (step != logged_step) {
            /* 串口自检序列证据：与小程序日志无关，不依赖 BLE 也能看。 */
            logged_step = step;
            ESP_LOGI(TAG, "自检 %u/%d %s rgb=%u,%u,%u", (unsigned)step + 1,
                     LUMEN_SELFTEST_STEPS, lumen_selftest_step_name(step), selftest_rgb[0],
                     selftest_rgb[1], selftest_rgb[2]);
        }

        /* 渲染耗时（set_pixel + 阻塞 refresh）不持锁，State read 不会被拖住。 */
        render_snapshot(&snapshot, &selftest);
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
    lumen_selftest_reset(&s_selftest);
    lumen_led_count_job_init(&s_led_count_job);
    s_response_cb = NULL;

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

void lumen_led_engine_commit(const lumen_state_t *next, uint8_t command)
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

    /* 写失败在 ACK 之后由 Event 0x81 异步上报（§10.3）；command 是 detail。 */
    lumen_state_store_request_save(&accepted, command);
}

void lumen_led_engine_set_store_event_cb(lumen_store_event_cb cb)
{
    lumen_state_store_set_event_cb(cb);
}

void lumen_led_engine_set_response_cb(lumen_led_engine_response_cb cb)
{
    /* 只在初始化阶段由 ble_link 调用一次；不做运行期切换。 */
    s_response_cb = cb;
}

uint8_t lumen_led_engine_set_led_count(uint16_t count, uint8_t seq)
{
    if (count < 1 || count > LUMEN_MAX_LEDS) {
        /* 命令层已拦下越界值；这里防御性拒绝，不改状态机。 */
        return LUMEN_RESULT_INVALID_PARAM;
    }

    lumen_led_count_request_t status;
    xSemaphoreTake(s_state_lock, portMAX_DELAY);
    status = lumen_led_count_job_request(&s_led_count_job, count, s_state.led_count, seq);
    xSemaphoreGive(s_state_lock);

    switch (status) {
    case LUMEN_LED_COUNT_ACCEPTED:
        /* 叫醒渲染任务去重建句柄；ACK 由它完成后经 response 回调发出。 */
        xSemaphoreGive(s_render_signal);
        ESP_LOGI(TAG, "SetLedCount %u 已排队（seq=0x%02X），等渲染任务重建", count, seq);
        return LUMEN_LED_ENGINE_DEFERRED;

    case LUMEN_LED_COUNT_UNCHANGED:
        /* 数量没变：不需要重建，调用方直接回 0x00（不写 NVS，也不刷灯）。 */
        ESP_LOGI(TAG, "SetLedCount %u 与当前一致（seq=0x%02X），无需重建", count, seq);
        return LUMEN_RESULT_OK;

    case LUMEN_LED_COUNT_BUSY:
    default:
        /* §11.3：重建进行中收到第二个请求 → 0x05，不排队。 */
        ESP_LOGW(TAG, "SetLedCount %u 被拒：已有重建在排队/进行中（seq=0x%02X）", count, seq);
        return LUMEN_RESULT_BUSY;
    }
}

uint8_t lumen_led_engine_max_brightness(void)
{
    return max_brightness();
}

/*
 * 协议 §11.2 自检控制。三个函数都不碰 s_state / s_mailbox / NVS：
 * 自检只是渲染层的临时覆盖，结束后渲染任务直接回到存储状态。
 */
void lumen_led_engine_start_selftest(void)
{
    if (s_state_lock == NULL) {
        return;
    }
    xSemaphoreTake(s_state_lock, portMAX_DELAY);
    /* 重复收到 0x07 时从这里重新计时（§11.2 第 7 条）。 */
    lumen_selftest_start(&s_selftest, esp_timer_get_time());
    xSemaphoreGive(s_state_lock);
    xSemaphoreGive(s_render_signal);
}

bool lumen_led_engine_cancel_selftest(void)
{
    if (s_state_lock == NULL) {
        return false;
    }
    bool was_active;
    xSemaphoreTake(s_state_lock, portMAX_DELAY);
    was_active = lumen_selftest_active(&s_selftest);
    lumen_selftest_stop(&s_selftest);
    xSemaphoreGive(s_state_lock);

    /* 只有真的在自检时才需要立刻重绘回存储状态。 */
    if (was_active) {
        xSemaphoreGive(s_render_signal);
    }
    return was_active;
}

bool lumen_led_engine_selftest_active(void)
{
    if (s_state_lock == NULL) {
        return false;
    }
    xSemaphoreTake(s_state_lock, portMAX_DELAY);
    bool active = lumen_selftest_active(&s_selftest);
    xSemaphoreGive(s_state_lock);
    return active;
}
