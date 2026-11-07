/**
 * 逐页截图：浅色 / 深色各一张，用于样式改动的目测核对。
 *
 * 写这个脚本的原因：渲染回归（`node scripts/test-run.mjs ui`）断言的是
 * 「元素在不在、点击有没有效果」，它不看「好不好看」。样式重构必须有人
 * 真的看到画面，否则字调小了两档、间距收了一级这类问题永远不会被发现。
 *
 * 用法：
 *   WS=ws://127.0.0.1:9420 node scripts/shoot-pages.mjs [--out .scratch/ui-shots]
 *
 * 依赖开发者工具开着自动化端口；连不上时打印 SKIPPED 并以 0 退出
 * （与 `test-run.mjs` 的三态语义一致：没跑不能算通过）。
 */

import { createRequire } from "node:module";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import net from "node:net";

const HERE = dirname(fileURLToPath(import.meta.url));
const MP_ROOT = resolve(HERE, "..", "miniprogram");
const requireFromMp = createRequire(join(MP_ROOT, "package.json"));

const argv = process.argv.slice(2);
function arg(name, fallback) {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
}

const OUT = resolve(HERE, "..", arg("--out", ".scratch/ui-shots"));
const ENDPOINT = process.env.WS || "ws://127.0.0.1:9420";

/** 页面清单：路由 + 用于文件名的短名。 */
const PAGES = [
  { path: "/pages/home/home", name: "01-home" },
  { path: "/pages/me/me", name: "02-me" },
  { path: "/pages/discover/discover", name: "03-discover" },
  { path: "/pages/device/device", name: "04-device" },
  { path: "/pages/device-info/device-info", name: "05-device-info" },
  { path: "/pages/strip/strip", name: "06-strip" },
];

const THEMES = [
  { key: "light", value: "light" },
  { key: "dark", value: "dark" },
];

function probe(endpoint, timeoutMs = 3000) {
  return new Promise((done) => {
    let host = "127.0.0.1";
    let port = 9420;
    try {
      const url = new URL(endpoint);
      host = url.hostname || host;
      port = Number(url.port) || port;
    } catch {
      done(`端点无法解析：${endpoint}`);
      return;
    }
    const socket = net.connect({ host, port });
    const timer = setTimeout(() => {
      socket.destroy();
      done(`自动化端口 ${port} 在 ${timeoutMs}ms 内没连上`);
    }, timeoutMs);
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.destroy();
      done(null);
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      done(`自动化端口 ${port}：${error.code ?? error.message}`);
    });
  });
}

function loadAutomator() {
  try {
    return requireFromMp("miniprogram-automator");
  } catch {
    return null;
  }
}

const automator = loadAutomator();
if (automator === null) {
  console.log("SKIPPED: 缺 miniprogram-automator（在 miniprogram/ 下 npm install）");
  process.exit(0);
}

const portIssue = await probe(ENDPOINT);
if (portIssue) {
  console.log(`SKIPPED: ${portIssue}`);
  process.exit(0);
}

mkdirSync(OUT, { recursive: true });

let mp;
try {
  mp = await automator.connect({ wsEndpoint: ENDPOINT });
} catch (error) {
  console.log(`SKIPPED: 连接失败（${error.message}）`);
  process.exit(0);
}

let ok = 0;
let failed = 0;

/* 主题必须走真实存储：`nav-bar` 与 `custom-tab-bar` 是独立组件，
 * 它们自己读 `lumen.theme.v1` 决定配色，改页面 data 影响不到它们。
 * 只改页面 class 会让截图里「导航栏浅色、内容深色」，看着像缺陷其实不是。 */
for (const theme of THEMES) {
  await mp.callWxMethod("setStorageSync", "lumen.theme.v1", theme.key);

  for (const page of PAGES) {
    let instance;
    try {
      instance = await mp.reLaunch(page.path);
    } catch (error) {
      console.log(`FAIL  ${page.name}  — 打不开：${error.message}`);
      failed += 1;
      continue;
    }

    /* 页面挂载后要等一帧渲染，否则截到的是空白。 */
    await new Promise((r) => setTimeout(r, 800));

    try {
      const file = join(OUT, `${page.name}-${theme.key}.png`);
      /* 截图是 MiniProgram 级方法，拍的是当前页面视口。 */
      await mp.screenshot({ path: file });
      console.log(`PASS  ${page.name}-${theme.key}`);
      ok += 1;
    } catch (error) {
      console.log(`FAIL  ${page.name}-${theme.key}  — ${error.message}`);
      failed += 1;
    }
  }
}

const summary = { endpoint: ENDPOINT, out: OUT, ok, failed, at: new Date().toISOString() };
writeFileSync(join(OUT, "summary.json"), JSON.stringify(summary, null, 2), "utf8");
console.log(`\n${ok} 张成功，${failed} 张失败 → ${OUT}`);
process.exit(failed === 0 ? 0 : 1);
