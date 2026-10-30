#pragma once

#include <stdint.h>

#include "protocol.h"
#include "segment_store.h"

/*
 * 设备共享状态的 RAM 表示。
 *
 * 字节 0-7 的布局与 v1 完全一致（这是刻意的：过渡期 UI 不必整体重写）；
 * 字节 8-13 是 v2 新增的段/剧本摘要，见 docs/protocol.md §7。
 */

typedef struct {
    uint8_t power;      /* 0 关 / 1 开 */
    uint8_t brightness; /* 0-255，已按 max_brightness 钳位 */
    /*
     * strip 0 / seg 0 的基准色（docs/protocol.md §7）。
     * 有活动段时由引擎按 seg 0 的 hue+sat 重算（seg 0 不存在则为 0）；
     * 一个活动段都没有时保持 v1 的单色值（向后兼容：现有单灯带功能不退化，
     * 且与共享向量 state_read_example_hex 的 FF B4 78 一致）。
     * 见 led_engine.c 的 lumen_engine_refresh_state_summary()。
     */
    uint8_t r;
    uint8_t g;
    uint8_t b;
    uint16_t led_count; /* 1-64，strip 0 的灯珠数 */

    /* v2 摘要字段（State 字节 8-13）。 */
    uint8_t strip_count;    /* 1-8，当前配置的灯带数 */
    uint8_t seg_count;      /* strip 0 的活动段数（每次写/清段后重算） */
    uint8_t script_id;      /* 0xFF = 无激活剧本 */
    uint8_t stage_index;    /* 当前阶段；无剧本时 0 */
    uint8_t playback_state; /* 0 停止 / 1 播放 / 2 暂停 */
    uint8_t flags;          /* bit0 loop；bit1 script_active；bit2-7 保留 = 0 */
} lumen_state_t;

/*
 * 持久化快照：状态 + 段配置。
 *
 * 段配置不属于 State（State 只报摘要），但断电恢复必须带上它，
 * 所以 NVS debounce 的载荷是这个组合而不是单独的 lumen_state_t。
 */
typedef struct {
    lumen_state_t state;
    lumen_segment_store_t segments;
} lumen_persist_t;

/* 协议默认值：关灯、亮度 128、暖白 255/180/120。
 * led_count 由构建期 Kconfig 传入（默认 30，与协议默认值一致）。
 * v2 摘要默认：1 条灯带、0 段、无激活剧本、停止播放。 */
void lumen_state_defaults(lumen_state_t *state, uint16_t led_count);

uint8_t lumen_state_clamp_brightness(uint8_t value, uint8_t max_brightness);

/* 按 docs/protocol.md §7 编码 LUMEN_STATE_BYTES(14) 字节 State。
 * brightness 字段写入钳位后的生效值，max_brightness 放在第 7 字节。 */
void lumen_state_to_bytes(const lumen_state_t *state, uint8_t max_brightness,
                          uint8_t out[LUMEN_STATE_BYTES]);
