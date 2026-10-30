# v2 灯效引擎架构

**状态**：设计定稿（2026-10-31），由 [#22](https://github.com/sishoui/light-matt/issues/22) 产出。
**前置已定**：[#20 帧率基线](./animation-baseline.md)（10fps 可配、TDM 单通道、静态不空转、错色风险开放）、
[灯效规格](./effects-spec.md)（参数块与公式，已定稿，本文不改）。
**关系**：本文只回答「怎么组织代码与任务」，字节细节以 `docs/protocol.md` 为准，效果公式以
`docs/effects-spec.md` 为准。

---

## 1. 一句话

**灯效计算是纯函数模块（`effects.c`），渲染循环是唯一的定时消费者（`led_engine`），
两者之间只用一个「段配置数组 + 当前时刻」的接口。** 静态与动画的共存靠
「有没有活动动画段」这一个判据，而不是两套渲染路径。

---

## 2. 模块划分与依赖方向

```
                 ┌──────────────────────────────┐
                 │ ble_link                     │  解帧、ACK、notify
                 └──────────────┬───────────────┘
                                │ commit / set_segment / playback
                 ┌──────────────▼───────────────┐
                 │ led_engine                   │  状态所有权、任务、句柄、定时
                 └───┬──────────────────┬───────┘
                     │                  │
      ┌──────────────▼──────┐   ┌───────▼────────────┐
      │ effects (纯函数)     │   │ state_store        │  NVS
      │ segment_store (纯)   │   └────────────────────┘
      └──────────────────────┘
```

| 模块 | 职责 | 依赖 | host 可测 |
|---|---|---|---|
| `effects.c/.h` | 四种灯效的像素计算：给「类型 + 参数 + 段内经过时间 + 灯珠下标」，返回 RGB | 无（仅 `stdint`） | ✅ |
| `segment_store.c/.h` | 8 段 × 8 灯带的配置数组、区间校验、重叠判定、合成到像素缓冲 | 无 | ✅ |
| `script_store.c/.h` | 剧本暂存区、提交/回滚、播放头推进（阶段时间轴） | 无 | ✅ |
| `led_engine.c` | 状态所有权、任务循环、句柄、TDM 轮询、把上面的纯模块串起来 | `effects` / `segment_store` / `script_store` / `state_store` | 部分 |
| `state_store.c` | 配置持久化（段配置 + 剧本 + 播放相关字段） | — | 部分（blob 编解码纯） |

**依赖单向**：`ble_link → led_engine → {effects, segment_store, script_store, state_store}`。
`effects` 不 include 任何 ESP-IDF 头，这是它能进 host 测试的前提（沿用 `gamma` / `selftest` 的做法）。

---

## 3. 帧循环：一个任务，两种模式

### 3.1 判据

```c
bool need_frames(void);  /* 任一活动段是动画类（type != 0x00） || 剧本在播放 */
```

- **静态模式**：`need_frames() == false` → 渲染任务阻塞在信号量上，
  只有 `commit` 才唤醒。**与 v1 完全一致**，静态场景零额外 CPU、零额外 RMT 负载。
- **动画模式**：`need_frames() == true` → 渲染任务带超时阻塞
  （`pdMS_TO_TICKS(1000 / CONFIG_LUMEN_ANIM_FPS)`），超时即渲染下一帧。

`CONFIG_LUMEN_ANIM_FPS` 默认 **10**（#20 结论），区间 5–30。
**不引入第二个定时器任务**：`esp_timer` 回调里做渲染会持锁、与 BLE 回调抢单核，
且无法自然串行化句柄操作。用渲染任务自身的 `xSemaphoreTake(..., timeout)` 就够了。

### 3.2 为什么不空转静态段

这是「静态段不会因为动画帧循环而空转刷帧」的实现方式：
帧循环只在 `need_frames()` 为真时存在。一段呼吸 + 一段静态时，
帧循环开着，静态段的像素每帧重算但**结果相同**——为避免无谓的 RMT 传输，
渲染层对整条灯带的最终像素缓冲做**逐字节比较**，全等则跳过 `refresh`。
（比 v1 的「单色三元组比较」更细，因为分段后缓冲长度可达 64 × 3。）

日志上要能看出差异：跳过时打 DEBUG「帧未变，跳过 refresh」，真刷时打 INFO 带帧号。

### 3.3 帧号与时间基准

- 段内时间 `t` 由 **段生效时刻 `t0_ms`** 与 `now_ms` 算出（无符号减法，
  `docs/effects-spec.md` §6 的 64 位中间量要求）。**不是**帧号——帧率可配、可被 BLE 拖慢，
  用帧号会让动画速度随负载漂移。
- `now_ms = esp_timer_get_time() / 1000`，49 天回绕，先取模再算相位。

---

## 4. 分段合成

### 4.1 数据结构

```c
typedef struct {
    bool active;
    uint8_t start, end;      /* 闭区间，end < led_count[strip] */
    uint8_t type;            /* 0x00 静态 / 0x01 呼吸 / 0x02 彩虹 / 0x03 流光 */
    uint16_t hue;            /* 0-65535 */
    uint8_t sat;
    uint16_t period_ms;
    uint8_t p5;              /* min_level / span / tail，按 type 解释 */
    uint8_t flags;
    uint32_t t0_ms;          /* 本段配置生效时刻 */
} lumen_segment_t;           /* 16 字节（对齐后） */
```

8 段 × 8 灯带 × 16B = **1024 字节**。当前空闲 heap 316KB，可接受。

### 4.2 合成顺序

```
每帧：
  memset(buf, 0, led_count * 3)              // ① 未覆盖区必须先清零
  for seg in segments[strip] where active:
      for i in seg.start..seg.end:
          rgb = lumen_effect_pixel(seg, i, now_ms)
          buf[i] = gamma(rgb, brightness)   // ② 每颗灯都过 gamma + 亮度
  refresh(buf)
```

- **① 清零不可省**：WS2812B 锁存，不主动写 0 就留残影（#25 的验收点）。
- **② gamma 与亮度在合成之后统一施加**：灯效算的是用户空间 RGB，
  亮度滑块与动画包络相乘叠加（`effects-spec.md` §4.2）。**禁止**在 `effects.c` 里做 gamma。
- 空白区间（[0-15] 与 [40-63] 之间的 16-39）落在 memset 的 0 上，天然熄灭。

### 4.3 段与亮度

呼吸的包络是**用户空间**的乘算（`effects.c` 输出已含包络），
亮度滑块再统一缩放。这样拖亮度不破坏灯效的相对关系（`effects-spec.md` §4.2）。

---

## 5. 灯效参数模型与分派

`effects.c` 的接口（纯函数，host 直接测）：

```c
/* 返回一颗灯的用户空间 RGB。now_ms 与 seg->t0_ms 同基准。 */
void lumen_effect_pixel(const lumen_segment_t *seg, uint16_t index_in_strip,
                        uint32_t now_ms, uint8_t out_rgb[3]);

/* 供渲染层判断是否需要帧循环 / 是否需要比较缓冲。 */
bool lumen_effect_is_animated(uint8_t type);

/* 段内灯珠数（彩虹/流光需要 N）。 */
uint16_t lumen_effect_segment_length(const lumen_segment_t *seg);
```

- **分派**：`switch (seg->type)`。未知类型 **不应出现**——命令层已在
  `docs/protocol.md` 校验顺序第 4 步拒绝（`InvalidParam`），D7「不静默降级」。
  `effects.c` 的 `default` 分支返回黑色并断言不可达（防御，不当作降级路径）。
- **每段独立相位**（D4）：`t` 从该段 `t0_ms` 起算，跨段不连续。这是接受的取舍，
  #31 的验收要求「确实不连续」。
- **整数运算**：相位 `phase_q16` 用 `uint64_t` 中间量；`exp` 用查表（流光尾部）。
  不使用 `float`（C3 无 FPU）。

### 5.1 相位状态存在哪

**不存在每段的可变相位变量里。** 相位完全由 `(now_ms - t0_ms) % period_ms` 算出，
`t0_ms` 是唯一的可变状态。这样做的好处：

- 动画状态不需要每帧保存/恢复，重启渲染任务不丢相位；
- 暂停/继续剧本时只需不改时间基准的推进量（见 §6）；
- 不写 NVS（相位每帧都变，写 NVS 等于自杀）。

---

## 6. 剧本时间轴

### 6.1 谁推进阶段

**由渲染任务在每帧开头推进**，不另起定时器。

```c
if (script->playback_state == PLAYING) {
    while (elapsed >= script->stages[head].duration_ms) {
        elapsed -= duration_ms;
        head = (head + 1) % stage_count;   // loop 或到头即停
    }
}
```

- 用 `while` 而不是 `if`：BLE 可能把渲染任务推迟超过一个阶段时长，
  一次追上所有过期的阶段，不会「卡在旧阶段」。
- 非循环剧本走完最后一个阶段 → `playback_state = STOPPED`，停在最后一阶段画面。

### 6.2 阶段切换时相位怎么衔接

**阶段切换 = 换一套段配置，且所有段的 `t0_ms` 重置为切换时刻。**
即：**相位重置**，不延续。

理由：阶段代表「整体换一套观感」，跨阶段延续相位会让同一套配置在不同阶段
呈现不同画面，用户无法预期。且延续需要在切换时做相位补偿运算，
收益不明确、复杂度高。**写进文档，这是已定取舍。**

### 6.3 暂停/停止的语义

| 动作 | 播放头 | 画面 | `t0_ms` |
|---|---|---|---|
| pause | 冻结 | 保持不变（不继续渲染动画） | 暂停时记录 `pause_offset_ms` |
| play（从暂停） | 从冻结处继续 | 恢复动画 | `t0_ms += 暂停时长`（等效把时间轴推后） |
| stop | 回到 stage 0 | 回到激活前的静态配置 | 重置 |

**暂停后继续从暂停处继续而不是从头**（#32 验收点）——靠 `pause_offset_ms` 补偿，
而不是重置播放头。

### 6.4 剧本的存储

- **暂存区**：`ScriptBegin` 分配，`ScriptCommit` 原子替换。
  失败时丢弃暂存、保留上一套（#21 §6）。
- **`MAX_SCRIPTS = 4`**：每套 8 阶段 × 8 段 × 16B ≈ 1KB，4 套 ≈ 4–5KB（含时长表）。
- **持久化**：只持久化**已提交**的剧本与当前激活 id。**播放位置不持久化**，
  上电从第一阶段开始、`playback_state = STOPPED`（#21 §6 已定，二选一取「从头」）。

---

## 7. 与既有机制的交互

### 7.1 自检

自检是**渲染层的最高优先级覆盖**：自检进行时，动画帧循环暂停推进剧本播放头，
像素输出走自检色（沿用 `lumen_selftest_compose`）。自检结束回到存储状态与剧本当前阶段。

原因：自检的语义是「让用户确认硬件没坏」，覆盖期间必须稳定、可预期。
若自检期间还跑动画，用户无法判断看到的是自检色还是灯效色。

### 7.2 灯珠数量重建

`SetLedCount` 重建句柄时（v1 已有的异步流程）：

1. 暂停帧循环（不进新帧）；
2. 清黑旧灯带 → 删旧句柄 → 建新句柄（v1 顺序，不能反）；
3. **裁剪段配置**：任何 `end >= new_count` 的段失效（`active = false`），
   并在串口明确打日志。不自动缩短——自动改用户的段边界更令人意外；
4. 恢复帧循环，按新数量重绘。

### 7.3 NVS

- **只存配置**：段配置、剧本、激活 id、开关/亮度/灯珠数。
- **不存相位**（由 `t0_ms` 算出，每帧变）。
- debounce 沿用 v1 的 500ms；动画帧循环**不触发** `request_save`
  （只有配置变更才触发，否则每帧都写 NVS）。

### 7.4 BLE 并发

- 帧循环在渲染任务（优先级 4），BLE 主机任务优先级 21——BLE 永远能抢占。
  这是必须的：不能反过来阻塞协议栈。
- 渲染任务持锁范围沿用 v1 的规矩：**只读取快照时持锁，set_pixel + refresh 不持锁**。
  State read 不能被一帧的 RMT 传输拖住。

---

## 8. 内存预算

| 项 | 字节 |
|---|---|
| 像素缓冲 8 条 × 64 灯 × 3 | 1536 |
| 段配置 8 × 8 × 16 | 1024 |
| 剧本 4 套 × (8 阶段 × 8 段 × 16 + 时长表) | ~4500 |
| 暂存区 1 套 | ~1100 |
| 上一帧缓冲（比较用）8 × 64 × 3 | 1536 |
| 合计新增 | **≈ 9.7 KB** |

当前空闲 heap 316KB。**超出时的降级顺序**（写死在文档里，避免临场乱改）：

1. 上一帧比较缓冲改为「每段一个 32 位校验和」——省 1.5KB；
2. `MAX_SCRIPTS` 4 → 2——省约 2.2KB（#32 只要求「至少 2 套」，合规）；
3. 剧本按需分配（只驻留激活的那一套）——省约 3.3KB，代价是切剧本要重新下发。

像素缓冲与段配置**不降级**：它们是功能本体。

---

## 9. `led_engine` 接口草图

```c
/* --- 新增，供 ble_link / 纯模块测试用 --- */

/* 段配置写入（命令层已校验类型/区间/重叠）。成功返回 true。 */
bool lumen_led_engine_set_segment(uint8_t strip_id, const lumen_segment_t *seg);
bool lumen_led_engine_clear_segment(uint8_t strip_id, uint8_t seg_id);

/* 把某灯带的活动段拷出来（QueryStrip → SegmentReport 用）。 */
uint8_t lumen_led_engine_segments(uint8_t strip_id, lumen_segment_t *out, uint8_t cap);

/* 播放控制。 */
void lumen_led_engine_set_playback(uint8_t action, bool loop);

/* 剧本下发。 */
bool lumen_led_engine_script_begin(uint8_t script_id, uint8_t stages, uint8_t strips);
bool lumen_led_engine_script_stage(uint8_t script_id, uint8_t index, uint16_t duration_ms);
bool lumen_led_engine_script_segment(uint8_t script_id, uint8_t stage, uint8_t strip_id,
                                     const lumen_segment_t *seg);
bool lumen_led_engine_script_commit(uint8_t script_id);
void lumen_led_engine_script_abort(uint8_t script_id);
bool lumen_led_engine_activate_script(uint8_t script_id, bool loop);

/* 14 字节 State（v2）。 */
void lumen_led_engine_state_bytes(uint8_t out[LUMEN_STATE_BYTES]);
```

`effects.c` / `segment_store.c` / `script_store.c` 的头文件不含 `esp_err.h`，
这样 `firmware/test/run-tests.cmd` 能直接把它们加进 gcc 编译列表。

---

## 10. 给实现票的边界

| 票 | 在本架构里加什么 |
|---|---|
| #25 分段静态 | `segment_store` 全量 + `effects` 的静态分支 + 渲染合成（含清零） |
| #29 八引脚 TDM | `led_engine` 的灯带数组 + `led_strip_switch_gpio` 轮询 + 周期埋点 |
| #30 呼吸 | `effects` 的呼吸分支 + 帧循环（`need_frames`） |
| #31 彩虹/流光 | `effects` 的两个空间分支（复用相位与帧循环） |
| #32 剧本 | `script_store` 全量 + 播放头推进 + 下发批次 |

**不要提前实现后面的票**：每条纵切只加自己那一层，保持「一条能跑通的细线」。
