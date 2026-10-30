#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "protocol.h"
#include "script_store.h"

/*
 * 剧本 NVS blob 的编解码（纯函数，host 可测）。
 *
 * 布局（v1，稀疏编码——只写活动段，不写 8×8 的空槽位）：
 *   0..3   magic 'L' 'M' 'S' 'C'
 *   4..5   version (小端) = 1
 *   6      active_script_id（0xFF = 无）
 *   7      flags（bit0 loop；其余保留 = 0）
 *   8..    4 个剧本槽位，按 id 升序：
 *             0 committed | 1 stage_count | 2 strip_count
 *             然后 stage_count 个阶段：
 *               0..1 duration_ms（小端）
 *               然后 strip_count 组：[seg_mask(1)] [每个置位槽位 10 字节记录]
 *             记录（顺序即槽位升序）：
 *               0 start | 1 end | 2 type | 3..4 hue(小端) | 5 sat |
 *               6..7 period_ms(小端) | 8 p5 | 9 flags
 *
 * 解码复用 lumen_script_commit 做整份校验：blob 损坏（段越界 / 重叠 / 时长 0）
 * 时整份拒绝，不让半套坏剧本进入 RAM。
 *
 * 不持久化播放位置（docs/protocol.md §12）：stage_index / playback_state 不在这里，
 * 上电一律 stage 0 + STOPPED。
 */

#define LUMEN_SCRIPT_BLOB_MAGIC "LMSC"
#define LUMEN_SCRIPT_BLOB_VERSION 1

/* 段记录的固定编码宽度（不含 strip / 槽位，二者由 seg_mask 与顺序隐含）。 */
#define LUMEN_SCRIPT_SEGMENT_SIZE 10

/*
 * 编码输出上限。NVS 分区 24KB，留足余量给状态 blob 与 NVS 自身开销。
 * 1 条灯带 × 8 阶段 × 8 段 × 4 套约 1.7KB；8 条灯带的最坏情况会超过这里，
 * 此时 encode 返回 0，调用方跳过持久化并告警（RAM 状态仍然有效）。
 */
#define LUMEN_SCRIPT_BLOB_MAX 8192

/*
 * 编码已提交剧本 + 激活 id + loop。
 * 返回写入字节数；参数非法或超出 LUMEN_SCRIPT_BLOB_MAX 返回 0。
 */
size_t lumen_script_blob_encode(const lumen_script_store_t *store, uint8_t active_script_id,
                                bool loop, uint8_t *out, size_t out_cap);

/*
 * 解码并整份校验。strip_counts 是每条灯带自己的灯珠数（与 commit 同一份规则）。
 * 失败时 store 保持调用方传入的初值（调用方先 init）。
 */
bool lumen_script_blob_decode(const uint8_t *blob, size_t len,
                              const uint16_t strip_counts[LUMEN_MAX_STRIPS],
                              lumen_script_store_t *store, uint8_t *active_script_id,
                              bool *loop);
