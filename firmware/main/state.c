#include "state.h"

#include <stddef.h>
#include <string.h>

void lumen_state_defaults(lumen_state_t *state, uint16_t led_count)
{
    if (state == NULL) {
        return;
    }
    memset(state, 0, sizeof(*state));
    state->power = 0;
    state->brightness = 128;
    state->strip_count = 1;
    /* docs/protocol-v5.md §10.6：默认全部打开。 */
    state->strip_power_mask = 0xFF;
    state->active_scene = 0;
    state->layout_valid = 0;
    /* 只有 strip 0 有灯珠数，其余槽位为 0（§7.3「未用的槽位为 0」）。 */
    state->led_count[0] = led_count;
}

uint8_t lumen_state_clamp_brightness(uint8_t value, uint8_t max_brightness)
{
    return value > max_brightness ? max_brightness : value;
}

void lumen_state_to_bytes(const lumen_state_t *state, uint8_t max_brightness,
                          uint8_t out[LUMEN_STATE_BYTES])
{
    if (state == NULL || out == NULL) {
        return;
    }
    memset(out, 0, LUMEN_STATE_BYTES);
    /*
     * docs/protocol-v5.md §7.3：
     *   0 power | 1 brightness | 2 max_brightness | 3 strip_count |
     *   4 strip_power_mask | 5 active_scene | 6 layout_valid | 7 reserved |
     *   8..23  led_count[8]（u16 小端）| 24..31 part_count[8]
     */
    out[0] = state->power;
    out[1] = lumen_state_clamp_brightness(state->brightness, max_brightness);
    out[2] = max_brightness;
    out[3] = state->strip_count;
    out[4] = state->strip_power_mask;
    out[5] = state->active_scene;
    out[6] = state->layout_valid != 0 ? 1u : 0u;
    /* out[7] 保留 0（已由 memset 保证）。 */

    for (uint8_t i = 0; i < LUMEN_MAX_STRIPS; ++i) {
        uint16_t count = state->led_count[i];
        out[8 + i * 2] = (uint8_t)(count & 0xFF);
        out[8 + i * 2 + 1] = (uint8_t)(count >> 8);
    }
    for (uint8_t i = 0; i < LUMEN_MAX_STRIPS; ++i) {
        out[24 + i] = state->part_count[i];
    }
}
