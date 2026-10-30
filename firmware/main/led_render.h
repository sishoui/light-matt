#pragma once

#include <stdbool.h>
#include <stdint.h>

#include "led_strip.h"

#include "state.h"

/* 自检进度类型（lumen_selftest_t）由 selftest.h 定义；渲染只读它。 */
#include "selftest.h"

/*
 * led_render：一份状态快照 → 一帧灯带像素。
 *
 * 只做 gamma、自检覆盖合成、渲染去重与刷灯，不拥有任何共享状态、不加锁。
 * 调用者是渲染任务，且持有灯带句柄的唯一所有权（见 led_strip_owner.h）。
 */

/*
 * 渲染一份快照，并把「已渲染像素」记下来供下次去重。
 * selftest 是渲染任务在锁内拷出的一份自检快照（不能直接读引擎里的 s_selftest：
 * BLE 回调可能并发取消/重启）。
 */
void lumen_led_render_snapshot(led_strip_handle_t strip, const lumen_state_t *snapshot,
                               const lumen_selftest_t *selftest, uint8_t max_brightness);

/*
 * 清掉「已渲染」标记，强制下一次渲染真的写灯带。
 * 新句柄的像素缓冲是空的（重建后）以及上电补发窗口内都必须调用。
 */
void lumen_led_render_invalidate(void);
