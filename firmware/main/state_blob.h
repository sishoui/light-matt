#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "state.h"

/*
 * NVS 状态 blob 的编解码（纯函数，可在 host 上单测）。
 *
 * v6 显式字节布局（docs/protocol-v5.md §10.2），避免结构体 padding 随编译器变化：
 *   0..3    magic 'L' 'M' 'E' 'N'
 *   4..5    version (小端) = 6
 *   6       power
 *   7       brightness
 *   8       strip_count
 *   9       strip_power_mask
 *   10      active_scene
 *   11..15  reserved 0
 *   16..31  led_count[8]（8 × 小端 2 字节）
 *
 * 总长 **32 字节**。v5 不再有分区 / 剧本字段：部位划分与三个场景各有独立键
 * （layout / scene0..2，见 state_store.h 与 layout_store.h / scene_store.h）。
 *
 * **版本号 6 不是笔误**：blob 版本 5 是 v4 的「状态 + 段表」1440 字节格式，
 * v5 的布局与场景拆成了独立的键，整份格式不兼容，必须用新版本号把它们分开。
 *
 * **旧 blob（任意版本）必须整体拒绝**。解码失败一律不写 out，调用方保留协议
 * 默认值——绝不能出现半套加载。
 */

#define LUMEN_STATE_BLOB_VERSION 6
#define LUMEN_STATE_BLOB_SIZE 32

/* 编码；state 或 out 为 NULL 时返回 0。成功返回 LUMEN_STATE_BLOB_SIZE。 */
size_t lumen_state_blob_encode(const lumen_persist_t *state,
                               uint8_t out[LUMEN_STATE_BLOB_SIZE]);

/*
 * 解码并校验：长度精确 32、magic、version == 6、power ∈ {0,1}、
 * brightness 任意、strip_count ∈ [1,8]、active_scene ∈ [0,2]、
 * 已配置链的 led_count ∈ [1,100]、未配置槽位为 0、part_count 留给布局
 * （State blob 不含部位数，加载后由布局键填）。
 * 任一失败返回 false 且不写 out（调用方保留默认值）。
 */
bool lumen_state_blob_decode(const uint8_t *blob, size_t len, lumen_persist_t *out);
