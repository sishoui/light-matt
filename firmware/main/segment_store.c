#include "segment_store.h"

#include <stddef.h>
#include <string.h>

/*
 * 段配置存储与合成。
 *
 * 重叠判定（docs/protocol-v4.md §10.3 / 21-design.md §5）：**拒绝**，不是覆盖。
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

uint8_t lumen_segment_store_validate_params(uint8_t type, uint8_t flags, uint16_t period_ms)
{
    if (!lumen_effect_type_implemented(type)) {
        /* 未知类型 / 未实现类型 / 空层：不静默降级（D7）。 */
        return LUMEN_RESULT_INVALID_PARAM;
    }
    if (type == LUMEN_EFFECT_STATIC) {
        /* 静态段没有 flags 字段（effects-spec §2.1）：必须为 0。 */
        if (flags != 0) {
            return LUMEN_RESULT_INVALID_PARAM;
        }
        return LUMEN_RESULT_OK;
    }
    if (type == LUMEN_EFFECT_BREATHING) {
        /*
         * 呼吸（effects-spec §2.2 / §5）：
         *   bit1-2 waveform、bit3-7 必须为 0；
         *   period_ms != 0 时必须 ≥ 334（≈3Hz，光敏性癫痫安全线）。
         * period_ms = 0 是合法值（静止），不受下限约束。
         *
         * **v4**：p5 从绝对 0-255 改为**相对百分比 0-100**（谷底 = level × p5%）。
         * 101-255 一律 InvalidParam——旧程序的绝对量在这里会被明确拒绝，
         * 而不是被静默解释成一个 255 倍的最暗基线。
         */
        if ((flags & 0xF8u) != 0) {
            return LUMEN_RESULT_INVALID_PARAM;
        }
        if (period_ms != 0 && period_ms < LUMEN_BREATHING_MIN_PERIOD_MS) {
            return LUMEN_RESULT_INVALID_PARAM;
        }
        return LUMEN_RESULT_OK;
    }
    /*
     * 彩虹 / 流光（effects-spec §2.3-§2.4）：
     *   bit0 reverse（有实际意义）、**bit1-7 必须为 0**——比呼吸更严，因为
     *   这里没有 waveform 位可借；period_ms != 0 时必须 ≥ 200（5Hz）。
     *   这两类是空间移动不是亮度闪烁，所以下限比呼吸宽松（D5）。
     */
    if ((flags & 0xFEu) != 0) {
        return LUMEN_RESULT_INVALID_PARAM;
    }
    if (period_ms != 0 && period_ms < LUMEN_RAINBOW_MIN_PERIOD_MS) {
        return LUMEN_RESULT_INVALID_PARAM;
    }
    return LUMEN_RESULT_OK;
}

uint8_t lumen_segment_validate_shape(const lumen_segment_t *seg)
{
    if (seg == NULL) {
        return LUMEN_RESULT_INVALID_PARAM;
    }
    /*
     * 严格按 docs/protocol-v4.md §7.1 的 1-8 步顺序。第 1 步（载荷精确长度）
     * 在命令层完成——本函数拿到的是已经解析好的结构。
     */
    const lumen_effect_layer_t *l0 = &seg->layer[0];
    const lumen_effect_layer_t *l1 = &seg->layer[1];

    /* 第 2 步：layer0 必须是已知类型且不得为 0xFF。 */
    if (l0->type == LUMEN_LAYER_EMPTY || !lumen_effect_type_known(l0->type)) {
        return LUMEN_RESULT_INVALID_PARAM;
    }

    /* 第 3 步：layer1 必须是已知类型或 0xFF 空层。 */
    if (l1->type != LUMEN_LAYER_EMPTY && !lumen_effect_type_known(l1->type)) {
        return LUMEN_RESULT_INVALID_PARAM;
    }
    if (l1->type == LUMEN_LAYER_EMPTY && !lumen_layer_empty_params_zero(l1)) {
        /* 空层的 9 字节编码必须全 0（含 level，§7.1 第 3 步）。 */
        return LUMEN_RESULT_INVALID_PARAM;
    }

    /*
     * 第 4 步（v4）：任一层的 level 必须在 0-100 内；空层（layer1）的 level
     * 必须为 0（已在第 3 步经 empty_params_zero 判过）。
     */
    if (l0->level > LUMEN_LAYER_LEVEL_MAX || l1->level > LUMEN_LAYER_LEVEL_MAX) {
        return LUMEN_RESULT_INVALID_PARAM;
    }

    /* 第 5 步：layer1 为空 ⇒ blend 必须为 0。 */
    if (l1->type == LUMEN_LAYER_EMPTY && seg->blend != 0) {
        return LUMEN_RESULT_INVALID_PARAM;
    }

    /* 第 6 步：blend ≤ 2（不支持取最大）。 */
    if (seg->blend > LUMEN_BLEND_MAX) {
        return LUMEN_RESULT_INVALID_PARAM;
    }

    /* 第 7 步：静态层的 param[3..6] 必须全 0（对两层都生效）。 */
    if (l0->type == LUMEN_EFFECT_STATIC && !lumen_layer_static_reserved_zero(l0)) {
        return LUMEN_RESULT_INVALID_PARAM;
    }
    if (l1->type == LUMEN_EFFECT_STATIC && !lumen_layer_static_reserved_zero(l1)) {
        return LUMEN_RESULT_INVALID_PARAM;
    }

    /* 第 8 步：各层按 type 校验参数（flags 保留位、周期下限、呼吸 p5 百分比）。 */
    if (lumen_segment_store_validate_params(l0->type, lumen_layer_flags(l0),
                                            lumen_layer_period_ms(l0)) != LUMEN_RESULT_OK) {
        return LUMEN_RESULT_INVALID_PARAM;
    }
    /* 呼吸层的 p5 是相对百分比：> 100 非法（绝对量的旧值一并不接受）。 */
    if (l0->type == LUMEN_EFFECT_BREATHING && lumen_layer_p5(l0) > 100u) {
        return LUMEN_RESULT_INVALID_PARAM;
    }
    if (l1->type != LUMEN_LAYER_EMPTY &&
        lumen_segment_store_validate_params(l1->type, lumen_layer_flags(l1),
                                            lumen_layer_period_ms(l1)) != LUMEN_RESULT_OK) {
        return LUMEN_RESULT_INVALID_PARAM;
    }
    if (l1->type == LUMEN_EFFECT_BREATHING && lumen_layer_p5(l1) > 100u) {
        return LUMEN_RESULT_INVALID_PARAM;
    }
    return LUMEN_RESULT_OK;
}

uint8_t lumen_segment_store_validate_single(uint8_t strip_id, uint8_t strip_count,
                                            uint8_t led_count, const lumen_segment_t *candidate)
{
    if (candidate == NULL) {
        return LUMEN_RESULT_INVALID_PARAM;
    }

    /* 2-7 形状与参数。 */
    if (lumen_segment_validate_shape(candidate) != LUMEN_RESULT_OK) {
        return LUMEN_RESULT_INVALID_PARAM;
    }

    /* strip_id 范围。 */
    if (strip_count == 0 || strip_count > LUMEN_MAX_STRIPS || strip_id >= strip_count) {
        return LUMEN_RESULT_INVALID_PARAM;
    }

    /* 段区间。 */
    if (led_count == 0 || led_count > LUMEN_MAX_LEDS) {
        return LUMEN_RESULT_INVALID_PARAM;
    }
    if (candidate->start > candidate->end || candidate->end >= led_count) {
        return LUMEN_RESULT_INVALID_PARAM;
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
     * 2-7：形状、层类型、blend、保留位、各类型参数。
     * 放在 strip / 区间之前——§7.1 的顺序是「先判载荷形状，再判语义范围」。
     */
    if (lumen_segment_validate_shape(candidate) != LUMEN_RESULT_OK) {
        return LUMEN_RESULT_INVALID_PARAM;
    }

    /*
     * strip_id 范围：0 ≤ strip_id < strip_count。
     * 多灯带（#29）之前 strip_count 恒为 1，所以传 1 也是 InvalidParam。
     */
    if (strip_count == 0 || strip_count > LUMEN_MAX_STRIPS || strip_id >= strip_count) {
        return LUMEN_RESULT_INVALID_PARAM;
    }

    /* 段区间：start <= end 且 end < led_count（led_count 至少为 1）。 */
    if (led_count == 0 || led_count > LUMEN_MAX_LEDS) {
        return LUMEN_RESULT_INVALID_PARAM;
    }
    if (candidate->start > candidate->end || candidate->end >= led_count) {
        return LUMEN_RESULT_INVALID_PARAM;
    }

    /* 段重叠：与同 strip 的其它活动段无交集。 */
    if (overlaps_others(store, strip_id, seg_id, candidate->start, candidate->end)) {
        return LUMEN_RESULT_INVALID_PARAM;
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
            /* 任一层是动画就需要帧循环（静态双层是常量画面）。 */
            if (lumen_segment_is_animated(seg)) {
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
     * docs/protocol-v4.md §7.3：State 字节 2-4 是 **strip 0 / seg 0 层 0 的基准色**，
     * 由 layer[0] 的 hue+sat 算出（静态层即其像素色），**不含动画包络、不含
     * layer1 与 blend**；seg 0 不存在时为 0。
     *
     * v4 裁决：**也不含本层 level**——它是「色」，不是「亮度」。否则调低光区
     * 亮度会让 App 里显示的「当前颜色」跟着变暗，用户无法区分「颜色变了」
     * 与「变暗了」（全局 brightness 已经单独上报）。
     */
    const lumen_segment_t *seg = &store->slot[strip_id][0];
    if (!seg->active) {
        return;
    }
    lumen_effect_static_rgb(lumen_layer_hue(&seg->layer[0]), lumen_layer_sat(&seg->layer[0]),
                            out_rgb);
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
            /* 两层求值 + blend 都在 lumen_effect_pixel 内，用户空间。 */
            lumen_effect_pixel(seg, i, now_ms, rgb);
            /* ② 用户空间 RGB 直接写进缓冲；gamma + 亮度由渲染层统一施加一次。 */
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
