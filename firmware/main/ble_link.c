#include "ble_link.h"

#include <stdio.h>
#include <string.h>

#include "esp_log.h"
#include "esp_mac.h"
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
#include "effects.h"
#include "led_engine.h"
#include "protocol.h"
#include "state_store.h"
#include "stress_metrics.h"

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

/* 默认 ATT MTU 23 时单次写最多 20 字节；留出余量处理客户端协商大 MTU 的情况。 */
#define LUMEN_RX_BUF_SIZE 64

static uint8_t s_own_addr_type;
static volatile uint16_t s_conn_handle = BLE_HS_CONN_HANDLE_NONE;
static uint16_t s_tx_val_handle;
static char s_device_name[16] = "Lumen-0000";

static int gap_event(struct ble_gap_event *event, void *arg);
static void advertise(void);

/*
 * 回一条 Event：载荷 [event_code, detail]，seq 固定 0x00（协议 §8）。
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
 * 超过本地缓冲的帧：协议规定整帧 > 20 字节必须拒绝（0x04），绝不截断执行。
 * 仍然可以从前 4 字节读出 header 并回显 seq / 命令字，所以先按 §10.2 的
 * 顺序检查 magic / version，再回长度错误。
 */
static void reject_oversized(const struct os_mbuf *om, uint16_t mbuf_len)
{
    uint8_t header[4] = {0};
    uint16_t copied = 0;
    int rc = ble_hs_mbuf_to_flat(om, header, sizeof(header), &copied);
    if (rc != 0 || copied < sizeof(header)) {
        ESP_LOGW(TAG, "超长帧 %u 字节且读不到 header，静默丢弃", mbuf_len);
        return;
    }

    uint8_t result = LUMEN_RESULT_BAD_LENGTH;
    if (header[0] != LUMEN_MAGIC) {
        result = LUMEN_RESULT_BAD_MAGIC;
    } else if (header[1] != LUMEN_VERSION) {
        result = LUMEN_RESULT_UNSUPPORTED_VERSION;
    }
    ESP_LOGW(TAG, "RX 收到 %u 字节，超过整帧上限 %d，拒绝 cmd=0x%02X seq=0x%02X result=0x%02X",
             mbuf_len, LUMEN_MAX_FRAME, header[2], header[3], result);
    send_ack(header[3], header[2], result);
}

/*
 * QueryStrip 0x12 的多帧响应（docs/protocol.md §9 / §10.1）：
 * seg_count 条 SegmentReport(0x83) + 1 条 SegmentListEnd(0x84)，
 * **全部回显同一个 seq**。小程序按命令字区分帧类型，按 SegmentListEnd 收尾。
 *
 * 在 NimBLE 主机任务的 RX 回调里同步发出：每帧只做一次编码 + notify 入队，
 * 不刷灯、不写 NVS。单灯带 3 段场景约 70 字节，不会把主机任务拖住。
 */
static void send_strip_reports(uint8_t seq, uint8_t strip_id)
{
    lumen_segment_t segments[LUMEN_MAX_SEGMENTS];
    uint8_t count = lumen_led_engine_segments(strip_id, segments, LUMEN_MAX_SEGMENTS);
    uint8_t mask = lumen_led_engine_segment_mask(strip_id);

    uint8_t frame[LUMEN_MAX_FRAME];
    uint8_t sent = 0;
    for (uint8_t i = 0; i < count; ++i) {
        const lumen_segment_t *seg = &segments[i];
        /* 参数块按 type 解释（docs/effects-spec.md §2）：静态 hue(2)+sat(1)。 */
        uint8_t params[7] = {0};
        uint8_t param_len = lumen_effect_param_len(seg->type);
        if (param_len == 0) {
            continue; /* 未知类型不回报（不该出现在权威段表里） */
        }
        params[0] = (uint8_t)(seg->hue & 0xFF);
        params[1] = (uint8_t)(seg->hue >> 8);
        params[2] = seg->sat;
        if (param_len > 3) {
            params[3] = (uint8_t)(seg->period_ms & 0xFF);
            params[4] = (uint8_t)(seg->period_ms >> 8);
            params[5] = seg->p5;
            params[6] = seg->flags;
        }
        size_t len = lumen_protocol_encode_segment_report(
            seq, strip_id, i, seg->start, seg->end, seg->type, params, param_len, frame,
            sizeof(frame));
        if (len == 0 || lumen_ble_link_notify(frame, len) != ESP_OK) {
            ESP_LOGW(TAG, "SegmentReport 发送失败 strip=%u seg=%u", strip_id, i);
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
     * 1KB 拷贝放在栈上会吃掉主机任务的栈余量，所以用静态缓冲——RX 回调
     * 在 NimBLE 主机任务里串行执行，不存在并发进入。
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
     * 自检控制（协议 §11.2），必须在写共享状态之前处理：
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

    /* QueryStrip：seg_count 条 SegmentReport + 1 条 SegmentListEnd，同 seq（§10.1）。 */
    if (outcome.strip_query) {
        send_strip_reports(frame.seq, outcome.query_strip_id);
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
    if (mbuf_len > LUMEN_RX_BUF_SIZE) {
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
        ESP_LOGD(TAG, "RX 收到 %u 字节", len);
        if (len > 0 && len <= LUMEN_MAX_FRAME) {
            ESP_LOG_BUFFER_HEX_LEVEL(TAG, buf, len, ESP_LOG_DEBUG);
        }
    }

    handle_frame(buf, len);
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

    /* 只是拷贝一份 14 字节 RAM 快照，短时间持锁，不触发渲染。 */
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
        lumen_stress_note_ble_connect(s_conn_handle);
        if (ble_gap_conn_find(s_conn_handle, &desc) == 0) {
            ESP_LOGI(TAG, "connected handle=0x%04X itvl=%d latency=%d timeout=%d",
                     s_conn_handle, desc.conn_itvl, desc.conn_latency,
                     desc.supervision_timeout);
        }
        ESP_LOGI(TAG, "mtu=%d", ble_att_mtu(s_conn_handle));
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
            /* 释放连接句柄后重新广播，等待下一个 central。 */
            advertise();
        }
        return 0;

    case BLE_GAP_EVENT_ADV_COMPLETE:
        advertise();
        return 0;

    case BLE_GAP_EVENT_MTU:
        ESP_LOGI(TAG, "mtu updated=%d", event->mtu.value);
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

    esp_err_t err = nimble_port_init();
    if (err != ESP_OK) {
        return err;
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

    struct os_mbuf *om = ble_hs_mbuf_from_flat(data, (uint16_t)len);
    if (om == NULL) {
        return ESP_ERR_NO_MEM;
    }
    /* ble_gatts_notify_custom 接管 txom 的所有权：成功和失败都由它释放，
     * 调用方不得再 os_mbuf_free_chain。 */
    int rc = ble_gatts_notify_custom(conn_handle, s_tx_val_handle, om);
    if (rc != 0) {
        ESP_LOGW(TAG, "notify failed rc=%d", rc);
        return ESP_FAIL;
    }
    return ESP_OK;
}
