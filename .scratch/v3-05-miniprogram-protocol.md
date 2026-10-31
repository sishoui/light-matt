## 要构建什么

小程序的协议层从 v2 升级到 v3：新信封、CRC16、分片、两层段、新命令、37 字节 State。
这一票**只动 `utils/protocol/` 与 `utils/ble/`**，不碰页面，保证可单测、可独立验证。

## 范围

1. **`frame.ts`**：新信封 `magic 0xA6 / ver 0x03 / len(2 LE) / crc16(2 LE)`；
   `crc16()` 用 CCITT-FALSE；`FrameTooLongError` 阈值改为载荷 232 / 整帧 240。
2. **分片**：新增 `chunk.ts`——`chunkFrame(frame, capacity)` 与 `ChunkAssembler`。
   ctrl 头 bit7 FIRST / bit6 LAST / bit5-0 序号；重组超时 1000ms；FIRST 重入丢弃旧缓冲。
3. **`commands.ts`**：段载荷改 21 字节两层；新增 `cmdSetStripPower`、`cmdQueryStripConfig`、
   `cmdQueryDeviceInfo`；`ScriptSegment` 改 23 字节、`ScriptStage` 加 `fade`。
4. **`types.ts` / `constants.ts`**：`DeviceState` 扩到 37 字节；
   新增 `EffectLayer`、`BlendMode`、`StripConfig`、`DeviceInfo`、`StripPowerMask`。
5. **`transport.ts`**：写路径改为「分片 → 串行写」；收路径改为「分片重组 → 解帧」；
   连接后按 MTU 设定 capacity（未知按 20）。
6. **向量测试**：直接加载 `docs/protocol-testvectors-v3.json` 跑全部用例。

## 验收

- [ ] v3 向量全通过（编码与解码两个方向）
- [ ] 分片边界：正好 179 字节、180 字节、跨 2 片、跨 3 片、FIRST 重入、超时
- [ ] MTU 未知时按 20 字节工作，功能不降级（只是分片更多）
- [ ] 两层段的编解码往返幂等；非法 blend / 空 layer0 在客户端就能拦下
- [ ] State 解析对 37 以外的长度明确报错，不静默截断
- [ ] `crc16` 与标准校验值一致（`"123456789"` → `0x29B1`）
- [ ] 现有 288 个单测里与新协议无关的部分保持通过

## 阻塞

无（契约已完成，与固件票并行）
