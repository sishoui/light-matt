#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "segment_store.h"
#include "state.h"

/*
 * NVS 状态 blob 的编解码（纯函数，可在 host 上单测）。
 *
 * v3 显式字节布局（避免结构体 padding 随编译器变化）：
 *   0..3    magic 'L' 'M' 'E' 'N'
 *   4..5    version (小端) = 3
 *   6       power
 *   7       brightness
 *   8..10   r, g, b
 *   11..12  led_count (小端)
 *   13      strip_count
 *   14      seg_count（冗余摘要，解码时与段表交叉校验）
 *   15..30  每条灯带的灯珠数（8 × 小端 2 字节，仅前 strip_count 项有效）
 *   31..    段表：LUMEN_MAX_STRIPS × LUMEN_MAX_SEGMENTS 个槽位，每槽 11 字节：
 *             0 active | 1 start | 2 end | 3 type | 4..5 hue(小端) |
 *             6 sat | 7..8 period_ms(小端) | 9 p5 | 10 flags
 *
 * 不持久化相位（t0_ms）：相位由 (now - t0) 算出，每帧都变（v2-effects-engine §7.3）。
 * 解码时不恢复 t0_ms，由引擎在加载后统一设为当前时刻。
 *
 * 版本只在布局不兼容地变化时才提升。字段越界 / 段表自相矛盾视为损坏，
 * 解码返回 false，由调用方回落到协议默认值（沿用 v1 行为）。
 */

#define LUMEN_STATE_BLOB_VERSION 3

/* 段槽位的固定编码宽度。 */
#define LUMEN_SEGMENT_RECORD_SIZE 11
/* 每条灯带的灯珠数表（8 × 小端 2 字节）与段表在 blob 里的偏移。 */
#define LUMEN_STRIP_COUNTS_OFFSET 15
#define LUMEN_STRIP_COUNTS_SIZE (LUMEN_MAX_STRIPS * 2)
#define LUMEN_SEGMENTS_OFFSET (LUMEN_STRIP_COUNTS_OFFSET + LUMEN_STRIP_COUNTS_SIZE)
#define LUMEN_STATE_BLOB_SIZE                                                                  \
    (LUMEN_SEGMENTS_OFFSET + LUMEN_MAX_STRIPS * LUMEN_MAX_SEGMENTS * LUMEN_SEGMENT_RECORD_SIZE)

/* 编码；state 或 out 为 NULL 时返回 0。成功返回 LUMEN_STATE_BLOB_SIZE。 */
size_t lumen_state_blob_encode(const lumen_persist_t *state,
                               uint8_t out[LUMEN_STATE_BLOB_SIZE]);

/*
 * 解码并校验：长度、magic、version、power ∈ {0,1}、led_count ∈ [1,64]、
 * strip_count ∈ [1,8]、每段区间合法且同灯带内不重叠。
 * 任一失败返回 false 且不写 out（调用方保留默认值）。
 */
bool lumen_state_blob_decode(const uint8_t *blob, size_t len, lumen_persist_t *out);
