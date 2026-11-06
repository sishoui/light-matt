#include "effects.h"

#include <math.h>
#include <stddef.h>
#include <string.h>

/*
 * 灯效像素计算，整数定点，无浮点（C3 无 FPU）。
 *
 * hue 是 0-65535 的一整圈（D2），分成 6 个 60° 扇区：
 *   sector = (hue * 6) / 65536        -> 0..5
 *   frac   = (hue * 6) % 65536        -> 扇区内的 Q16 位置
 * V 恒为 1，所以 C = sat（0-255 刻度），m = 255 - sat。
 * 每颗灯的结果都是用户空间 RGB（0-255），gamma 与亮度由渲染层施加。
 *
 * v3（#37）：段有两层。每层独立求值，然后按 blend 在用户空间合成；
 * **两层都绝不施加 gamma / 亮度**，否则「相乘」会在 gamma 后的非线性空间里
 * 把暗部压塌（见 effects.h 与 docs/protocol-v4.md §9.3）。
 */

bool lumen_effect_type_known(uint8_t type)
{
    switch (type) {
    case LUMEN_EFFECT_STATIC:
    case LUMEN_EFFECT_BREATHING:
    case LUMEN_EFFECT_RAINBOW:
    case LUMEN_EFFECT_COMET:
    case LUMEN_EFFECT_STROBE:
    case LUMEN_EFFECT_HEARTBEAT:
    case LUMEN_EFFECT_OFF:
    case LUMEN_EFFECT_FLICKER:
        return true;
    default:
        return false;
    }
}

bool lumen_effect_type_implemented(uint8_t type)
{
    /*
     * 八种类型全部有像素实现（#25 静态 / #30 呼吸 / #31 彩虹+流光 / #74 爆闪+
     * 心跳+熄灭 / #98 随机闪烁）。未知类型仍由 lumen_effect_type_known 在命令层
     * 拒绝（InvalidParam），这里不负责区分「已知但未实现」——那个中间态已经不存在。
     *
     * **熄灭必须同时出现在 known 与 implemented 里**：作为 layer0 时 §7.1
     * 第 2 步只认同一个都成立的类型，漏掉任一边都会把显式「熄灭」判成非法。
     */
    return type == LUMEN_EFFECT_STATIC || type == LUMEN_EFFECT_BREATHING ||
           type == LUMEN_EFFECT_RAINBOW || type == LUMEN_EFFECT_COMET ||
           type == LUMEN_EFFECT_STROBE || type == LUMEN_EFFECT_HEARTBEAT ||
           type == LUMEN_EFFECT_OFF || type == LUMEN_EFFECT_FLICKER;
}

uint8_t lumen_effect_param_len(uint8_t type)
{
    switch (type) {
    case LUMEN_EFFECT_STATIC:
        /* docs/effects-spec.md §2.1：hue(2) + sat(1)。 */
        return 3;
    case LUMEN_EFFECT_BREATHING:
    case LUMEN_EFFECT_RAINBOW:
    case LUMEN_EFFECT_COMET:
    case LUMEN_EFFECT_STROBE:
    case LUMEN_EFFECT_HEARTBEAT:
    case LUMEN_EFFECT_OFF:
    case LUMEN_EFFECT_FLICKER:
        /*
         * §2.2-§2.8：hue(2) + sat(1) + period(2) + p5(1) + flags(1) = 7。
         * #74 的三种与 #98 的随机闪烁**复用同一个 7 字节块**，所以层编码宽度、
         * 帧长、状态 blob 尺寸与协议版本号全都不变。熄灭虽然要求 7 个参数全部
         * 为 0（它一个字节都不解释），但长度仍按 7 报，让两端只有一张长度表——
         * 剧本 blob 的记录宽度也因此保持 5/9/13/21 不变。
         */
        return 7;
    default:
        /* 未知类型与空层（0xFF）：没有参数块。 */
        return 0;
    }
}

bool lumen_effect_is_animated(uint8_t type)
{
    /*
     * **显式枚举，不能写成 `type != STATIC`**：熄灭（0x06）的输出恒为黑，
     * 把它算成动画会让「一整组只有熄灭」的配置也按帧重绘，白烧 CPU / RMT。
     * 空层（0xFF）同样不是动画。
     */
    switch (type) {
    case LUMEN_EFFECT_STATIC:
    case LUMEN_EFFECT_OFF:
    case LUMEN_LAYER_EMPTY:
        return false;
    case LUMEN_EFFECT_BREATHING:
    case LUMEN_EFFECT_RAINBOW:
    case LUMEN_EFFECT_COMET:
    case LUMEN_EFFECT_STROBE:
    case LUMEN_EFFECT_HEARTBEAT:
    case LUMEN_EFFECT_FLICKER:
        return true;
    default:
        /* 未知类型：保守按「非静态」处理（与改动前一致，不影响任何合法配置）。 */
        return true;
    }
}

/* ---------------- 层编解码（§7.1 的 9 字节定宽） ---------------- */

bool lumen_layer_is_empty(const lumen_effect_layer_t *layer)
{
    return layer != NULL && layer->type == LUMEN_LAYER_EMPTY;
}

bool lumen_layer_decode(const uint8_t src[9], lumen_effect_layer_t *out)
{
    if (src == NULL || out == NULL) {
        return false;
    }
    out->type = src[0];
    memcpy(out->param, &src[1], sizeof(out->param));
    out->level = src[8];
    /* 形状合法 = 已知类型或空层。值的合法性（保留位 / 周期下限 / level）由命令层判。 */
    return lumen_effect_type_known(out->type) || out->type == LUMEN_LAYER_EMPTY;
}

void lumen_layer_encode(const lumen_effect_layer_t *layer, uint8_t out[9])
{
    if (layer == NULL || out == NULL) {
        return;
    }
    out[0] = layer->type;
    memcpy(&out[1], layer->param, sizeof(layer->param));
    out[8] = layer->level;
}

/* ---------------- 层 / 一步两层的形状校验（§7.1 第 2-8 步） ---------------- */

/*
 * 熄灭层的 param[0..6] 是否全 0（effects-spec §2.7）。
 *
 * 为什么不放进 lumen_segment_validate_params：那个函数只有
 * `(type, flags, period_ms)` 三个参数，看不到 hue / sat / p5。为一条规则
 * 扩公共签名会牵动命令层与 blob 解码的所有调用点，而熄灭的「参数全零」
 * 只依赖层本身——放在形状校验里最省。level 不在约束内：熄灭本来就是黑的，
 * 亮度对它没有意义。
 */
static bool off_params_zero(const lumen_effect_layer_t *layer)
{
    for (size_t i = 0; i < sizeof(layer->param); ++i) {
        if (layer->param[i] != 0) {
            return false;
        }
    }
    return true;
}

uint8_t lumen_segment_validate_params(uint8_t type, uint8_t flags, uint16_t period_ms)
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
         * p5 是**相对百分比 0-100**（谷底 = level × p5%），> 100 一律非法；
         * 那条判定在 lumen_segment_validate_shape 里（本函数看不到 p5）。
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
     * 彩虹（effects-spec §2.3）：
     *   bit0 reverse（有实际意义）、**bit1-7 必须为 0**——比呼吸更严，因为
     *   这里没有 waveform 位可借；period_ms != 0 时必须 ≥ 200（5Hz）。
     *   彩虹是空间移动不是亮度闪烁，所以下限比呼吸宽松（D5）。
     */
    if (type == LUMEN_EFFECT_RAINBOW) {
        if ((flags & 0xFEu) != 0) {
            return LUMEN_RESULT_INVALID_PARAM;
        }
        if (period_ms != 0 && period_ms < LUMEN_RAINBOW_MIN_PERIOD_MS) {
            return LUMEN_RESULT_INVALID_PARAM;
        }
        return LUMEN_RESULT_OK;
    }
    /*
     * 流光（effects-spec §2.4 + #98）：
     *   bit0 reverse、bit1 拖尾不衰减、bit2-3 头数量（0..3 ⇒ 1..4 个）、
     *   **bit4-7 保留必须为 0**。周期下限与彩虹同一条（≥ 200ms）。
     */
    if (type == LUMEN_EFFECT_COMET) {
        if ((flags & LUMEN_COMET_FLAGS_RESERVED_MASK) != 0) {
            return LUMEN_RESULT_INVALID_PARAM;
        }
        if (period_ms != 0 && period_ms < LUMEN_RAINBOW_MIN_PERIOD_MS) {
            return LUMEN_RESULT_INVALID_PARAM;
        }
        return LUMEN_RESULT_OK;
    }
    if (type == LUMEN_EFFECT_FLICKER) {
        /*
         * 随机闪烁（#98）：
         *   flags **必须为 0**（没有方向 / 波形 / 密度位）；duty 是 p5，0-255 全合法；
         *   period_ms != 0 时必须 ≥ 334（3Hz，与呼吸同一条光敏性癫痫安全线）。
         */
        if (flags != 0) {
            return LUMEN_RESULT_INVALID_PARAM;
        }
        if (period_ms != 0 && period_ms < LUMEN_FLICKER_MIN_PERIOD_MS) {
            return LUMEN_RESULT_INVALID_PARAM;
        }
        return LUMEN_RESULT_OK;
    }
    if (type == LUMEN_EFFECT_STROBE) {
        /*
         * 爆闪（effects-spec §2.5）：
         *   flags **必须为 0**（没有方向 / 波形位可用）；
         *   period_ms != 0 时必须 ≥ 100（10Hz = 20fps 下能表现的上界）。
         */
        if (flags != 0) {
            return LUMEN_RESULT_INVALID_PARAM;
        }
        if (period_ms != 0 && period_ms < LUMEN_STROBE_MIN_PERIOD_MS) {
            return LUMEN_RESULT_INVALID_PARAM;
        }
        return LUMEN_RESULT_OK;
    }
    if (type == LUMEN_EFFECT_HEARTBEAT) {
        /*
         * 心跳（effects-spec §2.6）：
         *   bit0 = 双脉冲开关（默认 1）、**bit1-7 必须为 0**；
         *   period_ms != 0 时必须落在 500-1500（40-120 BPM）。
         */
        if ((flags & 0xFEu) != 0) {
            return LUMEN_RESULT_INVALID_PARAM;
        }
        if (period_ms != 0 && (period_ms < LUMEN_HEARTBEAT_MIN_PERIOD_MS ||
                               period_ms > LUMEN_HEARTBEAT_MAX_PERIOD_MS)) {
            return LUMEN_RESULT_INVALID_PARAM;
        }
        return LUMEN_RESULT_OK;
    }
    if (type == LUMEN_EFFECT_OFF) {
        /*
         * 熄灭（effects-spec §2.7）：flags / period_ms 必须为 0。
         * hue / sat / p5 也必须是 0，但本函数签名看不到它们，所以那部分
         * 放在 lumen_segment_validate_shape 里。
         */
        if (flags != 0 || period_ms != 0) {
            return LUMEN_RESULT_INVALID_PARAM;
        }
        return LUMEN_RESULT_OK;
    }
    /* 类型已由 type_implemented 过滤，走到这里说明类型表与规则表不同步。 */
    return LUMEN_RESULT_INVALID_PARAM;
}

uint8_t lumen_segment_validate_shape(const lumen_segment_t *seg)
{
    if (seg == NULL) {
        return LUMEN_RESULT_INVALID_PARAM;
    }
    /*
     * 严格按 docs/protocol-v5.md §7.1 的 1-8 步顺序。第 1 步（载荷精确长度）
     * 在命令层完成——本函数拿到的是已经解析好的结构。
     *
     * v5 的一步等价于 v4 的一个段：**同一套层编码与同一套约束**，只是宿主
     * 从「段」换成了「步」。所以命令层、场景存储、blob 解码共用这一处。
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

    /* 第 4 步：任一层的 level 必须在 0-100 内；空层的 level 已在第 3 步判过。 */
    if (l0->level > LUMEN_LAYER_LEVEL_MAX || l1->level > LUMEN_LAYER_LEVEL_MAX) {
        return LUMEN_RESULT_INVALID_PARAM;
    }

    /* 第 5 步：layer1 为空 ⇒ blend 必须为 0。 */
    if (l1->type == LUMEN_LAYER_EMPTY && seg->blend != 0) {
        return LUMEN_RESULT_INVALID_PARAM;
    }

    /* 第 6 步：blend ≤ LUMEN_BLEND_MAX（v4 的 3 = 按亮度叠加也合法）。 */
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
    if (lumen_segment_validate_params(l0->type, lumen_layer_flags(l0),
                                      lumen_layer_period_ms(l0)) != LUMEN_RESULT_OK) {
        return LUMEN_RESULT_INVALID_PARAM;
    }
    if (l0->type == LUMEN_EFFECT_BREATHING && lumen_layer_p5(l0) > 100u) {
        return LUMEN_RESULT_INVALID_PARAM;
    }
    if (l1->type != LUMEN_LAYER_EMPTY &&
        lumen_segment_validate_params(l1->type, lumen_layer_flags(l1),
                                      lumen_layer_period_ms(l1)) != LUMEN_RESULT_OK) {
        return LUMEN_RESULT_INVALID_PARAM;
    }
    if (l1->type == LUMEN_EFFECT_BREATHING && lumen_layer_p5(l1) > 100u) {
        return LUMEN_RESULT_INVALID_PARAM;
    }

    /*
     * 熄灭：hue / sat / p5 也必须是 0（flags / period 已在上面的
     * validate_params 里判过）。这里单独查一次是因为共享函数看不到这些字节。
     */
    if (l0->type == LUMEN_EFFECT_OFF && !off_params_zero(l0)) {
        return LUMEN_RESULT_INVALID_PARAM;
    }
    if (l1->type == LUMEN_EFFECT_OFF && !off_params_zero(l1)) {
        return LUMEN_RESULT_INVALID_PARAM;
    }
    return LUMEN_RESULT_OK;
}

uint16_t lumen_layer_hue(const lumen_effect_layer_t *layer)
{
    if (layer == NULL) {
        return 0;
    }
    return (uint16_t)(layer->param[0] | ((uint16_t)layer->param[1] << 8));
}

uint8_t lumen_layer_sat(const lumen_effect_layer_t *layer)
{
    return layer != NULL ? layer->param[2] : 0;
}

uint16_t lumen_layer_period_ms(const lumen_effect_layer_t *layer)
{
    if (layer == NULL) {
        return 0;
    }
    return (uint16_t)(layer->param[3] | ((uint16_t)layer->param[4] << 8));
}

uint8_t lumen_layer_p5(const lumen_effect_layer_t *layer)
{
    return layer != NULL ? layer->param[5] : 0;
}

uint8_t lumen_layer_flags(const lumen_effect_layer_t *layer)
{
    return layer != NULL ? layer->param[6] : 0;
}

uint8_t lumen_layer_level(const lumen_effect_layer_t *layer)
{
    return layer != NULL ? layer->level : 0;
}

bool lumen_layer_static_reserved_zero(const lumen_effect_layer_t *layer)
{
    if (layer == NULL) {
        return false;
    }
    /* §7.1 第 6 步：静态层 param[3..6] 是保留位。level 是独立字节，不受此约束。 */
    for (size_t i = 3; i < sizeof(layer->param); ++i) {
        if (layer->param[i] != 0) {
            return false;
        }
    }
    return true;
}

bool lumen_layer_empty_params_zero(const lumen_effect_layer_t *layer)
{
    if (layer == NULL) {
        return false;
    }
    /* v4：空层的亮度必须为 0（§7.1 第 3 步），否则视为形状非法。 */
    if (layer->level != 0) {
        return false;
    }
    for (size_t i = 0; i < sizeof(layer->param); ++i) {
        if (layer->param[i] != 0) {
            return false;
        }
    }
    return true;
}

/* ---------------- 段几何 ---------------- */

uint16_t lumen_effect_segment_length(const lumen_segment_t *seg)
{
    if (seg == NULL || !seg->active) {
        return 0;
    }
    if (seg->end < seg->start) {
        return 0;
    }
    return (uint16_t)((uint16_t)seg->end - (uint16_t)seg->start + 1u);
}

uint16_t lumen_effect_index_in_segment(const lumen_segment_t *seg, uint16_t index_in_strip)
{
    if (seg == NULL || index_in_strip < seg->start || index_in_strip > seg->end) {
        return 0;
    }
    return (uint16_t)(index_in_strip - seg->start);
}

bool lumen_segment_is_animated(const lumen_segment_t *seg)
{
    if (seg == NULL || !seg->active) {
        return false;
    }
    /* 任一层动画就需要帧循环；静态双层（覆盖 / 相乘 / 相加）是常量画面。 */
    for (uint8_t l = 0; l < 2; ++l) {
        if (lumen_effect_is_animated(seg->layer[l].type)) {
            return true;
        }
    }
    return false;
}

void lumen_effect_static_rgb(uint16_t hue, uint8_t sat, uint8_t out_rgb[3])
{
    if (out_rgb == NULL) {
        return;
    }

    /* sector 0..5，frac 是扇区内 Q16 位置。 */
    uint32_t scaled = (uint32_t)hue * 6u; /* 最大 65535*6 = 393210，uint32 够 */
    uint8_t sector = (uint8_t)(scaled >> 16); /* / 65536 */
    if (sector > 5) {
        sector = 5; /* hue == 0xFFFF 时 scaled>>16 == 5，保险 */
    }
    uint32_t frac = scaled & 0xFFFFu;

    uint8_t c = sat;          /* C = V * S，V = 1 => C = sat（0-255 刻度） */
    uint8_t m = (uint8_t)(255u - (uint32_t)sat); /* min = V * (1 - S) */

    /* u = 扇区内从 0 到 1 的线性位置（偶数扇区递增，奇数扇区递减）。 */
    uint32_t u = (sector & 1u) != 0u ? (0x10000u - frac) : frac;
    uint32_t x = ((uint32_t)c * u + 0x8000u) >> 16; /* +32768 四舍五入 */

    uint8_t base = m;
    uint8_t r = 0;
    uint8_t g = 0;
    uint8_t b = 0;
    switch (sector) {
    case 0:
        r = c;
        g = (uint8_t)x;
        b = 0;
        break;
    case 1:
        r = (uint8_t)x;
        g = c;
        b = 0;
        break;
    case 2:
        r = 0;
        g = c;
        b = (uint8_t)x;
        break;
    case 3:
        r = 0;
        g = (uint8_t)x;
        b = c;
        break;
    case 4:
        r = (uint8_t)x;
        g = 0;
        b = c;
        break;
    default:
        r = c;
        g = 0;
        b = (uint8_t)x;
        break;
    }

    out_rgb[0] = (uint8_t)((uint16_t)r + base);
    out_rgb[1] = (uint8_t)((uint16_t)g + base);
    out_rgb[2] = (uint8_t)((uint16_t)b + base);
}

/* ---------------- blend（§7.2，用户空间） ---------------- */

void lumen_blend_pixel(uint8_t blend, const uint8_t l0[3], const uint8_t l1[3],
                       uint8_t out_rgb[3])
{
    if (l0 == NULL || l1 == NULL || out_rgb == NULL) {
        return;
    }
    uint8_t result[3];
    switch (blend) {
    case LUMEN_BLEND_MULTIPLY:
        /*
         * (L0 * L1 + 127) / 255：+127 是四舍五入（255*255+127 = 65152，
         * /255 = 255——满值满值仍是满值，不会因为舍入掉到 254）。
         */
        for (uint8_t c = 0; c < 3; ++c) {
            result[c] = (uint8_t)(((uint16_t)l0[c] * (uint16_t)l1[c] + 127u) / 255u);
        }
        break;
    case LUMEN_BLEND_ADD:
        /* min(255, L0 + L1)：用 uint16 相加再显式钳位，绝不靠 uint8 回绕。 */
        for (uint8_t c = 0; c < 3; ++c) {
            uint16_t sum = (uint16_t)l0[c] + (uint16_t)l1[c];
            result[c] = (uint8_t)(sum > 255u ? 255u : sum);
        }
        break;
    case LUMEN_BLEND_LUMA: {
        /*
         * 按亮度叠加（§7.2.1）：a = max(L1)/255，out = L1 + L0 × (1 − a)。
         *
         * 取三通道最大值而不是平均值：单色流动效果（纯红流星）只有红通道非 0，
         * 取平均会让 a 被另外两个 0 通道拉到 1/3，表现为「流星永远半透明」。
         *
         * 形状上等价于「上层按自己的亮度当不透明度」：L1 全黑 → 背景原样透出；
         * L1 满亮 → 上层完全接管；中间值按亮度线性混合。
         */
        uint8_t peak = l1[0];
        if (l1[1] > peak) {
            peak = l1[1];
        }
        if (l1[2] > peak) {
            peak = l1[2];
        }
        if (peak == 0xFFu) {
            /* 满亮：上层完全接管，等价于覆盖（省掉一次乘除）。 */
            memcpy(result, l1, 3);
            break;
        }
        uint16_t keep = (uint16_t)(0xFFu - peak); /* L0 的保留权重，0..254 */
        for (uint8_t c = 0; c < 3; ++c) {
            uint16_t scaled = (uint16_t)(((uint32_t)l0[c] * keep + 127u) / 255u);
            uint16_t sum = (uint16_t)l1[c] + scaled;
            result[c] = (uint8_t)(sum > 255u ? 255u : sum);
        }
        break;
    }
    case LUMEN_BLEND_OVER:
    default:
        /*
         * out = L1。未知 blend 也按覆盖处理：命令层已把 >3 判为 InvalidParam，
         * 这里只是防御，不让一个损坏的段把整条灯带变黑。
         */
        memcpy(result, l1, 3);
        break;
    }
    memcpy(out_rgb, result, 3);
}

/* ---------------- #30 呼吸 ---------------- */

/*
 * 正弦查表：65 个点（含右端点），值为 sin²(π k / 64) 的 Q16 表示。
 *
 * 为什么存 sin² 而不是 cos：包络要的正是 0.5 × (1 - cos(2πp))，
 * 恒等于 sin²(πp)。直接存这个量，查表后线性插值即可，不需要在运行时
 * 做减法与半幅缩放，也不会在 p 刚过半周期时出现负相位。
 *
 * 表在 k=32 达到峰值 65535，之后回落到 k=64 的 0——与 p 从 0 走到 1
 * 时「先亮后暗、首尾相接」的形状一致。
 *
 * 建表用 math.h（只在初始化时），运行时零浮点。用 float 而不是 double：
 * C3 无 FPU，double 会拉进一整组软件浮点例程白占 flash，而这个表的精度
 * 需求远低于 float 的分辨率（gamma.c 也是 float）。
 */
#define LUMEN_SINE_TABLE_SIZE 64u
#define LUMEN_SINE_STEP_Q16 1024u /* 65536 / 64 */

static uint16_t s_sine_sq[LUMEN_SINE_TABLE_SIZE + 1u];
static int s_sine_ready;

/*
 * 流光尾部的指数衰减表（#31）：exp(-3 × k/64)，Q16，k = 0..64。
 *
 * effects-spec §3.4 的权重是 exp(-(p×N/tail_n)×3)，自变量落在 [0,1]；
 * 存 65 个点覆盖整段并线性插值。与正弦表同一套做法：初始化时用 math.h，
 * 运行时只查表——**绝不调 expf**（C3 无 FPU，且渲染在每帧每灯的热路径上）。
 */
#define LUMEN_EXP_TABLE_SIZE 64u
#define LUMEN_EXP_STEP_Q16 1024u /* 65536 / 64 */

static uint16_t s_comet_exp[LUMEN_EXP_TABLE_SIZE + 1u];

void lumen_effects_init(void)
{
    if (s_sine_ready) {
        return;
    }
    for (uint32_t k = 0; k <= LUMEN_SINE_TABLE_SIZE; ++k) {
        /* sin²(π k / 64)：k=0 → 0，k=32 → 1（峰值），k=64 → 0（回到起点）。 */
        float angle = 3.14159265f * (float)k / (float)LUMEN_SINE_TABLE_SIZE;
        float s = sinf(angle);
        uint32_t value = (uint32_t)(s * s * 65535.0f + 0.5f);
        if (value > 65535u) {
            value = 65535u;
        }
        s_sine_sq[k] = (uint16_t)value;
    }
    for (uint32_t k = 0; k <= LUMEN_EXP_TABLE_SIZE; ++k) {
        /* exp(-3 × k/64)：k=0 → 1（头部满亮），k=64 → exp(-3) ≈ 0.0498。 */
        float x = 3.0f * (float)k / (float)LUMEN_EXP_TABLE_SIZE;
        uint32_t value = (uint32_t)(expf(-x) * 65535.0f + 0.5f);
        if (value > 65535u) {
            value = 65535u;
        }
        s_comet_exp[k] = (uint16_t)value;
    }
    s_sine_ready = 1;
}

uint32_t lumen_effect_breathing_phase_q16(uint16_t period_ms, uint32_t t0_ms, uint32_t now_ms)
{
    if (period_ms == 0) {
        /*
         * §3.2 的公式：period = 0 时 phase 恒 0，包络取 e(0) = 0，
         * 于是 e' = min_level/255 —— 段静止在「最暗」那一档，不随时间变。
         * 这是规格的字面语义，不要自作主张改成「停在最亮」。
         */
        return 0;
    }
    /*
     * 无符号减法：now < t0（49 天计时器回绕）时得到的是「正确的大正数」，
     * 先取模就把回绕吃掉了。绝不能用有符号。
     */
    uint32_t r = (now_ms - t0_ms) % (uint32_t)period_ms;
    /*
     * **uint64_t 中间量，不可省**（effects-spec §6）：
     * period_ms = 65535 时 r 最大 65534，r << 16 = 4294836224，
     * 距 2^32 = 4294967296 只有 131072 的余量。
     */
    return (uint32_t)(((uint64_t)r << 16) / (uint64_t)period_ms);
}

/*
 * 查表 + 线性插值：phase_q16 落在表的两点之间，按低位插值。
 *
 * 表是先升后降的（k=32 峰值），所以 **hi 可以小于 lo**——差值必须用
 * 有符号 32 位，否则 uint32 下溢会把整数除法算成一个巨大的正数。
 * |delta| ≤ 65535、frac ≤ 1023，乘积 ≤ 6.7e7，int32 安全。
 */
static uint32_t sine_envelope_q16(uint32_t phase_q16)
{
    if (!s_sine_ready) {
        lumen_effects_init();
    }
    uint32_t p = phase_q16 & 0xFFFFu; /* [0,65536) */
    uint32_t index = p / LUMEN_SINE_STEP_Q16;
    uint32_t frac = p - index * LUMEN_SINE_STEP_Q16; /* 0..1023 */
    if (index >= LUMEN_SINE_TABLE_SIZE) {
        return 65535u; /* p = 65535 时 index 仍为 63，这行是保险 */
    }
    int32_t lo = (int32_t)s_sine_sq[index];
    int32_t hi = (int32_t)s_sine_sq[index + 1u];
    int32_t delta = hi - lo;
    int32_t interpolated = lo + (delta * (int32_t)frac + 512) / 1024;
    if (interpolated < 0) {
        interpolated = 0;
    } else if (interpolated > 65535) {
        interpolated = 65535;
    }
    return (uint32_t)interpolated;
}

uint16_t lumen_effect_breathing_envelope_q16(uint32_t phase_q16, uint8_t waveform)
{
    uint32_t p = phase_q16 & 0xFFFFu; /* [0,65536) */

    switch (waveform) {
    case LUMEN_WAVE_TRIANGLE:
        /* 1 - |2p - 1|：p=0 → 0，p=0.5 → 1，p=1 → 0。 */
        return (uint16_t)(p < 32768u ? p * 2u : (65535u - p) * 2u + 1u);

    case LUMEN_WAVE_SAWTOOTH:
        /* p 本身：0 → 1 线性上升，然后瞬间回到 0（用户明确接受的不连续）。 */
        return (uint16_t)p;

    case LUMEN_WAVE_SQUARE: {
        /*
         * 方波但首尾各 10% 做线性斜坡（effects-spec §2.2）：
         *   p < 0.10          上升沿：0 → 1
         *   0.10 ≤ p < 0.50   高电平 1
         *   0.50 ≤ p < 0.60   下降沿：1 → 0
         *   p ≥ 0.60          低电平 0
         * 10% = 6554（Q16）。边界上两端都连续，不会有 ±1 的跳变。
         */
        const uint32_t ramp = 6554u; /* 10% */
        const uint32_t half = 32768u;
        if (p < ramp) {
            return (uint16_t)(p * 65535u / ramp);
        }
        if (p < half) {
            return 65535u;
        }
        if (p < half + ramp) {
            return (uint16_t)((half + ramp - p) * 65535u / ramp);
        }
        return 0;
    }

    case LUMEN_WAVE_SINE:
    default:
        /* 未知 waveform 位组合按正弦处理：命令层已拒绝非法 flags，这里不静默变黑。 */
        return (uint16_t)sine_envelope_q16(p);
    }
}

uint32_t lumen_effect_breathing_gain_q16(uint16_t period_ms, uint8_t min_level,
                                         uint8_t waveform, uint32_t t0_ms, uint32_t now_ms)
{
    uint32_t phase = lumen_effect_breathing_phase_q16(period_ms, t0_ms, now_ms);
    uint32_t e = lumen_effect_breathing_envelope_q16(phase, waveform);
    /*
     * e' = min_level/255 + (1 - min_level/255) × e，全部 Q16：
     *   span_q16 = (255 - min_level) × 65536 / 255     // 0..65536
     *   min_q16  = 65536 - span_q16
     *   e'       = min_q16 + span_q16 × e / 65536
     *
     * 用 (255 - min) 表示「可呼吸的幅度」，而不是直接算 min×65536/255：
     * 好处是 min_level = 255 时 span = 0 → 增益恒为 65536（钳到 65535），
     * 不需要为 65536 这唯一一个溢出值写特例。
     *
     * 极值核对：
     *   min_level = 0   → min_q16 = 0      → 谷底全黑，峰顶满亮
     *   min_level = 255 → span_q16 = 0     → 恒 65536 → 钳为 65535（不呼吸）
     */
    uint32_t span = (uint32_t)(255u - min_level); /* 0..255 */
    uint32_t span_q16 = span * 65536u / 255u;     /* 0..65536 */
    uint32_t min_q16 = 65536u - span_q16;         /* 0..65536 */
    uint32_t gain = min_q16 + (span_q16 * e) / 65536u;
    if (gain > 65535u) {
        gain = 65535u;
    }
    return gain;
}

uint32_t lumen_effect_breathing_gain_pct_q16(uint16_t period_ms, uint8_t min_pct, uint8_t level,
                                             uint8_t waveform, uint32_t t0_ms, uint32_t now_ms)
{
    uint32_t phase = lumen_effect_breathing_phase_q16(period_ms, t0_ms, now_ms);
    uint32_t e = lumen_effect_breathing_envelope_q16(phase, waveform);

    /*
     * v4：p5 是相对百分比，峰值 = 本层 level，谷底 = level × min_pct / 100。
     *
     *   floor_pct = level × min_pct / 100              // 0..100
     *   floor_q16 = floor_pct × 65536 / 100
     *   peak_q16  = level     × 65536 / 100
     *   gain      = floor_q16 + (peak_q16 - floor_q16) × e / 65536
     *
     * 极值核对：
     *   level = 100, min_pct = 0   → 0..65536（满幅呼吸，与 v3 的 min_level=0 一致）
     *   level = 100, min_pct = 100 → 恒 65536 → 钳为 65535（不呼吸）
     *   level = 50,  min_pct = 0   → 0..32768（峰值为半亮）
     *   level = 50,  min_pct = 100 → 恒 32768（谷底 = 50%）
     *
     * level / min_pct 越界在命令层已拒；这里钳位防御，不让坏配置把整层变黑。
     */
    if (min_pct > 100u) {
        min_pct = 100u;
    }
    if (level > LUMEN_LAYER_LEVEL_MAX) {
        level = LUMEN_LAYER_LEVEL_MAX;
    }
    uint32_t floor_pct = ((uint32_t)level * (uint32_t)min_pct) / 100u; /* 0..100 */
    uint32_t floor_q16 = floor_pct * 65536u / 100u;                    /* 0..65536 */
    uint32_t peak_q16 = (uint32_t)level * 65536u / 100u;               /* 0..65536 */
    if (peak_q16 > 65536u) {
        peak_q16 = 65536u;
    }
    uint32_t span_q16 = peak_q16 - floor_q16;
    uint32_t gain = floor_q16 + (span_q16 * e) / 65536u;
    if (gain > 65535u) {
        gain = 65535u;
    }
    return gain;
}

/* ---------------- #74 爆闪 / 心跳 ---------------- */

uint32_t lumen_effect_strobe_gain_q16(uint16_t period_ms, uint8_t duty, uint32_t t0_ms,
                                      uint32_t now_ms)
{
    /*
     * 方波，两端各留 5% 线性斜坡（effects-spec §2.5）。
     * 相位与呼吸 / 彩虹共用同一个 helper（同一条 §6 的 uint64 公式）。
     */
    if (period_ms == 0) {
        return 0; /* 静止 = 不出光（不是停在亮端） */
    }
    if (duty == 0) {
        return 0; /* 占空比 0 = 恒 GND（不是「一个极窄的脉冲」） */
    }
    uint32_t p = lumen_effect_breathing_phase_q16(period_ms, t0_ms, now_ms); /* [0,65536) */
    uint32_t hi = (uint32_t)duty * 65536u / 255u; /* 高电平结束位置 */
    const uint32_t ramp = 3277u;                  /* 5% = 65536 / 20 */
    if (hi < ramp * 2u) {
        /*
         * duty 极小但非 0 时把高电平抬到 10%，让斜坡两侧都还有空间：
         * 否则 hi < ramp 会让「下降沿」的区间算成负数，出现诡异的常亮。
         */
        hi = ramp * 2u;
    }
    if (p < ramp) {
        return p * 65535u / ramp; /* 上升沿：0 → 1 */
    }
    if (p < hi - ramp) {
        return 65535u; /* 高电平 */
    }
    if (p < hi) {
        return (hi - p) * 65535u / ramp; /* 下降沿：1 → 0 */
    }
    return 0; /* 低电平 */
}

uint32_t lumen_effect_heartbeat_gain_q16(uint16_t period_ms, uint8_t pulse, bool double_pulse,
                                         uint32_t t0_ms, uint32_t now_ms)
{
    /*
     * 一个节拍内一大一小两次脉冲（effects-spec §2.6），其余时间在谷底。
     * 线性三角近似：视觉上就是「咚、咚」两下，形状不必像心电图。
     */
    if (period_ms == 0) {
        return 0; /* 静止在谷底 */
    }
    uint32_t p = lumen_effect_breathing_phase_q16(period_ms, t0_ms, now_ms); /* [0,65536) */
    uint32_t w = (uint32_t)pulse * 65536u / 255u; /* 单次脉冲宽 */
    if (w < 655u) {
        w = 655u; /* 至少 1% 周期，免得脉冲窄到看不见（20fps 下可能整帧错过） */
    }
    /* 脉冲 1：0..w，峰值 1。 */
    if (p < w) {
        return p * 65535u / w;
    }
    /* 间歇：w..2w，谷底。 */
    if (p < w * 2u) {
        return 0u;
    }
    /* 脉冲 2：2w..3w，峰值 0.6（39321 ≈ 0.6 × 65535）。 */
    if (double_pulse && p < w * 3u) {
        return (p - w * 2u) * 39321u / w;
    }
    return 0;
}

/* ---------------- #98 随机闪烁 ---------------- */

uint32_t lumen_effect_flicker_phase_seed(uint16_t index_in_strip, uint16_t n, uint32_t t0_ms)
{
    /*
     * 一次 32 位乘法-异或混淆（MurmurHash 的收尾步骤），只用整数。
     * 输入里没有 now_ms——**这就是「不能每帧随机」的实现**：种子是这颗灯在
     * 这份配置下的常量，时间只在下面的相位里推进。
     *
     * 加 +1 让 0 号灯也不落在「全 0 输入」这个不动点上；t0_ms 参与是为了
     * 「重新下发同一份配置 = 换一张新的随机图」，同一份配置期间它不变。
     */
    uint32_t x = ((uint32_t)index_in_strip + 1u) * 2654435761u;
    x ^= ((uint32_t)n << 16) ^ t0_ms;
    x ^= x >> 15;
    x *= 2246822519u;
    x ^= x >> 13;
    x *= 3266489917u;
    x ^= x >> 16;
    return x & 0xFFFFu;
}

uint32_t lumen_effect_flicker_gain_q16(uint16_t period_ms, uint8_t duty, uint16_t index_in_strip,
                                       uint16_t n, uint32_t t0_ms, uint32_t now_ms)
{
    if (n == 0 || index_in_strip >= n) {
        return 0;
    }
    if (duty == 0) {
        return 0; /* 占比 0 = 全灭（不是「一个极窄的脉冲」） */
    }
    uint32_t seed_q16 = lumen_effect_flicker_phase_seed(index_in_strip, n, t0_ms);
    uint32_t time_q16 = lumen_effect_breathing_phase_q16(period_ms, t0_ms, now_ms);
    /* 空间相位（种子）+ 时间相位：每个灯珠的方波彼此错相，所以同一时刻只有一部分亮。 */
    uint32_t p = (time_q16 + seed_q16) & 0xFFFFu;

    uint32_t hi = (uint32_t)duty * 65536u / 255u;
    const uint32_t ramp = 3277u; /* 5% = 65536 / 20，与爆闪同一套边沿 */
    if (hi < ramp * 2u) {
        hi = ramp * 2u;
    }
    if (p < ramp) {
        return p * 65535u / ramp;
    }
    if (p < hi - ramp) {
        return 65535u;
    }
    if (p < hi) {
        return (hi - p) * 65535u / ramp;
    }
    return 0;
}

uint8_t lumen_effect_apply_gain_q16(uint8_t value, uint32_t gain_q16)
{
    if (gain_q16 >= 65535u) {
        return value;
    }
    uint32_t scaled = (uint32_t)value * gain_q16;
    return (uint8_t)((scaled + 32767u) / 65535u);
}

/* 把基础色按 Q16 增益缩放（四舍五入）；呼吸与流光共用。 */
static void scale_pixel(const uint8_t base[3], uint32_t gain_q16, uint8_t out_rgb[3])
{
    out_rgb[0] = lumen_effect_apply_gain_q16(base[0], gain_q16);
    out_rgb[1] = lumen_effect_apply_gain_q16(base[1], gain_q16);
    out_rgb[2] = lumen_effect_apply_gain_q16(base[2], gain_q16);
}

uint8_t lumen_effect_apply_level_q8(uint8_t value, uint8_t level)
{
    if (level >= LUMEN_LAYER_LEVEL_MAX) {
        return value; /* 100（以及防御性的 >100 钳位）→ 原样 */
    }
    /* round(value × level / 100)：+50 是四舍五入。value ≤ 255、level ≤ 100 → ≤ 25500。 */
    return (uint8_t)(((uint32_t)value * (uint32_t)level + 50u) / 100u);
}

static void scale_pixel_level(const uint8_t base[3], uint8_t level, uint8_t out_rgb[3])
{
    out_rgb[0] = lumen_effect_apply_level_q8(base[0], level);
    out_rgb[1] = lumen_effect_apply_level_q8(base[1], level);
    out_rgb[2] = lumen_effect_apply_level_q8(base[2], level);
}

/* ---------------- #31 彩虹 / 流光 ---------------- */

uint16_t lumen_layer_rainbow_hue(const lumen_effect_layer_t *layer, uint16_t n, uint16_t i,
                                 uint32_t t0_ms, uint32_t now_ms)
{
    if (layer == NULL || n == 0 || i >= n) {
        return 0;
    }
    uint16_t hue = lumen_layer_hue(layer);
    uint16_t period_ms = lumen_layer_period_ms(layer);
    uint8_t span = lumen_layer_p5(layer);
    uint8_t flags = lumen_layer_flags(layer);

    /* 相位与呼吸共用同一个 helper（同一条 §6 的 uint64 公式）。 */
    uint32_t phase_q16 = lumen_effect_breathing_phase_q16(period_ms, t0_ms, now_ms);

    /*
     * 空间项 = (i/N) × (span/255) × 65536，Q16。
     *
     * **这一步就是 ticket 点名的溢出点。** 把两个比例都写成 Q16 再相乘是
     * 最自然的写法：
     *   pos_q16  = (i << 16) / N        → i = N-1 时 64880（N = 100，#72 上限）
     *   span_q16 = span × 65536 / 255   → span = 255 时正好 65536
     * 两者的 32 位乘积是 64880 × 65536 = 4,251,975,680，虽然还没越界，
     * 但距 2^32 = 4,294,967,296 只剩约 1.0%，**再加 hue 与相位就翻车**；
     * 而且任何一步多乘一个 65536（把已经是 Q16 的相位再换算一次）、或改了
     * 先乘后除的顺序，都会静默回绕成错色。上限从 64 抬到 100 只会让这点余量
     * 更紧（64 时是 1.6%），结论不变：**不能走 32 位两段式**。
     *
     * 这里改成一次性 uint64 乘除：i ≤ 99、span ≤ 255、65536
     * → 上界 1.65e9，在 64 位下留出 10 个数量级的余量，且只做一次除法、
     * 取整误差最小。
     */
    uint64_t spatial_q16 = ((uint64_t)i * (uint64_t)span * 65536u) / ((uint64_t)n * 255u);

    /*
     * hue(≤65535) + phase_q16(≤65535) + spatial(≤65536) 用 int64_t 累加，
     * 最后一次性对 65536 取模。相位本身已经是「一整圈 = 65536」的刻度，
     * 所以这里**不能再乘 65536**——那是把 Q16 相位当成 [0,1) 的比例再换算
     * 一次的典型 bug，会造出 4.29e9 级的中间量并回绕。取模放在最后，
     * 满周期跑完不会出现颜色突然跳回，也不会因为溢出变成错色。
     */
    int64_t total = (int64_t)hue + (int64_t)phase_q16;
    if ((flags & 0x01u) != 0u) {
        total -= (int64_t)spatial_q16; /* reverse：色相沿灯带递减 */
    } else {
        total += (int64_t)spatial_q16;
    }
    total %= 65536;
    if (total < 0) {
        total += 65536;
    }
    return (uint16_t)total;
}

/* 查 exp(-3 × k/64) 表（Q16），k 由 0..65536 的 Q16 参数给出。 */
static uint32_t comet_exp_q16(uint32_t ratio_q16)
{
    if (!s_sine_ready) {
        lumen_effects_init();
    }
    uint32_t p = ratio_q16 & 0xFFFFu;
    uint32_t index = p / LUMEN_EXP_STEP_Q16;
    uint32_t frac = p - index * LUMEN_EXP_STEP_Q16; /* 0..1023 */
    if (index >= LUMEN_EXP_TABLE_SIZE) {
        return s_comet_exp[LUMEN_EXP_TABLE_SIZE];
    }
    /* 表单调递减（hi ≤ lo），差值必须走有符号，否则下溢成巨正数。 */
    int32_t lo = (int32_t)s_comet_exp[index];
    int32_t hi = (int32_t)s_comet_exp[index + 1u];
    int32_t interpolated = lo + ((hi - lo) * (int32_t)frac + 512) / 1024;
    if (interpolated < 0) {
        interpolated = 0;
    } else if (interpolated > 65535) {
        interpolated = 65535;
    }
    return (uint32_t)interpolated;
}

/* 单个流星头的权重（p_q16 = 该头相对当前位置的「落后量」，[0,1)）。 */
static uint32_t comet_head_gain_q16(uint32_t p_q16, uint32_t tail_n_q16, uint16_t n,
                                    bool solid_tail)
{
    /*
     * 尾部判定 p_i < tail_n/N ⇔ p_i × N < tail_n（两边同乘 N 消掉除法）。
     * p_i 与 tail_n/N 都是 Q16，乘法后 p ≤ 65535、N ≤ 100 → 6.55e6，uint64 下
     * 更不会溢出，且保持严格小于（p == tail_n/N 的灯不亮，硬边界）。
     */
    if ((uint64_t)p_q16 * (uint64_t)n >= (uint64_t)tail_n_q16) {
        return 0;
    }
    if (solid_tail) {
        /*
         * 实色拖尾（flags bit1）：整条尾巴同一个亮度，但**头部一颗必须更亮**，
         * 否则头与尾糊成一条同亮的块，看不出「流星在往哪儿跑」。
         *
         * p_i 是「落后头部多少圈」，所以离头最近的灯是 min(p, 1-p)。
         * 用**半颗灯**的窗口判定头：任何相位下每个头都恰好只有一颗灯满足，
         * 头因此不会在帧与帧之间「消失一下」（20fps 下头部每帧跳 1..N 颗，
         * 用 p < 1/N 的窗口会让大部分帧没有头）。
         */
        uint32_t dist_q16 = p_q16 < 32768u ? p_q16 : (65536u - p_q16);
        if (dist_q16 * 2u < (uint32_t)(65536u / n)) {
            return 65535u;
        }
        return LUMEN_COMET_SOLID_TAIL_GAIN_Q16;
    }
    /*
     * r = p_i / (tail_n/N) = p_i × N / tail_n ∈ [0,1)，Q16。
     * 指数参数是 3r，而表以 k/64 为步长（k = 64r，这里的 64 是**查表步数**，
     * 与灯珠上限无关），所以 r 的 Q16 值**直接**就是表的输入
     * （65536 ↔ k=64）——不需要再乘 3 或除 64。
     * 中间量 p ≤ 65535、N ≤ 100、65536 → 4.29e11，必须走 uint64。
     */
    uint32_t r_q16 = (uint32_t)(((uint64_t)p_q16 * (uint64_t)n * 65536u) / (uint64_t)tail_n_q16);
    return comet_exp_q16(r_q16);
}

uint32_t lumen_layer_comet_gain_q16(const lumen_effect_layer_t *layer, uint16_t n, uint16_t i,
                                    uint32_t t0_ms, uint32_t now_ms)
{
    if (layer == NULL || n == 0 || i >= n) {
        return 0;
    }
    uint16_t period_ms = lumen_layer_period_ms(layer);
    uint8_t tail = lumen_layer_p5(layer);
    uint8_t flags = lumen_layer_flags(layer);

    /*
     * reverse（flags bit0）用镜像段内下标实现：头部从高索引走向低索引，
     * 与整条图案反向等价，不需要在公式里改符号。
     */
    if ((flags & LUMEN_COMET_FLAG_REVERSE) != 0u) {
        i = (uint16_t)(n - 1u - i);
    }

    /*
     * #98：头数量 = (flags bit2-3) + 1，1..4 个，沿整条**均分**间距。
     * 每个头都是同一条公式，只是相位偏移 k/d；最终**取最大值**合成，
     * 绝不相加——两个头的尾巴重叠时相加会让那一小段亮度翻倍。
     */
    uint8_t heads = (uint8_t)(((flags & LUMEN_COMET_DENSITY_MASK) >> LUMEN_COMET_DENSITY_SHIFT) +
                              1u);
    bool solid_tail = (flags & LUMEN_COMET_FLAG_SOLID_TAIL) != 0u;

    /* p_i = ((i/N) - phase) mod 1，Q16。 */
    uint32_t phase_q16 = lumen_effect_breathing_phase_q16(period_ms, t0_ms, now_ms);
    uint32_t pos_q16 = (uint32_t)(((uint64_t)i << 16) / n); /* i/N ∈ [0,1) */

    /*
     * tail_n = 1 + (tail/255) × (N-1)，用 Q16 表示（65536 = 1 颗灯）：
     *   tail = 0   → tail_n_q16 = 65536          → 只有头部一颗灯
     *   tail = 255 → tail_n_q16 = N × 65536      → 整条都是尾巴
     * (tail/255)×(N-1) 的最大值 99×65536 = 6.49e6，uint32 够，但乘 tail
     * 时先到 255×99×65536 ≈ 1.65e9，仍安全（2^32 ≈ 4.29e9）；保险起见
     * 用 uint64 相乘。
     */
    uint32_t tail_n_q16 =
        65536u + (uint32_t)(((uint64_t)tail * (uint64_t)(n - 1u) * 65536u) / 255u);

    uint32_t best = 0;
    for (uint8_t k = 0; k < heads; ++k) {
        /*
         * 第 k 个头领先相位 k/d 圈，**取整到整颗灯**：
         *   head_pos = round(k × N / d)     // 0..N-1，间距均分
         * 不取整的话 N 不能被 d 整除时各头会落在两颗灯之间，峰值亮度互不相同
         * （一颗满亮、另一颗只有七成），看起来像「几个头不一样亮」。取整后
         * 所有头在同一时刻的亚像素偏移一致，亮度因此始终对齐。
         * +2×65536 只保证减法不借位（两项都 < 65536）。
         */
        uint32_t head_pos = ((uint32_t)k * (uint32_t)n + (uint32_t)heads / 2u) /
                            (uint32_t)heads;
        uint32_t head_off = (uint32_t)(((uint64_t)head_pos << 16) / n);
        uint32_t p_q16 = (pos_q16 + 2u * 65536u - phase_q16 - head_off) & 0xFFFFu;
        uint32_t gain = comet_head_gain_q16(p_q16, tail_n_q16, n, solid_tail);
        if (gain > best) {
            best = gain;
        }
    }
    return best;
}

/* 段 layer[0] 上的便捷包装（旧签名）。 */
uint16_t lumen_effect_rainbow_hue(const lumen_segment_t *seg, uint16_t index_in_strip,
                                  uint32_t now_ms)
{
    if (seg == NULL || !seg->active || seg->end < seg->start) {
        return 0;
    }
    if (index_in_strip < seg->start || index_in_strip > seg->end) {
        return 0;
    }
    uint16_t n = lumen_effect_segment_length(seg);
    if (n == 0) {
        return 0;
    }
    return lumen_layer_rainbow_hue(&seg->layer[0], n,
                                   lumen_effect_index_in_segment(seg, index_in_strip),
                                   seg->t0_ms, now_ms);
}

uint32_t lumen_effect_comet_gain_q16(const lumen_segment_t *seg, uint16_t index_in_strip,
                                     uint32_t now_ms)
{
    if (seg == NULL || !seg->active || seg->end < seg->start) {
        return 0;
    }
    if (index_in_strip < seg->start || index_in_strip > seg->end) {
        return 0;
    }
    uint16_t n = lumen_effect_segment_length(seg);
    if (n == 0) {
        return 0;
    }
    return lumen_layer_comet_gain_q16(&seg->layer[0], n,
                                      lumen_effect_index_in_segment(seg, index_in_strip),
                                      seg->t0_ms, now_ms);
}

/* ---------------- 单层 / 整段求值 ---------------- */

void lumen_layer_pixel(const lumen_segment_t *seg, uint8_t layer_index,
                       uint16_t index_in_strip, uint32_t now_ms, uint8_t out_rgb[3])
{
    if (out_rgb == NULL) {
        return;
    }
    out_rgb[0] = 0;
    out_rgb[1] = 0;
    out_rgb[2] = 0;

    if (seg == NULL || !seg->active || layer_index >= 2u) {
        return;
    }
    /* 越界下标不写像素：合成层只遍历段区间，这里是防御。 */
    if (index_in_strip < seg->start || index_in_strip > seg->end) {
        return;
    }

    const lumen_effect_layer_t *layer = &seg->layer[layer_index];
    if (layer->type == LUMEN_LAYER_EMPTY) {
        return; /* 空层：透明，输出全黑（blend 的语义由调用方决定）。 */
    }

    uint16_t hue = lumen_layer_hue(layer);
    uint8_t sat = lumen_layer_sat(layer);
    uint16_t n = lumen_effect_segment_length(seg);
    uint16_t i = lumen_effect_index_in_segment(seg, index_in_strip);
    uint8_t level = layer->level;

    switch (layer->type) {
    case LUMEN_EFFECT_STATIC: {
        /* 整段同色，与位置和时间无关（§3.1）。 */
        uint8_t base[3];
        lumen_effect_static_rgb(hue, sat, base);
        scale_pixel_level(base, level, out_rgb);
        return;
    }

    case LUMEN_EFFECT_BREATHING: {
        /*
         * 整段同色同步呼吸：包络只与时间有关，与段内位置无关（§3.2 的
         * RGB_i 对所有 i 相同）。两层共用 seg->t0_ms，所以同步呼吸。
         *
         * v4：p5 是**相对百分比**，谷底 = 本层 level × min_pct%。绝对电平
         * 缩放已经并进 gain（见 lumen_effect_breathing_gain_pct_q16），
         * 所以这里不再单独乘 level——否则会乘两次。
         */
        uint8_t base[3];
        lumen_effect_static_rgb(hue, sat, base);
        uint8_t waveform = (uint8_t)((lumen_layer_flags(layer) >> 1) & 0x03u);
        uint32_t gain = lumen_effect_breathing_gain_pct_q16(
            lumen_layer_period_ms(layer), lumen_layer_p5(layer), level, waveform, seg->t0_ms,
            now_ms);
        scale_pixel(base, gain, out_rgb);
        return;
    }

    case LUMEN_EFFECT_RAINBOW: {
        /*
         * 彩虹（§3.3）：色相随段内位置与时间变化，sat 恒定。
         * span = 0 → 整条同色、色相随时间循环；span = 255 → 铺满一整圈、
         * 随时间平移。中间值连续可调（spatial 项是线性的）。
         */
        uint16_t rainbow_hue = lumen_layer_rainbow_hue(layer, n, i, seg->t0_ms, now_ms);
        uint8_t base[3];
        lumen_effect_static_rgb(rainbow_hue, sat, base);
        scale_pixel_level(base, level, out_rgb);
        return;
    }

    case LUMEN_EFFECT_COMET: {
        /*
         * 流光（§3.4）：基色恒定，亮度权重随「离亮点的距离」指数衰减。
         * tail = 0 → 硬边（只有头部那一颗灯）；tail = 255 → 整条都是尾。
         * reverse 通过镜像段内下标实现，见 lumen_layer_comet_gain_q16。
         * 层亮度与流光增益**相乘**（先按 level 压暗基色，再乘尾权重）。
         */
        uint8_t base[3];
        lumen_effect_static_rgb(hue, sat, base);
        uint32_t gain = lumen_layer_comet_gain_q16(layer, n, i, seg->t0_ms, now_ms);
        uint8_t scaled_base[3];
        scale_pixel_level(base, level, scaled_base);
        scale_pixel(scaled_base, gain, out_rgb);
        return;
    }

    case LUMEN_EFFECT_STROBE: {
        /*
         * 爆闪（§2.5）：基色恒定，亮度按方波包络切换。duty（p5）是高电平
         * 占一个周期的比例；flags 恒为 0（命令层已拒绝非 0）。
         * 与流光一致：先按本层 level 压暗基色，再乘包络增益。
         */
        uint8_t base[3];
        lumen_effect_static_rgb(hue, sat, base);
        uint32_t gain = lumen_effect_strobe_gain_q16(lumen_layer_period_ms(layer),
                                                     lumen_layer_p5(layer), seg->t0_ms, now_ms);
        uint8_t scaled_base[3];
        scale_pixel_level(base, level, scaled_base);
        scale_pixel(scaled_base, gain, out_rgb);
        return;
    }

    case LUMEN_EFFECT_HEARTBEAT: {
        /*
         * 心跳（§2.6）：同上，包络换成「一大一小两次脉冲」。
         * p5（pulse）是单次脉冲宽度占比；flags bit0 = 双脉冲开关。
         */
        uint8_t base[3];
        lumen_effect_static_rgb(hue, sat, base);
        bool double_pulse = (lumen_layer_flags(layer) & 0x01u) != 0u;
        uint32_t gain = lumen_effect_heartbeat_gain_q16(
            lumen_layer_period_ms(layer), lumen_layer_p5(layer), double_pulse, seg->t0_ms, now_ms);
        uint8_t scaled_base[3];
        scale_pixel_level(base, level, scaled_base);
        scale_pixel(scaled_base, gain, out_rgb);
        return;
    }

    case LUMEN_EFFECT_FLICKER: {
        /*
         * 随机闪烁（#98）：基色恒定，每颗灯按自己的哈希相位独立亮灭。
         * p5 是同时亮着的比例；period 与呼吸同一条下限（334ms）。
         * 与爆闪一致：先按本层 level 压暗基色，再乘方波增益。
         */
        uint8_t base[3];
        lumen_effect_static_rgb(hue, sat, base);
        uint32_t gain = lumen_effect_flicker_gain_q16(lumen_layer_period_ms(layer),
                                                     lumen_layer_p5(layer), i, n, seg->t0_ms,
                                                     now_ms);
        uint8_t scaled_base[3];
        scale_pixel_level(base, level, scaled_base);
        scale_pixel(scaled_base, gain, out_rgb);
        return;
    }

    case LUMEN_EFFECT_OFF:
        /*
         * 熄灭（§2.7）：永不发光。out_rgb 进来时已清零，**直接返回**——
         * 不读 hue/sat/period，也不受 level 影响（参数在命令层已要求全 0）。
         */
        return;

    default:
        /* 未知类型：命令层已按 D7 拒绝（InvalidParam），这里同样只返回黑色。 */
        return;
    }
}

void lumen_effect_pixel(const lumen_segment_t *seg, uint16_t index_in_strip, uint32_t now_ms,
                        uint8_t out_rgb[3])
{
    if (out_rgb == NULL) {
        return;
    }
    out_rgb[0] = 0;
    out_rgb[1] = 0;
    out_rgb[2] = 0;

    if (seg == NULL || !seg->active) {
        return;
    }
    if (index_in_strip < seg->start || index_in_strip > seg->end) {
        return;
    }

    /* layer[0] 必须先有值（命令层保证）；这里仍按「空 = 全黑」防御。 */
    uint8_t l0[3] = {0, 0, 0};
    lumen_layer_pixel(seg, 0, index_in_strip, now_ms, l0);

    /* 单层段（layer1 = 0xFF）：直接交出 layer0，与 v2 逐字节一致。 */
    if (lumen_layer_is_empty(&seg->layer[1])) {
        memcpy(out_rgb, l0, 3);
        return;
    }

    uint8_t l1[3] = {0, 0, 0};
    lumen_layer_pixel(seg, 1, index_in_strip, now_ms, l1);
    lumen_blend_pixel(seg->blend, l0, l1, out_rgb);
}
