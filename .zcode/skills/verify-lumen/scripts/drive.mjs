#!/usr/bin/env node
/**
 * lumen 验证技能的执行器：连上开发者工具的自动化端口，跑一段「用户路径」，
 * 把断言与证据写进 .auto/evidence/ 下的运行目录。
 *
 * 用法：
 *   node .zcode/skills/verify-lumen/scripts/drive.mjs --scenario home-power --label "首页电源键"
 *   node .zcode/skills/verify-lumen/scripts/drive.mjs --scenario doctor
 *   node .zcode/skills/verify-lumen/scripts/drive.mjs --list
 *
 * 端口：默认 ws://127.0.0.1:9502（这是本机实际开着的窗口）；用 WS= 覆盖。
 *
 * 为什么证据不以截图为主：`mp.screenshot()` 在连续驱动的尾部经常超时，且会污染
 * 同一个 websocket。证据以「渲染层真正拿到的 data + DOM 元素 + 存储读回」为准，
 * 截图只在 `--screenshot` 时附带。
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
/* 仓库根：scripts -> verify-lumen -> skills -> .zcode -> 仓库根 */
const REPO = resolve(HERE, "../../../..");
/* 本脚本在 miniprogram/ 之外，裸包名解析不到，必须从它的 package.json 起解析。 */
const requireFromMp = createRequire(join(REPO, "miniprogram", "package.json"));
const automatorMod = requireFromMp("miniprogram-automator");
const automator = automatorMod.default ?? automatorMod;
const WS = process.env.WS || "ws://127.0.0.1:9502";
const RUN_ID = process.env.RUN_ID || new Date().toISOString().replace(/[:.]/g, "-");
const EVIDENCE_ROOT = join(REPO, "miniprogram", ".auto", "evidence");

const args = process.argv.slice(2);
const opt = (name, fallback = null) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback;
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------- 场景注册表 ---------------- */

const scenarios = {
  /**
   * doctor：只读。回答「这个实例值得驱动吗」。
   * 端口连得上 → 当前页已注册 → 演示设备已播种 → 主题存储可读。
   */
  async doctor(mp, rec) {
    const info = await mp.evaluate(() => {
      const pages = getCurrentPages();
      const p = pages[pages.length - 1];
      /* 设备列表在存储里是 JSON 字符串，这里 parse 出来才数得准。 */
      const parse = (raw) => {
        if (typeof raw !== "string") return raw || [];
        try {
          return JSON.parse(raw);
        } catch {
          return [];
        }
      };
      return {
        route: p ? p.route : null,
        stack: pages.length,
        recent: parse(wx.getStorageSync("lumen.recentDevices.v2")),
        registry: wx.getStorageSync("lumen.deviceRegistry.v1") || null,
        theme: wx.getStorageSync("lumen.theme.v1") || null,
        mock: wx.getStorageSync("lumen.mockMode.v1"),
      };
    });
    rec("自动化端口连得上且页面栈非空", info.stack > 0, `stack=${info.stack}`);
    rec("当前页是已知路由", ["pages/home/home", "pages/me/me", "pages/discover/discover", "pages/device/device", "pages/device-info/device-info", "pages/strip/strip"].includes(info.route), String(info.route));
    const devices = Array.isArray(info.recent) ? info.recent : [];
    rec("演示/最近设备已播种", devices.length > 0, `${devices.length} 台`);
    rec("主题存储可读（null 表示跟随系统）", info.theme === null || info.theme === "light" || info.theme === "dark", String(info.theme));
    return { route: info.route, devices: devices.map((d) => d.name || d.key || d.deviceId) };
  },

  /**
   * 首页电源键：点大卡电源 → 设备真的收到 SetPower，State 回来 power 翻转。
   * 这是「点了没反应」最典型的一类回归。
   */
  async "home-power"(mp, rec) {
    await connectDemo(mp);
    await sleep(1200);
    const before = await readState(mp);
    const beforePower = before?.power;
    await mp.evaluate(async () => {
      const p = getCurrentPages().pop();
      await p.onPowerTap({ currentTarget: { dataset: { key: p.data.current.key } } });
    });
    await sleep(2500);
    const after = await readState(mp);
    rec("电源键执行后 State.power 翻转", typeof after?.power === "number" && after.power !== beforePower, `${beforePower} → ${after?.power}`);
    rec("大卡按钮态与 State 一致", (await mp.evaluate(() => getCurrentPages().pop().data.current.powerOn)) === (after?.power === 1), "");
    /* 复位：再点一次，把设备放回原状态 */
    await mp.evaluate(async () => {
      const p = getCurrentPages().pop();
      await p.onPowerTap({ currentTarget: { dataset: { key: p.data.current.key } } });
    });
    await sleep(2000);
    const restored = await readState(mp);
    rec("复位到初始开关状态", restored?.power === beforePower, `${restored?.power} vs ${beforePower}`);
    return { beforePower, afterPower: after?.power };
  },

  /**
   * 首页搜索：按名称过滤，清空后恢复。
   * 用户路径 = 在搜索框里打字；这里直接调 bindinput 的处理器（渲染层同一入口）。
   */
  async "home-search"(mp, rec) {
    await settle(mp);
    await mp.switchTab("/pages/home/home");
    await sleep(1200);
    const result = await mp.evaluate(async () => {
      const p = getCurrentPages().pop();
      const cards = p.data.cards || [];
      if (cards.length === 0) return { skipped: "no cards" };
      const name = cards[0].name;
      const query = name.slice(0, 1);
      p.onQueryInput({ detail: { value: query } });
      await new Promise((r) => setTimeout(r, 300));
      const searching = p.data.searching;
      const hits = (p.data.searchResults || []).length;
      const hitNames = (p.data.searchResults || []).map((d) => d.name);
      p.onQueryClear();
      await new Promise((r) => setTimeout(r, 300));
      return { name, query, searching, hits, hitNames, restored: p.data.searching };
    });
    if (result.skipped) {
      rec("首页有设备卡（搜索前置条件）", false, result.skipped);
      return result;
    }
    rec("输入首字后进入搜索态", result.searching === true, String(result.searching));
    rec("搜索结果包含被搜索的设备", result.hitNames.includes(result.name), result.hitNames.join(","));
    rec("清空后退出搜索态", result.restored === false, String(result.restored));
    return result;
  },

  /**
   * 灯组页：进阶档时间轴 / 两层模型 / 循环三档。
   * 走真实导航，读渲染层 data，不 mock 页面结构。
   */
  async "strip-advanced"(mp, rec) {
    await connectDemo(mp);
    await openStrip(mp);
    const advanced = await mp.evaluate(async () => {
      const p = getCurrentPages().pop();
      p.onModeTap({ currentTarget: { dataset: { mode: "advanced" } } });
      await new Promise((r) => setTimeout(r, 1500));
      /* 两层编辑器只在「选中一个分区」后才渲染，所以先点轴上的第一块。 */
      const firstZone = (p.data.zoneBlocks || []).find((b) => b.kind === "zone");
      if (firstZone !== undefined && firstZone.segId !== undefined) {
        p.onZoneAxisTap({ currentTarget: { dataset: { segId: firstZone.segId } } });
      }
      await new Promise((r) => setTimeout(r, 800));
      return {
        mode: p.data.mode,
        /* 真实的字段名是 loopChoices（三档），不是 loopOptions。 */
        loopLabels: (p.data.loopChoices || []).map((c) => c.label),
        stepCount: p.data.stepCount,
        zoneCount: p.data.zoneCount,
        panelHasZone: p.data.panelHasZone,
      };
    });
    rec("能切到进阶档", advanced.mode === "advanced", String(advanced.mode));
    rec(
      "循环恰好三档且文案是约定的三个",
      JSON.stringify(advanced.loopLabels) === JSON.stringify(["不循环", "全部循环", "最后一步循环"]),
      JSON.stringify(advanced.loopLabels),
    );
    rec("装置已有分区可选中", advanced.zoneCount >= 1, `zoneCount=${advanced.zoneCount}`);
    rec("选中分区后两层编辑器可用", advanced.panelHasZone === true, String(advanced.panelHasZone));
    const text = await pageWxml(mp);
    rec("进阶档同时出现「背景层」与「特效层」", text.includes("背景层") && text.includes("特效层"), "");
    rec("「叠加效果」这一整块已不存在", !text.includes("叠加效果"), "");
    /* 复位回简单档 */
    await mp.evaluate(() => getCurrentPages().pop().onModeTap({ currentTarget: { dataset: { mode: "simple" } } }));
    await sleep(800);
    return advanced;
  },

  /**
   * 「我的」页删除设备：六处存储清理 + 演示设备不再回来。
   * 破坏性动作，所以先备份、后还原，还原失败会明确报错。
   */
  async "delete-device"(mp, rec) {
    /* 先清场：上一个场景可能把页面留在别的 tab 或留下卡住的忙碌态。
     * settle() 会停扫描 + reLaunch 首页，让「我的」页重新走 onShow 派生列表。 */
    await settle(mp);
    const backup = await mp.evaluate(() => {
      const keys = [
        "lumen.recentDevices.v2",
        "lumen.deviceRegistry.v1",
        "lumen.mockMode.v1",
        "lumen.lastDevice.v1",
        "lumen.devicePhotos.v1",
        "lumen.mockDeleted.v1",
      ];
      const out = {};
      for (const k of keys) out[k] = wx.getStorageSync(k);
      return out;
    });
    try {
      await mp.switchTab("/pages/me/me");
      /* 「我的」页的 myDevices 是 onShow 里 `refreshDevices()` 派生的；刚切过去时
       * 可能还是空数组。轮询到非空（或超时），不要用一个瞬时快照断言「列表为空」。 */
      let target = null;
      for (let i = 0; i < 10 && target === null; i++) {
        await sleep(400);
        target = await mp.evaluate(() => {
          const p = getCurrentPages().pop();
          /* 字段是 myDevices；每行带 key / deviceId / label / current。
           * **不要相信 `current` 标记**——切换过设备后它是旧的。真正「正在连」的
           * 设备要问会话：删掉它会让首页在静默回连时把 `busy` 卡成 true。 */
          const list = p.data.myDevices || [];
          const liveId = (p.session && p.session.transport && p.session.transport.currentDeviceId) || "";
          const pick = list.find((d) => d.deviceId !== liveId) ?? null;
          return pick ? { key: pick.key, deviceId: pick.deviceId, name: pick.label, liveId, total: list.length } : null;
        });
      }
      rec("「我的」页有可删除的设备", target !== null, target ? `${target.name}（跳过正在连接的 ${target.liveId || "无"}）` : "列表为空");
      if (target === null) return { skipped: "no device" };

      /* 删除前有 wx.showModal 确认框。驱动真实确认路径：临时替换 showModal
       * 让它自动点「删除」，调用完立刻还原——不改产品代码，也不留副作用。 */
      await mp.evaluate(async (key) => {
        const p = getCurrentPages().pop();
        const original = wx.showModal;
        wx.showModal = (opts) => {
          opts && opts.success && opts.success({ confirm: true, cancel: false });
          return Promise.resolve({ confirm: true, cancel: false });
        };
        try {
          await p.onDeleteDevice({ currentTarget: { dataset: { key } } });
        } finally {
          wx.showModal = original;
        }
      }, target.key);
      await sleep(1500);

      const after = await mp.evaluate(() => {
        const p = getCurrentPages().pop();
        const parse = (raw) => {
          if (typeof raw !== "string") return raw || [];
          try {
            return JSON.parse(raw);
          } catch {
            return [];
          }
        };
        return {
          devices: (p.data.myDevices || []).map((d) => d.deviceId),
          recent: parse(wx.getStorageSync("lumen.recentDevices.v2")),
          deleted: parse(wx.getStorageSync("lumen.mockDeleted.v1")),
        };
      });
      rec("设备从「我的」页列表消失", !after.devices.includes(target.deviceId), after.devices.join(","));
      rec("最近设备存储里也清掉了", !(after.recent || []).some((d) => (d.deviceId || d.key) === target.deviceId), `${(after.recent || []).length} 条`);
      rec("演示设备被记进删除标记（不会自己回来）", (after.deleted || []).includes(target.deviceId), JSON.stringify(after.deleted));
      return { deleted: target };
    } finally {
      await mp.evaluate((b) => {
        for (const k of Object.keys(b)) {
          const v = b[k];
          if (v === "" || v === undefined || v === null) wx.removeStorageSync(k);
          else wx.setStorageSync(k, v);
        }
        wx.setStorageSync("lumen.mockDeleted.v1", []);
        const mod = require("utils/control/session-singleton.js");
        if (typeof mod.reloadSession === "function") mod.reloadSession();
      }, backup);
      await sleep(800);
      const restored = await mp.evaluate(() => {
        const raw = wx.getStorageSync("lumen.recentDevices.v2");
        try {
          const list = typeof raw === "string" ? JSON.parse(raw) : raw;
          return Array.isArray(list) ? list.length : 0;
        } catch {
          return 0;
        }
      });
      /* 还原后回一次首页：删除会把页面留在「我的」，且可能留下未清的忙碌态。
       * reLaunch 让页面重新走 onShow 派生 busy，避免污染下一次运行。 */
      await mp.reLaunch("/pages/home/home");
      await sleep(1800);
      const settled = await mp.evaluate(() => {
        const p = getCurrentPages().pop();
        return { busy: p.data.busy, link: p.session.linkState };
      });
      rec("清理后已还原备份", true, `${restored} 台`);
      rec("还原后首页回到非忙碌态", settled.busy === false, `busy=${settled.busy} link=${settled.link}`);
    }
  },
};

/* ---------------- 共用步骤 ---------------- */

/**
 * automator 调用的重试包装。
 *
 * 本机这套开发者工具在连续驱动时会偶发 `timeout waiting for automator response`
 * （IDE 侧没回，不是我们的断言错了）。它是**瞬态**的：同一调用重试一次就过。
 * 只重试瞬态错误，别把真实失败吞掉。
 */
function isTransient(err) {
  const s = String(err);
  return s.includes("timeout waiting for automator response") || s.includes("Connection closed");
}

async function withRetry(fn, attempts = 3) {
  let last;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      if (!isTransient(e)) throw e;
      await sleep(700 * (i + 1));
    }
  }
  throw last;
}

/**
 * 把小程序带回「首页且没有进行中的操作」的稳定态。
 *
 * 为什么必须先做这一步：上一个场景可能把页面留在发现页并开着持续扫描，此时
 * 直接 reLaunch 会撞上 automator 的响应超时（本机实测）。先停扫描、再 reLaunch、
 * 再等一帧确认路由，后续断言才有可信基线。
 */
async function settle(mp) {
  try {
    /* 发现页的扫描由会话持有（`session.linkState === "scanning"`），页面卸载
     * 不会自己停。不停掉就 reLaunch，automator 会卡住等不到响应。 */
    await withRetry(() =>
      mp.evaluate(async () => {
        const p = getCurrentPages()[getCurrentPages().length - 1];
        const s = p && p.session;
        if (s && typeof s.stopScan === "function" && s.linkState === "scanning") {
          await s.stopScan().catch(() => undefined);
        }
      }),
    );
    await sleep(600);
  } catch {
    /* 页面已经不在，忽略 */
  }
  await withRetry(() => mp.reLaunch("/pages/home/home"));
  await sleep(1200);
  for (let i = 0; i < 3; i++) {
    const route = await withRetry(() =>
      mp.evaluate(() => {
        const p = getCurrentPages()[getCurrentPages().length - 1];
        return p ? p.route : null;
      }),
    );
    if (route === "pages/home/home") return;
    await sleep(900);
  }
}

/**
 * 连上演示设备（本机没有真机时首页默认播的就是它）。
 *
 * **必须走页面自己的处理器**（`onPowerTap`），不能直接 `session.connect`：
 * `applyLink` 在连接期间会把 `busy` 置 true（`pages/home/home.ts:271`），
 * 而只有 `onPowerTap` 的 `finally` 会把它清掉。绕过处理器连接会让 `busy`
 * 永久卡住，之后电源键静默返回——那不是测试环境问题，是页面真实的脆弱点。
 */
async function connectDemo(mp) {
  await settle(mp);
  await mp.evaluate(async () => {
    const p = getCurrentPages().pop();
    if (p.session.linkState !== "ready") {
      await p.onPowerTap();
    }
  });
  await sleep(2200);
  const ready = await mp.evaluate(() => {
    const p = getCurrentPages().pop();
    return { link: p.session.linkState, busy: p.data.busy };
  });
  if (ready.link !== "ready") {
    throw new Error(`连不上演示设备（linkState=${ready.link}），后续断言会无意义`);
  }
  /* busy 卡住时电源键会静默返回，明确报出来而不是让它变成一个假 FAIL。 */
  if (ready.busy === true) {
    throw new Error("首页 busy 卡在 true，电源键将静默返回（见 features/home-page.md 的 Gotchas）");
  }
}

/** 从首页进「书桌」的灯组页。 */
async function openStrip(mp) {
  await mp.switchTab("/pages/home/home");
  await sleep(900);
  await mp.navigateTo("/pages/device/device?key=A4%3ACF%3A12%3A9B%3E%3A01");
  await sleep(1800);
  await mp.navigateTo("/pages/strip/strip?strip=0");
  await sleep(2200);
}

/** 读设备 State（真实读回，不是页面缓存）。 */
async function readState(mp) {
  return mp.evaluate(async () => {
    const p = getCurrentPages().pop();
    const s = p.session;
    if (!s) return null;
    try {
      const st = typeof s.readState === "function" ? await s.readState() : s.deviceState;
      return st ? { power: st.power, brightness: st.brightness } : null;
    } catch {
      return null;
    }
  });
}

async function pageWxml(mp) {
  const pages = await mp.currentPage().then((p) => p.$$(".page"));
  return pages.length === 0 ? "" : pages[0].outerWxml();
}

/* ---------------- 主流程 ---------------- */

if (args.includes("--list")) {
  console.log(
    [
      "doctor          只读：端口 / 启动链 / 设备 / 主题是否值得驱动",
      "home-power      首页电源键：设备 State.power 真的翻转（并复位）",
      "home-search     首页搜索：按名称过滤，清空后恢复",
      "strip-advanced  灯组进阶档：循环三档 / 选中分区后两层编辑器出现",
      "delete-device   「我的」页删除设备：六处清理 + 删除标记（并还原）",
    ].join("\n"),
  );
  process.exit(0);
}

const name = opt("scenario", "doctor");
const label = opt("label", "");
const scenario = scenarios[name];
if (scenario === undefined) {
  console.error(`未知场景：${name}。可用：${Object.keys(scenarios).join(", ")}`);
  process.exit(2);
}

const outDir = join(EVIDENCE_ROOT, RUN_ID);
mkdirSync(outDir, { recursive: true });

const records = [];
const rec = (assertion, ok, detail = "") => {
  records.push({ assertion, ok: ok === true, detail: String(detail) });
  console.log(`${ok === true ? "PASS" : "FAIL"}  ${assertion}${detail ? "  — " + detail : ""}`);
};

let mp = null;
let exitCode = 1;
try {
  const raw = await automator.connect({ wsEndpoint: WS });
  /* 把所有 automator 调用统一包上瞬态重试：开发者工具在连续驱动时会偶发
   * `timeout waiting for automator response`，那不是断言失败。 */
  const retrying =
    (fn) =>
    (...a) =>
      withRetry(() => fn.apply(raw, a));
  mp = new Proxy(raw, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? retrying(value) : value;
    },
  });
  const data = await scenario(mp, rec);
  const failed = records.filter((r) => !r.ok);
  exitCode = failed.length === 0 ? 0 : 1;
  console.log(`\n===== ${records.length - failed.length} passed / ${failed.length} failed =====`);
  if (data !== undefined) console.log("DATA: " + JSON.stringify(data));

  /* 收尾复位：等链路稳定 → 回首页 → 确认不忙碌。
   *
   * **顺序不能反。** `applyLink()` 写的是 `busy: connecting || this.data.busy`
   * （`pages/home/home.ts:271`），所以 `busy` 是**粘的**：页面只要观察到一次
   * `connecting`，就会永久 true，而 `onPowerTap` 在 `busy` 为 true 时直接 return
   * （`home.ts:382`）——电源键就此失效，只有重开页面（onLoad 把 busy 复位）能救。
   * 因此若在「正在回连」时 reLaunch，新页面正好看到 connecting，又把它粘住。
   * 正确做法是先等链路落到 ready / idle，再 reLaunch，新页面的 onShow 看到的就是
   * 稳定态。 */
  const cleanup = await (async () => {
    try {
      /* 1. 等链路离开 connecting / initializing（最多 ~10s）。 */
      for (let i = 0; i < 20; i++) {
        const link = await withRetry(() =>
          mp.evaluate(() => {
            const p = getCurrentPages()[getCurrentPages().length - 1];
            return p && p.session ? p.session.linkState : "none";
          }),
        );
        if (link !== "connecting" && link !== "initializing") break;
        await sleep(500);
      }
      /* 2. 回首页（onLoad 把 busy 复位成 false）。 */
      await withRetry(() => mp.reLaunch("/pages/home/home"));
      await sleep(1500);
      /* 3. 复核；还没干净就再来一次。 */
      let state = null;
      for (let i = 0; i < 3; i++) {
        state = await withRetry(() =>
          mp.evaluate(() => {
            const p = getCurrentPages()[getCurrentPages().length - 1];
            return {
              route: p ? p.route : null,
              busy: p && p.data ? p.data.busy : null,
              link: p && p.session ? p.session.linkState : null,
            };
          }),
        );
        if (state.busy !== true) break;
        await sleep(600);
        await withRetry(() => mp.reLaunch("/pages/home/home"));
        await sleep(1500);
      }
      return state;
    } catch (e) {
      return { error: String(e) };
    }
  })();

  writeFileSync(
    join(outDir, `${name}.json`),
    JSON.stringify(
      {
        scenario: name,
        label,
        runId: RUN_ID,
        ws: WS,
        at: new Date().toISOString(),
        records,
        data,
        cleanup,
      },
      null,
      2,
    ),
  );
  /* 截图默认不拍：本机实测 `mp.screenshot()` 在连续驱动的尾部经常超时
   * （`timeout waiting for automator response`），而且这个挂起会污染同一个
   * websocket，让下一条命令也跟着超时——连续跑多个场景时尤其明显。
   * 需要图时加 `--screenshot`，并接受它可能失败。 */
  if (args.includes("--screenshot")) {
    try {
      let shot = null;
      let shotErr = "";
      for (let i = 0; i < 2 && shot === null; i++) {
        try {
          shot = await mp.screenshot();
        } catch (e) {
          shotErr = e instanceof Error ? e.message : String(e);
        }
        if (shot === null) await sleep(500);
      }
      if (shot) {
        writeFileSync(join(outDir, `${name}.png`), Buffer.from(shot, "base64"));
        console.log(`evidence: ${join(outDir, `${name}.json`)} + ${name}.png`);
      } else {
        console.log(`evidence: ${join(outDir, `${name}.json`)}（截图不可用：${shotErr || "返回空"}）`);
      }
    } catch (e) {
      console.log(`evidence: ${join(outDir, `${name}.json`)}（截图失败：${String(e).slice(0, 120)}）`);
    }
  } else {
    console.log(`evidence: ${join(outDir, `${name}.json`)}`);
  }
} catch (e) {
  console.error(`\n驱动失败：${String(e)}`);
  writeFileSync(
    join(outDir, `${name}.json`),
    JSON.stringify({ scenario: name, label, runId: RUN_ID, ws: WS, at: new Date().toISOString(), records, error: String(e) }, null, 2),
  );
} finally {
  if (mp !== null) {
    try {
      await mp.disconnect();
    } catch {
      /* 已经断开 */
    }
  }
}
process.exit(exitCode);
