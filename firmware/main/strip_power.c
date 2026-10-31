#include "strip_power.h"

#include "effects.h"
#include "protocol.h"

bool lumen_strip_mask_allows(const lumen_state_t *state, uint8_t strip_id, bool selftest_active)
{
    if (state == NULL || strip_id >= LUMEN_MAX_STRIPS) {
        return false;
    }
    /*
     * 自检是渲染层的最高优先级覆盖（§9.7）：序列期间**忽略每带开关**，
     * 所有带都点亮。所以门控在这里短路，而不是分散在渲染与 TDM 两处。
     */
    if (selftest_active) {
        return true;
    }
    if (state->power == 0) {
        return false;
    }
    return (state->strip_power_mask & (uint8_t)(1u << strip_id)) != 0;
}

uint8_t lumen_strip_anim_mask(const lumen_segment_store_t *segments, uint8_t strip_count)
{
    if (segments == NULL) {
        return 0;
    }
    if (strip_count == 0 || strip_count > LUMEN_MAX_STRIPS) {
        strip_count = LUMEN_MAX_STRIPS;
    }
    uint8_t mask = 0;
    for (uint8_t strip = 0; strip < strip_count; ++strip) {
        for (uint8_t slot = 0; slot < LUMEN_MAX_SEGMENTS; ++slot) {
            const lumen_segment_t *seg = &segments->slot[strip][slot];
            if (seg->active && lumen_effect_is_animated(seg->type)) {
                mask |= (uint8_t)(1u << strip);
                break; /* 一条带只要有一个动画段就置位 */
            }
        }
    }
    return mask;
}

uint8_t lumen_strip_power_set_mask(uint8_t mask, uint8_t strip_id, bool on)
{
    if (strip_id >= LUMEN_MAX_STRIPS) {
        return mask;
    }
    uint8_t bit = (uint8_t)(1u << strip_id);
    return on ? (uint8_t)(mask | bit) : (uint8_t)(mask & (uint8_t)~bit);
}

lumen_strip_tdm_action_t lumen_strip_tdm_plan(bool want_on, bool was_on)
{
    if (want_on) {
        /* 重开必须绕过去重：上一帧是黑帧，直接推会把黑帧「去重」掉。 */
        return was_on ? LUMEN_STRIP_TDM_PUSH : LUMEN_STRIP_TDM_REENABLE;
    }
    /*
     * 关掉时必须推一帧全黑再跳过：WS2812B 锁存住最后收到的画面，
     * 只跳过不推黑，那条带会一直停在被关之前的颜色上。
     */
    return was_on ? LUMEN_STRIP_TDM_BLACK_THEN_SKIP : LUMEN_STRIP_TDM_SKIP;
}
