#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "esp_err.h"

#include "layout_store.h"
#include "scene_store.h"
#include "state.h"

/*
 * state_store：NVS 持久化（docs/protocol-v5.md §10）。
 *
 * v5 有**五个独立键**（§10.5）：
 *   "state"        32 B     变更后 500 ms 防抖
 *   "layout"       4096 B   LayoutCommit 后立即（0 ms）
 *   "scene0/1/2"   12288 B  ScenePart / SceneStep / SceneName 后 2 s 防抖
 *
 * 上电各加载一次。blob 编解码由纯模块（state_blob / layout_store / scene_store）
 * 负责，debounce 由 save_scheduler 负责，本文件只负责任务、NVS 与失败上报，
 * 因此 host 单测不需要 NVS。
 *
 * **12 KB 的场景 blob 不在存储任务栈上编码**（seams.md §B7）：blob 由引擎在
 * 自己的静态缓冲里编好，本模块只持有指针。存储任务栈 5120 B，余量约 1.8 KB。
 *
 * 写失败发生在 ACK 之后，按 §10.5 用 Event 0x81 上报：注册的 event_cb 会被
 * 调用，参数是触发这次写入的命令字（detail 字段）。
 */

/*
 * NVS 写失败的异步通知（协议 §10.5 Event 0x81）。
 * 参数是触发这次写入的命令字，即 Event 载荷的第二字节。
 * 回调在存储任务上下文里执行，实现必须非阻塞（只做协议编码 + notify 入队）。
 */
typedef void (*lumen_store_event_cb)(uint8_t command);

esp_err_t lumen_state_store_init(void);

/* 注册异步写失败回调。回调在存储任务上下文执行，不得做耗时操作。 */
void lumen_state_store_set_event_cb(lumen_store_event_cb cb);

/*
 * 读回上次保存的 State。没有历史、数据损坏或字段越界时返回 false。
 * 失败时不写 out（调用方保留默认值）。
 *
 * 布局与场景有各自的加载函数；part_count / layout_valid 由引擎在布局加载后
 * 填进 State（State blob 不含它们，§10.2）。
 */
bool lumen_state_store_load(lumen_persist_t *out);

/*
 * 读回布局 blob。**没有历史或损坏时返回 false 且不写 out**（调用方保留默认值）。
 *
 * strip_counts 是 State 的权威灯珠数；布局 blob 自带的每链灯珠数只作冗余
 * 一致性检查，不一致以 State 为准并重跑一次整份校验（§10.3）。
 */
bool lumen_state_store_load_layout(lumen_layout_store_t *out,
                                   const uint16_t strip_counts[LUMEN_MAX_STRIPS]);

/* 读回某个场景（0-2）。没有历史或损坏时返回 false 且不写 out。 */
bool lumen_state_store_load_scene(uint8_t scene_id, lumen_scene_t *out);

/*
 * 线程安全：记录最新 State 快照、触发它的命令字，并重置 500 ms debounce。
 * 不在调用者上下文写 NVS。命令字用于 Event 0x81 的 detail。
 */
void lumen_state_store_request_save(const lumen_persist_t *snapshot, uint8_t command);

/*
 * 记录最新布局 / 场景 blob 并重置对应的 debounce。
 * 布局立即落盘（debounce 0）；场景 2 s（E4）。
 *
 * 传**已编码的 blob** 而不是整份表：布局 2760 B、一个场景 10530 B，引擎已经
 * 持有一份；存储侧再存一份会白吃一大块 DRAM，而编码是纯函数、只读表。
 *
 * blob 指针在写入完成前必须保持有效（调度器只存指针，不拷贝）。
 * 返回 false 表示参数非法（scene_id 越界 / 指针为空 / 长度超上限）。
 */
bool lumen_state_store_request_layout_save(const uint8_t *blob, size_t len, uint8_t command);
bool lumen_state_store_request_scene_save(uint8_t scene_id, const uint8_t *blob, size_t len,
                                          uint8_t command);
