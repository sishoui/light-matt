#include "strip_planar.h"

#include <ctype.h>
#include <stddef.h>
#include <string.h>

/*
 * 纯调度逻辑：见头文件。这里刻意不含任何 ESP-IDF 头，host 测试直接编译。
 */

uint8_t lumen_planar_parse_list(const char *text, uint16_t *out, uint8_t cap)
{
    if (text == NULL || out == NULL || cap == 0) {
        return 0;
    }
    uint8_t n = 0;
    const char *p = text;
    while (*p != '\0') {
        /* 跳过空白与分隔符。 */
        while (*p == ' ' || *p == '\t' || *p == ',') {
            ++p;
        }
        if (*p == '\0') {
            break;
        }
        unsigned value = 0;
        bool have_digit = false;
        while (isdigit((unsigned char)*p)) {
            value = value * 10u + (unsigned)(*p - '0');
            have_digit = true;
            if (value > 0xFFFFu) {
                return 0; /* 越界：整串作废，不静默截断 */
            }
            ++p;
        }
        if (!have_digit) {
            return 0; /* 非数字字符：整串作废 */
        }
        if (n >= cap) {
            return 0; /* 超过容量：整串作废，不静默丢尾巴 */
        }
        out[n++] = (uint16_t)value;
    }
    return n;
}

static bool pin_duplicated(const uint8_t *pins, uint8_t up_to, uint8_t pin)
{
    for (uint8_t i = 0; i < up_to; ++i) {
        if (pins[i] == pin) {
            return true;
        }
    }
    return false;
}

bool lumen_planar_init(lumen_planar_t *planar, const uint8_t *pins, const uint16_t *counts,
                       uint8_t strip_count)
{
    if (planar == NULL || pins == NULL || counts == NULL) {
        return false;
    }
    if (strip_count < 1 || strip_count > LUMEN_MAX_STRIPS) {
        return false;
    }
    /* 先全部校验，再写入：失败时 planar 保持原样。 */
    for (uint8_t i = 0; i < strip_count; ++i) {
        if (counts[i] < 1 || counts[i] > LUMEN_MAX_LEDS) {
            return false;
        }
        if (pin_duplicated(pins, i, pins[i])) {
            /* 两条灯带同一个引脚在 TDM 下无法区分，必须拒绝而不是后写覆盖。 */
            return false;
        }
    }

    memset(planar, 0, sizeof(*planar));
    planar->strip_count = strip_count;
    planar->cursor = 0;
    for (uint8_t i = 0; i < strip_count; ++i) {
        planar->strips[i].gpio = pins[i];
        planar->strips[i].count = counts[i];
        planar->strips[i].enabled = true;
        planar->strips[i].degraded = false;
        planar->strips[i].warned = false;
        if (counts[i] > planar->max_count) {
            planar->max_count = counts[i];
        }
    }
    return true;
}

const lumen_planar_strip_t *lumen_planar_get(const lumen_planar_t *planar, uint8_t strip_id)
{
    if (planar == NULL || strip_id >= planar->strip_count) {
        return NULL;
    }
    return &planar->strips[strip_id];
}

bool lumen_planar_set_count(lumen_planar_t *planar, uint8_t strip_id, uint16_t count)
{
    if (planar == NULL || strip_id >= planar->strip_count) {
        return false;
    }
    if (count < 1 || count > LUMEN_MAX_LEDS) {
        return false;
    }
    planar->strips[strip_id].count = count;
    /* 最大值可能要变小，重算一遍（8 条，代价可忽略）。 */
    uint16_t max = 0;
    for (uint8_t i = 0; i < planar->strip_count; ++i) {
        if (planar->strips[i].count > max) {
            max = planar->strips[i].count;
        }
    }
    planar->max_count = max;
    return true;
}

uint8_t lumen_planar_next(lumen_planar_t *planar)
{
    if (planar == NULL || planar->strip_count == 0) {
        return LUMEN_PLANAR_NONE;
    }
    /*
     * 从 cursor 起最多走 strip_count 步找一个可用条：
     * 全降级时正好走满一圈后放弃，不会死循环，也不会跳过「刚 revive 的条」。
     */
    for (uint8_t step = 0; step < planar->strip_count; ++step) {
        uint8_t id = planar->cursor;
        planar->cursor = (uint8_t)((planar->cursor + 1u) % planar->strip_count);
        const lumen_planar_strip_t *strip = &planar->strips[id];
        if (strip->enabled && !strip->degraded) {
            return id;
        }
    }
    return LUMEN_PLANAR_NONE;
}

uint8_t lumen_planar_revive_all(lumen_planar_t *planar)
{
    if (planar == NULL) {
        return 0;
    }
    uint8_t revived = 0;
    for (uint8_t i = 0; i < planar->strip_count; ++i) {
        if (planar->strips[i].degraded) {
            planar->strips[i].degraded = false;
            planar->strips[i].warned = false;
            ++revived;
        }
    }
    return revived;
}

bool lumen_planar_mark_degraded(lumen_planar_t *planar, uint8_t strip_id)
{
    if (planar == NULL || strip_id >= planar->strip_count) {
        return false;
    }
    lumen_planar_strip_t *strip = &planar->strips[strip_id];
    bool first = !strip->degraded;
    strip->degraded = true;
    if (first) {
        strip->warned = true;
    }
    return first;
}

bool lumen_planar_revive(lumen_planar_t *planar, uint8_t strip_id)
{
    if (planar == NULL || strip_id >= planar->strip_count) {
        return false;
    }
    lumen_planar_strip_t *strip = &planar->strips[strip_id];
    bool was = strip->degraded;
    strip->degraded = false;
    strip->warned = false;
    return was;
}

uint8_t lumen_planar_active_count(const lumen_planar_t *planar)
{
    if (planar == NULL) {
        return 0;
    }
    uint8_t n = 0;
    for (uint8_t i = 0; i < planar->strip_count; ++i) {
        if (planar->strips[i].enabled && !planar->strips[i].degraded) {
            ++n;
        }
    }
    return n;
}

void lumen_planar_stats_reset(lumen_planar_stats_t *stats)
{
    if (stats == NULL) {
        return;
    }
    memset(stats, 0, sizeof(*stats));
}

void lumen_planar_note_round(lumen_planar_stats_t *stats, uint32_t round_us, uint8_t pushed)
{
    if (stats == NULL) {
        return;
    }
    ++stats->rounds;
    stats->strips_pushed += pushed;
    stats->round_us_last = round_us;
    stats->round_us_total += round_us;
    if (round_us > stats->round_us_max) {
        stats->round_us_max = round_us;
    }
}

uint32_t lumen_planar_stats_avg_us(const lumen_planar_stats_t *stats)
{
    if (stats == NULL || stats->rounds == 0) {
        return 0;
    }
    return stats->round_us_total / stats->rounds;
}
