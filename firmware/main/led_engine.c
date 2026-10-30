#include "led_engine.h"

#include <stdbool.h>
#include <string.h>

#include "esp_log.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "freertos/task.h"
#include "sdkconfig.h"

#include "gamma.h"
#include "led_count_job.h"
#include "led_render.h"
#include "led_stress.h"
#include "led_strip_owner.h"
#include "protocol.h"
#include "selftest.h"
#include "state_store.h"
#include "stress_metrics.h"

static const char *TAG = "lumen_engine";

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

/*
 * SetLedCount 异步重建状态机（§11.3）。请求在 BLE 回调里只登记，
 * 真正的 create_strip / del 与 ACK 都在渲染任务里。
 * s_response_cb 由 ble_link 注册，用来在渲染任务里发延迟 ACK。
 */
static lumen_led_count_job_t s_led_count_job;
static lumen_led_engine_response_cb s_response_cb;

static uint8_t max_brightness(void)
{
    /* 0 表示不限制，按 255 处理。 */
    uint8_t configured = (uint8_t)CONFIG_LUMEN_MAX_BRIGHTNESS;
    return configured == 0 ? 255 : configured;
}

/* 压力模式通过函数指针取快照 / 提交 / 亮度上限，不需要反向包含 led_engine.h。 */
#if CONFIG_LUMEN_RMT_STRESS_MODE
static const lumen_led_stress_engine_t k_stress_engine = {
    .snapshot = lumen_led_engine_snapshot,
    .commit = lumen_led_engine_commit,
    .max_brightness = lumen_led_engine_max_brightness,
};
#endif

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

    /*
     * 顺序很关键：先清黑旧灯带 → 删旧句柄 → 再建新句柄。
     *
     * 不能先建后删：RMT TX 在创建时用 esp_gpio_reserve() 占住 GPIO，若旧句柄
     * 还活着，新句柄会拿到 "GPIO 3 is not usable, maybe conflict with others"
     * 的警告，输出路径仍指向旧通道——新句柄能 set_pixel/refresh 但不驱动灯带，
     * 表现为「改完数量后整条灯带不再响应任何操作」。
     *
     * 另外 WS2812B 会把最后一帧像素锁存住，句柄只驱动前 target 颗时，多出来的
     * 灯收不到新数据就一直停在旧颜色上。所以删之前必须按旧数量整条清黑。
     */
    led_strip_handle_t old;
    uint16_t old_count;
    xSemaphoreTake(s_state_lock, portMAX_DELAY);
    old = lumen_led_strip_owner_get();
    /* 旧数量要在 complete() 覆盖 s_state.led_count 之前取出来。 */
    old_count = s_state.led_count;
    xSemaphoreGive(s_state_lock);

    if (old != NULL) {
        /* 旧句柄按旧数量清黑（led_strip_clear 用句柄自己的 max_leds）。 */
        esp_err_t clear_err = lumen_led_strip_owner_clear(old);
        if (clear_err != ESP_OK) {
            ESP_LOGW(TAG, "led count rebuild: 清黑旧灯带失败 %s（多余灯珠可能保持旧色）",
                     esp_err_to_name(clear_err));
        }
        /* 释放旧句柄，让出 RMT 通道与 GPIO 预留，新句柄才能正确接管输出。 */
        lumen_led_strip_owner_destroy(old);
    }

    led_strip_handle_t fresh = NULL;
    esp_err_t err = lumen_led_strip_owner_create(target, &fresh);
    if (err != ESP_OK || fresh == NULL) {
        ESP_LOGE(TAG, "led count rebuild failed: %u leds err=%s（回滚：按旧数量重建）", target,
                 esp_err_to_name(err));
        /* 旧句柄已经删了，必须把旧数量恢复出来，否则灯带彻底失去驱动。 */
        led_strip_handle_t restored = NULL;
        if (lumen_led_strip_owner_create(old_count, &restored) == ESP_OK && restored != NULL) {
            xSemaphoreTake(s_state_lock, portMAX_DELAY);
            lumen_led_strip_owner_set(restored);
            xSemaphoreGive(s_state_lock);
            lumen_led_render_invalidate();
            ESP_LOGW(TAG, "led count rebuild: 已回滚到 %u leds", old_count);
        } else {
            ESP_LOGE(TAG, "led count rebuild: 回滚也失败，灯带已失去驱动");
        }
        xSemaphoreTake(s_state_lock, portMAX_DELAY);
        lumen_led_count_job_complete(&s_led_count_job, false, NULL);
        xSemaphoreGive(s_state_lock);
        if (s_response_cb != NULL) {
            s_response_cb(seq, LUMEN_CMD_SET_LED_COUNT, LUMEN_RESULT_INTERNAL_ERROR);
        }
        return;
    }

    lumen_state_t snapshot;
    xSemaphoreTake(s_state_lock, portMAX_DELAY);
    lumen_led_strip_owner_set(fresh);
    /* 只改数量：重建期间其它命令可能已改过开关/亮度/颜色，那些值原样保留。 */
    bool committed = lumen_led_count_job_complete(&s_led_count_job, true, &s_state);
    snapshot = s_state;
    xSemaphoreGive(s_state_lock);

    /* 新句柄的像素缓冲是空的：清掉「已渲染」标记，强制按最新状态重绘。
     * 放在 committed 判定之前，任何返回路径都不会留下「以为已渲染」的状态。 */
    lumen_led_render_invalidate();

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
        lumen_led_render_snapshot(lumen_led_strip_owner_get(), &latest, &selftest,
                                  max_brightness());
    }

    /* 成功后才持久化（§11.3 第 2 条）；触发命令是 SetLedCount。 */
    lumen_state_store_request_save(&snapshot, LUMEN_CMD_SET_LED_COUNT);

    ESP_LOGI(TAG, "led count -> %u (seq=0x%02X)", snapshot.led_count, seq);
    if (s_response_cb != NULL) {
        s_response_cb(seq, LUMEN_CMD_SET_LED_COUNT, LUMEN_RESULT_OK);
    }
}

/*
 * 上电后补发帧的次数与间隔。
 *
 * 灯带用独立 5V 供电（见 docs/led-bringup.md），它的电源建立可能晚于 MCU
 * 启动——启动日志里第一次 render 出现在 325ms，此时灯带那路可能还没上电，
 * 整帧被 WS2812B 丢掉。而 s_rendered_valid 已经置位，只要状态不变就不会
 * 再发，用户看到的是「断电重启后灯是灭的，开关一次才亮」。
 *
 * 所以启动后额外强制重绘几次，把窗口覆盖过去。次数/间隔按「覆盖到 1s 左右」
 * 取，代价是 4 帧 RMT 传输，可以忽略。
 */
#define LUMEN_BOOT_REASSERT_COUNT 4
#define LUMEN_BOOT_REASSERT_INTERVAL_MS 200

static void render_task(void *arg)
{
    (void)arg;

#if CONFIG_LUMEN_RMT_STRESS_MODE
    /* 压力阶段结束后自动回到普通 latest-wins 渲染路径。 */
    lumen_led_stress_run(&k_stress_engine);
#endif

    /*
     * 自检开始后渲染任务必须按步醒来，因此等待超时取「距离下一次换色的
     * tick 数」；启动补发窗口内也按固定间隔醒来。两者都不成立时仍然
     * portMAX_DELAY 阻塞在信号量上，不轮询。
     */
    uint8_t logged_step = 0xFF;
    /* 启动补发计数：前几次醒来不看去重，强制把像素再推一遍。 */
    uint8_t boot_reassert_left = LUMEN_BOOT_REASSERT_COUNT;

    for (;;) {
        TickType_t wait = portMAX_DELAY;
        xSemaphoreTake(s_state_lock, portMAX_DELAY);
        if (boot_reassert_left > 0) {
            /* 补发窗口内按固定间隔醒来，覆盖灯带电源建立的那段时间。 */
            wait = pdMS_TO_TICKS(LUMEN_BOOT_REASSERT_INTERVAL_MS);
        }
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

        /* 超时（自检换色 / 启动补发）与状态信号都会走到这里；统一重渲染。 */
        (void)xSemaphoreTake(s_render_signal, wait);

        /*
         * 启动补发：上电后头几帧不走去重，确保灯带电源晚于 MCU 建立时
         * 也能收到像素（否则首帧被丢后要等用户碰一次开关才亮）。
         */
        if (boot_reassert_left > 0) {
            lumen_led_render_invalidate();
            --boot_reassert_left;
        }

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
        lumen_led_render_snapshot(lumen_led_strip_owner_get(), &snapshot, &selftest,
                                  max_brightness());
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

    esp_err_t err = lumen_led_strip_owner_init(s_state.led_count);
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

void lumen_led_engine_state_bytes(uint8_t out[LUMEN_STATE_BYTES])
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
