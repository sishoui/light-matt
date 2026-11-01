# lumen

微信小程序通过 BLE 直连控制 ESP32-C3FH4 驱动的 WS2812B 灯带。

## 新会话从这里开始

**先读 [`docs/handoff.md`](docs/handoff.md)。** 它写清了当前在哪、哪些已完成、剩余工作卡在
什么上。不要凭本文件的简短描述推断进度——项目已经过了三个大版本。

**当前状态**：v3 全部 11 张实现票（GitHub #36–#45）已实现并合入
`integration/lumen-v3`，固件已编译烧录，协议层与性能项已在真机闭环。
剩 GitHub **#46（端到端真机验收）38 项**，全部需要人眼或小程序真机。

**v3 验收手册**：[`docs/acceptance-v3.md`](docs/acceptance-v3.md) —— 逐项清单 + 记录表 +
已完成项的实测数字。

## 字节契约

- **v3（当前唯一真相）**：`docs/protocol-v3.md` + 可执行副本
  `docs/protocol-testvectors-v3.json`（由 `scripts/gen-protocol-testvectors-v3.mjs` 生成）
- **v2 已作废**：`docs/protocol.md` 与 `docs/spec-v2.md` 仅保留供对照

改任何字节布局 = 契约 + 向量 + 两端实现同一个 commit。

## 测试基线（改代码后必须保持）

```bash
cmd.exe //c "firmware\\test\\run-tests.cmd"   # 10993 项断言 + 58 条 v3 向量
cd miniprogram && npx vitest run              # 553 用例
cd miniprogram && npx tsc --noEmit            # 必须干净
cd server && npm test                         # 133 用例
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
- `scripts/stress-fragment-v3.py` —— 分片重组压力测试
- `scripts/capture-serial.py` —— 抓串口日志（`--reset` 用 DTR/RTS 复位）
- `scripts/build-firmware.cmd` / `flash-firmware.cmd COM6` —— 编译与烧录

**烧录是断崖升级**：刷 v3 后设备配置回默认值，这是设计取舍，不是 bug。
