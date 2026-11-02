#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "segment_store.h"
#include "state.h"

/*
 * NVS 状态 blob 的编解码（纯函数，可在 host 上单测）。
 *
 * v4 显式字节布局（docs/protocol-v3.md §10.2），避免结构体 padding 随编译器变化：
 *   0..3    magic 'L' 'M' 'E' 'N'
 *   4..5    version (小端) = 4
 *   6       power
 *   7       brightness
 *   8..10   r, g, b
 *   11..12  led_count（strip 0，冗余）
 *   13      strip_count
 *   14      strip_power_mask
 *   15..30  strip_counts[8]（8 × 小端 2 字节）
 *   31      seg_count（strip 0 的冗余摘要，解码时与段表交叉校验）
 *   32..    段表：8 灯带 × 8 槽位 × 20 字节
 *
 * 段记录 20 字节（与 §7.1 的段编码同构，去掉 strip_id / seg_id）：
 *   0 active | 1 start | 2 end | 3 blend | 4..11 layer0(8) | 12..19 layer1(8)
 *
 * 总长 **1312 字节**。不持久化相位（t0_ms）：相位由 (now - t0) 算出，每帧都变。
 * strip_anim_mask 是每帧重算的摘要，恒 0。
 *
 * **v3 blob 必须按版本不符整体拒绝**（布局不兼容：记录 11 字节、没有 pmask）。
 * 解码失败一律不写 out，调用方保留协议默认值——绝不能出现半套加载。
 */

#define LUMEN_STATE_BLOB_VERSION 4

/* 段槽位的固定编码宽度（active/start/end/blend + layer0(8) + layer1(8)）。 */
#define LUMEN_SEGMENT_RECORD_SIZE 20
/* 每条灯带的灯珠数表（8 × 小端 2 字节）与段表在 blob 里的偏移。 */
#define LUMEN_STRIP_COUNTS_OFFSET 15
#define LUMEN_STRIP_COUNTS_SIZE (LUMEN_MAX_STRIPS * 2)
#define LUMEN_SEG_COUNT_OFFSET (LUMEN_STRIP_COUNTS_OFFSET + LUMEN_STRIP_COUNTS_SIZE)
#define LUMEN_SEGMENTS_OFFSET (LUMEN_SEG_COUNT_OFFSET + 1)
#define LUMEN_STATE_BLOB_SIZE                                                                  \
    (LUMEN_SEGMENTS_OFFSET + LUMEN_MAX_STRIPS * LUMEN_MAX_SEGMENTS * LUMEN_SEGMENT_RECORD_SIZE)

/* 编码；state 或 out 为 NULL 时返回 0。成功返回 LUMEN_STATE_BLOB_SIZE。 */
size_t lumen_state_blob_encode(const lumen_persist_t *state,
                               uint8_t out[LUMEN_STATE_BLOB_SIZE]);

/*
 * 解码并校验：长度、magic、version、power ∈ {0,1}、led_count ∈ [1,64]、
 * strip_count ∈ [1,8]、pmask 保留位、每段形状（层类型 / blend / 保留位）、
 * 区间落在**该灯带自己**的灯珠数内且同灯带内不重叠。
 * 任一失败返回 false 且不写 out（调用方保留默认值）。
 */
bool lumen_state_blob_decode(const uint8_t *blob, size_t len, lumen_persist_t *out);
