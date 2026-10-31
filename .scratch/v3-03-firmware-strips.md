## 要构建什么

每条灯带独立开关 + TDM 跳过，并把 v2 遗留的三处多带不一致修掉。这是"8 条灯带真正可用"的前提。

## 范围

1. **`SetStripPower 0x1B`**：`strip_id` + `on`。只改 `strip_power_mask` 对应位。
   关某带时**先推一帧全黑**再让 TDM 跳过该带（既保证熄灭，也省 RMT 时间）。
   全局 `SetPower(0)` 对所有带生效，但**不改** `strip_power_mask`。
2. **`QueryStripConfig 0x1C`**：返回 8 × `[strip_id, gpio, flags]`（24B），
   `flags.bit0 = 已分配`，未分配 `gpio = 0xFF`。引脚来自构建期 Kconfig，**只读**。
3. **`QueryDeviceInfo 0x1D`**：固件版本、6 字节 BT MAC、各项上限、caps 位。
4. **State 扩展**：`strip_power_mask`、`strip_anim_mask`、每条带的灯珠数与段数。
   `strip_anim_mask` 由渲染任务每帧维护。
5. **修 v2 的三处不一致**：
   - `lumen_led_engine_set_segment` 的再校验用 strip 0 的 `led_count` → 改 per-strip
   - `state_blob` 解码用 strip 0 的 `led_count` 校验所有带 → 改按各自带
   - `SegmentReport` 的 `seg_id` 报压缩序号 → 改报真实槽位

## 验收

- [ ] 关一条带，其余带继续按各自动画运行，被关的带全黑且不再占轮询时间
- [ ] 重新打开立刻恢复（不留残影、不需要重设段）
- [ ] 全局关灯后再开灯，各带的独立开关状态保持不变
- [ ] 8 条带各自的灯珠数不同（如 30/60/10）时，段区间按各自带上限校验
- [ ] `QueryStripConfig` 返回的 GPIO 与 Kconfig 引脚表一致
- [ ] `strip_anim_mask` 在"静态段 / 动画段 / 无段"三种情况下正确
- [ ] 关闭 4 条带后，8 带 20fps 的轮周期明显下降（记录实测数字）

## 阻塞

#固件协议层
