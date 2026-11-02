## 要构建什么

把 2086 行的单页拆成 tabBar 三页 + 两个二级页，并把灯带（strip）提升为主界面的切换维度。
**这一票只做骨架和导航，不实现段编辑的完整 UI**（那是下一票）。

## 页面结构

```
tabBar
├── 设备 devices      —— 列表 / 扫描 / 连接 / 备注名
├── 灯光 light        —— 选中灯带：开关、亮度、段列表、每带切换
└── 剧本 scripts      —— 阶段时间轴

二级页
├── 段编辑 segment-edit   —— 从 light push，传 strip_id + seg_id
└── 设备详情 device-info  —— GPIO / 灯珠数 / 自检 / 固件版本
```

## 范围

1. **会话提到 App 级单例**：`ControlSession` 放进 `getApp().session`（或模块级单例），
   切页不断链。页面在 `onShow` 订阅状态。
2. **新增 `utils/control/device-registry.ts`**：设备列表、备注名、**启用掩码**
   （「哪些带实际接线」由 App 本地按设备存，默认全显示）。
   **注意**：WS2812B 无回读能力，设备判断不了某条带物理上是否接线，所以这个掩码只能在 App 侧。
3. **灯光页的灯带切换器**：读取 State 的 `strip_count` 与各带灯珠数，
   横向 chip 切换；每条带显示：序号、灯珠数、GPIO（来自 `QueryStripConfig`）、
   开关状态、段数、是否在跑动画。
4. **连接后重建流程**：读 State(37B) → `QueryStripConfig` → `QueryDeviceInfo` →
   按需 `QueryStrip(i)` 逐带取段。
5. **旧单页逻辑迁移**：电源/亮度/预设/色彩轮/协议日志面板搬到对应新页，
   **接线阶段允许功能暂时缺失，但不能有编译错误**。
6. 所有 `PRIMARY_STRIP_ID` 硬编码全部消除，改为从当前选中带取。

## 验收

- [ ] tabBar 三页可切换，切换后 BLE 连接不断
- [ ] 从设备页连接成功后自动跳到灯光页
- [ ] 灯光页显示全部 8 条带的真实灯珠数与 GPIO（不是复制 strip 0）
- [ ] 切到第 3 条带，段列表显示的是第 3 条的段
- [ ] 关掉「启用掩码」里的某条带，它从列表消失但设备配置不丢失
- [ ] `grep PRIMARY_STRIP_ID` 在 `pages/` 与 `utils/control/` 下无结果
- [ ] 旧功能（电源、亮度、预设、色彩轮、日志面板）在新位置可用

## 阻塞

#小程序协议层
