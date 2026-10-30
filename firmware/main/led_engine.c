#include "led_engine.h"

#include <stdbool.h>
#include <string.h>

#include "esp_log.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "freertos/task.h"
#include "sdkconfig.h"

#include "effects.h"
#include "gamma.h"
#include "led_count_job.h"
#include "led_render.h"
#include "led_stress.h"
#include "led_strip_owner.h"
#include "protocol.h"
#include "segment_store.h"
#include "selftest.h"
#include "state_store.h"
#include "strip_planar.h"
#include "stress_metrics.h"

static const char *TAG = "lumen_engine";

/*
 * 共享状态由 s_state_lock 保护。s_state 是权威状态；s_mailbox 是最新待渲染
 * 快照，配 s_mailbox_dirty + 二值信号量 s_render_signal 构成 latest-wins 邮箱：
 * 无论 BLE 回调提交多快，渲染任务醒来永远只取最后一个快照，不排队旧帧。
 *
 * s_segments 是段配置的唯一权威，同一把锁保护。段配置没有自己的邮箱：
 * 渲染任务每次醒来在锁内整份拷出（64 个槽位 × 16 字节 = 1KB），
 * 天然 latest-wins，并且与 State 快照来自同一临界区，不会出现
 * 「状态更新了但段还是旧的」这种撕裂帧。
 */
static SemaphoreHandle_t s_state_lock;
static SemaphoreHandle_t s_render_signal;
static lumen_state_t s_state;
static lumen_state_t s_mailbox;
static bool s_mailbox_dirty;
static lumen_segment_store_t s_segments;

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

/*
 * #29 多灯带 TDM 状态。s_planar 是引脚/灯珠数/降级的唯一权威，
 * s_planar_stats 是给串口看的轮询实测数据（票面要求「每轮耗时 / 每条刷新间隔」）。
 *
 * 只有渲染任务读写 s_planar 的 cursor / degraded / stats（它独占灯带句柄）；
 * BLE 回调只通过 lumen_led_engine_set_strip_count 改灯珠数，那条路径持
 * s_state_lock 并只动 count 字段。二者的交集用 s_state_lock 保护。
 */
static lumen_planar_t s_planar;
static lumen_planar_stats_t s_planar_stats;
static led_strip_handle_t s_tdm_strip;

/* 每条灯带的上一帧，用于 TDM 下逐条去重（跳过没变化的条）。 */
static bool s_tdm_rendered_valid[LUMEN_MAX_STRIPS];
static uint16_t s_tdm_rendered_count[LUMEN_MAX_STRIPS];
static uint8_t s_tdm_rendered_frame[LUMEN_MAX_STRIPS][LUMEN_MAX_LEDS * 3];

static uint8_t max_brightness(void)
{
    /* 0 表示不限制，按 255 处理。 */
    uint8_t configured = (uint8_t)CONFIG_LUMEN_MAX_BRIGHTNESS;
    return configured == 0 ? 255 : configured;
}

/* 与 effects / segment_store 相同的毫秒基准（无符号，49 天回绕）。 */
static uint32_t now_ms(void)
{
    return (uint32_t)(esp_timer_get_time() / 1000);
}

/*
 * 重算 State 的 v2 摘要字段（**调用者必须持锁**）。
 *
 *  - 字节 9 `seg_count`：strip 0 的**活动**段数。每次写段 / 清段都必须重算，
 *    不是只在初始化时算一次。
 *  - 字节 2-4 `R/G/B`：docs/protocol.md §7 定义为「strip 0 / seg 0 的基准色」，
 *    由 seg 0 的 hue+sat 算出（不含动画包络）；seg 0 不活动或不存在时是 0。
 *
 * 一个活动段都没有时保留 v1 的单色值（s_state.r/g/b）：这是刻意的向后兼容——
 * 现有单灯带功能不退化，且与协议默认值（255,180,120 / seg_count 0，
 * 见 docs/protocol.md §7.1 与共享向量 state_read_example_hex）一致。
 * 一旦有活动段，State 就完全由段配置决定。
 */
static void refresh_state_summary_locked(void)
{
    s_state.seg_count = lumen_segment_store_count(&s_segments, 0);
    if (s_state.seg_count == 0) {
        return; /* 保持 v1 单色 */
    }
    uint8_t rgb[3];
    lumen_segment_store_state_rgb(&s_segments, 0, rgb);
    s_state.r = rgb[0];
    s_state.g = rgb[1];
    s_state.b = rgb[2];
}

/*
 * 拍一份持久化快照（**调用者必须持锁**）。
 * 段配置不在 State 里，必须一起写进 NVS，否则断电重启后各段颜色丢失。
 */
static lumen_persist_t persist_snapshot_locked(void)
{
    lumen_persist_t snapshot;
    snapshot.state = s_state;
    snapshot.segments = s_segments;
    /* #29：每条灯带的灯珠数一起存，断电重启后 8 条都要恢复。 */
    for (uint8_t i = 0; i < LUMEN_MAX_STRIPS; ++i) {
        const lumen_planar_strip_t *cfg = lumen_planar_get(&s_planar, i);
        snapshot.strip_counts[i] = cfg != NULL ? cfg->count : 0;
    }
    return snapshot;
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
 *    成功才在锁内替换 s_strip 并写 s_state.led_count（保留其它字段）、
 *    裁剪越界段、重算摘要，然后 del 旧句柄、强制重绘、debounce 持久化、回 ACK 0x00；
 *    失败则什么都不替换（旧句柄、旧数量原样保留），回 ACK 0x09。
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
     * #29：TDM 模式下所有条共用**一个**按 max_count 建的句柄，绝不能在改
     * strip 0 的数量时把它删掉重建——那会连带中断其余 7 条的输出，而且
     * s_tdm_strip 会变成悬空指针（它指向已被 del 的句柄）。
     *
     * 所以 TDM 下这里只更新数量与配置：只要新数量不超过句柄的 max_leds 就
     * 无需重建；超出时按 max_count 重建一次同一个句柄，并把 s_tdm_strip 换成
     * 新句柄。两条路径都必须让 s_tdm_strip 与 owner 的当前句柄保持一致。
     */
    bool tdm_mode = s_planar.strip_count > 1;

    if (tdm_mode) {
        uint16_t prev_max = s_planar.max_count;
        lumen_persist_t persist;
        xSemaphoreTake(s_state_lock, portMAX_DELAY);
        bool committed = lumen_led_count_job_complete(&s_led_count_job, true, &s_state);
        s_state.led_count = target;
        (void)lumen_planar_set_count(&s_planar, 0, target);
        persist = persist_snapshot_locked();
        xSemaphoreGive(s_state_lock);

        if (!committed) {
            if (s_response_cb != NULL) {
                s_response_cb(seq, LUMEN_CMD_SET_LED_COUNT, LUMEN_RESULT_INTERNAL_ERROR);
            }
            return;
        }

        /*
         * 句柄的 max_leds 必须覆盖最长的那条。target 变大且超过现有
         * max_count 时重建同一个句柄（先删后建，理由见下方 v1 路径注释）。
         */
        if (target > prev_max) {
            led_strip_handle_t old = s_tdm_strip;
            if (old != NULL) {
                (void)lumen_led_strip_owner_clear(old);
                lumen_led_strip_owner_destroy(old);
                s_tdm_strip = NULL;
            }
            led_strip_handle_t fresh = NULL;
            esp_err_t err =
                lumen_led_strip_owner_create_on(s_planar.strips[0].gpio, target, &fresh);
            if (err != ESP_OK || fresh == NULL) {
                /* 重建失败：尽力按旧上限恢复，避免整块板失去驱动。 */
                ESP_LOGE(TAG, "TDM 句柄扩容失败 %s，按 %u 重建", esp_err_to_name(err), prev_max);
                if (lumen_led_strip_owner_create_on(s_planar.strips[0].gpio, prev_max, &fresh) ==
                        ESP_OK &&
                    fresh != NULL) {
                    s_tdm_strip = fresh;
                    lumen_led_strip_owner_set(fresh);
                }
                if (s_response_cb != NULL) {
                    s_response_cb(seq, LUMEN_CMD_SET_LED_COUNT, LUMEN_RESULT_INTERNAL_ERROR);
                }
                return;
            }
            s_tdm_strip = fresh;
            lumen_led_strip_owner_set(fresh);
            ESP_LOGI(TAG, "TDM 句柄扩容到 max_leds=%u", target);
        }

        /* 数量变了：所有条的上一帧尺寸都按 max_count 推过，强制重刷一遍。 */
        for (uint8_t i = 0; i < LUMEN_MAX_STRIPS; ++i) {
            s_tdm_rendered_valid[i] = false;
        }
        lumen_led_render_invalidate();
        lumen_state_store_request_save(&persist, LUMEN_CMD_SET_LED_COUNT);
        ESP_LOGI(TAG, "led count strip0 -> %u（TDM 模式）", target);
        if (s_response_cb != NULL) {
            s_response_cb(seq, LUMEN_CMD_SET_LED_COUNT, LUMEN_RESULT_OK);
        }
        return;
    }

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

    lumen_persist_t snapshot;
    lumen_state_t latest;
    lumen_segment_store_t render_segments;
    lumen_selftest_t selftest;
    bool committed = false;
    xSemaphoreTake(s_state_lock, portMAX_DELAY);
    lumen_led_strip_owner_set(fresh);
    /* 只改数量：重建期间其它命令可能已改过开关/亮度/颜色，那些值原样保留。 */
    committed = lumen_led_count_job_complete(&s_led_count_job, true, &s_state);
    if (committed) {
        /*
         * 裁剪越界段（docs/v2-effects-engine.md §7.2 第 3 条）：任何 end >= 新数量
         * 的段失效，不自动缩短阈值——自动改用户边界比丢弃更意外。
         */
        uint8_t pruned = lumen_segment_store_prune(&s_segments, 0, s_state.led_count);
        if (pruned > 0) {
            ESP_LOGW(TAG, "led count -> %u：%u 个段越界已失效", s_state.led_count, pruned);
        }
        refresh_state_summary_locked();
        /* 重建期间 commit 过的快照已经被这一帧覆盖，邮箱不再需要。 */
        s_mailbox_dirty = false;
    }
    latest = s_state;
    render_segments = s_segments;
    selftest = s_selftest;
    snapshot = persist_snapshot_locked();
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

    /* 自检激活时新句柄也该显示自检色（§11.2 第 4 条）。 */
    lumen_led_render_snapshot(lumen_led_strip_owner_get(), &latest, &render_segments, &selftest,
                              max_brightness(), now_ms());

    /* 成功后才持久化（§11.3 第 2 条）；触发命令是 SetLedCount。 */
    lumen_state_store_request_save(&snapshot, LUMEN_CMD_SET_LED_COUNT);

    ESP_LOGI(TAG, "led count -> %u (seq=0x%02X)", latest.led_count, seq);
    if (s_response_cb != NULL) {
        s_response_cb(seq, LUMEN_CMD_SET_LED_COUNT, LUMEN_RESULT_OK);
    }
}

/*
 * TDM 轮询一条灯带（#29）。只有渲染任务调用。
 *
 * 一次调用 = 切 GPIO → 合成该条像素 → 推一帧。返回 true 表示真的推了帧
 * （像素有变化或强制重绘）；false 表示该条跳过（无变化 / 降级）。
 *
 * 为什么一条一条刷而不是同步刷全部 8 条：C3 只有一个 RMT 通道（TDM 复用），
 * 一轮里逐条切换引脚。WS2812B 锁存住自己最后收到的画面，所以切走之后
 * 那条灯带保持不动——这是 TDM 可行的物理前提。
 *
 * 去重按条独立：一段动画只让那一段所在的灯带每帧都刷，其余灯带不变就跳过，
 * 这样「静态段不因动画帧循环而空转刷帧」在多灯带下依然成立（#30 验收点）。
 */
static bool tdm_push_strip(uint8_t strip_id, const lumen_state_t *snapshot,
                           const lumen_segment_store_t *segments,
                           const lumen_selftest_t *selftest, bool force)
{
    const lumen_planar_strip_t *cfg = lumen_planar_get(&s_planar, strip_id);
    if (cfg == NULL || !cfg->enabled || cfg->degraded) {
        return false;
    }
    if (s_tdm_strip == NULL) {
        return false;
    }

    uint8_t frame[LUMEN_MAX_LEDS * 3];
    uint16_t n = lumen_led_render_compose_strip(snapshot, segments, selftest, max_brightness(),
                                               now_ms(), strip_id, cfg->count, frame,
                                               sizeof(frame));
    if (n == 0) {
        return false;
    }

    if (!force && s_tdm_rendered_valid[strip_id] && s_tdm_rendered_count[strip_id] == n &&
        memcmp(frame, s_tdm_rendered_frame[strip_id], (size_t)n * 3u) == 0) {
        return false; /* 该条画面没变：不切引脚、不刷，省一整帧的 RMT 时间 */
    }

    esp_err_t err = lumen_led_strip_owner_switch_gpio(s_tdm_strip, cfg->gpio);
    if (err != ESP_OK) {
        /* 切引脚失败：该条判降级，其余 7 条继续（票面「一条不接不影响其它」）。 */
        if (lumen_planar_mark_degraded(&s_planar, strip_id)) {
            ESP_LOGW(TAG, "strip %u (GPIO%u) 切换引脚失败 %s，已降级；其余灯带继续",
                     strip_id, cfg->gpio, esp_err_to_name(err));
        }
        return false;
    }

    err = lumen_led_strip_owner_push_pixels_n(s_tdm_strip, frame, s_planar.max_count, n);
    if (err != ESP_OK) {
        /* refresh 失败同样按「这条不接」处理，不让它拖住整轮。 */
        if (lumen_planar_mark_degraded(&s_planar, strip_id)) {
            ESP_LOGW(TAG, "strip %u (GPIO%u) 刷新失败 %s，已降级；其余灯带继续", strip_id,
                     cfg->gpio, esp_err_to_name(err));
        }
        return false;
    }

    memcpy(s_tdm_rendered_frame[strip_id], frame, (size_t)n * 3u);
    s_tdm_rendered_count[strip_id] = n;
    s_tdm_rendered_valid[strip_id] = true;
    return true;
}

/*
 * 跑一轮 TDM：把每条可用灯带刷一遍，并记录本轮耗时（票面要求的实测数字）。
 * 单灯带（strip_count == 1）时不走这里，仍用 lumen_led_render_snapshot，
 * 保证 v1 单灯带行为逐字节不变。
 */
static void tdm_run_round(const lumen_state_t *snapshot, const lumen_segment_store_t *segments,
                          const lumen_selftest_t *selftest, bool force)
{
    int64_t t0 = esp_timer_get_time();
    uint8_t pushed = 0;
    for (uint8_t i = 0; i < s_planar.strip_count; ++i) {
        if (tdm_push_strip(i, snapshot, segments, selftest, force)) {
            ++pushed;
        }
    }
    uint32_t round_us = (uint32_t)(esp_timer_get_time() - t0);
    lumen_planar_note_round(&s_planar_stats, round_us, pushed);

    /*
     * 每 60 轮打一行：这是「8 路轮询实测周期」的唯一固件侧证据（#20 要求
     * 由 #29 补上这个数字）。逐轮打会把串口淹掉，且串口本身会干扰测量。
     */
    if (s_planar_stats.rounds % 60u == 0u) {
        uint32_t avg = lumen_planar_stats_avg_us(&s_planar_stats);
        ESP_LOGI(TAG,
                 "tdm: strips=%u active=%u round=%uus avg=%uus max=%uus pushed=%lu "
                 "(每条间隔≈%uus)",
                 s_planar.strip_count, lumen_planar_active_count(&s_planar), round_us, avg,
                 s_planar_stats.round_us_max, (unsigned long)s_planar_stats.strips_pushed,
                 (unsigned)avg);
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
     *
     * #25 只有静态段：没有动画帧循环，静态场景与 v1 一样零额外 CPU
     * （docs/v2-effects-engine.md §3.1）。帧循环由 #30/#31 的 need_frames 加入。
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
         * TDM 路径下同样要逐条强制刷一遍，否则降级标记与供电建立的窗口
         * 会让某条灯带一直黑着。
         */
        bool force_round = false;
        if (boot_reassert_left > 0) {
            lumen_led_render_invalidate();
            for (uint8_t i = 0; i < LUMEN_MAX_STRIPS; ++i) {
                s_tdm_rendered_valid[i] = false;
            }
            force_round = true;
            --boot_reassert_left;
        }

        /* 先处理 SetLedCount 的重建：它会重建句柄、强制重绘并回延迟 ACK。
         * 重建期间的其它命令已进邮箱，下面的 latest-wins 取最新快照兜底。 */
        rebuild_led_count_if_pending();

        lumen_state_t snapshot;
        lumen_segment_store_t segments;
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
        /* 段配置与状态来自同一临界区，避免撕裂帧。 */
        segments = s_segments;
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

        /* 渲染耗时（set_pixel + 阻塞 refresh）不持锁，State read 不会被拖住。
         *
         * 单灯带：走 v1 路径（逐字节行为不变）。
         * 多灯带（#29）：一轮 TDM 把所有可用条刷一遍；某条画面没变就跳过，
         * 所以静态条不会因为别人的动画而空转刷帧。 */
        if (s_planar.strip_count > 1) {
            tdm_run_round(&snapshot, &segments, &selftest, force_round);
        } else {
            lumen_led_render_snapshot(lumen_led_strip_owner_get(), &snapshot, &segments,
                                      &selftest, max_brightness(), now_ms());
        }
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
    lumen_segment_store_init(&s_segments);
    s_response_cb = NULL;

    lumen_state_defaults(&s_state, CONFIG_LUMEN_LED_COUNT);

    /*
     * 恢复持久化配置（状态 + 段配置）。失败（无历史 / 损坏 / 旧版本）时
     * 保留协议默认值，并按「没有任何段」继续——沿用 v1 的 corrupt → defaults。
     */
    lumen_persist_t restored;
    bool have_saved = lumen_state_store_load(&restored);
    if (have_saved) {
        s_state = restored.state;
        s_segments = restored.segments;
        /*
         * t0_ms 不持久化（docs/v2-effects-engine.md §7.3）：加载后统一设为
         * 当前时刻，动画从这个时刻起算相位。静态段不用它，但保持字段有效。
         */
        uint32_t t0 = now_ms();
        for (uint8_t strip = 0; strip < LUMEN_MAX_STRIPS; ++strip) {
            for (uint8_t slot = 0; slot < LUMEN_MAX_SEGMENTS; ++slot) {
                s_segments.slot[strip][slot].t0_ms = t0;
            }
        }
        refresh_state_summary_locked();
    }
    s_state.brightness = lumen_state_clamp_brightness(s_state.brightness, max_brightness());

    ESP_LOGI(TAG,
             "state %s: power=%u brightness=%u rgb=%u,%u,%u leds=%u max=%u segs=%u",
             have_saved ? "restored" : "default", s_state.power, s_state.brightness, s_state.r,
             s_state.g, s_state.b, s_state.led_count, max_brightness(), s_state.seg_count);

    /*
     * #29 多灯带初始化。引脚来自 Kconfig 的逗号分隔列表；少于 2 条时直接走
     * 单灯带路径（v1 行为逐字节不变，验收点「现有单灯带功能不退化」）。
     *
     * 注意：TDM 只占 1 个 RMT 通道，所以句柄按「所有条里最大的灯珠数」建
     * 一次，运行时用 led_strip_switch_gpio 切引脚复用（C3 只有 2 个 TX 通道）。
     */
    uint16_t pins_buf[LUMEN_MAX_STRIPS];
    uint8_t pin_count = lumen_planar_parse_list(CONFIG_LUMEN_STRIP_PINS, pins_buf,
                                                LUMEN_MAX_STRIPS);
    uint16_t counts[LUMEN_MAX_STRIPS];
    uint8_t strip_n = pin_count;
    if (strip_n > 1) {
        uint8_t pins8[LUMEN_MAX_STRIPS];
        for (uint8_t i = 0; i < strip_n; ++i) {
            if (pins_buf[i] > 0xFF) {
                ESP_LOGE(TAG, "strip pin %u 超出 GPIO 范围", (unsigned)pins_buf[i]);
                strip_n = 1;
                break;
            }
            pins8[i] = (uint8_t)pins_buf[i];
            /*
             * 灯珠数：有恢复的持久化值就用它（断电重启后 8 条各自恢复），
             * 否则用 State 的默认值（首次上电）。
             */
            uint16_t restored_count = have_saved ? restored.strip_counts[i] : 0;
            counts[i] = (restored_count >= 1 && restored_count <= LUMEN_MAX_LEDS)
                            ? restored_count
                            : s_state.led_count;
        }
        if (strip_n > 1 &&
            !lumen_planar_init(&s_planar, pins8, counts, strip_n)) {
            ESP_LOGE(TAG, "TDM 配置非法（引脚重复 / 灯珠数越界），退回单灯带");
            strip_n = 1;
        }
    }

    esp_err_t err;
    if (strip_n > 1) {
        err = lumen_led_strip_owner_create_on(s_planar.strips[0].gpio, s_planar.max_count,
                                              &s_tdm_strip);
        if (err == ESP_OK) {
            lumen_led_strip_owner_set(s_tdm_strip);
        }
        ESP_LOGI(TAG, "TDM: %u 条灯带, pins=%s, max_leds=%u, mem_block_symbols=%d",
                 strip_n, CONFIG_LUMEN_STRIP_PINS, s_planar.max_count,
                 CONFIG_LUMEN_RMT_MEM_BLOCK_SYMBOLS);
    } else {
        lumen_planar_stats_reset(&s_planar_stats);
        err = lumen_led_strip_owner_init(s_state.led_count);
    }
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

    /* State 字节 8 报实际配置的灯带数（小程序据此知道要查几条）。 */
    s_state.strip_count = strip_n > 1 ? strip_n : 1;

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

    lumen_persist_t snapshot;
    xSemaphoreTake(s_state_lock, portMAX_DELAY);
    s_state = accepted;
    /* State 摘要永远由段配置决定，不信任调用方传进来的 seg_count / rgb。 */
    refresh_state_summary_locked();
    s_mailbox = s_state;
    s_mailbox_dirty = true;
    snapshot = persist_snapshot_locked();
    xSemaphoreGive(s_state_lock);

    /* 二值信号量天然只保留一个 pending 唤醒，旧快照会被 s_mailbox 覆盖。 */
    xSemaphoreGive(s_render_signal);

    /* 写失败在 ACK 之后由 Event 0x81 异步上报（§10.3）；command 是 detail。 */
    lumen_state_store_request_save(&snapshot, command);
}

uint8_t lumen_led_engine_set_segment(uint8_t strip_id, uint8_t seg_id,
                                     const lumen_segment_t *segment, uint8_t command)
{
    if (segment == NULL) {
        return LUMEN_RESULT_INVALID_PARAM;
    }

    lumen_segment_t applied = *segment;
    applied.active = true;
    /* 生效时刻由引擎填：相位以写入时刻为基准（docs/v2-effects-engine.md §5.1）。 */
    applied.t0_ms = now_ms();

    lumen_persist_t snapshot;
    uint8_t result;
    uint8_t seg_count;

    xSemaphoreTake(s_state_lock, portMAX_DELAY);
    /* 防御性再校验一次（命令层已校验；这里用引擎里的权威段表与 led_count）。 */
    result = lumen_segment_store_set(&s_segments, strip_id, s_state.strip_count, seg_id,
                                     (uint8_t)s_state.led_count, &applied);
    if (result == LUMEN_RESULT_OK) {
        refresh_state_summary_locked();
        s_mailbox = s_state;
        s_mailbox_dirty = true;
        snapshot = persist_snapshot_locked();
        seg_count = s_state.seg_count;
    } else {
        seg_count = 0;
    }
    xSemaphoreGive(s_state_lock);

    if (result != LUMEN_RESULT_OK) {
        ESP_LOGW(TAG, "SetSegment 被拒 strip=%u seg=%u start=%u end=%u result=0x%02X", strip_id,
                 seg_id, applied.start, applied.end, result);
        return result;
    }

    xSemaphoreGive(s_render_signal);
    /* 只有配置变更才请求持久化（动画帧循环绝不写 NVS，§7.3）。 */
    lumen_state_store_request_save(&snapshot, command);

    ESP_LOGI(TAG, "SetSegment strip=%u seg=%u [%u-%u] type=0x%02X hue=%u sat=%u segs=%u",
             strip_id, seg_id, applied.start, applied.end, applied.type, applied.hue,
             applied.sat, seg_count);
    return LUMEN_RESULT_OK;
}

uint8_t lumen_led_engine_clear_segment(uint8_t strip_id, uint8_t seg_id, uint8_t command)
{
    if (strip_id >= LUMEN_MAX_STRIPS || seg_id >= LUMEN_MAX_SEGMENTS) {
        return LUMEN_RESULT_INVALID_PARAM;
    }

    lumen_persist_t snapshot;
    bool was_active;
    uint8_t seg_count;

    xSemaphoreTake(s_state_lock, portMAX_DELAY);
    was_active = lumen_segment_store_clear(&s_segments, strip_id, seg_id);
    refresh_state_summary_locked();
    s_mailbox = s_state;
    s_mailbox_dirty = true;
    snapshot = persist_snapshot_locked();
    seg_count = s_state.seg_count;
    xSemaphoreGive(s_state_lock);

    xSemaphoreGive(s_render_signal);
    lumen_state_store_request_save(&snapshot, command);

    ESP_LOGI(TAG, "ClearSegment strip=%u seg=%u was_active=%d segs=%u", strip_id, seg_id,
             was_active ? 1 : 0, seg_count);
    return LUMEN_RESULT_OK;
}

void lumen_led_engine_segments_snapshot(lumen_segment_store_t *out)
{
    if (out == NULL) {
        return;
    }
    xSemaphoreTake(s_state_lock, portMAX_DELAY);
    *out = s_segments;
    xSemaphoreGive(s_state_lock);
}

uint8_t lumen_led_engine_segments(uint8_t strip_id, lumen_segment_t *out, uint8_t cap)
{
    if (out == NULL || cap == 0 || strip_id >= LUMEN_MAX_STRIPS) {
        return 0;
    }
    uint8_t written = 0;
    xSemaphoreTake(s_state_lock, portMAX_DELAY);
    for (uint8_t slot = 0; slot < LUMEN_MAX_SEGMENTS && written < cap; ++slot) {
        const lumen_segment_t *seg = &s_segments.slot[strip_id][slot];
        if (!seg->active) {
            continue;
        }
        out[written++] = *seg;
    }
    xSemaphoreGive(s_state_lock);
    return written;
}

uint8_t lumen_led_engine_segment_mask(uint8_t strip_id)
{
    if (strip_id >= LUMEN_MAX_STRIPS) {
        return 0;
    }
    xSemaphoreTake(s_state_lock, portMAX_DELAY);
    uint8_t mask = lumen_segment_store_mask(&s_segments, strip_id);
    xSemaphoreGive(s_state_lock);
    return mask;
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
    return lumen_led_engine_set_led_count_for_strip(0, count, seq);
}

/*
 * #29：按灯带独立设数量。
 *
 * strip 0 走原来的重建路径（会重建整个句柄）。
 * strip 1..7 不改句柄——TDM 下所有条共用一个句柄，句柄按 max_count 建，
 * 所以只需改 s_planar 里那条的 count 并把该条的「已渲染」标记清掉，
 * 下一次轮询自然按新数量推送。这里同步完成，可以直接回 ACK 0x00。
 */
uint8_t lumen_led_engine_set_led_count_for_strip(uint8_t strip_id, uint16_t count, uint8_t seq)
{
    if (count < 1 || count > LUMEN_MAX_LEDS) {
        /* 命令层已拦下越界值；这里防御性拒绝，不改状态机。 */
        return LUMEN_RESULT_INVALID_PARAM;
    }
    if (strip_id >= LUMEN_MAX_STRIPS) {
        return LUMEN_RESULT_INVALID_PARAM;
    }

    if (strip_id != 0) {
        /*
         * 非 0 号灯带：只改该条的灯珠数。单灯带路径下 s_planar.strip_count == 0，
         * 此时拒绝（命令层已按 strip_count 挡过，这里防绕过）。
         */
        xSemaphoreTake(s_state_lock, portMAX_DELAY);
        bool valid = strip_id < s_planar.strip_count;
        if (valid) {
            if (s_planar.strips[strip_id].count == count) {
                xSemaphoreGive(s_state_lock);
                return LUMEN_RESULT_OK;
            }
            (void)lumen_planar_set_count(&s_planar, strip_id, count);
            /* 数量变了：该条上一帧的尺寸不再有效，强制重刷一次。 */
            s_tdm_rendered_valid[strip_id] = false;
        }
        xSemaphoreGive(s_state_lock);
        if (!valid) {
            return LUMEN_RESULT_INVALID_PARAM;
        }
        xSemaphoreGive(s_render_signal);
        ESP_LOGI(TAG, "SetLedCount strip %u -> %u（seq=0x%02X），无需重建句柄", strip_id, count,
                 seq);
        return LUMEN_RESULT_OK;
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
