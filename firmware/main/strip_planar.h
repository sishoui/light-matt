#pragma once

#include <stdbool.h>
#include <stdint.h>

#include "protocol.h"

/*
 * strip_planar：8 条灯带的引脚/灯珠数配置 + TDM 轮询调度（纯模块，无 ESP-IDF 头）。
 *
 * 为什么需要 TDM（docs/animation-baseline.md §3）：
 * ESP32-C3 只有 2 个可用 RMT TX 通道（RMT_LL_TX_CANDIDATES_PER_INST = 2），
 * 8 条灯带不可能各占一个通道。做法是**一个通道 + 运行时切换输出引脚**
 * （led_strip_switch_gpio），靠 WS2812B 锁存保持画面：
 * 轮流把每条灯带的最新一帧推出去，两次推送之间那条灯带保持原样。
 *
 * 因此本模块只表达「下一轮该刷哪条、谁被标记降级、一轮花了多久」，
 * 不碰 led_strip、不碰 GPIO、不碰锁——真正的切换与刷灯在 led_engine /
 * led_strip_owner 里，所以这里的调度顺序可以在 host 上直接断言。
 *
 * 降级语义（票面「某一条不接时其余 7 条正常工作」）：
 * WS2812B 不会回报自己是否在线，所谓「不接」只能表现为**句柄创建失败**
 * 或 **refresh 失败**。两种都调用 lumen_planar_mark_degraded()：该条从轮询
 * 里摘掉、串口只提醒一次（避免每帧刷屏），其余灯带继续。恢复尝试由
 * led_engine 在配置变更（如重新设引脚/数量）时调用 revive。
 */

typedef struct {
    uint8_t gpio;     /* 数据脚 */
    uint16_t count;   /* 该条灯珠数，1-64 */
    bool enabled;     /* 参与轮询 */
    bool degraded;    /* 已判为不可用，暂不轮询 */
    bool warned;      /* 已打印过降级警告，避免每帧刷屏 */
} lumen_planar_strip_t;

typedef struct {
    lumen_planar_strip_t strips[LUMEN_MAX_STRIPS];
    uint8_t strip_count; /* 1-8，实际配置的条数 */
    uint8_t cursor;      /* 下一轮从哪条开始 */
    uint16_t max_count;  /* 所有条里的最大灯珠数（句柄 max_leds） */
} lumen_planar_t;

/* 轮询统计：串口要用它证明「每轮耗时 / 每条刷新间隔」（票面要求的数字）。 */
typedef struct {
    uint32_t rounds;         /* 完成的轮数 */
    uint32_t strips_pushed;  /* 累计推送次数（不含降级跳过的） */
    uint32_t round_us_last;  /* 最近一轮耗时（微秒） */
    uint32_t round_us_max;   /* 最长一轮耗时 */
    uint32_t round_us_total; /* 轮数 × 每轮累加，用于算平均 */
} lumen_planar_stats_t;

/* 解析 "3,4,5" 形式的引脚列表。返回解析出的个数；非法输入返回 0。 */
uint8_t lumen_planar_parse_list(const char *text, uint16_t *out, uint8_t cap);

/*
 * 用引脚表与灯珠数表初始化。
 *
 * pins/counts 长度都必须 >= strip_count；strip_count 必须在 1..LUMEN_MAX_STRIPS。
 * 灯珠数越界（0 或 > LUMEN_MAX_LEDS）或引脚重复时返回 false 且不改 planar。
 */
bool lumen_planar_init(lumen_planar_t *planar, const uint8_t *pins, const uint16_t *counts,
                       uint8_t strip_count);

/* 取某条的配置；越界返回 NULL。 */
const lumen_planar_strip_t *lumen_planar_get(const lumen_planar_t *planar, uint8_t strip_id);

/* 改某条的灯珠数（SetLedCount）。越界返回 false。 */
bool lumen_planar_set_count(lumen_planar_t *planar, uint8_t strip_id, uint16_t count);

/*
 * 取下一轮要刷的 strip_id，并推进 cursor。
 *
 * - 跳过 degraded 条（但保留在配置里，随时可 revive）；
 * - 全部降级时返回 LUMEN_PLANAR_NONE，调用方据此跳过刷新而不是死等。
 */
#define LUMEN_PLANAR_NONE 0xFF

uint8_t lumen_planar_next(lumen_planar_t *planar);

/* 标记降级。首次标记时返回 true（调用方据此只打印一次警告）。 */
bool lumen_planar_mark_degraded(lumen_planar_t *planar, uint8_t strip_id);

/* 恢复为可用。返回 true 表示该条之前确实是降级状态。 */
bool lumen_planar_revive(lumen_planar_t *planar, uint8_t strip_id);

/*
 * 恢复所有降级条。
 *
 * 唯一的重试入口：配置变更（改引脚/灯珠数）时调用。刻意**不做**每轮自动重试——
 * 一条真没接的灯带会让每轮都失败一次，串口和 CPU 都白花；而「接上了一条
 * 曾判降级的灯带」在物理上必然伴随用户操作，那一刻触发重试就够。
 */
uint8_t lumen_planar_revive_all(lumen_planar_t *planar);

/* 可用（enabled 且未降级）的条数。 */
uint8_t lumen_planar_active_count(const lumen_planar_t *planar);

/* 统计：开始/结束一轮。round_us 由调用方用 esp_timer 量。 */
void lumen_planar_stats_reset(lumen_planar_stats_t *stats);
void lumen_planar_note_round(lumen_planar_stats_t *stats, uint32_t round_us, uint8_t pushed);

/* 平均每轮耗时（微秒）；没跑过返回 0。 */
uint32_t lumen_planar_stats_avg_us(const lumen_planar_stats_t *stats);
