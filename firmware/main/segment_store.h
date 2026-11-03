#pragma once

#include <stdbool.h>
#include <stdint.h>

#include "effects.h"
#include "protocol.h"

/*
 * 段配置存储 + 合成（纯模块，无 ESP-IDF 头，host 可测）。
 *
 * 职责（docs/v2-effects-engine.md §2 / §4、docs/protocol-v4.md §7.1）：
 *  - 8 条灯带 × 8 段的配置数组；
 *  - §7.1 第 2-8 步的**形状**校验（层类型 / 层亮度 / blend / 保留位 / 各类型参数）
 *    以及后续的 strip 范围、区间、重叠；
 *  - 把一条灯带的活动段合成为像素缓冲：**先 memset 0，再写各段**——
 *    未覆盖的灯珠必须是 0（WS2812B 锁存，不主动清零会留残影）。
 *
 * 不做的事：gamma / 亮度（渲染层）、持久化（state_store）、时间基准（led_engine）。
 */

/*
 * RAM 记录（v4）：
 *   sizeof(lumen_effect_layer_t) = 9 字节（type + param[7] + level）
 *   sizeof(lumen_segment_t)      = 28 字节（active + start/end/blend + 2 × 9 +
 *                                  t0_ms(4)，因 4 字节对齐从 25 涨到 28）
 *   sizeof(lumen_segment_store_t)= 1792 字节（8 条灯带 × 8 段 × 28）
 * v3 的 store 是 1536、v2 是 1024。更大的代价在剧本表（script_store.h），
 * 因为一套剧本是 4 脚本 × 8 阶段 × 8 灯带 × 8 段；v4 起约 70KB。
 */
typedef struct {
    lumen_segment_t slot[LUMEN_MAX_STRIPS][LUMEN_MAX_SEGMENTS];
} lumen_segment_store_t;

/* 全清（所有灯带、所有段）。 */
void lumen_segment_store_init(lumen_segment_store_t *store);

/* 清空某条灯带的全部段。 */
void lumen_segment_store_reset_strip(lumen_segment_store_t *store, uint8_t strip_id);

/*
 * 段的整体形状校验（§7.1 第 2-8 步，**不含 strip / 区间 / 重叠**）。
 *
 * 顺序固定：
 *   2 layer0 已知且不得为空层
 *   3 layer1 已知或空层；空层的 level 必须为 0
 *   4 任一层的 level ≤ 100
 *   5 layer1 为空 ⇒ blend 必须为 0
 *   6 blend ≤ 2
 *   7 静态层 param[3..6] 全 0（对两层都生效）
 *   8 各层按 type 校验参数（呼吸 p5 ≤ 100、熄灭参数全 0 由本函数单独判）
 *
 * 命令层、剧本层、blob 解码都复用这一处，拒收规则永远一致。
 */
uint8_t lumen_segment_validate_shape(const lumen_segment_t *seg);

/*
 * 只做「类型参数」规则（§7.1 第 8 步）：flags 保留位与周期区间。
 *
 * 静态层要求 flags == 0；呼吸 bit3-7 保留、周期 ≥334；彩虹/流光 bit1-7 保留、
 * 周期 ≥200；爆闪 flags == 0、周期 ≥100；心跳 bit1-7 保留、周期 500-1500；
 * 熄灭 flags == 0 且 period == 0（hue / sat / p5 由
 * lumen_segment_validate_shape 另判，本函数看不到它们）；未知类型一律非法。
 * period_ms == 0 表示静止，不受下限约束。
 *
 * v4 的呼吸 p5 从绝对 0-255 改为相对百分比 0-100，这条规则由
 * lumen_segment_validate_shape 单独判（彩虹/流光的 p5 仍是 0-255）。
 */
uint8_t lumen_segment_store_validate_params(uint8_t type, uint8_t flags, uint16_t period_ms);

/*
 * 校验一个候选段（§7.1 第 2-8 步之后接 strip 范围 / 区间 / 重叠）。
 *
 * 顺序严格固定：
 *   2-8 形状（lumen_segment_validate_shape，与命令层同一份规则）
 *   strip_id 范围   0 ≤ strip_id < strip_count
 *   段区间          start ≤ end 且 end < led_count
 *   段重叠          与同 strip 的其它活动段无交集（同 seg_id 视为替换自身）
 *
 * 返回 LUMEN_RESULT_OK 或 LUMEN_RESULT_INVALID_PARAM。
 */
uint8_t lumen_segment_store_validate(const lumen_segment_store_t *store, uint8_t strip_id,
                                     uint8_t strip_count, uint8_t seg_id, uint8_t led_count,
                                     const lumen_segment_t *candidate);

/*
 * 只做「单段」规则（形状 + strip 范围 + 区间，**不含重叠**），供剧本 commit 使用：
 * 剧本的段在 8 阶段 × 8 灯带的表里，构造一个 1.5KB 的临时段表去复用上面的函数
 * 会把 NimBLE 主机任务的 4KB 栈吃掉一大块。剧本层的重叠判定由 script_store
 * 自己按阶段表做。
 */
uint8_t lumen_segment_store_validate_single(uint8_t strip_id, uint8_t strip_count,
                                            uint8_t led_count,
                                            const lumen_segment_t *candidate);

/*
 * 校验并写入。校验失败时不修改任何槽位（旧配置保持不变）。
 */
uint8_t lumen_segment_store_set(lumen_segment_store_t *store, uint8_t strip_id,
                                uint8_t strip_count, uint8_t seg_id, uint8_t led_count,
                                const lumen_segment_t *candidate);

/* 释放槽位；返回 true 表示原本是活动段。旧配置之外的段不受影响。 */
bool lumen_segment_store_clear(lumen_segment_store_t *store, uint8_t strip_id, uint8_t seg_id);

/* 取一个槽位（可能是非活动段）。非法 strip / seg 返回 NULL。 */
const lumen_segment_t *lumen_segment_store_get(const lumen_segment_store_t *store,
                                               uint8_t strip_id, uint8_t seg_id);

/* 活动段数（State 的 strip_seg_counts 来源）。 */
uint8_t lumen_segment_store_count(const lumen_segment_store_t *store, uint8_t strip_id);

/* 活动段位图：bit i = 槽位 i 活动（SegmentListEnd 的 seg_mask）。 */
uint8_t lumen_segment_store_mask(const lumen_segment_store_t *store, uint8_t strip_id);

/* 该灯带是否有任何活动段（渲染层判断走分段路径还是 v1 单色路径）。 */
bool lumen_segment_store_any_active(const lumen_segment_store_t *store, uint8_t strip_id);

/*
 * 帧循环判据（docs/v2-effects-engine.md §3.1）：
 * 任一 strip < strip_count 上存在**动画类**活动段（见 lumen_effect_is_animated：
 * 静态与熄灭都不算）时为真。
 *
 * 渲染任务只在为真时带超时等待（动画帧率）；为假时阻塞在信号量上，
 * 与 v1 的静态场景完全一致（零额外 CPU / RMT）。剧本播放（#32）会在
 * 调用方 OR 进来，本函数不管剧本。
 */
bool lumen_segment_store_needs_frames(const lumen_segment_store_t *store, uint8_t strip_count);

/*
 * 把 seg 0 的基准色写进 out_rgb（docs/protocol-v4.md §7.3：State 字节 2-4）。
 * **取 layer[0]** 的 hue+sat（不含动画包络）；段 0 不活动时写全 0。
 */
void lumen_segment_store_state_rgb(const lumen_segment_store_t *store, uint8_t strip_id,
                                   uint8_t out_rgb[3]);

/*
 * 把一条灯带合成为像素缓冲（用户空间 RGB，不含 gamma）。
 *
 * buf 至少 led_count*3 字节且由调用方持有；本函数先整块清零。
 * 返回实际写入的灯珠数（= led_count）；无效参数返回 0 且不写 buf。
 */
uint16_t lumen_segment_store_compose(const lumen_segment_store_t *store, uint8_t strip_id,
                                     uint8_t *buf, uint16_t led_count, uint32_t now_ms);

/*
 * 灯珠数量变化后裁剪段配置（docs/v2-effects-engine.md §7.2 第 3 条）：
 * 任何 end >= new_count 的段失效。返回失效的段数。不自动缩短区间。
 */
uint8_t lumen_segment_store_prune(lumen_segment_store_t *store, uint8_t strip_id,
                                  uint16_t new_count);
