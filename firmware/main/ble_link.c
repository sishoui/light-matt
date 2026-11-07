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
#include "strip_power.h"

static const char *TAG = "lumen_ble";

/* 128-bit UUID 在 NimBLE 里按小端存放。唯一真相是 docs/protocol-v5.md §2。
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
 * 单次 BLE 写 / notify 的字节上限（docs/protocol-v5.md §2.1）：
 *   chunk_capacity = min(mtu - 3, 180)，单分片的数据上限再减 1 字节分片头。
 *
 * MTU 未知时按 23 处理（最坏情况），即 20 字节写、19 字节数据。
 * LUMEN_RX_BUF_SIZE 按最大分片容量留足；实际接收也要按 s_mtu 再判一次，
 * 因为对端完全可能用协商后更大的 MTU 写进来。
 */
#define LUMEN_RX_BUF_SIZE (LUMEN_MAX_CHUNK_CAPACITY + 1)
#define LUMEN_DEFAULT_MTU 23

/* 固件版本号现在是 protocol.h 的 LUMEN_FIRMWARE_VERSION（0x0500），
 * 与协议 version 在同一轮升级里同步（docs/protocol-v5.md §4）。 */

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
/* 当前连接的 ATT MTU。0 = 未知（按 23 处理，docs/protocol-v4.md §2.1）。 */
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
 * 未知 MTU（0）按 23 处理 → 20 字节写 → 19 字节数据（docs/protocol-v4.md §2.1）。
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
 * 处理一条完整写到 RX 的分片（docs/protocol-v4.md §3.2）：
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
 * （docs/protocol-v4.md §3.2 规则 2）。分片头之后的前 4 字节仍是逻辑帧 header，
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
 * QueryLayout 0x24 的多帧响应（docs/protocol-v5.md §7.2 / §8）：
 * 逐部位一条 LayoutReport 0x89 + 一条 LayoutListEnd 0x8A，**全部回显同一个 seq**。
 *
 * 只有 seg_count > 0 的部位才会被报出来；part_mask 与报告条数一致。
 * 名字为空串的部位仍然可报（name_len = 0）。
 */
static void send_layout_reports(uint8_t seq, uint8_t strip_id)
{
    /* 布局快照 2696 字节：放静态区，别吃 NimBLE 主机任务的 4KB 栈。 */
    static lumen_layout_store_t layout;
    lumen_led_engine_layout_snapshot(&layout);

    uint8_t frame[LUMEN_MAX_FRAME];
    uint8_t mask = 0;
    uint8_t sent = 0;
    uint8_t parts = layout.part_count[strip_id];
    if (parts > LUMEN_MAX_PARTS) {
        parts = LUMEN_MAX_PARTS;
    }
    for (uint8_t p = 0; p < parts; ++p) {
        const lumen_part_layout_t *part = &layout.part[strip_id][p];
        if (part->segs.seg_count == 0) {
            continue; /* 没有划出灯珠的部位不报（报告条数 = part_mask 位数） */
        }
        size_t len = lumen_protocol_encode_layout_report(
            seq, strip_id, p, part->name_len, part->name, part->segs.seg_count, part->segs.seg,
            frame, sizeof(frame));
        if (len == 0 || lumen_ble_link_notify(frame, len) != ESP_OK) {
            ESP_LOGW(TAG, "LayoutReport 发送失败 strip=%u part=%u", strip_id, p);
            continue;
        }
        mask |= (uint8_t)(1u << p);
        ++sent;
    }

    size_t end_len = lumen_protocol_encode_layout_list_end(seq, strip_id, mask, frame,
                                                           sizeof(frame));
    if (end_len == 0 || lumen_ble_link_notify(frame, end_len) != ESP_OK) {
        ESP_LOGW(TAG, "LayoutListEnd 发送失败 strip=%u", strip_id);
    }
    ESP_LOGI(TAG, "QueryLayout strip=%u -> %u LayoutReport + LayoutListEnd mask=0x%02X seq=0x%02X",
             strip_id, sent, mask, seq);
}

/*
 * QueryScene 0x29 的多帧响应（§6.2 / §8）：逐部位 ScenePartReport 0x8B、
 * 逐步骤 SceneStepReport 0x8C、一条 SceneListEnd 0x8D，全部回显同一个 seq。
 *
 * 只报 step_count > 0 的部位（0 步 = 本场景不演，S10），与下发时的形状对称。
 * 场景快照 10530 字节：静态区，绝不上栈。
 */
static void send_scene_reports(uint8_t seq, uint8_t scene_id)
{
    static lumen_scene_t scene;
    lumen_led_engine_scene_snapshot(scene_id, &scene);

    uint8_t frame[LUMEN_MAX_FRAME];
    uint8_t part_reports = 0;
    uint8_t step_reports = 0;

    for (uint8_t strip = 0; strip < LUMEN_MAX_STRIPS; ++strip) {
        for (uint8_t part = 0; part < LUMEN_MAX_PARTS; ++part) {
            const lumen_part_scene_t *ps = &scene.part[strip][part];
            if (ps->step_count == 0) {
                continue;
            }
            size_t len = lumen_protocol_encode_scene_part_report(
                seq, scene_id, strip, part, ps->step_count, ps->loop, ps->on, frame,
                sizeof(frame));
            if (len == 0 || lumen_ble_link_notify(frame, len) != ESP_OK) {
                ESP_LOGW(TAG, "ScenePartReport 发送失败 scene=%u strip=%u part=%u", scene_id,
                         strip, part);
                continue;
            }
            ++part_reports;
            for (uint8_t st = 0; st < ps->step_count && st < LUMEN_MAX_STEPS; ++st) {
                uint8_t l0[9];
                uint8_t l1[9];
                lumen_layer_encode(&ps->step[st].layer[0], l0);
                lumen_layer_encode(&ps->step[st].layer[1], l1);
                size_t slen = lumen_protocol_encode_scene_step_report(
                    seq, scene_id, strip, part, st, ps->step[st].duration_ms, l0, l1, frame,
                    sizeof(frame));
                if (slen == 0 || lumen_ble_link_notify(frame, slen) != ESP_OK) {
                    ESP_LOGW(TAG, "SceneStepReport 发送失败 scene=%u strip=%u part=%u step=%u",
                             scene_id, strip, part, st);
                    continue;
                }
                ++step_reports;
            }
        }
    }

    size_t end_len = lumen_protocol_encode_scene_list_end(seq, scene_id, scene.name_len,
                                                          scene.name, frame, sizeof(frame));
    if (end_len == 0 || lumen_ble_link_notify(frame, end_len) != ESP_OK) {
        ESP_LOGW(TAG, "SceneListEnd 发送失败 scene=%u", scene_id);
    }
    ESP_LOGI(TAG, "QueryScene %u -> %u ScenePartReport + %u SceneStepReport + SceneListEnd",
             scene_id, part_reports, step_reports);
}

/*
 * QueryStripConfig 0x1C -> StripConfigReport 0x87（docs/protocol-v5.md §7.4）。
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
 * QueryDeviceInfo 0x1D -> DeviceInfoReport 0x88（docs/protocol-v5.md §7.4）。
 *
 * hw_id 是 6 字节 BT MAC，按 "AA:BB:CC:DD:EE:FF" 的自然顺序——esp_read_mac
 * 给出的就是这个顺序，直接抄，不要按小端翻转（那是数值字段的规则）。
 * caps：bit0 = 支持两层叠加；bit1 = fade（v5 仍为 0）。
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
 * 处理一条完整写到 RX 的帧：
 *   解码（§3.1 magic→version→length→checksum）
 *   → 命令分发（§5 command→payload 长度→payload 取值）
 *   → 写入共享状态 / 布局 / 场景（RAM）
 *   → 发渲染信号（引擎内部完成，渲染异步）
 *   → 回 ACK
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
        /* 不足 8 字节：读不出可靠的 seq，按协议静默丢弃。 */
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
     * 布局快照只给布局命令用（0x20-0x24）。2696 字节放栈上会吃掉主机任务的
     * 栈余量，所以用静态缓冲——RX 回调在 NimBLE 主机任务里串行执行，
     * 不存在并发进入。
     */
    static lumen_layout_store_t s_layout_scratch;
    const lumen_layout_store_t *layout = NULL;
    switch (frame.command) {
    case LUMEN_CMD_LAYOUT_WRITE:
    case LUMEN_CMD_LAYOUT_PART:
    case LUMEN_CMD_LAYOUT_SEG:
    case LUMEN_CMD_QUERY_LAYOUT:
        lumen_led_engine_layout_snapshot(&s_layout_scratch);
        layout = &s_layout_scratch;
        break;
    default:
        break;
    }

    lumen_command_outcome_t outcome;
    /* max_brightness 取构建期常量：SetBrightness 在这里被钳位，而不是拒绝。 */
    lumen_command_dispatch(&frame, &current, layout, lumen_led_engine_max_brightness(), &outcome);

    /*
     * 布局族 0x20-0x24。命令层已完成单条命令的校验；引擎在锁内写入权威表，
     * 并判需要布局上下文的边界（部位是否存在、跨部位互斥）。引擎的返回码是
     * 权威：它可能因为期间布局变化而被再拒一次。
     *
     * LayoutCommit 是唯一落盘点（§10.5：0 ms 防抖）；失败回 StorageFailed
     * 且 RAM 保留。
     */
    if (outcome.layout_op && outcome.result_code == LUMEN_RESULT_OK) {
        switch (outcome.layout_opcode) {
        case LUMEN_CMD_LAYOUT_WRITE:
            outcome.result_code = lumen_led_engine_layout_write(outcome.layout_strip,
                                                                outcome.layout_part_count);
            break;
        case LUMEN_CMD_LAYOUT_PART:
            outcome.result_code = lumen_led_engine_layout_part(
                outcome.layout_strip, outcome.layout_part, outcome.layout_name_len,
                outcome.layout_name, outcome.layout_seg_count, outcome.layout_phase);
            break;
        case LUMEN_CMD_LAYOUT_SEG:
            outcome.result_code = lumen_led_engine_layout_seg(
                outcome.layout_strip, outcome.layout_part, outcome.layout_seg,
                outcome.layout_start, outcome.layout_end);
            break;
        case LUMEN_CMD_LAYOUT_COMMIT:
            outcome.result_code = lumen_led_engine_layout_commit(frame.command);
            break;
        case LUMEN_CMD_QUERY_LAYOUT:
            /* 查询不改状态；ACK 之后补 LayoutReport + LayoutListEnd。 */
            outcome.result_code = LUMEN_RESULT_OK;
            break;
        default:
            break;
        }
    }

    /*
     * 场景族 0x25-0x29。同布局：命令层判形状，引擎在锁内写表并入队落盘
     * （2 s 防抖）。编码后超过 12288 字节时回 StorageFailed 且 RAM 原样保留。
     */
    if (outcome.scene_op && outcome.result_code == LUMEN_RESULT_OK) {
        switch (outcome.scene_opcode) {
        case LUMEN_CMD_SCENE_PART:
            outcome.result_code = lumen_led_engine_scene_part(
                outcome.scene_id, outcome.scene_strip, outcome.scene_part,
                outcome.scene_step_count, outcome.scene_loop, outcome.scene_on, frame.command);
            break;
        case LUMEN_CMD_SCENE_STEP:
            outcome.result_code = lumen_led_engine_scene_step(
                outcome.scene_id, outcome.scene_strip, outcome.scene_part,
                outcome.scene_step_index, outcome.scene_duration_ms, outcome.scene_layer[0],
                outcome.scene_layer[1], frame.command);
            break;
        case LUMEN_CMD_SCENE_NAME:
            outcome.result_code = lumen_led_engine_scene_name(
                outcome.scene_id, outcome.scene_name_len, outcome.scene_name, frame.command);
            break;
        case LUMEN_CMD_ACTIVATE_SCENE:
            outcome.result_code =
                lumen_led_engine_activate_scene(outcome.scene_id, frame.command);
            break;
        case LUMEN_CMD_QUERY_SCENE:
            /* 查询不改状态；ACK 之后补三条报告（§6.2）。 */
            outcome.result_code = LUMEN_RESULT_OK;
            break;
        default:
            break;
        }
    }

    /*
     * SetStripPower 0x1B（§9.5）。命令层已校验 strip 已分配且 on ∈ {0,1}。
     * 这里只改 State 的 strip_power_mask（一位），让小程序立刻能通过 State
     * 观察到结果。
     *
     * 全局 SetPower(0) 只动 power，**不碰**这个掩码，因此关灯再开灯会回到
     * 各带原来的开关状态。
     */
    if (outcome.strip_power_op && outcome.result_code == LUMEN_RESULT_OK) {
        uint8_t mask = lumen_strip_power_set_mask(outcome.next.strip_power_mask,
                                                  outcome.strip_power_strip,
                                                  outcome.strip_power_on);
        if (mask != current.strip_power_mask) {
            outcome.next.strip_power_mask = mask;
            outcome.state_changed = true;
        }
    }

    /*
     * 自检控制（§9.6），必须在写共享状态之前处理：
     *  - 改变状态的命令先取消自检，再 commit，渲染任务不会闪回自检色；
     *  - SelfTest 只启动覆盖，不改状态（state_changed 恒为 false）。
     *
     * SetLedCount 例外：reducer 只标记「需要重建」，真正的成败在引擎里
     * （重建中再请求会回 Busy）。Busy 意味着新命令**没有**被应用，按 §9.6
     * 的语义不该取消自检——所以它的取消延后到 set_led_count 的结果。
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
     * 主线索；power/brightness 是命令生效后的存储状态。
     *
     * selftest=start/cancel/on 是 §9.6 的串口证据：
     *   start  = 这条命令启动了自检；
     *   cancel = 这条命令确实打断了进行中的自检；
     *   on     = 命令处理完后自检仍在跑（即这条命令没有取消自检）。
     */
    const char *selftest_note = "";
    if (outcome.start_selftest) {
        selftest_note = " selftest=start";
    } else if (cancelled_selftest) {
        selftest_note = " selftest=cancel";
    } else if (lumen_led_engine_selftest_active()) {
        selftest_note = " selftest=on";
    }
    ESP_LOGI(TAG,
             "RX cmd=0x%02X seq=0x%02X len=%u result=0x%02X power=%u brightness=%u "
             "scene=%u parts=%u%s%s",
             frame.command, frame.seq, frame.payload_len, outcome.result_code, outcome.next.power,
             outcome.next.brightness, outcome.next.active_scene, outcome.next.part_count[0],
             outcome.state_changed ? " changed" : "", selftest_note);

    if (outcome.led_count_rebuild) {
        /*
         * SetLedCount（§11.3）：ACK 必须等句柄重建结果。
         * 这里只登记请求 —— 引擎判忙 / 判相同值，真正的 create/del 在渲染任务，
         * 结果由引擎经 response 回调发 ACK。
         */
        uint8_t st = lumen_led_engine_set_led_count_for_strip(outcome.led_count_strip,
                                                              outcome.led_count, frame.seq);
        if (st == LUMEN_LED_ENGINE_DEFERRED) {
            /* 已被接受：现在才取消自检，与「新命令生效」同时。 */
            if (outcome.cancels_selftest) {
                lumen_led_engine_cancel_selftest();
            }
            return; /* ACK 由渲染任务在重建完成后发 */
        }
        if (st == LUMEN_RESULT_OK && outcome.cancels_selftest) {
            lumen_led_engine_cancel_selftest();
        }
        /* OK（数量未变）或 Busy：可以立即回。Busy 不取消自检。 */
        send_ack(frame.seq, frame.command, st);
        return;
    }

    /* ACK 在写入 RAM 之后立刻发；不等待渲染完成。 */
    send_ack(frame.seq, frame.command, outcome.result_code);

    /* §9.1：查询状态在 ACK 之后紧跟一条 StateReport，载荷布局与 State read 相同。 */
    if (outcome.state_report) {
        uint8_t state[LUMEN_STATE_BYTES];
        lumen_led_engine_state_bytes(state);
        uint8_t buf[LUMEN_MAX_FRAME];
        size_t slen = lumen_protocol_encode_state_report(frame.seq, state, buf, sizeof(buf));
        if (slen == 0 || lumen_ble_link_notify(buf, slen) != ESP_OK) {
            ESP_LOGW(TAG, "StateReport 发送失败 seq=0x%02X", frame.seq);
        }
    }

    /* QueryLayout：逐部位 LayoutReport + 一条 LayoutListEnd，同 seq（§8）。 */
    if (outcome.layout_op && outcome.layout_opcode == LUMEN_CMD_QUERY_LAYOUT &&
        outcome.result_code == LUMEN_RESULT_OK) {
        send_layout_reports(frame.seq, outcome.layout_strip);
    }

    /* QueryScene：部位头 / 每步 / 收尾三段，同 seq（§6.2）。 */
    if (outcome.scene_op && outcome.scene_opcode == LUMEN_CMD_QUERY_SCENE &&
        outcome.result_code == LUMEN_RESULT_OK) {
        send_scene_reports(frame.seq, outcome.scene_id);
    }

    /* QueryStripConfig 0x1C：ACK 之后一条 StripConfigReport 0x87（§7.4）。 */
    if (outcome.strip_config_query) {
        send_strip_config_report(frame.seq);
    }

    /* QueryDeviceInfo 0x1D：ACK 之后一条 DeviceInfoReport 0x88（§7.4）。 */
    if (outcome.device_info_query) {
        send_device_info_report(frame.seq);
    }
}

/*
 * 收下一个分片并驱动重组（docs/protocol-v4.md §3.2）。
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
     * 偏好 MTU 247（docs/protocol-v4.md §2.1）：chunk_capacity 因此能到
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
