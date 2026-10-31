#pragma once

#include <stdint.h>

/*
 * gamma 校正 + 亮度乘算。纯函数，host 可测。
 * 小程序下发的是用户空间 RGB；gamma 只存在于固件。
 */

/* 建 gamma 表。幂等；必须在渲染任务启动前调用一次。 */
void lumen_gamma_init(void);

/* 先查 gamma 表，再乘亮度（0-255），四舍五入。 */
uint8_t lumen_gamma_apply(uint8_t value, uint8_t brightness);

/*
 * 单颗灯的输出：gamma + 亮度，并截掉「色相已丢失」的那一档。
 *
 * 为什么需要它：8bit 输出在极暗处装不下色相。橙色 (255,128,0) 呼吸到
 * e∈[0.008,0.02] 时 R 剩 1~2 而 G 已归零——屏幕上是**纯红**，再暗一档
 * 反而全黑。真机实测能看出「呼吸到底时闪一下红」。
 *
 * 判定：输入有 ≥2 个通道非零、输出只剩 <2 个非零 → 色相丢失，整颗归零。
 * 纯色（本来就单通道）与全黑不受影响，所以静态红/绿/蓝不会被打断。
 *
 * out_rgb 可与 in_rgb 指向同一块内存。
 */
void lumen_gamma_apply_pixel(const uint8_t in_rgb[3], uint8_t brightness, uint8_t out_rgb[3]);
