## 要构建什么

把固件协议层从 v2 升级到 v3 信封，并完成持久化 blob 的版本升级。这是固件侧所有后续工作的地基。

契约见 `docs/protocol-v3.md`，向量见 `docs/protocol-testvectors-v3.json`。

## 范围

1. **信封**：`main/protocol.[ch]` 换成 `magic 0xA6 | version 0x03 | cmd | seq | len(2 LE) | payload | crc16(2 LE)`，
   CRC16 用 CCITT-FALSE（poly 0x1021, init 0xFFFF），逻辑帧上限 240B / 载荷 232B。
2. **分片重组**：`main/ble_link.c` 增加 1 字节分片头（bit7 FIRST / bit6 LAST / bit5-0 序号），
   240 字节静态重组缓冲，latest-wins，**1000ms 超时丢弃**（超时不回 ACK）。
3. **MTU 协商**：初始化调用 `ble_att_set_preferred_mtu(247)`，按实际协商值决定单次写容量。
   未知时按 23（即 20 字节）兜底。
4. **State 37 字节** + 两条新报告：`StripConfigReport 0x87`（24B）、`DeviceInfoReport 0x88`（15B）。
5. **State blob v4**（1312B，段记录 20B 两层）与 **Script blob v2**（magic `LMS3`）。
6. **分区表**：新增 `partitions.csv`（NVS 64KB / app 0x3E0000），
   `sdkconfig.defaults` 改 `CONFIG_PARTITION_TABLE_CUSTOM`。

## 验收

- [ ] `docs/protocol-testvectors-v3.json` 全部用例在 host 测试里通过（含 CRC、非法帧、分片重组）
- [ ] 分片重组覆盖：单分片、2 分片、3 分片、FIRST 重入丢弃旧缓冲、超 240B 溢出、1000ms 超时
- [ ] CRC16 实现与标准校验值一致（`"123456789"` → `0x29B1`）
- [ ] state blob v4 / script blob v2 的 encode→decode 幂等，损坏 blob 整份拒绝
- [ ] v2 的 blob 被识别为版本不匹配并回落到默认值（不崩溃、不半套）
- [ ] 新分区表可编译烧录，NVS 实际可用容量 ≥ 64KB
- [ ] `lumen_protocol_encode` 对超长载荷返回 0，不越界写

## 阻塞

无（契约已完成）。
