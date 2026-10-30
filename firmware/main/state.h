#pragma once

#include <stdint.h>

/*
 * 设备共享状态的 RAM 表示。本票只放默认值与钳位；
 * 完整命令 reducer（SetPower / SetBrightness / ...）留给 #8。
 */

typedef struct {
    uint8_t power;      /* 0 关 / 1 开 */
    uint8_t brightness; /* 0-255，已按 max_brightness 钳位 */
    uint8_t r;
    uint8_t g;
    uint8_t b;
    uint16_t led_count; /* 1-64 */
} lumen_state_t;

/* 协议默认值：关灯、亮度 128、暖白 255/180/120。
 * led_count 由构建期 Kconfig 传入（默认 30，与协议默认值一致）。 */
void lumen_state_defaults(lumen_state_t *state, uint16_t led_count);

uint8_t lumen_state_clamp_brightness(uint8_t value, uint8_t max_brightness);

/* 按 docs/protocol.md §7 编码 8 字节 State。
 * brightness 字段写入钳位后的生效值，max_brightness 放在最后一字节。 */
void lumen_state_to_bytes(const lumen_state_t *state, uint8_t max_brightness, uint8_t out[8]);
