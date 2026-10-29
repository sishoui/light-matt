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
#define LUMEN_NVS_KEY "state"

static SemaphoreHandle_t s_lock;
static SemaphoreHandle_t s_wake;
static lumen_save_scheduler_t s_sched;
static lumen_store_event_cb s_event_cb;

/* 32 位毫秒时钟：esp_timer 是 64 位微秒，右移 10 位得到约 2048 秒回绕的毫秒。
 * save_scheduler 全用有符号差值比较，回绕不会卡死（见 save_scheduler.h）。 */
static uint32_t now_ms(void)
{
    return (uint32_t)(esp_timer_get_time() >> 10);
}

static esp_err_t write_blob(const lumen_state_t *state)
{
    uint8_t blob[LUMEN_STATE_BLOB_SIZE];
    if (lumen_state_blob_encode(state, blob) != LUMEN_STATE_BLOB_SIZE) {
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
            xSemaphoreGive(s_lock);

            if (wait_ms == UINT32_MAX || wait_ms == 0) {
                break; /* 没有待写 / 已到期 */
            }
            (void)xSemaphoreTake(s_wake, pdMS_TO_TICKS(wait_ms));
        }

        lumen_state_t snapshot;
        uint8_t command = 0;
        bool due;
        xSemaphoreTake(s_lock, portMAX_DELAY);
        due = lumen_save_scheduler_take_due(&s_sched, now_ms(), &snapshot, &command);
        xSemaphoreGive(s_lock);
        if (!due) {
            continue;
        }

        esp_err_t err = write_blob(&snapshot);
        if (err != ESP_OK) {
            /* ACK 早就发过了，失败只能异步上报（§10.3 Event 0x81）。 */
            ESP_LOGW(TAG, "nvs write failed: %s (cmd=0x%02X)", esp_err_to_name(err), command);
            if (s_event_cb != NULL) {
                s_event_cb(command);
            }
        } else {
            ESP_LOGD(TAG, "state saved (leds=%u power=%u brightness=%u cmd=0x%02X)",
                     snapshot.led_count, snapshot.power, snapshot.brightness, command);
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

bool lumen_state_store_load(lumen_state_t *out)
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

void lumen_state_store_request_save(const lumen_state_t *state, uint8_t command)
{
    if (state == NULL || s_lock == NULL) {
        return;
    }
    xSemaphoreTake(s_lock, portMAX_DELAY);
    lumen_save_scheduler_request(&s_sched, state, command, now_ms());
    xSemaphoreGive(s_lock);
    xSemaphoreGive(s_wake);
}
