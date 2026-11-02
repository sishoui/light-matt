# lumen

微信小程序通过 BLE 直连控制 ESP32-C3FH4 驱动的 WS2812B 灯带。

## 新会话从这里开始

**先读 [`docs/handoff.md`](docs/handoff.md)。** 它写清了当前在哪、哪些已完成、剩余工作卡在
什么上。不要凭本文件的简短描述推断进度——项目已经过了三个大版本。

**当前状态**：v3 的 11 张实现票（#36–#45）与 4 张缺口票（#47–#50）全部关闭，
**已合入 `master`**（PR #51，merge commit `f9f2fe3`）。**设备侧验收已全部跑完**：协议层 47 项 + 行为语义
69 项（`scripts/probe-v3-deep.py`）+ 400s 压力（0 事件）均已在真机闭环。

GitHub **#46** 已关闭且**验收项全部闭环**：§1.1–1.8 的 38 项里 §1.7 多设备的
5 项决定不作验收（只有 1 台设备），有效 32 项 **✅ 32 / ◐ 0 / ☐ 0**。
观感项用相机实测替代人眼，UI 提示文案用**微信开发者工具自动化**实测。

> **写小程序代码时注意**：相对 import 不能指向目录（`from "../usage"`）。
> 小程序的模块解析器不认目录 `index`，会抛 `module 'xxx.js' is not defined`，
> 且在 App 启动链上会导致**整个小程序白屏**——`tsc` 与单测都发现不了。
> 回归测试：`miniprogram/tests/module-resolution.test.ts`。

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
cd miniprogram && npx vitest run              # 607 用例（不含 e2e）
cd miniprogram && npm run test:ble            # 8 项真机 e2e（无设备自动 skip）
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
- `scripts/ble-gateway.py` —— BLE 网关（bleak → JSON over stdio），**由 e2e 自动拉起**。
  让 Node 侧的小程序代码直连 PC 真实蓝牙，无需手机
- `scripts/stress-fragment-v3.py` —— 分片重组压力测试
- `scripts/capture-serial.py` —— 抓串口日志（`--reset` 用 DTR/RTS 复位）
- `scripts/build-firmware.cmd` / `flash-firmware.cmd COM6` —— 编译与烧录

**烧录是断崖升级**：刷 v3 后设备配置回默认值，这是设计取舍，不是 bug。
