#include "state.h"

#include <stddef.h>

void lumen_state_defaults(lumen_state_t *state, uint16_t led_count)
{
    if (state == NULL) {
        return;
    }
    state->power = 0;
    state->brightness = 128;
    state->r = 255;
    state->g = 180;
    state->b = 120;
    state->led_count = led_count;
    state->strip_count = 1;
    state->seg_count = 0;
    state->script_id = LUMEN_NO_SCRIPT;
    state->stage_index = 0;
    state->playback_state = 0;
    state->flags = 0;
    /* docs/protocol-v3.md §10.5：默认全部打开。 */
    state->strip_power_mask = 0xFF;
    state->strip_anim_mask = 0;
}

uint8_t lumen_state_clamp_brightness(uint8_t value, uint8_t max_brightness)
{
    return value > max_brightness ? max_brightness : value;
}

void lumen_state_to_bytes(const lumen_state_t *state, uint8_t max_brightness,
                          const uint16_t *strip_counts, const uint8_t *strip_seg_counts,
                          uint8_t out[LUMEN_STATE_BYTES])
{
    if (state == NULL || out == NULL) {
        return;
    }
    /* 0-12：全局状态与两个掩码（docs/protocol-v3.md §7.3）。 */
    out[0] = state->power;
    out[1] = lumen_state_clamp_brightness(state->brightness, max_brightness);
    out[2] = state->r;
    out[3] = state->g;
    out[4] = state->b;
    out[5] = max_brightness;
    out[6] = state->strip_count;
    out[7] = state->script_id;
    out[8] = state->stage_index;
    out[9] = state->playback_state;
    out[10] = state->flags;
    out[11] = state->strip_power_mask;
    out[12] = state->strip_anim_mask;

    /* 13-28：每条灯带的灯珠数（u16 小端）。 */
    for (uint8_t i = 0; i < LUMEN_MAX_STRIPS; ++i) {
        uint16_t count = 0;
        if (strip_counts != NULL) {
            count = strip_counts[i];
        } else if (i == 0) {
            count = state->led_count;
        }
        out[13 + i * 2] = (uint8_t)(count & 0xFF);
        out[14 + i * 2] = (uint8_t)(count >> 8);
    }

    /* 29-36：每条灯带的活动段数（strip 0 与 State 的 seg_count 同源）。 */
    for (uint8_t i = 0; i < LUMEN_MAX_STRIPS; ++i) {
        uint8_t segs = 0;
        if (strip_seg_counts != NULL) {
            segs = strip_seg_counts[i];
        } else if (i == 0) {
            segs = state->seg_count;
        }
        out[29 + i] = segs;
    }
}
