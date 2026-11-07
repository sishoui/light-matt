#include "led_engine.h"

#include <stdbool.h>
#include <string.h>

#include "esp_log.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "freertos/task.h"
#include "sdkconfig.h"

#include "command.h"
#include "effects.h"
#include "gamma.h"
#include "led_count_job.h"
#include "led_render.h"
#include "led_stress.h"
#include "led_strip_owner.h"
#include "protocol.h"
#include "save_scheduler.h"
#include "scene_compose.h"
#include "selftest.h"
#include "state_store.h"
#include "strip_planar.h"
#include "strip_power.h"
#include "stress_metrics.h"

static const char *TAG = "lumen_engine";

/*
 * 共享状态由 s_state_lock 保护。s_state 是权威状态；s_mailbox 是最新待渲染
 * 快照，配 s_mailbox_dirty + 二值信号量 s_render_signal 构成 latest-wins 邮箱：
 * 无论 BLE 回调提交多快，渲染任务醒来永远只取最后一个快照，不排队旧帧。
 *
 * 与 State 同锁的还有**两张权威表**（布局 + 三个场景）与 64 个播放头：
 *   - s_layout   ：灯组 → 部位 → 灯珠段；
 *   - s_scenes   ：三个场景，各含 部位 → 步骤 → 两层；
 *   - s_clocks   ：每个部位一个播放头（只存 origin_ms，不累加相位）。
 * 渲染任务每次醒来在锁内整份**拷出**它要用的那部分，因此不会出现
 * 「状态更新了但表还是旧的」这种撕裂帧。
 */
static SemaphoreHandle_t s_state_lock;
static SemaphoreHandle_t s_render_signal;
static lumen_state_t s_state;
static lumen_state_t s_mailbox;
static bool s_mailbox_dirty;

static lumen_layout_store_t s_layout;
static lumen_scene_set_t s_scenes;
static lumen_part_clocks_t s_clocks;

/*
 * 持久化用的 blob 静态缓冲。**必须静态**：
 *   - 布局 blob 2760 字节、场景 blob 最坏 10472 字节；
 *   - 存储任务栈只有 5120 字节（seams.md §B7 算过余量约 1.8 KB），
 *     NimBLE 主机任务只有 4 KB，都不能在这些栈上编码；
 *   - save_scheduler 只存指针、不拷贝，所以缓冲必须在写入完成前一直有效。
 *
 * 三个场景各一块：连续编辑 scene0 与 scene1 时不会互相覆盖。
 */
static uint8_t s_layout_blob[LUMEN_LAYOUT_BLOB_MAX];
static uint8_t s_scene_blob[LUMEN_MAX_SCENES][LUMEN_SCENE_BLOB_MAX];

/*
 * 上电恢复用的两块工作区。**必须静态**：`lumen_led_engine_init` 由 app_main
 * 调用，那个任务的栈默认只有 3584 字节（CONFIG_ESP_MAIN_TASK_STACK_SIZE），
 * 而布局是 2696 字节、场景是 10530 字节。放进局部变量会在启动时打穿栈保护，
 * 表现为设备一上电就 panic、连蓝牙广播都起不来。
 *
 * 只在 init 里用一次，与渲染任务的工作区不重叠，所以静态区不会打架。
 */
static lumen_layout_store_t s_restore_layout;
static lumen_scene_t s_restore_scene;

/*
 * 渲染任务的工作区（**静态**，不是栈上局部变量）。
 *
 * 为什么必须静态：lumen_state_t + 布局快照（2696 B）+ 场景快照（10530 B）
 * 一旦放在 render_task 的栈上，再叠上 led_strip / RMT 驱动的调用深度，
 * 4KB 栈会被打穿——真机实测报
 * `Guru Meditation ... Stack protection fault, task "lumen_render"`。
 *
 * 渲染任务是单实例任务，且这些缓冲只被它使用，所以静态区天然安全；
 * s_state_lock 仍然只保护共享状态本身。
 */
static lumen_state_t s_render_state;
static lumen_layout_store_t s_render_layout;
static lumen_scene_t s_render_scene;
static lumen_part_clocks_t s_render_clocks;

/*
 * 上一帧的实际渲染耗时（微秒）。帧循环用它做前馈：
 * 等待量 = 目标帧周期 − 上一帧耗时，这样「配置 20fps」才会真的得到 20fps。
 * 只被渲染任务读写，静态区即可。
 */
static uint32_t s_last_frame_us;

/*
 * BLE 回调路径也要构造持久化快照；单独一份，不能与渲染任务的共用。
 */
static lumen_persist_t s_commit_persist;
/* 渲染任务用的独立一份（重建路径在渲染任务里跑，不能与 BLE 回调共用）。 */
static lumen_persist_t s_render_persist;

/*
 * 自检进度（§9.6）。与 s_state 分开保存：自检是渲染层的临时覆盖，
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
 * 多灯带 TDM 状态。s_planar 是引脚/灯珠数/降级的唯一权威，
 * s_planar_stats 是给串口看的轮询实测数据。
 *
 * 只有渲染任务读写 s_planar 的 cursor / degraded / stats（它独占灯带句柄）；
 * BLE 回调只通过 lumen_led_engine_set_led_count_for_strip 改灯珠数，那条路径
 * 持 s_state_lock 并只动 count 字段。
 */
static lumen_planar_t s_planar;
static lumen_planar_stats_t s_planar_stats;
static led_strip_handle_t s_tdm_strip;

/* 每条灯带的上一帧，用于 TDM 下逐条去重（跳过没变化的条）。 */
static bool s_tdm_rendered_valid[LUMEN_MAX_STRIPS];
static uint16_t s_tdm_rendered_count[LUMEN_MAX_STRIPS];
static uint8_t s_tdm_rendered_frame[LUMEN_MAX_STRIPS][LUMEN_MAX_LEDS * 3];

/*
 * 上一次 TDM 轮询时该条带是否真的出过光（#38）。
 *
 * 用来区分「本来就没光」与「刚被关掉」：前者直接跳过，后者必须先推一帧
 * 全黑（WS2812B 锁存最后画面，不推黑就一直停在旧颜色上）。
 */
static bool s_tdm_strip_lit[LUMEN_MAX_STRIPS];

/*
 * #20 错色实验开关：开启时跳过逐帧去重，静态画面也持续刷帧。
 * 必须用 #ifdef —— Kconfig 的 bool 关闭时**不定义宏**。
 */
#ifdef CONFIG_LUMEN_FORCE_REFRESH
#define LUMEN_SKIP_DEDUP true
#else
#define LUMEN_SKIP_DEDUP false
#endif

static uint8_t max_brightness(void)
{
    /* 0 表示不限制，按 255 处理。 */
    uint8_t configured = (uint8_t)CONFIG_LUMEN_MAX_BRIGHTNESS;
    return configured == 0 ? 255 : configured;
}

/* 与 effects / scene_compose 相同的毫秒基准（无符号，49 天回绕）。 */
static uint32_t now_ms(void)
{
    return (uint32_t)(esp_timer_get_time() / 1000);
}

/* 是否有任何链划过灯珠（布局「有效」的判据：至少一条链有部位且有段）。 */
static bool layout_any_segments_locked(void)
{
    for (uint8_t i = 0; i < LUMEN_MAX_STRIPS; ++i) {
        if (lumen_layout_store_has_segments(&s_layout, i)) {
            return true;
        }
    }
    return false;
}

/*
 * 更新 State 里由布局派生的一列（**调用者必须持锁**）。
 *
 * v5 的 State 只有「每链部位数」是布局的摘要，没有 seg_count、没有基准色、
 * 没有动画位（§7.3 明确「State 不含部位开关 / 播放位置 / 颜色摘要」）。
 */
static void refresh_layout_summary_locked(void)
{
    for (uint8_t i = 0; i < LUMEN_MAX_STRIPS; ++i) {
        s_state.part_count[i] = s_layout.part_count[i];
    }
    s_state.layout_valid = layout_any_segments_locked() ? 1u : 0u;
}

/* 填一份 State 持久化快照（**写指针，不返回大结构**，见 v4 的栈说明）。 */
static void persist_state_locked(lumen_persist_t *out)
{
    out->state = s_state;
}

/*
 * 把当前布局编码进静态 blob 并排队落盘（**调用者必须持锁**）。
 *
 * 布局的 debounce 是 0（§10.5：LayoutCommit 后立即落盘），所以这里写完就会
 * 被存储任务取走。编码失败（超 4096）回 false，调用方回 StorageFailed。
 */
static bool persist_layout_locked(uint8_t command)
{
    uint16_t counts[LUMEN_MAX_STRIPS];
    for (uint8_t i = 0; i < LUMEN_MAX_STRIPS; ++i) {
        counts[i] = s_state.led_count[i];
    }
    size_t len = lumen_layout_blob_encode(&s_layout, s_state.strip_count, counts, s_layout_blob,
                                          sizeof(s_layout_blob));
    if (len == 0) {
        ESP_LOGW(TAG, "布局编码失败（超 %u 字节）", (unsigned)sizeof(s_layout_blob));
        return false;
    }
    return lumen_state_store_request_layout_save(s_layout_blob, len, command);
}

/* 把某个场景编码进静态 blob 并排队落盘（**调用者必须持锁**）。 */
static bool persist_scene_locked(uint8_t scene_id, uint8_t command)
{
    if (scene_id >= LUMEN_MAX_SCENES) {
        return false;
    }
    size_t len = lumen_scene_blob_encode(&s_scenes.scene[scene_id], s_scene_blob[scene_id],
                                         sizeof(s_scene_blob[scene_id]));
    if (len == 0) {
        /* 超过 12288 → StorageFailed，RAM 保留（§10.4 末段）。 */
        ESP_LOGW(TAG, "场景 %u 编码失败（超 %u 字节）", scene_id,
                 (unsigned)sizeof(s_scene_blob[scene_id]));
        return false;
    }
    bool queued =
        lumen_state_store_request_scene_save(scene_id, s_scene_blob[scene_id], len, command);
    if (!queued) {
        /* 入队失败只可能是参数非法或调度器拒收——是异常，值得一条日志。 */
        ESP_LOGW(TAG, "场景 %u 落盘入队失败：%u 字节", scene_id, (unsigned)len);
    }
    return queued;
}

/* 每条灯带自己的灯珠数（**调用者必须持锁**）。 */
static void strip_counts_locked(uint16_t out[LUMEN_MAX_STRIPS])
{
    for (uint8_t i = 0; i < LUMEN_MAX_STRIPS; ++i) {
        out[i] = s_state.led_count[i];
    }
}

/*
 * 灯珠数变化后的统一裁剪（**调用者必须持锁**）。
 *
 * 布局里的段一旦 end >= new_count 就整段失效（**不自动缩短**——自动改用户
 * 边界比丢弃更意外）。场景不受影响：它不含几何（§6.2 两张表）。
 *
 * 返回失效的段数。有任何改动时把布局重新编码排队落盘，否则下次上电
 * `lumen_layout_blob_decode` 会因为「段越界」整份拒收，布局静默丢失。
 */
static uint16_t prune_layout_locked(uint8_t strip_id, uint16_t new_count)
{
    if (strip_id >= LUMEN_MAX_STRIPS) {
        return 0;
    }
    uint16_t pruned = 0;
    uint8_t parts = s_layout.part_count[strip_id];
    for (uint8_t p = 0; p < parts && p < LUMEN_MAX_PARTS; ++p) {
        lumen_part_segs_t *segs = &s_layout.part[strip_id][p].segs;
        for (uint8_t s = 0; s < segs->seg_count && s < LUMEN_MAX_PART_SEGS; ++s) {
            uint8_t start = segs->seg[s][0];
            uint8_t end = segs->seg[s][1];
            if (start == LUMEN_SEG_UNWRITTEN || end == LUMEN_SEG_UNWRITTEN) {
                continue;
            }
            if (end >= new_count) {
                /* 失效：打回「未写」标记，该槽位不再占用灯珠。 */
                segs->seg[s][0] = LUMEN_SEG_UNWRITTEN;
                segs->seg[s][1] = LUMEN_SEG_UNWRITTEN;
                ++pruned;
            }
        }
    }
    if (pruned > 0) {
        ESP_LOGW(TAG, "led count -> strip %u = %u：%u 个越界段失效", strip_id, new_count, pruned);
        (void)persist_layout_locked(LUMEN_CMD_SET_LED_COUNT);
    }
    return pruned;
}

/*
 * 这一帧是否有任何链需要持续出帧（**调用者必须持锁**）。
 *
 * 判据只在 scene_compose 一处（lumen_scene_strip_needs_frames）：只有真的要
 * 出光的部位参与——0 步、部位开关关掉、未覆盖段都不该让渲染任务一直转。
 */
static bool scene_needs_frames_locked(void)
{
    const lumen_scene_t *scene = &s_scenes.scene[s_state.active_scene];
    for (uint8_t i = 0; i < s_state.strip_count; ++i) {
        if (lumen_scene_strip_needs_frames(&s_layout, scene, i)) {
            return true;
        }
    }
    return false;
}

/*
 * 启动还没有播放头的部位（**调用者必须持锁**）。
 *
 * 新加的部位从自己的第 1 步起跳（T7）。已经启动过的部位不会被重置——
 * 「编辑不打断时钟」（E2）：改颜色 / 改时长 / 改层都不该让正在播的画面
 * 跳回第 1 步。
 */
static void start_pending_clocks_locked(uint32_t now)
{
    for (uint8_t i = 0; i < s_state.strip_count && i < LUMEN_MAX_STRIPS; ++i) {
        uint8_t parts = s_layout.part_count[i];
        for (uint8_t p = 0; p < parts && p < LUMEN_MAX_PARTS; ++p) {
            lumen_part_clock_start(&s_clocks.clock[i][p], now);
        }
    }
}

/*
 * 自检期间把时钟「停住」（**调用者必须持锁**）。
 *
 * 播放头只存 origin_ms，所以「暂停」就是把 origin 往后推同样长的时间。
 * 只对已经启动过的部位生效，且只在自检真的推进时调用（见调用点）。
 */
static void hold_clocks_locked(uint32_t now)
{
    /* 上一次记录的挂起时刻；0 = 没有在挂起。 */
    static uint32_t s_hold_since;
    if (s_hold_since == 0) {
        s_hold_since = now;
        return;
    }
    uint32_t delta = now - s_hold_since;
    if (delta == 0) {
        return;
    }
    for (uint8_t i = 0; i < LUMEN_MAX_STRIPS; ++i) {
        for (uint8_t p = 0; p < LUMEN_MAX_PARTS; ++p) {
            if (s_clocks.clock[i][p].started) {
                s_clocks.clock[i][p].origin_ms += delta;
            }
        }
    }
    s_hold_since = now;
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
 * SetLedCount 的句柄重建（§11.3）。只在渲染任务里执行。
 *
 * 并发模型：
 *  - BLE 回调里的 lumen_led_engine_set_led_count_for_strip() 只做三件事：
 *    判忙、登记 pending、给渲染信号量。它绝不调 led_strip_*。
 *  - 渲染任务在每次醒来时调用本函数：取走 pending → create_strip 新句柄 →
 *    成功才在锁内替换句柄并写 s_state.led_count[strip]、裁剪越界段，
 *    然后 del 旧句柄、强制重绘、debounce 持久化、回 ACK 0x00；
 *    失败则什么都不替换（旧句柄、旧数量原样保留），回 ACK 0x09。
 */
static void rebuild_led_count_if_pending(void)
{
    uint16_t target = 0;
    uint8_t seq = 0;

    xSemaphoreTake(s_state_lock, portMAX_DELAY);
    bool have_job = lumen_led_count_job_begin(&s_led_count_job, &target, &seq);
    uint8_t strip_id = lumen_led_count_job_strip(&s_led_count_job);
    xSemaphoreGive(s_state_lock);
    if (!have_job) {
        return;
    }

    ESP_LOGI(TAG, "led count rebuild begin: strip %u -> %u leds (seq=0x%02X)", strip_id, target,
             seq);

    /*
     * 多灯带 TDM 模式下所有条共用一个按 max_count 建的句柄，绝不能在改
     * strip 0 的数量时把它删掉重建——那会连带中断其余条的输出，而且
     * s_tdm_strip 会变成悬空指针。
     *
     * 所以 TDM 下这里只更新数量与配置：只要新数量不超过句柄的 max_leds 就
     * 无需重建；超出时按新 max_count 重建一次同一个句柄。
     */
    bool tdm_mode = s_planar.strip_count > 1;

    if (tdm_mode) {
        uint16_t prev_max = s_planar.max_count;
        xSemaphoreTake(s_state_lock, portMAX_DELAY);
        bool committed = lumen_led_count_job_complete(&s_led_count_job, true, &s_state);
        (void)lumen_planar_set_count(&s_planar, strip_id, target);
        /*
         * 越界段必须一起裁掉并重新落盘，否则一份带尾巴段的布局会让下次上电
         * 的 blob 解码整份失败（见 prune_layout_locked 的说明）。
         */
        if (committed) {
            prune_layout_locked(strip_id, target);
            refresh_layout_summary_locked();
        }
        persist_state_locked(&s_render_persist);
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
        lumen_state_store_request_save(&s_render_persist, LUMEN_CMD_SET_LED_COUNT);
        ESP_LOGI(TAG, "led count strip %u -> %u（TDM 模式）", strip_id, target);
        if (s_response_cb != NULL) {
            s_response_cb(seq, LUMEN_CMD_SET_LED_COUNT, LUMEN_RESULT_OK);
        }
        return;
    }

    /*
     * 顺序很关键：先清黑旧灯带 → 删旧句柄 → 再建新句柄。
     *
     * 不能先建后删：RMT TX 在创建时用 esp_gpio_reserve() 占住 GPIO，若旧句柄
     * 还活着，新句柄会拿到 "GPIO 3 is not usable" 的警告，输出路径仍指向旧通道
     * ——表现为「改完数量后整条灯带不再响应任何操作」。
     *
     * 另外 WS2812B 会把最后一帧像素锁存住，删之前必须按旧数量整条清黑。
     */
    led_strip_handle_t old;
    uint16_t old_count;
    xSemaphoreTake(s_state_lock, portMAX_DELAY);
    old = lumen_led_strip_owner_get();
    /* 旧数量要在 complete() 覆盖之前取出来。 */
    old_count = s_state.led_count[0];
    xSemaphoreGive(s_state_lock);

    if (old != NULL) {
        esp_err_t clear_err = lumen_led_strip_owner_clear(old);
        if (clear_err != ESP_OK) {
            ESP_LOGW(TAG, "led count rebuild: 清黑旧灯带失败 %s（多余灯珠可能保持旧色）",
                     esp_err_to_name(clear_err));
        }
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

    bool committed = false;
    xSemaphoreTake(s_state_lock, portMAX_DELAY);
    lumen_led_strip_owner_set(fresh);
    /* 只改该条的数量：重建期间其它命令可能已改过开关/亮度/场景，原样保留。 */
    committed = lumen_led_count_job_complete(&s_led_count_job, true, &s_state);
    if (committed) {
        prune_layout_locked(strip_id, s_state.led_count[strip_id]);
        refresh_layout_summary_locked();
        /* 重建期间 commit 过的快照已经被这一帧覆盖，邮箱不再需要。 */
        s_mailbox_dirty = false;
    }
    persist_state_locked(&s_render_persist);
    xSemaphoreGive(s_state_lock);

    /* 新句柄的像素缓冲是空的：强制按最新状态重绘。 */
    lumen_led_render_invalidate();

    if (!committed) {
        ESP_LOGE(TAG, "led count job complete rejected after swap");
        if (s_response_cb != NULL) {
            s_response_cb(seq, LUMEN_CMD_SET_LED_COUNT, LUMEN_RESULT_INTERNAL_ERROR);
        }
        return;
    }

    /* 成功后才持久化（§11.3 第 2 条）；触发命令是 SetLedCount。 */
    lumen_state_store_request_save(&s_render_persist, LUMEN_CMD_SET_LED_COUNT);

    ESP_LOGI(TAG, "led count strip %u -> %u (seq=0x%02X)", strip_id, s_state.led_count[strip_id],
             seq);
    if (s_response_cb != NULL) {
        s_response_cb(seq, LUMEN_CMD_SET_LED_COUNT, LUMEN_RESULT_OK);
    }
}

/*
 * TDM 轮询一条灯带。只有渲染任务调用。
 *
 * 一次调用 = 切 GPIO → 合成该条像素 → 推一帧。返回 true 表示真的推了帧。
 *
 * WS2812B 锁存住自己最后收到的画面，所以切走之后那条灯带保持不动——
 * 这是 TDM 可行的物理前提。去重按条独立：一个部位在动画只让那一条每帧都刷。
 */
static bool tdm_push_strip(uint8_t strip_id, const lumen_state_t *snapshot,
                           const lumen_layout_store_t *layout, const lumen_scene_t *scene,
                           const lumen_part_clocks_t *clocks, const lumen_selftest_t *selftest,
                           bool force, uint32_t now_ms_value)
{
    const lumen_planar_strip_t *cfg = lumen_planar_get(&s_planar, strip_id);
    if (cfg == NULL || !cfg->enabled || cfg->degraded) {
        return false;
    }
    if (s_tdm_strip == NULL) {
        return false;
    }

    /*
     * 出光门控：全局 power && 该带掩码位；自检期间忽略每带开关（§9.6）。
     * 决策本身是纯函数（strip_power.c），这里只按结果执行。
     */
    bool selftest_on = lumen_selftest_active(selftest);
    bool want_on = lumen_strip_mask_allows(snapshot, strip_id, selftest_on);
    lumen_strip_tdm_action_t action = lumen_strip_tdm_plan(want_on, s_tdm_strip_lit[strip_id]);

    if (action == LUMEN_STRIP_TDM_SKIP) {
        /* 本来就不出光：本轮不占 RMT（这就是「关 N 条缩短轮周期」的来源）。 */
        s_tdm_rendered_valid[strip_id] = false;
        return false;
    }

    uint8_t frame[LUMEN_MAX_LEDS * 3];
    uint16_t n = lumen_led_render_compose_strip(snapshot, layout, scene, clocks, selftest,
                                                max_brightness(), now_ms_value, strip_id,
                                                cfg->count, frame, sizeof(frame));
    if (n == 0) {
        return false;
    }

    /*
     * 逐条去重：画面没变就不刷，省一整帧 RMT。
     * CONFIG_LUMEN_FORCE_REFRESH 下跳过（#20 的错色实验要求持续刷帧）。
     * REENABLE（刚从关到开）也强制推送：上一帧是黑帧，去重会把真实画面吞掉。
     */
    bool must_push = force || action != LUMEN_STRIP_TDM_PUSH;
    if (!LUMEN_SKIP_DEDUP && !must_push && s_tdm_rendered_valid[strip_id] &&
        s_tdm_rendered_count[strip_id] == n &&
        memcmp(frame, s_tdm_rendered_frame[strip_id], (size_t)n * 3u) == 0) {
        lumen_led_render_note_skipped();
        return false;
    }

    esp_err_t err = lumen_led_strip_owner_switch_gpio(s_tdm_strip, cfg->gpio);
    if (err != ESP_OK) {
        /* 切引脚失败：该条判降级，其余条继续。 */
        if (lumen_planar_mark_degraded(&s_planar, strip_id)) {
            ESP_LOGW(TAG, "strip %u (GPIO%u) 切换引脚失败 %s，已降级；其余灯带继续", strip_id,
                     cfg->gpio, esp_err_to_name(err));
        }
        return false;
    }

    err = lumen_led_strip_owner_push_pixels_n(s_tdm_strip, frame, s_planar.max_count, n);
    if (err != ESP_OK) {
        if (lumen_planar_mark_degraded(&s_planar, strip_id)) {
            ESP_LOGW(TAG, "strip %u (GPIO%u) 刷新失败 %s，已降级；其余灯带继续", strip_id,
                     cfg->gpio, esp_err_to_name(err));
        }
        return false;
    }

    if (action == LUMEN_STRIP_TDM_BLACK_THEN_SKIP) {
        /* 黑帧推完了：这一带从下一轮起真正跳过。 */
        s_tdm_rendered_valid[strip_id] = false;
        s_tdm_rendered_count[strip_id] = 0;
        s_tdm_strip_lit[strip_id] = false;
        lumen_led_render_note_drawn();
        ESP_LOGI(TAG, "strip %u 关闭：已推黑帧，后续 TDM 轮询跳过", strip_id);
        return true;
    }

    memcpy(s_tdm_rendered_frame[strip_id], frame, (size_t)n * 3u);
    s_tdm_rendered_count[strip_id] = n;
    s_tdm_rendered_valid[strip_id] = true;
    s_tdm_strip_lit[strip_id] = true;
    lumen_led_render_note_drawn();
    return true;
}

/* 跑一轮 TDM，并记录本轮耗时（串口实测证据）。 */
static void tdm_run_round(const lumen_state_t *snapshot, const lumen_layout_store_t *layout,
                          const lumen_scene_t *scene, const lumen_part_clocks_t *clocks,
                          const lumen_selftest_t *selftest, bool force, uint32_t now_ms_value)
{
    int64_t t0 = esp_timer_get_time();
    uint8_t pushed = 0;
    for (uint8_t i = 0; i < s_planar.strip_count; ++i) {
        if (tdm_push_strip(i, snapshot, layout, scene, clocks, selftest, force, now_ms_value)) {
            ++pushed;
        }
    }
    uint32_t round_us = (uint32_t)(esp_timer_get_time() - t0);
    lumen_planar_note_round(&s_planar_stats, round_us, pushed);

    if (s_planar_stats.rounds % 60u == 0u) {
        uint8_t lit = 0;
        for (uint8_t i = 0; i < s_planar.strip_count; ++i) {
            if (s_tdm_strip_lit[i]) {
                ++lit;
            }
        }
        uint32_t avg = lumen_planar_stats_avg_us(&s_planar_stats);
        ESP_LOGI(TAG,
                 "tdm: strips=%u active=%u lit=%u round=%uus avg=%uus max=%uus pushed=%lu "
                 "(每条间隔≈%uus)",
                 s_planar.strip_count, lumen_planar_active_count(&s_planar), lit, round_us, avg,
                 s_planar_stats.round_us_max, (unsigned long)s_planar_stats.strips_pushed,
                 (unsigned)avg);
    }
}

/*
 * 上电后补发帧的次数与间隔。
 *
 * 灯带用独立 5V 供电，它的电源建立可能晚于 MCU 启动——启动日志里第一次
 * render 出现在 325ms，此时灯带那路可能还没上电，整帧被 WS2812B 丢掉。
 * 而 s_rendered_valid 已经置位，只要状态不变就不会再发，用户看到的是
 * 「断电重启后灯是灭的，开关一次才亮」。所以启动后额外强制重绘几次。
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
     * 两种模式：
     *  - **静态**（need_frames == false）：阻塞在信号量上，只有 commit /
     *    布局场景变更唤醒。零额外 CPU、零额外 RMT。
     *  - **动画**（need_frames == true）：带 1000/CONFIG_LUMEN_ANIM_FPS 超时
     *    等待，超时即渲染下一帧。
     */
    uint8_t logged_step = 0xFF;
    uint8_t boot_reassert_left = LUMEN_BOOT_REASSERT_COUNT;
    bool logged_anim_mode = false;

    for (;;) {
        TickType_t wait = portMAX_DELAY;
        bool anim_mode = false;
        xSemaphoreTake(s_state_lock, portMAX_DELAY);
        if (boot_reassert_left > 0) {
            wait = pdMS_TO_TICKS(LUMEN_BOOT_REASSERT_INTERVAL_MS);
        }
        if (lumen_selftest_active(&s_selftest)) {
            int64_t remaining_us =
                lumen_selftest_next_step_in_us(&s_selftest, esp_timer_get_time());
            TickType_t ticks =
                remaining_us > 0
                    ? pdMS_TO_TICKS((uint32_t)((remaining_us + 999) / 1000))
                    : 1;
            wait = ticks > 0 ? ticks : 1;
        } else if (LUMEN_SKIP_DEDUP || scene_needs_frames_locked()) {
            /*
             * 等待量 = 帧周期 − 上一帧耗时（前馈），不是直接等一个完整周期：
             * 早先写成「等 1000/fps」是错的，实际周期还要加上渲染本身。
             * 至少 1 tick：0 表示不等待，会变成忙循环。
             */
            uint32_t target_us = 1000000u / (uint32_t)CONFIG_LUMEN_ANIM_FPS;
            uint32_t spent_us = s_last_frame_us;
            uint32_t wait_us = target_us > spent_us ? target_us - spent_us : 0;
            TickType_t anim_ticks = pdMS_TO_TICKS((wait_us + 999u) / 1000u);
            wait = anim_ticks > 0 ? anim_ticks : 1;
            anim_mode = true;
        }
        xSemaphoreGive(s_state_lock);

        if (anim_mode != logged_anim_mode) {
            uint32_t drawn = 0;
            uint32_t skipped = 0;
            lumen_led_render_counters(&drawn, &skipped);
            logged_anim_mode = anim_mode;
            ESP_LOGI(TAG, "帧循环模式 -> %s（fps=%d）已绘制=%u 跳过=%u",
                     anim_mode ? "动画" : "静态（阻塞等待，不空转）", CONFIG_LUMEN_ANIM_FPS,
                     (unsigned)drawn, (unsigned)skipped);
        }

        /* 超时（自检换色 / 启动补发）与状态信号都会走到这里；统一重渲染。 */
        (void)xSemaphoreTake(s_render_signal, wait);

        bool force_round = false;
        if (boot_reassert_left > 0) {
            lumen_led_render_invalidate();
            for (uint8_t i = 0; i < LUMEN_MAX_STRIPS; ++i) {
                s_tdm_rendered_valid[i] = false;
            }
            force_round = true;
            --boot_reassert_left;
        }

        /* 先处理 SetLedCount 的重建：它会重建句柄、强制重绘并回延迟 ACK。 */
        rebuild_led_count_if_pending();

        bool dirty;
        bool selftest_active;
        uint8_t selftest_rgb[3] = {0, 0, 0};

        uint32_t frame_now = now_ms();

        /*
         * 在本帧开头**推进播放头**。v5 的播放头不存相位变量——只存 origin_ms，
         * 步号与步内时间都由 lumen_part_clock_advance 从 (now - origin) 一次性
         * 算出，不做累加（§9.4：累加会长时间运行后越走越偏）。
         *
         * 自检是渲染层的最高优先级覆盖：自检期间不推进播放头，结束后从原处
         * 继续——实现方式是自检结束时把各部位的 origin 整体后移。
         */
        xSemaphoreTake(s_state_lock, portMAX_DELAY);
        if (!lumen_selftest_active(&s_selftest)) {
            /* 新部位（刚建的）从自己的第 1 步起跳（T7）。 */
            start_pending_clocks_locked(frame_now);
        } else {
            /* 自检覆盖期间把这段时间记为「不算时间」，时钟整体后移。 */
            hold_clocks_locked(frame_now);
        }

        dirty = s_mailbox_dirty;
        if (dirty) {
            s_render_state = s_mailbox;
            s_mailbox_dirty = false;
        } else {
            s_render_state = s_state;
        }
        /* 布局 / 场景 / 播放头与状态来自同一临界区，避免撕裂帧。 */
        s_render_layout = s_layout;
        s_render_scene = s_scenes.scene[s_state.active_scene];
        s_render_clocks = s_clocks;

        /*
         * 推进自检步骤（持锁：与取消/重启自检的命令互斥），并把整份自检状态
         * 拷出来给渲染用。
         */
        lumen_selftest_advance(&s_selftest, esp_timer_get_time());
        lumen_selftest_t selftest = s_selftest;
        selftest_active = lumen_selftest_color(&selftest, selftest_rgb);
        uint8_t step = lumen_selftest_step(&selftest);
        xSemaphoreGive(s_state_lock);

        if (!selftest_active) {
            if (logged_step != 0xFF) {
                ESP_LOGI(TAG, "自检结束，恢复存储状态 power=%u brightness=%u",
                         s_render_state.power, s_render_state.brightness);
            }
            logged_step = 0xFF;
        } else if (step != logged_step) {
            logged_step = step;
            ESP_LOGI(TAG, "自检 %u/%d %s rgb=%u,%u,%u", (unsigned)step + 1,
                     LUMEN_SELFTEST_STEPS, lumen_selftest_step_name(step), selftest_rgb[0],
                     selftest_rgb[1], selftest_rgb[2]);
        }

        /* 渲染耗时（set_pixel + 阻塞 refresh）不持锁，State read 不会被拖住。 */
        int64_t frame_t0 = esp_timer_get_time();
        if (s_planar.strip_count > 1) {
            tdm_run_round(&s_render_state, &s_render_layout, &s_render_scene, &s_render_clocks,
                          &selftest, force_round, frame_now);
        } else {
            lumen_led_render_snapshot(lumen_led_strip_owner_get(), &s_render_state,
                                      &s_render_layout, &s_render_scene, &s_render_clocks,
                                      &selftest, max_brightness(), frame_now);
        }
        s_last_frame_us = (uint32_t)(esp_timer_get_time() - frame_t0);
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
    /* 正弦包络查表在这里建好（用 math.h，只在初始化时），渲染路径零浮点。 */
    lumen_effects_init();
    lumen_selftest_reset(&s_selftest);
    lumen_led_count_job_init(&s_led_count_job);
    lumen_layout_store_init(&s_layout);
    lumen_scene_set_init(&s_scenes);
    lumen_part_clocks_init(&s_clocks);
    s_mailbox_dirty = false;
    s_response_cb = NULL;

    lumen_state_defaults(&s_state, CONFIG_LUMEN_LED_COUNT);

    /*
     * 恢复持久化配置（State → 布局 → 三个场景）。任一步失败都保留默认值
     * ——沿用 v1 的 corrupt → defaults，绝不半套加载。
     */
    static lumen_persist_t restored;
    bool have_saved = lumen_state_store_load(&restored);
    if (have_saved) {
        s_state = restored.state;
    }
    s_state.brightness = lumen_state_clamp_brightness(s_state.brightness, max_brightness());

    /*
     * 恢复布局。它必须按**当前**灯珠数整份校验：数量被改小之后旧布局里越界的
     * 段应当整份拒绝，而不是让半套越界配置进入 RAM（与 v4 的剧本同一取舍）。
     *
     * 用 s_restore_layout 而不是局部变量：lumen_layout_store_t 是 2696 字节，
     * 而 lumen_led_engine_init 跑在 app_main 任务的 3584 字节栈上——放局部变量
     * 直接打穿栈保护（真机实测 `Stack protection fault, task "main"`）。
     */
    lumen_layout_store_init(&s_restore_layout);
    if (lumen_state_store_load_layout(&s_restore_layout, s_state.led_count)) {
        s_layout = s_restore_layout;
        ESP_LOGI(TAG, "布局已恢复：strip0 parts=%u", s_layout.part_count[0]);
    }

    /*
     * 恢复三个场景。播放头**不持久化**（§9.4：上电从每个部位的第 1 步起跳），
     * 所以这里只恢复内容，播放头保持「未启动」。
     *
     * 同样必须静态：lumen_scene_t 是 10530 字节，一轮循环就把 app_main 的栈
     * 彻底压穿。循环复用同一块工作区，逐个场景载入后立刻拷进 s_scenes。
     */
    for (uint8_t i = 0; i < LUMEN_MAX_SCENES; ++i) {
        lumen_scene_init(&s_restore_scene);
        bool loaded = lumen_state_store_load_scene(i, &s_restore_scene);
        if (loaded) {
            s_scenes.scene[i] = s_restore_scene;
        }
        /*
         * 每个场景都记一行：只记成功的话，「一个都没恢复」和「根本没读」在
         * 日志里长得一样（#162 就是靠这一行才看出三个场景全没恢复）。
         */
        ESP_LOGI(TAG, "场景 %u %s：name_len=%u strip0 steps=%u/%u", i,
                 loaded ? "已恢复" : "未恢复（无 key 或 blob 被拒）", s_restore_scene.name_len,
                 s_restore_scene.part[0][0].step_count, s_restore_scene.part[0][1].step_count);
    }
    refresh_layout_summary_locked();

    ESP_LOGI(TAG, "state %s: power=%u brightness=%u leds=%u max=%u parts=%u scene=%u layout=%u",
             have_saved ? "restored" : "default", s_state.power, s_state.brightness,
             s_state.led_count[0], max_brightness(), s_state.part_count[0],
             s_state.active_scene, s_state.layout_valid);

    /*
     * 多灯带初始化。引脚来自 Kconfig 的逗号分隔列表；少于 2 条时直接走
     * 单灯带路径（单灯带行为逐字节不变）。
     *
     * TDM 只占 1 个 RMT 通道，所以句柄按「所有条里最大的灯珠数」建一次，
     * 运行时用 led_strip_switch_gpio 切引脚复用（C3 只有 2 个 TX 通道）。
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
            uint16_t restored_count = have_saved ? s_state.led_count[i] : 0;
            counts[i] = (restored_count >= 1 && restored_count <= LUMEN_MAX_LEDS)
                            ? restored_count
                            : s_state.led_count[0];
        }
        if (strip_n > 1 && !lumen_planar_init(&s_planar, pins8, counts, strip_n)) {
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
        ESP_LOGI(TAG, "TDM: %u 条灯带, pins=%s, max_leds=%u, mem_block_symbols=%d", strip_n,
                 CONFIG_LUMEN_STRIP_PINS, s_planar.max_count, CONFIG_LUMEN_RMT_MEM_BLOCK_SYMBOLS);
    } else {
        lumen_planar_stats_reset(&s_planar_stats);
        err = lumen_led_strip_owner_init(s_state.led_count[0]);
    }
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "strip init failed: %s (mem_block_symbols=%d, leds=%u)",
                 esp_err_to_name(err), CONFIG_LUMEN_RMT_MEM_BLOCK_SYMBOLS, s_state.led_count[0]);
#if CONFIG_LUMEN_RMT_STRESS_MODE
        if (CONFIG_LUMEN_RMT_MEM_BLOCK_SYMBOLS > 192) {
            ESP_LOGE(TAG, "C3 每个 RMT group 只有 4x48=192 word，mem_block_symbols>192 "
                          "无法分配；这是组 4（384）的预期失败，记录后换回 48/96/192");
        }
#endif
        return err;
    }

    /* State 报实际配置的灯带数（小程序据此知道要查几条）。 */
    s_state.strip_count = strip_n > 1 ? strip_n : 1;

    /*
     * 把每条链的灯珠数写回 State。
     *
     * 上面那份 counts[] 只喂给了 lumen_planar_init（渲染要按它建句柄），而
     * State 的 led_count[] 一直是默认值：首条有数、其余 0。后果不是「显示不
     * 对」——lumen_layout_store_validate 拿 strip_counts 校验每条已配置的链
     * 都不得为 0，于是**每一句 LayoutCommit 都被 InvalidParam 拒掉**，布局永远
     * 落不了盘，部位划分改了也不生效（真机实测 55/58，三条失败全是它）。
     *
     * 多条链时以 counts[] 为准（它已经合成了「恢复值 / 默认值」）；单条链时
     * led_count[0] 就是唯一那条，保持原样即可。
     */
    if (strip_n > 1) {
        for (uint8_t i = 0; i < strip_n; ++i) {
            s_state.led_count[i] = counts[i];
        }
        for (uint8_t i = strip_n; i < LUMEN_MAX_STRIPS; ++i) {
            s_state.led_count[i] = 0;
        }
    }
    refresh_layout_summary_locked();

    BaseType_t created =
        xTaskCreate(render_task, "lumen_render", CONFIG_LUMEN_RENDER_TASK_STACK_SIZE, NULL,
                    CONFIG_LUMEN_RENDER_TASK_PRIORITY, NULL);
    if (created != pdPASS) {
        return ESP_ERR_NO_MEM;
    }

    /* 初始化后按当前（默认或恢复的）状态渲染一次，之后只等状态变化。 */
    xSemaphoreGive(s_render_signal);

#if CONFIG_LUMEN_RMT_STRESS_MODE
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
    /* 逐条灯珠数与部位数与状态快照来自同一临界区，避免「部位数更新了但灯珠数
     * 还是旧的」。 */
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
    /*
     * 布局派生的字段（part_count / layout_valid）永远由布局表决定，
     * 不信任调用方传进来的值。
     */
    refresh_layout_summary_locked();
    s_mailbox = s_state;
    s_mailbox_dirty = true;
    persist_state_locked(&s_commit_persist);
    xSemaphoreGive(s_state_lock);

    /* 二值信号量天然只保留一个 pending 唤醒，旧快照会被 s_mailbox 覆盖。 */
    xSemaphoreGive(s_render_signal);

    /* 写失败在 ACK 之后由 Event 0x81 异步上报（§10.5）；command 是 detail。 */
    lumen_state_store_request_save(&s_commit_persist, command);
}

/* ---------------- 布局族 ---------------- */

uint8_t lumen_led_engine_layout_write(uint8_t strip_id, uint8_t part_count)
{
    uint8_t result;
    xSemaphoreTake(s_state_lock, portMAX_DELAY);
    result = lumen_layout_store_write(&s_layout, strip_id, part_count, s_state.strip_count);
    if (result == LUMEN_RESULT_OK) {
        refresh_layout_summary_locked();
        s_mailbox = s_state;
        s_mailbox_dirty = true;
    }
    xSemaphoreGive(s_state_lock);
    if (result != LUMEN_RESULT_OK) {
        ESP_LOGW(TAG, "LayoutWrite 被拒 strip=%u parts=%u", strip_id, part_count);
        return result;
    }
    xSemaphoreGive(s_render_signal);
    ESP_LOGI(TAG, "LayoutWrite strip=%u parts=%u（该链部位已清空）", strip_id, part_count);
    return LUMEN_RESULT_OK;
}

uint8_t lumen_led_engine_layout_part(uint8_t strip_id, uint8_t part_id, uint8_t name_len,
                                     const uint8_t *name, uint8_t seg_count, uint8_t phase)
{
    uint8_t result;
    xSemaphoreTake(s_state_lock, portMAX_DELAY);
    result = lumen_layout_store_set_part(&s_layout, strip_id, part_id, name_len, name, seg_count,
                                         phase, s_state.strip_count);
    xSemaphoreGive(s_state_lock);
    if (result != LUMEN_RESULT_OK) {
        ESP_LOGW(TAG, "LayoutPart 被拒 strip=%u part=%u name_len=%u segs=%u phase=%u", strip_id,
                 part_id, name_len, seg_count, phase);
        return result;
    }
    ESP_LOGI(TAG, "LayoutPart strip=%u part=%u name_len=%u segs=%u phase=%u", strip_id, part_id,
             name_len, seg_count, phase);
    return LUMEN_RESULT_OK;
}

uint8_t lumen_led_engine_layout_seg(uint8_t strip_id, uint8_t part_id, uint8_t seg_id,
                                    uint8_t start, uint8_t end)
{
    uint8_t result;
    uint16_t led_count = 0;
    xSemaphoreTake(s_state_lock, portMAX_DELAY);
    led_count = lumen_command_strip_count(&s_state, strip_id);
    result = lumen_layout_store_set_seg(&s_layout, strip_id, part_id, seg_id, start, end,
                                        led_count, s_state.strip_count);
    xSemaphoreGive(s_state_lock);
    if (result != LUMEN_RESULT_OK) {
        /* 最常见原因：压到了别的部位（S3），旧布局保持不变（S4）。 */
        ESP_LOGW(TAG, "LayoutSeg 被拒 strip=%u part=%u seg=%u [%u-%u] led_count=%u", strip_id,
                 part_id, seg_id, start, end, led_count);
        return result;
    }
    ESP_LOGI(TAG, "LayoutSeg strip=%u part=%u seg=%u [%u-%u]", strip_id, part_id, seg_id, start,
             end);
    return LUMEN_RESULT_OK;
}

uint8_t lumen_led_engine_layout_commit(uint8_t command)
{
    uint16_t counts[LUMEN_MAX_STRIPS];
    uint8_t result;

    xSemaphoreTake(s_state_lock, portMAX_DELAY);
    strip_counts_locked(counts);
    /* 整份校验：每链部位数 / 每部位段数 / 段已写齐 / 段互斥 / 段在灯珠数内。 */
    result = lumen_layout_store_validate(&s_layout, s_state.strip_count, counts);
    if (result != LUMEN_RESULT_OK) {
        xSemaphoreGive(s_state_lock);
        ESP_LOGW(TAG, "LayoutCommit 校验失败：整份布局非法，RAM 与 NVS 都不动");
        return result;
    }
    /*
     * 先确认能落盘，再改 RAM。编码失败（> 4096）时一个字节都不改，
     * 直接回 StorageFailed。
     */
    if (!persist_layout_locked(command)) {
        xSemaphoreGive(s_state_lock);
        return LUMEN_RESULT_STORAGE_FAILED;
    }
    /*
     * 布局是「结构改动」，会打断该链时钟（§6.1 末段）：把**所有**链的播放头
     * 重置到此刻——这是唯一允许打断时钟的操作。
     */
    uint32_t t = now_ms();
    for (uint8_t i = 0; i < s_state.strip_count; ++i) {
        lumen_part_clocks_reset_strip(&s_clocks, i, s_layout.part_count[i], t);
    }
    refresh_layout_summary_locked();
    s_mailbox = s_state;
    s_mailbox_dirty = true;
    persist_state_locked(&s_commit_persist);
    xSemaphoreGive(s_state_lock);

    xSemaphoreGive(s_render_signal);
    /* layout_valid 变了 → State 也要落盘（它不在 layout blob 里）。 */
    lumen_state_store_request_save(&s_commit_persist, command);
    ESP_LOGI(TAG, "LayoutCommit ok（已落盘，该链时钟已重置）");
    return LUMEN_RESULT_OK;
}

void lumen_led_engine_layout_snapshot(lumen_layout_store_t *out)
{
    if (out == NULL) {
        return;
    }
    xSemaphoreTake(s_state_lock, portMAX_DELAY);
    *out = s_layout;
    xSemaphoreGive(s_state_lock);
}

uint8_t lumen_led_engine_part_count(uint8_t strip_id)
{
    if (strip_id >= LUMEN_MAX_STRIPS) {
        return 0;
    }
    xSemaphoreTake(s_state_lock, portMAX_DELAY);
    uint8_t count = s_layout.part_count[strip_id];
    xSemaphoreGive(s_state_lock);
    return count;
}

/* ---------------- 场景族 ---------------- */

uint8_t lumen_led_engine_scene_part(uint8_t scene_id, uint8_t strip_id, uint8_t part_id,
                                    uint8_t step_count, uint8_t loop, uint8_t on,
                                    uint8_t command)
{
    if (scene_id >= LUMEN_MAX_SCENES) {
        return LUMEN_RESULT_INVALID_PARAM;
    }
    /*
     * 先确认能落盘再改 RAM：场景编码后超过 12288 字节时回 StorageFailed 且
     * RAM 原样保留（§10.4 末段）。做法是「试写一份候选」——但场景表 10KB，
     * 拷贝一份太贵，所以这里先改 RAM、编码、失败再回滚那一个部位的头。
     */
    lumen_part_scene_t backup;
    uint8_t result;

    xSemaphoreTake(s_state_lock, portMAX_DELAY);
    lumen_scene_t *scene = &s_scenes.scene[scene_id];
    backup = scene->part[strip_id][part_id];
    result = lumen_scene_set_part(scene, strip_id, part_id, step_count, loop, on,
                                  s_state.strip_count, LUMEN_MAX_PARTS);
    if (result != LUMEN_RESULT_OK) {
        xSemaphoreGive(s_state_lock);
        ESP_LOGW(TAG, "ScenePart 被拒 scene=%u strip=%u part=%u steps=%u loop=%u on=%u",
                 scene_id, strip_id, part_id, step_count, loop, on);
        return result;
    }
    if (!persist_scene_locked(scene_id, command)) {
        scene->part[strip_id][part_id] = backup; /* 回滚：不半套生效 */
        xSemaphoreGive(s_state_lock);
        return LUMEN_RESULT_STORAGE_FAILED;
    }
    /*
     * 新部位或步数变多时，让新出现的部位从自己的第 1 步起跳（T7）。
     * 已经启动过的部位不重置（编辑不打断时钟，E2）。
     */
    lumen_part_clock_start(&s_clocks.clock[strip_id][part_id], now_ms());
    xSemaphoreGive(s_state_lock);

    xSemaphoreGive(s_render_signal);
    ESP_LOGI(TAG, "ScenePart scene=%u strip=%u part=%u steps=%u loop=%u on=%u", scene_id,
             strip_id, part_id, step_count, loop, on);
    return LUMEN_RESULT_OK;
}

uint8_t lumen_led_engine_scene_step(uint8_t scene_id, uint8_t strip_id, uint8_t part_id,
                                    uint8_t step_index, uint16_t duration_ms,
                                    const uint8_t layer0[9], const uint8_t layer1[9],
                                    uint8_t command)
{
    if (scene_id >= LUMEN_MAX_SCENES || layer0 == NULL || layer1 == NULL) {
        return LUMEN_RESULT_INVALID_PARAM;
    }

    lumen_effect_layer_t l0;
    lumen_effect_layer_t l1;
    (void)lumen_layer_decode(layer0, &l0);
    (void)lumen_layer_decode(layer1, &l1);

    lumen_scene_step_t backup;
    uint8_t result;
    xSemaphoreTake(s_state_lock, portMAX_DELAY);
    lumen_scene_t *scene = &s_scenes.scene[scene_id];
    backup = scene->part[strip_id][part_id].step[step_index];
    result = lumen_scene_set_step(scene, strip_id, part_id, step_index, duration_ms, l0, l1,
                                  s_state.strip_count, LUMEN_MAX_PARTS);
    if (result != LUMEN_RESULT_OK) {
        xSemaphoreGive(s_state_lock);
        ESP_LOGW(TAG, "SceneStep 被拒 scene=%u strip=%u part=%u step=%u duration=%ums", scene_id,
                 strip_id, part_id, step_index, duration_ms);
        return result;
    }
    if (!persist_scene_locked(scene_id, command)) {
        scene->part[strip_id][part_id].step[step_index] = backup;
        xSemaphoreGive(s_state_lock);
        return LUMEN_RESULT_STORAGE_FAILED;
    }
    xSemaphoreGive(s_state_lock);

    xSemaphoreGive(s_render_signal);
    ESP_LOGI(TAG, "SceneStep scene=%u strip=%u part=%u step=%u duration=%ums l0=0x%02X l1=0x%02X",
             scene_id, strip_id, part_id, step_index, duration_ms, l0.type, l1.type);
    return LUMEN_RESULT_OK;
}

uint8_t lumen_led_engine_scene_name(uint8_t scene_id, uint8_t name_len, const uint8_t *name,
                                    uint8_t command)
{
    if (scene_id >= LUMEN_MAX_SCENES) {
        return LUMEN_RESULT_INVALID_PARAM;
    }
    uint8_t result;
    uint8_t backup_len;
    uint8_t backup_name[LUMEN_NAME_BYTES];

    xSemaphoreTake(s_state_lock, portMAX_DELAY);
    lumen_scene_t *scene = &s_scenes.scene[scene_id];
    backup_len = scene->name_len;
    memcpy(backup_name, scene->name, sizeof(backup_name));
    result = lumen_scene_set_name(scene, name_len, name);
    if (result != LUMEN_RESULT_OK) {
        xSemaphoreGive(s_state_lock);
        return result;
    }
    if (!persist_scene_locked(scene_id, command)) {
        scene->name_len = backup_len;
        memcpy(scene->name, backup_name, sizeof(scene->name));
        xSemaphoreGive(s_state_lock);
        return LUMEN_RESULT_STORAGE_FAILED;
    }
    xSemaphoreGive(s_state_lock);
    ESP_LOGI(TAG, "SceneName scene=%u name_len=%u", scene_id, name_len);
    return LUMEN_RESULT_OK;
}

uint8_t lumen_led_engine_activate_scene(uint8_t scene_id, uint8_t command)
{
    if (scene_id >= LUMEN_MAX_SCENES) {
        return LUMEN_RESULT_INVALID_PARAM;
    }
    xSemaphoreTake(s_state_lock, portMAX_DELAY);
    s_state.active_scene = scene_id;
    /*
     * 硬切 + **所有部位**的播放头重置到此刻（T3/C4）：切场景后每个部位都从
     * 自己的第 1 步重新开始，不延续上一个场景的相位。
     */
    uint32_t t = now_ms();
    for (uint8_t i = 0; i < s_state.strip_count; ++i) {
        lumen_part_clocks_reset_strip(&s_clocks, i, s_layout.part_count[i], t);
    }
    s_mailbox = s_state;
    s_mailbox_dirty = true;
    persist_state_locked(&s_commit_persist);
    xSemaphoreGive(s_state_lock);

    xSemaphoreGive(s_render_signal);
    lumen_state_store_request_save(&s_commit_persist, command);
    ESP_LOGI(TAG, "ActivateScene scene=%u（硬切，全部部位从第 1 步重跳）", scene_id);
    return LUMEN_RESULT_OK;
}

void lumen_led_engine_scene_snapshot(uint8_t scene_id, lumen_scene_t *out)
{
    if (out == NULL || scene_id >= LUMEN_MAX_SCENES) {
        return;
    }
    xSemaphoreTake(s_state_lock, portMAX_DELAY);
    *out = s_scenes.scene[scene_id];
    xSemaphoreGive(s_state_lock);
}

uint8_t lumen_led_engine_active_scene(void)
{
    xSemaphoreTake(s_state_lock, portMAX_DELAY);
    uint8_t scene = s_state.active_scene;
    xSemaphoreGive(s_state_lock);
    return scene;
}

/* ---------------- 灯珠数与自检 ---------------- */

void lumen_led_engine_set_store_event_cb(lumen_store_event_cb cb)
{
    lumen_state_store_set_event_cb(cb);
}

void lumen_led_engine_set_response_cb(lumen_led_engine_response_cb cb)
{
    /* 只在初始化阶段由 ble_link 调用一次；不做运行期切换。 */
    s_response_cb = cb;
}

uint8_t lumen_led_engine_set_led_count_for_strip(uint8_t strip_id, uint16_t count, uint8_t seq)
{
    if (count < 1 || count > LUMEN_MAX_LEDS) {
        /* 命令层已拦下；这里防御性拒绝，不改状态机。 */
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
            if (s_state.led_count[strip_id] == count) {
                xSemaphoreGive(s_state_lock);
                return LUMEN_RESULT_OK;
            }
            (void)lumen_planar_set_count(&s_planar, strip_id, count);
            s_state.led_count[strip_id] = count;
            /* 数量变了：该条上一帧的尺寸不再有效，强制重刷一次。 */
            s_tdm_rendered_valid[strip_id] = false;
            /*
             * 越界段必须一起裁掉并重新落盘：不裁剪 → 越界段仍然生效，
             * 布局 blob 还会被整份拒收；不持久化 → 重启后数量又回到旧值。
             */
            prune_layout_locked(strip_id, count);
            refresh_layout_summary_locked();
            persist_state_locked(&s_commit_persist);
        }
        xSemaphoreGive(s_state_lock);
        if (!valid) {
            return LUMEN_RESULT_INVALID_PARAM;
        }
        /* 成功才持久化（§11.3 第 2 条）：数量与裁剪后的布局一起跨断电。 */
        lumen_state_store_request_save(&s_commit_persist, LUMEN_CMD_SET_LED_COUNT);
        xSemaphoreGive(s_render_signal);
        ESP_LOGI(TAG, "SetLedCount strip %u -> %u（seq=0x%02X），无需重建句柄", strip_id, count,
                 seq);
        return LUMEN_RESULT_OK;
    }

    lumen_led_count_request_t status;
    xSemaphoreTake(s_state_lock, portMAX_DELAY);
    status = lumen_led_count_job_request(&s_led_count_job, strip_id, count,
                                         s_state.led_count[strip_id], seq);
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

void lumen_led_engine_strip_counts(uint16_t out[LUMEN_MAX_STRIPS])
{
    if (out == NULL) {
        return;
    }
    xSemaphoreTake(s_state_lock, portMAX_DELAY);
    strip_counts_locked(out);
    xSemaphoreGive(s_state_lock);
}

uint8_t lumen_led_engine_max_brightness(void)
{
    return max_brightness();
}

/*
 * 协议 §9.6 自检控制。三个函数都不碰 s_state / s_mailbox / NVS：
 * 自检只是渲染层的临时覆盖，结束后渲染任务直接回到存储状态。
 */
void lumen_led_engine_start_selftest(void)
{
    if (s_state_lock == NULL) {
        return;
    }
    xSemaphoreTake(s_state_lock, portMAX_DELAY);
    /* 重复收到 0x07 时从这里重新计时。 */
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
