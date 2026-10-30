#include "script_blob.h"

#include <string.h>

/* 写一个段记录（10 字节）。t0_ms 不持久化。 */
static void encode_segment(const lumen_segment_t *seg, uint8_t *out)
{
    out[0] = seg->start;
    out[1] = seg->end;
    out[2] = seg->type;
    out[3] = (uint8_t)(seg->hue & 0xFF);
    out[4] = (uint8_t)(seg->hue >> 8);
    out[5] = seg->sat;
    out[6] = (uint8_t)(seg->period_ms & 0xFF);
    out[7] = (uint8_t)(seg->period_ms >> 8);
    out[8] = seg->p5;
    out[9] = seg->flags;
}

static void decode_segment(const uint8_t *in, lumen_segment_t *seg)
{
    memset(seg, 0, sizeof(*seg));
    seg->active = true;
    seg->start = in[0];
    seg->end = in[1];
    seg->type = in[2];
    seg->hue = (uint16_t)(in[3] | ((uint16_t)in[4] << 8));
    seg->sat = in[5];
    seg->period_ms = (uint16_t)(in[6] | ((uint16_t)in[7] << 8));
    seg->p5 = in[8];
    seg->flags = in[9];
    /* t0_ms 不持久化：阶段相位在切换/加载时由引擎统一重置。 */
    seg->t0_ms = 0;
}

size_t lumen_script_blob_encode(const lumen_script_store_t *store, uint8_t active_script_id,
                                bool loop, uint8_t *out, size_t out_cap)
{
    if (store == NULL || out == NULL || out_cap < 8) {
        return 0;
    }

    size_t pos = 0;
    memcpy(&out[pos], LUMEN_SCRIPT_BLOB_MAGIC, 4);
    pos += 4;
    out[pos++] = (uint8_t)(LUMEN_SCRIPT_BLOB_VERSION & 0xFF);
    out[pos++] = (uint8_t)(LUMEN_SCRIPT_BLOB_VERSION >> 8);
    out[pos++] = active_script_id;
    out[pos++] = loop ? 0x01 : 0x00;

    for (uint8_t id = 0; id < LUMEN_MAX_SCRIPTS; ++id) {
        const lumen_script_t *script = lumen_script_get(store, id);
        if (script == NULL) {
            /* 未提交的槽位用 committed = 0 占位，保持 4 个槽位的顺序。 */
            if (pos + 1 > out_cap) {
                return 0;
            }
            out[pos++] = 0;
            continue;
        }
        if (pos + 3 > out_cap) {
            return 0;
        }
        out[pos++] = 1;
        out[pos++] = script->stage_count;
        out[pos++] = script->strip_count;

        for (uint8_t st = 0; st < script->stage_count; ++st) {
            const lumen_script_stage_t *stage = &script->stages[st];
            if (pos + 2 > out_cap) {
                return 0;
            }
            out[pos++] = (uint8_t)(stage->duration_ms & 0xFF);
            out[pos++] = (uint8_t)(stage->duration_ms >> 8);

            for (uint8_t strip = 0; strip < script->strip_count; ++strip) {
                if (pos + 1 > out_cap) {
                    return 0;
                }
                uint8_t mask = 0;
                for (uint8_t seg = 0; seg < LUMEN_MAX_SEGMENTS; ++seg) {
                    if (stage->segments[strip][seg].active) {
                        mask |= (uint8_t)(1u << seg);
                    }
                }
                out[pos++] = mask;
                for (uint8_t seg = 0; seg < LUMEN_MAX_SEGMENTS; ++seg) {
                    if ((mask & (uint8_t)(1u << seg)) == 0) {
                        continue;
                    }
                    if (pos + LUMEN_SCRIPT_SEGMENT_SIZE > out_cap) {
                        return 0;
                    }
                    encode_segment(&stage->segments[strip][seg], &out[pos]);
                    pos += LUMEN_SCRIPT_SEGMENT_SIZE;
                }
            }
        }
    }
    return pos;
}

/* 有界读指针。 */
typedef struct {
    const uint8_t *data;
    size_t len;
    size_t pos;
} reader_t;

static bool read_u8(reader_t *r, uint8_t *out)
{
    if (r->pos + 1 > r->len) {
        return false;
    }
    *out = r->data[r->pos++];
    return true;
}

static bool read_u16(reader_t *r, uint16_t *out)
{
    if (r->pos + 2 > r->len) {
        return false;
    }
    *out = (uint16_t)(r->data[r->pos] | ((uint16_t)r->data[r->pos + 1] << 8));
    r->pos += 2;
    return true;
}

bool lumen_script_blob_decode(const uint8_t *blob, size_t len,
                              const uint16_t strip_counts[LUMEN_MAX_STRIPS],
                              lumen_script_store_t *store, uint8_t *active_script_id,
                              bool *loop)
{
    if (blob == NULL || store == NULL || len < 8) {
        return false;
    }
    if (memcmp(&blob[0], LUMEN_SCRIPT_BLOB_MAGIC, 4) != 0) {
        return false;
    }
    uint16_t version = (uint16_t)(blob[4] | ((uint16_t)blob[5] << 8));
    if (version != LUMEN_SCRIPT_BLOB_VERSION) {
        return false;
    }
    uint8_t stored_active = blob[6];
    uint8_t stored_flags = blob[7];
    if ((stored_flags & 0xFEu) != 0) {
        /* bit1-7 保留必须为 0（与 State 字节 13 同一约定）。 */
        return false;
    }
    if (stored_active != LUMEN_NO_SCRIPT && stored_active >= LUMEN_MAX_SCRIPTS) {
        return false;
    }

    reader_t r = {.data = blob, .len = len, .pos = 8};

    /* 在一份临时 store 上解码，全部成功才交给调用方（整份原子）。 */
    lumen_script_store_t decoded;
    lumen_script_store_init(&decoded);

    for (uint8_t id = 0; id < LUMEN_MAX_SCRIPTS; ++id) {
        uint8_t committed = 0;
        if (!read_u8(&r, &committed)) {
            return false;
        }
        if (committed == 0) {
            continue;
        }
        if (committed != 1) {
            return false;
        }
        uint8_t stage_count = 0;
        uint8_t strip_count = 0;
        if (!read_u8(&r, &stage_count) || !read_u8(&r, &strip_count)) {
            return false;
        }
        if (stage_count < 1 || stage_count > LUMEN_MAX_STAGES) {
            return false;
        }
        if (strip_count < 1 || strip_count > LUMEN_MAX_STRIPS) {
            return false;
        }
        if (!lumen_script_begin(&decoded, id, stage_count, strip_count)) {
            return false;
        }
        for (uint8_t st = 0; st < stage_count; ++st) {
            uint16_t duration = 0;
            if (!read_u16(&r, &duration)) {
                return false;
            }
            if (!lumen_script_stage(&decoded, id, st, duration)) {
                return false;
            }
            for (uint8_t strip = 0; strip < strip_count; ++strip) {
                uint8_t mask = 0;
                if (!read_u8(&r, &mask)) {
                    return false;
                }
                for (uint8_t seg = 0; seg < LUMEN_MAX_SEGMENTS; ++seg) {
                    if ((mask & (uint8_t)(1u << seg)) == 0) {
                        continue;
                    }
                    if (r.pos + LUMEN_SCRIPT_SEGMENT_SIZE > r.len) {
                        return false;
                    }
                    lumen_segment_t segment;
                    decode_segment(&r.data[r.pos], &segment);
                    r.pos += LUMEN_SCRIPT_SEGMENT_SIZE;
                    if (!lumen_script_segment(&decoded, id, st, strip, seg, &segment, NULL)) {
                        return false;
                    }
                }
            }
        }
        /* 整份校验复用 commit：越界 / 重叠 / flags / 周期都在这里一次判掉。 */
        if (!lumen_script_commit(&decoded, id, strip_counts)) {
            return false;
        }
    }

    /* 激活 id 必须指向已提交剧本，否则视为损坏（不「尽量解析」）。 */
    if (stored_active != LUMEN_NO_SCRIPT &&
        !lumen_script_is_committed(&decoded, stored_active)) {
        return false;
    }

    *store = decoded;
    if (active_script_id != NULL) {
        *active_script_id = stored_active;
    }
    if (loop != NULL) {
        *loop = (stored_flags & 0x01u) != 0;
    }
    return true;
}
