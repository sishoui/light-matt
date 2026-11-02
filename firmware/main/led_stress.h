#pragma once

#include <stdint.h>

#include "state.h"

/*
 * led_stress：issue #7 的 RMT × BLE 共存压力阶段（仅实验固件）。
 *
 * 产品固件不编译本文件的主体（CONFIG_LUMEN_RMT_STRESS_MODE 关闭时函数体为空），
 * 因此产品路径的渲染行为与 #6 骨架完全一致。
 *
 * 压力阶段需要读快照 / 提交状态 / 取亮度上限：这些能力由 led_engine 通过
 * 函数指针注入，避免 led_stress 反向包含 led_engine.h 形成调用环。
 */
typedef struct {
    void (*snapshot)(lumen_state_t *out);
    void (*commit)(const lumen_state_t *next, uint8_t command);
    uint8_t (*max_brightness)(void);
} lumen_led_stress_engine_t;

/* 运行压力阶段；到期（CONFIG_LUMEN_STRESS_DURATION_MIN）后返回。 */
void lumen_led_stress_run(const lumen_led_stress_engine_t *engine);
