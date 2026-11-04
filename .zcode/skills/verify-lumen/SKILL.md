---
name: verify-lumen
description: 驱动 lumen 微信小程序的真实渲染层，证明一次改动在模拟器里真的生效。用于改完 miniprogram 的页面 / 交互 / 主题后需要「点得动、状态真的变了」的证据时；覆盖首页、设备页、灯组页（简单 / 进阶）、发现页、我的页。不覆盖真机 BLE、固件与后端。
---

# 验证 lumen 小程序

lumen 是**微信小程序 + BLE 直连 ESP32** 的项目。它的验证有三层，只有第一层能被
脚本证明，另外两层必须有硬件：

| 层 | 手段 | 能证明什么 | 本技能是否覆盖 |
|---|---|---|---|
| 单元 / 类型 | `vitest` + `tsc` | 纯逻辑、编解码、模型 | 是（先跑，见 §1） |
| **渲染层** | 微信开发者工具 + `miniprogram-automator` | 页面真的渲染、`bindtap` 真的有方法、点了之后**设备状态真的变了** | **是（本技能主体）** |
| 真机 / 固件 | `probe-v4.py`、`npm run test:ble` | 真实 MTU / 分片 / CRC / ACK、实际观感 | 否，见 §5 |

**这一层的独有价值**（仓库踩过两次，都写进了 `AGENTS.md`）：`tsc` 干净 + 单测全绿 +
构建成功，**都不能证明小程序能跑**。相对导入指向目录会让整个小程序白屏；
`Page({...})` 的私有字段没在 `onLoad` 初始化会让整页事件绑定中断——点扫描 / 连接 /
取消全都没反应。这两种缺陷单测和类型检查都发现不了。

## 0. 先搞清楚要证的是哪一边

用户可见的界面在 `miniprogram/pages/`（6 个页面，全部 `navigationStyle: custom`）。
控制链路的真相在 `docs/protocol-v4.md`，**不在**本技能范围。要证明字节契约请用
`scripts/probe-v4.py`。要证明某个页面「点得动」，用本技能。

## 1. 前置：先让静态检查变绿

渲染层验证**不替代**下面这些，它只补它们看不到的部分。改动后先跑：

```bash
cd miniprogram && npx tsc --noEmit          # 必须干净
cd miniprogram && npx vitest run            # 单测（基线 1708 用例 / 68 文件）
cd miniprogram && node .auto/check-bindings.mjs   # WXML binding 有对应 TS 方法
```

`check-bindings.mjs` 是渲染层的廉价前置：它静态抓 `.wxml` 里的 `bindtap` / `catchtap`
名字，断言 `.ts` 里有同名方法。它查不出「方法存在但抛错」，那要靠下面的真实驱动。

## 2. 启动自动化会话

微信开发者工具必须**开着自动化端口**，且窗口里打开的**就是这个项目**。

```bash
"C:/Program Files (x86)/Tencent/微信web开发者工具/cli.bat" agent start \
  --project "<仓库>/miniprogram" --port 9420 --auto-port 9502
```

**已知的两个坑**（都来自 `docs/evidence/ui-acceptance-2026-11-02.md`）：

- **必须传 `--auto-port`。** 不带它时 `agent start` 返回成功，但 9420 只是 HTTP 服务，
  automator 连不上。
- **端口要和窗口对上。** automator 连的是 `--auto-port` 给的那个 ws 端口。本机常见的
  两个：`9501`（`cli agent start` 的默认习惯）和 `9502`（`cli auto` / 某些会话）。
  **连错了会报 `Failed connecting to ws://...`，而进程仍然活着**——不要因此以为服务没起。

`--port` 已有一个 IDE 在用时，必须先 `cli quit` 再重起，否则会报「must quit IDE
before re-run the command」。

**端口选择**（本技能的脚本默认 `WS=ws://127.0.0.1:9502`；不同机器上先探一下）：

```bash
cd miniprogram
node -e "const a=require('miniprogram-automator');(async()=>{for(const ep of ['ws://127.0.0.1:9501','ws://127.0.0.1:9502']){try{const m=await a.connect({wsEndpoint:ep});console.log('OK',ep);await m.disconnect()}catch(e){console.log('NO',ep)}}process.exit(0)})()"
```

## 3. 医生：这个实例值不值得驱动？

**任何一次驱动之前先跑它。** 它只读：不连设备、不写存储、不切主题。

```bash
node .zcode/skills/verify-lumen/scripts/doctor.mjs
WS=ws://127.0.0.1:9501 node .zcode/skills/verify-lumen/scripts/doctor.mjs
```

六项检查：端口可连 → 页面栈非空 → 当前页是已知路由 → 页面上挂到了 `session`
（启动链没崩）→ 有设备可用（演示或真机）→ 主题存储取值合法。任何一项 `NO`，
后续断言都不可信，先修环境。

## 4. 驱动一个用户路径

本技能带一个执行器，把「用户动作 → 可观察结果」写成断言，并把证据落到
`miniprogram/.auto/evidence/<RUN_ID>/`（该目录已在 `.gitignore`，是**本地产物**）。

```bash
node .zcode/skills/verify-lumen/scripts/drive.mjs --list
node .zcode/skills/verify-lumen/scripts/drive.mjs --scenario home-power        --label "首页电源键"
node .zcode/skills/verify-lumen/scripts/drive.mjs --scenario home-search       --label "首页搜索"
node .zcode/skills/verify-lumen/scripts/drive.mjs --scenario strip-advanced    --label "进阶档两层"
node .zcode/skills/verify-lumen/scripts/drive.mjs --scenario delete-device     --label "删除设备"
WS=ws://127.0.0.1:9501 node .zcode/skills/verify-lumen/scripts/drive.mjs --scenario doctor
node .zcode/skills/verify-lumen/scripts/drive.mjs --scenario home-power --screenshot   # 附带截图
```

退出码 `0` = 全过，`1` = 有断言失败，`2` = 场景名不存在。每个场景自己负责**复位**
（把电源点回去、把模式切回简单档、把删掉的设备还原），所以可以反复跑。

**写新场景时照这个形状加**：在 `scripts/drive.mjs` 的 `scenarios` 对象里加一个 async
函数，接收 `(mp, rec)`，用 `rec(断言名, 布尔, 细节)` 记录。三条硬规矩：

1. **走真实入口。** 导航用 `mp.navigateTo` / `mp.switchTab`，交互调用页面**自己的**
   事件处理器（`p.onPowerTap({currentTarget:{dataset:{...}}})`），不要直接 `setData`
   伪造中间态——那只证明你会改数据。**也不要用 `session.connect` / `session.switchTo`
   代替界面动作**：首页的 `busy` 只由 `onPowerTap` 的 `finally` 清除，绕过它会让电源键
   永久静默（实测，见 `features/home-page.md`）。
2. **读渲染层真正拿到的 `data`。** `page.data()` 在这个 SDK 版本不可用（报
   `page node not found`），必须 `mp.evaluate(() => getCurrentPages().pop().data)`。
3. **证副作用，不只证屏幕。** 「电源键点了」要断言设备 State 的 `power` 真的翻转；
   「删除了设备」要断言存储里也少了。必要时用 `p.session` 读回真实状态。

**先清场再驱动。** `settle()` 会停掉正在进行的扫描再 `reLaunch` 回首页。发现页的扫描
由会话持有，页面卸载不会停；不停掉就 `reLaunch`，automator 会卡住直到超时
（本机实测）。新场景的第一句应当 `await settle(mp)`。

**`wx.showModal` 这类系统弹窗**会自动悬停。场景里临时替换 `wx.showModal` 让它立刻
回调，并在 `finally` 里还原——不改产品代码，也不留副作用（`delete-device` 就是这么做的）。

## 5. 证据与什么算证明

证据落在 `miniprogram/.auto/evidence/<RUN_ID>/<scenario>.json`，结构：

```json
{
  "scenario": "home-power", "label": "...", "runId": "...", "ws": "...", "at": "...",
  "records": [{ "assertion": "电源键执行后 State.power 翻转", "ok": true, "detail": "1 → 0" }],
  "data": { "beforePower": 1, "afterPower": 0 }
}
```

**截图的实际情况**：`mp.screenshot()` 单拍能用（实测 97KB–130KB base64），但**在一次连续
驱动的尾部经常超时**（`timeout waiting for automator response`），而且这个挂起会污染同一个
websocket，让下一条命令也跟着超时。所以**截图默认关闭**，要图时加 `--screenshot` 并接受
它可能失败。证据的标准是 `records` + `data`：断言原文、布尔结果、以及证明它变了的原始数字。
要单独出图用 `miniprogram/.auto/shot-card.mjs` 那种一次性脚本。

**瞬态超时不等于失败。** 这套开发者工具在连续驱动时会偶发同样的超时（IDE 侧没回，
不是断言错了）。`drive.mjs` 把每个 automator 调用都包了一层重试，只重试
`timeout waiting for automator response` 与 `Connection closed` 两类瞬态错误，其他错误
照常抛出。**本机实测连续三轮 66/66 全过**（doctor 4 + home-search 3 + home-power 3 +
strip-advanced 6 + delete-device 6，每轮 22 项）。你在自己的环境发现重试也救不回来时，
先 `cli quit` 再重新 `agent start`——IDE 侧状态坏了，不是代码问题。

**什么不算证明**：

- 「构建过了 / tsc 干净」——它们对渲染层零覆盖（§0 的两个白屏缺陷就是全绿时埋的）。
- 「我调了 `setData`，`data` 变了」——那只证明赋值成功。要断言经过处理器后
  `p.session` 读回的设备状态或存储键真的变了。
- 只驱动一个方便的入口就说整页没问题——界面有多个入口时，分别驱动。

## 6. 清理

- 场景自己复位状态；跑完再跑一次 `doctor.mjs` 确认设备数、主题回到原样。
- **证据不要删**——它是这次运行的产物，留在 `.auto/evidence/<RUN_ID>/`。
- **不要按进程名杀微信开发者工具**。它可能开着用户自己的窗口。只在**本技能启动的
  那个会话**确实需要停时才 `cli quit --project "<仓库>/miniprogram"`，并且确认
  端口是它占的。
- 临时脚本放 `miniprogram/.auto/` 下（已 gitignore），跑完删掉；不要留在仓库根。

## 7. 不覆盖的部分

- **真机 BLE**：`cd miniprogram && npm run test:ble`（8 项，无设备自动 skip；
  链路是 Node → `scripts/ble-gateway.py` → PC 蓝牙 → ESP32）。
- **协议契约**：`python scripts/probe-v4.py [--address MAC]`（真机 22 项往返）。
- **固件 host 测试**：`cmd.exe //c "firmware\test\run-tests.cmd"`。
- **后端**：`cd server && npm test`。
- **实际观感**（颜色、亮度、闪烁）：只能人眼 / 相机，`docs/pending-tasks.md` 有记录。

## 8. 特性地图

`features/` 下每个文件是**一个用户可见特性的驱动配方**：怎么到达、怎么驱动、什么样的
终态证明它有效。读 `features/README.md` 的索引再挑文件。

Mapped features: 首页设备卡 / 发现与添加设备 / 设备页 / 灯组简单档 / 灯组进阶档 /
我的与主题。加新特性就加一个文件并在 README 索引登记。
