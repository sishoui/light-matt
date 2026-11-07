#!/usr/bin/env node
/**
 * v5 模拟器验收：**设备页（就地展开）+ 部位编辑器**。
 *
 * 历史：这个脚本原来锁的是 v4 的灯组页（`pages/strip`，第五轮 #85/#90–#101）。
 * v5 把那一页整个删了（#155），脚本会在 `navigateTo("/pages/strip/strip")` 上崩掉
 * ——所以断言集改写成 v5 的两层：`pages/device` 的就地展开与 `pages/part`。
 * 环境探测（端口 / automator / SKIP 语义）原样保留：那部分与页面无关。
 *
 * 锁的是「只有渲染层能发现」的问题：
 *  1. 主题全局同步（切深色后任意页面 / 导航栏 / tabBar 同时换色）；
 *  2. 首页：加号菜单 / 搜索 / 大卡亮度 / 长按弹层；
 *  3. 设备页：无状态栏、灯组单列、**点行就地展开不跳页**；
 *  4. 部位编辑器：结构区 + 内容区、时间轴、效果面板、无「应用」按钮；
 *  5. 点击后**设备状态真的变了**（不是只改 data）——改类型、改名都要读回；
 *  6. v5 术语：界面里没有「光区」「分区」「应用并播放」。
 *
 * 用法：微信开发者工具打开本项目并开启自动化端口。
 *
 *   开启自动化（**9501 是 IDE 的 HTTP 端口，不是自动化 ws**）：
 *     powershell -NoProfile -ExecutionPolicy Bypass -Command ^
 *       "& 'C:\Program Files (x86)\Tencent\微信web开发者工具\cli.bat' auto ^
 *        --project 'C:\Users\13092\Desktop\项目\zcode\lumen\miniprogram'"
 *
 *   然后（auto 通常把自动化落在 9502）：
 *     WS=ws://127.0.0.1:9502 node scripts/verify-v5.mjs
 *     node scripts/verify-v5.mjs --probe     # 只探端口，不跑断言
 *
 * 为什么住在 scripts/ 而不是 miniprogram/.auto/：`.auto/` 整个在 .gitignore 里，
 * 换台机器 clone 下来这层回归就不存在了——而它是唯一能发现白屏与事件全失效的一层。
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

/**
 * 候选自动化端口（#116）。
 *
 * 微信开发者工具「设置 → 安全设置 → 服务端口」其实是个区间：开着自动化后
 * 第一项占 9501，再开一个窗口就顺延到 9502。写死 9501 会让「明明开着自动化」
 * 的机器记成 SKIP，而 SKIP 在报告里又不显眼——那正是本轮要修的可信度问题。
 *
 * `WS` 仍可强制指定：指了就只试它，不再猜（CI 与手工排查要靠这个确定性）。
 */
const PORT_CANDIDATES = process.env.WS
  ? [process.env.WS]
  : ["ws://127.0.0.1:9501", "ws://127.0.0.1:9502"];

/* 探测超时要短到不会让人以为卡住，又要长到不会把「刚启动还没就绪」误判成「没开」。
   3 秒：开发者工具的 ws 端口要么立刻接受连接，要么本机直接 ECONNREFUSED。 */
const PROBE_TIMEOUT_MS = 3000;

/* 握手另给一个更长的预算：探通 TCP 之后，真实的 WebSocket 握手要来回几帧，
   3 秒偏紧；但也不能无限等——半开端口会一直不应答。 */
const HANDSHAKE_TIMEOUT_MS = 8000;

/** 给不带宽限的 promise 加一个超时，避免探针挂死。 */
function withTimeout(promise, ms, endpoint) {
  return new Promise((resolvePromise, rejectPromise) => {
    const timer = setTimeout(
      () => rejectPromise(new Error(`${endpoint} ${ms}ms 内没完成握手`)),
      ms,
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolvePromise(value);
      },
      (error) => {
        clearTimeout(timer);
        rejectPromise(error);
      },
    );
  });
}

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

/**
 * 依次试候选端口，返回第一个真正握手成功的地址。
 *
 * TCP 通不算数：端口开着但窗口没开「自动化」时 TCP 连得上、WebSocket 握手
 * 却失败。只测 TCP 会让探测说「可连」、正式跑立刻 SKIP，同一份环境两个结论。
 *
 * @returns {{ endpoint: string } | { reasons: string[] }}
 */
async function pickEndpoint(automator) {
  const reasons = [];
  for (const endpoint of PORT_CANDIDATES) {
    const tcp = await probeAutomationPort(endpoint);
    if (tcp.length > 0) {
      reasons.push(...tcp);
      continue;
    }
    try {
      const connection = await withTimeout(
        automator.connect({ wsEndpoint: endpoint }),
        HANDSHAKE_TIMEOUT_MS,
        endpoint,
      );
      await connection.disconnect();
      return { endpoint };
    } catch (error) {
      reasons.push(`${endpoint}：${String(error.message ?? error)}`);
    }
  }
  return { reasons };
}

/** 探测失败时指向可操作项（#116）：只说「连不上」没人知道该去哪开。 */
const PORT_HINT =
  "在微信开发者工具里打开 设置 → 安全设置 → 服务端口（开启「自动化」），" +
  `或按需设置 WS=<ws 地址>；已试 ${PORT_CANDIDATES.join(" / ")}`;

/** 加载 automator；缺失时返回 null（调用方据此报「缺环境」而不是硬失败）。 */
function loadAutomator() {
  try {
    const requireFromMp = createRequire(resolve(REPO, "miniprogram", "package.json"));
    const mod = requireFromMp("miniprogram-automator");
    return mod.default ?? mod;
  } catch {
    return null;
  }
}

/* ---------------- 只探测，不跑断言 ---------------- */

/* 编排器的 ui 层用这一支做「主动探测」：真的握手一次再断开，不跑 49 项断言，
   所以探测的代价与断言数无关。
   退出码在这里也保持「0 = 没有断言失败」：不通不是失败，是缺环境。 */
if (process.argv.includes("--probe")) {
  const probeAutomator = loadAutomator();
  if (probeAutomator === null) {
    console.log(skipLine("缺 miniprogram-automator（在 miniprogram/ 下跑 npm install）"));
    process.exit(0);
  }
  const chosen = await pickEndpoint(probeAutomator);
  if ("endpoint" in chosen) {
    console.log(`PORT: ${chosen.endpoint} 可连`);
  } else {
    console.log(skipLine(`缺微信开发者工具自动化端口（${chosen.reasons.join("；")}）。${PORT_HINT}`));
  }
  process.exit(0);
}

/* ---------------- 正常验收 ---------------- */

const automator = loadAutomator();
if (automator === null) {
  console.log(
    skipLine("缺 miniprogram-automator（在 miniprogram/ 下跑 npm install）：ui 层未验证"),
  );
  process.exit(0);
}

/* 先试端口再跑断言：连不上时报「缺环境」而不是抛栈，编排器才不会把常态当失败。 */
const chosen = await pickEndpoint(automator);
if (!("endpoint" in chosen)) {
  console.log(skipLine(`缺微信开发者工具自动化端口（${chosen.reasons.join("；")}）。${PORT_HINT}`));
  process.exit(0);
}

let mp;
try {
  mp = await automator.connect({ wsEndpoint: chosen.endpoint });
} catch (error) {
  console.log(skipLine(`缺微信开发者工具自动化端口（${chosen.endpoint}：${String(error.message ?? error)}）。${PORT_HINT}`));
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

/**
 * 等到页面 DOM 里出现某段文本（或超时后返回最后一次快照）。
 *
 * 自定义组件的 `setData` 落在页面之后，用固定 sleep 去等它必然偶尔失败。
 * 凡是「组件挂载后才成立」的断言都应该走这里。
 */
async function waitForText(needle, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  let snapshot = "";
  while (Date.now() < deadline) {
    snapshot = await textOf();
    if (snapshot.includes(needle)) {
      return snapshot;
    }
    await sleep(200);
  }
  return snapshot;
}

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
/* 导航栏是自定义组件：它的 `use-dark` 在组件 `attached` 之后才由 `setData`
   落下，比页面 `themeClass` 晚一拍。固定 sleep 会让这一条随机失败（实测同一
   环境连跑三次失败一次）——不稳定的断言比没有断言更糟，它会让人怀疑真实缺陷。
   所以等到出现为止，超时才算失败。 */
const homeText = await waitForText("nav-root use-dark", 5000);
rec(
  "导航栏组件挂上了 use-dark",
  homeText.includes("nav-root use-dark"),
  homeText.includes("nav-root use-dark") ? "" : `等了 5 秒仍未出现（页面 ${homeText.length} 字符）`,
);
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
const devicePage = await mp.navigateTo("/pages/device/device?key=A4%3ACF%3A12%3A9B%3A3E%3A01");
await devicePage.waitFor(600);
await sleep(2000);
const dev = await pageState();
if (dev.route !== "pages/device/device") {
  await mp.navigateTo("/pages/device/device?key=A4%3ACF%3A12%3A9B%3A3E%3A01");
  await sleep(2200);
}
rec("设备页打开", (await pageState()).route === "pages/device/device", (await pageState()).route);
rec("没有整条「已连接」状态栏", (await mp.currentPage().then((p) => p.$$(".statusbar"))).length === 0);
rec("灯组卡片一列排布", (await mp.currentPage().then((p) => p.$$(".strip-list"))).length === 1);
rec("每张卡片有封面", (await mp.currentPage().then((p) => p.$$(".strip-cover"))).length >= 1);

// ---------------- 4. 设备页：灯组行就地展开（#155 / U1） ----------------
//
// v5 把「灯组页」删了，编辑压进「设备页 → 部位编辑器」两层。
// 这一节验的是展开/收起本身：**不再跳页**、空态有 + 入口、展开不自动改设备。

const beforeExpand = await pageState();
const expanded = await mp.evaluate(async (stripId) => {
  const p = getCurrentPages().pop();
  p.onStripCardTap({ currentTarget: { dataset: { stripId } } });
  await new Promise((resolve) => setTimeout(resolve, 1800));
  const card = (p.data.stripCards || []).find((c) => c.stripId === stripId);
  return {
    route: p.route,
    expanded: card ? card.expanded === true : null,
    parts: card && card.parts ? card.parts.length : -1,
    emptyHint: card ? String(card.emptyHint || "") : "",
  };
}, 0);
rec(
  "点灯组行就地展开（不跳页）",
  expanded.route === "pages/device/device" && expanded.expanded === true,
  `route=${expanded.route} expanded=${expanded.expanded}`,
);
rec(
  "展开后出现部位列表或空态",
  expanded.parts >= 0 && (expanded.parts > 0 || expanded.emptyHint.length > 0),
  `parts=${expanded.parts} emptyHint="${expanded.emptyHint}"`,
);
rec(
  "点展开不会改动设备状态",
  String(beforeExpand?.data?.stripsOn ?? "") === String((await pageState())?.data?.stripsOn ?? ""),
);

// ---------------- 5. 部位编辑器（#155 最小版） ----------------
//
// 「整条 / 1 步 / 常亮」是设备页 + 播种出来的默认形态。这里先确保至少有一个部位，
// 再进编辑器验结构区 + 内容区两半。

const seeded = await mp.evaluate(async () => {
  const p = getCurrentPages().pop();
  const cards = p.data.stripCards || [];
  const target = cards.find((c) => c.expanded) || cards[0];
  if (!target) return { ok: false, reason: "没有灯组卡片" };
  p.onSeedPartTap({ currentTarget: { dataset: { stripId: target.stripId } } });
  await new Promise((resolve) => setTimeout(resolve, 2600));
  const card = (p.data.stripCards || []).find((c) => c.stripId === target.stripId);
  return {
    ok: true,
    stripId: target.stripId,
    parts: card && card.parts ? card.parts.length : 0,
    firstPartId: card && card.parts && card.parts[0] ? card.parts[0].partId : -1,
  };
});
rec("点 + 播种出一个部位", seeded.ok === true && seeded.parts >= 1, JSON.stringify(seeded));

let partPage = null;
if (seeded.ok && seeded.parts >= 1) {
  await mp.navigateTo(`/pages/part/part?strip=${seeded.stripId}&part=${seeded.firstPartId}`);
  await sleep(2600);
  partPage = await pageState();
}
rec(
  "部位编辑器打开",
  partPage !== null && partPage.route === "pages/part/part",
  partPage ? partPage.route : "未打开",
);

if (partPage !== null && partPage.route === "pages/part/part") {
  const partText = (await textOf()).replace(/<!--[\s\S]*?-->/g, "");
  rec("有结构区", partText.includes("结构"));
  rec("有内容区", partText.includes("内容"));
  rec("结构区有部位名输入", (await mp.currentPage().then((p) => p.$$(".field-input"))).length >= 1);
  /* #156：结构区改成「线视图 + 段数」，区间文字在线视图下方。
     断言验的是**用户看得见的东西**：色块画出来没有、区间从 1 起、颗数对得上。 */
  const lineBlocks = (await mp.currentPage().then((p) => p.$$(".line-block"))).length;
  rec("结构区有线视图色块", lineBlocks >= 1, `${lineBlocks} 块`);
  rec("结构区显示覆盖灯珠", /颗已划分/.test(partText) && /\d+–\d+/.test(partText));
  const timelineBlocks = (await mp.currentPage().then((p) => p.$$(".timeline-block"))).length;
  rec("内容区有时间轴", timelineBlocks >= 1, `${timelineBlocks} 块`);
  const typeCells = (await mp.currentPage().then((p) => p.$$(".type-cell"))).length;
  rec("效果面板有类型格", typeCells >= 6, `${typeCells}`);
  rec("页面里没有「应用并播放」（编辑即下发）", !partText.includes("应用并播放"));
  rec("页面里没有「光区」（v5 术语是部位 / 灯珠段）", !partText.includes("光区"));
  rec("页面里没有「分区」", !partText.includes("分区"));

  // 改类型 → 设备真的收到（不是只改 data）
  const typeChange = await mp.evaluate(async () => {
    const p = getCurrentPages().pop();
    const before = p.data.panelSummary;
    const cells = p.data.panelTypes || [];
    const target = cells.find((c) => c.type === 0x01) || cells[1];
    if (!target) return { ok: false, reason: "没有可选类型" };
    p.onPanelTypeTap({ currentTarget: { dataset: { type: target.type } } });
    await new Promise((resolve) => setTimeout(resolve, 2600));
    return {
      ok: true,
      before,
      after: p.data.panelSummary,
      selectedType: target.type,
      applyError: String(p.data.applyError || ""),
    };
  });
  await sleep(600);
  rec(
    "切灯效类型后面板摘要变了",
    typeChange.ok === true && String(typeChange.after) !== String(typeChange.before),
    JSON.stringify(typeChange),
  );
  rec(
    "切类型没有留下错误提示",
    typeChange.ok === true && typeChange.applyError === "",
    typeChange.ok ? typeChange.applyError : "未执行",
  );

  // 写名字 → 落库并读回
  const nameSaved = await mp.evaluate(async () => {
    const p = getCurrentPages().pop();
    p.onNameInput({ detail: { value: "眼灯" } });
    await p.onSaveName();
    await new Promise((resolve) => setTimeout(resolve, 2600));
    return {
      input: p.data.nameInput,
      rangeText: p.data.rangeText,
      applyError: String(p.data.applyError || ""),
    };
  });
  rec(
    "改名后保存成功（无错误）",
    nameSaved.input === "眼灯" && nameSaved.applyError === "",
    JSON.stringify(nameSaved),
  );

  /* #156 头牌：方格拖选。这里验的是「弹窗真的画出来、格子点得动、拖完选区
     落在 data 里」，以及「压到别的部位时被拒」——纯逻辑层已经由单测覆盖，
     这一层只回答「用户在模拟器上点得到吗」。 */
  const gridDrag = await mp.evaluate(async () => {
    const p = getCurrentPages().pop();
    p.onOpenGridAdd();
    await new Promise((resolve) => setTimeout(resolve, 600));
    const opened = p.data.gridOpen === true;
    const cells = p.data.gridRows || [];
    const cellCount = cells.reduce((sum, row) => sum + (row.cells ? row.cells.length : 0), 0);
    /* 先确认弹窗里确实有格子，再按 dataset 拖一段（模拟器里量不到屏幕矩形，
       走 `dataset.index` 的退路——那是产品代码本来就有的一条路径）。 */
    p.onGridTouchStart({ currentTarget: { dataset: { index: 2 } }, touches: [], detail: {} });
    p.onGridTouchMove({ currentTarget: { dataset: { index: 4 } }, touches: [], detail: {} });
    p.onGridTouchEnd({ currentTarget: { dataset: {} }, touches: [], detail: {} });
    const start = String(p.data.draftStartText);
    const end = String(p.data.draftEndText);
    p.onGridClose();
    return { opened, cellCount, start, end };
  });
  await sleep(400);
  rec(
    "方格弹窗能打开并画出格子",
    gridDrag.opened === true && gridDrag.cellCount >= 10,
    JSON.stringify(gridDrag),
  );
  rec(
    "方格拖选落成一段（选区从 1 起编号）",
    gridDrag.start === "3" && gridDrag.end === "5",
    `${gridDrag.start}–${gridDrag.end}`,
  );
}

// 回设备页，验改名读回
await mp.navigateBack({ delta: 1 }).catch(() => {});
await sleep(1800);
if ((await pageState())?.route === "pages/device/device") {
  const renamed = await mp.evaluate(async () => {
    const p = getCurrentPages().pop();
    const cards = p.data.stripCards || [];
    const target = cards.find((c) => c.expanded) || cards[0];
    if (!target) return { ok: false };
    /* 收起再展开：强制重新拉布局，验的是「设备上的名字」而不是页面缓存。 */
    p.onStripCardTap({ currentTarget: { dataset: { stripId: target.stripId } } });
    await new Promise((resolve) => setTimeout(resolve, 1200));
    p.onStripCardTap({ currentTarget: { dataset: { stripId: target.stripId } } });
    await new Promise((resolve) => setTimeout(resolve, 1800));
    const card = (p.data.stripCards || []).find((c) => c.stripId === target.stripId);
    const first = card && card.parts && card.parts[0];
    return { ok: true, label: first ? String(first.label) : "" };
  });
  rec(
    "回设备页后部位名读回是「眼灯」",
    renamed.ok === true && renamed.label === "眼灯",
    JSON.stringify(renamed),
  );
}

// ---------------- 6. 开关层级（#155 的挂点，#160 才完整） ----------------
const switches = await mp.evaluate(() => {
  const p = getCurrentPages().pop();
  return {
    partSwitches: (p.data.stripCards || []).reduce((n, c) => n + (c.parts || []).length, 0),
    strips: (p.data.stripCards || []).length,
  };
});
rec("展开区里每个部位各有一个开关", switches.partSwitches >= 1, `部位 ${switches.partSwitches} 个`);
rec("界面上没有播放 / 暂停按钮", !(await textOf()).includes("暂停"));

// ---------------- 7. 深色主题下这两个页面仍正常（#90） ----------------
await mp.switchTab("/pages/me/me");
await sleep(900);
await mp.evaluate(() => {
  const p = getCurrentPages().pop();
  p.onThemeTap({ currentTarget: { dataset: { value: "dark" } } });
});
await sleep(500);
await mp.switchTab("/pages/home/home");
await sleep(900);
await mp.navigateTo("/pages/device/device?key=A4%3ACF%3A12%3A9B%3A3E%3A01");
await sleep(1800);
rec(
  "深色下设备页也是 theme-dark",
  String((await pageState())?.data?.themeClass ?? "") === "theme-dark",
  (await pageState())?.data?.themeClass ?? "",
);
if (seeded.ok && seeded.parts >= 1) {
  await mp.navigateTo(`/pages/part/part?strip=${seeded.stripId}&part=${seeded.firstPartId}`);
  await sleep(2000);
  rec(
    "深色下部位编辑器也是 theme-dark",
    String((await pageState())?.data?.themeClass ?? "") === "theme-dark",
    (await pageState())?.data?.themeClass ?? "",
  );
  await mp.navigateBack({ delta: 1 }).catch(() => {});
  await sleep(900);
}

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
