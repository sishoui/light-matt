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
