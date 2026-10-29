#include "state_blob.h"

#include <string.h>

#include "protocol.h"

static const uint8_t s_blob_magic[4] = {'L', 'M', 'E', 'N'};

size_t lumen_state_blob_encode(const lumen_state_t *state, uint8_t out[LUMEN_STATE_BLOB_SIZE])
{
    if (state == NULL || out == NULL) {
        return 0;
    }
    memcpy(&out[0], s_blob_magic, sizeof(s_blob_magic));
    out[4] = (uint8_t)(LUMEN_STATE_BLOB_VERSION & 0xFF);
    out[5] = (uint8_t)(LUMEN_STATE_BLOB_VERSION >> 8);
    out[6] = state->power;
    out[7] = state->brightness;
    out[8] = state->r;
    out[9] = state->g;
    out[10] = state->b;
    out[11] = (uint8_t)(state->led_count & 0xFF);
    out[12] = (uint8_t)(state->led_count >> 8);
    return LUMEN_STATE_BLOB_SIZE;
}

bool lumen_state_blob_decode(const uint8_t *blob, size_t len, lumen_state_t *out)
{
    if (blob == NULL || out == NULL || len != LUMEN_STATE_BLOB_SIZE) {
        return false;
    }
    if (memcmp(&blob[0], s_blob_magic, sizeof(s_blob_magic)) != 0) {
        return false;
    }
    uint16_t version = (uint16_t)blob[4] | ((uint16_t)blob[5] << 8);
    if (version != LUMEN_STATE_BLOB_VERSION) {
        return false;
    }
    uint16_t led_count = (uint16_t)blob[11] | ((uint16_t)blob[12] << 8);
    if (blob[6] > 1 || led_count < 1 || led_count > LUMEN_MAX_LEDS) {
        return false;
    }

    out->power = blob[6];
    out->brightness = blob[7];
    out->r = blob[8];
    out->g = blob[9];
    out->b = blob[10];
    out->led_count = led_count;
    return true;
}
