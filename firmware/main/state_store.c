#include "state_store.h"

#include <string.h>

#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "freertos/task.h"
#include "nvs.h"
#include "sdkconfig.h"

#include "protocol.h"

static const char *TAG = "lumen_store";

#define LUMEN_NVS_NAMESPACE "lumen"
#define LUMEN_NVS_KEY "state"
#define LUMEN_NVS_VERSION 1
#define LUMEN_STORE_DEBOUNCE_MS 500

/*
 * 显式字节布局，避免结构体 padding 随编译器变化：
 *   0..3   magic 'L' 'M' 'E' 'N'
 *   4..5   version (LE)
 *   6      power
 *   7      brightness
 *   8..10  r, g, b
 *   11..12 led_count (LE)
 */
#define LUMEN_BLOB_SIZE 13
static const uint8_t s_blob_magic[4] = {'L', 'M', 'E', 'N'};

static SemaphoreHandle_t s_lock;
static SemaphoreHandle_t s_wake;
static lumen_state_t s_pending;
static uint8_t s_pending_command;
static lumen_store_event_cb s_event_cb;

static esp_err_t write_blob(const lumen_state_t *state)
{
    uint8_t blob[LUMEN_BLOB_SIZE];
    memcpy(&blob[0], s_blob_magic, sizeof(s_blob_magic));
    blob[4] = (uint8_t)(LUMEN_NVS_VERSION & 0xFF);
    blob[5] = (uint8_t)(LUMEN_NVS_VERSION >> 8);
    blob[6] = state->power;
    blob[7] = state->brightness;
    blob[8] = state->r;
    blob[9] = state->g;
    blob[10] = state->b;
    blob[11] = (uint8_t)(state->led_count & 0xFF);
    blob[12] = (uint8_t)(state->led_count >> 8);

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

        /* debounce：500ms 内还有新请求就继续等，只写最后一份快照。 */
        while (xSemaphoreTake(s_wake, pdMS_TO_TICKS(LUMEN_STORE_DEBOUNCE_MS)) == pdTRUE) {
        }

        lumen_state_t snapshot;
        uint8_t command = 0;
        xSemaphoreTake(s_lock, portMAX_DELAY);
        snapshot = s_pending;
        command = s_pending_command;
        xSemaphoreGive(s_lock);

        esp_err_t err = write_blob(&snapshot);
        if (err != ESP_OK) {
            /* ACK 已经发过了，失败只能异步上报（§10.3 Event 0x81）。 */
            ESP_LOGW(TAG, "nvs write failed: %s (cmd=0x%02X)", esp_err_to_name(err), command);
            if (s_event_cb != NULL) {
                s_event_cb(command);
            }
        } else {
            ESP_LOGD(TAG, "state saved (cmd=0x%02X)", command);
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

    uint8_t blob[LUMEN_BLOB_SIZE];
    size_t size = sizeof(blob);
    err = nvs_get_blob(handle, LUMEN_NVS_KEY, blob, &size);
    nvs_close(handle);
    if (err != ESP_OK || size != sizeof(blob)) {
        return false;
    }

    if (memcmp(&blob[0], s_blob_magic, sizeof(s_blob_magic)) != 0) {
        return false;
    }
    if (((uint16_t)blob[4] | ((uint16_t)blob[5] << 8)) != LUMEN_NVS_VERSION) {
        return false;
    }

    uint16_t led_count = (uint16_t)blob[11] | ((uint16_t)blob[12] << 8);
    if (blob[6] > 1 || led_count < 1 || led_count > LUMEN_MAX_LEDS) {
        return false;
    }

    out->power = blob[6];
    out->brightness = blob[7];
    out->r = blob[8];
    out->g = blob[9];
    out->b = blob[10];
    out->led_count = led_count;
    return true;
}

void lumen_state_store_set_event_cb(lumen_store_event_cb cb)
{
    s_event_cb = cb;
}

void lumen_state_store_request_save(const lumen_state_t *state, uint8_t command)
{
    if (state == NULL || s_lock == NULL) {
        return;
    }
    xSemaphoreTake(s_lock, portMAX_DELAY);
    s_pending = *state;
    s_pending_command = command;
    xSemaphoreGive(s_lock);
    xSemaphoreGive(s_wake);
}
