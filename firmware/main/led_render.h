#pragma once

#include <stdbool.h>
#include <stdint.h>

#include "led_strip.h"

#include "protocol.h"
#include "segment_store.h"
#include "state.h"

/* 自检进度类型（lumen_selftest_t）由 selftest.h 定义；渲染只读它。 */
#include "selftest.h"

/*
 * led_render：一份状态快照 + 段配置 → 一帧灯带像素。
 *
 * 只做合成、gamma、自检覆盖、渲染去重与刷灯，不拥有任何共享状态、不加锁。
 * 调用者是渲染任务，且持有灯带句柄的唯一所有权（见 led_strip_owner.h）。
 *
 * 两条路径（docs/v2-effects-engine.md §3 / §4）：
 *  - 有活动段：段合成到像素缓冲（**先 memset 0**，未覆盖区必须熄灭），
 *    再对每颗灯统一施加 gamma + 亮度；
 *  - 没有活动段：沿用 v1 的单色路径（state->r/g/b），现有单灯带功能不退化。
 */

/*
 * 渲染一份快照，并把「已渲染像素」记下来供下次去重。
 * selftest 是渲染任务在锁内拷出的一份自检快照（不能直接读引擎里的 s_selftest：
 * BLE 回调可能并发取消/重启）。
 * segments 可以为 NULL（视为没有任何活动段，走 v1 单色路径）。
 */
void lumen_led_render_snapshot(led_strip_handle_t strip, const lumen_state_t *snapshot,
                               const lumen_segment_store_t *segments,
                               const lumen_selftest_t *selftest, uint8_t max_brightness,
                               uint32_t now_ms);

/*
 * 清掉「已渲染」标记，强制下一次渲染真的写灯带。
 * 新句柄的像素缓冲是空的（重建后）以及上电补发窗口内都必须调用。
 */
void lumen_led_render_invalidate(void);
