#!/usr/bin/env node
/**
 * 第五轮（#85 / #90–#101）的模拟器验收：**灯组页**。
 *
 * 锁的是「只有渲染层能发现」的问题：
 *  1. 主题全局同步（切深色后任意页面 / 导航栏 / tabBar 同时换色）；
 *  2. 设备页精简后没有状态栏、灯组卡片单列、长按菜单；
 *  3. 灯组页：拨盘 / 固定三套方案 / 一行式灯效 / 无「应用并播放」；
 *  4. 进阶页：时间轴标题 + 步骤气泡 + 循环三档 + 背景层 / 特效层；
 *  5. 分区预览条按分区颜色画出每一颗灯珠；
 *  6. 点击后**设备状态真的变了**（不是只改 data）。
 *
 * 用法：微信开发者工具打开本项目并开启自动化端口（默认 9501）。
 *   node scripts/verify-v5.mjs
 *   端口不是 9501 时：WS=ws://127.0.0.1:9502 node scripts/verify-v5.mjs
 *   只探测端口：node scripts/verify-v5.mjs --probe
 *
 * 为什么住在 scripts/ 而不是 miniprogram/.auto/：`.auto/` 整个在 .gitignore 里，
 * 换台机器 clone 下来这 49 项回归就不存在了——而它是唯一能发现白屏与事件全失效的一层。
 * 这里与真机探针、串口工具同类：都是「需要外部环境」的脚本。
 *
 * 退出码（供编排器 `scripts/test-run.mjs` 的 ui 层解析）：
 *   0 全部断言通过，或环境缺失（缺自动化端口）
 *   1 有断言失败
 * 环境缺失**不是失败**：开发工具没开是常态，编排器要把它记成 SKIP 并写明原因。
 */
import { createRequire } from "node:module";
import net from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
/* 仓库根：scripts -> 仓库根。所有路径都从这里推，不依赖 cwd。 */
const REPO = resolve(HERE, "..");

const PORT = process.env.WS || "ws://127.0.0.1:9501";
/* 探测超时要短到不会让人以为卡住，又要长到不会把「刚启动还没就绪」误判成「没开」。
   3 秒：开发者工具的 ws 端口要么立刻接受连接，要么本机直接 ECONNREFUSED。 */
const PROBE_TIMEOUT_MS = 3000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 缺环境时的固定前缀：编排器只认这一行，不看别的。 */
const skipLine = (reason) => `SKIPPED: ${reason}`;

/**
 * 探测自动化端口是否可连。
 * 只做 TCP 连接，不握手、不跑断言——目的是「代价小到可以每次都探」。
 * 返回空数组表示可连，否则返回一条原因。
 */
function probeAutomationPort(endpoint, timeoutMs = PROBE_TIMEOUT_MS) {
  return new Promise((resolvePromise) => {
    let host = "127.0.0.1";
    let port = 9501;
    try {
      const url = new URL(endpoint);
      host = url.hostname || host;
      port = Number(url.port) || port;
    } catch {
      resolvePromise([`自动化端口地址无法解析：${endpoint}`]);
      return;
    }

    const socket = net.connect({ host, port });
    let settled = false;
    const finish = (reasons) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolvePromise(reasons);
    };

    const timer = setTimeout(() => finish([`缺微信开发者工具自动化端口（${endpoint} ${timeoutMs}ms 内没连上）`]), timeoutMs);
    socket.once("connect", () => {
      clearTimeout(timer);
      finish([]);
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      finish([`缺微信开发者工具自动化端口（${endpoint}：${error.code ?? error.message}）`]);
    });
  });
}

/* ---------------- 只探测，不跑断言 ---------------- */

/* 编排器的 ui 层用这一支做「主动探测」：真的握手一次再断开，不跑 49 项断言，
   所以探测的代价与断言数无关。
   为什么不能只做 TCP 连接：端口开着但窗口没开「自动化」模式时 TCP 连得上、
   WebSocket 握手却失败。只测 TCP 会让 probe 说「可连」、run 立刻 SKIP——
   同一份环境得出两个结论，报告就自相矛盾了。
   退出码在这里也保持「0 = 没有断言失败」：不通不是失败，是缺环境。 */
if (process.argv.includes("--probe")) {
  const reasons = await probeAutomationPort(PORT);
  if (reasons.length > 0) {
    console.log(skipLine(reasons.join("、")));
    process.exit(0);
  }
  try {
    const requireFromMp = createRequire(resolve(REPO, "miniprogram", "package.json"));
    const probeMod = requireFromMp("miniprogram-automator");
    const probeAutomator = probeMod.default ?? probeMod;
    const connection = await probeAutomator.connect({ wsEndpoint: PORT });
    await connection.disconnect();
    console.log(`PORT: ${PORT} 可连`);
  } catch (error) {
    console.log(skipLine(`缺微信开发者工具自动化端口（${PORT}：${String(error.message ?? error)}）`));
  }
  process.exit(0);
}

/* ---------------- 正常验收 ---------------- */

/* 先探测再连接：连不上时报「缺环境」而不是抛栈，编排器才不会把常态当失败。
   真正连接仍可能失败（端口开但窗口没开自动化模式），那种也归为缺环境。 */
const missing = await probeAutomationPort(PORT);
if (missing.length > 0) {
  console.log(skipLine(missing.join("、")));
  process.exit(0);
}

/* automator 只在确认端口通之后才加载。
   为什么延后：本脚本住在 miniprogram/ 之外，裸包名得从它的 package.json 起解析
   （与 `.zcode/skills/verify-lumen/scripts/drive.mjs` 同一做法）；而 clean clone
   还没 `npm install` 时模块不存在。先把「缺端口」这条最常见的原因报出去，
   否则一个没装依赖的 clone 会把 ui 层变成硬失败而不是 SKIP。 */
let automator;
try {
  const requireFromMp = createRequire(resolve(REPO, "miniprogram", "package.json"));
  const automatorMod = requireFromMp("miniprogram-automator");
  automator = automatorMod.default ?? automatorMod;
} catch (error) {
  console.log(skipLine(`缺 miniprogram-automator（在 miniprogram/ 下跑 npm install）：${String(error.message ?? error)}`));
  process.exit(0);
}

let mp;
try {
  mp = await automator.connect({ wsEndpoint: PORT });
} catch (error) {
  console.log(skipLine(`缺微信开发者工具自动化端口（${PORT}：${String(error.message ?? error)}）`));
  process.exit(0);
}

let pass = 0;
let fail = 0;
const rec = (name, ok, detail = "") => {
  ok ? pass++ : fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
};

const pageState = () =>
  mp.evaluate(() => {
    const p = getCurrentPages().pop();
    return p ? { route: p.route, data: p.data } : null;
  });

const textOf = async () => {
  const pages = await mp.currentPage().then((p) => p.$$(".page"));
  if (pages.length === 0) {
    return "";
  }
  return pages[0].outerWxml();
};

/** 连上第一台演示设备（并把首页回到正常态）。 */
async function connectDemo() {
  await mp.reLaunch("/pages/home/home");
  await sleep(1600);
  await mp.evaluate(async () => {
    const p = getCurrentPages().pop();
    if (p.session.linkState !== "ready") {
      await p.session.connect("A4:CF:12:9B:3E:01", "客厅");
    }
  });
  await sleep(1800);
}

// ---------------- 0. 启动 ----------------
let boot = null;
try {
  boot = await pageState();
} catch (err) {
  boot = { error: String(err) };
}
rec("小程序启动、页面已注册", boot !== null && boot.error === undefined, boot?.error ?? "");

// ---------------- 1. 主题：切深色后三处同时换色（#90） ----------------
await mp.switchTab("/pages/me/me");
await sleep(1200);
await mp.evaluate(() => {
  const p = getCurrentPages().pop();
  p.onThemeTap({ currentTarget: { dataset: { value: "dark" } } });
});
await sleep(600);
const meDark = await pageState();
rec(
  "「我的」页切深色后根节点是 theme-dark",
  String(meDark?.data?.themeClass ?? "") === "theme-dark",
  meDark?.data?.themeClass ?? "",
);
rec(
  "tabBar 同时换色",
  (await mp.evaluate(() => {
    const p = getCurrentPages().pop();
    const bar = typeof p.getTabBar === "function" ? p.getTabBar() : null;
    return bar === null || bar === undefined ? "" : bar.data.themeClass;
  })) === "theme-dark",
);
await mp.switchTab("/pages/home/home");
await sleep(1200);
const homeDark = await pageState();
rec(
  "回到首页也是深色（页面显示时重读）",
  String(homeDark?.data?.themeClass ?? "") === "theme-dark",
  homeDark?.data?.themeClass ?? "",
);
rec(
  "原生滑块的激活色是深色主题色",
  String(homeDark?.data?.accentColor ?? "").toUpperCase() === "#8FA9C4",
  homeDark?.data?.accentColor ?? "",
);
const navDark = await mp.evaluate(() => {
  const p = getCurrentPages().pop();
  const pages = p.selectAllComponents ? null : null;
  return null;
});
void navDark;
const homeText = await textOf();
rec("导航栏组件挂上了 use-dark", homeText.includes("nav-root use-dark"));
// 复位浅色
await mp.switchTab("/pages/me/me");
await sleep(800);
await mp.evaluate(() => {
  const p = getCurrentPages().pop();
  p.onThemeTap({ currentTarget: { dataset: { value: "light" } } });
});
await sleep(500);

// ---------------- 2. 首页（#93） ----------------
await mp.switchTab("/pages/home/home");
await sleep(1200);
const home0 = await pageState();
rec(
  "首页右上角是加号（不是「发现」文字）",
  (await textOf()).includes('<text class="nav-action">+</text>'),
);
rec("首页有搜索框", (await mp.currentPage().then((p) => p.$$(".searchbar"))).length === 1);
rec(
  "大卡上没有「封面」按钮",
  (await mp.currentPage().then((p) => p.$$(".hero-cover-btn"))).length === 0,
);
rec(
  "大卡亮度是可拖滑条",
  (await mp.currentPage().then((p) => p.$$(".hero-slider"))).length === 1,
);
// 搜索过滤
const searchHit = await mp.evaluate(() => {
  const p = getCurrentPages().pop();
  const name = (p.data.cards || [])[0].name;
  p.onQueryInput({ detail: { value: name.slice(0, 1) } });
  return { searching: p.data.searching, hits: (p.data.searchResults || []).length, name };
});
await sleep(400);
rec("搜索框按名称过滤", searchHit.searching === true && searchHit.hits >= 1, JSON.stringify(searchHit));
await mp.evaluate(() => {
  getCurrentPages().pop().onQueryClear();
});
await sleep(300);
// 长按菜单
await mp.evaluate(() => {
  const p = getCurrentPages().pop();
  p.onCardLongPress({ currentTarget: { dataset: { key: p.data.current.key } } });
});
await sleep(500);
rec(
  "长按大卡弹出五项菜单",
  (await mp.currentPage().then((p) => p.$$(".sheet-item"))).length === 5,
  `${(await mp.currentPage().then((p) => p.$$(".sheet-item"))).length}`,
);
await mp.evaluate(() => {
  getCurrentPages().pop().onMenuClose();
});
await sleep(300);

// ---------------- 3. 设备页（#94） ----------------
await connectDemo();
const devicePage = await mp.navigateTo("/pages/device/device?key=A4%3ACF%3A12%3A9B%3E%3A01");
await devicePage.waitFor(600);
await sleep(2000);
const dev = await pageState();
if (dev.route !== "pages/device/device") {
  await mp.navigateTo("/pages/device/device?key=A4%3ACF%3A12%3A9B%3E%3A01");
  await sleep(2200);
}
rec("设备页打开", (await pageState()).route === "pages/device/device", (await pageState()).route);
rec("没有整条「已连接」状态栏", (await mp.currentPage().then((p) => p.$$(".statusbar"))).length === 0);
rec("灯组卡片一列排布", (await mp.currentPage().then((p) => p.$$(".strip-list"))).length === 1);
rec("每张卡片有封面", (await mp.currentPage().then((p) => p.$$(".strip-cover"))).length >= 1);

// ---------------- 4. 灯组页：简单档（#95 / #96 / #97） ----------------
await mp.navigateTo("/pages/strip/strip?strip=0");
await sleep(2600);
const strip = await pageState();
rec("灯组页打开", strip.route === "pages/strip/strip", strip.route);
rec(
  "标题右侧是灯珠数胶囊",
  (await mp.currentPage().then((p) => p.$$(".led-capsule"))).length === 1,
);
rec(
  "没有独立的灯珠数滑块区块",
  (await mp.currentPage().then((p) => p.$$(".led-count-slider"))).length === 0,
);
rec(
  "方案恰好三个圆形按钮",
  (await mp.currentPage().then((p) => p.$$(".plan-circle"))).length === 3,
  `${(await mp.currentPage().then((p) => p.$$(".plan-circle"))).length}`,
);
rec("没有新增 / 删除方案入口", (await mp.currentPage().then((p) => p.$$(".plan-action"))).length === 0);
rec("简单档是一行式灯效（没有色块网格）", (await mp.currentPage().then((p) => p.$$(".quick-card"))).length === 0);
rec(
  "简单档有一个「灯效」行",
  (await mp.currentPage().then((p) => p.$$(".effect-row"))).length === 1,
);
const stripText = await textOf();
rec("页面上没有「应用并播放」按钮", !stripText.replace(/<!--[\s\S]*?-->/g, "").includes("应用并播放"));

// 拨盘
const dial = await mp.evaluate(() => {
  const p = getCurrentPages().pop();
  p.onLedCapsuleLongPress();
  return { open: p.data.dialOpen, ticks: (p.data.dialTicks || []).length, value: p.data.dialValue };
});
await sleep(500);
rec("长按胶囊弹出圆盘", dial.open === true);
rec("圆盘刻度 1–100", dial.ticks === 100, `${dial.ticks}`);
await mp.evaluate(() => {
  getCurrentPages().pop().onDialClose();
});
await sleep(300);

// 一行式：滚轮选灯效 → 立即生效
const picked = await mp.evaluate(async () => {
  const p = getCurrentPages().pop();
  p.onEffectRowTap();
  const open = p.data.effectWheelOpen;
  const count = (p.data.effectOptions || []).length;
  p.onEffectPick({ currentTarget: { dataset: { id: "heartbeat" } } });
  const selected = p.effectId;
  await new Promise((resolve) => setTimeout(resolve, 3200));
  return { open, count, selected, hint: p.data.quickHint, type: p.segmentReports[0] && p.segmentReports[0].layer0.type };
});
rec("点灯效行弹出滚轮", picked.open === true);
rec("滚轮有八个灯效", picked.count === 8, `${picked.count}`);
rec("选中立刻生效", picked.selected === "heartbeat", picked.selected);
rec("设备真的收到心跳（0x05）", picked.type === 0x05, `0x${(picked.type || 0).toString(16)}`);

// ---------------- 5. 进阶档（#99 / #100 / #97） ----------------
await mp.evaluate(() => {
  const p = getCurrentPages().pop();
  p.onModeTap({ currentTarget: { dataset: { mode: "advanced" } } });
});
await sleep(1600);
const adv = await pageState();
rec("切到进阶档", adv.data.mode === "advanced", adv.data.mode);
rec("时间轴标题放大（有 subtitle 元素）", (await mp.currentPage().then((p) => p.$$(".timeline-sub"))).length === 1);
rec("没有「删步骤」按钮", !(await textOf()).replace(/<!--[\s\S]*?-->/g, "").includes("删步骤"));
rec("循环三档存在", (await mp.currentPage().then((p) => p.$$(".loop-option"))).length === 3);
rec("时间轴不在卡片里", (await mp.currentPage().then((p) => p.$$(".section.timeline-section"))).length === 0);
rec("有步骤气泡", (await mp.currentPage().then((p) => p.$$(".step-bubble"))).length === 1);
rec("气泡有指向选中块的箭头", (await mp.currentPage().then((p) => p.$$(".bubble-arrow"))).length === 1);

// 选中一个分区 → 背景层 / 特效层 / 预览
const layers = await mp.evaluate(() => {
  const p = getCurrentPages().pop();
  const zones = p.currentZones();
  if (zones[0]) {
    p.onBubbleZoneTap({ currentTarget: { dataset: { segId: zones[0].segId } } });
  }
  return { zones: zones.length };
});
await sleep(900);
const advText = (await textOf()).replace(/<!--[\s\S]*?-->/g, "");
rec("有「背景层」", advText.includes("背景层"));
rec("有「特效层」", advText.includes("特效层"));
rec("没有「叠加效果」区块", !advText.includes("叠加效果"));
rec("没有「相乘」", !advText.includes("相乘"));
rec("界面里没有「熄灭」", !advText.includes("熄灭"));
rec("界面里没有「光区」", !advText.includes("光区"));
rec("界面里有「分区」", advText.includes("分区"));

// 预览条
const preview = await mp.evaluate(() => {
  const p = getCurrentPages().pop();
  p.onPreviewToggle();
  return { open: p.data.previewOpen, leds: (p.data.previewLeds || []).length, ledCount: p.currentLedCount() };
});
await sleep(500);
rec("预览条打开", preview.open === true && preview.leds > 0, JSON.stringify(preview));
rec("预览条逐颗画灯珠", preview.leds === preview.ledCount, `${preview.leds}/${preview.ledCount}`);
rec("预览条节点已渲染", (await mp.currentPage().then((p) => p.$$(".preview-strip"))).length === 1);
await mp.evaluate(() => {
  getCurrentPages().pop().onPreviewToggle();
});

// 循环切换 → 草稿真的变
const loop = await mp.evaluate(async () => {
  const p = getCurrentPages().pop();
  p.onLoopTap({ currentTarget: { dataset: { value: 2 } } });
  await new Promise((resolve) => setTimeout(resolve, 1200));
  const after = p.currentDraft().loop;
  p.onLoopTap({ currentTarget: { dataset: { value: 0 } } });
  return { after };
});
rec("循环切到最后一步循环（草稿真的改）", loop.after === 2, `loop=${loop.after}`);
await sleep(1200);

// ---------------- 6. 深色主题下灯组页仍正常（#90） ----------------
await mp.switchTab("/pages/me/me");
await sleep(900);
await mp.evaluate(() => {
  const p = getCurrentPages().pop();
  p.onThemeTap({ currentTarget: { dataset: { value: "dark" } } });
});
await sleep(500);
await mp.switchTab("/pages/home/home");
await sleep(900);
await mp.navigateTo("/pages/device/device?key=A4%3ACF%3A12%3A9B%3E%3A01");
await sleep(1800);
rec(
  "深色下设备页也是 theme-dark",
  String((await pageState())?.data?.themeClass ?? "") === "theme-dark",
  (await pageState())?.data?.themeClass ?? "",
);
// 复位浅色 + 回到首页
await mp.switchTab("/pages/me/me");
await sleep(700);
await mp.evaluate(() => {
  const p = getCurrentPages().pop();
  p.onThemeTap({ currentTarget: { dataset: { value: "light" } } });
});
await sleep(400);
await mp.switchTab("/pages/home/home");

console.log(`\n===== ${pass} passed / ${fail} failed =====`);
await mp.disconnect();
process.exit(fail === 0 ? 0 : 1);
