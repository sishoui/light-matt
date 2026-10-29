#include "esp_err.h"
#include "esp_log.h"
#include "nvs_flash.h"
#include "sdkconfig.h"

#include "ble_link.h"
#include "led_engine.h"
#include "state_store.h"

static const char *TAG = "lumen_app";

/*
 * 初始化顺序（与 docs/wayfinder/tickets/05-firmware-ble-skeleton.md 一致）：
 *   NVS → state_store 任务 → led_engine（恢复状态 + 建灯带 + 起渲染任务）
 *   → ble_link（NimBLE 主机任务；sync 回调里开始广播）。
 * NimBLE 内部还会再调用一次 nvs_flash_init（幂等），但我们必须先初始化 NVS，
 * 以便 led_engine 在 BLE 启动前恢复状态并完成第一次渲染。
 */
void app_main(void)
{
    esp_err_t err = nvs_flash_init();
    if (err == ESP_ERR_NVS_NO_FREE_PAGES || err == ESP_ERR_NVS_NEW_VERSION_FOUND) {
        ESP_ERROR_CHECK(nvs_flash_erase());
        err = nvs_flash_init();
    }
    ESP_ERROR_CHECK(err);

    ESP_ERROR_CHECK(lumen_state_store_init());
    ESP_ERROR_CHECK(lumen_led_engine_init());
    ESP_ERROR_CHECK(lumen_ble_link_init());

    ESP_LOGI(TAG, "初始化完成：NVS → state_store → led_engine → ble_link");
}
