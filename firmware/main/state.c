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
}

uint8_t lumen_state_clamp_brightness(uint8_t value, uint8_t max_brightness)
{
    return value > max_brightness ? max_brightness : value;
}

void lumen_state_to_bytes(const lumen_state_t *state, uint8_t max_brightness, uint8_t out[8])
{
    if (state == NULL || out == NULL) {
        return;
    }
    out[0] = state->power;
    out[1] = lumen_state_clamp_brightness(state->brightness, max_brightness);
    out[2] = state->r;
    out[3] = state->g;
    out[4] = state->b;
    out[5] = (uint8_t)(state->led_count & 0xFF);
    out[6] = (uint8_t)(state->led_count >> 8);
    out[7] = max_brightness;
}
