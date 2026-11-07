#include "state_store.h"

#include <string.h>

#include "esp_log.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "freertos/task.h"
#include "nvs.h"
#include "sdkconfig.h"

#include "save_scheduler.h"
#include "state_blob.h"

static const char *TAG = "lumen_store";

#define LUMEN_NVS_NAMESPACE "lumen"
/* v5 的五个键（docs/protocol-v5.md §10.5）。 */
#define LUMEN_NVS_KEY_STATE "state"
#define LUMEN_NVS_KEY_LAYOUT "layout"
#define LUMEN_NVS_KEY_SCENE0 "scene0"
#define LUMEN_NVS_KEY_SCENE1 "scene1"
#define LUMEN_NVS_KEY_SCENE2 "scene2"

/* 键名表：下标与 lumen_save_key_t 一一对应。 */
static const char *const k_key_names[LUMEN_SAVE_KEY_COUNT] = {
    LUMEN_NVS_KEY_STATE, LUMEN_NVS_KEY_LAYOUT, LUMEN_NVS_KEY_SCENE0,
    LUMEN_NVS_KEY_SCENE1, LUMEN_NVS_KEY_SCENE2,
};

/* 某个键的 debounce（§10.5）。 */
static uint32_t key_debounce_ms(lumen_save_key_t key)
{
    switch (key) {
    case LUMEN_SAVE_KEY_LAYOUT:
        return 0; /* LayoutCommit 立即落盘 */
    case LUMEN_SAVE_KEY_SCENE0:
    case LUMEN_SAVE_KEY_SCENE1:
    case LUMEN_SAVE_KEY_SCENE2:
        return LUMEN_SAVE_SCENE_DEBOUNCE_MS; /* 2 s（E4） */
    case LUMEN_SAVE_KEY_STATE:
    default:
        return LUMEN_SAVE_DEBOUNCE_MS;
    }
}

static SemaphoreHandle_t s_lock;
static SemaphoreHandle_t s_wake;
static lumen_save_scheduler_t s_sched;
static lumen_store_event_cb s_event_cb;

/*
 * State blob 是 32 字节，放在这里而不是栈上只是为了与其它写路径同形；
 * 布局 / 场景的 blob 由引擎持有（12 KB 不能进 5120 字节的任务栈，§B7）。
 */
static uint8_t s_state_blob[LUMEN_STATE_BLOB_SIZE];

/*
 * 近似毫秒时钟：esp_timer 是 64 位微秒，右移 10 位 ≈ 除以 1024，即每单位
 * 0.9766ms（debounce 实际约 512ms 而非 500ms，误差 2.3%，无关紧要）。
 *
 * 32 位回绕周期是 2^32 × 1024µs ≈ 50.9 天。save_scheduler 全用有符号差值
 * 比较，回绕不会卡死（见 save_scheduler.h）。
 */
static uint32_t now_ms(void)
{
    return (uint32_t)(esp_timer_get_time() >> 10);
}

/* 把一份 blob 写进某个键。 */
static esp_err_t write_key(lumen_save_key_t key, const uint8_t *blob, size_t len)
{
    if ((unsigned)key >= LUMEN_SAVE_KEY_COUNT || blob == NULL || len == 0) {
        return ESP_ERR_INVALID_ARG;
    }
    nvs_handle_t handle;
    esp_err_t err = nvs_open(LUMEN_NVS_NAMESPACE, NVS_READWRITE, &handle);
    if (err != ESP_OK) {
        return err;
    }
    err = nvs_set_blob(handle, k_key_names[key], blob, len);
    if (err == ESP_OK) {
        err = nvs_commit(handle);
    }
    nvs_close(handle);
    return err;
}

/*
 * 读一份 blob 进调用方的缓冲。实际长度写进 *len（进入时是容量）。
 * 没有历史 / 长度超过容量时返回 false。
 */
static bool read_key(lumen_save_key_t key, uint8_t *buf, size_t *len)
{
    if ((unsigned)key >= LUMEN_SAVE_KEY_COUNT || buf == NULL || len == NULL) {
        return false;
    }
    nvs_handle_t handle;
    if (nvs_open(LUMEN_NVS_NAMESPACE, NVS_READONLY, &handle) != ESP_OK) {
        return false;
    }
    esp_err_t err = nvs_get_blob(handle, k_key_names[key], buf, len);
    nvs_close(handle);
    return err == ESP_OK;
}

static void store_task(void *arg)
{
    (void)arg;
    for (;;) {
        if (xSemaphoreTake(s_wake, portMAX_DELAY) != pdTRUE) {
            continue;
        }

        /*
         * debounce（§10.5）：等满各自的时长且期间没有新请求才写。
         *
         * 不能只靠「信号量等待超时」判定到期——超时发生在 tick 边界，可能比
         * 真正的到期时刻早不到 1ms，导致漏写。这里先问调度器还差多少毫秒，
         * 按精确剩余时间等；期间被新请求唤醒就重算，继续推迟。
         */
        for (;;) {
            xSemaphoreTake(s_lock, portMAX_DELAY);
            uint32_t wait_ms = lumen_save_scheduler_earliest_delay_ms(&s_sched, now_ms());
            xSemaphoreGive(s_lock);

            if (wait_ms == UINT32_MAX || wait_ms == 0) {
                break; /* 没有待写 / 已到期 */
            }
            (void)xSemaphoreTake(s_wake, pdMS_TO_TICKS(wait_ms));
        }

        /*
         * 逐键取到期项并写。一次唤醒可以 flush 多个键——它们各自独立计时，
         * 共用同一次唤醒更省 flash 写。
         *
         * 取到期项后立即持锁快照指针，出锁再写 NVS：nvs_commit 可能阻塞几百
         * 毫秒（cache 关闭期间），不能把引擎的请求路径挡在后面。
         */
        for (unsigned k = 0; k < LUMEN_SAVE_KEY_COUNT; ++k) {
            lumen_save_key_t key = (lumen_save_key_t)k;
            const uint8_t *blob = NULL;
            uint32_t len = 0;
            uint8_t command = 0;

            xSemaphoreTake(s_lock, portMAX_DELAY);
            bool due = lumen_save_scheduler_take_due(&s_sched, key, now_ms(), &blob, &len,
                                                     &command);
            xSemaphoreGive(s_lock);
            if (!due) {
                continue;
            }

            /*
             * State 键的 blob 就是 s_state_blob（在 request_save 里编码好），
             * 布局 / 场景的 blob 由引擎持有，两者在写入完成前都有效。
             */
            esp_err_t err = write_key(key, blob, len);
            if (err != ESP_OK) {
                /* ACK 早就发过了，失败只能异步上报（§10.5 Event 0x81）。 */
                ESP_LOGW(TAG, "nvs write failed: key=%s len=%u err=%s (cmd=0x%02X)",
                         k_key_names[key], (unsigned)len, esp_err_to_name(err), command);
                if (s_event_cb != NULL) {
                    s_event_cb(command);
                }
            } else {
                /*
                 * INFO 而不是 DEBUG：默认日志级别看不到 DEBUG，而「到底存了没有」
                 * 是真机排查的第一个问题（#162 靠它确认了写入确实发生）。
                 * 只在真落盘时打，不随每次编辑刷屏。
                 */
                ESP_LOGI(TAG, "saved key=%s (%u bytes, cmd=0x%02X)", k_key_names[key],
                         (unsigned)len, command);
            }
        }
    }
}

esp_err_t lumen_state_store_init(void)
{
    s_lock = xSemaphoreCreateMutex();
    s_wake = xSemaphoreCreateBinary();
    if (s_lock == NULL || s_wake == NULL) {
        return ESP_ERR_NO_MEM;
    }

    lumen_save_scheduler_init(&s_sched);
    s_event_cb = NULL;

    BaseType_t created =
        xTaskCreate(store_task, "lumen_store", CONFIG_LUMEN_STORE_TASK_STACK_SIZE, NULL,
                    CONFIG_LUMEN_STORE_TASK_PRIORITY, NULL);
    if (created != pdPASS) {
        return ESP_ERR_NO_MEM;
    }
    return ESP_OK;
}

bool lumen_state_store_load(lumen_persist_t *out)
{
    if (out == NULL) {
        return false;
    }
    size_t size = sizeof(s_state_blob);
    if (!read_key(LUMEN_SAVE_KEY_STATE, s_state_blob, &size)) {
        return false;
    }
    /* 长度 / magic / version / 字段越界的校验都在纯模块里（host 可单测）。 */
    return lumen_state_blob_decode(s_state_blob, size, out);
}

bool lumen_state_store_load_layout(lumen_layout_store_t *out,
                                   const uint16_t strip_counts[LUMEN_MAX_STRIPS])
{
    if (out == NULL) {
        return false;
    }
    /*
     * 布局 blob 最坏 2760 字节，放进本任务栈（5120，余量约 1.8 KB）会紧张，
     * 所以走静态缓冲。本函数只在启动加载时调用，那时不可能有待写内容。
     */
    static uint8_t blob[LUMEN_LAYOUT_BLOB_MAX];
    size_t size = sizeof(blob);
    if (!read_key(LUMEN_SAVE_KEY_LAYOUT, blob, &size)) {
        return false;
    }
    uint8_t strip_count = 0;
    if (!lumen_layout_blob_decode(blob, size, &strip_count, out)) {
        return false;
    }
    /*
     * blob 自带的每链灯珠数是冗余。以 State 的权威值再跑一次整份校验：
     * 灯珠数被改小之后，旧布局里越界的段应当整份拒绝，而不是让半套越界
     * 配置进入 RAM（§10.3）。
     */
    if (lumen_layout_store_validate(out, strip_count, strip_counts) != LUMEN_RESULT_OK) {
        ESP_LOGW(TAG, "布局 blob 与当前灯珠数不一致，整份拒绝");
        return false;
    }
    return true;
}

bool lumen_state_store_load_scene(uint8_t scene_id, lumen_scene_t *out)
{
    if (out == NULL || scene_id >= LUMEN_MAX_SCENES) {
        return false;
    }
    /* 场景 blob 最坏 12288 未字节，绝不能放本任务栈（见 §B7 的栈账）。 */
    static uint8_t blob[LUMEN_SCENE_BLOB_MAX];
    size_t size = sizeof(blob);
    lumen_save_key_t key = (lumen_save_key_t)(LUMEN_SAVE_KEY_SCENE0 + scene_id);
    if (!read_key(key, blob, &size)) {
        ESP_LOGW(TAG, "场景 %u：NVS 里没有 %s", scene_id, k_key_names[key]);
        return false;
    }
    if (!lumen_scene_blob_decode(blob, size, out)) {
        /*
         * 记「读到了多少字节 + 头 4 字节」就够了：只记「解码失败」的话，
         * 「长度不对」「magic 不对」「版本不对」在日志里长得一样（#162 正是
         * 靠这两个数字定位到 encode/decode 对未编排部位的处理不一致）。
         */
        ESP_LOGW(TAG, "场景 %u：%u 字节解码失败，magic=%02X%02X%02X%02X ver=%u", scene_id,
                 (unsigned)size, size > 0 ? blob[0] : 0, size > 1 ? blob[1] : 0,
                 size > 2 ? blob[2] : 0, size > 3 ? blob[3] : 0, size > 4 ? blob[4] : 0);
        return false;
    }
    return true;
}

void lumen_state_store_set_event_cb(lumen_store_event_cb cb)
{
    /* 只在初始化阶段（ble_link init）注册一次；不做运行期切换。 */
    s_event_cb = cb;
}

void lumen_state_store_request_save(const lumen_persist_t *snapshot, uint8_t command)
{
    if (snapshot == NULL || s_lock == NULL) {
        return;
    }
    /* State blob 只有 32 字节：在这里编码进静态缓冲，调度器只存指针。 */
    if (lumen_state_blob_encode(snapshot, s_state_blob) != LUMEN_STATE_BLOB_SIZE) {
        ESP_LOGW(TAG, "state blob 编码失败，跳过本次保存");
        return;
    }
    xSemaphoreTake(s_lock, portMAX_DELAY);
    (void)lumen_save_scheduler_request(&s_sched, LUMEN_SAVE_KEY_STATE, s_state_blob,
                                       LUMEN_STATE_BLOB_SIZE, command, now_ms(),
                                       key_debounce_ms(LUMEN_SAVE_KEY_STATE));
    xSemaphoreGive(s_lock);
    xSemaphoreGive(s_wake);
}

bool lumen_state_store_request_layout_save(const uint8_t *blob, size_t len, uint8_t command)
{
    if (blob == NULL || len == 0 || len > LUMEN_LAYOUT_BLOB_MAX || s_lock == NULL) {
        return false;
    }
    xSemaphoreTake(s_lock, portMAX_DELAY);
    bool ok = lumen_save_scheduler_request(&s_sched, LUMEN_SAVE_KEY_LAYOUT, blob, (uint32_t)len,
                                           command, now_ms(),
                                           key_debounce_ms(LUMEN_SAVE_KEY_LAYOUT));
    xSemaphoreGive(s_lock);
    xSemaphoreGive(s_wake);
    return ok;
}

bool lumen_state_store_request_scene_save(uint8_t scene_id, const uint8_t *blob, size_t len,
                                          uint8_t command)
{
    if (scene_id >= LUMEN_MAX_SCENES || blob == NULL || len == 0 ||
        len > LUMEN_SCENE_BLOB_MAX || s_lock == NULL) {
        return false;
    }
    lumen_save_key_t key = (lumen_save_key_t)(LUMEN_SAVE_KEY_SCENE0 + scene_id);
    xSemaphoreTake(s_lock, portMAX_DELAY);
    bool ok = lumen_save_scheduler_request(&s_sched, key, blob, (uint32_t)len, command, now_ms(),
                                           key_debounce_ms(key));
    xSemaphoreGive(s_lock);
    xSemaphoreGive(s_wake);
    return ok;
}
