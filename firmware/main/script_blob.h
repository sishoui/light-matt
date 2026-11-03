#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "protocol.h"
#include "script_store.h"

/*
 * 剧本 NVS blob 的编解码（纯函数，host 可测）。
 *
 * 布局（v3，docs/protocol-v4.md §10.3，稀疏编码——只写活动段）：
 *   0..3   magic 'L' 'M' 'S' '4'
 *   4..5   version (小端) = 3
 *   6      active_script_id（0xFF = 无）
 *   7      flags（bit0 loop；其余保留 = 0）
 *   8..    4 个剧本槽位，按 id 升序：
 *             0 committed | 1 stage_count | 2 strip_count
 *             然后 stage_count 个阶段：
 *               0..1 duration_ms（小端）
 *               2..3 fade_ms（小端，格式预留，恒为 0）
 *               然后 strip_count 组：[seg_mask(1)] [每个置位槽位一条记录]
 *             记录（槽位升序）：start(1) end(1) blend(1) layer0 layer1
 *             层编码：type(1) + param_len(type) 字节 + level(1)
 *                     （0xFF 空层长度为 0，**连 level 都不写**——空层 level 恒 0）
 *
 * **记录宽度按层类型变长**：静态 3、动画 7、空 0，每层再 +1（level）。所以一条
 * 记录是 `3 + (1+1+len0) + (1+1+len1)` 字节（5..21，见 §10.4 的尺寸预算公式）。
 *
 * **版本 3 不是笔误**：v3 的剧本 blob 已用掉 version 2 / magic `LMS3`。v4 每层
 * 多一个 level 字节，必须同时升 magic 与 version，否则旧的 `LMS3` v2 会被按
 * 新布局误读（整份错位）。
 *
 * 解码复用 lumen_script_commit 做整份校验：blob 损坏（段越界 / 重叠 / 时长 0）
 * 时整份拒绝，不让半套坏剧本进入 RAM。
 *
 * 不持久化播放位置：stage_index / playback_state 不在这里，上电一律 stage 0 + STOPPED。
 */

#define LUMEN_SCRIPT_BLOB_MAGIC "LMS4"
#define LUMEN_SCRIPT_BLOB_VERSION 3

/*
 * 段记录的最小/最大宽度（不含 strip / 槽位，二者由 seg_mask 与顺序隐含）。
 *
 * 实际宽度 = 3 + (1 + 1 + param_len(layer0)) + (1 + 1 + param_len(layer1))：
 *   两层都空   → 3 + 1 + 1 = 5（不应出现，空槽位由 seg_mask 表示；
 *                                空层不写 level，所以空层的宽度仍是 1）
 *   静态 + 空  → 3 + 5 + 1 = 9
 *   动画 + 空  → 3 + 9 + 1 = 13
 *   静态 + 静态→ 3 + 5 + 5 = 13
 *   动画 + 动画→ 3 + 9 + 9 = 21
 * 下限 3（记录头本身），上限 21（v3 是 19，多出的 2 是两个 level 字节）。
 */
#define LUMEN_SCRIPT_SEGMENT_MIN 3
#define LUMEN_SCRIPT_SEGMENT_MAX 21

/*
 * 编码输出上限：16384 字节（v3 从 4KB 提到 16KB，NVS 分区同时扩到 64KB）。
 *
 * 典型用法（1-2 条灯带、4-8 阶段、3-4 段）远低于上限；理论最坏
 * （8 带 × 8 阶段 × 8 段 × 两层动画）单套就 10752 字节（v4 记录 21 字节），
 * 装不下 4 套——这是 4MB flash 的物理限制。**不要通过扩大上限来"修复"**：40KB 跨 10 个 page
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
 * 带槽位覆盖的编码（ScriptCommit 的尺寸预检用）。
 *
 * `override_script` 非空时，编码器把 `override_slot` 这个槽位当成它来写，
 * 其余槽位照常读 store。用途：候选剧本还在 staging 里，试编码时既不能把它
 * 拷贝到 committed（会污染可见状态），也不能拷到栈上（~12.6KB，NimBLE host
 * 任务栈只有 4KB —— 这正是真机上 commit 直接 panic 的原因）。
 *
 * override_script 为 NULL 时与 lumen_script_blob_encode 完全等价。
 */
size_t lumen_script_blob_encode_with_override(const lumen_script_store_t *store,
                                              uint8_t override_slot,
                                              const lumen_script_t *override_script,
                                              uint8_t active_script_id, bool loop, uint8_t *out,
                                              size_t out_cap);

/*
 * 把 `cleared_slot` **当成未提交**来编码（ClearScript 0x1E 的落盘前预检，#73）。
 *
 * store 里的剧本还没动：调用方先编一遍「清空后」的快照，编得出来才真的
 * memset 槽位并排队写 NVS。这样「存不下」不会留下 RAM 已清、flash 还有的
 * 撕裂状态（此时回 StorageFailed，原剧本保持可用）。
 *
 * 成功时写入的 active_script_id / loop 由调用方给（清空的正是激活剧本时传
 * LUMEN_NO_SCRIPT / false）。cleared_slot 越界返回 0。
 */
size_t lumen_script_blob_encode_with_cleared(const lumen_script_store_t *store,
                                             uint8_t cleared_slot, uint8_t active_script_id,
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
