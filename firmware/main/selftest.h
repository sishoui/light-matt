#pragma once

#include <stdbool.h>
#include <stdint.h>

/*
 * selftest：协议 §11.2 自检序列的纯逻辑，不依赖 FreeRTOS / ESP-IDF，
 * 因此可以在 host 上直接单测（时间由调用方注入）。
 *
 * 序列固定为 红 → 绿 → 蓝 → 白，每色 500ms，共 2s。
 *
 * 关键边界：
 *  - 自检只决定「这一帧该渲染什么颜色」，从不读写 lumen_state_t；
 *  - 序列走完自动变为未激活，调用方按存储状态重绘即恢复；
 *  - 再次 start 会把进度重置到红色并重新计时（§11.2 第 7 条）。
 */

#define LUMEN_SELFTEST_STEPS 4
#define LUMEN_SELFTEST_STEP_US (500 * 1000)

typedef struct {
    bool active;
    uint8_t step;            /* 0..LUMEN_SELFTEST_STEPS-1：红/绿/蓝/白 */
    int64_t step_started_us; /* 本步开始时刻，单位由调用方决定（设备用微秒） */
} lumen_selftest_t;

/* 归零：未激活、step=0、起点 0。 */
void lumen_selftest_reset(lumen_selftest_t *st);

/* 开始或重启序列：激活、回到红色、以 now_us 作为第一步的起点。 */
void lumen_selftest_start(lumen_selftest_t *st, int64_t now_us);

/* 立即取消（任何改变状态的命令 / 序列结束）。未激活时无副作用。 */
void lumen_selftest_stop(lumen_selftest_t *st);

bool lumen_selftest_active(const lumen_selftest_t *st);

/* 当前步骤下标（未激活时仍返回 0，调用方应先判断 active）。 */
uint8_t lumen_selftest_step(const lumen_selftest_t *st);

/*
 * 推进到 now_us 对应的步骤。
 *
 * 返回 true 表示自检仍激活；false 表示未激活或序列刚好走完。
 * 步骤用「已过时间 / 每步时长」计算，渲染任务被延迟唤醒时不会累积漂移，
 * 但错过的颜色不会补播（墙钟优先，2s 总时长不变）。
 */
bool lumen_selftest_advance(lumen_selftest_t *st, int64_t now_us);

/* 当前步骤的原始 RGB（满值 255/0）；未激活返回 false 且不写 out_rgb。 */
bool lumen_selftest_color(const lumen_selftest_t *st, uint8_t out_rgb[3]);

/* 距离下一次换色的微秒数；未激活返回 -1，已到期返回 0。 */
int64_t lumen_selftest_next_step_in_us(const lumen_selftest_t *st, int64_t now_us);

/* 步骤名（red/green/blue/white），只用于串口日志；越界返回 "?"。 */
const char *lumen_selftest_step_name(uint8_t step);

/*
 * 算出「这一帧实际该输出什么」——自检与存储状态的合成规则集中在这里，
 * 纯函数，host 可直接断言 §11.2 第 2/3/4 条：
 *   - 自检激活：颜色 = 自检色，亮度 = max_brightness（不看 power）；
 *   - 未激活：颜色 = 存储 RGB，亮度 = power ? clamp(brightness) : 0。
 *
 * 亮度是「线性乘算前的 0-255」，gamma 与 set_pixel 仍在 led_engine 里做。
 * selftest 为 NULL 或未激活时走存储状态分支。
 */
void lumen_selftest_compose(const lumen_selftest_t *st, uint8_t stored_power,
                            uint8_t stored_brightness, const uint8_t stored_rgb[3],
                            uint8_t max_brightness, uint8_t out_rgb[3],
                            uint8_t *out_brightness);
