#pragma once

#include <stdbool.h>
#include <stdint.h>

#include "effects.h"
#include "layout_store.h"
#include "scene_store.h"
#include "state.h"

/*
 * v5 唯一的渲染接缝：`lumen_scene_compose(...)`（纯模块，host 可测）。
 *
 * 唯一真相是 docs/protocol-v5.md §9.3（合成顺序）与 §9.4（相位与播放头）。
 *
 * 为什么单独一个 .c：`led_render.c` 依赖 `led_strip.h` / `esp_log.h`，不在
 * host 编译清单里。把合成塞进它就等于放弃这条接缝的单测能力——而规格把它
 * 定为「唯一的新接缝」。
 *
 * 职责边界（与 v4 同一条顺序）：
 *   - 本模块产出**用户空间 RGB**（0-255），**不做 gamma、不乘全局亮度**；
 *   - 全局亮度与 gamma 仍在渲染层对整帧做**一次**（led_render.c）。
 */

/*
 * 一个部位的播放头。
 *
 * 只存 `origin_ms`（一个时间原点），**不存相位变量**：步号与步内时间都由
 * `lumen_part_clock_advance` 从 `(now - origin)` 一次性算出，不做累加。
 * 累加会在长时间运行后越走越偏（规格「Further Notes」第 3 条风险）。
 *
 * `started == false` 表示这个部位还没有被启动过（例如刚建的部位）。
 */
typedef struct {
    uint32_t origin_ms;
    bool started;
} lumen_part_clock_t;

/* 64 个播放头：8 链 × 8 部位（规格 §11）。 */
typedef struct {
    lumen_part_clock_t clock[LUMEN_MAX_STRIPS][LUMEN_MAX_PARTS];
} lumen_part_clocks_t;

/*
 * 播放头求值的结果（纯数据，不引用任何表）。
 */
typedef struct {
    uint8_t step_index;   /* 当前步号；step_count 为 0 时无意义 */
    uint32_t elapsed_ms;  /* 当前步内已用时间（已按循环折回） */
    uint32_t step_start_ms; /* 当前步的起点（相对 origin），= now - elapsed */
    bool finished;        /* 仅 loop = 0：已经播完，停在最后一帧 */
} lumen_part_position_t;

/* 全清：所有播放头未启动。 */
void lumen_part_clocks_init(lumen_part_clocks_t *clocks);

/* 把某链所有部位的播放头重置到此刻（T3 / C4 / U10）。 */
void lumen_part_clocks_reset_strip(lumen_part_clocks_t *clocks, uint8_t strip_id,
                                   uint8_t part_count, uint32_t now_ms);

/*
 * 启动单个部位的播放头（T7：新加的部位从自己的第 1 步起跳）。
 * 已经启动过的部位不会被重置——「编辑不打断时钟」（E2 / 验收项）。
 */
void lumen_part_clock_start(lumen_part_clock_t *clock, uint32_t now_ms);

/*
 * 纯函数：从 (origin, now) 与步表算出当前步号与步内时间。
 *
 * 三档循环（§7.5）：
 *   - loop = 0   不循环：走完停在最后一帧（T4）。`finished = true`，
 *                `step_index` 是末步，`elapsed_ms` 是末步的时长。
 *   - loop = 1   全部循环：按总时长取模。
 *   - loop = 2   最后一步循环：前 N-1 步各播一次，之后原地重播末步。
 *
 * 边界：
 *   - step_count == 0 → `finished = true`，`step_index = 0`，`elapsed_ms = 0`。
 *   - 单步 + loop = 0 → 立即 finished（那一帧一直显示下去）。
 *   - `now < origin`（时钟回绕）按 0 处理，不产生负时间。
 *   - 超大 `now`（例如 origin = 0、now = 0xFFFFFFFF）不溢出：
 *     全程用 uint32 无符号减法与 uint64 中间量。
 */
lumen_part_position_t lumen_part_clock_advance(const lumen_part_scene_t *part,
                                               const lumen_part_clock_t *clock, uint32_t now_ms);

/*
 * 合成一条链的像素（docs/protocol-v5.md §9.3）：
 *
 *   1. 整块清零 → 灰缝恒黑（未覆盖的灯珠是真黑，不是上一帧残留）；
 *   2. 逐部位取「当前步的两层」，按**该部位自己的**相位模式求逻辑下标（§9.2：
 *      相位是每部位一份，所以没有 chain 级参数），调 lumen_effect_pixel；
 *   3. 把逻辑像素按段的物理区间散回物理位置；
 *   4. 全局亮度与 gamma **不在这里做**。
 *
 * 门控两层：
 *   - 部位开关（场景的 `on`）：关掉只灭灯，时钟照走；
 *   - 未覆盖灯珠与 `step_count == 0` 的部位：恒黑。
 *
 * `buf` 至少 `led_count * 3` 字节且由调用方持有。返回实际写入的灯珠数
 * （= led_count）；无效参数返回 0 且不写 buf。
 */
uint16_t lumen_scene_compose(const lumen_layout_store_t *layout, const lumen_scene_t *scene,
                             const lumen_part_clocks_t *clocks, uint32_t now_ms,
                             uint8_t strip_id, uint8_t *buf, uint16_t led_count);

/*
 * 该链是否需要帧循环（动画判据）。
 *
 * 只有「真的要出光」的部位参与判断：0 步、开关关掉、未覆盖段都不该让渲染
 * 任务一直转。部位里有任何一步是动画类（`lumen_segment_is_animated` 的同一
 * 判据）就算需要帧。
 */
bool lumen_scene_strip_needs_frames(const lumen_layout_store_t *layout,
                                    const lumen_scene_t *scene, uint8_t strip_id);

/*
 * 把「当前步的两层」构造成一个临时段（供合成与编辑器预览共用）。
 *
 * 段的几何是 `[0, n-1]`（n = 该部位的逻辑灯珠数），`t0_ms` 设为该部位的
 * 时钟原点再减去步内已用时间——这样 `lumen_effect_pixel` 的现有包络函数
 * 会看到「这一步已经走了 elapsed_ms」。这正是 §9.3 第 2 步说的构造方式，
 * 不需要改 effects API。
 *
 * 混合方式由有无叠加层决定：layer1 为空 → 覆盖；非空 → 按亮度叠加（E6）。
 * 返回 false 表示该部位此刻不该出光（0 步 / 开关关 / 步号越界）。
 */
bool lumen_scene_build_segment(const lumen_scene_t *scene, uint8_t strip_id, uint8_t part_id,
                               uint16_t logical_count, const lumen_part_clock_t *clock,
                               uint32_t now_ms, lumen_segment_t *out);
