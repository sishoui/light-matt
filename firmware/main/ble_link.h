#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "esp_err.h"

/*
 * ble_link：NimBLE GATT server + 帧收发。依赖方向只有 ble_link → led_engine。
 *
 * 回调边界（详见 docs/firmware-architecture.md）：
 *   - 允许：解析已有的 mbuf、拷贝到栈上、解帧信封、打一行短日志、
 *           从 led_engine 取一次 RAM 快照。
 *   - 禁止：刷灯、写 NVS、flash 操作、大段日志、等待超过毫秒级的阻塞。
 */

/* 初始化 NimBLE、注册 GATT 服务并启动主机任务；广播在 sync 回调里开始。 */
esp_err_t lumen_ble_link_init(void);

bool lumen_ble_link_is_connected(void);

/*
 * 通过 TX 特征值发一条通知。#8 用它发 ACK / Event / StateReport。
 * 未连接、参数非法或缓冲不足时返回错误；帧编码由调用者用 protocol.h 完成。
 */
esp_err_t lumen_ble_link_notify(const uint8_t *data, size_t len);
