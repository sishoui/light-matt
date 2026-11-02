#include "led_engine_slots.h"

#include <stddef.h>

/*
 * 段槽位枚举。
 *
 * 本文件的唯一职责是从段表里挑出活动段，并同时给出它们的真实槽位号。
 * 逻辑逐行对应 #49 之前写在 led_engine.c 里的那一版，唯一变化是把
 * s_segments 换成参数、把信号量留在调用方（led_engine.c）里。
 */

uint8_t lumen_led_engine_collect_segments(const lumen_segment_store_t *store, uint8_t strip_id,
                                          lumen_segment_t *out, uint8_t *out_slots, uint8_t cap)
{
    if (store == NULL || out == NULL || cap == 0 || strip_id >= LUMEN_MAX_STRIPS) {
        return 0;
    }
    uint8_t written = 0;
    for (uint8_t slot = 0; slot < LUMEN_MAX_SEGMENTS && written < cap; ++slot) {
        const lumen_segment_t *seg = &store->slot[strip_id][slot];
        if (!seg->active) {
            continue;
        }
        out[written] = *seg;
        /*
         * spec-v3 §4.2 第 3 处缺陷：SegmentReport 必须报**真实槽位**，
         * 不是压缩后的序号——小程序要按 seg_id 精确对应到可编辑的槽位。
         * 这条断言由 firmware/test/test_skeleton.c 的 test_segment_real_slots()
         * 守住；改动这里之前先看那条用例。
         */
        if (out_slots != NULL) {
            out_slots[written] = slot;
        }
        ++written;
    }
    return written;
}
