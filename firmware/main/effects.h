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
    /* #74：三种新类型，参数块仍是 7 字节，层编码 / 帧长 / 状态存储都不变。 */
    LUMEN_EFFECT_STROBE = 0x04,    /* 爆闪：方波 + 两端斜坡，duty 决定亮的时间占比 */
    LUMEN_EFFECT_HEARTBEAT = 0x05, /* 心跳：一个节拍内一大一小两次脉冲 */
    LUMEN_EFFECT_OFF = 0x06,       /* 熄灭：参数全 0，永不发光（显式的「这里就是黑的」） */
    /* #98：随机闪烁。每颗灯珠按自己的哈希相位做确定性亮灭方波，p5 = 同时亮的比例。 */
    LUMEN_EFFECT_FLICKER = 0x07,
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
    /*
     * 按亮度叠加（§7.2.1）：a = max(L1)/255，out = L1 + L0 × (1 − a)。
     *
     * 这是「上层只盖住它自己亮着的地方」：流动效果（流星 / 随机闪烁）叠在
     * 静态或彩虹之上时，只有头部与尾巴亮着，其余位置继续显示背景层。
     * `LUMEN_BLEND_OVER` 做不到这一点——它让上层的每个黑像素都盖住背景。
     */
    LUMEN_BLEND_LUMA = 0x03,
} lumen_blend_mode_t;

#define LUMEN_BLEND_MAX LUMEN_BLEND_LUMA

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
 * 爆闪周期下限（effects-spec §2.5）：100ms = 10Hz。
 *
 * 这是**亮度闪烁**的上界，不是安全线：固件默认 20fps（每帧 50ms），
 * 一个 100ms 周期只有 2 帧，已经到能表现的上限。**本票不提高帧率**——
 * 8 条满 100 颗时提高帧率会掉帧，那种掉帧比低频更糟（#74）。
 * period_ms == 0 是「静止不出光」，不受此限。
 */
#define LUMEN_STROBE_MIN_PERIOD_MS 100u

/*
 * 心跳周期区间（effects-spec §2.6）：500-1500ms = 40-120 BPM。
 * period_ms == 0 同样是「静止」（谷底，不出光）。
 */
#define LUMEN_HEARTBEAT_MIN_PERIOD_MS 500u
#define LUMEN_HEARTBEAT_MAX_PERIOD_MS 1500u

/*
 * 随机闪烁（#98）的周期下限：334ms 与呼吸同一条光敏性癫痫安全线。
 *
 * 它是**亮度闪烁**（每颗灯独立亮灭），不是空间移动，所以不能借用彩虹 / 流光的
 * 200ms。period_ms == 0 是「静止」——相位冻结在 0，画面仍是一张确定性的
 * 亮点分布图（不是全亮也不是全灭）。
 */
#define LUMEN_FLICKER_MIN_PERIOD_MS 334u

/*
 * 流光 flags（#98 原地扩展，仍只用已有的 1 字节）：
 *   bit0       reverse（沿灯带反向）
 *   bit1       拖尾不衰减（0 = 现有的指数渐隐；1 = 实色块拖尾）
 *   bit2-3     流星头数量 - 1（0..3 ⇒ 1..4 个，沿整条均分）
 *   bit4-7     保留 = 0（> 0 一律 InvalidParam）
 *
 * 多个头在同一帧**取最大值**合成，绝不相加——否则重叠处亮度翻倍，
 * 整条会闪出一块比单个流星亮一倍的白斑。
 */
#define LUMEN_COMET_FLAG_REVERSE 0x01u
#define LUMEN_COMET_FLAG_SOLID_TAIL 0x02u
#define LUMEN_COMET_DENSITY_SHIFT 2u
#define LUMEN_COMET_DENSITY_MASK 0x0Cu /* 两位 → 0..3 ⇒ 1..4 个头 */
#define LUMEN_COMET_FLAGS_RESERVED_MASK 0xF0u
/* 实色拖尾的亮度（约 75%），与头形成一颗灯的亮暗台阶，免得糊成一条。 */
#define LUMEN_COMET_SOLID_TAIL_GAIN_Q16 49152u

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

/* type 是否属于协议定义的八种之一（docs/protocol-v4.md §7.1；#98 起含随机闪烁）。 */
bool lumen_effect_type_known(uint8_t type);

/*
 * type 是否已经有像素实现。八种类型全部为真（静态 / 呼吸 / 彩虹 / 流光 /
 * 爆闪 / 心跳 / 熄灭 / 随机闪烁）。
 */
bool lumen_effect_type_implemented(uint8_t type);

/*
 * 该类型的参数块长度（effects-spec §2.5）：静态 3，其余已知类型 7
 * （爆闪 / 心跳 / 熄灭同样复用 7 字节，所以层编码宽度不变），未知 / 空层 0。
 */
uint8_t lumen_effect_param_len(uint8_t type);

/*
 * 该类型是否需要逐帧重绘（effects-spec §2.7 的「熄灭不是动画」）。
 *
 * **显式枚举，不是 `type != STATIC`**：熄灭（OFF）虽然类型值非 0，但它的
 * 输出恒为黑，把静态画面也拖进帧循环是纯浪费（8 条带满 100 颗时尤其明显）。
 * 空层同样返回 false（空层不是动画）；未知类型保守返回 true（在命令层已被拒，
 * 这里不影响任何合法配置）。
 */
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
 * 段是否需要帧循环：任一层是动画类（见 lumen_effect_is_animated：静态与熄灭
 * 都不算，空层也不算）。静态双层与「静态 + 熄灭」都是常量画面。
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
 *   0 覆盖          out = L1
 *   1 相乘          out = (L0 * L1 + 127) / 255
 *   2 相加          out = min(255, L0 + L1)
 *   3 按亮度叠加     a = max(L1)/255；out = L1 + L0 × (1 − a)
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

/* ---------------- #74 爆闪 / 心跳 ---------------- */

/*
 * 爆闪增益，Q16（0..65535），effects-spec §2.5：
 *
 *   p    = phase_q16（与呼吸共用同一个 helper）
 *   hi   = duty/255 × 65536                     // 高电平结束位置
 *   p < 5%          → 线性上升到 1（上升沿）
 *   5% ≤ p < hi-5%  → 1（高电平）
 *   hi-5% ≤ p < hi  → 线性下降到 0（下降沿）
 *   p ≥ hi          → 0（低电平）
 *
 * `period_ms == 0` 返回 0：静止 = **不出光**（不是停在亮端）。
 * duty = 0 时 hi 被抬到 10%，仍是「几乎全黑」；duty = 255 时几乎常亮。
 *
 * 5% 斜坡（Q16 = 3277）是为了避免硬切：20fps 下方波的边沿本来就落在
 * 帧边界上，加一段斜坡能让相邻两帧的亮度差更均匀。
 */
uint32_t lumen_effect_strobe_gain_q16(uint16_t period_ms, uint8_t duty, uint32_t t0_ms,
                                      uint32_t now_ms);

/*
 * 心跳增益，Q16（0..65535），effects-spec §2.6：
 *
 *   w = pulse/255 × 65536（至少 1% 周期，免得看不见）
 *   p < w             → 线性上升到 1（第一次脉冲，峰值 1）
 *   w ≤ p < 2w        → 0（间歇，谷底）
 *   2w ≤ p < 3w       → 线性上升到 0.6（第二次脉冲，峰值 39321）
 *   p ≥ 3w            → 0
 *
 * `double_pulse == false` 时第二次脉冲恒 0（单脉冲）。`period_ms == 0`
 * 返回 0：静止在谷底，不出光。
 *
 * 这是「一大一小两次脉冲」的线性三角近似，不是心电图的精确形状；
 * 验收只看得到两次幅度不同的脉冲（#74）。
 */
uint32_t lumen_effect_heartbeat_gain_q16(uint16_t period_ms, uint8_t pulse, bool double_pulse,
                                         uint32_t t0_ms, uint32_t now_ms);

/* ---------------- #98 随机闪烁 ---------------- */

/*
 * 一颗灯珠的哈希（#98），确定性、无状态：只用段内下标与段几何算出一个
 * 固定的 16 位相位种子。同一颗灯在任何时刻、任何调用顺序下都得到同一个值
 * ——这是「不能每帧随机」的硬要求（每帧随机会变成白噪声而不是闪烁）。
 *
 * 输入刻意只用 (index_in_strip, n, t0_ms)：t0_ms 提供「换一套配置就换一张图」
 * 的变化，但同一份配置下它是常量。
 */
uint32_t lumen_effect_flicker_phase_seed(uint16_t index_in_strip, uint16_t n, uint32_t t0_ms);

/*
 * 随机闪烁增益，Q16（0 或 65535 附近的方波），effects-spec §2.8（新增）：
 *
 *   seed      = flicker_phase_seed(i, N, t0_ms)
 *   phase_q16 = (period 的时间相位 + seed/N 的空间相位) mod 1
 *   duty      = p5 / 255                 // 同时亮着的比例
 *   on        = phase_q16 < duty × 65536
 *
 * 每个灯珠的方波相互错相（seed 均匀撒在 [0,1)），所以同一时刻只有
 * `p5/255` 比例亮着；时间推进时同一颗灯按 period 反复亮灭。`period_ms == 0`
 * 让时间相位的增量恒为 0（与呼吸同一条 `lumen_effect_breathing_phase_q16`
 * 语义），画面停在一张固定分布上。
 *
 * 与爆闪一样**两端各留 5% 线性斜坡**，避免 20fps 下方波边沿落在帧边界上
 * 造成相邻两帧亮度跳变。
 */
uint32_t lumen_effect_flicker_gain_q16(uint16_t period_ms, uint8_t duty, uint16_t index_in_strip,
                                       uint16_t n, uint32_t t0_ms, uint32_t now_ms);

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
 *
 * #98 起同一层可以同时有 1-4 个头（flags bit2-3）：
 *   - 头沿整条**均分**，第 k 个头位于 k/N_head 的相位偏移处；
 *   - 多个头的权重**取最大值**合成，绝不相加（重叠处不会亮度翻倍）；
 *   - flags bit1 = 拖尾不衰减：拖尾是实色块（约 75%），头部之后一颗立刻降到
 *     该台阶，避免和头糊成一片；衰减拖尾仍走上面的 exp 表。
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
