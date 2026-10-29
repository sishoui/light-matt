#pragma once

#include <stdint.h>

#include "esp_err.h"

#include "state.h"

/*
 * led_engine：共享状态的唯一所有者 + latest-wins 邮箱 + 渲染任务。
 *
 * 依赖方向：ble_link → led_engine → state_store。led_engine 不调用任何 BLE API。
 * 灯带句柄只在渲染任务里使用（句柄在 init 中创建，任务启动后不再由其它任务触碰）。
 */

esp_err_t lumen_led_engine_init(void);

/* 把共享状态编码成 8 字节 State（docs/protocol.md §7），供 State read 使用。 */
void lumen_led_engine_state_bytes(uint8_t out[8]);

/* 拷贝一份共享状态快照。 */
void lumen_led_engine_snapshot(lumen_state_t *out);

/*
 * 提交一份新状态：写入共享状态与 latest-wins 邮箱、置 dirty、发渲染信号，
 * 并请求 state_store 做 500ms debounce 持久化。命令层（#8）在 reducer
 * 算出新状态后调用本函数；本票没有命令路径会调用它。
 */
void lumen_led_engine_commit(const lumen_state_t *next);

/* 当前生效的亮度上限（构建期常量）。 */
uint8_t lumen_led_engine_max_brightness(void);
