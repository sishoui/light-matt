#pragma once

#include <stdbool.h>
#include <stdint.h>

#include "script_store.h"
#include "segment_store.h"

/*
 * 方案作用域（#122，纯逻辑，**无 ESP-IDF / FreeRTOS 依赖，host 可测**）。
 *
 * ## 为什么需要这一层
 *
 * 协议里整个设备只有**一份**播放头、一个 `stage_index`、一个 `loop`：一套方案
 * 的阶段一次性给所有灯带铺内容。于是「只编排了 strip0 的方案」一激活，其余
 * 灯带也被拖进同一条时间轴——停播时它们跟着闪一下，播完跟着一起停。
 *
 * 修法不是改协议（字节布局与版本号都不动），而是**渲染前合成一份段配置**：
 * 参与方案的灯带取当前阶段的内容，没参与的取实时分区。下游的推帧 / 合成 /
 * `strip_anim_mask` 因此一行都不用改。
 *
 * ## 归属口径
 *
 * - 一条灯带只要在**任意一个阶段**出现过，整份方案期间都归方案管（并集口径，
 *   中途不切换渲染源）。判定只依赖已提交的脚本内容，不依赖播放头。
 * - 参与但在**当前这一步**没有段 → 该步输出黑（不是「保持上一步」，也不是
 *   「回退实时分区」）。这一条由调用方把归属位传给合成路径实现：只有归属位
 *   能让「零个活动段」与「这一条根本不归我管」区分开。
 * - `loop=0` 走完、播放头停在最后一阶段时，参与带冻结最后一帧；未参与的带
 *   仍然逐帧合成自己的实时分区。
 */

/* 一条灯带是否归当前方案管：`script_mask` 的第 `strip_id` 位。 */
bool lumen_scope_is_script_strip(uint8_t script_mask, uint8_t strip_id);

/*
 * 整份方案覆盖的灯带并集（Q10）：任一阶段的任一段活动即置位。
 *
 * 只看 `strip_id < script->strip_count` 的灯带——那是本方案声明覆盖的范围。
 * `script` 为 NULL 返回 0。
 */
uint8_t lumen_script_strip_union_mask(const lumen_script_t *script);

/*
 * 这一帧渲染第 `strip_id` 条时该用哪份段配置。
 *
 * 归方案管 → `stage`（当前阶段的内容，可能整条为空 = 该步全黑）；
 * 否则 → `live`（实时分区）。
 *
 * `stage` 或 `live` 为 NULL 时退化为另一份（都不给则返回 NULL），让调用方
 * 不必在每个调用点重复判空。
 */
const lumen_segment_store_t *lumen_scope_source_for_strip(const lumen_segment_store_t *stage,
                                                          const lumen_segment_store_t *live,
                                                          uint8_t script_mask, uint8_t strip_id);

/*
 * 合成「这一帧真正要渲染的段配置」：逐条按归属从 `stage` 或 `live` 整条拷贝。
 *
 * 这是 Q16 的那个合成源。`out` 必须与两份输入都不重叠（渲染任务用它自己的
 * 静态缓冲）。
 */
void lumen_scope_compose(lumen_segment_store_t *out, const lumen_segment_store_t *stage,
                         const lumen_segment_store_t *live, uint8_t script_mask,
                         uint8_t strip_count);

/*
 * 这一条该走「分段合成」还是「v1 单色」（整条铺满全局 RGB）。
 *
 * `led_render.c::compose_frame` 的唯一判据，抽出来是为了让 host 能断言它：
 * 归方案管的带**即使这一步没有任何段**也必须走分段路径（于是输出全黑），
 * 退回单色会让「这一步让这条灯组熄一下」整条亮成纯色——那正是用户看到的
 * 「亮起再熄灭」。未归方案管的带保持老判据（有活动段才分段），
 * 单灯带 v1 行为因此逐字节不变。
 *
 * `power` 为 0（总闸关）或自检期间一律走单色，与渲染层原有规则一致。
 */
bool lumen_scope_uses_segments(bool script_owned, bool has_active_segments, bool power_on,
                               bool selftest_active);

/*
 * 按归属口径推导 `strip_anim_mask`（State 字节 12）。
 *
 * 与 `lumen_strip_anim_mask` 的区别只有一处：取值来源逐条按归属选。未参与
 * 方案的灯带因此保留自己的动画位——这正是「方案只驱动它包含的灯带」在 State
 * 上的可观测证据。
 */
uint8_t lumen_scope_anim_mask(const lumen_segment_store_t *stage,
                              const lumen_segment_store_t *live, uint8_t script_mask,
                              uint8_t strip_count);
