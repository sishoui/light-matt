#!/usr/bin/env node
/**
 * doctor：只读检查「这个自动化实例值不值得驱动」。
 *
 *   node .zcode/skills/verify-lumen/scripts/doctor.mjs
 *   WS=ws://127.0.0.1:9501 node .zcode/skills/verify-lumen/scripts/doctor.mjs
 *
 * 它不改任何状态：不连设备、不写存储、不切主题。任何一项是 NO 都说明
 * 后续断言的结果不可信，先修环境再驱动。
 */
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../../../..");
const requireFromMp = createRequire(join(REPO, "miniprogram", "package.json"));
const automatorMod = requireFromMp("miniprogram-automator");
const automator = automatorMod.default ?? automatorMod;

const WS = process.env.WS || "ws://127.0.0.1:9502";
const KNOWN_ROUTES = [
  "pages/home/home",
  "pages/me/me",
  "pages/discover/discover",
  "pages/device/device",
  "pages/device-info/device-info",
  "pages/strip/strip",
];

let bad = 0;
const check = (name, ok, detail = "") => {
  if (!ok) bad++;
  console.log(`${ok ? "OK  " : "NO  "} ${name}${detail ? "  — " + detail : ""}`);
};

console.log(`endpoint: ${WS}\n`);

let mp = null;
try {
  mp = await automator.connect({ wsEndpoint: WS });
  check("自动化端口可连接", true);

  const info = await mp.evaluate(() => {
    const pages = getCurrentPages();
    const p = pages[pages.length - 1];
    /* 存储里的设备列表是 JSON 字符串（`loadRecentDevices` 自己 parse），
     * 所以数的是「首页渲染出的卡片」，那才是用户看得见的东西。 */
    let cards = [];
    try {
      cards = (wx.getStorageSync("lumen.recentDevices.v2") || "");
      cards = typeof cards === "string" ? JSON.parse(cards) : cards;
    } catch {
      cards = [];
    }
    return {
      route: p ? p.route : null,
      stack: pages.length,
      hasSession: !!(p && p.session),
      busy: p && p.data ? p.data.busy : undefined,
      recentCount: Array.isArray(cards) ? cards.length : 0,
      theme: wx.getStorageSync("lumen.theme.v1") || null,
      mock: wx.getStorageSync("lumen.mockMode.v1"),
    };
  });

  check("页面栈非空（小程序已启动）", info.stack > 0, `stack=${info.stack}`);
  check("当前页是仓库里的已知路由", KNOWN_ROUTES.includes(info.route), String(info.route));
  check("页面挂上了 session（启动链没崩）", info.hasSession === true);
  check("首页有设备可用（演示或真机）", info.recentCount > 0, `${info.recentCount} 台；mock 偏好=${String(info.mock)}`);
  /* 首页的 busy 是「电源键还能不能用」的开关，只有 onPowerTap 的 finally 会清它。
   * 卡住时电源键静默返回——这是本项目已知的脆弱点，所以单独报出来。 */
  check(
    "首页不处于卡住的忙碌态",
    info.route !== "pages/home/home" || info.busy !== true,
    info.busy === true ? "busy=true：电源键会静默返回；reLaunch 首页可复位" : `busy=${String(info.busy)}`,
  );
  check("主题存储取值合法", info.theme === null || info.theme === "light" || info.theme === "dark", String(info.theme));

  console.log(
    bad === 0
      ? "\n值得驱动：全部前置条件满足。"
      : `\n先修上面 ${bad} 项，再驱动；否则断言结果不可信。`,
  );
} catch (e) {
  console.log(`NO  连不上 ${WS}\n     ${String(e).slice(0, 200)}`);
  console.log(
    "\n端口没开时先启动自动化会话（关键参数是 --auto-port）：\n" +
      '  "C:/Program Files (x86)/Tencent/微信web开发者工具/cli.bat" agent start \\\n' +
      '    --project "<仓库>/miniprogram" --port 9420 --auto-port 9502',
  );
  bad = bad || 1;
} finally {
  if (mp !== null) {
    try {
      await mp.disconnect();
    } catch {
      /* ignore */
    }
  }
}
process.exit(bad === 0 ? 0 : 1);
