# 小程序 UI 验收（2026-11-02，微信开发者工具自动化）

**手段**：微信开发者工具 2.02.2608080 + 基础库 3.17.6 + `miniprogram-automator`
（`cli agent start --auto-port 9500` 建立自动化会话）
**结果**：**19/19 断言通过**
**原始数据**：`miniprogram/.auto/evidence/results.json`（本地产物，不入库）

---

## 0. 这轮最重要的发现：项目在开发者工具里本来是白屏的

验收过程中发现**整个小程序打不开** —— 模拟器只有导航栏和 tabBar，内容区全黑，
控制台反复报：

```
Page "pages/devices/devices" has not been registered yet.
```

这不是工具链问题，也不是环境问题，而是**仓库里真实存在的缺陷**，三端测试全绿
也没有暴露它。

### 根因

`miniprogram/utils/control/session-singleton.ts` 第 20 行：

```diff
- import { createDefaultUsageLogger } from "../usage";        // ← 目录导入
+ import { createDefaultUsageLogger } from "../usage/index";  // ← 必须写全
```

`utils/usage/` 是一个**目录**（内含 `index.ts`）。TypeScript 能解析目录默认到
`index.ts`，`tsc --noEmit` 干净、vitest 604 用例全过、`cli preview` 也能成功
生成二维码 —— 但**微信小程序的运行时模块解析器不认目录 index**，直接抛：

```
module 'utils/usage.js' is not defined, require args is '../usage'
```

后果是灾难性的：`session-singleton` 是 App 启动链的必经节点（`app.ts` 的
`onLaunch` 调 `getSession()`），它一崩，**所有页面的 `Page()` 都不执行**，
整棵页面树全白。

### 定位过程（对照实验）

| 步骤 | 结果 |
|---|---|
| 写一个最小 TS 项目（app.ts + 一个 Page）跑自动化 | **完全正常**：`hasApp=true`、`data` 可读、DOM 文本可取 → 排除 IDE / TS 插件 |
| 把 lumen 的 `app.ts` onLaunch 清空 | `hasApp` 变成 **true** → 问题在 App 启动链 |
| 加一个诊断页，逐个 import 业务模块并 try/catch | 控制台打出 `module 'utils/usage.js' is not defined` |
| 全项目扫描「相对导入指向目录」 | **只有这一处** |

### 修复与防回归

1. 改成 `../usage/index`。
2. 新增 `miniprogram/tests/module-resolution.test.ts`：扫描全项目所有相对
   import，断言它们都指向**具体文件**而不是目录。
3. **变异测试验证**：把修复改回 `../usage`，测试准确红出
   `utils\control\session-singleton.ts → "../usage"`；还原后变绿。

> 这个缺陷值得单独立项复盘的教训：**`tsc` 干净 + 单测全绿 + 构建成功，
> 都不足以证明小程序能跑。** 只有真机或模拟器能发现模块解析层的问题。

---

## 1. 修复后的 UI 验收结果（19/19）

自动化会话直接驱动真实页面：`switchTab` / `navigateTo` 导航、真实 tap 事件、
真实 `setData` 与页面方法调用，读的是渲染层真正拿到的 `data`。

### §1.3.5 没有第三层入口

| 断言 | 实测 |
|---|---|
| `layerViews` 恰好 2 项 | 2 项 |
| 两层层标签可区分 | `["第 1 层（必填）", "第 2 层（可选）"]` |
| DOM 中带 `data-layer` 的卡片恰好 2 个 | 2 个 |

> 配合代码侧：`layerIndexOf` 返回类型是 `0 | 1 | null`，第三层在类型系统层面
> 就不存在。

### §1.5.6 剧本页没有 fade 入口

| 断言 | 实测 |
|---|---|
| `data` 里无 fade 字段 | `[]` |
| 页面可见文本不含「过渡/渐变」 | 501 字内无命中 |

### §1.6.1 剧本过大的提示

| 断言 | 实测 |
|---|---|
| 有 `scriptOverCapacity` 状态位 | `estimated=31` 字节时可用 |
| 超容量时渲染 `.capacity-warn` | 文案：**「剧本过大，请减少阶段数/段数/灯带数」** |

### §1.4.1–1.4.3 提交前拦截与提示文案

三条都验证了「**`canApply=false` + 具体文案**」两件事：

| 项 | 触发 | 实测提示 |
|---|---|---|
| 1.4.1 重叠 | 已有 0-15，划 10-20 | **「与段 0（0-15）重叠，同一灯带的段不能重叠」** |
| 1.4.2 越界 | 30 灯的带划 0-40 | **「终点 40 超出灯珠范围（0-29）」** |
| 1.4.3 周期下限 | 呼吸层填 300ms | **「层 1的周期不能短于 334ms（当前 300ms）」** |

三条 `canApply` 均为 `false` —— 按钮被禁用，**不会发请求**。

### §3.6 协议日志面板

| 断言 | 实测 |
|---|---|
| 有 `logVisible` 状态且默认隐藏 | `false` |
| 版本号元素存在（连点入口） | `v0.3.0` |
| 连点 5 次后面板打开 | `logVisible=true` |
| 面板 DOM 出现 | found |
| 行结构可用 | 0 行（未连设备，符合预期） |

---

## 2. 这轮**没有**证明什么

1. **面板行内容没验** —— 未连接设备，`logRows` 为空。要看 cmd/seq/len/result
   四要素的实际渲染，需要连着真机复跑一次。
2. **截图没保存** —— 这个 SDK 版本的 `page.screenshot` 不可用（返回 undefined
   或抛错）。证据是读取的 `data` 与 DOM 元素，不是图片。
3. **样式层没验** —— 提示文字会不会被 CSS 遮挡、按钮禁用态是否可见，需要人眼。

---

## 3. 复现

```bash
# 1) 开启服务端口后，用 agent 模式启动（关键是给 --auto-port）
"C:/Program Files (x86)/Tencent/微信web开发者工具/cli.bat" agent start \
  --project "<仓库>/miniprogram" --port 9420 --auto-port 9500

# 2) 跑验收（脚本在本地产物目录，不入库）
cd miniprogram && node .auto/verify-ui.mjs
```

**两个踩过的坑**（都写进脚本注释了）：

- **必须传 `--auto-port`**。不带这个参数时，`agent start` 返回成功但 9420
  只是 HTTP 服务，automator 连不上。
- **`page.data()` 在这个 SDK 版本不可用**（报 `page node not found`）。要读页面
  数据必须走 `mp.evaluate(() => getCurrentPages().pop().data)`。
