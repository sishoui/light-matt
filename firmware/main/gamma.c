#include "gamma.h"

#include <math.h>

#define LUMEN_GAMMA_EXPONENT 2.2f

static uint8_t s_gamma[256];
static int s_ready;

void lumen_gamma_init(void)
{
    if (s_ready) {
        return;
    }
    for (int i = 0; i < 256; ++i) {
        float normalized = (float)i / 255.0f;
        s_gamma[i] = (uint8_t)(powf(normalized, LUMEN_GAMMA_EXPONENT) * 255.0f + 0.5f);
    }
    s_ready = 1;
}

uint8_t lumen_gamma_apply(uint8_t value, uint8_t brightness)
{
    if (!s_ready) {
        lumen_gamma_init();
    }
    uint32_t scaled = (uint32_t)s_gamma[value] * brightness;
    return (uint8_t)((scaled + 127u) / 255u);
}
