#include "script_blob.h"

#include <string.h>

/*
 * 剧本 blob v3（docs/protocol-v4.md §10.3）：两层定宽段 + 变长记录。
 *
 * 段记录 = start(1) end(1) blend(1) layer0 layer1，其中每层是
 * type(1) + param_len(type) 字节 + level(1)（空层 0xFF 长度为 0，**连 level
 * 都不写**——空层 level 恒 0）。记录宽度因此由两层类型决定，见 script_blob.h
 * 的 LUMEN_SCRIPT_SEGMENT_MIN/MAX。
 */

size_t lumen_script_blob_encode(const lumen_script_store_t *store, uint8_t active_script_id,
                                bool loop, uint8_t *out, size_t out_cap)
{
    return lumen_script_blob_encode_with_override(store, 0, NULL, active_script_id, loop, out,
                                                  out_cap);
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

/* 某一层在 blob 里的参数个数（空层 0）。 */
static size_t layer_param_len(uint8_t type)
{
    if (type == LUMEN_LAYER_EMPTY) {
        return 0;
    }
    return lumen_effect_param_len(type);
}

/*
 * 某一层在 blob 里的完整宽度：空层只有 type 一个字节（level 恒 0，不写）；
 * 非空层是 type(1) + param_len + level(1)。
 */
static size_t layer_wire_len(uint8_t type)
{
    if (type == LUMEN_LAYER_EMPTY) {
        return 1;
    }
    return 1u + lumen_effect_param_len(type) + 1u;
}

/* 一条段记录的宽度。 */
static size_t segment_record_len(const lumen_segment_t *seg)
{
    return 3u + layer_wire_len(seg->layer[0].type) + layer_wire_len(seg->layer[1].type);
}

/* 写一层：type + 该类型的有效参数前缀 + level（其余 param 字节不持久化）。
 * 空层只写 type（0xFF）：level 恒 0，省略后记录更短，解码据此识别空层。 */
static void encode_layer(const lumen_effect_layer_t *layer, uint8_t *out)
{
    out[0] = layer->type;
    size_t n = layer_param_len(layer->type);
    for (size_t i = 0; i < n; ++i) {
        out[1 + i] = layer->param[i];
    }
    if (n != 0) {
        out[1 + n] = layer->level;
    }
}

/* 写一条段记录。t0_ms 不持久化（阶段相位在加载/切换时统一重置）。 */
static void encode_segment(const lumen_segment_t *seg, uint8_t *out)
{
    size_t pos = 0;
    out[pos++] = seg->start;
    out[pos++] = seg->end;
    out[pos++] = seg->blend;
    encode_layer(&seg->layer[0], &out[pos]);
    pos += layer_wire_len(seg->layer[0].type);
    encode_layer(&seg->layer[1], &out[pos]);
}

/*
 * 读一层：type + 参数 + level；未持久化的 param 尾部补 0（保留位必须为 0）。
 *
 * v4：空层只写 type（0xFF），**没有 level 字节**——空层的 level 恒 0，
 * 形状校验也要求它必须为 0，所以省略即可。非空层读完 param 后必须再读
 * 一个 level 字节，否则整份 blob 会错位。
 */
static bool decode_layer(reader_t *r, lumen_effect_layer_t *layer)
{
    uint8_t type = 0;
    if (!read_u8(r, &type)) {
        return false;
    }
    if (type != LUMEN_LAYER_EMPTY && !lumen_effect_type_known(type)) {
        return false; /* 未知 type：整份拒绝，不静默降级 */
    }
    memset(layer, 0, sizeof(*layer));
    layer->type = type;
    size_t n = layer_param_len(type);
    if (r->pos + n > r->len) {
        return false;
    }
    for (size_t i = 0; i < n; ++i) {
        layer->param[i] = r->data[r->pos++];
    }
    if (n != 0) {
        uint8_t level = 0;
        if (!read_u8(r, &level)) {
            return false;
        }
        layer->level = level;
    }
    return true;
}

size_t lumen_script_blob_encode_with_override(const lumen_script_store_t *store,
                                              uint8_t override_slot,
                                              const lumen_script_t *override_script,
                                              uint8_t active_script_id, bool loop, uint8_t *out,
                                              size_t out_cap)
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
        /*
         * 覆盖视图：`override_script` 非空且 id 命中时，把这个槽位当成它。
         * 用于 ScriptCommit 的尺寸预检——候选剧本还在 staging 里，不能为了
         * 试编码把 12.6KB 的结构体往栈上拷（NimBLE host 栈只有 4KB）。
         */
        const lumen_script_t *script =
            (override_script != NULL && id == override_slot) ? override_script
                                                             : lumen_script_get(store, id);
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
            if (pos + 4 > out_cap) {
                return 0;
            }
            out[pos++] = (uint8_t)(stage->duration_ms & 0xFF);
            out[pos++] = (uint8_t)(stage->duration_ms >> 8);
            out[pos++] = (uint8_t)(stage->fade_ms & 0xFF);
            out[pos++] = (uint8_t)(stage->fade_ms >> 8);

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
                    const lumen_segment_t *record = &stage->segments[strip][seg];
                    size_t width = segment_record_len(record);
                    if (pos + width > out_cap) {
                        return 0;
                    }
                    encode_segment(record, &out[pos]);
                    pos += width;
                }
            }
        }
    }
    return pos;
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

    /*
     * **就地解码**到调用方的 store，不建临时副本：一套剧本表 4 × 8 × 8 × 16
     * 约 41KB，放栈上会直接撑爆调用者（固件里是 app_main 的任务栈）。
     *
     * 因此失败时 *store 的内容未定义（可能是半套），调用方必须重新
     * lumen_script_store_init()。这条契约写进头文件；当前唯一调用方
     * （led_engine 上电加载）在失败分支里就是重新 init。
     */
    lumen_script_store_t *decoded = store;
    lumen_script_store_init(decoded);

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
        if (!lumen_script_begin(decoded, id, stage_count, strip_count)) {
            return false;
        }
        for (uint8_t st = 0; st < stage_count; ++st) {
            uint16_t duration = 0;
            uint16_t fade = 0;
            if (!read_u16(&r, &duration)) {
                return false;
            }
            if (!read_u16(&r, &fade)) {
                return false;
            }
            if (!lumen_script_stage(decoded, id, st, duration, fade)) {
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
                    lumen_segment_t segment;
                    memset(&segment, 0, sizeof(segment));
                    segment.active = true;
                    uint8_t start = 0;
                    uint8_t end = 0;
                    uint8_t blend = 0;
                    if (!read_u8(&r, &start) || !read_u8(&r, &end) || !read_u8(&r, &blend)) {
                        return false;
                    }
                    segment.start = start;
                    segment.end = end;
                    segment.blend = blend;
                    if (!decode_layer(&r, &segment.layer[0]) ||
                        !decode_layer(&r, &segment.layer[1])) {
                        return false;
                    }
                    if (!lumen_script_segment(decoded, id, st, strip, seg, &segment, NULL)) {
                        return false;
                    }
                }
            }
        }
        /* 整份校验复用 commit：越界 / 重叠 / flags / 周期都在这里一次判掉。 */
        if (lumen_script_commit(decoded, id, strip_counts, NULL, 0, NULL) !=
            LUMEN_SCRIPT_COMMIT_OK) {
            return false;
        }
    }

    /* 激活 id 必须指向已提交剧本，否则视为损坏（不「尽量解析」）。 */
    if (stored_active != LUMEN_NO_SCRIPT &&
        !lumen_script_is_committed(decoded, stored_active)) {
        return false;
    }

    if (active_script_id != NULL) {
        *active_script_id = stored_active;
    }
    if (loop != NULL) {
        *loop = (stored_flags & 0x01u) != 0;
    }
    return true;
}
