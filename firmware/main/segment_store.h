#pragma once

#include <stdbool.h>
#include <stdint.h>

#include "effects.h"
#include "protocol.h"

/*
 * 段配置存储 + 合成（纯模块，无 ESP-IDF 头，host 可测）。
 *
 * 职责（docs/v2-effects-engine.md §2 / §4）：
 *  - 8 条灯带 × 8 段的配置数组；
 *  - 校验顺序 §11.3 的第 5-9 步（strip 范围、区间、重叠、flags 保留位、周期下限）；
 *  - 把一条灯带的活动段合成为像素缓冲：**先 memset 0，再写各段**——
 *    未覆盖的灯珠必须是 0（WS2812B 锁存，不主动清零会留残影）。
 *
 * 不做的事：gamma / 亮度（渲染层）、持久化（state_store）、时间基准（led_engine）。
 */

typedef struct {
    lumen_segment_t slot[LUMEN_MAX_STRIPS][LUMEN_MAX_SEGMENTS];
} lumen_segment_store_t;

/* 全清（所有灯带、所有段）。 */
void lumen_segment_store_init(lumen_segment_store_t *store);

/* 清空某条灯带的全部段。 */
void lumen_segment_store_reset_strip(lumen_segment_store_t *store, uint8_t strip_id);

/*
 * 校验一个候选段（§11.3 第 5-9 步），调用方已确认 type 已知且载荷长度匹配。
 *
 * 顺序严格固定：
 *   5 strip_id 范围   0 ≤ strip_id < strip_count（#25 只有 1 条灯带，传 1 也是 InvalidParam）
 *   6 段区间          start ≤ end 且 end < led_count
 *   7 段重叠          与同 strip 的其它活动段无交集（同 seg_id 视为替换自身）
 *   8 flags 保留位    静态必须 0；呼吸 bit3-7、彩虹·流光 bit1-7 必须 0
 *   9 周期下限        呼吸 ≥334、彩虹/流光 ≥200（period = 0 均不受限）
 *
 * 返回 LUMEN_RESULT_OK 或 LUMEN_RESULT_INVALID_PARAM。
 */
uint8_t lumen_segment_store_validate(const lumen_segment_store_t *store, uint8_t strip_id,
                                     uint8_t strip_count, uint8_t seg_id, uint8_t led_count,
                                     const lumen_segment_t *candidate);

/*
 * 只做「单段」规则（§11.3 第 5/6/8/9 步，**不含重叠**），供剧本 commit 使用：
 * 剧本的段在 8 阶段 × 8 灯带的表里，构造一个 1KB 的临时段表去复用上面的函数
 * 会把 NimBLE 主机任务的 4KB 栈吃掉四分之一。剧本层的重叠判定由
 * script_store 自己按阶段表做。
 */
uint8_t lumen_segment_store_validate_single(uint8_t strip_id, uint8_t strip_count,
                                            uint8_t led_count,
                                            const lumen_segment_t *candidate);

/*
 * 校验并写入。校验失败时不修改任何槽位（旧配置保持不变）。
 * success 时 *out_stored 为写入后的段（t0_ms 已由调用方设置）。
 */
uint8_t lumen_segment_store_set(lumen_segment_store_t *store, uint8_t strip_id,
                                uint8_t strip_count, uint8_t seg_id, uint8_t led_count,
                                const lumen_segment_t *candidate);

/* 释放槽位；返回 true 表示原本是活动段。旧配置之外的段不受影响。 */
bool lumen_segment_store_clear(lumen_segment_store_t *store, uint8_t strip_id, uint8_t seg_id);

/* 取一个槽位（可能是非活动段）。非法 strip / seg 返回 NULL。 */
const lumen_segment_t *lumen_segment_store_get(const lumen_segment_store_t *store,
                                               uint8_t strip_id, uint8_t seg_id);

/* 活动段数（State 字节 9 的 seg_count 来源）。 */
uint8_t lumen_segment_store_count(const lumen_segment_store_t *store, uint8_t strip_id);

/* 活动段位图：bit i = 槽位 i 活动（SegmentListEnd 的 seg_mask）。 */
uint8_t lumen_segment_store_mask(const lumen_segment_store_t *store, uint8_t strip_id);

/* 该灯带是否有任何活动段（渲染层判断走分段路径还是 v1 单色路径）。 */
bool lumen_segment_store_any_active(const lumen_segment_store_t *store, uint8_t strip_id);

/*
 * 帧循环判据（docs/v2-effects-engine.md §3.1）：
 * 任一 strip < strip_count 上存在**动画类**活动段（type != 0x00）时为真。
 *
 * 渲染任务只在为真时带超时等待（动画帧率）；为假时阻塞在信号量上，
 * 与 v1 的静态场景完全一致（零额外 CPU / RMT）。剧本播放（#32）会在
 * 调用方 OR 进来，本函数不管剧本。
 */
bool lumen_segment_store_needs_frames(const lumen_segment_store_t *store, uint8_t strip_count);

/*
 * 把 seg 0 的基准色写进 out_rgb（docs/protocol.md §7：State 字节 2-4）。
 * 段 0 不活动或没有段时写全 0。不包含动画包络（静态段本来就没有）。
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
