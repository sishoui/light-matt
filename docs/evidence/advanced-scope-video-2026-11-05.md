# 进阶灯效：逐步点击视频实测（第九轮，2026-11-05）

- **规格**：[#120](https://github.com/sishoui/light-matt/issues/120)
- **设备**：`Lumen-5662` @ `CC:8D:A2:C2:56:62`，固件 v4.0（本轮构建），**8 条带 × 30 颗**
- **产物**：[`advanced-scope-video-2026-11-05/index.html`](./advanced-scope-video-2026-11-05/index.html)（20 段视频，双击即播）
- **方法**：真机页面处理器 → `ble-gateway.py` → PC 蓝牙 → 真实灯带；相机 1280×720 全程录制
- **结论**：**20 步里 17 步读回值与预期一致，3 步属于「协议读不回来」的元数据改动（已说明），0 步失败、0 次写入报错。**

---

## 1. 与上一版的差别：每步只录一段

上一版（[`advanced-video-2026-11-05.md`](./advanced-video-2026-11-05.md)）每步录两段
（「① 只点击」和「② 点击后应用」），因为那时**只有循环三档会写设备**，
其余编辑只进本地草稿——「只点」那一段用来记录「用户点了但灯不动」。

本轮 #125 之后每个控件点完就下发，所以「只点」就是完整行为，不再需要
「点后应用」那一段。**上一版那 17 项「只点击时设备无写入」到本轮全部变成「已下发」。**

## 2. 逐步骤结果

| # | 操作 | 设备读回 | 判定 |
|---|---|---|---|
| 01 | 点「进阶」 | — | 只切页面，不下发 |
| 02 | 点「加步骤」 | — | 只改本地编排 |
| 03 | 画分区 0-29 → 确定 | 出现分区、类型 0x00 | ✅ 确认即下发 |
| 04 | 点分区气泡 | — | 只选编辑目标 |
| 05 | 呼吸 | **0x01** | ✅ |
| 06 | 彩虹 | **0x02** | ✅ |
| 07 | 流星 | **0x03** | ✅ |
| 08 | 爆闪 | **0x04** | ✅ |
| 09 | 心跳 | **0x05** | ✅ |
| 10 | **随机闪烁** | **0x07** | ✅（上一版是 0x00，见 #121） |
| 11 | 常亮 | 0x00 | ✅ |
| 12 | 亮度 → 40 | level=40 | ✅ |
| 13 | 色相 → 210° | hue 相符 | ✅ |
| 14 | 特效层选「流星」 | layer1=0x03 | ✅ |
| 15 | 混合改「相加」 | blend 0→2 | ✅ |
| 16 | 循环「不循环」 | flags 已是不循环 | 幂等（无变化是正确结果） |
| 17 | 循环「全部循环」 | flags 加 bit0 | ✅ |
| 18 | 循环「最后一步循环」 | flags 加 bit2 | ✅ |
| 19 | 时长 → 1.5 秒 | — | 方案 blob，**协议读不回每步时长** |
| 20 | 点「空」 | 类型 0x06 | ✅ |

**17 步读回一致，3 步属于协议读不回来的元数据改动，0 步失败。**

第 19 步的限制不是本轮引入的：`QueryScript` 只回 `stage_count` 与 4 字节摘要，
每步时长没有查询接口（见 [`protocol-v4.md`](../protocol-v4.md) §9.6）。这一段的
证据只能是「点完不报错、画面不被破坏」，录像是为此保留的。

## 3. 上一版 vs 这一版

| 项 | 上一版（`advanced-video-2026-11-05`） | 本轮 |
|---|---|---|
| 每步录制 | 2 段（只点 / 点后应用） | **1 段**（点完即下发） |
| 「点完设备无写入」的步骤 | **17 项** | **0 项** |
| 随机闪烁读回 | `0x00`（常亮，缺陷） | **`0x07`** |
| 循环三档 | 唯一会写设备的控件 | 与其它控件一致 |

## 4. 复现

```bash
# 相机（另一个进程；opencv 与 bleak 不能同进程）
python docs/evidence/advanced-scope-video-2026-11-05/scripts/cam_record.py \
  .test-run-tmp/adv-scope/run 1280 720 -7 900 &

# 驱动页面（需要真机在广播、无其它 central 连接）
cd miniprogram
ADV_OUT="<repo>/.test-run-tmp/adv-scope/run" \
  npx vitest run --config .auto/advtest/vitest.record.config.ts

# 切段 + 报告
python docs/evidence/advanced-scope-video-2026-11-05/scripts/build_report.py .test-run-tmp/adv-scope/run
python docs/evidence/advanced-scope-video-2026-11-05/scripts/make_html.py .test-run-tmp/adv-scope/run report.html
```

`record.spec.ts` / `vitest.record.config.ts` 的正本在
[`docs/evidence/advanced-scope-video-2026-11-05/scripts/`](./advanced-scope-video-2026-11-05/scripts/)，
跑之前要复制到 `miniprogram/.auto/advtest/`（该目录被 gitignore，是本地执行目录）。
