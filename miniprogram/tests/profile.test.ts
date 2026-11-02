/**
 * 本机身份（头像 / 昵称）的存储逻辑。
 *
 * 只测**纯逻辑**：读写、默认值、损坏数据、往返。`wx.chooseAvatar` +
 * `saveFile` 那部分只在真机 / 模拟器跑（人工验证）。
 *
 * 为什么值得单测：这是唯一一条「用户主动提供的个人资料」，写错键或把空
 * 昵称落盘会让「我的」页顶部出现空白卡片，而现象只是「名字没了」。
 */

import { describe, expect, it } from "vitest";

import {
  DEFAULT_NICKNAME,
  deleteAvatarFile,
  loadProfile,
  PROFILE_KEY,
  saveAvatarFile,
  saveProfile,
} from "../utils/control/profile";
import { createSessionStorage } from "./helpers/storage";

describe("本机身份：默认值", () => {
  it("没有记录时给出默认昵称、无头像", () => {
    const profile = loadProfile(createSessionStorage());
    expect(profile).toEqual({ nickname: DEFAULT_NICKNAME });
    expect(profile.avatarFile).toBeUndefined();
  });

  it("默认昵称是「微信用户」", () => {
    expect(DEFAULT_NICKNAME).toBe("微信用户");
  });

  it("存储键带版本号（lumen.profile.v1）", () => {
    expect(PROFILE_KEY).toBe("lumen.profile.v1");
  });

  it("JSON 损坏时回落默认值（不抛错）", () => {
    const storage = createSessionStorage({ [PROFILE_KEY]: "{not json" });
    expect(loadProfile(storage)).toEqual({ nickname: DEFAULT_NICKNAME });
  });

  it("结构不对（数组 / 字符串 / null）一律回落默认值", () => {
    for (const raw of ["[]", "\"x\"", "null", "42"]) {
      const storage = createSessionStorage({ [PROFILE_KEY]: raw });
      expect(loadProfile(storage)).toEqual({ nickname: DEFAULT_NICKNAME });
    }
  });

  it("缺字段的记录按字段补默认：只有头像时不丢头像", () => {
    const storage = createSessionStorage({
      [PROFILE_KEY]: JSON.stringify({ avatarFile: "wxfile://a.jpg" }),
    });
    expect(loadProfile(storage)).toEqual({
      nickname: DEFAULT_NICKNAME,
      avatarFile: "wxfile://a.jpg",
    });
  });
});

describe("本机身份：写入与往返", () => {
  it("写昵称后能读回", () => {
    const storage = createSessionStorage();
    saveProfile(storage, { nickname: "阿灯" });
    expect(loadProfile(storage).nickname).toBe("阿灯");
  });

  it("写头像后能读回，且不影响昵称", () => {
    const storage = createSessionStorage();
    saveProfile(storage, { nickname: "阿灯" });
    saveProfile(storage, { avatarFile: "wxfile://avatar.jpg" });
    expect(loadProfile(storage)).toEqual({
      nickname: "阿灯",
      avatarFile: "wxfile://avatar.jpg",
    });
  });

  it("只改昵称不会清掉头像（部分更新语义）", () => {
    const storage = createSessionStorage();
    saveProfile(storage, { avatarFile: "wxfile://avatar.jpg" });
    const next = saveProfile(storage, { nickname: "新名字" });
    expect(next.avatarFile).toBe("wxfile://avatar.jpg");
    expect(loadProfile(storage).avatarFile).toBe("wxfile://avatar.jpg");
  });

  it("空昵称回落默认值（不会出现空白名字）", () => {
    const storage = createSessionStorage();
    saveProfile(storage, { nickname: "阿灯" });
    const next = saveProfile(storage, { nickname: "   " });
    expect(next.nickname).toBe(DEFAULT_NICKNAME);
    expect(loadProfile(storage).nickname).toBe(DEFAULT_NICKNAME);
  });

  it("昵称首尾空格被去掉", () => {
    const storage = createSessionStorage();
    saveProfile(storage, { nickname: "  阿灯  " });
    expect(loadProfile(storage).nickname).toBe("阿灯");
  });

  it("传 avatarFile: \"\" 表示清除头像（其余字段保留）", () => {
    const storage = createSessionStorage();
    saveProfile(storage, { nickname: "阿灯", avatarFile: "wxfile://avatar.jpg" });
    const next = saveProfile(storage, { avatarFile: "" });
    expect(next).toEqual({ nickname: "阿灯" });
    expect(loadProfile(storage).avatarFile).toBeUndefined();
  });

  it("saveProfile 返回的完整值与随后 loadProfile 一致（往返）", () => {
    const storage = createSessionStorage();
    const saved = saveProfile(storage, { nickname: "阿灯", avatarFile: "wxfile://a.jpg" });
    expect(loadProfile(storage)).toEqual(saved);
  });

  it("重复写入是替换而不是叠加", () => {
    const storage = createSessionStorage();
    saveProfile(storage, { nickname: "一", avatarFile: "wxfile://a.jpg" });
    saveProfile(storage, { nickname: "二", avatarFile: "wxfile://b.jpg" });
    expect(loadProfile(storage)).toEqual({ nickname: "二", avatarFile: "wxfile://b.jpg" });
    /* 存储里只有一条记录（不是数组 / 多个键）。 */
    expect(storage.map.size).toBe(1);
  });
});

describe("本机身份：wx 侧在 node 里安全降级", () => {
  it("没有 wx 时选头像返回 null（不抛错）", async () => {
    /* node 环境没有全局 wx：这些函数必须整体短路，不能访问未定义变量。 */
    await expect(saveAvatarFile("wxfile://temp.jpg", "")).resolves.toBe(null);
  });

  it("空临时路径直接返回 null", async () => {
    await expect(saveAvatarFile("", "")).resolves.toBe(null);
  });

  it("删除空路径是空操作（不抛错）", () => {
    expect(() => deleteAvatarFile("")).not.toThrow();
  });
});
