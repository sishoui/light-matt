#include "scene_compose.h"

#include <string.h>

void lumen_part_clocks_init(lumen_part_clocks_t *clocks)
{
    if (clocks == NULL) {
        return;
    }
    memset(clocks, 0, sizeof(*clocks));
}

void lumen_part_clock_start(lumen_part_clock_t *clock, uint32_t now_ms)
{
    if (clock == NULL || clock->started) {
        return; /* 已经启动过：不重置（编辑不打断时钟，E2） */
    }
    clock->origin_ms = now_ms;
    clock->started = true;
}

void lumen_part_clocks_reset_strip(lumen_part_clocks_t *clocks, uint8_t strip_id,
                                   uint8_t part_count, uint32_t now_ms)
{
    if (clocks == NULL || strip_id >= LUMEN_MAX_STRIPS) {
        return;
    }
    for (uint8_t p = 0; p < LUMEN_MAX_PARTS; ++p) {
        if (p < part_count) {
            clocks->clock[strip_id][p].origin_ms = now_ms;
            clocks->clock[strip_id][p].started = true;
        } else {
            clocks->clock[strip_id][p].origin_ms = 0;
            clocks->clock[strip_id][p].started = false;
        }
    }
}

lumen_part_position_t lumen_part_clock_advance(const lumen_part_scene_t *part,
                                               const lumen_part_clock_t *clock, uint32_t now_ms)
{
    lumen_part_position_t out = {0, 0, 0, true};
    if (part == NULL || clock == NULL) {
        return out;
    }
    uint8_t steps = part->step_count > LUMEN_MAX_STEPS ? LUMEN_MAX_STEPS : part->step_count;
    if (steps == 0 || !clock->started) {
        /* 0 步 = 本场景不演（S10）；未启动的部位停在起点但不前进。 */
        return out;
    }

    /*
     * 无符号差值 + 有符号判向：`now < origin`（例如调用方把时钟往前调、或
     * 上电时 origin 还没写）按 0 处理，不产生天文数字一样的 elapsed。
     * 用 (int32_t) 判向而不是直接比大小，是因为 uint32 会在约 49 天后自然回绕
     * ——回绕时差值在 int32 范围内仍然是小的正数，必须照常推进。
     */
    int32_t delta = (int32_t)(now_ms - clock->origin_ms);
    uint32_t elapsed = delta < 0 ? 0 : (uint32_t)delta;

    uint32_t total = 0;
    for (uint8_t i = 0; i < steps; ++i) {
        total += part->step[i].duration_ms;
    }
    if (total == 0) {
        /* 所有步时长都为 0（不该出现，写入已拒绝 0 时长）：停在第一帧。 */
        out.step_index = 0;
        out.finished = true;
        return out;
    }

    switch (part->loop) {
    case LUMEN_LOOP_ALL_V5:
        /* 全部循环：按总时长折回。 */
        elapsed %= total;
        break;

    case LUMEN_LOOP_LAST_V5: {
        /*
         * 最后一步循环：前 N-1 步各播一次，之后原地重播末步。
         * N == 1 时「前 0 步」无用，整段就是末步重复——等价于全部循环。
         */
        if (steps == 1) {
            elapsed %= part->step[0].duration_ms;
            out.step_index = 0;
            out.elapsed_ms = elapsed;
            out.step_start_ms = now_ms - elapsed;
            out.finished = false;
            return out;
        }
        uint32_t head = 0; /* 前 N-1 步的总时长 */
        for (uint8_t i = 0; (uint8_t)(i + 1u) < steps; ++i) {
            head += part->step[i].duration_ms;
        }
        if (elapsed < head) {
            break; /* 还在前 N-1 步里，走下面的顺序查找 */
        }
        uint16_t last_dur = part->step[steps - 1].duration_ms;
        uint32_t in_last = (uint32_t)((elapsed - head) % last_dur);
        out.step_index = (uint8_t)(steps - 1);
        out.elapsed_ms = in_last;
        out.step_start_ms = (uint32_t)(now_ms - in_last);
        out.finished = false;
        return out;
    }

    case LUMEN_LOOP_NONE_V5:
    default:
        /*
         * 不循环：走完停在最后一帧（T4：不熄灭、不回头）。
         * 末步的 phase 冻结在它的时长处，画面不再变化。
         */
        if (elapsed >= total) {
            out.step_index = (uint8_t)(steps - 1);
            out.elapsed_ms = part->step[steps - 1].duration_ms;
            out.step_start_ms = (uint32_t)(now_ms - out.elapsed_ms);
            out.finished = true;
            return out;
        }
        break;
    }

    /* 在步表里顺序定位（≤ 8 步，顺序查找比二分更快且无分支错误风险）。 */
    uint32_t acc = 0;
    for (uint8_t i = 0; i < steps; ++i) {
        uint16_t dur = part->step[i].duration_ms;
        if (elapsed < acc + dur) {
            out.step_index = i;
            out.elapsed_ms = elapsed - acc;
            out.step_start_ms = (uint32_t)(now_ms - out.elapsed_ms);
            out.finished = false;
            return out;
        }
        acc += dur;
    }

    /* 兜底：浮点误差不可能出现（全整数），但防御一下停在末步。 */
    out.step_index = (uint8_t)(steps - 1);
    out.elapsed_ms = part->step[steps - 1].duration_ms;
    out.step_start_ms = (uint32_t)(now_ms - out.elapsed_ms);
    out.finished = part->loop == LUMEN_LOOP_NONE_V5;
    return out;
}

bool lumen_scene_build_segment(const lumen_scene_t *scene, uint8_t strip_id, uint8_t part_id,
                               uint16_t logical_count, const lumen_part_clock_t *clock,
                               uint32_t now_ms, lumen_segment_t *out)
{
    if (scene == NULL || clock == NULL || out == NULL) {
        return false;
    }
    if (strip_id >= LUMEN_MAX_STRIPS || part_id >= LUMEN_MAX_PARTS) {
        return false;
    }
    const lumen_part_scene_t *part = &scene->part[strip_id][part_id];
    if (!lumen_scene_part_plays(scene, strip_id, part_id)) {
        return false;
    }
    lumen_part_position_t pos = lumen_part_clock_advance(part, clock, now_ms);
    if (pos.step_index >= part->step_count) {
        return false;
    }
    const lumen_scene_step_t *step = &part->step[pos.step_index];

    memset(out, 0, sizeof(*out));
    out->active = true;
    out->start = 0;
    /*
     * 段的几何是「逻辑灯带」的 [0, n-1]。logical_count 为 0 时仍然给 end = 0，
     * 让 lumen_effect_pixel 的越界门直接输出黑（不会读到负下标）。
     */
    out->end = logical_count > 0 ? (uint8_t)(logical_count - 1) : 0;
    out->layer[0] = step->layer[0];
    out->layer[1] = step->layer[1];
    /*
     * 混合方式不在线上（E6）：有叠加层 → 按亮度叠加，否则覆盖。
     * 这与 lumen_scene_set_step 的规范化必须一致，否则合成与写入判定会分叉。
     */
    out->blend = lumen_layer_is_empty(&step->layer[1]) ? (uint8_t)LUMEN_BLEND_OVER
                                                       : (uint8_t)LUMEN_BLEND_LUMA;
    /*
     * 时间原点：把「这一步开始的那一刻」写成 t0，于是
     * lumen_effect_pixel(seg, i, now_ms) 看到的 (now - t0) 正好是步内已用时间。
     * 这样现有全部包络函数原样可用，不需要给 effects API 加时钟参数（§9.4）。
     */
    out->t0_ms = pos.step_start_ms;
    return true;
}

bool lumen_scene_strip_needs_frames(const lumen_layout_store_t *layout,
                                    const lumen_scene_t *scene, uint8_t strip_id)
{
    if (layout == NULL || scene == NULL || strip_id >= LUMEN_MAX_STRIPS) {
        return false;
    }
    for (uint8_t p = 0; p < layout->part_count[strip_id] && p < LUMEN_MAX_PARTS; ++p) {
        /* 没有划分灯珠的部位不参与渲染，自然也不需要帧。 */
        const lumen_part_layout_t *part = &layout->part[strip_id][p];
        if (part->segs.seg_count == 0) {
            continue;
        }
        const lumen_part_scene_t *ps = &scene->part[strip_id][p];
        if (ps->step_count == 0 || ps->on == 0) {
            continue;
        }
        for (uint8_t s = 0; s < ps->step_count && s < LUMEN_MAX_STEPS; ++s) {
            lumen_segment_t probe;
            memset(&probe, 0, sizeof(probe));
            probe.active = true;
            probe.start = 0;
            probe.end = 0;
            probe.layer[0] = ps->step[s].layer[0];
            probe.layer[1] = ps->step[s].layer[1];
            if (lumen_segment_is_animated(&probe)) {
                return true;
            }
        }
    }
    return false;
}

uint16_t lumen_scene_compose(const lumen_layout_store_t *layout, const lumen_scene_t *scene,
                             const lumen_part_clocks_t *clocks, uint32_t now_ms,
                             uint8_t strip_id, lumen_phase_mode_t phase, uint8_t *buf,
                             uint16_t led_count)
{
    if (layout == NULL || scene == NULL || clocks == NULL || buf == NULL) {
        return 0;
    }
    if (strip_id >= LUMEN_MAX_STRIPS || led_count == 0 || led_count > LUMEN_MAX_LEDS) {
        return 0;
    }

    /*
     * 第 1 步：整块清零 → **灰缝恒黑**。WS2812B 会锁存上一帧，不主动清零就留
     * 残影；这一条也是「未覆盖灯珠是真黑」的实现来源（S3）。
     */
    memset(buf, 0, (size_t)led_count * 3u);

    uint8_t parts = layout->part_count[strip_id];
    if (parts > LUMEN_MAX_PARTS) {
        parts = LUMEN_MAX_PARTS;
    }

    for (uint8_t p = 0; p < parts; ++p) {
        const lumen_part_layout_t *part = &layout->part[strip_id][p];
        if (part->segs.seg_count == 0) {
            continue; /* 没有划出灯珠的部位：整段黑，继续下一个 */
        }
        if (!lumen_scene_part_plays(scene, strip_id, p)) {
            continue; /* 0 步或部位开关关掉（T8：只灭灯，时钟照走） */
        }
        uint16_t logical_n = lumen_layout_part_pixel_count(part);
        if (logical_n == 0) {
            continue;
        }

        /* 第 2 步：当前步的两层 → 临时段（几何 [0, n-1]，t0 = 步起点）。 */
        lumen_segment_t seg;
        if (!lumen_scene_build_segment(scene, strip_id, p, logical_n, &clocks->clock[strip_id][p],
                                       now_ms, &seg)) {
            continue;
        }

        /*
         * 逐段散回物理位置：连续相位下逻辑下标是「覆盖集合的升序名次」，
         * 各自起点下是「段内偏移」——两者都由 lumen_layout_logical_index 给。
         */
        for (uint8_t s = 0; s < part->segs.seg_count && s < LUMEN_MAX_PART_SEGS; ++s) {
            uint8_t start = part->segs.seg[s][0];
            uint8_t end = part->segs.seg[s][1];
            if (start == LUMEN_SEG_UNWRITTEN || end == LUMEN_SEG_UNWRITTEN) {
                continue; /* 还没写的段（分帧下发中间态） */
            }
            if (start > end || end >= led_count) {
                continue; /* blob 校验已拒，这里只是防御 */
            }
            for (uint16_t i = start; i <= end; ++i) {
                uint16_t logical = lumen_layout_logical_index(part, i, phase);
                if (logical >= logical_n) {
                    logical = (uint16_t)(logical_n - 1);
                }
                uint8_t rgb[3];
                lumen_effect_pixel(&seg, logical, now_ms, rgb);
                uint8_t *dst = &buf[(size_t)i * 3u];
                /*
                 * 多段不会重叠（S3），所以这里直接赋值；不存在相加变亮。
                 * 部位之间也不重叠，后写的部位不会盖掉前一个。
                 */
                dst[0] = rgb[0];
                dst[1] = rgb[1];
                dst[2] = rgb[2];
            }
        }
    }

    return led_count;
}
