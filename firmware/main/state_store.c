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
#include "script_blob.h"
#include "state_blob.h"

static const char *TAG = "lumen_store";

#define LUMEN_NVS_NAMESPACE "lumen"
#define LUMEN_NVS_KEY "state"
/* #32：剧本单独一个 key（见 state_store.h 的理由）。 */
#define LUMEN_NVS_SCRIPT_KEY "scripts"

static SemaphoreHandle_t s_lock;
static SemaphoreHandle_t s_wake;
static lumen_save_scheduler_t s_sched;
static lumen_store_event_cb s_event_cb;

/*
 * 剧本快照（#32）。与状态快照共用同一把锁与同一个 debounce 计时：
 * 改段配置与改剧本几乎总是同一批命令，合并成一次唤醒更省 flash 写。
 *
 * 放在静态区而不是栈上：一套剧本约 1KB，存储任务栈只有 3KB。
 */
static uint8_t s_script_blob[LUMEN_SCRIPT_BLOB_MAX];
static size_t s_script_blob_len;
static bool s_script_pending;
static uint32_t s_script_deadline_ms;

/* 剧本写入的剩余 debounce 毫秒；UINT32_MAX = 没有待写。 */
static uint32_t script_next_delay_ms(uint32_t now)
{
    if (!s_script_pending) {
        return UINT32_MAX;
    }
    int32_t remaining = (int32_t)(s_script_deadline_ms - now);
    return remaining > 0 ? (uint32_t)remaining : 0;
}

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

/*
 * 栈注意（v4）：blob 缓冲是 1440 字节（LUMEN_STATE_BLOB_SIZE = 32 + 8×8×22），
 * 而本任务栈是 CONFIG_LUMEN_STORE_TASK_STACK_SIZE = 5120。调用方还持有一份
 * lumen_persist_t（≈1.83 KB），加上这里的 blob 与 NVS 在 cache 关闭期间的工作量，
 * 余量约 1.8 KB。想增大 blob 之前先读 Kconfig.projbuild 的那段账。
 */
static esp_err_t write_blob(const lumen_persist_t *snapshot)
{
    uint8_t blob[LUMEN_STATE_BLOB_SIZE];
    if (lumen_state_blob_encode(snapshot, blob) != LUMEN_STATE_BLOB_SIZE) {
        return ESP_ERR_INVALID_ARG;
    }

    nvs_handle_t handle;
    esp_err_t err = nvs_open(LUMEN_NVS_NAMESPACE, NVS_READWRITE, &handle);
    if (err != ESP_OK) {
        return err;
    }
    err = nvs_set_blob(handle, LUMEN_NVS_KEY, blob, sizeof(blob));
    if (err == ESP_OK) {
        err = nvs_commit(handle);
    }
    nvs_close(handle);
    return err;
}

/*
 * 写剧本 blob（#32）。blob 已由引擎编码好并拷进 s_script_blob（静态区，3KB 的
 * 存储任务栈放不下 4KB 缓冲）。
 */
static esp_err_t write_script_blob(const uint8_t *blob, size_t len)
{
    nvs_handle_t handle;
    esp_err_t err = nvs_open(LUMEN_NVS_NAMESPACE, NVS_READWRITE, &handle);
    if (err != ESP_OK) {
        return err;
    }
    err = nvs_set_blob(handle, LUMEN_NVS_SCRIPT_KEY, blob, len);
    if (err == ESP_OK) {
        err = nvs_commit(handle);
    }
    nvs_close(handle);
    return err;
}

static void store_task(void *arg)
{
    (void)arg;
    for (;;) {
        if (xSemaphoreTake(s_wake, portMAX_DELAY) != pdTRUE) {
            continue;
        }

        /*
         * debounce（协议 §12）：等满 500ms 且期间没有新请求才写。
         *
         * 不能只靠「信号量等待超时」判定到期——超时发生在 tick 边界，可能比
         * 真正的到期时刻早不到 1ms，导致漏写。这里先问调度器还差多少毫秒，
         * 按精确剩余时间等；期间被新请求唤醒就重算，继续推迟。
         */
        for (;;) {
            uint32_t wait_ms;
            xSemaphoreTake(s_lock, portMAX_DELAY);
            wait_ms = lumen_save_scheduler_next_delay_ms(&s_sched, now_ms());
            uint32_t script_wait = script_next_delay_ms(now_ms());
            /* 两个 debounce 取较早到期者（各自独立计时，共用一次唤醒）。 */
            if (script_wait < wait_ms) {
                wait_ms = script_wait;
            }
            xSemaphoreGive(s_lock);

            if (wait_ms == UINT32_MAX || wait_ms == 0) {
                break; /* 没有待写 / 已到期 */
            }
            (void)xSemaphoreTake(s_wake, pdMS_TO_TICKS(wait_ms));
        }

        lumen_persist_t snapshot;
        uint8_t command = 0;
        bool due;
        bool script_pending;
        xSemaphoreTake(s_lock, portMAX_DELAY);
        due = lumen_save_scheduler_take_due(&s_sched, now_ms(), &snapshot, &command);
        /*
         * 剧本快照与状态快照一起 flush：两者共享同一次唤醒，避免
         * 「状态写完了但剧本还没写」的中间窗口。剧本自己的 debounce 也必须
         * 已到期，否则把它放回待写状态继续等。
         */
        script_pending = s_script_pending && script_next_delay_ms(now_ms()) == 0;
        size_t script_len = s_script_blob_len;
        if (script_pending) {
            s_script_pending = false;
        }
        xSemaphoreGive(s_lock);
        if (!due && !script_pending) {
            continue;
        }

        if (due) {
            esp_err_t err = write_blob(&snapshot);
            if (err != ESP_OK) {
                /* ACK 早就发过了，失败只能异步上报（§10.3 Event 0x81）。 */
                ESP_LOGW(TAG, "nvs write failed: %s (cmd=0x%02X)", esp_err_to_name(err),
                         command);
                if (s_event_cb != NULL) {
                    s_event_cb(command);
                }
            } else {
                ESP_LOGD(TAG,
                         "state saved (leds=%u power=%u brightness=%u segs=%u cmd=0x%02X)",
                         snapshot.state.led_count, snapshot.state.power,
                         snapshot.state.brightness, snapshot.state.seg_count, command);
            }
        }

        if (script_pending) {
            esp_err_t err = write_script_blob(s_script_blob, script_len);
            if (err != ESP_OK) {
                ESP_LOGW(TAG, "nvs script write failed: %s", esp_err_to_name(err));
                if (s_event_cb != NULL) {
                    /* detail = 触发写入的命令字；剧本写入一律记 ScriptCommit。 */
                    s_event_cb(LUMEN_CMD_SCRIPT_COMMIT);
                }
            } else {
                ESP_LOGD(TAG, "scripts saved (%u bytes)", (unsigned)script_len);
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

    nvs_handle_t handle;
    esp_err_t err = nvs_open(LUMEN_NVS_NAMESPACE, NVS_READONLY, &handle);
    if (err != ESP_OK) {
        return false;
    }

    uint8_t blob[LUMEN_STATE_BLOB_SIZE];
    size_t size = sizeof(blob);
    err = nvs_get_blob(handle, LUMEN_NVS_KEY, blob, &size);
    nvs_close(handle);
    if (err != ESP_OK) {
        return false;
    }

    /* 长度 / magic / version / 字段越界的校验都在纯模块里（host 可单测）。 */
    return lumen_state_blob_decode(blob, size, out);
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
    xSemaphoreTake(s_lock, portMAX_DELAY);
    lumen_save_scheduler_request(&s_sched, snapshot, command, now_ms());
    xSemaphoreGive(s_lock);
    xSemaphoreGive(s_wake);
}

bool lumen_state_store_load_scripts(const uint16_t strip_counts[LUMEN_MAX_STRIPS],
                                    lumen_script_store_t *store, uint8_t *active_script_id,
                                    uint8_t *loop)
{
    if (store == NULL) {
        return false;
    }

    nvs_handle_t handle;
    esp_err_t err = nvs_open(LUMEN_NVS_NAMESPACE, NVS_READONLY, &handle);
    if (err != ESP_OK) {
        return false;
    }

    /*
     * 复用 s_script_blob 而不是再开一块 16KB 静态缓冲。
     *
     * 本函数只在启动加载时调用，那时候不可能有待写的剧本。为防将来有人在
     * 运行期再调一次，这里持锁并在有待写内容时直接拒绝，而不是悄悄覆盖掉
     * 一份还没落盘的快照。
     *
     * 这样全固件的 16KB 剧本缓冲从 3 块（48KB）降到 2 块（32KB）：
     * 这里 + led_engine 的编码缓冲。C3 只有 ~400KB SRAM 且要与 NimBLE 共用。
     */
    if (s_lock == NULL) {
        nvs_close(handle);
        return false;
    }
    xSemaphoreTake(s_lock, portMAX_DELAY);
    if (s_script_pending) {
        xSemaphoreGive(s_lock);
        nvs_close(handle);
        ESP_LOGW(TAG, "剧本加载被拒：已有待写的剧本快照（不应在运行期调用）");
        return false;
    }
    size_t size = sizeof(s_script_blob);
    err = nvs_get_blob(handle, LUMEN_NVS_SCRIPT_KEY, s_script_blob, &size);
    nvs_close(handle);
    if (err != ESP_OK) {
        xSemaphoreGive(s_lock);
        return false;
    }

    /*
     * 整份校验需要「每条灯带自己的灯珠数」。剧本里记录的段区间必须落在
     * 当前配置的灯珠数内——数量被改小之后旧剧本里的越界段应当整份拒绝，
     * 由调用方回落到「没有剧本」，而不是让半套越界配置进入 RAM。
     * strip_counts 由调用方在加载剧本之前填好（它来自状态 blob）。
     */
    bool ok = lumen_script_blob_decode(s_script_blob, size, strip_counts, store,
                                       active_script_id, loop);
    xSemaphoreGive(s_lock);
    return ok;
}

void lumen_state_store_request_script_save(const uint8_t *blob, size_t len)
{
    if (blob == NULL || len == 0 || len > sizeof(s_script_blob) || s_lock == NULL) {
        return;
    }
    xSemaphoreTake(s_lock, portMAX_DELAY);
    memcpy(s_script_blob, blob, len);
    s_script_blob_len = len;
    s_script_pending = true;
    s_script_deadline_ms = now_ms() + LUMEN_SAVE_DEBOUNCE_MS;
    xSemaphoreGive(s_lock);
    xSemaphoreGive(s_wake);
}
