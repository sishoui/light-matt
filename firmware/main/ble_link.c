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

#include "led_engine.h"
#include "protocol.h"
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
 * RX 回调：本票只做信封解码与日志，不执行命令、不改变灯带、不回 ACK。
 * 命令分发、payload 校验与 ACK 都在 #8。
 */
static int rx_access(uint16_t conn_handle, uint16_t attr_handle,
                     struct ble_gatt_access_ctxt *ctxt, void *arg)
{
    (void)attr_handle;
    (void)arg;

    if (ctxt->op != BLE_GATT_ACCESS_OP_WRITE_CHR) {
        return BLE_ATT_ERR_UNLIKELY;
    }

    uint16_t mbuf_len = OS_MBUF_PKTLEN(ctxt->om);
    if (mbuf_len > LUMEN_RX_BUF_SIZE) {
        ESP_LOGW(TAG, "RX 收到 %u 字节，超过本地缓冲 %d，丢弃", mbuf_len, LUMEN_RX_BUF_SIZE);
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

    /* 验收要求的一行：收到 N 字节。20 字节以内的帧顺带打 hex，日志仍是一行。 */
    ESP_LOGI(TAG, "RX 收到 %u 字节", len);
    if (len > 0 && len <= LUMEN_MAX_FRAME) {
        ESP_LOG_BUFFER_HEX_LEVEL(TAG, buf, len, ESP_LOG_INFO);
    }

    lumen_frame_t frame;
    uint8_t result_code = 0xFF;
    lumen_decode_status_t status = lumen_protocol_decode(buf, len, &frame, &result_code);
    switch (status) {
    case LUMEN_DECODE_OK:
        ESP_LOGI(TAG, "信封 OK cmd=0x%02X seq=0x%02X payload_len=%u（本票不执行命令）",
                 frame.command, frame.seq, frame.payload_len);
        break;
    case LUMEN_DECODE_SILENT:
        ESP_LOGW(TAG, "帧不足 %d 字节，静默丢弃", LUMEN_FRAME_OVERHEAD);
        break;
    default:
        ESP_LOGW(TAG, "信封错误 result=0x%02X cmd=0x%02X seq=0x%02X（ACK 留给 #8）",
                 result_code, frame.command, frame.seq);
        break;
    }

    /* 骨架阶段：绝不在这里刷灯 / 写 NVS / 改共享状态。 */
    (void)conn_handle;
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

    /* 只是拷贝一份 8 字节 RAM 快照，短时间持锁，不触发渲染。 */
    uint8_t state[8];
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
