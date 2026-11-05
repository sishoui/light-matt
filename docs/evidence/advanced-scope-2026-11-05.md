# 进阶灯效：方案作用域与自动下发 · 真机证据（2026-11-05）

- **规格**：[#120](https://github.com/sishoui/light-matt/issues/120)
- **实现票**：#121–#125
- **设备**：`Lumen-5662` @ `CC:8D:A2:C2:56:62`，固件 v4.0，**8 条带 × 30 颗**
- **固件**：本轮构建（`scripts\build-firmware.cmd` → `flash-firmware.cmd COM6`，哈希校验通过）
- **相机**：1280×720 / 1920×1080 @ 1.3fps，曝光 -7、增益 0（1080p 才分得开八条带）

---

## 1. #122 判据一：`strip_anim_mask` 只报方案真正驱动的带

**做法**：构造只含 strip0 的两步方案（第 0 步呼吸、第 1 步空），激活并播放，
逐帧采样 `State` 第 12 字节。

**为什么不能只靠 BLE 轮询**：单发一条 `QUERY_STATE` 要等一个完整往返
（实测 16Hz），而固件按 20fps 渲染——只存在一帧的瞬态正好落在采样间隙里。
所以证据取三份，互相补齐：

| 来源 | 频率 | 抓什么 |
|---|---|---|
| BLE 批量连发 | 33Hz | 协议层读数（用户/App 实际看到的） |
| 固件串口日志 | **每帧，无遗漏** | 掩码的每一次变化（帧级） |
| 相机 | 1.3Hz | 真实出光（见 §3） |

### 1.1 固件串口日志（帧级，无遗漏）

固件在掩码每次变化时打一行。只含 strip0 的方案循环播放时：

```
I (34105) lumen_engine: anim_mask 0xFE -> 0xFF（scope=0x01 stage=0/2 pb=1）
I (35625) lumen_engine: anim_mask 0xFF -> 0xFE（scope=0x01 stage=1/2 pb=1）
I (37125) lumen_engine: anim_mask 0xFE -> 0xFF（scope=0x01 stage=0/2 pb=1）
I (38605) lumen_engine: anim_mask 0xFF -> 0xFE（scope=0x01 stage=1/2 pb=1）
...（循环 9 轮，共 9 次上、9 次下）
```

读法：
- `0xFE` = bit1..7 全在，**bit0（strip0）不在**。strip0 在第 1 步（空步骤）
  没有内容 → 输出黑 → 没有动画位。这正是「参与方案但该步没段 = 黑」。
- `0xFF` = 八个位全在。strip0 在第 0 步有呼吸段。
- **bit1..7 全程没掉过**。旧行为（整份方案接管设备）下这里会是 `0x01` / `0x00`，
  即其余七条的动画位被整份方案覆盖掉。

`scope=0x01` 是归属位，只含 strip0。完整日志见 `serial-anim-mask.log`，
关键转换摘录见 `anim-mask-transitions.txt`。

### 1.2 BLE 逐帧采样

```
[§1 播放中] 采样 200 帧 / 6.01s = 33.3Hz，anim_mask 取值 ['0xfe', '0xff']
PASS  播放全程 strip1..7 的动画位始终为 1（逐帧）— 期望每帧都含 0xFE，实际最小 0xFE
```

### 1.3 `loop=0` 走完停住

```
PASS  方案已走完并停住（playback=STOPPED / hold_last）— playback=0 stage=1
[§2 停住后] 采样 200 帧 / 6.21s = 32.2Hz，anim_mask 取值 ['0xfe']
PASS  停住后 strip1..7 的动画位仍在（逐帧）— 每帧最低 0xFE
PASS  停住后 strip0 的动画位为 0（它冻结在最后一帧）
```

停住之后 `0xFE` 恒定不变：非参与的七条继续动，strip0 冻结且不再有动画位。

### 1.4 该步没有段 → 黑

```
PASS  播放头已进入第 1 步（空步骤）— stage=1
PASS  该步 strip0 的活动段数为 0（没有段 = 输出黑，不是纯色）— seg_counts[0]=0
     （全部 [0, 1, 1, 1, 1, 1, 1, 1]）
PASS  该步 strip0 的动画位为 0（黑帧不产生动画）— anim_mask=0xFE
```

`seg_counts` 逐条报：strip0 是 0（方案给的这一片是空的），strip1..7 各是 1
（它们自己的实时分区）。这就是「方案只驱动它包含的带」在 State 上的完整形态。

### 1.5 未参与带的实时分区逐字节不变

```
PASS  方案全程后 strip1..7 的 QueryStrip 读回与开工前逐字节一致 — 8 条全部一致
```

---

## 2. #121 随机闪烁不再下发成常亮

走页面自己的 `onPanelTypeTap` → 真实 BLE → 真实设备，读回：

```
READBACK [{"type":"0x07","period":1000,"p5":128}]
```

修复前是 `0x00`（常亮）、周期 0（见 `advanced-video-2026-11-05` 的
`10-effect-flicker--apply`）。现在类型 `0x07`、周期 1000ms（≥334 光敏线）、
密度 128/255 落进 `p5`。

固定这一点的单测：`panelLayer("flicker", defaultParams("flicker")).type === 0x07`
与「默认周期不是 0」。变异验证：删掉 `case "flicker"` 分支 → 2 条用例红。

---

## 3. 相机：逐帧比对（同内容对照）

### 3.1 为什么不能用「与基线比」

这台相机拍到的八条带在画面里靠得极近（s2 的框与 s0 的重叠 56%、s4 的重叠 62%）。
实测把 **strip0 从亮度 60 调到 0**，其余七条的读数也各掉 7~39：

```
strip0 brightness 60 -> 0, others untouched:
  s0:  64.34 ->  39.88   delta=-24.47
  s1:  47.67 ->  27.59   delta=-20.08
  s2:  76.67 ->  58.21   delta=-18.46
  s3:  32.63 ->  25.17   delta= -7.45
  s4:  43.79 ->  29.11   delta=-14.68
  s5:  75.32 ->  42.53   delta=-32.79
  s6:  99.84 ->  60.57   delta=-39.27
  s7:  38.65 ->  27.49   delta=-11.16
```

那是**光学串扰**（灯带太近、光晕叠加），比「像素有没有变」的真实量级（0.2）
大一个数量级。同内容之外的任何亮度判据都会被它淹没——实测刷出 143 个假事件。

### 3.2 改用的判据：同内容，只换渲染源

让 strip0 在两阶段渲染**完全相同的像素**（同 hue / 同 sat / 同 level）：

| 阶段 | strip0 的内容来自 |
|---|---|
| A | 实时分区（协议里没有方案） |
| B | 只含 strip0 的方案 |

两阶段 strip0 的出光逐像素相同 → 它对其它带的串扰也相同。于是判据干净：
**八条带的读数都必须无从区分**。若固件把别的带绑上了方案，B 阶段它们的渲染源
被换掉，差值就会撕开。

### 3.3 结果

```
同内容对照：A 13 帧 / B 13 帧 @ 1.3fps，阈值 2.0
  strip  实时分区  方案驱动   差
  s0      65.42    65.48   0.06
  s1      45.68    45.98   0.30
  s2      74.87    75.17   0.30
  s3      33.61    33.74   0.13
  s4      42.71    42.88   0.17
  s5      74.48    74.76   0.28
  s6      96.11    96.52   0.41
  s7      38.14    38.24   0.10

PASS  八条带在「内容相同、来源不同」下无从区分：方案没有碰非参与带
```

全部差 ≤ 0.41，阈值 2.0；静止灯带的逐帧噪声底实测 stdev 0.04~0.28、极差 0.1~1.0，
所以 0.41 在噪声带内。

---

## 4. #124 错误窗口：420ms → 一帧

同一份 3 步 × 3 段的方案，真机实测上传耗时：

```
upload: 14 frames in 420 ms  -> 30.0 ms/frame
OLD window (upload only, before play): 420 ms = 8.4 frames @20fps
NEW window (stop -> play gap): ~1 frame (33-50 ms)
```

旧顺序「停播 → 写实时分区 → 上传 → 开播」里，停播到开播之间夹着整个上传；
现在上传提到停播之前（只写 staging，不影响画面），中间只剩「停播 + 写回落画面」。

**没有加固件过渡态**：App 侧改完之后窗口已经压到一帧，再加一个「已激活但未
开播」的固件状态不会有用户可见的收益，只多一条需要维护的分支。这条判断的证据
就是上面这行实测数字。

---

## 5. 五条判据汇总

| # | 判据 | 结果 | 证据 |
|---|---|---|---|
| 1 | 只含 strip0 的方案激活后，strip1..7 动画位仍在 | ✅ | §1.1 串口帧级 + §1.2 BLE 33Hz |
| 2 | `loop=0` 停住时未参与带继续动 | ✅ | §1.3 |
| 3 | 参与但某步无段 → 该步黑 | ✅ | §1.4（`seg_counts[0]=0`、动画位 0） |
| 4 | 未参与带全程画面不变（逐帧） | ✅ | §3.3（同内容对照，差 ≤0.41） |
| 5 | 字节契约未动 | ✅ | `probe-v4.py` 43/43；向量 93 条原样通过 |

---

## 6. 复现命令

```bash
# 协议层 + 固件串口帧级证据
python scripts/capture-serial.py COM6 70 > serial.log &
python scripts/verify-scope.py --seconds 5

# 相机逐帧（同内容对照）；先标定一次
python scripts/calibrate-scope-boxes.py
python scripts/verify-scope-camera.py --seconds 10

# 字节契约
python scripts/probe-v4.py

# 三端 + 真机
node scripts/test-run.mjs firmware mp
cd miniprogram && npm run test:ble
```

相机标定产物 `.scope-boxes.json` 是本地文件（绑定机位与分辨率，不入库）；
`scripts/calibrate-scope-boxes.py` 每次换机位都要重跑。
