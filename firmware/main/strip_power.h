#pragma once

#include <stdbool.h>
#include <stdint.h>

#include "segment_store.h"
#include "state.h"

/*
 * 每带独立开关的纯逻辑（#38）。
 *
 * 本模块不含任何 ESP-IDF / FreeRTOS 头，host 可直接单测：
 *  - 出光门控：全局 power && strip_power_mask 对应位（自检例外，§9.5/§9.7）；
 *  - strip_anim_mask 的推导（State 字节 12 的摘要）；
 *  - TDM 轮询的「推帧 / 先推黑再跳过 / 直接跳过」决策。
 *
 * 渲染层（led_render.c）与 TDM（led_engine.c）都只是这些纯函数的薄调用者，
 * 所以「关一条带的行为」可以在没有硬件的情况下被断言。
 */

/*
 * 该灯带这一帧是否应该出光（docs/protocol-v4.md §7.3 / §9.5）。
 *
 * 自检期间忽略每带开关：**所有**带都点亮（§9.7「自检期间忽略每带开关」），
 * 因此 selftest_active 为 true 时直接返回 true（合法 strip_id 前提下）。
 *
 * 合法 strip_id 是 0..LUMEN_MAX_STRIPS-1；越界 / state 为 NULL 一律 false。
 */
bool lumen_strip_mask_allows(const lumen_state_t *state, uint8_t strip_id, bool selftest_active);

/*
 * 推导 strip_anim_mask（State 字节 12）：bit i = 第 i 条带有**动画类**活动段。
 *
 * 只看 strip_id < strip_count 的灯带；strip_count 为 0 或越界时按
 * LUMEN_MAX_STRIPS 处理（与 segment_store_needs_frames 同一口径）。
 * 空段表 / NULL 返回 0。纯查询，不加锁。
 */
uint8_t lumen_strip_anim_mask(const lumen_segment_store_t *segments, uint8_t strip_count);

/*
 * 改 strip_power_mask 的一位（§9.5）。strip_id 越界时原样返回 mask。
 *
 * 与「全局 SetPower 不改掩码」配套：总闸与每带开关是两层独立的意图，
 * 关灯再开灯必须回到各带原来自己的开关状态。
 */
uint8_t lumen_strip_power_set_mask(uint8_t mask, uint8_t strip_id, bool on);

/* TDM 轮询对一条灯带的动作。 */
typedef enum {
    LUMEN_STRIP_TDM_SKIP = 0,       /* 本来就不出光：本轮不切引脚、不占 RMT */
    LUMEN_STRIP_TDM_PUSH,           /* 持续出光：正常合成并推一帧（可去重） */
    LUMEN_STRIP_TDM_BLACK_THEN_SKIP,/* 刚被关掉：推一帧全黑，本轮之后跳过 */
    LUMEN_STRIP_TDM_REENABLE        /* 刚被打开：必须立刻推、**跳过去重** */
} lumen_strip_tdm_action_t;

/*
 * 由「这一帧该不该出光 / 上一次实际有没有出光」决定 TDM 动作（§9.5）。
 *
 *   want_on  was_on  → PUSH（画面继续）
 *   want_on  !was_on → REENABLE（重开立刻恢复；必须绕过去重，否则残留黑帧）
 *   !want_on was_on  → BLACK_THEN_SKIP（先把已锁存的画面清黑）
 *   !want_on !was_on → SKIP（已经是黑的，别再浪费一帧 RMT）
 *
 * 自检由调用方先折进 want_on（自检期间 want_on 恒真），本函数不关心。
 */
lumen_strip_tdm_action_t lumen_strip_tdm_plan(bool want_on, bool was_on);
