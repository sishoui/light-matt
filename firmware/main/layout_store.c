#include "layout_store.h"

#include <string.h>

#include "protocol.h"

static const uint8_t s_layout_magic[4] = {'L', 'M', 'L', '1'};

#define BLOB_OFF_VERSION 4
#define BLOB_OFF_STRIP_COUNT 5
#define BLOB_OFF_STRIPS 8
/* 每链记录 8 字节：led_count(1) | part_count(1) | phase(1) | reserved(5)。 */
#define BLOB_OFF_PARTS (BLOB_OFF_STRIPS + LUMEN_MAX_STRIPS * LUMEN_LAYOUT_STRIP_RECORD_BYTES)

/*
 * 每部位记录 42 字节：
 *   0        name_len
 *   1..24    name[24]
 *   25       seg_count
 *   26..41   segs[8] × (start, end)
 */
#define PART_OFF_NAME_LEN 0
#define PART_OFF_NAME 1
#define PART_OFF_SEG_COUNT (PART_OFF_NAME + LUMEN_NAME_BYTES)
#define PART_OFF_SEGS (PART_OFF_SEG_COUNT + 1)
#define PART_RECORD_BYTES 42

_Static_assert(PART_OFF_SEGS + LUMEN_MAX_PART_SEGS * 2 == PART_RECORD_BYTES,
               "layout part record arithmetic must match the contract");
_Static_assert(BLOB_OFF_PARTS + LUMEN_MAX_STRIPS * LUMEN_MAX_PARTS * PART_RECORD_BYTES ==
                   LUMEN_LAYOUT_BLOB_SIZE,
               "layout blob size must match docs/protocol-v5.md §10.3");

/* ---------------- 基础查询 ---------------- */

/* 段槽位是否已经写过（LayoutPart 之后、LayoutSeg 之前是「未写」）。 */
static bool seg_written(const lumen_part_segs_t *segs, uint8_t index)
{
    return segs->seg[index][0] != LUMEN_SEG_UNWRITTEN &&
           segs->seg[index][1] != LUMEN_SEG_UNWRITTEN;
}

/* 把一个部位的段槽位全部标成「未写」。 */
static void segs_mark_unwritten(lumen_part_segs_t *segs, uint8_t seg_count)
{
    memset(segs->seg, LUMEN_SEG_UNWRITTEN, sizeof(segs->seg));
    segs->seg_count = seg_count;
}

void lumen_layout_store_init(lumen_layout_store_t *layout)
{
    if (layout == NULL) {
        return;
    }
    memset(layout, 0, sizeof(*layout));
}

const lumen_part_layout_t *lumen_layout_store_part(const lumen_layout_store_t *layout,
                                                   uint8_t strip_id, uint8_t part_id)
{
    if (layout == NULL || strip_id >= LUMEN_MAX_STRIPS || part_id >= LUMEN_MAX_PARTS) {
        return NULL;
    }
    if (part_id >= layout->part_count[strip_id]) {
        return NULL;
    }
    return &layout->part[strip_id][part_id];
}

bool lumen_layout_store_has_segments(const lumen_layout_store_t *layout, uint8_t strip_id)
{
    if (layout == NULL || strip_id >= LUMEN_MAX_STRIPS) {
        return false;
    }
    for (uint8_t p = 0; p < layout->part_count[strip_id] && p < LUMEN_MAX_PARTS; ++p) {
        if (layout->part[strip_id][p].segs.seg_count > 0) {
            return true;
        }
    }
    return false;
}

uint8_t lumen_layout_part_of_pixel(const lumen_layout_store_t *layout, uint8_t strip_id,
                                   uint16_t index)
{
    if (layout == NULL || strip_id >= LUMEN_MAX_STRIPS) {
        return LUMEN_PART_NONE;
    }
    for (uint8_t p = 0; p < layout->part_count[strip_id] && p < LUMEN_MAX_PARTS; ++p) {
        const lumen_part_segs_t *segs = &layout->part[strip_id][p].segs;
        for (uint8_t s = 0; s < segs->seg_count && s < LUMEN_MAX_PART_SEGS; ++s) {
            if (!seg_written(segs, s)) {
                continue;
            }
            if (index >= segs->seg[s][0] && index <= segs->seg[s][1]) {
                return p;
            }
        }
    }
    return LUMEN_PART_NONE;
}

uint16_t lumen_layout_part_pixel_count(const lumen_part_layout_t *part)
{
    if (part == NULL) {
        return 0;
    }
    uint16_t n = 0;
    for (uint8_t s = 0; s < part->segs.seg_count && s < LUMEN_MAX_PART_SEGS; ++s) {
        if (!seg_written(&part->segs, s)) {
            continue;
        }
        n = (uint16_t)(n + (uint16_t)(part->segs.seg[s][1] - part->segs.seg[s][0]) + 1u);
    }
    return n;
}

uint16_t lumen_layout_logical_index(const lumen_part_layout_t *part, uint16_t index,
                                    lumen_phase_mode_t phase)
{
    if (part == NULL) {
        return 0;
    }
    /*
     * 段在写入时不一定按升序排列（LayoutSeg 逐条写），但「连续」相位要求
     * 逻辑顺序是**升序名次**。这里不排序（会改 RAM 且每次调用都排），而是
     * 直接数「比它小的灯珠有多少颗」：
     *   连续：统计所有段里严格小于 index 的灯珠数；
     *   各自起点：统计**同一段内**严格小于 index 的灯珠数。
     * 两者都天然对任意段顺序给出正确结果，且 O(段数)。
     */
    uint16_t offset = 0;
    for (uint8_t s = 0; s < part->segs.seg_count && s < LUMEN_MAX_PART_SEGS; ++s) {
        if (!seg_written(&part->segs, s)) {
            continue;
        }
        uint16_t start = part->segs.seg[s][0];
        uint16_t end = part->segs.seg[s][1];
        bool inside = index >= start && index <= end;
        if (phase == LUMEN_PHASE_CONTINUOUS) {
            if (start < index) {
                uint16_t upper = end < (uint16_t)(index - 1u) ? end : (uint16_t)(index - 1u);
                if (start <= upper) {
                    offset = (uint16_t)(offset + (upper - start + 1u));
                }
            }
        } else if (inside) {
            return (uint16_t)(index - start);
        }
    }
    if (phase == LUMEN_PHASE_CONTINUOUS) {
        /* index 不在本部位覆盖范围内时返回 0（调用方不该问）。 */
        for (uint8_t s = 0; s < part->segs.seg_count && s < LUMEN_MAX_PART_SEGS; ++s) {
            if (!seg_written(&part->segs, s)) {
                continue;
            }
            if (index >= part->segs.seg[s][0] && index <= part->segs.seg[s][1]) {
                return offset;
            }
        }
        return 0;
    }
    return 0;
}

/* ---------------- 写入 ---------------- */

uint8_t lumen_layout_store_write(lumen_layout_store_t *layout, uint8_t strip_id,
                                 uint8_t part_count, uint8_t strip_count)
{
    if (layout == NULL) {
        return LUMEN_RESULT_INVALID_PARAM;
    }
    if (strip_id >= LUMEN_MAX_STRIPS || strip_id >= strip_count || strip_count > LUMEN_MAX_STRIPS) {
        return LUMEN_RESULT_INVALID_PARAM;
    }
    if (part_count > LUMEN_MAX_PARTS) {
        return LUMEN_RESULT_INVALID_PARAM;
    }
    layout->part_count[strip_id] = part_count;
    /* 声明新数量即清空该链所有部位（§6.1 第 1 条：名字与段都清）。 */
    memset(layout->part[strip_id], 0, sizeof(layout->part[strip_id]));
    return LUMEN_RESULT_OK;
}

uint8_t lumen_layout_store_set_part(lumen_layout_store_t *layout, uint8_t strip_id,
                                    uint8_t part_id, uint8_t name_len, const uint8_t *name,
                                    uint8_t seg_count, uint8_t strip_count)
{
    if (layout == NULL) {
        return LUMEN_RESULT_INVALID_PARAM;
    }
    if (strip_id >= LUMEN_MAX_STRIPS || strip_id >= strip_count || strip_count > LUMEN_MAX_STRIPS) {
        return LUMEN_RESULT_INVALID_PARAM;
    }
    if (part_id >= LUMEN_MAX_PARTS || part_id >= layout->part_count[strip_id]) {
        return LUMEN_RESULT_INVALID_PARAM;
    }
    if (name_len > LUMEN_NAME_BYTES) {
        return LUMEN_RESULT_INVALID_PARAM;
    }
    if (seg_count > LUMEN_MAX_PART_SEGS) {
        return LUMEN_RESULT_INVALID_PARAM;
    }
    if (name_len > 0 && name == NULL) {
        return LUMEN_RESULT_INVALID_PARAM;
    }

    lumen_part_layout_t *part = &layout->part[strip_id][part_id];
    memset(part->name, 0, sizeof(part->name));
    if (name_len > 0) {
        memcpy(part->name, name, name_len);
    }
    part->name_len = name_len;
    /*
     * 写段数即清空旧段：新一次划分从空开始，避免旧段悄悄留下来。槽位标成
     * 「未写」而不是 0/0——分帧下发时后面的 LayoutSeg 还没到。
     */
    segs_mark_unwritten(&part->segs, seg_count);
    return LUMEN_RESULT_OK;
}

/* 段是否与同链其它部位的段相交（闭区间）。skip_part / skip_seg 用于排除自身。 */
static bool seg_conflicts(const lumen_layout_store_t *layout, uint8_t strip_id, uint8_t skip_part,
                         uint8_t skip_seg, uint8_t start, uint8_t end)
{
    for (uint8_t p = 0; p < layout->part_count[strip_id] && p < LUMEN_MAX_PARTS; ++p) {
        const lumen_part_segs_t *segs = &layout->part[strip_id][p].segs;
        for (uint8_t s = 0; s < segs->seg_count && s < LUMEN_MAX_PART_SEGS; ++s) {
            if (p == skip_part && s == skip_seg) {
                continue;
            }
            if (!seg_written(segs, s)) {
                continue;
            }
            uint8_t os = segs->seg[s][0];
            uint8_t oe = segs->seg[s][1];
            if (!(end < os || oe < start)) {
                return true;
            }
        }
    }
    return false;
}

uint8_t lumen_layout_store_set_seg(lumen_layout_store_t *layout, uint8_t strip_id,
                                   uint8_t part_id, uint8_t seg_id, uint8_t start, uint8_t end,
                                   uint16_t led_count, uint8_t strip_count)
{
    if (layout == NULL) {
        return LUMEN_RESULT_INVALID_PARAM;
    }
    if (strip_id >= LUMEN_MAX_STRIPS || strip_id >= strip_count || strip_count > LUMEN_MAX_STRIPS) {
        return LUMEN_RESULT_INVALID_PARAM;
    }
    if (part_id >= LUMEN_MAX_PARTS || part_id >= layout->part_count[strip_id]) {
        return LUMEN_RESULT_INVALID_PARAM;
    }
    lumen_part_layout_t *part = &layout->part[strip_id][part_id];
    if (seg_id >= LUMEN_MAX_PART_SEGS || seg_id >= part->segs.seg_count) {
        return LUMEN_RESULT_INVALID_PARAM;
    }
    if (start > end) {
        return LUMEN_RESULT_INVALID_PARAM;
    }
    if (led_count == 0 || end >= led_count) {
        return LUMEN_RESULT_INVALID_PARAM;
    }
    /* S3 / S4：一颗灯珠只属一个部位，压到别的部位就整体拒绝，不改任何字节。 */
    if (seg_conflicts(layout, strip_id, part_id, seg_id, start, end)) {
        return LUMEN_RESULT_INVALID_PARAM;
    }
    part->segs.seg[seg_id][0] = start;
    part->segs.seg[seg_id][1] = end;
    return LUMEN_RESULT_OK;
}

/* ---------------- 整份校验 ---------------- */

uint8_t lumen_layout_store_validate(const lumen_layout_store_t *layout, uint8_t strip_count,
                                    const uint16_t *strip_counts)
{
    if (layout == NULL) {
        return LUMEN_RESULT_INVALID_PARAM;
    }
    if (strip_count < 1 || strip_count > LUMEN_MAX_STRIPS) {
        return LUMEN_RESULT_INVALID_PARAM;
    }
    for (uint8_t strip = 0; strip < LUMEN_MAX_STRIPS; ++strip) {
        if (strip >= strip_count) {
            /* 未配置的链不得有内容，否则就是「半套布局」悄悄留着。 */
            if (layout->part_count[strip] != 0) {
                return LUMEN_RESULT_INVALID_PARAM;
            }
            continue;
        }
        uint8_t parts = layout->part_count[strip];
        if (parts > LUMEN_MAX_PARTS) {
            return LUMEN_RESULT_INVALID_PARAM;
        }
        uint16_t led_count = LUMEN_MAX_LEDS;
        if (strip_counts != NULL) {
            led_count = strip_counts[strip];
            if (led_count == 0 || led_count > LUMEN_MAX_LEDS) {
                return LUMEN_RESULT_INVALID_PARAM;
            }
        }
        for (uint8_t p = 0; p < parts; ++p) {
            const lumen_part_layout_t *part = &layout->part[strip][p];
            if (part->name_len > LUMEN_NAME_BYTES) {
                return LUMEN_RESULT_INVALID_PARAM;
            }
            uint8_t segs = part->segs.seg_count;
            if (segs > LUMEN_MAX_PART_SEGS) {
                return LUMEN_RESULT_INVALID_PARAM;
            }
            for (uint8_t s = 0; s < segs; ++s) {
                /*
                 * 声明了却不写 = 不完整的布局（LayoutPart 给了 seg_count 但
                 * 对应的 LayoutSeg 从没到）。LayoutCommit 必须整份拒绝。
                 */
                if (!seg_written(&part->segs, s)) {
                    return LUMEN_RESULT_INVALID_PARAM;
                }
                uint8_t start = part->segs.seg[s][0];
                uint8_t end = part->segs.seg[s][1];
                if (start > end || end >= led_count) {
                    return LUMEN_RESULT_INVALID_PARAM;
                }
                /* 与同链所有其它段（含自己部位的其它段）互斥。 */
                if (seg_conflicts(layout, strip, p, s, start, end)) {
                    return LUMEN_RESULT_INVALID_PARAM;
                }
            }
        }
    }
    return LUMEN_RESULT_OK;
}

/* ---------------- blob ---------------- */

size_t lumen_layout_blob_encode(const lumen_layout_store_t *layout, uint8_t strip_count,
                                const uint16_t *strip_counts, uint8_t *out, size_t out_cap)
{
    if (layout == NULL || out == NULL || out_cap < LUMEN_LAYOUT_BLOB_SIZE) {
        return 0;
    }
    if (strip_count < 1 || strip_count > LUMEN_MAX_STRIPS) {
        return 0;
    }
    memset(out, 0, LUMEN_LAYOUT_BLOB_SIZE);
    memcpy(&out[0], s_layout_magic, sizeof(s_layout_magic));
    out[BLOB_OFF_VERSION] = LUMEN_LAYOUT_BLOB_VERSION;
    out[BLOB_OFF_STRIP_COUNT] = strip_count;

    for (uint8_t strip = 0; strip < LUMEN_MAX_STRIPS; ++strip) {
        uint8_t *rec = &out[BLOB_OFF_STRIPS + strip * LUMEN_LAYOUT_STRIP_RECORD_BYTES];
        uint8_t parts = strip < strip_count ? layout->part_count[strip] : 0;
        /*
         * 每链记录：led_count | part_count | 保留 6 字节 = 0。
         * led_count 只是自校验用的冗余（State blob 才是权威）；没有表时写 0。
         * 保留字节按契约必须为 0——v5.0 不借它存相位模式（见 layout_store.h）。
         */
        rec[LUMEN_LAYOUT_STRIP_LED_COUNT_OFFSET] =
            (strip_counts != NULL && strip < LUMEN_MAX_STRIPS)
                ? (uint8_t)(strip_counts[strip] > 255 ? 255 : strip_counts[strip])
                : 0;
        rec[LUMEN_LAYOUT_STRIP_PART_COUNT_OFFSET] = parts;
    }

    uint8_t *p = &out[BLOB_OFF_PARTS];
    for (uint8_t strip = 0; strip < LUMEN_MAX_STRIPS; ++strip) {
        for (uint8_t part = 0; part < LUMEN_MAX_PARTS; ++part) {
            const lumen_part_layout_t *src = &layout->part[strip][part];
            bool live = strip < strip_count && part < layout->part_count[strip];
            p[PART_OFF_NAME_LEN] = live ? src->name_len : 0;
            if (live) {
                memcpy(&p[PART_OFF_NAME], src->name, LUMEN_NAME_BYTES);
                p[PART_OFF_SEG_COUNT] = src->segs.seg_count;
                for (uint8_t s = 0; s < src->segs.seg_count && s < LUMEN_MAX_PART_SEGS; ++s) {
                    /* 未写的段按 0/0 落盘（0/0 是合法段，见 §10.3）。 */
                    uint8_t start = seg_written(&src->segs, s) ? src->segs.seg[s][0] : 0;
                    uint8_t end = seg_written(&src->segs, s) ? src->segs.seg[s][1] : 0;
                    p[PART_OFF_SEGS + s * 2] = start;
                    p[PART_OFF_SEGS + s * 2 + 1] = end;
                }
            }
            p += PART_RECORD_BYTES;
        }
    }
    return LUMEN_LAYOUT_BLOB_SIZE;
}

bool lumen_layout_blob_decode(const uint8_t *blob, size_t len, uint8_t *out_strip_count,
                              lumen_layout_store_t *out)
{
    if (blob == NULL || out == NULL || out_strip_count == NULL) {
        return false;
    }
    if (len != LUMEN_LAYOUT_BLOB_SIZE) {
        return false;
    }
    if (memcmp(&blob[0], s_layout_magic, sizeof(s_layout_magic)) != 0) {
        return false;
    }
    if (blob[BLOB_OFF_VERSION] != LUMEN_LAYOUT_BLOB_VERSION) {
        return false;
    }
    uint8_t strip_count = blob[BLOB_OFF_STRIP_COUNT];
    if (strip_count < 1 || strip_count > LUMEN_MAX_STRIPS) {
        return false;
    }

    /*
     * **必须静态**：lumen_layout_store_t 是 2696 字节，本函数经
     * lumen_state_store_load_layout 跑在 app_main 任务的 3584 字节栈上。
     * 与 scene_store.c 的同类修复同一个理由，见那里的注释。
     */
    static lumen_layout_store_t decoded;
    memset(&decoded, 0, sizeof(decoded));
    uint16_t counts[LUMEN_MAX_STRIPS];
    memset(counts, 0, sizeof(counts));

    for (uint8_t strip = 0; strip < LUMEN_MAX_STRIPS; ++strip) {
        const uint8_t *rec = &blob[BLOB_OFF_STRIPS + strip * LUMEN_LAYOUT_STRIP_RECORD_BYTES];
        uint8_t parts = rec[LUMEN_LAYOUT_STRIP_PART_COUNT_OFFSET];
        if (parts > LUMEN_MAX_PARTS) {
            return false;
        }
        if (strip >= strip_count && parts != 0) {
            return false;
        }
        /* 保留字节必须为 0（v5.0 不借它存相位模式）。 */
        for (uint8_t i = LUMEN_LAYOUT_STRIP_PART_COUNT_OFFSET + 1;
             i < LUMEN_LAYOUT_STRIP_RECORD_BYTES; ++i) {
            if (rec[i] != 0) {
                return false;
            }
        }
        decoded.part_count[strip] = strip < strip_count ? parts : 0;
        /*
         * led_count 是 1 字节冗余：0 表示「本 blob 没写」。非 0 才是 1..255，
         * 而协议上限是 100，所以 > 100 只能是坏 blob。
         */
        uint8_t led = rec[LUMEN_LAYOUT_STRIP_LED_COUNT_OFFSET];
        if (strip < strip_count && led > LUMEN_MAX_LEDS) {
            return false;
        }
        counts[strip] = led;
    }

    const uint8_t *p = &blob[BLOB_OFF_PARTS];
    for (uint8_t strip = 0; strip < LUMEN_MAX_STRIPS; ++strip) {
        for (uint8_t part = 0; part < LUMEN_MAX_PARTS; ++part) {
            uint8_t name_len = p[PART_OFF_NAME_LEN];
            uint8_t seg_count = p[PART_OFF_SEG_COUNT];
            if (name_len > LUMEN_NAME_BYTES || seg_count > LUMEN_MAX_PART_SEGS) {
                return false;
            }
            /* 未使用的部位槽位必须全 0，否则是坏 blob（半套写入）。 */
            if (part >= decoded.part_count[strip]) {
                if (name_len != 0 || seg_count != 0) {
                    return false;
                }
            } else {
                lumen_part_layout_t *dst = &decoded.part[strip][part];
                dst->name_len = name_len;
                memcpy(dst->name, &p[PART_OFF_NAME], LUMEN_NAME_BYTES);
                /* name_len 之后必须全是 NUL（解码端只信任 name_len，但坏 blob 要拒）。 */
                for (uint8_t i = name_len; i < LUMEN_NAME_BYTES; ++i) {
                    if (dst->name[i] != 0) {
                        return false;
                    }
                }
                dst->segs.seg_count = seg_count;
                for (uint8_t s = 0; s < seg_count; ++s) {
                    dst->segs.seg[s][0] = p[PART_OFF_SEGS + s * 2];
                    dst->segs.seg[s][1] = p[PART_OFF_SEGS + s * 2 + 1];
                }
            }
            p += PART_RECORD_BYTES;
        }
    }

    /*
     * 整份校验（段互斥、start ≤ end、end < 灯珠数）。blob 可能不带 led_count
     * （为 0），那样只能按协议上限校验；调用方拿到之后应用 State 的权威值再
     * 跑一次 lumen_layout_store_validate。
     */
    const uint16_t *counts_or_null = NULL;
    bool any_count = false;
    for (uint8_t i = 0; i < strip_count; ++i) {
        if (counts[i] != 0) {
            any_count = true;
        }
    }
    if (any_count) {
        /* 缺灯的链按协议上限补齐，避免把合法布局误判成越界。 */
        for (uint8_t i = 0; i < LUMEN_MAX_STRIPS; ++i) {
            if (counts[i] == 0) {
                counts[i] = LUMEN_MAX_LEDS;
            }
        }
        counts_or_null = counts;
    }
    if (lumen_layout_store_validate(&decoded, strip_count, counts_or_null) != LUMEN_RESULT_OK) {
        return false;
    }

    /* 只有全部通过才写 out：绝不半套加载。 */
    *out = decoded;
    *out_strip_count = strip_count;
    return true;
}

void lumen_layout_blob_strip_counts(const uint8_t *blob, size_t len, uint16_t *out_counts)
{
    if (blob == NULL || out_counts == NULL || len != LUMEN_LAYOUT_BLOB_SIZE) {
        return;
    }
    for (uint8_t strip = 0; strip < LUMEN_MAX_STRIPS; ++strip) {
        out_counts[strip] =
            blob[BLOB_OFF_STRIPS + strip * LUMEN_LAYOUT_STRIP_RECORD_BYTES +
                 LUMEN_LAYOUT_STRIP_LED_COUNT_OFFSET];
    }
}
