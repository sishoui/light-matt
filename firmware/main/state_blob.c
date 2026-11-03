#include "state_blob.h"

#include <string.h>

#include "protocol.h"

static const uint8_t s_blob_magic[4] = {'L', 'M', 'E', 'N'};

#define BLOB_OFF_VERSION 4
#define BLOB_OFF_POWER 6
#define BLOB_OFF_BRIGHTNESS 7
#define BLOB_OFF_R 8
#define BLOB_OFF_LED_COUNT 11
#define BLOB_OFF_STRIP_COUNT 13
#define BLOB_OFF_STRIP_POWER_MASK 14
/* 灯珠数表 / seg_count / 段表偏移统一取自 state_blob.h，避免两处各写一份。 */

static void encode_segment(const lumen_segment_t *seg, uint8_t *out)
{
    out[0] = seg->active ? 1 : 0;
    out[1] = seg->start;
    out[2] = seg->end;
    out[3] = seg->blend;
    /* 层编码与 §7.1 的 9 字节线格式完全一致（type + param[7] + level）。 */
    lumen_layer_encode(&seg->layer[0], &out[4]);
    lumen_layer_encode(&seg->layer[1], &out[13]);
}

static void decode_segment(const uint8_t *in, lumen_segment_t *seg)
{
    memset(seg, 0, sizeof(*seg));
    seg->active = in[0] != 0;
    seg->start = in[1];
    seg->end = in[2];
    seg->blend = in[3];
    (void)lumen_layer_decode(&in[4], &seg->layer[0]);
    (void)lumen_layer_decode(&in[13], &seg->layer[1]);
    /* t0_ms 不持久化：加载后由引擎统一设为当前时刻（v2-effects-engine §7.3）。 */
    seg->t0_ms = 0;
}

size_t lumen_state_blob_encode(const lumen_persist_t *state,
                               uint8_t out[LUMEN_STATE_BLOB_SIZE])
{
    if (state == NULL || out == NULL) {
        return 0;
    }
    memset(out, 0, LUMEN_STATE_BLOB_SIZE);
    memcpy(&out[0], s_blob_magic, sizeof(s_blob_magic));
    out[BLOB_OFF_VERSION] = (uint8_t)(LUMEN_STATE_BLOB_VERSION & 0xFF);
    out[BLOB_OFF_VERSION + 1] = (uint8_t)(LUMEN_STATE_BLOB_VERSION >> 8);

    const lumen_state_t *s = &state->state;
    out[BLOB_OFF_POWER] = s->power;
    out[BLOB_OFF_BRIGHTNESS] = s->brightness;
    out[BLOB_OFF_R] = s->r;
    out[BLOB_OFF_R + 1] = s->g;
    out[BLOB_OFF_R + 2] = s->b;
    out[BLOB_OFF_LED_COUNT] = (uint8_t)(s->led_count & 0xFF);
    out[BLOB_OFF_LED_COUNT + 1] = (uint8_t)(s->led_count >> 8);
    out[BLOB_OFF_STRIP_COUNT] = s->strip_count;
    out[BLOB_OFF_STRIP_POWER_MASK] = s->strip_power_mask;
    out[LUMEN_SEG_COUNT_OFFSET] = s->seg_count;

    /* 每条灯带的灯珠数（#29）：strip 0 用 State 的权威值，其余用快照里的表。 */
    for (uint8_t i = 0; i < LUMEN_MAX_STRIPS; ++i) {
        uint16_t n = i == 0 ? s->led_count : state->strip_counts[i];
        out[LUMEN_STRIP_COUNTS_OFFSET + i * 2] = (uint8_t)(n & 0xFF);
        out[LUMEN_STRIP_COUNTS_OFFSET + i * 2 + 1] = (uint8_t)(n >> 8);
    }

    uint8_t *p = &out[LUMEN_SEGMENTS_OFFSET];
    for (uint8_t strip = 0; strip < LUMEN_MAX_STRIPS; ++strip) {
        for (uint8_t slot = 0; slot < LUMEN_MAX_SEGMENTS; ++slot) {
            encode_segment(&state->segments.slot[strip][slot], p);
            p += LUMEN_SEGMENT_RECORD_SIZE;
        }
    }
    return LUMEN_STATE_BLOB_SIZE;
}

/* 同灯带内活动段两两检查交集（闭区间）。 */
static bool segments_overlap(const lumen_segment_store_t *store, uint8_t strip)
{
    for (uint8_t a = 0; a < LUMEN_MAX_SEGMENTS; ++a) {
        const lumen_segment_t *sa = &store->slot[strip][a];
        if (!sa->active) {
            continue;
        }
        for (uint8_t b = (uint8_t)(a + 1u); b < LUMEN_MAX_SEGMENTS; ++b) {
            const lumen_segment_t *sb = &store->slot[strip][b];
            if (!sb->active) {
                continue;
            }
            if (!(sa->end < sb->start || sb->end < sa->start)) {
                return true;
            }
        }
    }
    return false;
}

bool lumen_state_blob_decode(const uint8_t *blob, size_t len, lumen_persist_t *out)
{
    if (blob == NULL || out == NULL || len != LUMEN_STATE_BLOB_SIZE) {
        return false;
    }
    if (memcmp(&blob[0], s_blob_magic, sizeof(s_blob_magic)) != 0) {
        return false;
    }
    uint16_t version =
        (uint16_t)blob[BLOB_OFF_VERSION] | ((uint16_t)blob[BLOB_OFF_VERSION + 1] << 8);
    if (version != LUMEN_STATE_BLOB_VERSION) {
        /*
         * 任何别的版本（含 v3 的 4）整体拒绝：记录宽度从 20 变成 22、每层多一个
         * level 字节，布局不兼容。绝不能「尽量解析」——错位的段表会写出越界区间。
         * 调用方因此回落到协议默认值（一次干净的重置，不是半套状态），这也正是
         * 「刷机后设备配置回到默认值」的实现来源。
         */
        return false;
    }

    uint16_t led_count =
        (uint16_t)blob[BLOB_OFF_LED_COUNT] | ((uint16_t)blob[BLOB_OFF_LED_COUNT + 1] << 8);
    uint8_t strip_count = blob[BLOB_OFF_STRIP_COUNT];
    if (blob[BLOB_OFF_POWER] > 1 || led_count < 1 || led_count > LUMEN_MAX_LEDS ||
        strip_count < 1 || strip_count > LUMEN_MAX_STRIPS) {
        return false;
    }
    uint8_t strip_power_mask = blob[BLOB_OFF_STRIP_POWER_MASK];
    /*
     * 未配置灯带（i >= strip_count）的掩码位在规格里没有语义，按原样保留、
     * 不做校验：拒绝它们只会让一份「关掉了不存在的灯带」的 blob 整份作废，
     * 而那份数据在渲染上完全无害（渲染只查已配置的条）。
     */

    lumen_persist_t decoded;
    memset(&decoded, 0, sizeof(decoded));
    decoded.state.power = blob[BLOB_OFF_POWER];
    decoded.state.brightness = blob[BLOB_OFF_BRIGHTNESS];
    decoded.state.r = blob[BLOB_OFF_R];
    decoded.state.g = blob[BLOB_OFF_R + 1];
    decoded.state.b = blob[BLOB_OFF_R + 2];
    decoded.state.led_count = led_count;
    decoded.state.strip_count = strip_count;
    decoded.state.seg_count = blob[LUMEN_SEG_COUNT_OFFSET];
    decoded.state.strip_power_mask = strip_power_mask;
    /* 剧本 / 播放相关字段不持久化（protocol §12）：上电从第一阶段、停止态开始。 */
    decoded.state.script_id = LUMEN_NO_SCRIPT;
    decoded.state.stage_index = 0;
    decoded.state.playback_state = 0;
    decoded.state.flags = 0;
    /* strip_anim_mask 是每帧重算的摘要，恒 0。 */
    decoded.state.strip_anim_mask = 0x00;

    /* 每条灯带的灯珠数（#29）。越界视为损坏，不「尽量解析」。 */
    for (uint8_t i = 0; i < LUMEN_MAX_STRIPS; ++i) {
        uint16_t n = (uint16_t)blob[LUMEN_STRIP_COUNTS_OFFSET + i * 2] |
                     ((uint16_t)blob[LUMEN_STRIP_COUNTS_OFFSET + i * 2 + 1] << 8);
        if (i < strip_count && (n < 1 || n > LUMEN_MAX_LEDS)) {
            return false;
        }
        decoded.strip_counts[i] = n;
    }
    /* strip 0 必须与 State 的 led_count 一致，否则是自相矛盾的 blob。 */
    if (decoded.strip_counts[0] != led_count) {
        return false;
    }

    const uint8_t *p = &blob[LUMEN_SEGMENTS_OFFSET];
    uint8_t active_counts[LUMEN_MAX_STRIPS] = {0};
    for (uint8_t strip = 0; strip < LUMEN_MAX_STRIPS; ++strip) {
        /*
         * 按**各自灯带**的灯珠数校验段区间：strip 3 只有 10 灯、strip 0 有 100 灯时，
         * 一份 [0-40] 打到 strip 3 的 blob 必须被拒，否则加载后渲染越界。
         */
        uint16_t strip_leds = decoded.strip_counts[strip];
        if (strip_leds == 0 || strip_leds > LUMEN_MAX_LEDS) {
            /* 未配置的条（i >= strip_count）在磁盘上是 0；用它只能兜底到上限，
             * 但下面 `strip >= strip_count` 已先拒掉所有落在其上的活动段。 */
            strip_leds = LUMEN_MAX_LEDS;
        }
        for (uint8_t slot = 0; slot < LUMEN_MAX_SEGMENTS; ++slot) {
            lumen_segment_t *seg = &decoded.segments.slot[strip][slot];
            decode_segment(p, seg);
            p += LUMEN_SEGMENT_RECORD_SIZE;

            if (!seg->active) {
                continue;
            }
            /*
             * 段表自洽性：§7.1 的形状规则（两层类型 / blend / 保留位 / 参数）
             * 与区间都必须是合法的。伪造 / 损坏即整体拒绝。
             */
            if (lumen_segment_validate_shape(seg) != LUMEN_RESULT_OK) {
                return false;
            }
            if (seg->start > seg->end || seg->end >= strip_leds) {
                return false;
            }
            if (strip >= strip_count) {
                return false;
            }
            ++active_counts[strip];
        }
        if (segments_overlap(&decoded.segments, strip)) {
            return false;
        }
    }

    /* seg_count 是 strip 0 的摘要：与段表不一致视为损坏，不「尽量解析」。 */
    if (decoded.state.seg_count != active_counts[0]) {
        return false;
    }

    *out = decoded;
    return true;
}
