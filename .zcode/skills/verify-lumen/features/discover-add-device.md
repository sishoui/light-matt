# 发现与添加设备

「发现」是二级页，做两件事：**扫描**附近设备，以及把扫到的一台**添加**进来。第五轮把它
重做成清单式：搜索条 + 分组标题（「附近的设备 N 台」）+ 每行封面与信号条。**点一行不再
直接跳走，而是弹出添加表单**（名称预填 + 封面选择）。

## Sub-features

- **DISC-1 扫描** —— 一个主按钮 + 一行状态；结果清单式分组。
- **DISC-2 搜索** —— 顶部搜索条过滤已扫到的行，可清空。
- **DISC-3 添加表单** —— 点一行弹出：名称输入（预填优先级：用户备注 > 已登记 > 广播名）、
  封面选择、「添加并连接」。已添加过的设备会注明。
- **DISC-4 信号条** —— 每行四格信号条 + 信号说明。
- **DISC-5 跳转契约** —— 点行**只开表单**；连接与跳转发生在表单提交之后。

## How to get to it (user POV)

首页右上角 `+` 下拉 → 「发现设备」。（第五轮之前它在底部 tab，现在不是。）

## Driving it with miniprogram-automator

`Preconditions:` `doctor.mjs` 全绿。有演示设备时，扫描会从 mock transport 返回演示设备；
没有演示数据时扫描结果为空，这属于前置条件问题。

- **进发现页** → `mp.navigateTo("/pages/discover/discover")` → 等 ~1.5s；
  可观察结果：`route === "pages/discover/discover"`。
- **扫描出结果** → `p.onScanTap()` → 等 ~6s 让结果进来；可观察结果：
  `data.rows.length > 0`，DOM 里 `.scan-row` 数量与 `rows.length` 一致。
  **不要等 `data.scanning === false`**——扫描是持续的，它会一直保持 true（本机实测 6s
  后仍是 true，但 `rows` 已经有 4 条）。
- **点一行只开表单** → 记下当前路由 → `p.onRowTap({ currentTarget: { dataset: { deviceId } } })`
  → 可观察结果：`data.formOpen === true`，且**路由仍然是发现页**（没有跳走）。
  （本机实测：点「Lumen-9B01」后 `formOpen=true`、`formDeviceId` 是它的 MAC、
  `formName` 预填成「书桌」——即登记表里的备注名。）
- **表单名称预填** → 读 `data.formName` 与 `data.formDeviceId`；可观察结果：
  `formDeviceId` 等于点的那行，`formName` 非空（已登记设备取备注名）。
- **搜索过滤** → `p.onQueryInput({ detail: { value: "Lumen" } })`；可观察结果：
  `rows` 只剩匹配项；`p.onQueryClear()` 后恢复。
- **添加并连接** → `p.onFormSubmit()` → 可观察结果：`data.formOpen === false` 且随后
  发生连接（`session.linkState` 变为 `ready`）。注意它会真的建连接，跑完要断开复位。

## Gotchas

- **`dataset` 键是 `deviceId`**（WXML 写的是 `data-device-id`），不是 `key`。列表里
  也没有 `onRowTap` 之外的点击入口。
- **扫描依赖平台 BLE**。开发者工具里蓝牙是桩实现；有演示数据时走 mock transport 才能
  看到行。**别把「没有设备所以列表为空」当成扫描坏了**——写清前置条件。
- **提交表单会改登记表（备注名）并建立连接**，是副作用动作。验证后要么断开、要么恢复备注。
- 这台机器只有 1 台真机，多设备场景（同名两台、信号强弱并存）**没有在真机上验过**；
  断言不要建立在多真机共存上。
- 相关单测：`tests/add-device.test.ts`（搜索规则 / 预填优先级 / 已添加判定）、
  `tests/scan-filter.test.ts`。
