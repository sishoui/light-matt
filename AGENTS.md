# lumen

微信小程序通过 BLE 直连控制 ESP32-C3FH4 驱动的 WS2812B 灯带。

## 新会话从这里开始

**先读 [`docs/handoff.md`](docs/handoff.md)。** 它写清了当前在哪、哪些已完成、剩余工作卡在
什么上。不要凭本文件的简短描述推断进度——项目已经过了三个大版本。

**当前状态**：v3 的 11 张实现票（#36–#45）与 4 张缺口票（#47–#50）全部关闭，
合入 `integration/lumen-v3-gaps`。**设备侧验收已全部跑完**：协议层 47 项 + 行为语义
69 项（`scripts/probe-v3-deep.py`）+ 400s 压力（0 事件）均已在真机闭环。

剩 GitHub **#46**：§1.1–1.8 的 38 项里 **✅ 22 / ◐ 6 / ☐ 10**。
剩下的只有三类：**人眼看颜色**（§1.3 的 4 项观感）、**手机上看提示文案**
（6 项，设备侧已证）、**凑齐 3 台设备**（§1.7 的 5 项）。

**v3 验收手册**：[`docs/acceptance-v3.md`](docs/acceptance-v3.md) —— 逐项清单 + 记录表 +
已完成项的实测数字。

**未完成任务清单**：[`docs/pending-tasks.md`](docs/pending-tasks.md) —— 剩余项按
「人眼 / 手机 / 更多硬件」分类，含相机色域压缩这个最大阻塞。

**证据归档**：[`docs/evidence/`](docs/evidence/) —— 行为探针报告、400s 稳定性数据、
SHA-256 索引、配置丢失记录。

## 字节契约

- **v3（当前唯一真相）**：`docs/protocol-v3.md` + 可执行副本
  `docs/protocol-testvectors-v3.json`（由 `scripts/gen-protocol-testvectors-v3.mjs` 生成）
- **v2 已作废**：`docs/protocol.md` 与 `docs/spec-v2.md` 仅保留供对照

改任何字节布局 = 契约 + 向量 + 两端实现同一个 commit。

## 测试基线（改代码后必须保持）

```bash
cmd.exe //c "firmware\\test\\run-tests.cmd"   # 11053 项断言 + 58 条 v3 向量
cd miniprogram && npx vitest run              # 604 用例
cd miniprogram && npx tsc --noEmit            # 必须干净
cd server && npm test                         # 140 用例
cd server && npm run typecheck                # 必须干净
```

## Agent skills

### Issue tracker

GitHub Issues（`sishoui/light-matt`）。**当前 effort 的规格父票是 `#35`**（v3），
11 张实现票 `#36`–`#45` 已关闭，#46 验收票 open。v1 的父票 `#1` 与 v2 的 `#27` 是历史。
详见 `docs/agents/issue-tracker.md`。

### Domain docs

单上下文布局（`GLOSSARY.md` + `docs/adr/`）。见 `docs/agents/domain.md`。

## 真机工具

- `scripts/probe-v3.py` —— 协议层 47 项真机验证（PC 当 central，需 bleak）
- `scripts/probe-v3-deep.py` —— 行为语义 69 项（段回滚 / 逐带独立 / 剧本推进 /
  断连续播 / 过大回滚），`--skip-heavy` 跳过 ~900 帧大剧本下发
- `scripts/stress-fragment-v3.py` —— 分片重组压力测试
- `scripts/capture-serial.py` —— 抓串口日志（`--reset` 用 DTR/RTS 复位）
- `scripts/build-firmware.cmd` / `flash-firmware.cmd COM6` —— 编译与烧录

**烧录是断崖升级**：刷 v3 后设备配置回默认值，这是设计取舍，不是 bug。
