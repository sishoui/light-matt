#pragma once

#include <stdbool.h>
#include <stdint.h>

#include "led_strip.h"

#include "layout_store.h"
#include "protocol.h"
#include "scene_compose.h"
#include "scene_store.h"
#include "selftest.h"
#include "state.h"

/*
 * led_render：一份状态快照 + 布局 + 场景 + 播放头 → 一帧灯带像素。
 *
 * 只做合成、gamma、自检覆盖、渲染去重与刷灯，不拥有任何共享状态、不加锁。
 * 调用者是渲染任务，且持有灯带句柄的唯一所有权（见 led_strip_owner.h）。
 *
 * v5 的合成**不再有段表**：唯一接缝是 `lumen_scene_compose()`
 * （scene_compose.c，host 可测）。本文件只负责它前后的两件事：
 *   ① 自检覆盖（整条单色，忽略布局与场景）；
 *   ② 全局亮度 + gamma，对整帧做**一次**。
 *
 * 没有覆盖的灯珠就是全黑（§9.3 第 1 步），不存在 v1 那种「整条铺 state->r/g/b」
 * 的回退。
 */

/*
 * 渲染一份快照，并把「已渲染像素」记下来供下次去重。
 *
 * selftest 是渲染任务在锁内拷出的一份自检快照（不能直接读引擎里的 s_selftest：
 * BLE 回调可能并发取消/重启）。
 * layout / scene / clocks 为 NULL 时视为「没有任何部位」→ 全黑。
 */
void lumen_led_render_snapshot(led_strip_handle_t strip, const lumen_state_t *snapshot,
                               const lumen_layout_store_t *layout, const lumen_scene_t *scene,
                               const lumen_part_clocks_t *clocks, const lumen_selftest_t *selftest,
                               uint8_t max_brightness, uint32_t now_ms);

/*
 * 把一条灯带的当前画面合成为像素缓冲（用户空间 RGB 已过 gamma + 亮度），
 * 不刷灯、不改去重状态。TDM 轮询用它为每条灯带各自生成一帧。
 *
 * 与 lumen_led_render_snapshot 共用同一套合成规则，区别只是「不负责刷灯」。
 * strip_id 决定用哪条链的布局与场景、以及它自己的灯珠数。
 *
 * 返回实际填充的灯珠数；参数非法返回 0。
 */
uint16_t lumen_led_render_compose_strip(const lumen_state_t *snapshot,
                                        const lumen_layout_store_t *layout,
                                        const lumen_scene_t *scene,
                                        const lumen_part_clocks_t *clocks,
                                        const lumen_selftest_t *selftest, uint8_t max_brightness,
                                        uint32_t now_ms, uint8_t strip_id, uint16_t strip_count,
                                        uint8_t *out_frame, uint16_t out_cap);

/*
 * 清掉「已渲染」标记，强制下一次渲染真的写灯带。
 * 新句柄的像素缓冲是空的（重建后）以及上电补发窗口内都必须调用。
 */
void lumen_led_render_invalidate(void);

/*
 * 帧循环的累计计数：
 *   drawn   —— 真正写进灯带的帧数（refresh 成功）
 *   skipped —— 像素与上一帧逐字节相同而跳过 refresh 的次数
 *
 * 用途是让「静态不空转、动画持续刷」在串口上可判定。
 * 任一参数可为 NULL。
 */
void lumen_led_render_counters(uint32_t *drawn, uint32_t *skipped);

/*
 * 让多灯带 TDM 路径把每条灯带的「真刷 / 跳过」记进同一组计数。
 * 单灯带路径已在 lumen_led_render_snapshot 内部记，不需要调用。
 */
void lumen_led_render_note_drawn(void);
void lumen_led_render_note_skipped(void);
