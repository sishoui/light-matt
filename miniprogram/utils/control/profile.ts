/**
 * 本机身份：头像 + 昵称（`pages/me` 的顶部）。
 *
 * ## 为什么只存在本机
 *
 * 微信早已下线「获取用户信息」接口，`wx.getUserProfile` 调了也拿不到真实
 * 资料。头像只能由用户主动点 `<button open-type="chooseAvatar">` 给，昵称
 * 只能由用户在自己的键盘上填（`<input type="nickname">`）。这两样都只是
 * **这台手机上的显示偏好**，不上传后端——后端连用户表都没有，也不该为了
 * 一个昵称多存一份 PII。
 *
 * ## 为什么头像要落盘
 *
 * `chooseavatar` 回调给的是**临时路径**，小程序重启后就失效。所以选完必须
 * `saveFile` 到 `USER_DATA_PATH`，再把永久路径记进存储（与
 * `utils/control/device-photo.ts` 的 `pickDevicePhoto` 同一套做法）。
 *
 * ## 分层
 *
 * `loadProfile` / `saveProfile` 只依赖 `SessionStorage`，node 单测直接跑；
 * 碰 `wx` 的部分（文件系统）只在函数体内部，模块 import 无副作用。
 */

import type { SessionStorage } from "./device-cache";

/** 存储键（含版本，避免读到旧结构）。spec 未指定键名，这里补 `lumen.profile.v1`。 */
export const PROFILE_KEY = "lumen.profile.v1";

/** 默认昵称：用户没填过时显示它（不是占位符，是真的会存下来）。 */
export const DEFAULT_NICKNAME = "微信用户";

export interface Profile {
  /** 头像的**本机永久文件路径**；没选过时字段不存在。 */
  avatarFile?: string;
  /** 昵称；永远非空（空输入一律回落默认昵称）。 */
  nickname: string;
}

/** 把任意存储内容收敛成合法结构；损坏 / 缺字段都按默认处理。 */
function normalize(raw: unknown): Profile {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { nickname: DEFAULT_NICKNAME };
  }
  const record = raw as Record<string, unknown>;
  const nickname =
    typeof record.nickname === "string" && record.nickname.trim().length > 0
      ? record.nickname.trim()
      : DEFAULT_NICKNAME;
  const avatarFile =
    typeof record.avatarFile === "string" && record.avatarFile.length > 0
      ? record.avatarFile
      : undefined;
  return avatarFile === undefined ? { nickname } : { nickname, avatarFile };
}

/** 读本机身份；没设置过返回默认昵称、无头像。 */
export function loadProfile(storage: SessionStorage): Profile {
  const raw = storage.get(PROFILE_KEY);
  if (raw === null) {
    return { nickname: DEFAULT_NICKNAME };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { nickname: DEFAULT_NICKNAME };
  }
  return normalize(parsed);
}

/**
 * 写入一部分字段，返回完整的新值（不可变，方便调用方直接 setData）。
 *
 * `avatarFile: ""` 表示**清除头像**（用户没做这个操作，但保留语义，
 * 免得将来加「恢复默认头像」时又改一次存储结构）。
 */
export function saveProfile(storage: SessionStorage, patch: Partial<Profile>): Profile {
  const current = loadProfile(storage);
  const nickname =
    patch.nickname === undefined
      ? current.nickname
      : patch.nickname.trim().length > 0
        ? patch.nickname.trim()
        : DEFAULT_NICKNAME;
  const avatarFile =
    patch.avatarFile === undefined
      ? current.avatarFile
      : patch.avatarFile.length > 0
        ? patch.avatarFile
        : undefined;
  const next: Profile = avatarFile === undefined ? { nickname } : { nickname, avatarFile };
  storage.set(PROFILE_KEY, JSON.stringify(next));
  return next;
}

/**
 * `chooseavatar` 的临时路径 → `USER_DATA_PATH` 下的永久文件，返回永久路径。
 *
 * 只在真机 / 模拟器里调用。换头像时先存新的、再删旧的：顺序反了会在保存
 * 失败时把用户原来的头像也弄丢。
 *
 * 失败不抛给页面（头像是装饰，不该阻断设置页）：返回 null 由调用方提示。
 */
export function saveAvatarFile(tempFilePath: string, previous: string): Promise<string | null> {
  if (typeof wx === "undefined" || tempFilePath.length === 0) {
    return Promise.resolve(null);
  }
  return new Promise((resolve) => {
    let base: string;
    try {
      base = wx.env.USER_DATA_PATH;
    } catch {
      resolve(null);
      return;
    }
    /* 文件名带时间戳：`<image src>` 对同一路径有缓存，换头像后可能仍显示旧图。
     * 旧文件在保存成功后删除，不会积累。 */
    const target = `${base}/profile-avatar-${Date.now()}.jpg`;
    saveInto(target, tempFilePath, (saved) => {
      if (saved === null) {
        resolve(null);
        return;
      }
      /* 新文件已就位，再删旧的。 */
      if (previous.length > 0 && previous !== saved) {
        removeFile(previous);
      }
      resolve(saved);
    });
  });
}

/** 把永久头像文件删掉（当前没有调用方，保留给「恢复默认头像」）。 */
export function deleteAvatarFile(filePath: string): void {
  if (filePath.length > 0) {
    removeFile(filePath);
  }
}

/**
 * `saveFile` 到固定目标；同名文件已存在时先删再存一次。
 *
 * 微信的 `saveFile` 在目标已存在时会失败（而不是覆盖），所以必须走这条
 * 回退路径，否则第二次换头像永远失败。
 */
function saveInto(target: string, tempFilePath: string, done: (saved: string | null) => void): void {
  const fs = wx.getFileSystemManager();
  const attempt = (retry: boolean): void => {
    fs.saveFile({
      tempFilePath,
      filePath: target,
      success: (res) => done(res.savedFilePath ?? target),
      fail: () => {
        if (!retry) {
          done(null);
          return;
        }
        fs.unlink({
          filePath: target,
          complete: () => attempt(false),
        });
      },
    });
  };
  attempt(true);
}

function removeFile(filePath: string): void {
  try {
    wx.getFileSystemManager().unlink({ filePath, fail: () => undefined });
  } catch {
    /* 文件已不存在或 FS 不可用：忽略。 */
  }
}
