# 交接：#20 错色率真机测试

**写给新会话。** 只写「读代码看不出来、但必须知道」的东西，其余给指针。

---

## 0. 一句话现状

8 路 TDM、四种灯效、剧本、分段**全部真机验收通过**（见 `docs/animation-baseline.md` §7、
`docs/end-to-end-acceptance.md` §4/§7/§8）。**唯一剩下的是 #20 的核心问题：
8 路 + BLE 高频写入的错色率，至今零数据。**

---

## 1. 硬件事实（这几条踩了很久才确认，别重新试）

| 项 | 值 |
|---|---|
| 设备 | ESP32-C3FH4，COM6，USB VID 303A:1001 |
| 灯板 | **一块 8×8 方阵（64 灯）**，只有这一块，不是 8 条灯带 |
| 灯板接线 | **DIN 接 GPIO6**，独立 5V 供电，与开发板共地 |
| 引脚映射 | `LUMEN_STRIP_PINS="3,10,0,1,4,5,6,7"` → **GPIO6 = `strip_id 6`** |
| 摄像头 | 索引 0，MSMF 后端，1920×1080，**定焦**（无自动对焦，cv2 改不了） |

**关键认知**：固件在 8 路 TDM 下把 8 条的内容轮流发到 8 个引脚。灯板只接了 GPIO6，
所以**只有 `strip_id 6` 的内容会真的显示**。给 strip 0 配东西，灯板不会有任何反应
——这个坑我踩了很久。

---

## 2. 当前固件状态（已烧录，可直接用）

```
CONFIG_LUMEN_STRIP_PINS="3,10,0,1,4,5,6,7"   # 8 路
CONFIG_LUMEN_ANIM_FPS=20                     # 实测 20.05fps
CONFIG_LUMEN_FORCE_REFRESH=y                 # ★ 静态画面也持续刷帧（实验专用）
```

`CONFIG_LUMEN_FORCE_REFRESH` 是这轮为实验加的开关：跳过逐帧去重、静态也按 20fps 刷。
**量产必须关掉**（它让静态场景也持续占 RMT 带宽）。Kconfig 里有完整说明。

**工作区状态**：`firmware/` 和 `scripts/analyze-strip-video.py` 有未提交改动
（force-refresh 开关 + 分析工具的 `--grid` 模式）。这些是实验工具，不影响产品路径，
但**还没提交**——新会话如果要用，直接在同一工作区继续即可。

---

## 3. 已经做好的工具（直接用，不用重写）

### `scripts/ble-stress.py`（本轮新增）
PC 当 BLE central，配置画面 + 制造 BLE 压力。

```bash
python scripts/ble-stress.py setup --strip 6 --brightness 60 --leds 8   # 点 8 颗对角灯
python scripts/ble-stress.py flood --seconds 180 --hz 20                # 20Hz 持续写
python scripts/ble-stress.py reset                                      # 恢复
```

### `scripts/analyze-strip-video.py`
逐帧判定错色。**本轮已加 `--grid RxC` 模式**（原来只支持一维切段）。

```bash
python scripts/analyze-strip-video.py --selftest                       # 5 个用例全过
python scripts/analyze-strip-video.py rec.mp4 --grid 8x8 --roi X,Y,W,H
```

自检**已通过**，含新增的「8×8 方阵第 27 格错色」用例——能精确定位到格子、零假阳性。

---

## 4. 相机标定（这轮花了很久，值直接抄）

**问题**：灯板是 8×8 方阵，斜拍时有透视+旋转，规整 8×8 等分网格对不上。

**当前可用的标定**（画面位置会随你挪动而变，**每次都要重新确认**）：

```python
EXPOSURE = -7        # 曝光档位粗，-10 → 全黑，-9 → 饱和
GAIN     = 30
# 亮度 60 时 R≈150、G≈137，G/B 各有 100+ 余量（错色时 G 飙升可检出）
```

**必须避免过曝**：R 通道饱和到 255 后色相信息就没了，错色检测会失效。
判据：`R 不饱和 + G/B < 200`，可用下面这段检查（在仓库根目录跑）：

```python
import cv2, time
c = cv2.VideoCapture(0, cv2.CAP_MSMF)
c.set(cv2.CAP_PROP_FRAME_WIDTH, 1920); c.set(cv2.CAP_PROP_FRAME_HEIGHT, 1080)
c.set(cv2.CAP_PROP_AUTO_EXPOSURE, 0.25)
c.set(cv2.CAP_PROP_EXPOSURE, -7); c.set(cv2.CAP_PROP_GAIN, 30)
time.sleep(1.2)
for _ in range(20): c.grab()
ok, f = c.read(); c.release()
print(f"饱和像素 {(f>=250).mean()*100:.1f}%  （应 < 5%）")
cv2.imwrite("check.png", f)
```

> 注意：`opencv` 和 `bleak` **不能在同一个进程里**用（opencv 把线程设成 Windows GUI，
> 之后 bleak 会报 `Thread is configured for Windows GUI`）。分开两个脚本跑。

---

## 5. 下一步：实验本身

### 判据（票面原定）
30 分钟 20Hz 写入下，**错色 ≤ 1 次/10 分钟**且用户不可感知。

### 推荐的执行顺序

```bash
# 1. 配置画面（8 颗孤立红灯，恒定）
python scripts/ble-stress.py setup --strip 6 --brightness 60 --leds 8

# 2. 确认相机标定（R 不饱和）
#    跑上面那段检查代码，看图确认 8 颗灯清晰、无粘连

# 3. 录基线 3 分钟（什么都不写）→ 应 0 错色
#    （用 OBS / Windows 相机应用 / 或写个 cv2.VideoWriter 也行）

# 4. 录压力段 3 分钟，同时跑：
python scripts/ble-stress.py flood --seconds 180 --hz 20

# 5. 判定
python scripts/analyze-strip-video.py baseline.mp4 --grid 8x8 --roi X,Y,W,H
python scripts/analyze-strip-video.py stress.mp4   --grid 8x8 --roi X,Y,W,H
```

**先跑 3 分钟快速筛查**：若零错色，再考虑跑满 30 分钟；若几分钟就出错色，
那就是重大发现（8 路 + 20fps 不安全，需降帧率或改 `mem_block_symbols`）。

### 注意事项
- 录制全程**不要碰灯板、不要开灯、不要移动相机**——分析工具靠「画面恒定」判定。
- `flood` 会让亮度在 60/59 之间微调，基线要容忍这一档（这是为了让写入真实生效，
  否则固件可能因为值没变而忽略）。
- 手机小程序要退到后台，它会抢 BLE 连接。

---

## 6. 已知的坑（都踩过）

1. **GPIO6 = strip_id 6**，不是 strip 0。配错条 → 灯板毫无反应。
2. **`State.seg_count` 只报 strip 0 的段数**（协议如此）。配 strip 6 后读 State 看到
   `seg_count=0` 是正常的，用 `QueryStrip 6` 才能查到 strip 6 的段表。
3. **相机曝光档位粗**：-8 饱和 15%、-9 几乎全黑，中间没有值。靠 **GAIN** 补精细控制。
4. **opencv 与 bleak 同进程会冲突**（线程模型），必须分开跑。
5. **串口是独占的**：抓日志时不能同时有别的进程占 COM6。残留的
   `python capture-serial.py` 进程会一直占着，需要手动 kill。
6. **分析工具的 `--roi` 必须精确**：框大了会把溢光算进去，框小了切掉灯珠。
   建议先落一张图，用 `cv2.rectangle` 画出来目视确认。

---

## 7. 参考文档

| 内容 | 文件 |
|---|---|
| 帧率基线、8 路实测、拔线结论 | `docs/animation-baseline.md`（§7 是本轮新增） |
| 已完成的真机验收 | `docs/end-to-end-acceptance.md`（§4 / §7 / §8） |
| #7 的实验方案与判定工具说明 | `docs/rmt-ble-stability.md` |
| 协议字节契约 | `docs/protocol.md` |
| issue | #20（本项）、#29（8 路 TDM，已闭环） |

---

## 8. 如果实验跑出结论

把数字写回 `docs/animation-baseline.md` §7.5 的「仍未测」一节，并回帖 #20。
若发现错色，第一嫌疑是 **BLE 抢占 RMT ISR**（C3 单核、无 DMA、编码在 ISR 里逐块执行），
先试降帧率到 10fps 或把 `mem_block_symbols` 调到 192 做对照。
