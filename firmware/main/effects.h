#pragma once

#include <stdbool.h>
#include <stdint.h>

/*
 * 灯效像素计算（纯函数，无 ESP-IDF 头，可在 host 上直接单测）。
 *
 * 架构见 docs/v2-effects-engine.md §4/§5 与 docs/protocol-v4.md §7.1/§9.3：
 *  - 本模块只做「类型 + 参数 + 层亮度 + 段内灯珠下标 + 当前时刻 → 用户空间 RGB」；
 *  - **不做 gamma、不乘全局亮度**——那是渲染层（led_render）的职责，且只做一次；
 *  - 未知类型不得静默降级：命令层已经拒绝（D7），这里的 default 只是防御。
 *
 * v3 起段是**两层**：layer[0] 必须有灯效，layer[1] 可以为空层（type = 0xFF）。
 * 两层各自求值（各自按自己的 level 压暗）后按 blend 在**用户空间**合成（§7.2），
 * 合成结果再统一乘全局亮度、过 gamma。
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
 * 层 1 如何叠加到层 0（docs/protocol-v4.md §7.2）。
 * 不支持「取最大值」：与相加视觉重合，规格已明确不做。
 */
typedef enum {
    LUMEN_BLEND_OVER = 0x00,     /* out = L1 */
    LUMEN_BLEND_MULTIPLY = 0x01, /* out = (L0 * L1 + 127) / 255 */
    LUMEN_BLEND_ADD = 0x02,      /* out = min(255, L0 + L1) */
} lumen_blend_mode_t;

#define LUMEN_BLEND_MAX LUMEN_BLEND_ADD

/* 空层标记（docs/protocol-v4.md §7.1）。合法值恰为 0xFF。 */
#define LUMEN_LAYER_EMPTY 0xFF

/* 层亮度档位上限（v4）：0-100，100 = 满亮；> 100 是非法参数。 */
#define LUMEN_LAYER_LEVEL_MAX 100

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
 * 一个灯效层：9 字节定宽（docs/protocol-v4.md §7.1）。
 *
 * param 的语义按 type 解释，沿用 docs/effects-spec.md §2（v4 未改）：
 *   param[0..1] hue(小端) | param[2] sat | param[3..4] period_ms(小端) |
 *   param[5] p5(min_level / span / tail) | param[6] flags
 * 静态层只用前 3 字节，**param[3..6] 必须是 0**（§7.1 第 6 步的保留位）。
 *
 * `level`（v4 新增）是本层的**母亮度** 0-100：< 100 时这一层整体压暗，
 * 0 表示不出光；> 100 是非法参数（命令层拒绝）。空层（type = 0xFF）的
 * level 必须为 0。合成时 level 在**用户空间**逐通道相乘，然后才 blend，
 * 最后统一乘全局亮度并过 gamma（docs/protocol-v4.md §9.3）。
 *
 * 定宽而不是变长：任何未知 type 都能安全判定参数边界，不需要长度表兜底。
 */
typedef struct {
    uint8_t type;
    uint8_t param[7];
    uint8_t level; /* v4：0-100，本层亮度百分比；100 = 满亮 */
} lumen_effect_layer_t;

/*
 * 段的配置快照（与 docs/protocol-v4.md §7.1 一致）。
 *
 * 定义在 effects.h 而不是 segment_store.h：effects 是最底层纯模块，
 * segment_store 依赖它（合成时逐颗调用 lumen_effect_pixel），不能反过来。
 *
 * t0_ms 是「本段配置生效时刻」，**两层共享一个时间原点**（§9.4）；相位只由
 * (now_ms - t0_ms) 算出，不存相位变量（§5.1）。
 *
 * 体积：sizeof(lumen_segment_t) == 28 字节（v3 是 24、v2 是 16）。段表因此
 * 涨到 8 条灯带 × 8 段 × 28 = **1792 字节**。脚本存储同比从 ~61KB 涨到 ~70KB——
 * 这是 v4「逐光区亮度」记录在案的 RAM 代价（见 segment_store.h 的尺寸说明）。
 */
typedef struct {
    bool active;
    uint8_t start; /* 闭区间起点 */
    uint8_t end;   /* 闭区间终点，必须 < 该灯带的 led_count */
    uint8_t blend; /* lumen_blend_mode_t；layer[1] 为空时必须为 0 */
    lumen_effect_layer_t layer[2];
    uint32_t t0_ms; /* 配置生效时刻（毫秒，可回绕）；两层共享 */
} lumen_segment_t;

/*
 * 建正弦 / 指数查表的初始化（#30）。
 *
 * 沿用 gamma.c 的先例：**只在初始化时**用 math.h 建表，运行时只查表，
 * 所以渲染路径里没有任何浮点（C3 没有 FPU）。幂等。
 * 未调用时查表函数会惰性补建，host 测试因此不依赖调用顺序。
 */
void lumen_effects_init(void);

/* type 是否属于协议定义的四种之一（docs/effects-spec.md §2）。 */
bool lumen_effect_type_known(uint8_t type);

/* type 是否已经有像素实现。四种类型全部为真（静态 / 呼吸 / 彩虹 / 流光）。 */
bool lumen_effect_type_implemented(uint8_t type);

/* 该类型的参数块长度：静态 3，动画 7，未知 / 空层 0（effects-spec §2.5）。 */
uint8_t lumen_effect_param_len(uint8_t type);

/* type != 0x00（不含空层 0xFF：空层不是动画）。 */
bool lumen_effect_is_animated(uint8_t type);

/* ---------------- 层编解码（与 §7.1 的 9 字节定宽编码一一对应） ---------------- */

/*
 * 层是否为空（type == 0xFF）。空层只允许出现在 layer[1]（§7.1 第 2 步）。
 */
bool lumen_layer_is_empty(const lumen_effect_layer_t *layer);

/*
 * 把 9 字节线格式解码成层结构（§7.1）。src 非 NULL 时总是填充 out；
 * 返回 false 表示 type 既不是已知类型也不是空层（形状非法，值仍已复制，
 * 便于调用方在错误日志里打出实际字节）。
 */
bool lumen_layer_decode(const uint8_t src[9], lumen_effect_layer_t *out);

/* 把层编码回 9 字节线格式（§7.1）。未用字节由 layer->param 原样给出。 */
void lumen_layer_encode(const lumen_effect_layer_t *layer, uint8_t out[9]);

/* 层的参数访问器（param 按 type 的布局解释，见结构体注释）。 */
uint16_t lumen_layer_hue(const lumen_effect_layer_t *layer);
uint8_t lumen_layer_sat(const lumen_effect_layer_t *layer);
uint16_t lumen_layer_period_ms(const lumen_effect_layer_t *layer);
uint8_t lumen_layer_p5(const lumen_effect_layer_t *layer);
uint8_t lumen_layer_flags(const lumen_effect_layer_t *layer);

/* 本层亮度档位 0-100（v4 §7.1）。层为 NULL 时返回 0。 */
uint8_t lumen_layer_level(const lumen_effect_layer_t *layer);

/* 静态层的 param[3..6] 是否全为 0（§7.1 第 6 步的保留位约束）。 */
bool lumen_layer_static_reserved_zero(const lumen_effect_layer_t *layer);

/*
 * 空层的 9 字节编码是否全为「空层形态」：type 之外 param 全 0 且 level == 0
 * （v4 §7.1 第 3 步：空层不得携带亮度）。
 */
bool lumen_layer_empty_params_zero(const lumen_effect_layer_t *layer);

/* ---------------- 段几何 ---------------- */

/* 段内灯珠数。非活动段返回 0。 */
uint16_t lumen_effect_segment_length(const lumen_segment_t *seg);

/* 段内偏移；下标不在段区间内返回 0。 */
uint16_t lumen_effect_index_in_segment(const lumen_segment_t *seg, uint16_t index_in_strip);

/*
 * 段是否需要帧循环：任一层是动画类（type != 0x00 且非空层）。
 * 静态双层（例如静态 + 静态相乘）不需要逐帧重画。
 */
bool lumen_segment_is_animated(const lumen_segment_t *seg);

/* ---------------- 单层 / 整段求值 ---------------- */

/*
 * 计算**单个层**在某颗灯上的用户空间 RGB（0-255，不含 gamma / 全局亮度）。
 *
 * layer_index ∈ {0,1}；空层输出 (0,0,0)。段几何（start/end）与相位基准
 * （t0_ms）取自 seg——两层共享同一个时间原点（§9.4）。
 * now_ms 与 seg->t0_ms 同基准；静态灯效忽略 now_ms。
 *
 * **v4：返回前按 layer->level/100 逐通道缩放**（§9.3 第 1 步）。level = 100
 * 时与 v3 逐字节一致；level = 0 时整层全黑。全局亮度仍不在这里。
 */
void lumen_layer_pixel(const lumen_segment_t *seg, uint8_t layer_index,
                       uint16_t index_in_strip, uint32_t now_ms, uint8_t out_rgb[3]);

/*
 * 计算一颗灯的最终用户空间 RGB：layer[0] 求值 → （如有）layer[1] 求值 →
 * 按 seg->blend 合成（§7.2 / §9.3）。**两层都不做 gamma / 全局亮度**，
 * 但各自已经按自己的 level 压暗过。
 */
void lumen_effect_pixel(const lumen_segment_t *seg, uint16_t index_in_strip, uint32_t now_ms,
                        uint8_t out_rgb[3]);

/*
 * blend 合成（纯函数，§7.2）：
 *   0 覆盖  out = L1
 *   1 相乘  out = (L0 * L1 + 127) / 255
 *   2 相加  out = min(255, L0 + L1)
 * 未知 blend 按「覆盖」处理（命令层已拒绝非法值，这里只是防御）。
 * out 可与 l0 / l1 指向同一块内存。
 */
void lumen_blend_pixel(uint8_t blend, const uint8_t l0[3], const uint8_t l1[3],
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
 *
 * **v4 起呼吸层的 p5 是相对百分比**（0-100），实际谷底 = 本层 level ×
 * minLevel%。本函数保留绝对 0-255 的定义给彩虹/流光的 p5 语义与旧测试；
 * 呼吸层走下面的 lumen_effect_breathing_gain_pct_q16。
 */
uint32_t lumen_effect_breathing_gain_q16(uint16_t period_ms, uint8_t min_level,
                                         uint8_t waveform, uint32_t t0_ms, uint32_t now_ms);

/*
 * v4 呼吸增益：min_pct 是 0-100 的相对百分比，谷底 = level × min_pct / 100。
 *
 *   min_frac = min_pct/100 × level/100
 *   e'       = min_frac + (1 - min_frac) × e
 *
 * 与绝对版的区别只在「谷底怎么算」：level 是这一层的母亮度，所以 level = 50
 * 的呼吸层谷底是满亮的一半再乘最低亮百分比。min_pct > 100 属非法参数，
 * 命令层已拒绝；这里按 100 钳位防御。
 */
uint32_t lumen_effect_breathing_gain_pct_q16(uint16_t period_ms, uint8_t min_pct, uint8_t level,
                                             uint8_t waveform, uint32_t t0_ms, uint32_t now_ms);

/* 用 Q16 增益缩放一个用户空间通道（四舍五入），0..255 输入输出。 */
uint8_t lumen_effect_apply_gain_q16(uint8_t value, uint32_t gain_q16);

/*
 * 按层的亮度档位缩放一个用户空间通道（纯函数，v4 §9.3 第 1 步）：
 *   out = round(value × level / 100)
 *
 * level = 100 原样返回；level = 0 返回 0。level > 100 按 100 钳位（命令层
 * 已拒绝，这里只是防御）。用于 lumen_layer_pixel 返回前给整层压暗。
 */
uint8_t lumen_effect_apply_level_q8(uint8_t value, uint8_t level);

/* ---------------- #31 彩虹 / 流光 ---------------- */

/*
 * 彩虹：段内第 i 颗（共 n 颗）的色相（0-65535），effects-spec §3.3：
 *
 *   hue_i = hue + phase × 65536 + (i/N) × (span/255) × 65536 × dir   (mod 65536)
 *
 *  - span = 0   → 整条同色，色相随时间循环；
 *  - span = 255 → 沿灯带铺满一整圈，随时间平移；
 *  - dir = reverse ? -1 : +1（flags bit0）。
 *
 * 用层 + 段几何（n / i / t0_ms）作参数，而不是整个段：两层各自的 layer 都能
 * 直接求值。溢出论证见 effects.c——这里统一用 uint64 算乘积再取模。
 */
uint16_t lumen_layer_rainbow_hue(const lumen_effect_layer_t *layer, uint16_t n, uint16_t i,
                                 uint32_t t0_ms, uint32_t now_ms);

/*
 * 流光：段内第 i 颗（共 n 颗）的亮度权重，Q16（0..65535），effects-spec §3.4：
 *
 *   tail_n = 1 + (tail/255) × (N-1)
 *   p_i    = ((i/N) - phase) mod 1
 *   w_i    = p_i < tail_n/N ? exp(-(p_i × N / tail_n) × 3) : 0
 *
 * 指数用初始化时建的 65 点表 + 线性插值（沿用 gamma.c / 正弦表的先例），
 * 运行时零浮点。reverse 由调用方在传 i 时镜像（见 lumen_layer_pixel）。
 */
uint32_t lumen_layer_comet_gain_q16(const lumen_effect_layer_t *layer, uint16_t n, uint16_t i,
                                    uint32_t t0_ms, uint32_t now_ms);

/*
 * 段 layer[0] 上的便捷包装（旧签名，保留给「只关心底层」的测试与摘要）。
 * 段无效或下标越界返回 0。
 */
uint16_t lumen_effect_rainbow_hue(const lumen_segment_t *seg, uint16_t index_in_strip,
                                  uint32_t now_ms);
uint32_t lumen_effect_comet_gain_q16(const lumen_segment_t *seg, uint16_t index_in_strip,
                                     uint32_t now_ms);
