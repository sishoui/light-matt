# 进阶灯效：逐步点击视频实测（2026-11-05）

- **时间**：2026-11-05
- **设备**：`Lumen-5662` @ `CC:8D:A2:C2:56:62`，固件 v4.0，8 条带 × 30 颗
- **产物**：[`advanced-video-2026-11-05/index.html`](./advanced-video-2026-11-05/index.html)（34 段视频，双击即播）
- **方法**：真机页面处理器 → `ble-gateway.py` → PC 蓝牙 → 真实灯带；相机 1280×720 @ 10fps 全程录制
- **结论**：**15 项读回与预期一致，1 项与预期不符，17 项「只点击」时设备无写入**

---

## 1. 为什么每个步骤录两段

这个版本里，进阶档**只有「循环三档」点下去会立刻写设备**。其余改动
（选灯效 / 划分区 / 调参数 / 改时长）只写进手机本地草稿：

```ts
// strip.ts  commitPanel() → applyStepZones() → setDraft()
// 注释仍写着「写设备只走应用并播放」，但那个按钮已经不存在了：
// strip.wxml 里 grep 不到任何 bindtap="onApplyAndPlay"（#96 去掉的）
```

所以每步录两段：

| 段 | 含义 |
|---|---|
| **① 只点击** | 用户今天在 App 里点完真实看到的画面 |
| **② 点击后应用** | 调用页面自己的 `applyAdvanced()`，验证编排本身对不对 |

唯一的例外是循环三档：它 `onLoopTap` 里就 `void this.applyAdvanced()`，所以只有 ① 段。

## 2. 逐步骤结果

| # | 操作 | ① 只点击 | ② 应用后读回 |
|---|---|---|---|
| 01 | 点「进阶」 | 无写入 | — |
| 02 | 加步骤 | 无写入 | — |
| 03 | 划分区 0-29 → 确定 | 无写入 | 分区 1 · 常亮 ✅ |
| 04 | 选中分区 | 无写入 | — |
| 05 | 呼吸 | 无写入 | 0x01 ✅ |
| 06 | 彩虹 | 无写入 | 0x02 ✅ |
| 07 | 流星 | 无写入 | 0x03 ✅ |
| 08 | 爆闪 | 无写入 | 0x04 ✅ |
| 09 | 心跳 | 无写入 | 0x05 ✅ |
| 10 | **随机闪烁** | 无写入 | **0x00 常亮 ❌** |
| 11 | 常亮 | 无写入 | 0x00 ✅ |
| 12 | 亮度 → 40 | 无写入 | level=40 ✅ |
| 13 | 色相 → 210° | 无写入 | 209.9° ✅ |
| 14 | 特效层选流星 | 无写入 | layer1=0x03 ✅ |
| 15 | 混合改「相加」 | 无写入 | blend=0x02 ✅ |
| 16 | 循环「不循环」 | flags 0x02 ✅ | — |
| 17 | 循环「全部循环」 | flags 0x02→0x03 ✅ | — |
| 18 | 循环「最后一步循环」 | flags 0x03→0x07 ✅ | — |
| 19 | 时长 → 1.5s | 无写入 | 读取受限（见 §4） |
| 20 | 空 | 无写入 | 0x06 ✅ |

## 3. 发现的缺陷：`panelLayer()` 缺 `flicker` 分支

**现象**：点「随机闪烁」，下发后设备读回 `type=0x00`（常亮），不是 `0x07`。

`miniprogram/utils/control/effect-panel.ts` 的 `panelLayer()` 是 `switch (type)`，
分支只有 `breathing / rainbow / comet / strobe / heartbeat / off` + `default`，
**没有 `case "flicker"`**，于是落到 `default`（静态层）。同文件里
`TYPE_VALUE.flicker = SEGMENT_TYPE.FLICKER`、`panelTypeOf()` 也认 0x07、
`SLIDER_KEYS.flicker` 定义了四个滑块 —— 只有真正生成层那一处漏了。

`defaultParams("flicker")` 同样落 `default`，周期默认 0。

**为什么单测没拦住**：`effect-panel.test.ts` 断言的是「类型清单里有 flicker」
「滑块表里有它」，没有断言 `panelLayer("flicker").type === 0x07`。
这是「测了清单、没测映射」的缺口。

**未修复**：本次只做实测与取证，没有改产品代码。

## 4. 两处不能当「通过」的地方

- **时长（19）**：协议只回剧本摘要（4 字节），**每步时长读不回来**。
  「QueryStrip 没变化」是协议限制，不是这一步没生效。视频里能看播放节奏，
  但读回值证明不了。
- **相机色域**：这台相机把高饱和色压得很扁（`docs/handoff.md` §相机硬限制 记过），
  所以面板里的「平均色相」只能作趋势参考，不能当颜色准确性的证据。

## 5. 复现

```bash
# 1. 相机（独立进程：opencv 与 bleak 不能同进程）
python .test-run-tmp/adv-video/cam_record.py .test-run-tmp/adv-video/run 1280 720 -7 1500 &

# 2. 驱动页面点击（写 marks.jsonl + results.json）
cd miniprogram
ADV_OUT="<repo>/.test-run-tmp/adv-video/run" npx vitest run --config .auto/advtest/vitest.record.config.ts

# 3. 切段 + 量测 + 生成报告
python .test-run-tmp/adv-video/build_report.py .test-run-tmp/adv-video/run
python .test-run-tmp/adv-video/make_html.py .test-run-tmp/adv-video/run report.html
```

`record.spec.ts` / `vitest.record.config.ts` 在 `miniprogram/.auto/`（**该目录被
gitignore**）。换机器 clone 下来要先从本证据目录重建，或把它们移进 `scripts/`。
