/**
 * 段配置的「扁平 UI 形态 ⇄ 线上两层形态」接缝（#40）。
 *
 * 为什么需要：v3 的段是**两层定宽**（`SegmentSpec`），而 #40 之前所有页面
 * 与 `session.setSegment*` 都只认「单层 + 扁平字段」（`SegmentConfig`）。
 * 把转换集中在一处，可以让页面在 #40 一行不改，同时协议层完全按 v3 说话。
 *
 * 约定（与 docs/protocol-v3.md §7.1 一致）：
 *  - 扁平草稿只描述 **layer0**；
 *  - 转换出的 spec 一律 `layer1 = 空层`、`blend = 0`（覆盖）——设备要求
 *    layer1 为空时 blend 必须为 0；
 *  - `toFlat` 只投影 layer0，layer1 的权威数据始终留在 `SegmentSpec` 里
 *    （#42 的双层编辑直接读 spec，不再经过扁平形态）。
 *
 * 实现放在 `utils/protocol/segment-shapes.ts`：转换本身是纯字节语义，
 * 协议层（commands.ts）也要用它；本文件只是控制层对外的稳定门面。
 *
 * 本模块纯函数、不碰 wx / BLE。
 */

export {
  emptyLayer,
  hasSecondLayer,
  isSegmentSpec,
  layerFromFlat,
  specFromReport,
  toFlat,
  toSpec,
} from "../protocol/segment-shapes";
