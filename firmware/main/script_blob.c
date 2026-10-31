#include "script_blob.h"

#include <string.h>

/*
 * 剧本 blob 仍停留在 v1 的**单层**记录（docs/protocol-v3.md §10.3 的 v2 是 #39）。
 *
 * #37 的段结构已经是两层，但 blob 格式的升级（LMS3 / version 2 / 变长记录 /
 * 容量 16384）属于 #39。为了让本票不产生数据损坏，这里的策略是**显式降级**：
 *   - 写：只持久化 layer[0] 与段几何；layer[1] 与 blend **不写**（记录形状不变，
 *     仍是 10 字节，旧固件也能读）；
 *   - 读：layer[1] 置为空层、blend 置 0——即「单层段」。
 * 也就是说：两层剧本在掉电重启后会退回单层（layer0 保留），不会写出一个
 * 自相矛盾或越界的 blob，也不会把 layer1 的字节当成 layer0 的参数。
 *
 * **#39 必须把这里换成双层变长记录**，否则用户的两层剧本重启即丢失上层。
 */
/* 写一个段记录（10 字节）：start, end, type, layer0.param[0..6]。t0_ms 不持久化。 */
static void encode_segment(const lumen_segment_t *seg, uint8_t *out)
{
    const uint8_t *param = seg->layer[0].param;
    out[0] = seg->start;
    out[1] = seg->end;
    out[2] = seg->layer[0].type;
    out[3] = param[0];
    out[4] = param[1];
    out[5] = param[2];
    out[6] = param[3];
    out[7] = param[4];
    out[8] = param[5];
    out[9] = param[6];
}

static void decode_segment(const uint8_t *in, lumen_segment_t *seg)
{
    memset(seg, 0, sizeof(*seg));
    seg->active = true;
    seg->start = in[0];
    seg->end = in[1];
    seg->layer[0].type = in[2];
    for (size_t i = 0; i < sizeof(seg->layer[0].param); ++i) {
        seg->layer[0].param[i] = in[3 + i];
    }
    /* #39：layer1 / blend 尚未持久化，读出即单层段（见文件头的降级说明）。 */
    seg->layer[1].type = LUMEN_LAYER_EMPTY;
    seg->blend = 0;
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
            if (!read_u16(&r, &duration)) {
                return false;
            }
            if (!lumen_script_stage(decoded, id, st, duration)) {
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
                    if (!lumen_script_segment(decoded, id, st, strip, seg, &segment, NULL)) {
                        return false;
                    }
                }
            }
        }
        /* 整份校验复用 commit：越界 / 重叠 / flags / 周期都在这里一次判掉。 */
        if (!lumen_script_commit(decoded, id, strip_counts)) {
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
