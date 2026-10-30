#pragma once

#include <stdint.h>

#include "esp_err.h"
#include "led_strip.h"

/*
 * led_strip_owner：灯带句柄的管理与像素推送。
 *
 * 句柄的唯一所有者是渲染任务：init 里创建，重建时在同一任务里替换/释放，
 * 其它任务（BLE 回调）绝不接触 led_strip_*。本模块不加锁——调用方按
 * 「只有一个渲染任务」的前提串行化调用。
 *
 * 产品路径上这里是唯一接触 led_strip_* 的编译单元；压力模式
 * （led_stress.c，CONFIG_LUMEN_RMT_STRESS_MODE）为了做 async 对比另有直接调用。
 */

/* 按 count 建句柄（不安装）；失败时 *out 未定义。 */
esp_err_t lumen_led_strip_owner_create(uint16_t count, led_strip_handle_t *out);

/* 建句柄并安装为当前句柄。 */
esp_err_t lumen_led_strip_owner_init(uint16_t count);

/* 当前句柄；未初始化/已释放时为 NULL。 */
led_strip_handle_t lumen_led_strip_owner_get(void);

/* 替换当前句柄（不释放旧句柄，调用方决定）。 */
void lumen_led_strip_owner_set(led_strip_handle_t strip);

/* 按句柄自己的 max_leds 整条清黑。删除旧句柄前必须调用（见 led_engine.c）。 */
esp_err_t lumen_led_strip_owner_clear(led_strip_handle_t strip);

/* 释放句柄，让出 RMT 通道与 GPIO 预留。 */
void lumen_led_strip_owner_destroy(led_strip_handle_t strip);

/*
 * 把一帧像素写进驱动并阻塞等待 RMT 发完。
 * 只有渲染任务调用（灯带句柄唯一所有者）。
 * 压力模式开启时顺带记录返回码与阻塞耗时；关闭时两次 esp_timer 调用
 * 都被编译掉，产品路径与 #6 骨架一致。
 */
esp_err_t lumen_led_strip_owner_push_frame(led_strip_handle_t strip, uint8_t r, uint8_t g,
                                           uint8_t b, uint16_t count);
