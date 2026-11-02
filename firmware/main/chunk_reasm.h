#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "protocol.h"

/*
 * BLE 分片重组（纯模块，无 ESP-IDF 头，host 可测）。
 *
 * 为什么单独成模块：docs/protocol-v3.md §3.2 的重组规则是**两端对称**的协议
 * 状态机，而 ble_link.c 依赖 NimBLE、无法在 host 上编译。把状态机抽出来并注入
 * now_ms，就能用向量里的 chunks_hex 直接驱动它做逐字节断言。
 *
 * 分片头（每次 write / notify 都有）：
 *   bit7 FIRST —— 本逻辑帧的第一个分片
 *   bit6 LAST  —— 本逻辑帧的最后一个分片
 *   bit5..0    分片序号（0-63 循环，仅用于诊断，不要求连续）
 *
 * 规则（§3.2 第 1-4 条）：
 *   1. FIRST 到达时若有未完成缓冲，丢弃旧的重新开始（latest-wins）；
 *   2. 依次追加到 240 字节缓冲，累计超过 240 → 丢弃并回 BadLength；
 *   3. LAST 到达时缓冲完成，交调用方按 §3.1 解析，随后清空；
 *   4. 自上一个分片起 1000ms 未完成 → 丢弃且**不回 ACK**（此时 seq 已不可靠）。
 *
 * 并发：本结构自身不加锁。ble_link 在 RX 回调（NimBLE 主机任务）里 feed，
 * 渲染任务周期性调用 expire；两处都用 ble_link 里的短临界区包住。
 */

#define LUMEN_REASM_CAPACITY LUMEN_MAX_FRAME /* 240：重组后的逻辑帧上限 */
#define LUMEN_REASM_TIMEOUT_MS 1000u

/* 分片头位定义（§3.2）。不分片的帧也必须带 ctrl = 0xC0，不允许裸帧。 */
#define LUMEN_CHUNK_FIRST 0x80
#define LUMEN_CHUNK_LAST 0x40
#define LUMEN_CHUNK_INDEX_MASK 0x3F
#define LUMEN_CHUNK_SINGLE (LUMEN_CHUNK_FIRST | LUMEN_CHUNK_LAST)

typedef enum {
    LUMEN_REASM_PENDING = 0, /* 已收下，等待后续分片 */
    LUMEN_REASM_COMPLETE,    /* 已收到 LAST，data / len 有效，缓冲已复位 */
    LUMEN_REASM_OVERFLOW,    /* 累计超过 240，缓冲已丢弃，调用方应回 BadLength */
    LUMEN_REASM_IGNORED,     /* 非 FIRST 且没有进行中的重组（无头分片），静默丢弃 */
} lumen_reasm_status_t;

typedef struct {
    uint8_t data[LUMEN_REASM_CAPACITY];
    uint16_t len;
    bool active;
    /* 诊断用：分片头里的序号不要求连续，只记下来供日志比对。 */
    uint8_t last_index;
    /* 最近一次收到分片的时刻（毫秒，可回绕）。只在 active 时有效。 */
    uint32_t last_ms;
    /*
     * 第一个分片的前 4 字节（magic / version / command / seq）。累计溢出时缓冲被
     * 丢弃，但 §3.2 规则 2 仍要求回 BadLength——seq 只能从这里取。FIRST 时刷新，
     * 溢出后保留（不清空），由下一次 FIRST 覆盖。
     */
    uint8_t first_header[4];
    bool have_header;
} lumen_reasm_t;

void lumen_reasm_init(lumen_reasm_t *reasm);

/*
 * 喂一个分片。ctrl 是分片头，data/len 是分片头之后的数据。
 *
 * 返回 COMPLETE 时 reasm->data / reasm->len 是本逻辑帧，调用方解析后不需要
 * 手动清空（本函数已在返回前复位）。OVERFLOW / IGNORED 时调用方只按返回值处理。
 */
lumen_reasm_status_t lumen_reasm_feed(lumen_reasm_t *reasm, uint8_t ctrl, const uint8_t *data,
                                      size_t len, uint32_t now_ms);

/*
 * 兜底清理：渲染任务每秒调用一次。丢弃一个已超时（> 1000ms）的未完成重组，
 * 返回 true；没有超时或本来就没有进行中的重组返回 false。**不发 ACK**。
 */
bool lumen_reasm_expire(lumen_reasm_t *reasm, uint32_t now_ms);

/* 丢弃未完成的重组（新连接 / 断连时用）。返回是否真的丢弃了东西。 */
bool lumen_reasm_reset(lumen_reasm_t *reasm);

/*
 * 发送侧切分（设备 → 小程序，规则与接收端对称）。
 *
 * capacity 是**单分片的数据上限**（= chunk_capacity - 1，见 §2.1）。
 * 返回该帧需要几个分片；frame_len == 0 或 capacity == 0 返回 0。
 */
uint8_t lumen_reasm_chunk_count(size_t frame_len, uint8_t capacity);

/*
 * 切出第 index 个分片（含 1 字节 ctrl 头）。返回写入 out 的字节数，失败返回 0。
 * 首片置 FIRST、末片置 LAST；单分片时两者同时置位（ctrl = 0xC0）。
 */
size_t lumen_reasm_build_chunk(const uint8_t *frame, size_t frame_len, uint8_t capacity,
                               uint8_t index, uint8_t *out, size_t out_cap);
