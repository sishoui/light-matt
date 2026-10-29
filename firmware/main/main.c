/*
 * #4「灯带点亮与电气基线」的临时 bring-up 固件。
 *
 * 这不是产品固件：
 *   - 这里只有一个 main，没有 BLE、没有协议、没有状态持久化、没有灯效；
 *   - #6 会把整个 main 重写成正式的固件骨架（渲染任务 / 状态机 / BLE 服务）。
 *
 * 它存在的唯一目的：在真实硬件上确认
 *   - espressif/led_strip 的 RMT backend 能在 ESP32-C3FH4 上点亮 30 灯 WS2812B；
 *   - 颜色通道顺序到底是不是 GRB；
 *   - 亮度 1 / 128 / 255 的实际观感；
 *   - 全白高亮时开发板 USB 5V 供不上电会怎样（掉压 / 重启 / 闪烁）；
 *   - 连续 5 分钟常亮是否稳定。
 *
 * 所有结论必须由人眼在灯带前确认，串口日志只能证明固件在跑、没重启。
 */

#include <inttypes.h>
#include <stdbool.h>
#include <stdint.h>

#include "esp_chip_info.h"
#include "esp_err.h"
#include "esp_log.h"
#include "esp_system.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "led_strip.h"
#include "sdkconfig.h"

static const char *TAG = "lumen_led";

/* RMT 时钟：WS2812B 的 1.25us 位宽在 10MHz 下是 12.5 tick，led_strip 内部按此量化。 */
#define LUMEN_RMT_RESOLUTION_HZ (10 * 1000 * 1000)

/* soak：5 分钟常亮，电流可控的红色 + 中亮。 */
#define SOAK_DURATION_MS (5 * 60 * 1000)
#define SOAK_HEARTBEAT_MS 30000
#define SOAK_R 255
#define SOAK_G 0
#define SOAK_B 0
#define SOAK_BRIGHTNESS 128

#if CONFIG_LUMEN_LED_COLOR_ORDER_RGB
#define LUMEN_COLOR_FORMAT LED_STRIP_COLOR_COMPONENT_FMT_RGB
#define LUMEN_COLOR_FORMAT_NAME "RGB"
#else
#define LUMEN_COLOR_FORMAT LED_STRIP_COLOR_COMPONENT_FMT_GRB
#define LUMEN_COLOR_FORMAT_NAME "GRB"
#endif

typedef struct {
    const char *name;      /* 日志里的阶段名，ASCII，方便回传日志后 grep */
    const char *expect;    /* 人眼应该看到什么 */
    uint8_t r;             /* 命令颜色（未经亮度缩放） */
    uint8_t g;
    uint8_t b;
    uint8_t brightness;    /* 0-255，线性乘到 RGB 上 */
    uint32_t duration_ms;
} led_stage_t;

/* 序列末尾的“灭”是 5 秒，然后立刻进 soak。 */
static const led_stage_t k_stages[] = {
    {
        .name = "red",
        .expect = "整条 30 灯纯红，颜色均匀、尾部不衰减",
        .r = 255, .g = 0, .b = 0,
        .brightness = 255,
        .duration_ms = 2000,
    },
    {
        .name = "green",
        .expect = "整条纯绿；若这里是红色，说明 R/G 通道要互换（改为 RGB）",
        .r = 0, .g = 255, .b = 0,
        .brightness = 255,
        .duration_ms = 2000,
    },
    {
        .name = "blue",
        .expect = "整条纯蓝",
        .r = 0, .g = 0, .b = 255,
        .brightness = 255,
        .duration_ms = 2000,
    },
    {
        .name = "warm_low",
        .expect = "暖白、明显很暗（亮度 1/255），不应刺眼；若这一段不亮或闪烁，属低亮度边界问题",
        .r = 255, .g = 180, .b = 120,
        .brightness = 1,
        .duration_ms = 2000,
    },
    {
        .name = "warm_mid",
        .expect = "同色暖白，中等亮度（128/255），约为上一段的可感知放大量",
        .r = 255, .g = 180, .b = 120,
        .brightness = 128,
        .duration_ms = 2000,
    },
    {
        .name = "white_high",
        .expect = "全白最亮（255/255），约 1.8A；重点观察是否掉压、整条闪烁、开发板重启",
        .r = 255, .g = 255, .b = 255,
        .brightness = 255,
        .duration_ms = 3000,
    },
    {
        .name = "off",
        .expect = "全部熄灭，不应有单灯微亮（若有，属首灯/末灯供电或数据问题）",
        .r = 0, .g = 0, .b = 0,
        .brightness = 0,
        .duration_ms = 5000,
    },
};

#define STAGE_COUNT (sizeof(k_stages) / sizeof(k_stages[0]))

static led_strip_handle_t s_strip;
static uint32_t s_refresh_errors;

static double now_s(void)
{
    return (double)esp_timer_get_time() / 1000000.0;
}

/* WS2812B 没有全局亮度寄存器，亮度只能在写入前线性乘到 RGB 上。
 * 这里刻意不做 gamma：本票要观察的是电气与通道顺序，
 * 线性缩放至少保证 1/255 就是真的 1/255（gamma 会让它更暗）。 */
static uint8_t scale_brightness(uint8_t value, uint8_t brightness)
{
    return (uint8_t)(((uint16_t)value * brightness + 127u) / 255u);
}

static const char *reset_reason_name(esp_reset_reason_t reason)
{
    switch (reason) {
    case ESP_RST_UNKNOWN:   return "UNKNOWN";
    case ESP_RST_POWERON:   return "POWERON";
    case ESP_RST_EXT:       return "EXT";
    case ESP_RST_SW:        return "SW";
    case ESP_RST_PANIC:     return "PANIC";
    case ESP_RST_INT_WDT:   return "INT_WDT";
    case ESP_RST_TASK_WDT:  return "TASK_WDT";
    case ESP_RST_WDT:       return "WDT";
    case ESP_RST_DEEPSLEEP: return "DEEPSLEEP";
    case ESP_RST_BROWNOUT:  return "BROWNOUT";
    case ESP_RST_SDIO:      return "SDIO";
    case ESP_RST_USB:       return "USB";       /* 原生 USB-JTAG 复位，烧录后会看到 */
    case ESP_RST_JTAG:      return "JTAG";
    case ESP_RST_EFUSE:     return "EFUSE";
    case ESP_RST_PWR_GLITCH: return "PWR_GLITCH";
    case ESP_RST_CPU_LOCKUP: return "CPU_LOCKUP";
    default:                return "?";
    }
}

static void log_boot_banner(void)
{
    esp_chip_info_t chip = {0};
    esp_chip_info(&chip);

    esp_reset_reason_t reason = esp_reset_reason();

    ESP_LOGI(TAG, "======================================================");
    ESP_LOGI(TAG, "lumen #4 LED bring-up（临时 main，#6 会替换）");
    ESP_LOGI(TAG, "chip=%s cores=%d rev=%d.%d", CONFIG_IDF_TARGET, chip.cores,
             chip.revision / 100, chip.revision % 100);
    ESP_LOGI(TAG, "reset_reason=%d (%s) uptime=%.3fs", (int)reason,
             reset_reason_name(reason), now_s());

    if (reason == ESP_RST_BROWNOUT || reason == ESP_RST_PWR_GLITCH) {
        ESP_LOGE(TAG, "*** 上次复位是 %s：供电不足（USB 5V 限流 / 线损 / 未共地）***",
                 reset_reason_name(reason));
    } else if (reason == ESP_RST_TASK_WDT || reason == ESP_RST_INT_WDT ||
               reason == ESP_RST_WDT || reason == ESP_RST_PANIC ||
               reason == ESP_RST_CPU_LOCKUP) {
        ESP_LOGE(TAG, "*** 上次复位不是正常上电（%s）：先查接线与供电，再怀疑固件 ***",
                 reset_reason_name(reason));
    }

    ESP_LOGI(TAG, "strip: gpio=%d leds=%d color_order=%s mem_block_symbols=%d resolution=%d Hz dma=off",
             CONFIG_LUMEN_LED_GPIO, CONFIG_LUMEN_LED_COUNT, LUMEN_COLOR_FORMAT_NAME,
             CONFIG_LUMEN_RMT_MEM_BLOCK_SYMBOLS, LUMEN_RMT_RESOLUTION_HZ);
    ESP_LOGI(TAG, "接线：GPIO%d -> DIN；灯带用独立 5V 供电；开发板 GND 必须与灯带 GND 相连", CONFIG_LUMEN_LED_GPIO);
    ESP_LOGI(TAG, "接线：首灯并 500-1000uF/>=6.3V 电容；数据线串 300-500ohm（靠灯珠一端）");
    ESP_LOGI(TAG, "接线：灯带方向 DIN 在首灯，箭头指向尾部；接反不会亮");
    ESP_LOGI(TAG, "电气：3.3V 直驱 5V 灯带不满足 VIH=3.5V 规格，画板必须加 74AHCT125（不能用 74HC125）");
    ESP_LOGI(TAG, "======================================================");
}

static esp_err_t strip_init(void)
{
    led_strip_config_t strip_config = {
        .strip_gpio_num = CONFIG_LUMEN_LED_GPIO,
        .max_leds = CONFIG_LUMEN_LED_COUNT,
        .led_model = LED_MODEL_WS2812,
        .color_component_format = LUMEN_COLOR_FORMAT,
        .flags.invert_out = false,
    };
    led_strip_rmt_config_t rmt_config = {
        .clk_src = RMT_CLK_SRC_DEFAULT,
        .resolution_hz = LUMEN_RMT_RESOLUTION_HZ,
        .mem_block_symbols = CONFIG_LUMEN_RMT_MEM_BLOCK_SYMBOLS,
        .flags.with_dma = false,
    };

    esp_err_t err = led_strip_new_rmt_device(&strip_config, &rmt_config, &s_strip);
    if (err != ESP_OK) {
        s_strip = NULL;
        ESP_LOGE(TAG, "led_strip_new_rmt_device 失败: %s", esp_err_to_name(err));
        ESP_LOGE(TAG, "常见原因：GPIO 被占用/RMT 通道不足；先确认 GPIO%d 没接别的东西",
                 CONFIG_LUMEN_LED_GPIO);
    }
    return err;
}

/* 把一帧真正写进灯带并阻塞等待发完。 */
static esp_err_t show_rgb(uint8_t r, uint8_t g, uint8_t b, uint8_t brightness)
{
    if (s_strip == NULL) {
        return ESP_ERR_INVALID_STATE;
    }

    uint8_t sr = scale_brightness(r, brightness);
    uint8_t sg = scale_brightness(g, brightness);
    uint8_t sb = scale_brightness(b, brightness);

    for (int i = 0; i < CONFIG_LUMEN_LED_COUNT; ++i) {
        esp_err_t err = led_strip_set_pixel(s_strip, i, sr, sg, sb);
        if (err != ESP_OK) {
            s_refresh_errors++;
            ESP_LOGE(TAG, "set_pixel(%d) 失败: %s", i, esp_err_to_name(err));
            return err;
        }
    }

    esp_err_t err = led_strip_refresh(s_strip);
    if (err != ESP_OK) {
        s_refresh_errors++;
        ESP_LOGE(TAG, "refresh 失败: %s", esp_err_to_name(err));
    }
    return err;
}

static void log_stage(int index, const led_stage_t *stage)
{
    uint8_t sr = scale_brightness(stage->r, stage->brightness);
    uint8_t sg = scale_brightness(stage->g, stage->brightness);
    uint8_t sb = scale_brightness(stage->b, stage->brightness);

    ESP_LOGI(TAG, "[t=%8.3fs] [stage %d/%d] %-10s 期望：%s", now_s(),
             index + 1, (int)STAGE_COUNT, stage->name, stage->expect);
    ESP_LOGI(TAG, "[t=%8.3fs] [stage %d/%d] %-10s 命令 RGB=(%3u,%3u,%3u) brightness=%3u -> 实际下发 (%3u,%3u,%3u) x %d 灯 %" PRIu32 "ms",
             now_s(), index + 1, (int)STAGE_COUNT, stage->name,
             stage->r, stage->g, stage->b, stage->brightness,
             sr, sg, sb, CONFIG_LUMEN_LED_COUNT, stage->duration_ms);
}

static void run_sequence(uint32_t pass)
{
    ESP_LOGI(TAG, "[t=%8.3fs] ===== 序列第 %" PRIu32 " 轮开始：红 -> 绿 -> 蓝 -> 暖白低 -> 暖白中 -> 全白高 -> 灭 =====",
             now_s(), pass);

    for (int i = 0; i < (int)STAGE_COUNT; ++i) {
        const led_stage_t *stage = &k_stages[i];
        log_stage(i, stage);
        show_rgb(stage->r, stage->g, stage->b, stage->brightness);
        vTaskDelay(pdMS_TO_TICKS(stage->duration_ms));
    }

    ESP_LOGI(TAG, "[t=%8.3fs] ===== 序列第 %" PRIu32 " 轮结束 =====", now_s(), pass);
}

/* 5 分钟常亮。红色 + 亮度 128 的电流远低于全白，适合长时间观察闪烁/重启。 */
static void run_soak(uint32_t pass)
{
    ESP_LOGI(TAG, "[t=%8.3fs] [soak] 开始：全红 RGB=(255,0,0) brightness=%d，持续 %d 分钟，每 %d 秒心跳",
             now_s(), SOAK_BRIGHTNESS, SOAK_DURATION_MS / 60000, SOAK_HEARTBEAT_MS / 1000);
    ESP_LOGI(TAG, "[t=%8.3fs] [soak] 期望：整条保持均匀红色，5 分钟内不闪烁、不重启；"
                  "若中途日志从头开始且 reset_reason=BROWNOUT，就是掉压", now_s());

    show_rgb(SOAK_R, SOAK_G, SOAK_B, SOAK_BRIGHTNESS);

    int64_t start_us = esp_timer_get_time();
    int64_t next_heartbeat_us = start_us + (int64_t)SOAK_HEARTBEAT_MS * 1000;
    int beat = 0;
    const int total_beats = SOAK_DURATION_MS / SOAK_HEARTBEAT_MS;

    for (;;) {
        vTaskDelay(pdMS_TO_TICKS(1000));

        int64_t now_us = esp_timer_get_time();
        int64_t elapsed_ms = (now_us - start_us) / 1000;
        bool finished = elapsed_ms >= SOAK_DURATION_MS;

        if (now_us >= next_heartbeat_us) {
            beat++;
            next_heartbeat_us += (int64_t)SOAK_HEARTBEAT_MS * 1000;
            ESP_LOGI(TAG, "[t=%8.3fs] [soak] 心跳 %d/%d：已常亮 %" PRId64 "s，剩余 %" PRId64
                          "s，heap=%" PRIu32 " min_heap=%" PRIu32 " refresh_errors=%" PRIu32,
                     now_s(), beat, total_beats, elapsed_ms / 1000,
                     (SOAK_DURATION_MS - elapsed_ms) / 1000 > 0
                         ? (SOAK_DURATION_MS - elapsed_ms) / 1000
                         : 0,
                     esp_get_free_heap_size(), esp_get_minimum_free_heap_size(),
                     s_refresh_errors);
        }

        if (finished) {
            break;
        }
    }

    ESP_LOGI(TAG, "[t=%8.3fs] [soak] 第 %" PRIu32 " 轮结束：累计 refresh_errors=%" PRIu32
                  "，heap=%" PRIu32 "，min_heap=%" PRIu32,
             now_s(), pass, s_refresh_errors, esp_get_free_heap_size(),
             esp_get_minimum_free_heap_size());
}

void app_main(void)
{
    log_boot_banner();

    if (strip_init() != ESP_OK) {
        ESP_LOGE(TAG, "无法创建灯带，序列不会开始。检查接线后按 RST 重启。");
        for (;;) {
            vTaskDelay(pdMS_TO_TICKS(10000));
            ESP_LOGE(TAG, "[t=%8.3fs] 仍在等待：led_strip 初始化失败，未点灯", now_s());
        }
    }

    /* 先灭一次，避免复位后残留上一轮的像素。 */
    show_rgb(0, 0, 0, 0);

    for (uint32_t pass = 1;; ++pass) {
        run_sequence(pass);
        run_soak(pass);
    }
}
