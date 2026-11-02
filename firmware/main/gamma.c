#include "gamma.h"

#include <math.h>

#define LUMEN_GAMMA_EXPONENT 2.2f

/*
 * 暗部线性混合系数（0 = 纯线性，1 = 纯 gamma）。
 *
 * 为什么不是纯 gamma 2.2：8bit 输出下，gamma 在暗部压缩极猛，
 * 非纯色（橙、青、紫等）的次要通道会先被量化到 0，导致**呼吸/淡入时色相丢失**。
 * 实测现象：橙色 (255,128,0) 呼吸到暗部只剩红色——因为 G=128 过 gamma 只剩 56，
 * 再乘亮度后低到 0，视觉上就是纯红。这不是包络算法的问题（Q16 增益对各通道
 * 同比缩放，比例恒定），而是 gamma 曲线 + 8bit 量化的固有损失。
 *
 * 混入 30% 线性后，次要通道可见阈值从 e≈0.131 降到 e≈0.017（实测推算），
 * 暗部色相基本保住；代价是暗部对比度略降、中段整体亮一点
 * （v=128 由 56 变为 78）。端点不变（0→0、255→255），曲线仍严格单调。
 *
 * 为什么不直接改用 sRGB 分段曲线：C3 无 FPU，本表只在初始化时用 float 建一次，
 * 运行期查表；改用分段曲线收益很小，而混合方案只多一次加法与乘法。
 */
#define LUMEN_GAMMA_LINEAR_MIX 0.30f

static uint8_t s_gamma[256];
static int s_ready;

void lumen_gamma_init(void)
{
    if (s_ready) {
        return;
    }
    for (int i = 0; i < 256; ++i) {
        float normalized = (float)i / 255.0f;
        float curved = powf(normalized, LUMEN_GAMMA_EXPONENT) * 255.0f;
        float linear = (float)i;
        float blended = (1.0f - LUMEN_GAMMA_LINEAR_MIX) * curved +
                        LUMEN_GAMMA_LINEAR_MIX * linear;
        s_gamma[i] = (uint8_t)(blended + 0.5f);
    }
    s_ready = 1;
}

uint8_t lumen_gamma_apply(uint8_t value, uint8_t brightness)
{
    if (!s_ready) {
        lumen_gamma_init();
    }
    uint32_t scaled = (uint32_t)s_gamma[value] * brightness;
    return (uint8_t)((scaled + 127u) / 255u);
}

void lumen_gamma_apply_pixel(const uint8_t in_rgb[3], uint8_t brightness, uint8_t out_rgb[3])
{
    if (in_rgb == NULL || out_rgb == NULL) {
        return;
    }
    uint8_t out[3];
    uint8_t in_nonzero = 0;
    uint8_t out_nonzero = 0;
    for (uint8_t c = 0; c < 3; ++c) {
        out[c] = lumen_gamma_apply(in_rgb[c], brightness);
        if (in_rgb[c] != 0) {
            ++in_nonzero;
        }
        if (out[c] != 0) {
            ++out_nonzero;
        }
    }
    /*
     * 多通道颜色被压成单通道 → 色相丢失。归零而不是显示假色，
     * 这样呼吸谷底是「熄灭」而不是「先闪一下纯红」。
     */
    if (in_nonzero >= 2 && out_nonzero < 2) {
        out[0] = 0;
        out[1] = 0;
        out[2] = 0;
    }
    out_rgb[0] = out[0];
    out_rgb[1] = out[1];
    out_rgb[2] = out[2];
}
