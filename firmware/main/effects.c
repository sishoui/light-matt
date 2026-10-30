#include "effects.h"

#include <stddef.h>

/*
 * 灯效像素计算，整数定点，无浮点（C3 无 FPU）。
 *
 * hue 是 0-65535 的一整圈（D2），分成 6 个 60° 扇区：
 *   sector = (hue * 6) / 65536        -> 0..5
 *   frac   = (hue * 6) % 65536        -> 扇区内的 Q16 位置
 * V 恒为 1，所以 C = sat（0-255 刻度），m = 255 - sat。
 * 每颗灯的结果都是用户空间 RGB（0-255），gamma 与亮度由渲染层施加。
 */

bool lumen_effect_type_known(uint8_t type)
{
    switch (type) {
    case LUMEN_EFFECT_STATIC:
    case LUMEN_EFFECT_BREATHING:
    case LUMEN_EFFECT_RAINBOW:
    case LUMEN_EFFECT_COMET:
        return true;
    default:
        return false;
    }
}

bool lumen_effect_type_implemented(uint8_t type)
{
    /* #25 只交付静态；动画类型由 #30 / #31 实现。未实现的类型必须在命令层
     * 就被拒绝（UnknownCommand），绝不静默变黑——所以这里如实返回 false。 */
    return type == LUMEN_EFFECT_STATIC;
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
        /* §2.2-§2.4：hue(2) + sat(1) + period(2) + p5(1) + flags(1)。 */
        return 7;
    default:
        return 0;
    }
}

bool lumen_effect_is_animated(uint8_t type)
{
    return type != LUMEN_EFFECT_STATIC;
}

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
    /* 越界下标不写像素：合成层只遍历段区间，这里是防御。 */
    if (index_in_strip < seg->start || index_in_strip > seg->end) {
        return;
    }

    switch (seg->type) {
    case LUMEN_EFFECT_STATIC:
        /* 整段同色，与位置和时间无关（§3.1）。 */
        lumen_effect_static_rgb(seg->hue, seg->sat, out_rgb);
        return;

    case LUMEN_EFFECT_BREATHING:
    case LUMEN_EFFECT_RAINBOW:
    case LUMEN_EFFECT_COMET:
        /*
         * 动画分支由 #30 / #31 实现。命令层目前不接受这三类
         * （lumen_effect_type_implemented == false），所以正常路径走不到这里。
         * 返回黑色是防御，不是降级路径：让误配置在真机上表现为熄灭而不是乱色。
         */
        (void)now_ms;
        return;

    default:
        /* 未知类型：命令层已按 D7 拒绝（InvalidParam），这里同样只返回黑色。 */
        return;
    }
}
