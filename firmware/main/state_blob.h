#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "state.h"

/*
 * NVS 状态 blob 的编解码（纯函数，可在 host 上单测）。
 *
 * 显式字节布局，避免结构体 padding 随编译器变化：
 *   0..3   magic 'L' 'M' 'E' 'N'
 *   4..5   version (小端)
 *   6      power
 *   7      brightness
 *   8..10  r, g, b
 *   11..12 led_count (小端)
 *
 * 版本只在布局不兼容地变化时才提升；字段越界（power / led_count）视为损坏，
 * 由调用方回落到协议默认值。
 */

#define LUMEN_STATE_BLOB_SIZE 13
#define LUMEN_STATE_BLOB_VERSION 1

/* 编码；state 或 out 为 NULL 时返回 0。成功返回 LUMEN_STATE_BLOB_SIZE。 */
size_t lumen_state_blob_encode(const lumen_state_t *state, uint8_t out[LUMEN_STATE_BLOB_SIZE]);

/*
 * 解码并校验：长度、magic、version、power ∈ {0,1}、led_count ∈ [1, 64]。
 * 任一失败返回 false 且不写 out（调用方保留默认值）。
 */
bool lumen_state_blob_decode(const uint8_t *blob, size_t len, lumen_state_t *out);
