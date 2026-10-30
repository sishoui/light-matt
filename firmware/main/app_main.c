#include "esp_err.h"
#include "esp_log.h"
#include "nvs_flash.h"
#include "sdkconfig.h"

#include "ble_link.h"
#include "led_engine.h"
#include "state_store.h"
#include "stress_metrics.h"

#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

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
    /* #7 压力模式：在任何初始化之前打印复位原因与实验配置；关闭时为空操作。 */
    lumen_stress_boot_report();

    esp_err_t err = nvs_flash_init();
    if (err == ESP_ERR_NVS_NO_FREE_PAGES || err == ESP_ERR_NVS_NEW_VERSION_FOUND) {
        ESP_ERROR_CHECK(nvs_flash_erase());
        err = nvs_flash_init();
    }
    ESP_ERROR_CHECK(err);

    ESP_ERROR_CHECK(lumen_state_store_init());

#if CONFIG_LUMEN_RMT_STRESS_MODE
    /*
     * 实验固件：灯带初始化失败（例如组 4 的 mem_block_symbols=384 超过 C3 的
     * 192 word 上限）时不要走 ESP_ERROR_CHECK 的重启循环——那会把串口刷满
     * 并掩盖原因。这里打印清楚后挂起，日志只出现一次。
     */
    esp_err_t led_err = lumen_led_engine_init();
    if (led_err != ESP_OK) {
        ESP_LOGE(TAG, "压力实验无法开始：led_engine 初始化失败 (%s)。"
                      "若是 mem_block_symbols>192，这是 C3 硬件上限导致的预期失败。",
                 esp_err_to_name(led_err));
        for (;;) {
            vTaskDelay(pdMS_TO_TICKS(10000));
            ESP_LOGE(TAG, "仍在等待：灯带初始化失败，未进入压力循环");
        }
    }
#else
    ESP_ERROR_CHECK(lumen_led_engine_init());
#endif

    ESP_ERROR_CHECK(lumen_ble_link_init());

    ESP_LOGI(TAG, "初始化完成：NVS → state_store → led_engine → ble_link");
}
