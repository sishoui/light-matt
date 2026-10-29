#include <string.h>

#include "esp_log.h"
#include "nvs_flash.h"

#include "nimble/nimble_port.h"
#include "nimble/nimble_port_freertos.h"
#include "host/ble_hs.h"
#include "host/ble_att.h"
#include "host/ble_uuid.h"
#include "host/util/util.h"
#include "services/gap/ble_svc_gap.h"
#include "services/gatt/ble_svc_gatt.h"

static const char *TAG = "lumen_echo";

static uint8_t own_addr_type;
static uint16_t conn_handle = BLE_HS_CONN_HANDLE_NONE;
static uint16_t tx_val_handle;

static int gap_event(struct ble_gap_event *event, void *arg);

/* 128-bit UUID 在 NimBLE 里按小端存放。
 * Service 6c756d65-6e00-4b1e-9a3c-000000000001
 * RX      ...-000000000002
 * TX      ...-000000000003
 * State   ...-000000000004
 */
static const ble_uuid128_t svc_uuid = BLE_UUID128_INIT(
    0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x3c, 0x9a,
    0x1e, 0x4b, 0x00, 0x6e, 0x65, 0x6d, 0x75, 0x6c);
static const ble_uuid128_t rx_uuid = BLE_UUID128_INIT(
    0x02, 0x00, 0x00, 0x00, 0x00, 0x00, 0x3c, 0x9a,
    0x1e, 0x4b, 0x00, 0x6e, 0x65, 0x6d, 0x75, 0x6c);
static const ble_uuid128_t tx_uuid = BLE_UUID128_INIT(
    0x03, 0x00, 0x00, 0x00, 0x00, 0x00, 0x3c, 0x9a,
    0x1e, 0x4b, 0x00, 0x6e, 0x65, 0x6d, 0x75, 0x6c);
static const ble_uuid128_t state_uuid = BLE_UUID128_INIT(
    0x04, 0x00, 0x00, 0x00, 0x00, 0x00, 0x3c, 0x9a,
    0x1e, 0x4b, 0x00, 0x6e, 0x65, 0x6d, 0x75, 0x6c);

/* 探针用的假状态：开关、亮度、RGB、灯珠数、亮度上限 */
static uint8_t state_buf[8] = {0x01, 0x80, 0xFF, 0xB4, 0x78, 0x1E, 0x00, 0xFF};

static int rx_access(uint16_t conn, uint16_t attr, struct ble_gatt_access_ctxt *ctxt, void *arg)
{
    if (ctxt->op != BLE_GATT_ACCESS_OP_WRITE_CHR) {
        return BLE_ATT_ERR_UNLIKELY;
    }

    uint16_t len = OS_MBUF_PKTLEN(ctxt->om);
    uint8_t buf[256];
    if (len > sizeof(buf)) {
        return BLE_ATT_ERR_INVALID_ATTR_VALUE_LEN;
    }

    uint16_t out_len = 0;
    if (ble_hs_mbuf_to_flat(ctxt->om, buf, sizeof(buf), &out_len) != 0) {
        return BLE_ATT_ERR_UNLIKELY;
    }

    ESP_LOGI(TAG, "RX len=%u", out_len);

    if (conn == BLE_HS_CONN_HANDLE_NONE || out_len == 0) {
        return 0;
    }

    struct os_mbuf *om = ble_hs_mbuf_from_flat(buf, out_len);
    if (om == NULL) {
        return BLE_ATT_ERR_INSUFFICIENT_RES;
    }

    int rc = ble_gatts_notify_custom(conn, tx_val_handle, om);
    if (rc != 0) {
        os_mbuf_free_chain(om);
        ESP_LOGW(TAG, "notify failed rc=%d", rc);
    }
    return 0;
}

static int tx_access(uint16_t conn, uint16_t attr, struct ble_gatt_access_ctxt *ctxt, void *arg)
{
    return BLE_ATT_ERR_UNLIKELY;
}

static int state_access(uint16_t conn, uint16_t attr, struct ble_gatt_access_ctxt *ctxt, void *arg)
{
    if (ctxt->op != BLE_GATT_ACCESS_OP_READ_CHR) {
        return BLE_ATT_ERR_UNLIKELY;
    }
    int rc = os_mbuf_append(ctxt->om, state_buf, sizeof(state_buf));
    return rc == 0 ? 0 : BLE_ATT_ERR_INSUFFICIENT_RES;
}

static const struct ble_gatt_svc_def gatt_svcs[] = {
    {
        .type = BLE_GATT_SVC_TYPE_PRIMARY,
        .uuid = &svc_uuid.u,
        .characteristics = (struct ble_gatt_chr_def[]){
            {
                .uuid = &rx_uuid.u,
                .access_cb = rx_access,
                .flags = BLE_GATT_CHR_F_WRITE | BLE_GATT_CHR_F_WRITE_NO_RSP,
            },
            {
                .uuid = &tx_uuid.u,
                .access_cb = tx_access,
                .flags = BLE_GATT_CHR_F_NOTIFY,
                .val_handle = &tx_val_handle,
            },
            {
                .uuid = &state_uuid.u,
                .access_cb = state_access,
                .flags = BLE_GATT_CHR_F_READ,
            },
            {0},
        },
    },
    {0},
};

static void advertise(void)
{
    struct ble_hs_adv_fields fields = {0};
    fields.flags = BLE_HS_ADV_F_DISC_GEN | BLE_HS_ADV_F_BREDR_UNSUP;
    fields.uuids128 = &svc_uuid;
    fields.num_uuids128 = 1;
    fields.uuids128_is_complete = 1;

    int rc = ble_gap_adv_set_fields(&fields);
    if (rc != 0) {
        ESP_LOGE(TAG, "adv fields rc=%d", rc);
        return;
    }

    struct ble_hs_adv_fields rsp = {0};
    const char *name = ble_svc_gap_device_name();
    rsp.name = (const uint8_t *)name;
    rsp.name_len = strlen(name);
    rsp.name_is_complete = 1;

    rc = ble_gap_adv_rsp_set_fields(&rsp);
    if (rc != 0) {
        ESP_LOGE(TAG, "scan rsp rc=%d", rc);
        return;
    }

    struct ble_gap_adv_params params = {0};
    params.conn_mode = BLE_GAP_CONN_MODE_UND;
    params.disc_mode = BLE_GAP_DISC_MODE_GEN;

    rc = ble_gap_adv_start(own_addr_type, NULL, BLE_HS_FOREVER, &params, gap_event, NULL);
    if (rc != 0 && rc != BLE_HS_EALREADY) {
        ESP_LOGE(TAG, "adv start rc=%d", rc);
    }
}

static int gap_event(struct ble_gap_event *event, void *arg)
{
    struct ble_gap_conn_desc desc;

    switch (event->type) {
    case BLE_GAP_EVENT_CONNECT:
        if (event->connect.status == 0) {
            conn_handle = event->connect.conn_handle;
            if (ble_gap_conn_find(conn_handle, &desc) == 0) {
                ESP_LOGI(TAG, "connected itvl=%d latency=%d timeout=%d",
                         desc.conn_itvl, desc.conn_latency, desc.supervision_timeout);
            }
            ESP_LOGI(TAG, "mtu=%d", ble_att_mtu(conn_handle));
        } else {
            conn_handle = BLE_HS_CONN_HANDLE_NONE;
            advertise();
        }
        return 0;

    case BLE_GAP_EVENT_DISCONNECT:
        ESP_LOGI(TAG, "disconnected reason=%d", event->disconnect.reason);
        conn_handle = BLE_HS_CONN_HANDLE_NONE;
        advertise();
        return 0;

    case BLE_GAP_EVENT_ADV_COMPLETE:
        advertise();
        return 0;

    case BLE_GAP_EVENT_MTU:
        ESP_LOGI(TAG, "mtu updated=%d", event->mtu.value);
        return 0;

    case BLE_GAP_EVENT_CONN_UPDATE:
        if (ble_gap_conn_find(event->conn_update.conn_handle, &desc) == 0) {
            ESP_LOGI(TAG, "conn updated itvl=%d latency=%d timeout=%d",
                     desc.conn_itvl, desc.conn_latency, desc.supervision_timeout);
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
        ESP_LOGE(TAG, "ensure_addr rc=%d", rc);
        return;
    }

    rc = ble_hs_id_infer_auto(0, &own_addr_type);
    if (rc != 0) {
        ESP_LOGE(TAG, "infer addr rc=%d", rc);
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
    ESP_LOGI(TAG, "BLE host task started");
    nimble_port_run();
    nimble_port_freertos_deinit();
}

void app_main(void)
{
    esp_err_t ret = nvs_flash_init();
    if (ret == ESP_ERR_NVS_NO_FREE_PAGES || ret == ESP_ERR_NVS_NEW_VERSION_FOUND) {
        ESP_ERROR_CHECK(nvs_flash_erase());
        ret = nvs_flash_init();
    }
    ESP_ERROR_CHECK(ret);

    ESP_ERROR_CHECK(nimble_port_init());

    ble_hs_cfg.reset_cb = on_reset;
    ble_hs_cfg.sync_cb = on_sync;

    ble_svc_gap_init();
    ble_svc_gatt_init();

    ble_gatts_count_cfg(gatt_svcs);
    ble_gatts_add_svcs(gatt_svcs);
    ble_svc_gap_device_name_set("Lumen-ECHO");

    nimble_port_freertos_init(host_task);
}
