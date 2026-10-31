#pragma once

#include <stdint.h>

#include "protocol.h"
#include "segment_store.h"

/*
 * 设备共享状态的 RAM 表示。
 *
 * 字节布局见 docs/protocol-v3.md §7.3（37 字节）。v3 相比 v2 增加了每带开关掩码
 * 与每带动画掩码，并把每条灯带的灯珠数 / 活动段数放进 State。
 */

typedef struct {
    uint8_t power;      /* 0 关 / 1 开（全局总闸） */
    uint8_t brightness; /* 0-255，已按 max_brightness 钳位 */
    /*
     * strip 0 / seg 0 的基准色（docs/protocol-v3.md §7.3）。
     * 有活动段时由引擎按 seg 0 的 layer0 hue+sat 重算（seg 0 不存在则为 0）；
     * 一个活动段都没有时保持 v1 的单色值（向后兼容：现有单灯带功能不退化）。
     * 见 led_engine.c 的 lumen_engine_refresh_state_summary()。
     */
    uint8_t r;
    uint8_t g;
    uint8_t b;
    uint16_t led_count; /* 1-64，strip 0 的灯珠数 */

    /* 摘要字段（State 字节 6-12）。 */
    uint8_t strip_count;    /* 1-8，当前配置的灯带数 */
    uint8_t seg_count;      /* strip 0 的活动段数（每次写/清段后重算） */
    uint8_t script_id;      /* 0xFF = 无激活剧本 */
    uint8_t stage_index;    /* 当前阶段；无剧本时 0 */
    uint8_t playback_state; /* 0 停止 / 1 播放 / 2 暂停 */
    uint8_t flags;          /* bit0 loop；bit1 script_active；bit2-7 保留 = 0 */
    /*
     * 每条灯带的独立开关（docs/protocol-v3.md §9.5）。bit i = 第 i 条。
     * 实际是否出光 = 全局 power && 对应位。默认 0xFF（全开）。
     * 当前只有影子字段：#38 接 SetStripPower 与渲染门控。
     */
    uint8_t strip_power_mask;
    /*
     * 每条灯带当前是否有动画类活动段（§7.3）。渲染任务每帧维护的摘要，
     * 只作 App 的显示提示，不作为正确性依据。#38 负责维护。
     */
    uint8_t strip_anim_mask;
} lumen_state_t;

/*
 * 持久化快照：状态 + 段配置 + 每条灯带的灯珠数。
 *
 * 段配置不属于 State（State 只报摘要），但断电恢复必须带上它，
 * 所以 NVS debounce 的载荷是这个组合而不是单独的 lumen_state_t。
 *
 * #29 起每条灯带的灯珠数各自独立（State 只有 strip 0 的那一个），
 * 所以单独存一张表；strip_counts[0] 恒等于 state.led_count。
 */
typedef struct {
    lumen_state_t state;
    lumen_segment_store_t segments;
    uint16_t strip_counts[LUMEN_MAX_STRIPS];
} lumen_persist_t;

/* 协议默认值：关灯、亮度 128、暖白 255/180/120、strip_power_mask = 0xFF（全开）。
 * led_count 由构建期 Kconfig 传入（默认 30，与协议默认值一致）。 */
void lumen_state_defaults(lumen_state_t *state, uint16_t led_count);

uint8_t lumen_state_clamp_brightness(uint8_t value, uint8_t max_brightness);

/*
 * 按 docs/protocol-v3.md §7.3 编码 LUMEN_STATE_BYTES(37) 字节 State。
 *
 * strip_counts / strip_seg_counts 是每条灯带的灯珠数与活动段数（长度须为
 * LUMEN_MAX_STRIPS）。传 NULL 时按「只有 strip 0 且段数为 0」兜底——
 * 单灯带 host 测试与尚未初始化 TDM 的场景走这条路。
 * brightness 字段写入钳位后的生效值，max_brightness 放在第 5 字节。
 */
void lumen_state_to_bytes(const lumen_state_t *state, uint8_t max_brightness,
                          const uint16_t *strip_counts, const uint8_t *strip_seg_counts,
                          uint8_t out[LUMEN_STATE_BYTES]);
