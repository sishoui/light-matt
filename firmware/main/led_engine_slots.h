#pragma once

#include <stdbool.h>
#include <stdint.h>

#include "segment_store.h"

/*
 * 段槽位枚举（纯逻辑，**无 ESP-IDF / FreeRTOS 依赖，host 可测**）。
 *
 * 为什么单独成文件（#49）：这段逻辑原本在 led_engine.c 的
 * lumen_led_engine_segments() 里，但 led_engine.c 整体依赖 FreeRTOS 信号量、
 * esp_timer 和 ESP-IDF 头，无法进 host 测试的编译清单。于是
 * 「SegmentReport 报真实槽位」（spec-v3 §4.2 第 3 处缺陷）这条修复就只靠
 * 代码注释自证：任何人把它改回压缩序号，10993 项断言都会全绿。
 *
 * 拆出来后：led_engine.c 仍然负责加锁与取快照，本函数只做「遍历槽位 →
 * 输出活动段 + 真实槽位号」，不碰任何共享状态，因此行为与抽取前逐字节一致。
 */

/*
 * 把 store 中 strip_id 的活动段按**槽位升序**拷进 out。
 *
 * out      按槽位升序填充活动段，最多 cap 个；
 * out_slots 可选（NULL = 不关心），同时给出每个活动段的**真实槽位号**。
 *           这就是 spec-v3 §4.2 第 3 处要求的 seg_id 来源，**不是**压缩序号 i。
 * cap       out 的容量，0 表示不写出任何内容。
 *
 * 返回写入个数。store/out 为 NULL、strip_id 越界或 cap 为 0 时返回 0。
 */
uint8_t lumen_led_engine_collect_segments(const lumen_segment_store_t *store, uint8_t strip_id,
                                          lumen_segment_t *out, uint8_t *out_slots, uint8_t cap);
