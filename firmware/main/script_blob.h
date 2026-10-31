#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "protocol.h"
#include "script_store.h"

/*
 * 剧本 NVS blob 的编解码（纯函数，host 可测）。
 *
 * 布局（v2，docs/protocol-v3.md §10.3，稀疏编码——只写活动段）：
 *   0..3   magic 'L' 'M' 'S' '3'
 *   4..5   version (小端) = 2
 *   6      active_script_id（0xFF = 无）
 *   7      flags（bit0 loop；其余保留 = 0）
 *   8..    4 个剧本槽位，按 id 升序：
 *             0 committed | 1 stage_count | 2 strip_count
 *             然后 stage_count 个阶段：
 *               0..1 duration_ms（小端）
 *               2..3 fade_ms（小端，格式预留，恒为 0）
 *               然后 strip_count 组：[seg_mask(1)] [每个置位槽位一条记录]
 *             记录（槽位升序）：start(1) end(1) blend(1) layer0 layer1
 *             层编码：type(1) + param_len(type) 字节（0xFF 长度为 0）
 *
 * **记录宽度按层类型变长**：静态 3、动画 7、空 0。所以一条记录是
 * `3 + (1+len0) + (1+len1)` 字节（19..18，见 §10.4 的尺寸预算公式）。
 *
 * 解码复用 lumen_script_commit 做整份校验：blob 损坏（段越界 / 重叠 / 时长 0）
 * 时整份拒绝，不让半套坏剧本进入 RAM。
 *
 * 不持久化播放位置：stage_index / playback_state 不在这里，上电一律 stage 0 + STOPPED。
 */

#define LUMEN_SCRIPT_BLOB_MAGIC "LMS3"
#define LUMEN_SCRIPT_BLOB_VERSION 2

/*
 * 段记录的最小/最大宽度（不含 strip / 槽位，二者由 seg_mask 与顺序隐含）。
 *
 * 实际宽度 = 3 + (1 + param_len(layer0)) + (1 + param_len(layer1))：
 *   两层都空   → 3 + 1 + 1 = 5（不应出现，空槽位由 seg_mask 表示）
 *   静态 + 空  → 3 + 4 + 1 = 8
 *   动画 + 空  → 3 + 8 + 1 = 12
 *   静态 + 静态→ 3 + 4 + 4 = 11
 *   动画 + 动画→ 3 + 8 + 8 = 19
 * 下限 3（记录头本身），上限 19。
 */
#define LUMEN_SCRIPT_SEGMENT_MIN 3
#define LUMEN_SCRIPT_SEGMENT_MAX 19

/*
 * 编码输出上限：16384 字节（v3 从 4KB 提到 16KB，NVS 分区同时扩到 64KB）。
 *
 * 典型用法（1-2 条灯带、4-8 阶段、3-4 段）远低于上限；理论最坏
 * （8 带 × 8 阶段 × 8 段 × 两层动画）单套就 9792 字节，装不下 4 套——这是
 * 4MB flash 的物理限制。**不要通过扩大上限来"修复"**：40KB 跨 10 个 page
 * 写入，C3 上可能数百毫秒到数秒，掉电风险显著。
 *
 * 超限由 lumen_script_commit 在**提交前**发现并回 ScriptTooLarge (0x0A)，
 * 所以 encode 返回 0 在正常流程里只可能出现在 blob_out 缓冲给小的调用方。
 */
#define LUMEN_SCRIPT_BLOB_MAX 16384

/*
 * 编码已提交剧本 + 激活 id + loop。
 * 返回写入字节数；参数非法或超出 LUMEN_SCRIPT_BLOB_MAX 返回 0。
 */
size_t lumen_script_blob_encode(const lumen_script_store_t *store, uint8_t active_script_id,
                                bool loop, uint8_t *out, size_t out_cap);

/*
 * 解码并整份校验。strip_counts 是每条灯带自己的灯珠数（与 commit 同一份规则）。
 *
 * **就地解码**：结果直接写进 store（一套剧本表约 41KB，不做临时副本，否则
 * 会撑爆调用者栈）。因此**失败时 store 内容未定义**（可能是半套），调用方
 * 必须重新 `lumen_script_store_init(store)`。成功时才算整份可信。
 */
bool lumen_script_blob_decode(const uint8_t *blob, size_t len,
                              const uint16_t strip_counts[LUMEN_MAX_STRIPS],
                              lumen_script_store_t *store, uint8_t *active_script_id,
                              bool *loop);
