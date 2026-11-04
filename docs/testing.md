# 测试怎么跑

这份文档独立成立：只读它就能知道这五层分别验什么、改了某类代码该跑哪几层、
报告在哪、清单怎么维护。**所有测试数字的唯一来源是最近一次报告**，本文只贴指针。

```bash
node scripts/test-run.mjs          # 日常：三层无环境成本的
node scripts/test-run.mjs --list   # 看有哪几层
```

---

## 1. 五层

层是按**环境成本**划分的，不是按被测代码的目录划分。前三层不需要任何外部环境，
后两层各要一样东西：微信开发者工具、一台连着蓝牙的 ESP32。

| 层 | 跑什么 | 为什么在这一层 | 环境成本 | 默认跑 |
|---|---|---|---|---|
| `firmware` | `firmware/test/run-tests.cmd`：gcc 编译 host 测试 + v4 向量静态校验 | 协议字节布局的守门人。纯 C、无 RTOS、无硬件，编译加执行合计一两秒就能跑完上万条断言 | 需要 `gcc` 与 `node` | 是 |
| `mp` | 小程序 `vitest run` + `tsc --noEmit` | 单测与类型检查检验同一批源码，类型错了用例全绿也不能交付，所以合成一层 | 无 | 是 |
| `server` | 后端 `vitest run` + `tsc --noEmit` | 同上，只是另一个包 | 无 | 是 |
| `ui` | `scripts/verify-v5.mjs`：用 miniprogram-automator 驱动真实渲染层 | 白屏、`bindtap` 全部失效、主题 class 没挂、tabBar 没渲染、点了却不改设备状态——这些只有渲染层能发现 | 微信开发者工具 + 自动化端口 | 否 |
| `ble` | `vitest --config vitest.e2e.config.ts`：Node → `scripts/ble-gateway.py`（bleak）→ PC 蓝牙 → ESP32 | 真实 MTU 协商、真实写入与 ACK 往返、真实设备对身体长度的兜底 | 真机 + `python` + `bleak` | 否 |

### 各层的细节

**`firmware`**：`run-tests.cmd` 把 `test_skeleton.c` 与 `main/*.c` 里能脱离 ESP-IDF
编译的部分一起编译到 `%TEMP%`（不污染仓库），跑完用 `scripts/check-protocol-testvectors-v4.mjs`
把向量文件与 `docs/protocol-v4.md` 对一遍。没有 `node` 时它打印 `SKIPPED: v4 vector self-check (node not found)`
并以 0 退出——**「没跑」和「跑过了」在终端上必须长得不一样**，编排器把这行收进未验证清单。

固件侧按测试函数统计断言数：每个 `test_*()` 前后各读一次全局计数，打一行
`TESTCOUNT <函数名> <断言数>`，编排器按行首前缀解析。报告里的「按测试函数的断言数」
就是这些真实数字，不是估算。

**`mp` / `server`**：编排器直接跑仓库里的 `node_modules/vitest/vitest.mjs`，不走 `npx`
——`npx` 在依赖缺失时会下载一份临时副本并在别的目录里跑，那会给出「跑了，但跑的不是这份代码」。
vitest 用 JSON reporter 写到临时文件（stdout 留给人读），`tsc --noEmit` 的
`文件(行,列): error TSxxxx` 与断言失败共用同一种「文件:行」定位。

**`ui`**：脚本住在 `scripts/` 而不是 `miniprogram/.auto/`，因为 `.auto/` 整个在
`.gitignore` 里——换台机器 clone 下来那一层就凭空消失了。它与真机探针、串口工具同类：
都是「需要外部环境」的脚本。断言输出 `PASS 名称` / `FAIL 名称  — 差异`，缺环境时只有一行
`SKIPPED: 缺微信开发者工具自动化端口` 且退出码 0。

**`ble`**：这一层不自己连 BLE，而是包住已有的执行器
`.zcode/skills/verify-lumen-ble/scripts/drive.mjs`：先 `doctor.py` 只读体检（设备在不在、
固件是不是 v4、State 是否合法），再跑 e2e，最后核对现场。它已定义了退出码语义
（`0` 过 / `1` 断言失败 / `3` SKIP），编排器只做「读懂它」：`3` → SKIP，`1` 但用例全过也判 FAIL
（收尾出问题不能算过），其余按 JSON 里的实际收集数报。

> **这一层实际收集 16 条用例，不是 8 条。** `vitest.e2e.config.ts` 的 include 是
> `tests/e2e/**/*.test.ts`，覆盖两个文件：`real-device.test.ts` 8 条（扫描连接、State、
> 往返 ACK、段读回、非法参数、超灯珠数、每带开关、DeviceInfo）与 `complex-plan.test.ts`
> 8 条（多阶段剧本下发、摘要、推进、两种 loop、逐阶段分区数、越界拒绝、其他引脚未被写入）。
> 旧文写「8 项」是因为只数了 `real-device.test.ts` 一个文件。无设备时两条扫描用例
> 会「顺利结束」（它们不 fail，只是没扫到东西），其余全部 skip。所以判定阈值是
> 「至多 1 条通过 + 其余全跳过」→ SKIP，不能因为那一条通过就把整层染绿。

### 不属于五层的取证工具

`scripts/probe-v4.py`（协议字节往返）、`scripts/probe-v3-deep.py`（行为语义）、
`scripts/stress-fragment-v3.py`（分片压力）都需要真机，且产出的是**一次性的证据**而不是
稳定的回归断言。它们不进编排器，结果写进 `docs/evidence/`。

---

## 2. 改哪类代码 → 跑哪几层

日常按这张表，不要每次全量。

| 改了哪里 | 必须跑 | 理由 |
|---|---|---|
| `firmware/main/**` 或协议字节布局 | `firmware` + 真机探针（`probe-v4.py`） | 字节布局的契约是固件与小程序共用的，向量与两端实现必须同一个 commit |
| `docs/protocol-testvectors-v4.json` 的生成脚本 | `firmware` + `mp` | 两端都对着同一份向量跑 |
| `miniprogram/utils/ble`、`utils/protocol`、`utils/control/session` | `mp` + `ble` | 单测覆盖语义，真机才覆盖「协商出来的 MTU / 真实 ACK / 固件是否跟上」 |
| 小程序页面 / 样式 / 交互 | `mp` + `ui` | 单测进不了 `Page()` 的渲染；白屏与事件失效只有渲染层看得见 |
| `server/**` | `server` | 互不依赖 |
| `miniprogram/tests/**`、`docs/test-manifest.json` | `mp`（含清单查漏） | 新增测试文件没登记，整轮判 FAIL |
| 发版前 | `--release`（全五层） | 报告额外归档进 `docs/evidence/test-runs/` |

> 页面改动的 `ui` 层需要先打开微信开发者工具并开启自动化端口；端口不是 9501 时用
> `WS=ws://127.0.0.1:9502`。脚本会自己切浅色 / 深色并复位，可以反复跑（幂等）。

---

## 3. 编排器

`scripts/test-run.mjs`，零依赖，只认清单里声明的层名。

| 命令 | 语义 |
|---|---|
| `node scripts/test-run.mjs` | 跑清单里 `cheap: true` 的层（当前是 `firmware` / `mp` / `server`） |
| `node scripts/test-run.mjs mp` | 只跑指定层，可给多个（`mp server`） |
| `node scripts/test-run.mjs ui ble` | 只在确实要跑环境层时显式要 |
| `node scripts/test-run.mjs --release` | 五层全跑，**并且报告归档进 `docs/evidence/test-runs/`** |
| `node scripts/test-run.mjs --list` | 列层、标「便宜 / 需环境」、标「尚未接入」 |

退出码：`0` 没有 FAIL（全 SKIP 也是 0）；`1` 有 FAIL；`2` 清单读不了或层名未知。
清单查漏不一致也判 `1`。

**前置条件是主动探测的，不是跑一遍失败再猜：**

| 层 | 探测内容 |
|---|---|
| `firmware` | 非 Windows 直接记「需要 Windows + cmd.exe」；Windows 上查 `gcc` / `node` |
| `mp` / `server` | 对应目录的 `node_modules` 里有 vitest 与 typescript 的可执行文件 |
| `ui` | 跑 `verify-v5.mjs --probe`：先 3 秒 TCP 探测，再真做一次 WebSocket 握手并断开（8 秒预算）。只测 TCP 不够——窗口开着但没开自动化模式时 TCP 通、握手失败 |
| `ble` | `drive.mjs` 在不在、`miniprogram/node_modules/vitest` 在不在、`python -c "import bleak"` 是否成功 |

`ble` 刻意**不在这里扫设备**：`drive.mjs` 自己会跑 `doctor.py`，扫一次蓝牙要好几秒，
探两遍只是让每次 `--release` 多等一会儿。设备维度的判定交给它的退出码 `3`。

---

## 4. 报告

一次运行写两份到同一个运行目录：`report.md`（给人读）与 `report.json`（给机器比对）。
目录名是 ISO 时间戳变形（`2026-11-04T18-09-35-109`），同一毫秒内撞名会补 `-02` 序号
——撞名就是静默覆盖一份证据，而报告里看不出异常。

| 命令 | 报告位置 |
|---|---|
| 日常（不带参数 / 指定层） | `.reports/<RUN_ID>/`，被 `.gitignore` 忽略，不进仓库 |
| `--release` | `docs/evidence/test-runs/<RUN_ID>/`，随本次发布一起提交 |

两个池子分开的不只是目录，还有「上一次」的索敌范围：日常报告只跟日常报告比，归档只跟
归档比。混着找会让「上次」变成一台机器上的私有历史，归档里那几份反而永远没有基线。

### 六段

1. **头部**：运行时间、commit（含「工作区有未提交改动」标记）、分支、机器 / 系统 / 核数、
   触发了哪些层、结论；有层没跑时多一行「本轮未验证」，有层内步骤没跑时多一行「层内未验证」。
   发布级报告额外列「五层结果」一行。
2. **分层结果**：层 / 结果 / 用例数 / 耗时 / 说明一行一层。
3. **未验证清单**：每个 SKIP 的层与每一条层内 skip 的原因，单列成一节。**这是最重要的
   一段**——它回答「这轮漏了什么」。没有未验证项时明确写「本轮没有未验证的层」。
4. **明细**：固件按测试函数的断言数（按条数降序），然后按层列每个测试文件的
   「文件 / 覆盖 / 用例数」。用例数只有结构化输出给得出，拿不到就写 `—`，绝不回退成层总数。
5. **失败详情**：按层列；用例失败与类型错误分两栏（修法不同）。
6. **与上次运行**：见下。

发布级归档且本轮有层没跑时，标题正下方会多一段 `⚠️ 发布级证据，但本轮发布未覆盖：…`。
一份「发版测过了」的证据被误读成全绿，比没归档更糟。

### 三态

| 结果 | 含义 | 影响退出码 |
|---|---|---|
| `PASS` | 跑了，没失败 | 否 |
| `FAIL` | 跑了，有失败 | **是** |
| `SKIP` | 没跑成，且**必须带原因**（缺什么前置条件） | 否 |

除整层的 SKIP 之外还有**层内 skip**：层本身 PASS，但里面有一步没跑（固件的
`SKIPPED:` 标签、真机跑到一半设备被抢连）。它不改变层状态，但同样进「未验证清单」，
并在差异节按原因单独记「新出现的跳过」。

### 与上次运行的差异

只比**用例数**，不逐条比用例名（改名会产生整屏噪音，把「这个文件少了 12 条」淹掉）。
只比**本轮触发的层**——「这次只跑了固件」不该拿上次全量报告当基线。内容按优先级：
新出现的失败 → 新出现的跳过 → 用例数变化（上次 / 本次 / 差值）→ 新增文件 → 消失文件 →
层状态变化 → 无法比对（一边有数字一边没有，绝不把缺失当 0）。

上一次的报告读不出来（坏 JSON、schema 不兼容）只影响差异节，不影响本轮结论——
「上一份写坏了」不是这次代码有问题。

---

## 5. 测试清单

`docs/test-manifest.json` 同时承载两件事：

- `layers`：每层的中文名、`cheap`（是否进默认那一轮）、`requires`（前置条件）、
  `missingHint`、`scan`（收集通配，只支持文件名里的 `*`，不跨目录）；
- `files`：**相对仓库路径 → 所属层 / 覆盖行为的中文说明 / 可选票号**。

粒度是**测试文件**，不是 describe 块也不是票号：「文件是否存在」是可靠可判定的事实，
describe 名字与票号都会漂。说明由人维护，用例数由运行结果自动填。

`ui` 层的 `scan` 是空数组——它是一个脚本里的几十条断言，没有「测试文件」可登记；
其余四层列出的是仓库里的实际文件。

### 查漏规则

`scripts/check-test-manifest.mjs`（`--json` 出机器可读结果）对比清单与仓库，判五类问题，
**任意一类都让整轮判 FAIL**：

| 类别 | 含义 |
|---|---|
| `unregistered` | 仓库里有、清单没登记（最要紧：有人不知道自己跑了什么） |
| `missing` | 清单里有、仓库里没有（清单腐化） |
| `misplaced` | 登记了，但声明的层与实际扫描到的层不一致 |
| `unknownLayer` | 声明了一个 `layers` 里不存在的层名 |
| `emptyCovers` | 没有覆盖说明 |

退出码 `0` 通过 / `1` 有上述问题 / `2` 清单本身读不了。`test-run.mjs` 每轮都会跑它，
不一致时往报告里追加一行「清单查漏」的 FAIL 层。

### 加测试文件时

1. 文件放进清单里某层 `scan` 覆盖的位置（`miniprogram/tests/*.test.ts`、
   `server/tests/*.test.ts`、`miniprogram/tests/e2e/*.test.ts`，固件是那一个 `.c`）；
2. 在 `files` 里加一条，`covers` 用中文写清它守的是哪条**行为**（不是「测了某函数」）；
3. 跑 `node scripts/check-test-manifest.mjs` 确认没有 `unregistered` / `emptyCovers`。

### 变异测试在哪

规则本身是否真的会抓错，靠带变异测试的回归守住：

| 文件 | 守什么 |
|---|---|
| `miniprogram/tests/test-manifest.test.ts` | 清单查漏的四类问题（未登记 / 已删 / 层不一致 / 空说明），自带变异测试 |
| `miniprogram/tests/test-run.test.ts` | 编排器自身：三态语义、报告六段、退出码、固件输出与 `TESTCOUNT` 解析、逐文件用例数与 tsc 定位、发布级归档 |
| `miniprogram/tests/module-resolution.test.ts` | 禁止相对导入指向目录（否则整个小程序白屏），自带变异测试 |
| `miniprogram/tests/page-fields.test.ts` | 页面的非 `data` 字段必须在 `onLoad` 初始化，自带变异测试 |

---

## 6. 不用编排器时

编排器只是把下面这些命令包起来并记录结果。调某一层时可以直接跑：

```bash
cmd.exe //c "firmware\test\run-tests.cmd"
cd miniprogram && npx vitest run
cd miniprogram && npx tsc --noEmit
cd miniprogram && npm run test:ble
cd server && npm test
cd server && npm run typecheck
node scripts/verify-v5.mjs
node scripts/check-test-manifest.mjs
```

这些命令只把结果打到终端，不留报告、不进差异比较。要留证据就用编排器。
`verify-v5.mjs` 的退出码对编排器有意义（`0` 全过或环境缺失 / `1` 有断言失败）。

**已作废的渲染脚本**：`verify-effect-editor.mjs`（九张色块卡 → 一行式）、
`verify-redesign.mjs`（发现 tab）、`verify-deep.mjs`（设备页自定义档）、
`verify-ui-interaction.mjs`（`pages/devices`）。它们锁的是已删除的页面或已重写的控件，
不要接进任何流程；「点得动」的意图已并入 `verify-v5.mjs`。

---

## 7. 验收文档的编号与三态符号

`docs/acceptance-v3.md`、`acceptance-v4.md`、`acceptance-v5.md` 是**已发布的历史记录**，
编号与结论不重写。新写验收记录时沿用同一套，跨轮比对才有稳定 ID。

**编号（统一口径：三级）**：`§<章>.<节>.<项>`，如 `§1.2.3`。章 = 一个大验收面
（灯带 / 开关 / 两层 / 区间 / 剧本 / 设备恢复 / 稳定性 / 协议回归 / 文档），节按顺序排，
项在节内排。编号一旦发布不改；作废的项保留编号并在结论栏写「不作验收」。

> `acceptance-v3.md` 就是这个形状（55 行逐项清单）。`acceptance-v4.md` 与
> `acceptance-v5.md` 是命令级表格，只用到两级（`§1`、`§4`），**已发布，不重编号**；
> 新写的验收记录一律三级。

**三态符号**：

| 符号 | 含义 |
|---|---|
| ✅ | 已闭环，且有可复核的证据（报告 / 相机实测 / 串口日志 / 自动化截图） |
| ◐ | 部分闭环（例如设备侧已证、人眼或 UI 未验）；必须写明缺哪一半 |
| ☐ | 完全未做 |
| — | 按决定**不作验收**，不计入分母（例如只有一台设备时的多设备项） |

每份记录末尾给一张汇总表：逐章列 ✅ / ◐ / ☐ / — 的条数，并写明分母口径
（「全表 N 行，其中 §x 的 M 项不作验收 → 有效 N−M 行」）。分母必须写清，
否则「§1 的 38 个功能项全过」和「整张表 50 行全过」会被当成同一件事
——`acceptance-v3.md` 里这两个数字确实并存，靠分母那句区分。

每条结论文本要能独立成立：写清期望、实际数字、证据在哪，不要只写「通过」。

---

## 8. 文档里的测试数字

**规则：文档不写「当前基线」的具体数字，只写指针。**

- 要数字 → 看最近一次报告：日常在 `.reports/`，发布级在 `docs/evidence/test-runs/`；
- 要「这套流程本身对不对」→ 看 `mp` 层里 `test-run.test.ts` 与 `test-manifest.test.ts`；
- 已归档的**带日期的**证据（`docs/evidence/*-2026-*.md`）里的实测数字是当时的事实，
  一字不改；
- 已作废的协议文档（`docs/protocol-v3.md`、`docs/protocol.md`、`docs/spec-v2.md`）里
  的数字保留供对照。

原因很简单：手抄的数字每抄一次漂一次，而且没有任何一处能证明它是跑出来的。
