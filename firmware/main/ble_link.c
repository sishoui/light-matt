#include "ble_link.h"

#include <stdio.h>
#include <string.h>

#include "esp_log.h"
#include "esp_mac.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "nimble/ble.h"
#include "nimble/nimble_port.h"
#include "nimble/nimble_port_freertos.h"
#include "host/ble_att.h"
#include "host/ble_gap.h"
#include "host/ble_gatt.h"
#include "host/ble_hs.h"
#include "host/ble_uuid.h"
#include "host/util/util.h"
#include "services/gap/ble_svc_gap.h"
#include "services/gatt/ble_svc_gatt.h"

#include "command.h"
#include "chunk_reasm.h"
#include "effects.h"
#include "led_engine.h"
#include "protocol.h"
#include "state_store.h"
#include "stress_metrics.h"
#include "strip_planar.h"

static const char *TAG = "lumen_ble";

/* 128-bit UUID 在 NimBLE 里按小端存放。唯一真相是 docs/protocol.md §2。
 * Service 6c756d65-6e00-4b1e-9a3c-000000000001
 * RX      ...-000000000002
 * TX      ...-000000000003
 * State   ...-000000000004
 */
static const ble_uuid128_t s_svc_uuid = BLE_UUID128_INIT(
    0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x3c, 0x9a,
    0x1e, 0x4b, 0x00, 0x6e, 0x65, 0x6d, 0x75, 0x6c);
static const ble_uuid128_t s_rx_uuid = BLE_UUID128_INIT(
    0x02, 0x00, 0x00, 0x00, 0x00, 0x00, 0x3c, 0x9a,
    0x1e, 0x4b, 0x00, 0x6e, 0x65, 0x6d, 0x75, 0x6c);
static const ble_uuid128_t s_tx_uuid = BLE_UUID128_INIT(
    0x03, 0x00, 0x00, 0x00, 0x00, 0x00, 0x3c, 0x9a,
    0x1e, 0x4b, 0x00, 0x6e, 0x65, 0x6d, 0x75, 0x6c);
static const ble_uuid128_t s_state_uuid = BLE_UUID128_INIT(
    0x04, 0x00, 0x00, 0x00, 0x00, 0x00, 0x3c, 0x9a,
    0x1e, 0x4b, 0x00, 0x6e, 0x65, 0x6d, 0x75, 0x6c);

/*
 * 单次 BLE 写 / notify 的字节上限（docs/protocol-v3.md §2.1）：
 *   chunk_capacity = min(mtu - 3, 180)，单分片的数据上限再减 1 字节分片头。
 *
 * MTU 未知时按 23 处理（最坏情况），即 20 字节写、19 字节数据。
 * LUMEN_RX_BUF_SIZE 按最大分片容量留足；实际接收也要按 s_mtu 再判一次，
 * 因为对端完全可能用协商后更大的 MTU 写进来。
 */
#define LUMEN_RX_BUF_SIZE (LUMEN_MAX_CHUNK_CAPACITY + 1)
#define LUMEN_DEFAULT_MTU 23

/* v3 协议版本号（DeviceInfoReport 的 firmware_version = major<<8 | minor）。 */
#define LUMEN_FIRMWARE_VERSION 0x0300

/* 每条灯带的数据脚（构建期 Kconfig，协议只读；#38 的 StripConfigReport 用它）。 */
#ifndef CONFIG_LUMEN_STRIP_PINS
#define CONFIG_LUMEN_STRIP_PINS "3"
#endif

/* 分片重组状态（§3.2）。RX 回调在 NimBLE 主机任务里串行喂；1Hz 的 esp_timer
 * 兜底超时清理与它并发，所以两者共用一个 portMUX 短临界区（只包住 240 字节的
 * 静态缓冲操作，不阻塞、不做 IO）。 */
static lumen_reasm_t s_reasm;
static portMUX_TYPE s_reasm_mux = portMUX_INITIALIZER_UNLOCKED;

/*
 * 重组完成后拷出的逻辑帧。放静态区而不是 RX 回调的栈上：240 字节在 NimBLE
 * 主机任务的 4KB 栈里不算小，而这里同一时刻只有一次未完成的重组，静态区
 * 天然安全（拷贝仍在临界区内，见 handle_chunk）。
 */
static uint8_t s_chunk_frame[LUMEN_REASM_CAPACITY];

static uint8_t s_own_addr_type;
static volatile uint16_t s_conn_handle = BLE_HS_CONN_HANDLE_NONE;
static uint16_t s_tx_val_handle;
static char s_device_name[16] = "Lumen-0000";
/* 当前连接的 ATT MTU。0 = 未知（按 23 处理，docs/protocol-v3.md §2.1）。 */
static volatile uint16_t s_mtu;

/*
 * 重组超时的兜底清理（§3.2 规则 4）。
 *
 * 主路径在 lumen_reasm_feed 里就地判过期（下一个分片到达时清掉旧缓冲），
 * 但「对端发了一半就消失」不会再有下一个分片，所以还需要一个周期性清理。
 * 这里用 1Hz esp_timer 而不是渲染任务：渲染任务在静态场景阻塞在信号量上，
 * 恰恰是最需要兜底的时候不会醒；esp_timer 与 BLE 回调共用同一把短临界区，
 * 不会反转 led_engine 与 BLE 的依赖方向。
 */
static esp_timer_handle_t s_reasm_timer;

static void reasm_timeout_cb(void *arg)
{
    (void)arg;
    uint32_t now = (uint32_t)(esp_timer_get_time() / 1000);
    bool dropped;
    taskENTER_CRITICAL(&s_reasm_mux);
    dropped = lumen_reasm_expire(&s_reasm, now);
    taskEXIT_CRITICAL(&s_reasm_mux);
    if (dropped) {
        /* 超时**不回 ACK**（此时 seq 已不可靠，§3.2 规则 4）。 */
        ESP_LOGW(TAG, "分片重组超时 %ums，丢弃半截缓冲", (unsigned)LUMEN_REASM_TIMEOUT_MS);
    }
}

static int gap_event(struct ble_gap_event *event, void *arg);
static void advertise(void);

/*
 * 当前单分片的数据上限（不需要分片头的那部分）。
 * 未知 MTU（0）按 23 处理 → 20 字节写 → 19 字节数据（docs/protocol-v3.md §2.1）。
 */
static uint16_t chunk_data_capacity(void)
{
    uint16_t mtu = s_mtu;
    if (mtu == 0) {
        mtu = LUMEN_DEFAULT_MTU;
    }
    uint16_t capacity = (uint16_t)(mtu - 3);
    if (capacity > LUMEN_MAX_CHUNK_CAPACITY) {
        capacity = LUMEN_MAX_CHUNK_CAPACITY;
    }
    if (capacity < 2) {
        capacity = 2; /* 防御：至少能放下 1 字节 ctrl + 1 字节数据 */
    }
    return (uint16_t)(capacity - 1);
}

/*
 * 处理一条完整写到 RX 的分片（docs/protocol-v3.md §3.2）：
 *   ctrl 解析 → 重组 → 完成时交给 handle_frame。
 *
 * 超过本次写容量、或累计超过 240 → 回 BadLength（§3.2 规则 2）。重组溢出时
 * 缓冲已经被丢弃，这里只有 ctrl 头里的数据可读，所以用第一个分片的数据里
 * 的 command / seq 回 ACK（若首片还没到就没有可靠 header，只能静默）。
 */
static void handle_chunk(uint8_t ctrl, const uint8_t *data, size_t len, uint32_t now_ms);

/*
 * 回一条 Event：载荷 [event_code, detail]，seq 固定 0x00（协议 §7.4）。
 * 用于 ACK 之后才发生的异步失败，例如 NVS 写失败（§10.3）。
 */
static void send_event(uint8_t event, uint8_t detail)
{
    uint8_t frame[LUMEN_MAX_FRAME];
    size_t len = lumen_protocol_encode_event(event, detail, frame, sizeof(frame));
    if (len == 0 || lumen_ble_link_notify(frame, len) != ESP_OK) {
        ESP_LOGW(TAG, "Event 0x%02X detail=0x%02X 发送失败", event, detail);
        return;
    }
    ESP_LOGI(TAG, "Event event=0x%02X detail=0x%02X", event, detail);
}

/*
 * 存储任务发现 NVS 写失败时回调到这里：ACK 早已发出，按 §10.3 用 Event 0x81
 * 异步告知小程序。回调运行在存储任务上下文，只做一次 mbuf 拷贝与入队。
 */
static void on_store_failed(uint8_t command)
{
    send_event(LUMEN_EVENT_STORAGE_FAILED, command);
}

/*
 * 回一条 ACK：载荷 [原命令字, 结果码]，seq 回显请求。
 * 在 NimBLE 主机任务的 RX 回调里调用；notify 内部只做 mbuf 拷贝与入队，
 * 不等待射频发送完成，也不刷灯 / 写 NVS。
 *
 * 成功路径不打日志：调用方（handle_frame / 渲染任务）已经在同一条 RX 汇总里
 * 带了 cmd / seq / result，重复一行会成倍放大 20Hz 拖动时的串口占空比。
 * 只有发送失败才告警——那才是需要人看的信息。
 */
static void send_ack(uint8_t seq, uint8_t command, uint8_t result)
{
    uint8_t frame[LUMEN_MAX_FRAME];
    size_t len = lumen_protocol_encode_ack(seq, command, result, frame, sizeof(frame));
    if (len == 0) {
        ESP_LOGE(TAG, "ACK 编码失败 cmd=0x%02X seq=0x%02X result=0x%02X", command, seq,
                 result);
        return;
    }
    esp_err_t err = lumen_ble_link_notify(frame, len);
    if (err != ESP_OK) {
        ESP_LOGW(TAG, "ACK notify 失败 cmd=0x%02X seq=0x%02X result=0x%02X err=%s", command,
                 seq, result, esp_err_to_name(err));
    }
}

/*
 * 引擎在渲染任务里发出的异步 ACK（SetLedCount 重建完成后）。
 * 同样只做编码 + notify 入队，不阻塞渲染任务。
 */
static void engine_response(uint8_t seq, uint8_t command, uint8_t result)
{
    send_ack(seq, command, result);
}

/*
 * 超过本地重组缓冲的分片：协议规定累计 > 240 必须拒绝（0x04），绝不截断执行
 * （docs/protocol-v3.md §3.2 规则 2）。分片头之后的前 4 字节仍是逻辑帧 header，
 * 所以先按 §5 的顺序检查 magic / version，再回长度错误。
 *
 * 注意分片头：header[0] 是 ctrl，逻辑帧从 header[1] 开始。
 */
static void reject_oversized(const struct os_mbuf *om, uint16_t mbuf_len)
{
    uint8_t raw[5] = {0};
    uint16_t copied = 0;
    int rc = ble_hs_mbuf_to_flat(om, raw, sizeof(raw), &copied);
    /* 需要 5 字节才能拿全 ctrl + magic + version + command + seq。 */
    if (rc != 0 || copied < sizeof(raw)) {
        ESP_LOGW(TAG, "超长分片 %u 字节且读不到 header，静默丢弃", mbuf_len);
        return;
    }

    /* raw[0] 是 ctrl；逻辑帧 header 从 raw[1] 开始。 */
    uint8_t result = LUMEN_RESULT_BAD_LENGTH;
    if (raw[1] != LUMEN_MAGIC) {
        result = LUMEN_RESULT_BAD_MAGIC;
    } else if (raw[2] != LUMEN_VERSION) {
        result = LUMEN_RESULT_UNSUPPORTED_VERSION;
    }
    ESP_LOGW(TAG, "RX 分片 %u 字节，超过重组上限 %d，拒绝 cmd=0x%02X seq=0x%02X result=0x%02X",
             mbuf_len, LUMEN_MAX_FRAME, raw[3], raw[4], result);
    send_ack(raw[4], raw[3], result);
}

/*
 * QueryStrip 0x12 的多帧响应（docs/protocol-v3.md §7.4 / §8）：
 * seg_count 条 SegmentReport(0x83) + 1 条 SegmentListEnd(0x84)，
 * **全部回显同一个 seq**。小程序按命令字区分帧类型，按 SegmentListEnd 收尾。
 *
 * SegmentReport 载荷固定 21 字节，与 §7.1 的 SetSegment 同构：
 *   strip_id, seg_id(真实槽位), start, end, blend, layer0(8), layer1(8)
 *
 * #37：段就是两层结构，layer0 / layer1 / blend 直接编码上报（与持久化记录
 * 的层编码完全一致，用 lumen_layer_encode 而不是在这里手抄一遍字段）。
 */
static void send_strip_reports(uint8_t seq, uint8_t strip_id)
{
    lumen_segment_t segments[LUMEN_MAX_SEGMENTS];
    uint8_t slots[LUMEN_MAX_SEGMENTS];
    uint8_t count = lumen_led_engine_segments(strip_id, segments, slots, LUMEN_MAX_SEGMENTS);
    uint8_t mask = lumen_led_engine_segment_mask(strip_id);

    uint8_t frame[LUMEN_MAX_FRAME];
    uint8_t sent = 0;
    for (uint8_t i = 0; i < count; ++i) {
        const lumen_segment_t *seg = &segments[i];
        /* layer0.type 未知说明段表已被写坏；不回报（权威段表不该出现）。 */
        if (!lumen_effect_type_known(seg->layer[0].type)) {
            continue;
        }
        /* 层编码：type + param[7]，未用字节由 param 原样给出（§7.1 定宽）。 */
        uint8_t layer0[8];
        uint8_t layer1[8];
        lumen_layer_encode(&seg->layer[0], layer0);
        lumen_layer_encode(&seg->layer[1], layer1);

        size_t len = lumen_protocol_encode_segment_report(seq, strip_id, slots[i], seg->start,
                                                          seg->end, seg->blend, layer0, layer1,
                                                          frame, sizeof(frame));
        if (len == 0 || lumen_ble_link_notify(frame, len) != ESP_OK) {
            ESP_LOGW(TAG, "SegmentReport 发送失败 strip=%u seg=%u", strip_id, slots[i]);
            continue;
        }
        ++sent;
    }

    size_t end_len = lumen_protocol_encode_segment_list_end(seq, strip_id, mask, frame,
                                                            sizeof(frame));
    if (end_len == 0 || lumen_ble_link_notify(frame, end_len) != ESP_OK) {
        ESP_LOGW(TAG, "SegmentListEnd 发送失败 strip=%u", strip_id);
    }
    ESP_LOGI(TAG, "QueryStrip strip=%u -> %u SegmentReport + SegmentListEnd mask=0x%02X seq=0x%02X",
             strip_id, sent, mask, seq);
}

/*
 * QueryStripConfig 0x1C → StripConfigReport 0x87（docs/protocol-v3.md §7.4）。
 * 引脚表来自构建期 Kconfig（CONFIG_LUMEN_STRIP_PINS），协议只读。
 * 未分配的记录由编码器写 gpio=0xFF、flags=0。
 */
static void send_strip_config_report(uint8_t seq)
{
    uint8_t gpios[LUMEN_MAX_STRIPS];
    uint16_t pins[LUMEN_MAX_STRIPS];
    uint8_t parsed = lumen_planar_parse_list(CONFIG_LUMEN_STRIP_PINS, pins, LUMEN_MAX_STRIPS);
    for (uint8_t i = 0; i < LUMEN_MAX_STRIPS; ++i) {
        /* 解析失败 / 越界时按 0xFF 报「未分配」，不猜引脚。 */
        gpios[i] = (i < parsed && pins[i] <= 0xFF) ? (uint8_t)pins[i] : 0xFF;
    }
    /* 已分配的条数以 State 的 strip_count 为准（引脚表来自构建期，可能更长）。 */
    lumen_state_t state;
    lumen_led_engine_snapshot(&state);
    uint8_t frame[LUMEN_MAX_FRAME];
    size_t len = lumen_protocol_encode_strip_config_report(seq, gpios, state.strip_count,
                                                           frame, sizeof(frame));
    if (len == 0 || lumen_ble_link_notify(frame, len) != ESP_OK) {
        ESP_LOGW(TAG, "StripConfigReport 发送失败 seq=0x%02X", seq);
        return;
    }
    ESP_LOGI(TAG, "QueryStripConfig -> %u 条已分配 seq=0x%02X", state.strip_count, seq);
}

/*
 * QueryDeviceInfo 0x1D → DeviceInfoReport 0x88（docs/protocol-v3.md §7.4）。
 *
 * hw_id 是 6 字节 BT MAC，按 "AA:BB:CC:DD:EE:FF" 的自然顺序——esp_read_mac
 * 给出的就是这个顺序，直接抄，不要按小端翻转（那是数值字段的规则）。
 * caps：bit0 = 支持两层叠加（v3 的段载荷已经是定宽两层）；
 *       bit1 = fade 已实现 —— #39 才接行为，这里保持 0。
 */
static void send_device_info_report(uint8_t seq)
{
    uint8_t mac[6] = {0};
    if (esp_read_mac(mac, ESP_MAC_BT) != ESP_OK) {
        ESP_LOGW(TAG, "读蓝牙 MAC 失败，hw_id 报全 0");
        memset(mac, 0, sizeof(mac));
    }
    uint8_t frame[LUMEN_MAX_FRAME];
    size_t len = lumen_protocol_encode_device_info_report(seq, LUMEN_FIRMWARE_VERSION, mac,
                                                          LUMEN_CAP_TWO_LAYERS, frame,
                                                          sizeof(frame));
    if (len == 0 || lumen_ble_link_notify(frame, len) != ESP_OK) {
        ESP_LOGW(TAG, "DeviceInfoReport 发送失败 seq=0x%02X", seq);
        return;
    }
    ESP_LOGI(TAG, "QueryDeviceInfo -> v%u.%u hw_id=%02X:%02X:%02X:%02X:%02X:%02X seq=0x%02X",
             LUMEN_FIRMWARE_VERSION >> 8, LUMEN_FIRMWARE_VERSION & 0xFF, mac[0], mac[1], mac[2],
             mac[3], mac[4], mac[5], seq);
}

/*
 * ScriptProgress 0x86：每接受 8 帧 ScriptSegment 补一条（docs/protocol.md §10.4）。
 *
 * 「每 8 帧」是设备侧补充证据；权威进度是小程序自己数的逐帧 ACK。
 * 每帧都发会把 BLE 带宽吃掉（下发一帧本身就 20 字节），所以按 8 帧节流。
 */
static void send_script_progress(uint8_t seq, uint8_t script_id, uint16_t frames_written)
{
    uint8_t frame[LUMEN_MAX_FRAME];
    size_t len = lumen_protocol_encode_script_progress(seq, script_id, frames_written, frame,
                                                       sizeof(frame));
    if (len == 0 || lumen_ble_link_notify(frame, len) != ESP_OK) {
        ESP_LOGW(TAG, "ScriptProgress 发送失败 id=%u frames=%u", script_id, frames_written);
    }
}

/* QueryScript 0x1A → ScriptSummary 0x85（回显请求 seq）。 */
static void send_script_summary(uint8_t seq, uint8_t script_id)
{
    uint8_t stage_count = 0;
    uint8_t flags = 0;
    if (!lumen_led_engine_script_summary(script_id, &stage_count, &flags)) {
        /* 未提交的剧本：回 stage_count 0、flags 0、active 0，让 UI 明确显示「没有」。 */
        ESP_LOGI(TAG, "QueryScript id=%u -> 未提交", script_id);
        stage_count = 0;
        flags = 0;
    }
    uint8_t active = (uint8_t)((flags & 0x02u) != 0 ? 1 : 0);
    uint8_t frame[LUMEN_MAX_FRAME];
    size_t len = lumen_protocol_encode_script_summary(seq, script_id, stage_count,
                                                      (uint8_t)(flags & 0x01u), active, frame,
                                                      sizeof(frame));
    if (len == 0 || lumen_ble_link_notify(frame, len) != ESP_OK) {
        ESP_LOGW(TAG, "ScriptSummary 发送失败 id=%u", script_id);
        return;
    }
    ESP_LOGI(TAG, "QueryScript id=%u -> stages=%u flags=0x%02X active=%u seq=0x%02X", script_id,
             stage_count, flags, active, seq);
}

/*
 * 处理一条完整写到 RX 的帧：
 *   解码（§10.2 magic→version→length→checksum）
 *   → 命令分发（§10.2 command→payload 长度→payload 取值）
 *   → 写入共享状态（RAM）
 *   → 发渲染信号（lumen_led_engine_commit 内部完成，渲染异步）
 *   → 回 ACK（协议 §10.1：写入 RAM 后立刻回）
 *
 * 渲染任务与 NVS 写入都不在本回调里发生。命令层是纯函数，状态写入是 O(1)
 * 邮箱操作，不阻塞 NimBLE 主机任务。
 */
static void handle_frame(const uint8_t *data, size_t len)
{
    lumen_frame_t frame;
    uint8_t result_code = 0xFF;
    lumen_decode_status_t status = lumen_protocol_decode(data, len, &frame, &result_code);

    switch (status) {
    case LUMEN_DECODE_OK:
        break;
    case LUMEN_DECODE_SILENT:
        /* 不足 6 字节：读不出可靠的 seq，按协议静默丢弃。 */
        ESP_LOGW(TAG, "帧不足 %d 字节，静默丢弃", LUMEN_FRAME_OVERHEAD);
        return;
    default:
        /* 坏 magic / version / length / checksum：尽力回显 header，不执行命令。 */
        ESP_LOGW(TAG, "帧校验失败 cmd=0x%02X seq=0x%02X result=0x%02X", frame.command,
                 frame.seq, result_code);
        send_ack(frame.seq, frame.command, result_code);
        return;
    }

    lumen_state_t current;
    lumen_led_engine_snapshot(&current);

    /*
     * 段配置快照只给段命令用：0x10 / 0x11 / 0x12。
     * 1.5KB 拷贝（#37 两层结构：8×8×24）放在栈上会吃掉主机任务的栈余量，
     * 所以用静态缓冲——RX 回调在 NimBLE 主机任务里串行执行，不存在并发进入。
     */
    static lumen_segment_store_t s_segment_scratch;
    const lumen_segment_store_t *segments = NULL;
    switch (frame.command) {
    case LUMEN_CMD_SET_SEGMENT:
    case LUMEN_CMD_CLEAR_SEGMENT:
    case LUMEN_CMD_QUERY_STRIP:
        lumen_led_engine_segments_snapshot(&s_segment_scratch);
        segments = &s_segment_scratch;
        break;
    default:
        break;
    }

    lumen_command_outcome_t outcome;
    /* max_brightness 取构建期常量：SetBrightness 在这里被钳位，而不是拒绝。 */
    /* #29：段区间必须按「这条灯带自己」的灯珠数校验，不能一律用 strip 0 的。 */
    uint16_t strip_counts[LUMEN_MAX_STRIPS];
    lumen_led_engine_strip_counts(strip_counts);
    lumen_command_dispatch(&frame, &current, segments, strip_counts,
                           lumen_led_engine_max_brightness(), &outcome);

    /*
     * 段配置写入 / 清除（#25）。命令层已完成 §11.3 第 4-9 步校验，
     * 引擎在锁内做最终写入并重算 State 摘要（seg_count 与 seg 0 基准色）。
     * 引擎的最终结果码是权威（可能因为期间状态变化而被再拒一次）。
     */
    if (outcome.segment_op && outcome.result_code == LUMEN_RESULT_OK) {
        if (outcome.segment_clear) {
            outcome.result_code = lumen_led_engine_clear_segment(
                outcome.segment_strip, outcome.segment_id, frame.command);
        } else {
            outcome.result_code = lumen_led_engine_set_segment(
                outcome.segment_strip, outcome.segment_id, &outcome.segment, frame.command);
        }
    }

    /*
     * #32 剧本命令（0x13–0x1A）。命令层只做形状校验，暂存 / 提交 / 激活在引擎
     * 的锁内执行。引擎的返回码是权威：它可能因为「没有对应的 Begin」「未提交」
     * 等上下文原因再拒一次。
     *
     * ScriptCommit 失败额外补一条 Event 0x02（detail = script_id）：ACK 里只有
     * 结果码 0x01，小程序分不清是哪个剧本、哪种校验失败。
     */
    if (outcome.script_op != LUMEN_SCRIPT_OP_NONE && outcome.result_code == LUMEN_RESULT_OK) {
        switch (outcome.script_op) {
        case LUMEN_SCRIPT_OP_PLAYBACK:
            outcome.result_code =
                lumen_led_engine_set_playback(outcome.script_action, outcome.script_loop);
            break;
        case LUMEN_SCRIPT_OP_BEGIN:
            outcome.result_code = lumen_led_engine_script_begin(
                outcome.script_id, outcome.script_stage_count, outcome.script_strip_count);
            break;
        case LUMEN_SCRIPT_OP_STAGE:
            outcome.result_code = lumen_led_engine_script_stage(
                outcome.script_id, outcome.script_stage_index, outcome.script_duration_ms);
            break;
        case LUMEN_SCRIPT_OP_SEGMENT: {
            uint16_t written = 0;
            outcome.result_code = lumen_led_engine_script_segment(
                outcome.script_id, outcome.script_stage_index, outcome.script_strip,
                outcome.script_seg, &outcome.script_segment, &written);
            if (outcome.result_code == LUMEN_RESULT_OK) {
                /*
                 * 进度：每接受 8 帧补一条 0x86（§10.4）。第 8、16、24… 帧各发一次，
                 * 回显这次下发请求的 seq。
                 */
                if (written > 0 && (written % 8u) == 0u) {
                    send_script_progress(frame.seq, outcome.script_id, written);
                }
            }
            break;
        }
        case LUMEN_SCRIPT_OP_COMMIT:
            outcome.result_code = lumen_led_engine_script_commit(outcome.script_id);
            if (outcome.result_code != LUMEN_RESULT_OK) {
                send_event(LUMEN_EVENT_SCRIPT_COMMIT_FAILED, outcome.script_id);
            }
            break;
        case LUMEN_SCRIPT_OP_ABORT:
            outcome.result_code = lumen_led_engine_script_abort(outcome.script_id);
            break;
        case LUMEN_SCRIPT_OP_ACTIVATE:
            outcome.result_code =
                lumen_led_engine_activate_script(outcome.script_id, outcome.script_loop);
            break;
        case LUMEN_SCRIPT_OP_QUERY:
            /* 查询不改状态；ACK 之后补 ScriptSummary（与 QueryStrip 同一模式）。 */
            outcome.result_code = LUMEN_RESULT_OK;
            break;
        default:
            break;
        }
    }

    /*
     * SetStripPower 0x1B（docs/protocol-v3.md §9.5）。命令层已校验 strip 已分配
     * 且 on ∈ {0,1}。这里只更新 State 的 strip_power_mask，让小程序立刻能通过
     * State 观察到结果；**渲染门控、推黑帧与 TDM 跳带属于 #38**，所以本次不
     * 依赖画面行为，也不额外唤醒渲染任务。
     */
    if (outcome.strip_power_op && outcome.result_code == LUMEN_RESULT_OK) {
        uint8_t bit = (uint8_t)(1u << outcome.strip_power_strip);
        uint8_t mask = outcome.next.strip_power_mask;
        mask = outcome.strip_power_on ? (uint8_t)(mask | bit)
                                      : (uint8_t)(mask & (uint8_t)~bit);
        if (mask != current.strip_power_mask) {
            outcome.next.strip_power_mask = mask;
            outcome.state_changed = true;
        }
    }

    /*
     * 自检控制（协议 §9.7），必须在写共享状态之前处理：
     *  - 改变状态的命令先取消自检，再 commit，渲染任务不会闪回自检色；
     *  - SelfTest 只启动覆盖，不改状态（state_changed 恒为 false）。
     * 记录「是否真的取消了」，否则每条 SetXxx 都会打出 selftest=cancel，
     * 排查时会误以为自检被打断过。
     *
     * SetLedCount 例外：reducer 只标记「需要重建」，真正的成败在引擎里
     * （重建中再请求会回 Busy）。Busy 意味着新命令**没有**被应用，按 §11.2
     * 第 5 条的语义不该取消自检——所以它的取消延后到 set_led_count 的结果。
     */
    bool cancelled_selftest = false;
    if (outcome.cancels_selftest && !outcome.led_count_rebuild) {
        cancelled_selftest = lumen_led_engine_cancel_selftest();
    }
    if (outcome.start_selftest) {
        lumen_led_engine_start_selftest();
    }

    if (outcome.state_changed) {
        /* 写入 RAM + 发渲染信号 + 请求 debounce 持久化；本回调不刷灯、不写 NVS。 */
        lumen_led_engine_commit(&outcome.next, frame.command);
    }

    /*
     * 每帧一行、字段固定：command / seq / len / result 是两端 seq 对齐的
     * 主线索；power/brightness/rgb 是命令生效后的存储状态（自检期间也仍是
     * 存储状态，不是自检颜色——§11.2 第 6 条）。
     *
     * selftest=start/cancel/on 是 §11.2 的串口证据：
     *   start  = 这条命令启动了自检；
     *   cancel = 这条命令确实打断了进行中的自检（没在自检时不会出现）；
     *   on     = 命令处理完后自检仍在跑，即这条命令没有取消自检
     *            （QueryState 期间出现 on 就证明查询不打断自检）。
     */
    const char *selftest_note = "";
    if (outcome.start_selftest) {
        selftest_note = " selftest=start";
    } else if (cancelled_selftest) {
        selftest_note = " selftest=cancel";
    } else if (lumen_led_engine_selftest_active()) {
        selftest_note = " selftest=on";
    }
    /* 每帧只打一行：命令字 / seq / 结果码 / 关键状态。 */
    ESP_LOGI(TAG,
             "RX cmd=0x%02X seq=0x%02X len=%u result=0x%02X power=%u brightness=%u "
             "rgb=%u,%u,%u segs=%u%s%s",
             frame.command, frame.seq, frame.payload_len, outcome.result_code,
             outcome.next.power, outcome.next.brightness, outcome.next.r, outcome.next.g,
             outcome.next.b, outcome.next.seg_count, outcome.state_changed ? " changed" : "",
             selftest_note);

    if (outcome.led_count_rebuild) {
        /*
         * SetLedCount（协议 §10.1 例外 / §11.3）：ACK 必须等句柄重建结果。
         * 这里只登记请求 —— 引擎判忙 / 判相同值，真正的 create/del 在渲染任务，
         * 结果由引擎经 response 回调发 ACK。
         *
         * 上面那行的 result 是 reducer 的判定（0x00 = 取值合法），不是最终结果：
         * 真正的 ACK 可能是 0x09（重建失败）或 0x05（忙），由 send_ack 再打一行。
         */
        uint8_t status = lumen_led_engine_set_led_count_for_strip(outcome.led_count_strip,
                                                                outcome.led_count, frame.seq);
        if (status == LUMEN_LED_ENGINE_DEFERRED) {
            /* 已被接受（或数量未变）：现在才取消自检，与「新命令生效」同时。
             * 取消要在登记之后，否则重建期间的渲染会先闪回存储色。 */
            if (outcome.cancels_selftest) {
                lumen_led_engine_cancel_selftest();
            }
            return; /* ACK 由渲染任务在重建完成后发 */
        }
        if (status == LUMEN_RESULT_OK && outcome.cancels_selftest) {
            lumen_led_engine_cancel_selftest();
        }
        /* OK（数量未变）或 Busy：可以立即回。Busy 不取消自检。 */
        send_ack(frame.seq, frame.command, status);
        return;
    }

    /* ACK 在写入 RAM 之后立刻发；不等待渲染完成。 */
    send_ack(frame.seq, frame.command, outcome.result_code);

    /* §6.1：查询状态在 ACK 之后紧跟一条 StateReport，载荷布局与 State read 相同。 */
    if (outcome.state_report) {
        uint8_t state[LUMEN_STATE_BYTES];
        lumen_led_engine_state_bytes(state);
        uint8_t buf[LUMEN_MAX_FRAME];
        size_t len = lumen_protocol_encode_state_report(frame.seq, state, buf, sizeof(buf));
        if (len == 0 || lumen_ble_link_notify(buf, len) != ESP_OK) {
            ESP_LOGW(TAG, "StateReport 发送失败 seq=0x%02X", frame.seq);
        }
    }

    /* QueryStrip：seg_count 条 SegmentReport + 1 条 SegmentListEnd，同 seq（§8）。 */
    if (outcome.strip_query) {
        send_strip_reports(frame.seq, outcome.query_strip_id);
    }

    /* QueryStripConfig 0x1C：ACK 之后一条 StripConfigReport 0x87（§8）。 */
    if (outcome.strip_config_query) {
        send_strip_config_report(frame.seq);
    }

    /* QueryDeviceInfo 0x1D：ACK 之后一条 DeviceInfoReport 0x88（§8）。 */
    if (outcome.device_info_query) {
        send_device_info_report(frame.seq);
    }

    /* QueryScript：ACK 之后一条 ScriptSummary 0x85（§10.1 第 3 步）。 */
    if (outcome.script_op == LUMEN_SCRIPT_OP_QUERY &&
        outcome.result_code == LUMEN_RESULT_OK) {
        send_script_summary(frame.seq, outcome.script_id);
    }
}

/*
 * 收下一个分片并驱动重组（docs/protocol-v3.md §3.2）。
 *
 * 三种结果：
 *   COMPLETE → 把拼好的逻辑帧交给 handle_frame（§3.1 解析、§5 结果码）；
 *   OVERFLOW → 累计超过 240，回 BadLength（规则 2）；
 *   PENDING / IGNORED → 什么都不做（IGNORED 是无头分片，静默丢弃）。
 *
 * 超时（规则 4）不在这里判：1000ms 是「自上一个分片起」算的，由
 * lumen_reasm_feed 在下一次到达时就地清掉过期缓冲，1Hz 的 esp_timer 另做兜底。
 */
static void handle_chunk(uint8_t ctrl, const uint8_t *data, size_t len, uint32_t now_ms)
{
    lumen_reasm_status_t status;
    uint16_t frame_len;
    uint8_t header[4] = {0};
    bool have_header;

    /*
     * 一次临界区里完成「喂入 + 取走结果」：重组缓冲是唯一的跨上下文状态，
     * 中间不能让 esp_timer 的超时清理插进来。拷贝 240 字节是 O(1) 的静态区
     * 操作，不会把主机任务拖住。
     */
    taskENTER_CRITICAL(&s_reasm_mux);
    status = lumen_reasm_feed(&s_reasm, ctrl, data, len, now_ms);
    frame_len = s_reasm.len;
    have_header = s_reasm.have_header;
    memcpy(header, s_reasm.first_header, sizeof(header));
    if (status == LUMEN_REASM_COMPLETE) {
        /* 只有 COMPLETE 才拷整帧；其余分支只用 header。 */
        memcpy(s_chunk_frame, s_reasm.data, frame_len);
    }
    taskEXIT_CRITICAL(&s_reasm_mux);

    switch (status) {
    case LUMEN_REASM_COMPLETE:
        handle_frame(s_chunk_frame, frame_len);
        break;
    case LUMEN_REASM_OVERFLOW:
        /*
         * §3.2 规则 2：累计超过 240 → 丢弃缓冲并回 BadLength。缓冲已丢弃，
         * 但首片的 header 还留着，可以直接回显 seq / 命令字（不用猜）。
         */
        ESP_LOGW(TAG, "分片重组超过 %d 字节，丢弃并回 BadLength", LUMEN_MAX_FRAME);
        send_ack(have_header ? header[3] : 0x00, have_header ? header[2] : 0x00,
                 LUMEN_RESULT_BAD_LENGTH);
        break;
    case LUMEN_REASM_IGNORED:
        ESP_LOGW(TAG, "收到无 FIRST 的分片 ctrl=0x%02X，静默丢弃", ctrl);
        break;
    case LUMEN_REASM_PENDING:
    default:
        break;
    }
}

static int rx_access(uint16_t conn_handle, uint16_t attr_handle,
                     struct ble_gatt_access_ctxt *ctxt, void *arg)
{
    (void)attr_handle;
    (void)arg;
    (void)conn_handle;

    if (ctxt->op != BLE_GATT_ACCESS_OP_WRITE_CHR) {
        return BLE_ATT_ERR_UNLIKELY;
    }

    uint16_t mbuf_len = OS_MBUF_PKTLEN(ctxt->om);
    /* 单次写最多 chunk_capacity = min(mtu-3, 180)，超过就是协议违规（§2.1）。 */
    uint16_t mtu = s_mtu != 0 ? s_mtu : LUMEN_DEFAULT_MTU;
    uint16_t max_write = (uint16_t)(mtu - 3);
    if (max_write > LUMEN_MAX_CHUNK_CAPACITY) {
        max_write = LUMEN_MAX_CHUNK_CAPACITY;
    }
    if (mbuf_len == 0) {
        return 0;
    }
    if (mbuf_len > max_write || mbuf_len > LUMEN_RX_BUF_SIZE) {
        reject_oversized(ctxt->om, mbuf_len);
        return 0;
    }

    uint8_t buf[LUMEN_RX_BUF_SIZE];
    uint16_t len = 0;
    int rc = ble_hs_mbuf_to_flat(ctxt->om, buf, sizeof(buf), &len);
    if (rc != 0) {
        ESP_LOGW(TAG, "mbuf flatten failed rc=%d", rc);
        return BLE_ATT_ERR_UNLIKELY;
    }

    /* 压力模式：#7 要求每次写入都带时间戳，用于和高频刷新做时间对齐。 */
    lumen_stress_note_ble_write(len);

    /*
     * 帧内容日志级别是 DEBUG：20Hz 拖动时每帧 4 行串口输出会占掉主机任务
     * 近一半时间（115200 下约 220 字节 / 19-23ms），直接表现为拖动卡顿与 10008。
     * 产品路径只在 handle_frame 里打一行 RX 汇总；需要看原始字节时把日志级别
     * 调到 DEBUG（idf.py menuconfig → Log output → Default log verbosity）。
     */
    if (esp_log_level_get(TAG) >= ESP_LOG_DEBUG) {
        ESP_LOGD(TAG, "RX 收到分片 %u 字节", len);
        if (len > 0 && len <= LUMEN_RX_BUF_SIZE) {
            ESP_LOG_BUFFER_HEX_LEVEL(TAG, buf, len, ESP_LOG_DEBUG);
        }
    }

    /*
     * §3.2：第一个字节是分片头，其余是本逻辑帧的切片。完整帧（含 CRC）由
     * 重组器拼出来之后才进 handle_frame。
     */
    uint8_t ctrl = buf[0];
    handle_chunk(ctrl, &buf[1], (size_t)(len - 1), (uint32_t)(esp_timer_get_time() / 1000));
    return 0;
}

static int tx_access(uint16_t conn_handle, uint16_t attr_handle,
                     struct ble_gatt_access_ctxt *ctxt, void *arg)
{
    (void)conn_handle;
    (void)attr_handle;
    (void)ctxt;
    (void)arg;
    /* TX 只用于 notify，不开放 read / write。 */
    return BLE_ATT_ERR_UNLIKELY;
}

static int state_access(uint16_t conn_handle, uint16_t attr_handle,
                        struct ble_gatt_access_ctxt *ctxt, void *arg)
{
    (void)conn_handle;
    (void)attr_handle;
    (void)arg;

    if (ctxt->op != BLE_GATT_ACCESS_OP_READ_CHR) {
        return BLE_ATT_ERR_UNLIKELY;
    }

    /*
     * 只是拷贝一份 37 字节 RAM 快照，短时间持锁，不触发渲染。
     *
     * 注意：State 特征值的 read **不带分片头**（§3.2 只约束 write / notify）。
     * MTU 小于 38 时 ATT 层会走 Read Blob 分段，由协议栈自动处理；小程序侧
     * 的读取逻辑必须按「长读」把两段拼起来。
     */
    uint8_t state[LUMEN_STATE_BYTES];
    lumen_led_engine_state_bytes(state);
    int rc = os_mbuf_append(ctxt->om, state, sizeof(state));
    return rc == 0 ? 0 : BLE_ATT_ERR_INSUFFICIENT_RES;
}

static const struct ble_gatt_chr_def s_characteristics[] = {
    {
        .uuid = &s_rx_uuid.u,
        .access_cb = rx_access,
        /* 协议规定小程序 → 设备走 write-no-response。 */
        .flags = BLE_GATT_CHR_F_WRITE_NO_RSP,
    },
    {
        .uuid = &s_tx_uuid.u,
        .access_cb = tx_access,
        .flags = BLE_GATT_CHR_F_NOTIFY,
        .val_handle = &s_tx_val_handle,
    },
    {
        .uuid = &s_state_uuid.u,
        .access_cb = state_access,
        .flags = BLE_GATT_CHR_F_READ,
    },
    {0},
};

static const struct ble_gatt_svc_def s_services[] = {
    {
        .type = BLE_GATT_SVC_TYPE_PRIMARY,
        .uuid = &s_svc_uuid.u,
        .characteristics = s_characteristics,
    },
    {0},
};

static void derive_device_name(void)
{
    uint8_t mac[6] = {0};
    if (esp_read_mac(mac, ESP_MAC_BT) == ESP_OK) {
        snprintf(s_device_name, sizeof(s_device_name), "Lumen-%02X%02X", mac[4], mac[5]);
    } else {
        ESP_LOGW(TAG, "读蓝牙 MAC 失败，使用默认名 %s", s_device_name);
    }
}

static void advertise(void)
{
    struct ble_hs_adv_fields fields = {0};
    fields.flags = BLE_HS_ADV_F_DISC_GEN | BLE_HS_ADV_F_BREDR_UNSUP;
    /* 广播包里带 128-bit Service UUID，小程序按它过滤设备。 */
    fields.uuids128 = &s_svc_uuid;
    fields.num_uuids128 = 1;
    fields.uuids128_is_complete = 1;

    int rc = ble_gap_adv_set_fields(&fields);
    if (rc != 0) {
        ESP_LOGE(TAG, "adv fields failed rc=%d", rc);
        return;
    }

    /* 扫描响应包里放完整本地名 Lumen-XXXX。 */
    const char *name = ble_svc_gap_device_name();
    struct ble_hs_adv_fields rsp = {0};
    rsp.name = (const uint8_t *)name;
    rsp.name_len = (uint8_t)strlen(name);
    rsp.name_is_complete = 1;

    rc = ble_gap_adv_rsp_set_fields(&rsp);
    if (rc != 0) {
        ESP_LOGE(TAG, "scan rsp failed rc=%d", rc);
        return;
    }

    struct ble_gap_adv_params params = {0};
    params.conn_mode = BLE_GAP_CONN_MODE_UND;
    params.disc_mode = BLE_GAP_DISC_MODE_GEN;

    rc = ble_gap_adv_start(s_own_addr_type, NULL, BLE_HS_FOREVER, &params, gap_event, NULL);
    if (rc != 0 && rc != BLE_HS_EALREADY) {
        ESP_LOGE(TAG, "adv start failed rc=%d", rc);
    } else {
        ESP_LOGI(TAG, "开始广播（%s），等连接", s_device_name);
    }
}

static void request_fast_conn_params(uint16_t conn_handle)
{
    /* 15-30ms、latency 0：拖动跟手优先，不追求省电。超时 4s。 */
    struct ble_gap_upd_params params = {
        .itvl_min = BLE_GAP_CONN_ITVL_MS(15),
        .itvl_max = BLE_GAP_CONN_ITVL_MS(30),
        .latency = 0,
        .supervision_timeout = 400,
        .min_ce_len = 0,
        .max_ce_len = 0,
    };
    int rc = ble_gap_update_params(conn_handle, &params);
    if (rc != 0) {
        ESP_LOGW(TAG, "conn params request failed rc=%d（继续用对端参数）", rc);
    }
}

static int gap_event(struct ble_gap_event *event, void *arg)
{
    (void)arg;
    struct ble_gap_conn_desc desc;

    switch (event->type) {
    case BLE_GAP_EVENT_CONNECT:
        if (event->connect.status != 0) {
            ESP_LOGW(TAG, "connect failed status=%d", event->connect.status);
            s_conn_handle = BLE_HS_CONN_HANDLE_NONE;
            advertise();
            return 0;
        }

        /* 单连接：理论上不会走到这里，仍显式踢掉残留旧句柄。 */
        if (s_conn_handle != BLE_HS_CONN_HANDLE_NONE) {
            ESP_LOGW(TAG, "发现残留连接 0x%04X，断开旧连接", s_conn_handle);
            ble_gap_terminate(s_conn_handle, BLE_ERR_REM_USER_CONN_TERM);
        }

        s_conn_handle = event->connect.conn_handle;
        /* 新连接：上一连接的半截重组缓冲必须丢掉，否则会把新连接的分片接在旧数据后面。 */
        taskENTER_CRITICAL(&s_reasm_mux);
        (void)lumen_reasm_reset(&s_reasm);
        taskEXIT_CRITICAL(&s_reasm_mux);
        /* MTU 在 CONNECT 之后由内核按协商结果给出；未知时按 23 处理（§2.1）。 */
        s_mtu = ble_att_mtu(s_conn_handle);
        lumen_stress_note_ble_connect(s_conn_handle);
        if (ble_gap_conn_find(s_conn_handle, &desc) == 0) {
            ESP_LOGI(TAG, "connected handle=0x%04X itvl=%d latency=%d timeout=%d",
                     s_conn_handle, desc.conn_itvl, desc.conn_latency,
                     desc.supervision_timeout);
        }
        ESP_LOGI(TAG, "mtu=%d chunk_data=%u", s_mtu, chunk_data_capacity());
        request_fast_conn_params(s_conn_handle);
        return 0;

    case BLE_GAP_EVENT_DISCONNECT:
        ESP_LOGI(TAG, "disconnected handle=0x%04X reason=%d",
                 event->disconnect.conn.conn_handle, event->disconnect.reason);
        lumen_stress_note_ble_disconnect(event->disconnect.conn.conn_handle,
                                         event->disconnect.reason);
        /* 只清理当前连接句柄；旧连接的延迟 DISCONNECT 不能误伤新连接。 */
        if (s_conn_handle == event->disconnect.conn.conn_handle) {
            s_conn_handle = BLE_HS_CONN_HANDLE_NONE;
            s_mtu = 0; /* 回到「未知」，下一个连接重新协商 */
            taskENTER_CRITICAL(&s_reasm_mux);
            (void)lumen_reasm_reset(&s_reasm);
            taskEXIT_CRITICAL(&s_reasm_mux);
            /* 释放连接句柄后重新广播，等待下一个 central。 */
            advertise();
        }
        return 0;

    case BLE_GAP_EVENT_ADV_COMPLETE:
        advertise();
        return 0;

    case BLE_GAP_EVENT_MTU:
        ESP_LOGI(TAG, "mtu updated=%d chunk_data=%u", event->mtu.value,
                 (uint16_t)(event->mtu.value > 3 ? event->mtu.value - 4 : 0));
        if (event->mtu.conn_handle == s_conn_handle || s_conn_handle == BLE_HS_CONN_HANDLE_NONE) {
            s_mtu = event->mtu.value;
        }
        lumen_stress_note_ble_mtu(event->mtu.value);
        return 0;

    case BLE_GAP_EVENT_CONN_UPDATE:
        if (ble_gap_conn_find(event->conn_update.conn_handle, &desc) == 0) {
            ESP_LOGI(TAG, "conn updated itvl=%d latency=%d timeout=%d", desc.conn_itvl,
                     desc.conn_latency, desc.supervision_timeout);
        }
        return 0;

    case BLE_GAP_EVENT_SUBSCRIBE:
        if (event->subscribe.attr_handle == s_tx_val_handle) {
            ESP_LOGI(TAG, "TX notify %s", event->subscribe.cur_notify ? "enabled" : "disabled");
        }
        return 0;

    default:
        return 0;
    }
}

static void on_sync(void)
{
    int rc = ble_hs_util_ensure_addr(0);
    if (rc != 0) {
        ESP_LOGE(TAG, "ensure addr failed rc=%d", rc);
        return;
    }
    rc = ble_hs_id_infer_auto(0, &s_own_addr_type);
    if (rc != 0) {
        ESP_LOGE(TAG, "infer addr failed rc=%d", rc);
        return;
    }
    advertise();
}

static void on_reset(int reason)
{
    ESP_LOGW(TAG, "host reset reason=%d", reason);
}

static void host_task(void *param)
{
    (void)param;
    ESP_LOGI(TAG, "BLE host task started");
    nimble_port_run();
    nimble_port_freertos_deinit();
}

esp_err_t lumen_ble_link_init(void)
{
    /*
     * 两条异步回执通道先接上（都在 notify 可用之前注册，避免丢第一帧）：
     *   1. 引擎在渲染任务里回 SetLedCount 的延迟 ACK；
     *   2. 存储任务在 NVS 写失败时发 Event 0x81。
     */
    lumen_led_engine_set_response_cb(engine_response);
    lumen_state_store_set_event_cb(on_store_failed);

    lumen_reasm_init(&s_reasm);
    s_mtu = 0;

    esp_err_t err = nimble_port_init();
    if (err != ESP_OK) {
        return err;
    }

    /*
     * 偏好 MTU 247（docs/protocol-v3.md §2.1）：chunk_capacity 因此能到
     * min(247-3, 180) = 180。必须在主机任务启动前设置，协商结果以对端为准；
     * 对端不配合时 s_mtu 会停在 23，所有路径按 20 字节写 / 19 字节数据兜底。
     */
    int mtu_rc = ble_att_set_preferred_mtu(247);
    if (mtu_rc != 0) {
        ESP_LOGW(TAG, "设置偏好 MTU 247 失败 rc=%d，按默认 23 兜底", mtu_rc);
    }

    /* 分片超时的兜底清理：1 秒一次，与 1000ms 超时同量级（§3.2 规则 4）。 */
    const esp_timer_create_args_t timer_args = {
        .callback = reasm_timeout_cb,
        .arg = NULL,
        .name = "lumen_reasm",
    };
    esp_err_t timer_err = esp_timer_create(&timer_args, &s_reasm_timer);
    if (timer_err == ESP_OK) {
        timer_err = esp_timer_start_periodic(s_reasm_timer, LUMEN_REASM_TIMEOUT_MS * 1000ull);
    }
    if (timer_err != ESP_OK) {
        ESP_LOGW(TAG, "分片超时定时器启动失败: %s", esp_err_to_name(timer_err));
        s_reasm_timer = NULL;
    }

    ble_hs_cfg.reset_cb = on_reset;
    ble_hs_cfg.sync_cb = on_sync;

    ble_svc_gap_init();
    ble_svc_gatt_init();

    derive_device_name();
    int rc = ble_svc_gap_device_name_set(s_device_name);
    if (rc != 0) {
        ESP_LOGE(TAG, "set device name failed rc=%d", rc);
        return ESP_FAIL;
    }

    rc = ble_gatts_count_cfg(s_services);
    if (rc != 0) {
        ESP_LOGE(TAG, "gatts count failed rc=%d", rc);
        return ESP_FAIL;
    }
    rc = ble_gatts_add_svcs(s_services);
    if (rc != 0) {
        ESP_LOGE(TAG, "gatts add svcs failed rc=%d", rc);
        return ESP_FAIL;
    }
    ESP_LOGI(TAG, "GATT 服务已注册（Service 6c756d65-...-0001，RX/TX/State）");

    nimble_port_freertos_init(host_task);
    return ESP_OK;
}

bool lumen_ble_link_is_connected(void)
{
    return s_conn_handle != BLE_HS_CONN_HANDLE_NONE;
}

esp_err_t lumen_ble_link_notify(const uint8_t *data, size_t len)
{
    if (data == NULL || len == 0 || len > LUMEN_MAX_FRAME) {
        return ESP_ERR_INVALID_ARG;
    }
    uint16_t conn_handle = s_conn_handle;
    if (conn_handle == BLE_HS_CONN_HANDLE_NONE) {
        return ESP_ERR_INVALID_STATE;
    }

    /*
     * 设备 → 小程序同样按 §3.2 分片：每个 notify 都带 1 字节 ctrl 头，
     * 单分片时 ctrl = 0xC0。不允许裸帧——否则 0xA6 会和 FIRST|序号 0x26 冲突。
     *
     * 每个分片一个独立 mbuf：ble_gatts_notify_custom 接管所有权，成功与失败
     * 都由它释放，调用方不得再 os_mbuf_free_chain。
     */
    uint16_t capacity = chunk_data_capacity();
    uint8_t count = lumen_reasm_chunk_count(len, (uint8_t)capacity);
    if (count == 0) {
        return ESP_ERR_INVALID_ARG;
    }

    uint8_t chunk[LUMEN_MAX_CHUNK_CAPACITY + 1];
    for (uint8_t i = 0; i < count; ++i) {
        size_t n = lumen_reasm_build_chunk(data, len, (uint8_t)capacity, i, chunk,
                                           sizeof(chunk));
        if (n == 0) {
            return ESP_FAIL;
        }
        struct os_mbuf *om = ble_hs_mbuf_from_flat(chunk, (uint16_t)n);
        if (om == NULL) {
            return ESP_ERR_NO_MEM;
        }
        int rc = ble_gatts_notify_custom(conn_handle, s_tx_val_handle, om);
        if (rc != 0) {
            ESP_LOGW(TAG, "notify failed rc=%d (chunk %u/%u)", rc, i, count);
            return ESP_FAIL;
        }
    }
    return ESP_OK;
}
