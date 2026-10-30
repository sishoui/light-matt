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
 * #25 只实现静态单色（type 0x00）。呼吸 / 彩虹 / 流光的像素分支由 #30 / #31 加入，
 * 在那之前命令层把这三个类型当作「尚未实现」，回 UnknownCommand（不静默变黑）。
 */

/* 段类型（docs/effects-spec.md §2）。 */
typedef enum {
    LUMEN_EFFECT_STATIC = 0x00,
    LUMEN_EFFECT_BREATHING = 0x01,
    LUMEN_EFFECT_RAINBOW = 0x02,
    LUMEN_EFFECT_COMET = 0x03,
} lumen_effect_type_t;

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

/* type 是否已经有像素实现。当前只有静态；动画类型由 #30/#31 打开。 */
bool lumen_effect_type_implemented(uint8_t type);

/* 该类型的参数块长度：静态 3，动画 7，未知 0（docs/effects-spec.md §2.5）。 */
uint8_t lumen_effect_param_len(uint8_t type);

/* type != 0x00。帧循环的判据之一（§3.1）；#25 不驱动帧循环，但接口先定。 */
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
