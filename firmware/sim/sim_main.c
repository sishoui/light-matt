/*
 * 固件渲染的宿主机（host）模拟器。
 *
 * ## 为什么不是「另写一套模拟」
 *
 * 本文件**不重新实现任何灯效逻辑**。它直接链接固件真实的
 * effects.c / segment_store.c / gamma.c / led_render.c / state.c / strip_power.c，
 * 只提供两样东西：
 *
 *   1. 一个假的 `lumen_led_strip_owner_push_pixels`（吞掉刷新，把像素留在内存里）；
 *   2. 一个 JSON 输入（场景 = 各条灯带的段配置 + 全局亮度 + 采样时刻），
 *      跑完后把每条灯带的逐颗像素以 JSON 吐出去。
 *
 * 像素因此与真机**逐字节同源**：同一份 compose_frame、同一份
 * lumen_effect_pixel、同一份 gamma(brightness)。宿主上绿色就是设备上绿色。
 *
 * ## 它能证明什么、不能证明什么
 *
 * 能证明：段语义（谁有分区、谁全黑）、blend 的像素结果、层亮度、gamma 与
 *        全局亮度的合成顺序、动画在不同时刻的相位。
 * 不能证明：真实 WS2812B 的色域压缩、电源压降、RMT 时序。那些仍需真机。
 *
 * ## 输入 / 输出
 *
 *   lumen_sim <scenario.json> <out.json>
 *
 * 场景格式见 `scripts/simulate-strips.py` 的文档；这里只认它产出的形状。
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "esp_err.h"

#include "effects.h"
#include "led_render.h"
#include "segment_store.h"
#include "state.h"
#include "strip_power.h"

/* ---- 假句柄：led_render 只把它透传给 push_pixels，我们只要得到像素 ---- */

static uint8_t g_last_frame[LUMEN_MAX_LEDS * 3];

#define LUMEN_MAX_STRIPS_LOCAL 8

/* 由 led_strip_owner.c 提供；模拟器里换成「记下来」的版本。 */
esp_err_t lumen_led_strip_owner_push_pixels(led_strip_handle_t strip, const uint8_t *frame,
                                            uint16_t count)
{
    (void)strip;
    if (frame == NULL) {
        return ESP_ERR_INVALID_ARG;
    }
    if (count > LUMEN_MAX_LEDS) {
        count = LUMEN_MAX_LEDS;
    }
    memcpy(g_last_frame, frame, (size_t)count * 3u);
    return ESP_OK;
}

/* ---- 极小的 JSON 读取器：只支持本模拟器自己的输入形状 ---- */

static const char *g_cursor;

static void skip_ws(void)
{
    while (*g_cursor == ' ' || *g_cursor == '\t' || *g_cursor == '\n' || *g_cursor == '\r') {
        ++g_cursor;
    }
}

static int expect(char c)
{
    skip_ws();
    if (*g_cursor != c) {
        fprintf(stderr, "sim: 期望 '%c'，实际 '%c'（偏移 %ld）\n", c, *g_cursor,
                (long)(g_cursor - g_cursor));
        return 0;
    }
    ++g_cursor;
    return 1;
}

static int read_int(long *out)
{
    skip_ws();
    char *end = NULL;
    long v = strtol(g_cursor, &end, 10);
    if (end == g_cursor) {
        return 0;
    }
    g_cursor = end;
    *out = v;
    return 1;
}

static int read_key(char *buf, size_t cap)
{
    skip_ws();
    if (*g_cursor != '"') {
        return 0;
    }
    ++g_cursor;
    size_t n = 0;
    while (*g_cursor != '\0' && *g_cursor != '"') {
        if (n + 1 < cap) {
            buf[n++] = *g_cursor;
        }
        ++g_cursor;
    }
    if (*g_cursor != '"') {
        return 0;
    }
    ++g_cursor;
    buf[n] = '\0';
    return 1;
}

/* ---- 场景 ---- */

#define MAX_SAMPLES 64
#define MAX_SEGMENTS_PER_STRIP 8

/* 一层的 JSON 表示（**不是 lumen_effect_layer_t**：那是 9 字节线上编码）。 */
typedef struct {
    int type; /* -1 = 空层 */
    int hue;
    int sat;
    int period;
    int p5;
    int flags;
    int level;
} sim_layer_t;

typedef struct {
    int strip_id;
    int seg_id;
    int start;
    int end;
    int blend;
    sim_layer_t layer[2];
} sim_segment_t;

typedef struct {
    int led_count[LUMEN_MAX_STRIPS_LOCAL];
    int strip_count;
    int brightness;
    int power;
    int sample_ms[MAX_SAMPLES];
    int sample_count;
    sim_segment_t segs[LUMEN_MAX_STRIPS_LOCAL * MAX_SEGMENTS_PER_STRIP];
    int seg_count;
} sim_scenario_t;

/* 一层 JSON → sim_segment_t 的字段（**不是** lumen_effect_layer_t：那是线上
 * 的 9 字节定宽编码，这两个结构体的内存布局完全不同，强转会静默错位）。 */
static int parse_layer(sim_layer_t *out)
{
    memset(out, 0, sizeof(*out));
    out->type = -1; /* 空层 */

    if (!expect('{')) {
        return 0;
    }
    skip_ws();
    if (*g_cursor == '}') {
        ++g_cursor;
        return 1;
    }
    for (;;) {
        char key[32];
        if (!read_key(key, sizeof(key)) || !expect(':')) {
            return 0;
        }
        long v = 0;
        if (!read_int(&v)) {
            return 0;
        }
        if (strcmp(key, "type") == 0) {
            out->type = (int)v;
        } else if (strcmp(key, "hue") == 0) {
            out->hue = (int)v;
        } else if (strcmp(key, "sat") == 0) {
            out->sat = (int)v;
        } else if (strcmp(key, "period") == 0) {
            out->period = (int)v;
        } else if (strcmp(key, "p5") == 0) {
            out->p5 = (int)v;
        } else if (strcmp(key, "flags") == 0) {
            out->flags = (int)v;
        } else if (strcmp(key, "level") == 0) {
            out->level = (int)v;
        }
        skip_ws();
        if (*g_cursor == ',') {
            ++g_cursor;
            continue;
        }
        if (*g_cursor == '}') {
            ++g_cursor;
            return 1;
        }
        return 0;
    }
}

static int parse_segment(sim_segment_t *out)
{
    memset(out, 0, sizeof(*out));
    out->layer[0].type = LUMEN_LAYER_EMPTY;
    out->layer[1].type = LUMEN_LAYER_EMPTY;

    if (!expect('{')) {
        return 0;
    }
    skip_ws();
    if (*g_cursor == '}') {
        ++g_cursor;
        return 1;
    }
    for (;;) {
        char key[32];
        if (!read_key(key, sizeof(key)) || !expect(':')) {
            return 0;
        }
        if (strcmp(key, "layer0") == 0) {
            if (!parse_layer(&out->layer[0])) {
                return 0;
            }
        } else if (strcmp(key, "layer1") == 0) {
            if (!parse_layer(&out->layer[1])) {
                return 0;
            }
        } else {
            long v = 0;
            if (!read_int(&v)) {
                return 0;
            }
            if (strcmp(key, "strip") == 0) {
                out->strip_id = (int)v;
            } else if (strcmp(key, "seg") == 0) {
                out->seg_id = (int)v;
            } else if (strcmp(key, "start") == 0) {
                out->start = (int)v;
            } else if (strcmp(key, "end") == 0) {
                out->end = (int)v;
            } else if (strcmp(key, "blend") == 0) {
                out->blend = (int)v;
            }
        }
        skip_ws();
        if (*g_cursor == ',') {
            ++g_cursor;
            continue;
        }
        if (*g_cursor == '}') {
            ++g_cursor;
            return 1;
        }
        return 0;
    }
}

static int parse_int_array(int *out, int cap)
{
    if (!expect('[')) {
        return -1;
    }
    skip_ws();
    if (*g_cursor == ']') {
        ++g_cursor;
        return 0;
    }
    int n = 0;
    for (;;) {
        long v = 0;
        if (!read_int(&v)) {
            return -1;
        }
        if (n < cap) {
            out[n++] = (int)v;
        }
        skip_ws();
        if (*g_cursor == ',') {
            ++g_cursor;
            continue;
        }
        if (*g_cursor == ']') {
            ++g_cursor;
            return n;
        }
        return -1;
    }
}

static int parse_scenario(const char *path, sim_scenario_t *sc)
{
    memset(sc, 0, sizeof(*sc));
    for (int i = 0; i < LUMEN_MAX_STRIPS_LOCAL; ++i) {
        sc->led_count[i] = 30;
    }
    sc->strip_count = 8;
    sc->brightness = 200;
    sc->power = 1;

    FILE *fh = fopen(path, "rb");
    if (fh == NULL) {
        fprintf(stderr, "sim: 打不开场景文件 %s\n", path);
        return 0;
    }
    static char body[65536];
    size_t n = fread(body, 1, sizeof(body) - 1, fh);
    fclose(fh);
    body[n] = '\0';
    g_cursor = body;

    if (!expect('{')) {
        return 0;
    }
    skip_ws();
    if (*g_cursor == '}') {
        return 1;
    }
    for (;;) {
        char key[32];
        if (!read_key(key, sizeof(key)) || !expect(':')) {
            return 0;
        }
        if (strcmp(key, "led_count") == 0) {
            int tmp[LUMEN_MAX_STRIPS_LOCAL];
            int got = parse_int_array(tmp, LUMEN_MAX_STRIPS_LOCAL);
            if (got > 0) {
                for (int i = 0; i < got && i < LUMEN_MAX_STRIPS_LOCAL; ++i) {
                    sc->led_count[i] = tmp[i];
                }
            }
        } else if (strcmp(key, "samples_ms") == 0) {
            int got = parse_int_array(sc->sample_ms, MAX_SAMPLES);
            if (got > 0) {
                sc->sample_count = got;
            }
        } else if (strcmp(key, "segments") == 0) {
            if (!expect('[')) {
                return 0;
            }
            skip_ws();
            if (*g_cursor == ']') {
                ++g_cursor;
            } else {
                for (;;) {
                    if (sc->seg_count < (int)(sizeof(sc->segs) / sizeof(sc->segs[0]))) {
                        if (!parse_segment(&sc->segs[sc->seg_count])) {
                            return 0;
                        }
                        ++sc->seg_count;
                    } else {
                        return 0;
                    }
                    skip_ws();
                    if (*g_cursor == ',') {
                        ++g_cursor;
                        continue;
                    }
                    if (*g_cursor == ']') {
                        ++g_cursor;
                        break;
                    }
                    return 0;
                }
            }
        } else {
            long v = 0;
            if (!read_int(&v)) {
                return 0;
            }
            if (strcmp(key, "brightness") == 0) {
                sc->brightness = (int)v;
            } else if (strcmp(key, "power") == 0) {
                sc->power = (int)v;
            } else if (strcmp(key, "strip_count") == 0) {
                sc->strip_count = (int)v;
            }
        }
        skip_ws();
        if (*g_cursor == ',') {
            ++g_cursor;
            continue;
        }
        if (*g_cursor == '}') {
            break;
        }
        return 0;
    }
    return 1;
}

int main(int argc, char **argv)
{
    if (argc < 3) {
        fprintf(stderr, "用法: lumen_sim <scenario.json> <out.json>\n");
        return 2;
    }

    sim_scenario_t sc;
    if (!parse_scenario(argv[1], &sc)) {
        fprintf(stderr, "sim: 场景解析失败\n");
        return 2;
    }

    lumen_effects_init();

    lumen_state_t state;
    lumen_state_defaults(&state, (uint16_t)sc.led_count[0]);
    state.power = (uint8_t)sc.power;
    state.brightness = (uint8_t)sc.brightness;
    state.strip_count = (uint8_t)sc.strip_count;
    state.strip_power_mask = 0xFF;

    lumen_segment_store_t store;
    lumen_segment_store_init(&store);

    /* 逐条写入段。写入走真实的 SetSegment 校验路径（非法就被拒并报出来）。 */
    for (int i = 0; i < sc.seg_count; ++i) {
        const sim_segment_t *s = &sc.segs[i];
        lumen_segment_t seg;
        memset(&seg, 0, sizeof(seg));
        seg.active = true;
        seg.start = (uint8_t)s->start;
        seg.end = (uint8_t)s->end;
        seg.blend = (uint8_t)s->blend;
        for (int l = 0; l < 2; ++l) {
            seg.layer[l].type = (uint8_t)s->layer[l].type;
            if (s->layer[l].type < 0) {
                seg.layer[l].type = LUMEN_LAYER_EMPTY;
            }
            uint32_t hue = (uint32_t)(s->layer[l].hue < 0 ? 0 : s->layer[l].hue);
            seg.layer[l].param[0] = (uint8_t)(hue & 0xFF);
            seg.layer[l].param[1] = (uint8_t)((hue >> 8) & 0xFF);
            seg.layer[l].param[2] = (uint8_t)s->layer[l].sat;
            seg.layer[l].param[3] = (uint8_t)(s->layer[l].period & 0xFF);
            seg.layer[l].param[4] = (uint8_t)((s->layer[l].period >> 8) & 0xFF);
            seg.layer[l].param[5] = (uint8_t)s->layer[l].p5;
            seg.layer[l].param[6] = (uint8_t)s->layer[l].flags;
            seg.layer[l].level = (uint8_t)s->layer[l].level;
        }
        seg.t0_ms = 0;

        uint8_t result = lumen_segment_store_set(&store, (uint8_t)s->strip_id,
                                                 (uint8_t)sc.strip_count, (uint8_t)s->seg_id,
                                                 (uint8_t)sc.led_count[s->strip_id], &seg);
        if (result != 0) {
            fprintf(stderr,
                    "sim: strip %d seg %d 被拒（result=0x%02X）"
                    " l0.type=0x%02X l0.p=%u,%u,%u,%u,%u,%u,%u l0.level=%u"
                    " l1.type=0x%02X l1.p=%u,%u,%u,%u,%u,%u,%u l1.level=%u"
                    " blend=%u start=%u end=%u\n",
                    s->strip_id, s->seg_id, result, seg.layer[0].type, seg.layer[0].param[0],
                    seg.layer[0].param[1], seg.layer[0].param[2], seg.layer[0].param[3],
                    seg.layer[0].param[4], seg.layer[0].param[5], seg.layer[0].param[6],
                    seg.layer[0].level, seg.layer[1].type, seg.layer[1].param[0],
                    seg.layer[1].param[1], seg.layer[1].param[2], seg.layer[1].param[3],
                    seg.layer[1].param[4], seg.layer[1].param[5], seg.layer[1].param[6],
                    seg.layer[1].level, seg.blend, seg.start, seg.end);
            return 3;
        }
    }

    /* 输出：逐采样时刻 × 逐带 × 逐颗像素。 */
    FILE *out = fopen(argv[2], "wb");
    if (out == NULL) {
        fprintf(stderr, "sim: 打不开输出 %s\n", argv[2]);
        return 2;
    }
    fprintf(out, "{\"strips\":[");
    for (int i = 0; i < LUMEN_MAX_STRIPS_LOCAL; ++i) {
        fprintf(out, "%s%d", i == 0 ? "" : ",", sc.led_count[i]);
    }
    fprintf(out, "],\"frames\":[");

    for (int k = 0; k < sc.sample_count; ++k) {
        uint32_t now = (uint32_t)sc.sample_ms[k];
        fprintf(out, "%s{\"t_ms\":%d,\"strips\":[", k == 0 ? "" : ",", sc.sample_ms[k]);
        for (int strip = 0; strip < LUMEN_MAX_STRIPS_LOCAL; ++strip) {
            uint8_t frame[LUMEN_MAX_LEDS * 3];
            uint16_t n = lumen_led_render_compose_strip(
                &state, &store, NULL, 200, now, (uint8_t)strip, (uint16_t)sc.led_count[strip], 0,
                frame, sizeof(frame));
            fprintf(out, "%s[", strip == 0 ? "" : ",");
            for (uint16_t i = 0; i < n; ++i) {
                fprintf(out, "%s[%u,%u,%u]", i == 0 ? "" : ",", frame[i * 3u], frame[i * 3u + 1u],
                        frame[i * 3u + 2u]);
            }
            fprintf(out, "]");
        }
        fprintf(out, "]}");
    }
    fprintf(out, "]}\n");
    fclose(out);
    return 0;
}
