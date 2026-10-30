#include "effects.h"

#include <math.h>
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
    /* 四种类型全部有像素实现（#25 静态 / #30 呼吸 / #31 彩虹+流光）。
     * 未知类型仍由 lumen_effect_type_known 在命令层拒绝（InvalidParam），
     * 这里不负责区分「已知但未实现」——那个中间态已经不存在了。 */
    return type == LUMEN_EFFECT_STATIC || type == LUMEN_EFFECT_BREATHING ||
           type == LUMEN_EFFECT_RAINBOW || type == LUMEN_EFFECT_COMET;
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

uint8_t lumen_effect_apply_gain_q16(uint8_t value, uint32_t gain_q16)
{
    if (gain_q16 >= 65535u) {
        return value;
    }
    uint32_t scaled = (uint32_t)value * gain_q16;
    return (uint8_t)((scaled + 32767u) / 65535u);
}

/* 把基础色按 Q16 增益缩放（四舍五入）。 */
static void breathing_pixel(const lumen_segment_t *seg, uint32_t now_ms, uint8_t out_rgb[3])
{
    uint8_t base[3];
    lumen_effect_static_rgb(seg->hue, seg->sat, base);

    uint8_t waveform = (uint8_t)((seg->flags >> 1) & 0x03u);
    uint32_t gain = lumen_effect_breathing_gain_q16(seg->period_ms, seg->p5, waveform,
                                                    seg->t0_ms, now_ms);
    out_rgb[0] = lumen_effect_apply_gain_q16(base[0], gain);
    out_rgb[1] = lumen_effect_apply_gain_q16(base[1], gain);
    out_rgb[2] = lumen_effect_apply_gain_q16(base[2], gain);
}

/* 把基础色按 Q16 增益缩放（四舍五入）；流光复用。 */
static void scale_pixel(uint8_t base[3], uint32_t gain_q16, uint8_t out_rgb[3])
{
    out_rgb[0] = lumen_effect_apply_gain_q16(base[0], gain_q16);
    out_rgb[1] = lumen_effect_apply_gain_q16(base[1], gain_q16);
    out_rgb[2] = lumen_effect_apply_gain_q16(base[2], gain_q16);
}

/* ---------------- #31 彩虹 / 流光 ---------------- */

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
    uint16_t i = lumen_effect_index_in_segment(seg, index_in_strip);

    /* 相位与呼吸共用同一个 helper（同一条 §6 的 uint64 公式）。 */
    uint32_t phase_q16 = lumen_effect_breathing_phase_q16(seg->period_ms, seg->t0_ms, now_ms);

    /*
     * 空间项 = (i/N) × (span/255) × 65536，Q16。
     *
     * **这一步就是 ticket 点名的溢出点。** 把两个比例都写成 Q16 再相乘是
     * 最自然的写法：
     *   pos_q16  = (i << 16) / N        → 最大 65535（i = N-1）
     *   span_q16 = span × 65536 / 255   → span = 255 时正好 65536
     * 两者的 32 位乘积最大是 (N-1)/N × 2^32，N = 64 时 4,228,792,320，
     * **距 uint32 上限只剩 1.5%**：任何一个四舍五入项（+半个除数）、
     * 换一种先乘后除的顺序、或再多乘一个 65536（把 Q16 当成比例再乘一次）
     * 都会越界并静默回绕成错色。
     *
     * 这里改成一次性 uint64 乘除：i ≤ 63、span ≤ 255、65536 → 上界 1.05e9，
     * 在 64 位下留出 4 个数量级的余量，且只做一次除法、取整误差最小。
     */
    uint64_t spatial_q16 =
        ((uint64_t)i * (uint64_t)seg->p5 * 65536u) / ((uint64_t)n * 255u);

    /*
     * hue(≤65535) + phase_q16(≤65535) + spatial(≤65536) 用 int64_t 累加，
     * 最后一次性对 65536 取模。相位本身已经是「一整圈 = 65536」的刻度，
     * 所以这里**不能再乘 65536**——那是把 Q16 相位当成 [0,1) 的比例再换算
     * 一次的典型 bug，会造出 4.29e9 级的中间量并回绕。取模放在最后，
     * 满周期跑完不会出现颜色突然跳回，也不会因为溢出变成错色。
     */
    int64_t total = (int64_t)seg->hue + (int64_t)phase_q16;
    if ((seg->flags & 0x01u) != 0u) {
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
    uint16_t i = lumen_effect_index_in_segment(seg, index_in_strip);

    /*
     * reverse（flags bit0）用镜像段内下标实现：头部从高索引走向低索引，
     * 与整条图案反向等价，不需要在公式里改符号。
     */
    if ((seg->flags & 0x01u) != 0u) {
        i = (uint16_t)(n - 1u - i);
    }

    /* p_i = ((i/N) - phase) mod 1，Q16。 */
    uint32_t phase_q16 = lumen_effect_breathing_phase_q16(seg->period_ms, seg->t0_ms, now_ms);
    uint32_t pos_q16 = (uint32_t)(((uint64_t)i << 16) / n); /* i/N ∈ [0,1) */
    uint32_t p_q16 = (pos_q16 + 65536u - phase_q16) & 0xFFFFu;

    /*
     * tail_n = 1 + (tail/255) × (N-1)，用 Q16 表示（65536 = 1 颗灯）：
     *   tail = 0   → tail_n_q16 = 65536          → 只有头部一颗灯
     *   tail = 255 → tail_n_q16 = N × 65536      → 整条都是尾巴
     * (tail/255)×(N-1) 的最大值 63×65536 = 4.13e6，uint32 够，但乘 tail
     * 时先到 255×63×65536 ≈ 1.05e9，仍安全；保险起见用 uint64 相乘。
     */
    uint32_t tail_n_q16 =
        65536u + (uint32_t)(((uint64_t)seg->p5 * (uint64_t)(n - 1u) * 65536u) / 255u);

    /*
     * 尾部判定 p_i < tail_n/N ⇔ p_i × N < tail_n（两边同乘 N 消掉除法）。
     * p_i 与 tail_n/N 都是 Q16，乘法后 p ≤ 65535、N ≤ 64 → 4.19e6，uint64 下
     * 更不会溢出，且保持严格小于（p == tail_n/N 的灯不亮，硬边界）。
     */
    if ((uint64_t)p_q16 * (uint64_t)n >= (uint64_t)tail_n_q16) {
        return 0;
    }

    /*
     * r = p_i / (tail_n/N) = p_i × N / tail_n ∈ [0,1)，Q16。
     * 指数参数是 3r，而表以 k/64 为步长（k = 64r），所以 r 的 Q16 值
     * **直接**就是表的输入（65536 ↔ k=64）——不需要再乘 3 或除 64。
     */
    uint32_t r_q16 = (uint32_t)(((uint64_t)p_q16 * (uint64_t)n * 65536u) / (uint64_t)tail_n_q16);
    return comet_exp_q16(r_q16);
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
        /*
         * 整段同色同步呼吸：包络只与时间有关，与段内位置无关（§3.2 的
         * RGB_i 对所有 i 相同）。段间相位因 t0_ms 不同而独立（D4）。
         */
        breathing_pixel(seg, now_ms, out_rgb);
        return;

    case LUMEN_EFFECT_RAINBOW: {
        /*
         * 彩虹（§3.3）：色相随段内位置与时间变化，sat 恒定。
         * span = 0 → 整条同色、色相随时间循环；span = 255 → 铺满一整圈、
         * 随时间平移。中间值连续可调（spatial 项是线性的）。
         */
        uint16_t hue = lumen_effect_rainbow_hue(seg, index_in_strip, now_ms);
        lumen_effect_static_rgb(hue, seg->sat, out_rgb);
        return;
    }

    case LUMEN_EFFECT_COMET: {
        /*
         * 流光（§3.4）：基色恒定，亮度权重随「离亮点的距离」指数衰减。
         * tail = 0 → 硬边（只有头部那一颗灯）；tail = 255 → 整条都是尾。
         * reverse 通过镜像段内下标实现，见 lumen_effect_comet_gain_q16。
         */
        uint8_t base[3];
        lumen_effect_static_rgb(seg->hue, seg->sat, base);
        uint32_t gain = lumen_effect_comet_gain_q16(seg, index_in_strip, now_ms);
        scale_pixel(base, gain, out_rgb);
        return;
    }

    default:
        /* 未知类型：命令层已按 D7 拒绝（InvalidParam），这里同样只返回黑色。 */
        return;
    }
}
