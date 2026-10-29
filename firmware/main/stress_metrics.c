#include "stress_metrics.h"

#if CONFIG_LUMEN_RMT_STRESS_MODE

#include <inttypes.h>
#include <stdio.h>
#include <string.h>

#include "esp_attr.h"
#include "esp_heap_caps.h"
#include "esp_log.h"
#include "esp_system.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "freertos/task.h"
#include "sdkconfig.h"

static const char *TAG = "lumen_stress";

/*
 * RTC_NOINIT 内存里的 boot 计数：软件复位、WDT 复位后仍然保留，用来在长跑
 * 日志里一眼看出「中途重启过几次」。掉电（含部分 BROWNOUT）可能清空 RTC
 * 域，此时 magic 不匹配会重新从 1 计数，所以它只是辅助证据，不是权威。
 */
#define LUMEN_STRESS_BOOT_MAGIC 0x4C554D45u /* "LUME" */
RTC_NOINIT_ATTR static uint32_t s_boot_magic;
RTC_NOINIT_ATTR static uint32_t s_boot_count;

/* 单个窗口内的一组耗时统计（微秒）。 */
typedef struct {
    uint32_t count;
    int64_t sum_us;
    int64_t min_us;
    int64_t max_us;
} stress_stat_t;

/*
 * 渲染窗口统计。所有写入来自渲染任务，读取/清零来自心跳任务，
 * 用 s_metric_lock 保护。加锁次数是每帧 3 次、每次几微秒，可忽略。
 */
static SemaphoreHandle_t s_metric_lock;
static stress_stat_t s_refresh_win;    /* refresh / refresh_async 的调用耗时 */
static stress_stat_t s_async_wait_win; /* refresh_async_done 的等待耗时 */
static stress_stat_t s_loop_gap_win;   /* 两次循环唤醒之间的间隔 */
static uint32_t s_refresh_err_win;     /* 窗口内 refresh 返回非 OK 的次数 */
static uint32_t s_loop_gap_over_win;   /* 窗口内间隔超出「实际周期 + 5ms」的次数 */

/* 累计统计（跨窗口）。 */
static uint32_t s_refresh_total;
static uint32_t s_refresh_err_total;
static esp_err_t s_last_err = ESP_OK;
static uint32_t s_async_wait_err_total;
static uint32_t s_loop_gap_over_total;

/*
 * BLE 写入时间戳环：每次写入记录 (t_us, len)，心跳时批量倾倒。
 *
 * 为什么不在 rx_access 里直接打日志：RX 回调跑在 NimBLE 主机任务
 * （优先级 21）上，一次 20Hz 的串口打印约 5ms，会让主机任务周期性
 * 卡在 UART 上，本身就可能造成断连或写入延迟——这会污染被测对象。
 * 环形缓冲让主机任务只做 8 字节写入。
 *
 * 单生产者（主机任务）：先写槽位再递增 head；单消费者（心跳任务）：
 * 先读 head 再读槽位。两个变量都是 volatile，单核上顺序有保证。
 * 缓冲满时丢弃新记录并计数，绝不覆盖未消费的旧记录。
 */
#define STRESS_WRITE_RING 1024
static volatile int64_t s_write_ring[STRESS_WRITE_RING]; /* 打包为 (t_us << 8) | len */
static volatile uint32_t s_write_head;
static volatile uint32_t s_write_tail;
static volatile uint32_t s_write_dropped;

/* BLE 侧聚合计数：主机任务写，心跳任务读。C3 是 32 位机，单个 uint32_t
 * 的读写天然原子；64 位统计可能撕裂，但作为统计量够用，且不让主机任务
 * 去抢渲染任务的锁。 */
static volatile uint32_t s_ble_connects;
static volatile uint32_t s_ble_disconnects;
static volatile uint32_t s_ble_writes;
static volatile uint16_t s_ble_mtu_last;
static volatile int s_ble_last_disc_reason;
static volatile int64_t s_ble_last_write_us;
static volatile int64_t s_ble_write_gap_min_us;
static volatile int64_t s_ble_write_gap_max_us;
static volatile uint32_t s_ble_write_gap_count;

static int64_t now_us(void)
{
    return esp_timer_get_time();
}

static void stat_reset(stress_stat_t *s)
{
    s->count = 0;
    s->sum_us = 0;
    s->min_us = 0;
    s->max_us = 0;
}

static void stat_add(stress_stat_t *s, int64_t value_us)
{
    if (s->count == 0 || value_us < s->min_us) {
        s->min_us = value_us;
    }
    if (s->count == 0 || value_us > s->max_us) {
        s->max_us = value_us;
    }
    s->count++;
    s->sum_us += value_us;
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
    case ESP_RST_USB:       return "USB";
    case ESP_RST_JTAG:      return "JTAG";
    case ESP_RST_EFUSE:     return "EFUSE";
    case ESP_RST_PWR_GLITCH: return "PWR_GLITCH";
    case ESP_RST_CPU_LOCKUP: return "CPU_LOCKUP";
    default:                return "?";
    }
}

void lumen_stress_boot_report(void)
{
    bool known = (s_boot_magic == LUMEN_STRESS_BOOT_MAGIC);
    if (!known) {
        s_boot_count = 0;
        s_boot_magic = LUMEN_STRESS_BOOT_MAGIC;
    }
    s_boot_count++;

    /* 渲染任务在 led_engine_init 里就会开始记录指标，锁必须更早创建。 */
    if (s_metric_lock == NULL) {
        s_metric_lock = xSemaphoreCreateMutex();
    }

    esp_reset_reason_t reason = esp_reset_reason();

    ESP_LOGI(TAG, "======================================================");
    ESP_LOGI(TAG, "issue #7 RMT x BLE 共存压力模式（实验固件，非产品固件）");
    ESP_LOGI(TAG, "reset_reason=%d (%s) boot_count=%" PRIu32 " (RTC 保留，掉电会清零重计)",
             (int)reason, reset_reason_name(reason), s_boot_count);
    ESP_LOGI(TAG, "strip: gpio=%d leds=%d mem_block_symbols=%d resolution=10MHz dma=off",
             CONFIG_LUMEN_LED_GPIO, CONFIG_LUMEN_LED_COUNT,
             CONFIG_LUMEN_RMT_MEM_BLOCK_SYMBOLS);
    ESP_LOGI(TAG, "stress: period=%dms pattern=%s duration=%dmin async=%s brightness=%d "
                  "heartbeat=%ds start_delay=%ds write_ring=%d",
             CONFIG_LUMEN_STRESS_PERIOD_MS,
#if CONFIG_LUMEN_STRESS_PATTERN_STEADY
             "STEADY",
#else
             "CYCLE",
#endif
             CONFIG_LUMEN_STRESS_DURATION_MIN,
#if CONFIG_LUMEN_STRESS_REFRESH_ASYNC
             "on",
#else
             "off",
#endif
             CONFIG_LUMEN_STRESS_BRIGHTNESS, CONFIG_LUMEN_STRESS_HEARTBEAT_S,
             CONFIG_LUMEN_STRESS_START_DELAY_S, STRESS_WRITE_RING);

    if (reason == ESP_RST_BROWNOUT || reason == ESP_RST_PWR_GLITCH) {
        ESP_LOGE(TAG, "*** 上次复位是 %s：供电问题会让错色统计失真，先查 5V 供电/共地/电容 ***",
                 reset_reason_name(reason));
    } else if (reason == ESP_RST_TASK_WDT || reason == ESP_RST_INT_WDT || reason == ESP_RST_WDT) {
        ESP_LOGE(TAG, "*** 上次复位是 %s：渲染任务或中断被长时间饿死，这是共存问题的强证据 ***",
                 reset_reason_name(reason));
    } else if (reason == ESP_RST_PANIC || reason == ESP_RST_CPU_LOCKUP) {
        ESP_LOGE(TAG, "*** 上次复位是 %s：固件异常，保存完整日志后再排查 ***",
                 reset_reason_name(reason));
    }
    ESP_LOGI(TAG, "指标局限：本模式只能证明固件没崩/refresh 没报错/周期被拉长；"
                  "灯珠是否错色只能肉眼判定（见 docs/rmt-ble-stability.md）");
    ESP_LOGI(TAG, "======================================================");
}

void lumen_stress_note_refresh(esp_err_t err, int64_t elapsed_us)
{
    xSemaphoreTake(s_metric_lock, portMAX_DELAY);
    s_refresh_total++;
    stat_add(&s_refresh_win, elapsed_us);
    if (err != ESP_OK) {
        s_refresh_err_total++;
        s_refresh_err_win++;
        s_last_err = err;
    }
    xSemaphoreGive(s_metric_lock);
}

void lumen_stress_note_async_wait(esp_err_t err, int64_t elapsed_us)
{
    xSemaphoreTake(s_metric_lock, portMAX_DELAY);
    stat_add(&s_async_wait_win, elapsed_us);
    if (err != ESP_OK) {
        s_async_wait_err_total++;
    }
    xSemaphoreGive(s_metric_lock);
}

/*
 * 判定「循环被明显推迟」的阈值：实际周期 + 5ms。
 * 实际周期按 FreeRTOS tick 量化后计算——CONFIG_FREERTOS_HZ 默认 100
 * （10ms/tick），周期若不是 10ms 的整数倍，pdMS_TO_TICKS 会取整，
 * 直接用配置值会误判。默认周期 50ms 恰好是 5 个 tick。
 */
static int64_t loop_gap_threshold_us(void)
{
    const int64_t actual_period_us =
        (int64_t)pdMS_TO_TICKS(CONFIG_LUMEN_STRESS_PERIOD_MS) * 1000000 /
        configTICK_RATE_HZ;
    return actual_period_us + 5000;
}

void lumen_stress_note_loop_interval(int64_t interval_us)
{
    bool over = interval_us > loop_gap_threshold_us();
    xSemaphoreTake(s_metric_lock, portMAX_DELAY);
    stat_add(&s_loop_gap_win, interval_us);
    if (over) {
        s_loop_gap_over_win++;
        s_loop_gap_over_total++;
    }
    xSemaphoreGive(s_metric_lock);
}

void lumen_stress_note_ble_connect(uint16_t conn_handle)
{
    s_ble_connects++;
    s_ble_last_write_us = 0;
    s_ble_write_gap_count = 0;
    s_ble_write_gap_min_us = 0;
    s_ble_write_gap_max_us = 0;
    ESP_LOGI(TAG, "ble connect t=%" PRId64 "us handle=0x%04X (累计连接 %" PRIu32 ")",
             now_us(), conn_handle, s_ble_connects);
}

void lumen_stress_note_ble_disconnect(uint16_t conn_handle, int reason)
{
    s_ble_disconnects++;
    s_ble_last_disc_reason = reason;
    ESP_LOGI(TAG, "ble disconnect t=%" PRId64 "us handle=0x%04X reason=%d (累计断开 %" PRIu32 ")",
             now_us(), conn_handle, reason, s_ble_disconnects);
}

void lumen_stress_note_ble_mtu(uint16_t mtu)
{
    s_ble_mtu_last = mtu;
    ESP_LOGI(TAG, "ble mtu t=%" PRId64 "us mtu=%u", now_us(), mtu);
}

void lumen_stress_note_ble_write(uint16_t len)
{
    int64_t t = now_us();
    int64_t last = s_ble_last_write_us;
    if (last > 0) {
        int64_t gap = t - last;
        if (s_ble_write_gap_count == 0 || gap < s_ble_write_gap_min_us) {
            s_ble_write_gap_min_us = gap;
        }
        if (gap > s_ble_write_gap_max_us) {
            s_ble_write_gap_max_us = gap;
        }
        s_ble_write_gap_count++;
    }
    s_ble_last_write_us = t;
    s_ble_writes++;

#if CONFIG_LUMEN_STRESS_LOG_WRITES
    ESP_LOGI(TAG, "ble write t=%" PRId64 "us len=%u", t, len);
#endif

    /* 时间戳始终进环；环里只做一次 8 字节写入，不在主机任务里碰 UART。 */
    uint32_t head = s_write_head;
    if (head - s_write_tail >= STRESS_WRITE_RING) {
        s_write_dropped++;
        return;
    }
    s_write_ring[head % STRESS_WRITE_RING] = (t << 8) | (int64_t)(len & 0xFFu);
    s_write_head = head + 1;
}

static void log_stat(const char *name, const stress_stat_t *s)
{
    if (s->count == 0) {
        ESP_LOGI(TAG, "  %-10s count=0", name);
        return;
    }
    ESP_LOGI(TAG, "  %-10s count=%" PRIu32 " min=%" PRId64 "us avg=%" PRId64 "us max=%" PRId64 "us",
             name, s->count, s->min_us, s->sum_us / s->count, s->max_us);
}

/* 把上次心跳以来的写入时间戳批量打成若干行；在心跳任务（低优先级）里执行。 */
static void dump_write_ring(void)
{
    uint32_t tail = s_write_tail;
    uint32_t head = s_write_head;
    if (head == tail) {
        ESP_LOGI(TAG, "  ble writes: 本窗口无写入 (累计 %" PRIu32 ")", s_ble_writes);
        return;
    }

    ESP_LOGI(TAG, "  ble writes（本窗口 %" PRIu32 " 条，格式 t_us:len；丢弃 %" PRIu32 "）:",
             head - tail, s_write_dropped);

    char line[256];
    int pos = 0;
    line[0] = '\0';
    for (; tail != head; ++tail) {
        int64_t raw = s_write_ring[tail % STRESS_WRITE_RING];
        int64_t t = raw >> 8;
        unsigned len = (unsigned)(raw & 0xFF);
        /* 单条最长约 25 字符；每行超过 180 字符就换行，256 字节缓冲不会溢出。 */
        int wrote = snprintf(line + pos, sizeof(line) - (size_t)pos, " %" PRId64 ":%u", t, len);
        if (wrote <= 0) {
            continue;
        }
        pos += wrote;
        if (pos > 180) {
            ESP_LOGI(TAG, "   %s", line);
            pos = 0;
            line[0] = '\0';
        }
    }
    if (pos > 0) {
        ESP_LOGI(TAG, "   %s", line);
    }
    s_write_tail = tail;
}

/* 取走并清零当前窗口；调用者必须先持有 s_metric_lock。 */
static void snapshot_window(stress_stat_t *refresh, stress_stat_t *async_wait,
                            stress_stat_t *loop_gap, uint32_t *refresh_err,
                            uint32_t *loop_gap_over, uint32_t *refresh_total_out,
                            uint32_t *refresh_err_total_out, esp_err_t *last_err_out,
                            uint32_t *async_wait_err_total_out,
                            uint32_t *loop_gap_over_total_out)
{
    *refresh = s_refresh_win;
    *async_wait = s_async_wait_win;
    *loop_gap = s_loop_gap_win;
    *refresh_err = s_refresh_err_win;
    *loop_gap_over = s_loop_gap_over_win;
    *refresh_total_out = s_refresh_total;
    *refresh_err_total_out = s_refresh_err_total;
    *last_err_out = s_last_err;
    *async_wait_err_total_out = s_async_wait_err_total;
    *loop_gap_over_total_out = s_loop_gap_over_total;

    stat_reset(&s_refresh_win);
    stat_reset(&s_async_wait_win);
    stat_reset(&s_loop_gap_win);
    s_refresh_err_win = 0;
    s_loop_gap_over_win = 0;
}

static void print_heartbeat(bool include_writes)
{
    stress_stat_t refresh, async_wait, loop_gap;
    uint32_t refresh_err, loop_gap_over;
    uint32_t refresh_total, refresh_err_total, async_wait_err_total, loop_gap_over_total;
    esp_err_t last_err;

    xSemaphoreTake(s_metric_lock, portMAX_DELAY);
    snapshot_window(&refresh, &async_wait, &loop_gap, &refresh_err, &loop_gap_over,
                    &refresh_total, &refresh_err_total, &last_err, &async_wait_err_total,
                    &loop_gap_over_total);
    xSemaphoreGive(s_metric_lock);

    ESP_LOGI(TAG, "---------- 心跳 t=%" PRId64 "s ----------", now_us() / 1000000);
    log_stat("refresh", &refresh);
    log_stat("async_wait", &async_wait);
    log_stat("loop_gap", &loop_gap);
    ESP_LOGI(TAG, "  win: refresh_err=%" PRIu32 " loop_gap_over=%" PRIu32
                  " (阈值=实际周期+5ms)",
             refresh_err, loop_gap_over);
    ESP_LOGI(TAG, "  total: refresh=%" PRIu32 " refresh_err=%" PRIu32 " last_err=%s"
                  " async_wait_err=%" PRIu32 " loop_gap_over=%" PRIu32,
             refresh_total, refresh_err_total, esp_err_to_name(last_err),
             async_wait_err_total, loop_gap_over_total);
    ESP_LOGI(TAG, "  heap: free=%" PRIu32 " min_free=%" PRIu32 " largest_block=%" PRIu32,
             esp_get_free_heap_size(), esp_get_minimum_free_heap_size(),
             (uint32_t)heap_caps_get_largest_free_block(MALLOC_CAP_8BIT));
    ESP_LOGI(TAG, "  ble: connects=%" PRIu32 " disconnects=%" PRIu32 " last_disc_reason=%d"
                  " mtu=%u writes=%" PRIu32,
             s_ble_connects, s_ble_disconnects, s_ble_last_disc_reason, s_ble_mtu_last,
             s_ble_writes);
    if (s_ble_write_gap_count > 0) {
        ESP_LOGI(TAG, "       write_gap_us: count=%" PRIu32 " min=%" PRId64 " max=%" PRId64,
                 s_ble_write_gap_count, s_ble_write_gap_min_us, s_ble_write_gap_max_us);
    }
    if (include_writes) {
        dump_write_ring();
    }
}

/*
 * 心跳任务：低优先级（1，仅次于 IDLE）。串口打印很慢（115200 约 11.5KB/s），
 * 如果放在渲染任务里，每次心跳都会在 loop_gap 的最大值里留下一个几十毫秒的
 * 假尖峰，把真正的 BLE 抢占淹没。独立任务打印只竞争 CPU，不推迟渲染唤醒。
 */
static void heartbeat_task(void *arg)
{
    (void)arg;
    for (;;) {
        vTaskDelay(pdMS_TO_TICKS(CONFIG_LUMEN_STRESS_HEARTBEAT_S * 1000));
        print_heartbeat(true);
    }
}

esp_err_t lumen_stress_start(void)
{
    if (s_metric_lock == NULL) {
        return ESP_ERR_INVALID_STATE;
    }
    BaseType_t created = xTaskCreate(heartbeat_task, "lumen_stress", 4096, NULL, 1, NULL);
    return created == pdPASS ? ESP_OK : ESP_ERR_NO_MEM;
}

void lumen_stress_final_report(void)
{
    /*
     * 压力阶段由渲染任务结束；心跳任务仍在跑，统一走加锁快照。
     * 这里不倾倒写入环：环的 tail 只允许心跳任务推进，避免两个任务
     * 同时消费造成重复/丢失。剩余未打印的写入会在下一个心跳补上。
     */
    print_heartbeat(false);

    ESP_LOGI(TAG, "===== 压力阶段结束 t=%" PRId64 "s =====", now_us() / 1000000);
    ESP_LOGI(TAG, "提醒：以上仍然只能证明「固件没崩、刷新没报错」；"
                  "错色帧数必须由人眼填入 docs/rmt-ble-stability.md 的表格。");
    ESP_LOGI(TAG, "压力阶段结束后已回到普通 latest-wins 渲染路径（灯带停在最后一帧）。");
}

#endif /* CONFIG_LUMEN_RMT_STRESS_MODE */
