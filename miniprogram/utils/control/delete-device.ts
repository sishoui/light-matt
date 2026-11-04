/**
 * 「删除设备」的单一实现（#91 / #94）。
 *
 * ## 为什么必须是一组动作
 *
 * 删除只清登记表会留下三种「删了但还在」的痕迹，每一种都真实发生过：
 *  1. **连接没断** → 固件连上就停止广播 → 扫描永远看不到这台设备
 *     （用户以为「删了就找不回来了」）；
 *  2. **「上次设备」没清** → 重连监控在页面显示时拿它自动连回去，
 *     并把设备重新写回「最近连过」（切个页就复活）；
 *  3. **封面文件 / 方案草稿 / 灯组元数据没清** → 重新加回来时旧资料还在，
 *     或者用户存储（10MB）被永远用不到的图吃掉。
 *
 * 演示设备还有第四条：不记住「用户显式删除过」的话，演示模式恢复逻辑
 * 会在下次启动把它重新播种回来。
 *
 * ## 调用点
 *
 * `pages/me`（我的设备列表）与 `pages/device-info`（设备信息页）两处。
 * 语义只能有一份，否则两处行为会分叉——这正是本模块存在的原因。
 */

import { clearCachedDevice, type SessionStorage } from "./device-cache";
import { deviceKeyOf } from "./device-history";
import { removeDevice } from "./device-registry";
import {
  clearDevicePhoto,
  deleteDevicePhotoFile,
  loadDevicePhotos,
  photoKeyOf,
} from "./device-photo";
import { clearPlanDraftsForDevice } from "./plan-drafts";
import { clearStripMetaForDevice } from "./strip-meta";
import { isMockDeviceId } from "./mock-mode";
import { markMockDeleted } from "./mock-deleted";
import type { ControlSession } from "./session";

/** 删除一台设备所需的上下文。 */
export interface DeleteDeviceInput {
  storage: SessionStorage;
  /** 本机平台 deviceId（可能为空：只有后端记录的设备）。 */
  deviceId: string;
  /** 设备自报的 hardwareId（未知时为空）。 */
  hardwareId: string;
  /** 会话（断开连接 / 清最近记录）。可为 null（页面还没拿到会话）。 */
  session: ControlSession | null;
}

/** 删除结果：给调用方做提示与断言。 */
export interface DeleteDeviceResult {
  /** 是否真的断开了（已经未连接时为 false，不是失败）。 */
  disconnected: boolean;
  /** 清掉了几条方案草稿。 */
  planDraftsCleared: number;
  /** 清掉了几条灯组元数据。 */
  stripMetaCleared: number;
  /** 删掉了几个本地封面文件。 */
  photosDeleted: number;
  /** 是否是演示设备（演示设备要额外记住「显式删除过」）。 */
  mock: boolean;
}

/**
 * 删除一台设备的**全部**本机痕迹。
 *
 * 顺序是刻意的：
 *  1. **先断开**——不断开，固件不重新广播，扫描永远看不到它；
 *  2. 清「上次设备」——否则切页时重连监控会把它连回去；
 *  3. 清最近记录（会同步更新会话内存）；
 *  4. 清登记表（备注 / 掩码 / 硬件号 / 后端 id）；
 *  5. 清方案草稿（hardwareId 与 deviceId 两个键都清，iOS 换 UUID 时都可能是键）；
 *  6. 清灯组元数据（按 deviceKey 前缀）；
 *  7. 清封面文件与映射；
 *  8. 演示设备额外记一笔「显式删除过」。
 *
 * 任何一步失败都不阻断后面的步骤：留下半套痕迹比「删到一半报错」更糟。
 */
export async function deleteDeviceFully(input: DeleteDeviceInput): Promise<DeleteDeviceResult> {
  const { storage, session } = input;
  const deviceId = input.deviceId;
  const hardwareId = input.hardwareId;
  const mock = deviceId.length > 0 && isMockDeviceId(deviceId);
  const key = deviceKeyOf({ deviceId, hardwareId });

  /* 1. 断开连接。只看「当前连的就是这台」——连别的设备时删除本机记录
   * 不该把别的连接断掉。 */
  let disconnected = false;
  if (session !== null) {
    const currentId = session.transport.currentDeviceId ?? "";
    if (deviceId.length > 0 && currentId === deviceId) {
      try {
        await session.disconnect();
        disconnected = true;
      } catch {
        /* 断开失败也继续清记录：设备可能已经自己断开了。 */
      }
    }
    /* 2 + 3. 清「上次设备」并让重连监控放弃回连意图。
     * `disconnect()` 内部已经清了缓存（见 ControlSession.disconnect），
     * 但「当前连的不是这台」时没走到那里，所以这里再兜一次。 */
    clearCachedDevice(storage);
    session.forgetRecent(deviceId, hardwareId.length > 0 ? hardwareId : undefined);
  } else {
    clearCachedDevice(storage);
  }

  /* 4. 清登记表。 */
  if (deviceId.length > 0) {
    removeDevice(storage, deviceId);
  }

  /* 5. 方案草稿：键可能是 hardwareId 或 deviceId，两个都清。 */
  let planDraftsCleared = 0;
  if (hardwareId.length > 0) {
    planDraftsCleared += clearPlanDraftsForDevice(storage, hardwareId);
  }
  if (deviceId.length > 0) {
    planDraftsCleared += clearPlanDraftsForDevice(storage, deviceId);
  }

  /* 6. 灯组元数据：按 deviceKey 前缀清理，连同自定义封面文件一起删。 */
  let stripMetaCleared = 0;
  let photosDeleted = 0;
  if (key.length > 0) {
    const removed = clearStripMetaForDevice(storage, key);
    stripMetaCleared = removed.removedPhotos.length;
    for (const photo of removed.removedPhotos) {
      deleteDevicePhotoFile(photo);
    }
  }

  /* 7. 设备封面：先拿到路径再清映射，最后删文件。
   *
   * **两个键都要清**：封面按 deviceKey（hardwareId 优先）存，但升级前 / iOS
   * 换 UUID 后可能还留着一条按 deviceId 存的旧记录。只清一个会留下孤儿映射
   * ——它永远显示不出来，却一直占着用户存储。 */
  const photoKeys = new Set<string>();
  if (key.length > 0) photoKeys.add(key);
  if (deviceId.length > 0) photoKeys.add(deviceId);
  if (hardwareId.length > 0) photoKeys.add(hardwareId);
  if (photoKeys.size > 0) {
    const photos = loadDevicePhotos(storage);
    for (const photoKey of photoKeys) {
      const photo = photoKeyOf(photos, photoKey);
      if (photo.length > 0) {
        deleteDevicePhotoFile(photo);
        photosDeleted += 1;
      }
      clearDevicePhoto(storage, photoKey);
    }
  }

  /* 8. 演示设备：记住「用户显式删除过」，否则下次启动会重新播种。 */
  if (mock) {
    markMockDeleted(storage, deviceId);
  }

  return { disconnected, planDraftsCleared, stripMetaCleared, photosDeleted, mock };
}
