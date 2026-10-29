#pragma once

#include <stdbool.h>
#include <stdint.h>

#include "esp_err.h"

/*
 * stress_metrics：issue #7「RMT × BLE 共存验证」的串口指标采集。
 *
 * 只在 CONFIG_LUMEN_RMT_STRESS_MODE=y 时编译出实体代码；关闭时本头文件把
 * 所有接口定义成空的内联函数，调用点会被优化掉，产品路径零开销、行为与
 * #6 骨架完全一致。
 *
 * 这些指标能证明「固件没崩、refresh 没报错、渲染周期被拉长」，不能证明
 * 「灯珠没显示错色」——错色只能由人眼在灯带前判定。局限说明见
 * docs/rmt-ble-stability.md §2。
 */

#if CONFIG_LUMEN_RMT_STRESS_MODE

/*
 * 启动时打印复位原因、boot 计数与本次实验配置，并创建指标锁。
 * 必须在 led_engine 初始化之前调用（渲染任务会立刻开始记录）。
 */
void lumen_stress_boot_report(void);

/* 创建低优先级心跳任务（串口打印不能占用渲染任务的唤醒节拍）。 */
esp_err_t lumen_stress_start(void);

/* 渲染任务：一次 refresh / refresh_async 的返回码与阻塞耗时（微秒）。 */
void lumen_stress_note_refresh(esp_err_t err, int64_t elapsed_us);

/* 渲染任务：refresh_async_done 的等待耗时（组 5 专有）。 */
void lumen_stress_note_async_wait(esp_err_t err, int64_t elapsed_us);

/* 渲染任务：压力循环两次唤醒之间的实际间隔（微秒），用于检测 BLE 抢占。 */
void lumen_stress_note_loop_interval(int64_t interval_us);

/* 渲染任务：压力阶段结束时的汇总。 */
void lumen_stress_final_report(void);

/* BLE 主机任务：连接 / 断开 / MTU / 每次写入（含微秒时间戳）。 */
void lumen_stress_note_ble_connect(uint16_t conn_handle);
void lumen_stress_note_ble_disconnect(uint16_t conn_handle, int reason);
void lumen_stress_note_ble_mtu(uint16_t mtu);
void lumen_stress_note_ble_write(uint16_t len);

#else /* !CONFIG_LUMEN_RMT_STRESS_MODE */

static inline void lumen_stress_boot_report(void) {}
static inline esp_err_t lumen_stress_start(void) { return ESP_OK; }
static inline void lumen_stress_note_refresh(esp_err_t err, int64_t elapsed_us)
{
    (void)err;
    (void)elapsed_us;
}
static inline void lumen_stress_note_async_wait(esp_err_t err, int64_t elapsed_us)
{
    (void)err;
    (void)elapsed_us;
}
static inline void lumen_stress_note_loop_interval(int64_t interval_us)
{
    (void)interval_us;
}
static inline void lumen_stress_final_report(void) {}
static inline void lumen_stress_note_ble_connect(uint16_t conn_handle)
{
    (void)conn_handle;
}
static inline void lumen_stress_note_ble_disconnect(uint16_t conn_handle, int reason)
{
    (void)conn_handle;
    (void)reason;
}
static inline void lumen_stress_note_ble_mtu(uint16_t mtu)
{
    (void)mtu;
}
static inline void lumen_stress_note_ble_write(uint16_t len)
{
    (void)len;
}

#endif
