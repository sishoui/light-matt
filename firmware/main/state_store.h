#pragma once

#include <stdbool.h>
#include <stdint.h>

#include "esp_err.h"

#include "state.h"

/*
 * state_store：NVS 持久化。
 * 上电加载一次；状态变更后 500ms debounce 写一次。
 *
 * debounce 与 blob 编解码分别由 save_scheduler / state_blob 两个纯模块实现，
 * 本文件只负责任务、NVS 与失败上报，因此 host 单测不需要 NVS。
 *
 * 写失败发生在 ACK 之后，按 docs/protocol.md §10.3 用 Event 0x81 上报：
 * 注册的 event_cb 会被调用，参数是触发这次写入的命令字（detail 字段）。
 */

/*
 * NVS 写失败的异步通知（协议 §10.3 Event 0x81）。
 * 参数是触发这次写入的命令字，即 Event 载荷的第二字节。
 * 回调在存储任务上下文里执行，实现必须非阻塞（只做协议编码 + notify 入队）。
 */
typedef void (*lumen_store_event_cb)(uint8_t command);

esp_err_t lumen_state_store_init(void);

/* 注册异步写失败回调。回调在存储任务上下文执行，不得做耗时操作。 */
void lumen_state_store_set_event_cb(lumen_store_event_cb cb);

/* 读回上次保存的状态。没有历史、数据损坏或字段越界时返回 false。 */
bool lumen_state_store_load(lumen_state_t *out);

/* 线程安全：记录最新快照、触发它的命令字，并重置 debounce 计时。
 * 不在调用者上下文写 NVS。命令字用于 Event 0x81 的 detail。 */
void lumen_state_store_request_save(const lumen_state_t *state, uint8_t command);
