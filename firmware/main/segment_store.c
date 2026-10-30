#include "segment_store.h"

#include <stddef.h>
#include <string.h>

/*
 * 段配置存储与合成。
 *
 * 重叠判定（docs/protocol.md §10.3 / 21-design.md §5）：**拒绝**，不是覆盖。
 * 设备持有全部 8 段，全局校验是可行的；同 seg_id 的重写视为「替换自身」，
 * 不与自己的旧区间冲突（否则改颜色会被自己的旧区间拒掉）。
 */

void lumen_segment_store_init(lumen_segment_store_t *store)
{
    if (store == NULL) {
        return;
    }
    memset(store, 0, sizeof(*store));
}

void lumen_segment_store_reset_strip(lumen_segment_store_t *store, uint8_t strip_id)
{
    if (store == NULL || strip_id >= LUMEN_MAX_STRIPS) {
        return;
    }
    memset(store->slot[strip_id], 0, sizeof(store->slot[strip_id]));
}

/*
 * 检查候选段与同灯带其它活动段的交集。
 * skip_seg 是被替换的槽位（替换自身不算冲突）。
 */
static bool overlaps_others(const lumen_segment_store_t *store, uint8_t strip_id, uint8_t skip_seg,
                            uint8_t start, uint8_t end)
{
    for (uint8_t i = 0; i < LUMEN_MAX_SEGMENTS; ++i) {
        if (i == skip_seg) {
            continue;
        }
        const lumen_segment_t *other = &store->slot[strip_id][i];
        if (!other->active) {
            continue;
        }
        /* 闭区间有交集：!(a.end < b.start || b.end < a.start)。 */
        if (!(end < other->start || other->end < start)) {
            return true;
        }
    }
    return false;
}

uint8_t lumen_segment_store_validate_single(uint8_t strip_id, uint8_t strip_count,
                                            uint8_t led_count, const lumen_segment_t *candidate)
{
    if (candidate == NULL) {
        return LUMEN_RESULT_INVALID_PARAM;
    }

    /* 5 strip_id 范围。 */
    if (strip_count == 0 || strip_count > LUMEN_MAX_STRIPS || strip_id >= strip_count) {
        return LUMEN_RESULT_INVALID_PARAM;
    }

    /* 6 段区间。 */
    if (led_count == 0 || led_count > LUMEN_MAX_LEDS) {
        return LUMEN_RESULT_INVALID_PARAM;
    }
    if (candidate->start > candidate->end || candidate->end >= led_count) {
        return LUMEN_RESULT_INVALID_PARAM;
    }

    /* 8 flags 保留位 / 9 周期下限（与整表版本共用同一段规则）。 */
    if (candidate->type == LUMEN_EFFECT_STATIC) {
        if (candidate->flags != 0) {
            return LUMEN_RESULT_INVALID_PARAM;
        }
    } else if (!lumen_effect_type_implemented(candidate->type)) {
        return LUMEN_RESULT_INVALID_PARAM;
    } else if (candidate->type == LUMEN_EFFECT_BREATHING) {
        if ((candidate->flags & 0xF8u) != 0) {
            return LUMEN_RESULT_INVALID_PARAM;
        }
        if (candidate->period_ms != 0 && candidate->period_ms < LUMEN_BREATHING_MIN_PERIOD_MS) {
            return LUMEN_RESULT_INVALID_PARAM;
        }
    } else {
        if ((candidate->flags & 0xFEu) != 0) {
            return LUMEN_RESULT_INVALID_PARAM;
        }
        if (candidate->period_ms != 0 && candidate->period_ms < LUMEN_RAINBOW_MIN_PERIOD_MS) {
            return LUMEN_RESULT_INVALID_PARAM;
        }
    }
    return LUMEN_RESULT_OK;
}

uint8_t lumen_segment_store_validate(const lumen_segment_store_t *store, uint8_t strip_id,
                                     uint8_t strip_count, uint8_t seg_id, uint8_t led_count,
                                     const lumen_segment_t *candidate)
{
    if (store == NULL || candidate == NULL) {
        return LUMEN_RESULT_INVALID_PARAM;
    }

    /*
     * 5 strip_id 范围：0 ≤ strip_id < strip_count。
     * 多灯带（#29）之前 strip_count 恒为 1，所以传 1 也是 InvalidParam。
     */
    if (strip_count == 0 || strip_count > LUMEN_MAX_STRIPS || strip_id >= strip_count) {
        return LUMEN_RESULT_INVALID_PARAM;
    }

    /* 6 段区间：start <= end 且 end < led_count（led_count 至少为 1）。 */
    if (led_count == 0 || led_count > LUMEN_MAX_LEDS) {
        return LUMEN_RESULT_INVALID_PARAM;
    }
    if (candidate->start > candidate->end || candidate->end >= led_count) {
        return LUMEN_RESULT_INVALID_PARAM;
    }

    /* 7 段重叠：与同 strip 的其它活动段无交集。 */
    if (overlaps_others(store, strip_id, seg_id, candidate->start, candidate->end)) {
        return LUMEN_RESULT_INVALID_PARAM;
    }

    /*
     * 8 flags 保留位 / 9 周期下限（docs/protocol.md §11.3 第 8/9 步）。
     *
     * 静态段没有周期字段，flags 必须为 0（effects-spec §2.1：静态无 flags）。
     * 动画类型的保留位与周期下限按类型分别判定。
     */
    if (candidate->type == LUMEN_EFFECT_STATIC) {
        if (candidate->flags != 0) {
            return LUMEN_RESULT_INVALID_PARAM;
        }
    } else if (!lumen_effect_type_implemented(candidate->type)) {
        /*
         * 动画类型尚未实现。命令层会把这种情况判成 UnknownCommand；
         * 这里再拒一次是防御，避免绕过命令层直接写段（host 测试 / 未来剧本）。
         */
        return LUMEN_RESULT_INVALID_PARAM;
    } else if (candidate->type == LUMEN_EFFECT_BREATHING) {
        /*
         * 呼吸（effects-spec §2.2 / §5 第 8-9 步）：
         *   bit0 reverse（保留，无实际意义）、bit1-2 waveform、bit3-7 必须为 0；
         *   period_ms != 0 时必须 ≥ 334（≈3Hz，光敏性癫痫安全线）。
         * period_ms = 0 是合法值（静止），不受下限约束。
         */
        if ((candidate->flags & 0xF8u) != 0) {
            return LUMEN_RESULT_INVALID_PARAM;
        }
        if (candidate->period_ms != 0 && candidate->period_ms < LUMEN_BREATHING_MIN_PERIOD_MS) {
            return LUMEN_RESULT_INVALID_PARAM;
        }
    } else {
        /*
         * 彩虹 / 流光（effects-spec §2.3-§2.4 / §11.3 第 8-9 步）：
         *   bit0 reverse（有实际意义）、**bit1-7 必须为 0**——
         *   注意比呼吸更严：呼吸把 bit1-2 用作 waveform，这里没有位可借；
         *   period_ms != 0 时必须 ≥ 200（5Hz）。这两类是空间移动不是亮度闪烁，
         *   所以下限比呼吸宽松（D5）。
         */
        if ((candidate->flags & 0xFEu) != 0) {
            return LUMEN_RESULT_INVALID_PARAM;
        }
        if (candidate->period_ms != 0 && candidate->period_ms < LUMEN_RAINBOW_MIN_PERIOD_MS) {
            return LUMEN_RESULT_INVALID_PARAM;
        }
    }

    return LUMEN_RESULT_OK;
}

uint8_t lumen_segment_store_set(lumen_segment_store_t *store, uint8_t strip_id,
                                uint8_t strip_count, uint8_t seg_id, uint8_t led_count,
                                const lumen_segment_t *candidate)
{
    if (store == NULL || seg_id >= LUMEN_MAX_SEGMENTS) {
        return LUMEN_RESULT_INVALID_PARAM;
    }
    uint8_t result =
        lumen_segment_store_validate(store, strip_id, strip_count, seg_id, led_count, candidate);
    if (result != LUMEN_RESULT_OK) {
        return result;
    }
    /* 校验全部通过后才写槽位：失败时旧配置完全不动。 */
    store->slot[strip_id][seg_id] = *candidate;
    store->slot[strip_id][seg_id].active = true;
    return LUMEN_RESULT_OK;
}

bool lumen_segment_store_clear(lumen_segment_store_t *store, uint8_t strip_id, uint8_t seg_id)
{
    if (store == NULL || strip_id >= LUMEN_MAX_STRIPS || seg_id >= LUMEN_MAX_SEGMENTS) {
        return false;
    }
    bool was_active = store->slot[strip_id][seg_id].active;
    memset(&store->slot[strip_id][seg_id], 0, sizeof(store->slot[strip_id][seg_id]));
    return was_active;
}

const lumen_segment_t *lumen_segment_store_get(const lumen_segment_store_t *store,
                                               uint8_t strip_id, uint8_t seg_id)
{
    if (store == NULL || strip_id >= LUMEN_MAX_STRIPS || seg_id >= LUMEN_MAX_SEGMENTS) {
        return NULL;
    }
    return &store->slot[strip_id][seg_id];
}

uint8_t lumen_segment_store_count(const lumen_segment_store_t *store, uint8_t strip_id)
{
    if (store == NULL || strip_id >= LUMEN_MAX_STRIPS) {
        return 0;
    }
    uint8_t count = 0;
    for (uint8_t i = 0; i < LUMEN_MAX_SEGMENTS; ++i) {
        if (store->slot[strip_id][i].active) {
            ++count;
        }
    }
    return count;
}

uint8_t lumen_segment_store_mask(const lumen_segment_store_t *store, uint8_t strip_id)
{
    if (store == NULL || strip_id >= LUMEN_MAX_STRIPS) {
        return 0;
    }
    uint8_t mask = 0;
    for (uint8_t i = 0; i < LUMEN_MAX_SEGMENTS; ++i) {
        if (store->slot[strip_id][i].active) {
            mask |= (uint8_t)(1u << i);
        }
    }
    return mask;
}

bool lumen_segment_store_any_active(const lumen_segment_store_t *store, uint8_t strip_id)
{
    return lumen_segment_store_count(store, strip_id) > 0;
}

bool lumen_segment_store_needs_frames(const lumen_segment_store_t *store, uint8_t strip_count)
{
    if (store == NULL) {
        return false;
    }
    if (strip_count == 0 || strip_count > LUMEN_MAX_STRIPS) {
        strip_count = LUMEN_MAX_STRIPS;
    }
    for (uint8_t strip = 0; strip < strip_count; ++strip) {
        for (uint8_t slot = 0; slot < LUMEN_MAX_SEGMENTS; ++slot) {
            const lumen_segment_t *seg = &store->slot[strip][slot];
            if (seg->active && lumen_effect_is_animated(seg->type)) {
                return true;
            }
        }
    }
    return false;
}

void lumen_segment_store_state_rgb(const lumen_segment_store_t *store, uint8_t strip_id,
                                   uint8_t out_rgb[3])
{
    if (out_rgb == NULL) {
        return;
    }
    out_rgb[0] = 0;
    out_rgb[1] = 0;
    out_rgb[2] = 0;
    if (store == NULL || strip_id >= LUMEN_MAX_STRIPS) {
        return;
    }
    /*
     * docs/protocol.md §7：State 字节 2-4 是 **strip 0 / seg 0 的基准色**，
     * 由 seg 0 的 hue+sat 算出（静态段即其像素色），**不含动画包络**；
     * seg 0 不存在时为 0。动画类型也能算出基准色（四种都有 hue+sat 前缀）。
     */
    const lumen_segment_t *seg = &store->slot[strip_id][0];
    if (!seg->active) {
        return;
    }
    lumen_effect_static_rgb(seg->hue, seg->sat, out_rgb);
}

uint16_t lumen_segment_store_compose(const lumen_segment_store_t *store, uint8_t strip_id,
                                     uint8_t *buf, uint16_t led_count, uint32_t now_ms)
{
    if (store == NULL || buf == NULL || led_count == 0 || led_count > LUMEN_MAX_LEDS ||
        strip_id >= LUMEN_MAX_STRIPS) {
        return 0;
    }

    /*
     * ① 未覆盖区必须先清零（docs/v2-effects-engine.md §4.2）。
     * WS2812B 会锁存最后一帧：不主动写 0，gap 里的灯珠就一直停在旧颜色上。
     * 这是 #25 的验收点「[0-15] 与 [40-63] 之间 16-39 确实熄灭」的实现前提。
     */
    memset(buf, 0, (size_t)led_count * 3u);

    for (uint8_t s = 0; s < LUMEN_MAX_SEGMENTS; ++s) {
        const lumen_segment_t *seg = &store->slot[strip_id][s];
        if (!seg->active) {
            continue;
        }
        for (uint16_t i = seg->start; i <= seg->end && i < led_count; ++i) {
            uint8_t rgb[3];
            lumen_effect_pixel(seg, i, now_ms, rgb);
            /* ② 用户空间 RGB 直接写进缓冲；gamma + 亮度由渲染层统一施加。 */
            buf[i * 3u + 0] = rgb[0];
            buf[i * 3u + 1] = rgb[1];
            buf[i * 3u + 2] = rgb[2];
        }
    }
    return led_count;
}

uint8_t lumen_segment_store_prune(lumen_segment_store_t *store, uint8_t strip_id,
                                  uint16_t new_count)
{
    if (store == NULL || strip_id >= LUMEN_MAX_STRIPS) {
        return 0;
    }
    uint8_t pruned = 0;
    for (uint8_t i = 0; i < LUMEN_MAX_SEGMENTS; ++i) {
        lumen_segment_t *seg = &store->slot[strip_id][i];
        if (!seg->active) {
            continue;
        }
        /* 不自动缩短区间：自动改用户边界比丢弃更意外（§7.2 第 3 条）。 */
        if (seg->end >= new_count) {
            memset(seg, 0, sizeof(*seg));
            ++pruned;
        }
    }
    return pruned;
}
