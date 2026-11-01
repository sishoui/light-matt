/**
 * `wx.login` 接缝（#47）：把一次性的登录 code 取回来交给会话层。
 *
 * 为什么单独一个文件：
 *  - `device-api.ts` 是纯逻辑（node 单测里零 wx 依赖），code 来源必须从外面注入；
 *  - 约定**永不抛错**：wx.login 失败（未授权 / 网络 / 基础库不支持）统一返回
 *    `null`，会话层据此显式回落到 local 身份，而不是让异常冒到页面。
 *
 * 只在函数内部碰 wx，import 时零副作用（node 里 import 不会炸）。
 */

import type { LoginCodeFetcher } from "./device-api";

/** 取一次登录 code；拿不到返回 null。 */
export function createWxLoginCode(): LoginCodeFetcher {
  return () =>
    new Promise<string | null>((resolve) => {
      if (typeof wx === "undefined" || typeof wx.login !== "function") {
        resolve(null);
        return;
      }
      try {
        wx.login({
          success: (res) => {
            const code = typeof res.code === "string" ? res.code.trim() : "";
            /* 空 code 等同于失败：后端会把空串当无效 code 拒掉。 */
            resolve(code.length > 0 ? code : null);
          },
          /* 用户取消 / 网络失败 / 平台不支持：都是「这次没有 code」。 */
          fail: () => resolve(null),
        });
      } catch {
        resolve(null);
      }
    });
}
