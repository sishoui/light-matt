#pragma once

#include <stdbool.h>
#include <stdint.h>

/*
 * 灯效像素计算（纯函数，无 ESP-IDF 头，可在 host 上直接单测）。
 *
 * 架构见 docs/v2-effects-engine.md §4/§5：
 *  - 本模块只做「类型 + 参数 + 段内灯珠下标 + 当前时刻 → 用户空间 RGB」；
 *  - **不做 gamma、不乘亮度**——那是渲染层（led_render）的职责；
 *  - 未知类型不得静默降级：命令层已经拒绝（D7），这里的 default 只是防御。
 *
 * #25 交付静态单色（type 0x00），#30 加入呼吸（type 0x01）。彩虹 / 流光的像素
 * 分支由 #31 加入，在那之前命令层把这两个类型当作「尚未实现」，回 UnknownCommand
 * （不静默变黑）。
 */

/* 段类型（docs/effects-spec.md §2）。 */
typedef enum {
    LUMEN_EFFECT_STATIC = 0x00,
    LUMEN_EFFECT_BREATHING = 0x01,
    LUMEN_EFFECT_RAINBOW = 0x02,
    LUMEN_EFFECT_COMET = 0x03,
} lumen_effect_type_t;

/* 呼吸波形（flags bit1-2，docs/effects-spec.md §2.2）。 */
typedef enum {
    LUMEN_WAVE_SINE = 0,
    LUMEN_WAVE_TRIANGLE = 1,
    LUMEN_WAVE_SAWTOOTH = 2,
    LUMEN_WAVE_SQUARE = 3,
} lumen_effect_waveform_t;

/*
 * 呼吸周期下限（effects-spec §5）：334ms ≈ 3Hz，光敏性癫痫安全线。
 * period_ms == 0 是「静止」，不受此限。
 */
#define LUMEN_BREATHING_MIN_PERIOD_MS 334u

/*
 * 彩虹 / 流光周期下限（effects-spec §5）：200ms = 5Hz。
 * 这两类是**空间移动**而不是亮度闪烁，所以比呼吸宽松（D5）。
 * period_ms == 0 同样是「静止」。
 */
#define LUMEN_RAINBOW_MIN_PERIOD_MS 200u

/*
 * 建正弦查表的初始化（#30）。
 *
 * 沿用 gamma.c 的先例：**只在初始化时**用 math.h 建表，运行时只查表，
 * 所以渲染路径里没有任何浮点（C3 没有 FPU）。幂等。
 * 未调用时查表函数会惰性补建，host 测试因此不依赖调用顺序。
 */
void lumen_effects_init(void);

/*
 * 段的配置快照（与 docs/v2-effects-engine.md §4.1 一致）。
 *
 * 定义在 effects.h 而不是 segment_store.h：effects 是最底层纯模块，
 * segment_store 依赖它（合成时逐颗调用 lumen_effect_pixel），不能反过来。
 *
 * t0_ms 是「本段配置生效时刻」，相位只由 (now_ms - t0_ms) 算出，不存相位变量
 * （§5.1）。静态灯效不使用它，但保留字段供 #30/#31 复用，避免改写协议/存储层。
 */
typedef struct {
    bool active;
    uint8_t start;     /* 闭区间起点 */
    uint8_t end;       /* 闭区间终点，必须 < led_count */
    uint8_t type;      /* 0x00 静态 / 0x01 呼吸 / 0x02 彩虹 / 0x03 流光 */
    uint16_t hue;      /* 0-65535 */
    uint8_t sat;       /* 0-255 */
    uint16_t period_ms;/* 0 = 静止；动画类才用 */
    uint8_t p5;        /* min_level / span / tail，按 type 解释 */
    uint8_t flags;     /* 动画类保留位；静态类恒 0 */
    uint32_t t0_ms;    /* 配置生效时刻（毫秒，可回绕） */
} lumen_segment_t;

/* type 是否属于协议定义的四种之一（docs/effects-spec.md §2）。 */
bool lumen_effect_type_known(uint8_t type);

/* type 是否已经有像素实现。当前是静态 + 呼吸；彩虹 / 流光由 #31 打开。 */
bool lumen_effect_type_implemented(uint8_t type);

/* 该类型的参数块长度：静态 3，动画 7，未知 0（docs/effects-spec.md §2.5）。 */
uint8_t lumen_effect_param_len(uint8_t type);

/* type != 0x00。帧循环的判据（§3.1；由 segment_store_needs_frames 汇总）。 */
bool lumen_effect_is_animated(uint8_t type);

/* 段内灯珠数（彩虹 / 流光需要 N）。非活动段返回 0。 */
uint16_t lumen_effect_segment_length(const lumen_segment_t *seg);

/* 段内灯珠数所需的另一种写法：给 index_in_strip 与段区间算段内偏移。 */
uint16_t lumen_effect_index_in_segment(const lumen_segment_t *seg, uint16_t index_in_strip);

/*
 * 计算一颗灯的用户空间 RGB（0-255，不含 gamma / 亮度）。
 * now_ms 与 seg->t0_ms 同基准。静态灯效忽略 now_ms。
 */
void lumen_effect_pixel(const lumen_segment_t *seg, uint16_t index_in_strip, uint32_t now_ms,
                        uint8_t out_rgb[3]);

/*
 * hue(0-65535) + sat(0-255) → 用户空间 RGB（V 恒为 1）。
 * 单独暴露：State 字节 2-4 的「seg 0 基准色」与测试都直接用它。
 */
void lumen_effect_static_rgb(uint16_t hue, uint8_t sat, uint8_t out_rgb[3]);

/* ---------------- #30 呼吸 ---------------- */

/*
 * 段内相位，Q16（0..65535 表示 [0,1)）。
 *
 * 严格按 docs/effects-spec.md §6：
 *   r        = (now_ms - t0_ms) % period_ms      // 无符号减法，先取模
 *   phase_q16 = (uint32_t)(((uint64_t)r << 16) / period_ms)
 *
 * **内部用 uint64_t 中间量**：period_ms = 65535 时 r 最大 65534，
 * 65534 << 16 = 4294836224，距 2^32 只剩 131072 的余量——32 位写法任何
 * 微小偏差都会翻车。period_ms == 0 时返回 0（§3.2：静止于相位 0）。
 */
uint32_t lumen_effect_breathing_phase_q16(uint16_t period_ms, uint32_t t0_ms, uint32_t now_ms);

/*
 * 波形包络 e(phase)，Q16（0..65535），phase_q16 ∈ [0,65536)。
 *
 *  - 正弦  0.5 × (1 - cos(2πp)) → 查表 + 线性插值（表在初始化时用 math.h 建）
 *  - 三角  1 - |2p - 1|
 *  - 锯齿  p
 *  - 方波  前半周期为 1、后半为 0，上升沿与下降沿各留 10% 线性斜坡
 *          （梯形，首尾连续：p=0 与 p=1 都为 0）
 *
 * 未知 waveform 值按正弦处理（命令层已按 flags 保留位拒绝非法组合）。
 */
uint16_t lumen_effect_breathing_envelope_q16(uint32_t phase_q16, uint8_t waveform);

/*
 * 叠加最暗基线后的增益 e'，Q16：
 *   e' = min_level/255 + (1 - min_level/255) × e
 *
 * min_level = 0 → 能暗到全黑；min_level = 255 → 恒为满亮（几乎不呼吸）。
 */
uint32_t lumen_effect_breathing_gain_q16(uint16_t period_ms, uint8_t min_level,
                                         uint8_t waveform, uint32_t t0_ms, uint32_t now_ms);

/* 用 Q16 增益缩放一个用户空间通道（四舍五入），0..255 输入输出。 */
uint8_t lumen_effect_apply_gain_q16(uint8_t value, uint32_t gain_q16);

/* ---------------- #31 彩虹 / 流光 ---------------- */

/*
 * 彩虹：段内某颗灯的色相（0-65535），effects-spec §3.3：
 *
 *   hue_i = hue + phase × 65536 + (i/N) × (span/255) × 65536 × dir   (mod 65536)
 *
 *  - span = 0   → 整条同色，色相随时间循环；
 *  - span = 255 → 沿灯带铺满一整圈，随时间平移；
 *  - dir = reverse ? -1 : +1（flags bit0）。
 *
 * 单独暴露是为了让 host 测试能直接断言色相算术本身：像素颜色只有 6 个
 * 扇区，分辨率不足以发现 32 位溢出导致的错位。
 *
 * **溢出**：`(i/N) × (span/255) × 65536` 写成 `i × span × 65536` 时
 * i ≤ 63、span ≤ 255 → 上界 1.05e9，看似还在 uint32 内，但任何先生成
 * 「(span/255)×65536 ≈ 65536」中间量再乘 i 的写法都会在 i 较大、N 较小时
 * 越界。这里统一用 uint64_t 算乘积再除，最后才取模——零成本，不要优化掉。
 * 段无效或下标越界返回 0。
 */
uint16_t lumen_effect_rainbow_hue(const lumen_segment_t *seg, uint16_t index_in_strip,
                                  uint32_t now_ms);

/*
 * 流光：段内某颗灯的亮度权重，Q16（0..65535），effects-spec §3.4：
 *
 *   tail_n = 1 + (tail/255) × (N-1)
 *   p_i    = ((i/N) - phase) mod 1
 *   w_i    = p_i < tail_n/N ? exp(-(p_i × N / tail_n) × 3) : 0
 *
 * 指数用初始化时建的 65 点表 + 线性插值（沿用 gamma.c / 正弦表的先例），
 * 运行时零浮点。reverse 通过镜像段内下标实现（把方向反过来）。
 * 段无效或下标越界返回 0。
 */
uint32_t lumen_effect_comet_gain_q16(const lumen_segment_t *seg, uint16_t index_in_strip,
                                     uint32_t now_ms);
