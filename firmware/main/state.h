#pragma once

#include <stdint.h>

#include "protocol.h"

/*
 * 设备共享状态的 RAM 表示。
 *
 * 字节布局见 docs/protocol-v5.md §7.3（**32 字节**）。v5 不再有分区 / 剧本字段：
 * State 报的是「整机开关 / 亮度 / 链数 / 每链灯珠数与部位数 / 当前场景」，
 * 部位开关属于场景、播放位置不持久化，都不在 State 里（§9.1 第 5 步：
 * App 要部位明细走 QueryLayout / QueryScene）。
 */
typedef struct {
    uint8_t power;      /* 0 关 / 1 开（全局总闸） */
    uint8_t brightness; /* 0-255，已按 max_brightness 钳位 */
    uint8_t strip_count;      /* 1-8，当前配置的灯带数 */
    /*
     * 每条灯带的独立开关（§9.5）。bit i = 第 i 条。
     * 实际是否出光 = 全局 power && 对应位。默认 0xFF（全开）。
     * 由 SetStripPower 改写；全局 SetPower 只动 power，**不碰**本字段。
     * 门控判据集中在 strip_power.c 的 lumen_strip_mask_allows()。
     */
    uint8_t strip_power_mask;
    uint8_t active_scene; /* 0-2：当前激活的场景 */
    /* 设备上是否有已提交的布局（LayoutCommit 成功后置 1，§6.1）。 */
    uint8_t layout_valid;
    /* 每条链自己的灯珠数（1-100；未用的槽位为 0）。v5 起这是权威值。 */
    uint16_t led_count[LUMEN_MAX_STRIPS];
    /* 每条链的部位数（0-8；未用的槽位为 0）。布局的摘要，明细走 QueryLayout。 */
    uint8_t part_count[LUMEN_MAX_STRIPS];
} lumen_state_t;

/*
 * 持久化快照：v5 的 state 键只有 State 本身（§10.2，32 字节）。
 * 布局与三个场景各有独立键（§10.5），不在这里。
 */
typedef struct {
    lumen_state_t state;
} lumen_persist_t;

/* 协议默认值（docs/protocol-v5.md §10.6）：关灯、亮度 128、strip_power_mask = 0xFF
 * （全开）、strip_count = 1、led_count[0] 由构建期 Kconfig 传入（默认 30）、
 * active_scene = 0、layout_valid = 0、part_count 全 0。 */
void lumen_state_defaults(lumen_state_t *state, uint16_t led_count);

uint8_t lumen_state_clamp_brightness(uint8_t value, uint8_t max_brightness);

/*
 * 按 docs/protocol-v5.md §7.3 编码 LUMEN_STATE_BYTES(32) 字节 State。
 *
 * brightness 字段写入钳位后的生效值，max_brightness 放在第 2 字节。
 * 未用的链槽位（i >= strip_count）由调用方保证是 0；本函数原样编码。
 */
void lumen_state_to_bytes(const lumen_state_t *state, uint8_t max_brightness,
                          uint8_t out[LUMEN_STATE_BYTES]);
