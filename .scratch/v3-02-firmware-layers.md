## 要构建什么

把段的单层模型改成两层 + blend，并完成渲染链路的合成。这是"多灯效"需求的实体。

## 范围

1. **数据结构**：`main/effects.[ch]` 新增 `lumen_effect_layer_t`（`type` + 7 字节 `param`），
   `lumen_segment_t` 改为持有 `layer[2]` + `blend`。删除原来平铺的 `hue/sat/period_ms/p5/flags`。
2. **像素求值**：`lumen_effect_pixel` 改为按层求值；新增 `lumen_layer_pixel(layer, idx, now, out)`。
3. **合成**：`main/led_render.c` 在**用户空间**做 blend，之后统一过 gamma + 全局亮度：
   - 覆盖 `out = L1`
   - 相乘 `out = (L0 * L1 + 127) / 255`
   - 相加 `out = min(255, L0 + L1)`
   **两层都不得自行做 gamma 或亮度。**
4. **校验**：`main/segment_store.[ch]` 按 `protocol-v3.md` §7.1 的 7 步顺序校验，
   静态层保留位 `param[3..6]` 必须为 0，空 layer0 判非法，单层时 blend 必须为 0。
5. **相位**：`t0_ms` 留在段上（两层共享），语义不变。

## 验收

- [ ] 单层段行为与 v2 完全一致（回归：现有 4 种灯效的像素输出逐字节相同）
- [ ] 三种 blend 的输出值有单测覆盖，含饱和钳位边界（255+255、0×255、127 舍入）
- [ ] 空 layer0 → `InvalidParam`；单层带非零 blend → `InvalidParam`；未知 type → `InvalidParam`
- [ ] 静态层 `param[3..6]` 非 0 → `InvalidParam`
- [ ] "彩虹 + 呼吸相乘"合成后暗部不塌陷（gamma 只过一次）
- [ ] 段表内存增量记录在案（两层后 `lumen_segment_t` 体积）

## 阻塞

#固件协议层（需要 v3 的段载荷布局与 blob 格式）
