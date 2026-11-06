#include "script_scope.h"

#include <string.h>

bool lumen_scope_is_script_strip(uint8_t script_mask, uint8_t strip_id)
{
    if (strip_id >= LUMEN_MAX_STRIPS) {
        return false;
    }
    return (script_mask & (uint8_t)(1u << strip_id)) != 0;
}

uint8_t lumen_script_strip_union_mask(const lumen_script_t *script)
{
    if (script == NULL) {
        return 0;
    }
    uint8_t strip_count = script->strip_count;
    if (strip_count == 0 || strip_count > LUMEN_MAX_STRIPS) {
        strip_count = LUMEN_MAX_STRIPS;
    }
    uint8_t mask = 0;
    for (uint8_t stage = 0; stage < script->stage_count && stage < LUMEN_MAX_STAGES; ++stage) {
        const lumen_script_stage_t *s = &script->stages[stage];
        for (uint8_t strip = 0; strip < strip_count; ++strip) {
            if ((uint8_t)(1u << strip) == (mask & (uint8_t)(1u << strip))) {
                /* 已经置位的带不必再扫它的槽位。 */
                continue;
            }
            for (uint8_t slot = 0; slot < LUMEN_MAX_SEGMENTS; ++slot) {
                if (s->segments[strip][slot].active) {
                    mask |= (uint8_t)(1u << strip);
                    break;
                }
            }
        }
    }
    return mask;
}

const lumen_segment_store_t *lumen_scope_source_for_strip(const lumen_segment_store_t *stage,
                                                          const lumen_segment_store_t *live,
                                                          uint8_t script_mask, uint8_t strip_id)
{
    if (lumen_scope_is_script_strip(script_mask, strip_id)) {
        return stage != NULL ? stage : live;
    }
    return live != NULL ? live : stage;
}

void lumen_scope_compose(lumen_segment_store_t *out, const lumen_segment_store_t *stage,
                         const lumen_segment_store_t *live, uint8_t script_mask,
                         uint8_t strip_count)
{
    if (out == NULL) {
        return;
    }
    if (strip_count == 0 || strip_count > LUMEN_MAX_STRIPS) {
        strip_count = LUMEN_MAX_STRIPS;
    }
    for (uint8_t strip = 0; strip < LUMEN_MAX_STRIPS; ++strip) {
        const lumen_segment_store_t *src = NULL;
        if (strip < strip_count) {
            src = lumen_scope_source_for_strip(stage, live, script_mask, strip);
        }
        if (src == NULL) {
            /* 超出设备声明的带数：清空，不沿用上一帧的内容。 */
            memset(&out->slot[strip], 0, sizeof(out->slot[strip]));
            continue;
        }
        memcpy(&out->slot[strip], &src->slot[strip], sizeof(out->slot[strip]));
    }
}

uint8_t lumen_scope_anim_mask(const lumen_segment_store_t *stage,
                              const lumen_segment_store_t *live, uint8_t script_mask,
                              uint8_t strip_count)
{
    if (stage == NULL && live == NULL) {
        return 0;
    }
    if (strip_count == 0 || strip_count > LUMEN_MAX_STRIPS) {
        strip_count = LUMEN_MAX_STRIPS;
    }
    uint8_t mask = 0;
    for (uint8_t strip = 0; strip < strip_count; ++strip) {
        const lumen_segment_store_t *src =
            lumen_scope_source_for_strip(stage, live, script_mask, strip);
        if (src == NULL) {
            continue;
        }
        for (uint8_t slot = 0; slot < LUMEN_MAX_SEGMENTS; ++slot) {
            if (lumen_segment_is_animated(&src->slot[strip][slot])) {
                mask |= (uint8_t)(1u << strip);
                break;
            }
        }
    }
    return mask;
}
