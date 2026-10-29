#include "selftest.h"

#include <stddef.h>

/* 协议 §11.2：红 → 绿 → 蓝 → 白。顺序是验收项，不要调整。 */
static const uint8_t k_selftest_rgb[LUMEN_SELFTEST_STEPS][3] = {
    {255, 0, 0},
    {0, 255, 0},
    {0, 0, 255},
    {255, 255, 255},
};

static const char *const k_selftest_names[LUMEN_SELFTEST_STEPS] = {
    "red",
    "green",
    "blue",
    "white",
};

void lumen_selftest_reset(lumen_selftest_t *st)
{
    if (st == NULL) {
        return;
    }
    st->active = false;
    st->step = 0;
    st->step_started_us = 0;
}

void lumen_selftest_start(lumen_selftest_t *st, int64_t now_us)
{
    if (st == NULL) {
        return;
    }
    st->active = true;
    st->step = 0;
    st->step_started_us = now_us;
}

void lumen_selftest_stop(lumen_selftest_t *st)
{
    if (st == NULL) {
        return;
    }
    st->active = false;
    st->step = 0;
    st->step_started_us = 0;
}

bool lumen_selftest_active(const lumen_selftest_t *st)
{
    return st != NULL && st->active;
}

uint8_t lumen_selftest_step(const lumen_selftest_t *st)
{
    return st == NULL ? 0 : st->step;
}

bool lumen_selftest_advance(lumen_selftest_t *st, int64_t now_us)
{
    if (st == NULL || !st->active) {
        return false;
    }

    int64_t elapsed = now_us - st->step_started_us;
    if (elapsed < 0) {
        /* 时钟回退（理论上 esp_timer 不会）：按刚开始处理，不提前结束。 */
        elapsed = 0;
    }

    int64_t index = elapsed / LUMEN_SELFTEST_STEP_US;
    if (index >= LUMEN_SELFTEST_STEPS) {
        /* 4 × 500ms 走完：自动结束，调用方据此恢复存储状态。 */
        lumen_selftest_stop(st);
        return false;
    }

    st->step = (uint8_t)index;
    return true;
}

bool lumen_selftest_color(const lumen_selftest_t *st, uint8_t out_rgb[3])
{
    if (st == NULL || !st->active || out_rgb == NULL || st->step >= LUMEN_SELFTEST_STEPS) {
        return false;
    }
    out_rgb[0] = k_selftest_rgb[st->step][0];
    out_rgb[1] = k_selftest_rgb[st->step][1];
    out_rgb[2] = k_selftest_rgb[st->step][2];
    return true;
}

int64_t lumen_selftest_next_step_in_us(const lumen_selftest_t *st, int64_t now_us)
{
    if (st == NULL || !st->active) {
        return -1;
    }
    int64_t deadline =
        st->step_started_us + (int64_t)(st->step + 1) * LUMEN_SELFTEST_STEP_US;
    int64_t remaining = deadline - now_us;
    return remaining > 0 ? remaining : 0;
}

const char *lumen_selftest_step_name(uint8_t step)
{
    return step < LUMEN_SELFTEST_STEPS ? k_selftest_names[step] : "?";
}

void lumen_selftest_compose(const lumen_selftest_t *st, uint8_t stored_power,
                            uint8_t stored_brightness, const uint8_t stored_rgb[3],
                            uint8_t max_brightness, uint8_t out_rgb[3],
                            uint8_t *out_brightness)
{
    if (out_rgb == NULL || out_brightness == NULL) {
        return;
    }

    uint8_t selftest_rgb[3];
    if (lumen_selftest_color(st, selftest_rgb)) {
        /* §11.2 第 2/4 条：自检色满值输出，亮度取 max_brightness，不看 power。 */
        out_rgb[0] = selftest_rgb[0];
        out_rgb[1] = selftest_rgb[1];
        out_rgb[2] = selftest_rgb[2];
        *out_brightness = max_brightness;
        return;
    }

    /* 存储状态路径（与 #8/#9/#10 行为一致）：关灯把亮度乘 0，颜色仍保留。 */
    out_rgb[0] = stored_rgb != NULL ? stored_rgb[0] : 0;
    out_rgb[1] = stored_rgb != NULL ? stored_rgb[1] : 0;
    out_rgb[2] = stored_rgb != NULL ? stored_rgb[2] : 0;
    *out_brightness = stored_power ? stored_brightness : 0;
}
