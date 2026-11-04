#!/usr/bin/env node
/**
 * 测试编排器：跑一层或多层，产出一份能自证的报告。
 *
 * 为什么需要它：跑测试看到的只有一个「绿」。不知道跑了什么命令、每层验了什么、
 * 哪些因为环境不在而根本没跑。报告把这些都写下来，并且是测试数字的唯一来源。
 *
 * 用法：
 *   node scripts/test-run.mjs                # 便宜的三层（固件 / 小程序 / 后端）
 *   node scripts/test-run.mjs firmware mp    # 指定层
 *   node scripts/test-run.mjs --release      # 全五层，报告归档到证据目录
 *   node scripts/test-run.mjs --list         # 列层
 *
 * 三态：PASS / FAIL / SKIP。SKIP 必须带原因，进「未验证清单」，不影响退出码。
 * 前置条件靠主动探测，不是跑一遍失败再猜。
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { cpus, hostname, platform, release as osRelease, tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
// @ts-expect-error -- 同目录的工具脚本是 .mjs，没有类型声明
import { checkManifest, loadManifest } from "./check-test-manifest.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO = resolve(HERE, "..");

const PASS = "PASS";
const FAIL = "FAIL";
const SKIP = "SKIP";

const nowIso = () => new Date().toISOString();
const runIdOf = (date = new Date()) =>
  date.toISOString().replace(/[:.]/g, "-").replace("Z", "");

function git(args, fallback = "") {
  try {
    return execFileSync("git", args, { cwd: REPO, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return fallback;
  }
}

function hasCommand(cmd) {
  try {
    execFileSync(process.platform === "win32" ? "where" : "which", [cmd], {
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ */
/* 层执行器：每个返回 { status, checks, unit, detail, failures, extra } */
/* ------------------------------------------------------------------ */

/**
 * 固件按测试函数的断言数（#108）。固件侧在每次 test_*() 前后各读一次 g_checks，
 * 打一行 `TESTCOUNT <函数名> <断言数>`。这些行合成「按模块」的真实数字，
 * 取代文档里靠估算的占比表。
 *
 * 只认行首前缀、行尾即是数字：这样 gcc 的报错里就算出现同名文本也不会被误算。
 */
export const parseTestCounts = (stdout) => {
  const byTest = {};
  let total = 0;
  for (const raw of String(stdout ?? "").split("\n")) {
    const match = raw.trim().match(/^TESTCOUNT\s+(\S+)\s+(\d+)$/);
    if (!match) continue;
    const name = match[1];
    const count = Number(match[2]);
    byTest[name] = (byTest[name] ?? 0) + count;
    total += count;
  }
  return { byTest, total, count: Object.keys(byTest).length };
};

export const parseFirmwareOutput = (stdout) => {
  const checksMatch = stdout.match(/all (\d+) checks passed/);
  const failedMatch = stdout.match(/(\d+)\/(\d+) checks failed/);
  const vectorsMatch = stdout.match(/vectors: (\d+) cases/);
  const counts = parseTestCounts(stdout);
  const byTest = counts.count > 0 ? counts.byTest : null;

  const failures = [];
  for (const line of stdout.split("\n")) {
    if (/^\[FAIL\]/.test(line.trim())) failures.push({ name: line.trim(), detail: "" });
  }

  if (failedMatch) {
    return {
      status: FAIL,
      checks: Number(failedMatch[2]),
      unit: "断言",
      detail: `${failedMatch[1]}/${failedMatch[2]} 条断言失败`,
      failures,
      extra: { byTest },
    };
  }
  if (checksMatch) {
    return {
      status: PASS,
      checks: Number(checksMatch[1]),
      unit: "断言",
      detail: `${checksMatch[1]} 条断言通过`,
      failures,
      extra: { vectors: vectorsMatch ? Number(vectorsMatch[1]) : null, byTest },
    };
  }
  return { status: FAIL, checks: null, unit: "断言", detail: "输出里找不到断言统计", failures: [], extra: { byTest } };
};

/**
 * 显式 skip 标签（#108）。固件入口在 node 缺失时打 "SKIPPED: <原因>"，退出码仍为 0。
 * 它不是失败，但也绝不能是一句悄悄话——这里把它取出来，进该层的未验证项。
 */
export const parseSkippedTags = (stdout) =>
  String(stdout ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("SKIPPED:"))
    .map((line) => line.slice("SKIPPED:".length).trim())
    .filter((reason) => reason.length > 0);

const runFirmware = () => {
  const started = Date.now();
  const res =
    process.platform === "win32"
      ? spawnSync("cmd.exe", ["/c", "firmware\\test\\run-tests.cmd"], {
          cwd: REPO,
          encoding: "utf8",
          maxBuffer: 64 * 1024 * 1024,
        })
      : spawnSync("sh", ["firmware/test/run-tests.cmd"], {
          cwd: REPO,
          encoding: "utf8",
          maxBuffer: 64 * 1024 * 1024,
        });

  const stdout = `${res.stdout ?? ""}${res.stderr ?? ""}`;
  const durationMs = Date.now() - started;
  const parsed = parseFirmwareOutput(stdout);

  /* 显式 skip 标签（#108）：不是失败，但要作为可见记录进未验证清单。 */
  const skipped = parseSkippedTags(stdout);

  if (res.error) {
    return { status: FAIL, checks: null, unit: "断言", detail: String(res.error.message), failures: [], skipped, durationMs };
  }
  if (res.status !== 0 && parsed.status === PASS) {
    return { ...parsed, status: FAIL, detail: `退出码 ${res.status}`, skipped, durationMs };
  }
  return { ...parsed, skipped, durationMs };
};

/* ------------------------------------------------------------------ */
/* 渲染回归（ui 层）：包住 scripts/verify-v5.mjs                       */
/* ------------------------------------------------------------------ */

/**
 * 解析渲染回归脚本的输出。
 *
 * 输出形状（脚本自己定的，别改两头对不上的格式）：
 *   PASS  断言名
 *   FAIL  断言名  — 差异描述
 *   ===== 47 passed / 2 failed =====
 *   缺环境时只有一行：SKIPPED: 原因
 *
 * 为什么数 PASS/FAIL 行而不是信末尾的汇总行：汇总行是脚本自己算的，
 * 数行是编排器自己算的。两者不一致时以数行得到的失败项为准，因为
 * 「失败详情里有断言名」是报告要能跳过去修的前提。
 */
export const parseUiOutput = (stdout, exitCode = 0) => {
  const lines = stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  /* 缺环境优先于一切：端口没通时脚本一条断言都没跑，
     把它记成 FAIL 会让「今天没开开发者工具」看起来像代码坏了。 */
  const skipped = lines.find((line) => line.startsWith("SKIPPED:"));
  if (skipped !== undefined) {
    return {
      status: SKIP,
      checks: null,
      unit: "断言",
      detail: "",
      failures: [],
      skipReason: skipped.slice("SKIPPED:".length).trim(),
    };
  }

  const failures = [];
  let passed = 0;
  for (const line of lines) {
    const match = /^(PASS|FAIL)\s{2,}(.+)$/.exec(line);
    if (match === null) continue;
    const rest = match[2];
    const splitAt = rest.indexOf("  — ");
    const name = splitAt < 0 ? rest : rest.slice(0, splitAt);
    const detail = splitAt < 0 ? "" : rest.slice(splitAt + "  — ".length);
    if (match[1] === "PASS") passed += 1;
    else failures.push({ name, detail });
  }

  const total = passed + failures.length;
  if (total === 0) {
    return {
      status: FAIL,
      checks: null,
      unit: "断言",
      detail: "输出里找不到断言行",
      failures,
    };
  }

  if (failures.length > 0) {
    return {
      status: FAIL,
      checks: total,
      unit: "断言",
      detail: `${failures.length}/${total} 条断言失败`,
      failures,
    };
  }

  /* 断言全过但脚本非零退出，说明是脚本收尾时出的问题（例如断开连接失败）。
     不能因为行都是 PASS 就判通过。 */
  if (exitCode !== 0) {
    return {
      status: FAIL,
      checks: total,
      unit: "断言",
      detail: `断言全过但退出码 ${exitCode}`,
      failures,
    };
  }

  return { status: PASS, checks: total, unit: "断言", detail: `${total} 条断言通过`, failures };
};

/** 脚本路径：与编排器同目录，不依赖 cwd。 */
const UI_SCRIPT = join(HERE, "verify-v5.mjs");

/**
 * 主动探测自动化端口。
 *
 * 为什么要单独探一次而不是跑一遍再判断：49 项断言要跑一分多钟，
 * 端口没通时那段时间纯属浪费，而且失败输出会被误读成「页面坏了」。
 * 探测本身只建 TCP 连接（脚本的 `--probe` 分支，内部 3 秒超时），
 * 与断言数无关；这里的 10 秒外壳只是兜住进程起不来的情况。
 */
const probeUi = () => {
  const res = spawnSync(process.execPath, [UI_SCRIPT, "--probe"], {
    cwd: REPO,
    encoding: "utf8",
    timeout: 10_000,
    maxBuffer: 1024 * 1024,
  });
  const stdout = `${res.stdout ?? ""}${res.stderr ?? ""}`;
  const skipped = stdout
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.startsWith("SKIPPED:"));
  if (skipped !== undefined) return [skipped.slice("SKIPPED:".length).trim()];
  if (res.error) return [`自动化端口探测失败：${res.error.message}`];
  if (/PORT: .* 可连/.test(stdout)) return [];
  return [`自动化端口探测没有结论：${stdout.trim().slice(0, 200)}`];
};

/** 跑 49 项渲染断言。整轮要一分多钟，超时给到 10 分钟。 */
const runUi = () => {
  const started = Date.now();
  const res = spawnSync(process.execPath, [UI_SCRIPT], {
    cwd: REPO,
    encoding: "utf8",
    timeout: 600_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  const durationMs = Date.now() - started;
  const stdout = `${res.stdout ?? ""}${res.stderr ?? ""}`;

  if (res.error) {
    return {
      status: FAIL,
      checks: null,
      unit: "断言",
      detail: String(res.error.message),
      failures: [],
      durationMs,
    };
  }

  return { ...parseUiOutput(stdout, res.status ?? 0), durationMs };
};

/* ------------------------------------------------------------------ */
/* 小程序层与后端层：vitest 结构化输出 + tsc                           */
/* ------------------------------------------------------------------ */

/**
 * 把路径变成仓库内相对路径，统一成 `/`。
 * 报告要能直接把读者送到文件，Windows 反斜杠和盘符会让这一句失效。
 * tsc 输出的本来就是相对 cwd 的路径，那已经是我们想要的形状，不再相对化一次。
 */
function toRel(root, abs) {
  const rel = isAbsolute(abs) ? relative(root, abs) : abs;
  if (!rel || rel.startsWith("..")) return abs.split("\\").join("/");
  return rel.split("\\").join("/");
}

/** 从断言栈里挑第一条不是依赖的栈帧——那是用户真正写错的那一行。 */
function firstFrameLocation(message, root, prefix = "") {
  for (const line of String(message ?? "").split("\n")) {
    const match = line.match(/(?:file:\/\/\/)?([A-Za-z]:[\\/][^()\s]+?|\/[^()\s]+?):(\d+):(\d+)/);
    if (!match) continue;
    if (/node_modules|[\\/]node_modules[\\/]/.test(match[1])) continue;
    return `${prefix}${toRel(root, decodeURIComponent(match[1]))}:${match[2]}`;
  }
  return null;
}

/**
 * 解析 vitest 的 JSON reporter 输出。
 *
 * 为什么不用 stdout 的「N passed」：那个字符串格式会变，而且它只给总数——
 * 「某个文件的用例数掉了」正是这套报告要抓的东西。JSON 里每个文件的
 * assertionResults 才是可按文件核对的来源。
 */
export const parseVitestJson = (jsonText, { root = ".", dir = "" } = {}) => {
  let report;
  try {
    report = JSON.parse(jsonText);
  } catch (error) {
    return {
      status: FAIL,
      checks: null,
      unit: "用例",
      detail: `vitest JSON 解析失败：${error.message ?? error}`,
      failures: [],
      files: [],
    };
  }

  const results = Array.isArray(report.testResults) ? report.testResults : [];
  /* 报告里的路径要和清单里的写法一致（相对仓库根），否则读者在文件表里看到的
     是 `miniprogram/tests/a.test.ts`、在失败详情里看到的却是 `tests/a.test.ts`。 */
  const repoPath = (abs) => `${dir ? `${dir}/` : ""}${toRel(root, abs)}`;
  const files = results.map((item) => ({
    file: repoPath(String(item.name ?? "")),
    checks: Array.isArray(item.assertionResults) ? item.assertionResults.length : 0,
    status: item.status ?? "unknown",
  }));

  const total =
    typeof report.numTotalTests === "number"
      ? report.numTotalTests
      : files.reduce((acc, file) => acc + file.checks, 0);

  const failures = [];
  for (const item of results) {
    const assertions = Array.isArray(item.assertionResults) ? item.assertionResults : [];
    /* 整个文件没跑起来（语法错误、导入失败）时 assertionResults 是空的，
       只有 message。不单独记下来的话这种失败会从报告里消失。 */
    if (assertions.length === 0 && item.status === "failed") {
      const firstLine = String(item.message ?? "").split("\n").find((line) => line.trim()) ?? "文件加载失败";
      failures.push({
        name: `文件加载失败 ${repoPath(String(item.name ?? ""))}`,
        detail: firstLine.trim(),
        location: repoPath(String(item.name ?? "")),
        kind: "test",
      });
      continue;
    }
    for (const assertion of assertions) {
      if (assertion.status !== "failed") continue;
      const raw = (assertion.failureMessages ?? []).join("\n");
      const firstLine = raw.split("\n").find((line) => line.trim()) ?? "断言失败";
      failures.push({
        name: assertion.fullName ?? assertion.title ?? "未命名用例",
        detail: firstLine.trim(),
        location: firstFrameLocation(raw, root, dir ? `${dir}/` : ""),
        kind: "test",
      });
    }
  }

  const failed = typeof report.numFailedTests === "number" ? report.numFailedTests : failures.length;
  const status = report.success === false || failed > 0 || failures.length > 0 ? FAIL : PASS;

  if (total === 0) {
    return {
      status: FAIL,
      checks: 0,
      unit: "用例",
      detail: "一个用例都没收集到",
      failures: failures.length > 0 ? failures : [{ name: "收集结果为空", detail: "", location: null }],
      files,
    };
  }

  return {
    status,
    checks: total,
    unit: "用例",
    detail: status === PASS ? `${total} 个用例通过` : `${failed}/${total} 个用例失败`,
    failures,
    files,
  };
};

/**
 * 解析 `tsc --noEmit` 的输出。
 *
 * 报错格式自带「文件(行,列)」，正好能和断言失败用同一种「文件:行」定位。
 * 有输出但一行都认不出来时仍判失败——安静地通过比报错更危险。
 */
export const parseTscOutput = (stdout, { root = ".", dir = "" } = {}) => {
  const text = String(stdout ?? "");
  const prefix = dir ? `${dir}/` : "";
  if (text.trim() === "") {
    return { status: PASS, failures: [], detail: "" };
  }

  const failures = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    /* 形如 `src/a.ts(12,5): error TS2322: 文案`；分成错误与提示两栏，
       但两者都意味着类型检查没通过。 */
    const match = line.match(/^(.+?)\((\d+),(\d+)\):\s+(error|warning)\s+(TS\d+):\s*(.*)$/);
    if (!match) continue;
    failures.push({
      name: `${match[5]} ${match[4] === "error" ? "error" : "warning"}`,
      detail: match[6],
      location: `${prefix}${toRel(root, match[1])}:${match[2]}`,
      kind: "typecheck",
    });
  }

  if (failures.length === 0) {
    const firstLine = text.split("\n").find((line) => line.trim()) ?? text;
    return { status: FAIL, failures: [], detail: `类型检查报错无法定位：${firstLine.trim()}` };
  }

  return {
    status: FAIL,
    failures,
    detail: `${failures.length} 处类型错误`,
  };
};

/**
 * 把 vitest 与 tsc 两件事合成一层的结果。
 *
 * 合成而不是并列成两层，是因为它们检验的是同一批源码：类型错了就算用例全绿，
 * 这层也不能交付。两者分开呈现，但都计入同一个 PASS/FAIL。
 */
export function combineNodeLayerResults(vitest, tsc) {
  const failures = [...(vitest.failures ?? []), ...(tsc.failures ?? [])];
  const status = vitest.status === FAIL || tsc.status === FAIL ? FAIL : PASS;
  const typecheckNote = tsc.status === PASS ? "类型检查干净" : tsc.detail || "类型检查未通过";
  const detail = vitest.status === PASS && tsc.status === PASS
    ? `${vitest.checks} 个用例通过，${typecheckNote}`
    : `${vitest.detail || ""}${vitest.detail ? "；" : ""}${typecheckNote}`;

  return {
    status,
    checks: vitest.checks ?? null,
    unit: "用例",
    detail,
    failures,
    extra: {
      typecheck: tsc.status,
      typecheckFailures: (tsc.failures ?? []).length,
      files: vitest.files ?? [],
    },
  };
}

/**
 * 直接跑仓库里装好的 CLI，不走 npx。
 *
 * npx 在依赖缺失时会去下载一份临时副本，然后在一个和仓库无关的目录里跑——
 * 那会给出「跑了但跑的不是这份代码」的结果。依赖缺失是探测该管的事，
 * 到了这里还缺就只能明说。
 */
function runNodeCli(cwd, binRel, args) {
  const local = join(cwd, "node_modules", binRel);
  if (!existsSync(local)) {
    return { status: null, stdout: "", stderr: `${binRel} 不存在（${cwd}/node_modules 不完整）`, missing: local };
  }
  return spawnSync(process.execPath, [local, ...args], {
    cwd,
    encoding: "utf8",
    maxBuffer: 128 * 1024 * 1024,
  });
}

/**
 * 跑一层的两件事：vitest（JSON reporter 落临时文件）+ tsc --noEmit。
 * 临时文件是必需的：vitest 把 JSON 写到文件，stdout 留给人的日志，
 * 两者混在一起时任何一方的格式变化都会破坏另一方。
 */
function runNodeLayer({ dirName, repoRoot }) {
  const started = Date.now();
  const cwd = join(repoRoot, dirName);
  const tmp = mkdtempSync(join(tmpdir(), "lumen-vitest-"));
  const jsonPath = join(tmp, "vitest.json");

  let vitest;
  try {
    const res = runNodeCli(cwd, "vitest/vitest.mjs", ["run", "--reporter=json", `--outputFile=${jsonPath}`]);
    if (res.missing) {
      vitest = { status: FAIL, checks: null, unit: "用例", detail: res.stderr, failures: [], files: [] };
    } else if (existsSync(jsonPath)) {
      vitest = parseVitestJson(readFileSync(jsonPath, "utf8"), { root: cwd, dir: dirName });
    } else {
      const stdout = `${res.stdout ?? ""}${res.stderr ?? ""}`.trim();
      vitest = {
        status: FAIL,
        checks: null,
        unit: "用例",
        detail: `vitest 没有产出 JSON（退出码 ${res.status}）${stdout ? `：${stdout.split("\n").slice(-3).join(" ")}` : ""}`,
        failures: [],
        files: [],
      };
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }

  const tscRes = runNodeCli(cwd, "typescript/bin/tsc", ["--noEmit"]);
  const tscStdout = `${tscRes.stdout ?? ""}${tscRes.missing ? tscRes.stderr : ""}`;
  let tsc = parseTscOutput(tscStdout, { root: cwd, dir: dirName });
  /* 退出码非零但输出为空：类型检查崩了，不是通过。 */
  if (tsc.status === PASS && tscRes.status !== 0) {
    tsc = { status: FAIL, failures: [], detail: `tsc 退出码 ${tscRes.status}` };
  }

  return { ...combineNodeLayerResults(vitest, tsc), durationMs: Date.now() - started };
}

/* ------------------------------------------------------------------ */
/* 真机 e2e（ble 层）：包住既有执行器 drive.mjs                         */
/* ------------------------------------------------------------------ */

/**
 * 真机层为什么不自己跑 vitest、也不自己连 BLE：
 *
 * 仓库里已经有一个把这件事做完了的执行器
 * （`.zcode/skills/verify-lumen-ble/scripts/drive.mjs`）：它先跑 `doctor.py` 做只读体检
 * （设备在不在、固件是不是 v4、State 是否合法），再用 JSON reporter 跑 e2e，最后
 * 收尾核对设备现场，并且**已经定义了退出码语义**：0 过 / 1 断言失败 / 3 SKIP。
 *
 * 那套语义正是这一层要的东西。再写一遍只会多出两套会各自漂移的判定，所以这里只做
 * 「读懂它的输出」：退出码 3 一律 SKIP（环境问题不是代码回归），退出码 1 但用例全过
 * 也判 FAIL（收尾出问题不能算过），其余按 JSON 里的真实收集数报。
 *
 * 它自己会写证据 JSON 到 `miniprogram/.auto/evidence-ble/<RUN_ID>/`。这里通过给
 * 子进程传 `RUN_ID` 来拿到确定路径，不去猜它的时间戳——猜错就会把「没读到 JSON」
 * 误报成「零用例失败」。
 */
const BLE_SKILL_DIR = join(".zcode", "skills", "verify-lumen-ble", "scripts");

/**
 * 解析真机 e2e 的 vitest JSON。
 *
 * 与 `parseVitestJson` 的差别只有三处，都是这一层特有的：
 *   1. skipped 计数是主角。「没设备」与「设备被抢连」都表现为用例 skip，
 *      必须能报成 SKIP 而不是 FAIL；
 *   2. 只有扫描那条用例会在无设备时「顺利结束」（它自己提前 return），
 *      所以「至多一条通过 + 其余跳过」也要判 SKIP，否则整层会被这一条染绿；
 *   3. 用例数是**实际收集数**（两个 e2e 文件合计 16 条），不是文档里只数了一个
 *      文件得出的 8。
 */
export const parseE2eJson = (jsonText, { root = ".", dir = "" } = {}) => {
  let report;
  try {
    report = JSON.parse(jsonText);
  } catch (error) {
    return {
      status: FAIL,
      checks: null,
      unit: "用例",
      detail: `真机 e2e JSON 解析失败：${error.message ?? error}`,
      failures: [],
      files: [],
      passedCount: 0,
      skippedCount: 0,
    };
  }

  const results = Array.isArray(report.testResults) ? report.testResults : [];
  const repoPath = (abs) => `${dir ? `${dir}/` : ""}${toRel(root, abs)}`;

  const failures = [];
  const files = [];
  let passed = 0;
  let skipped = 0;
  let seen = 0;

  for (const item of results) {
    const assertions = Array.isArray(item.assertionResults) ? item.assertionResults : [];
    const fileSkipped = assertions.filter((a) => a.status === "skipped" || a.status === "pending" || a.status === "todo").length;
    passed += assertions.filter((a) => a.status === "passed").length;
    skipped += fileSkipped;
    seen += assertions.length;

    files.push({ file: repoPath(String(item.name ?? "")), checks: assertions.length, status: item.status ?? "unknown" });

    /* 文件级加载失败（网关起不来、导入报错）时 assertionResults 是空的，
       只有 message。不记下来这种失败会从报告里消失。 */
    if (assertions.length === 0 && item.status === "failed") {
      const firstLine = String(item.message ?? "").split("\n").find((line) => line.trim()) ?? "文件加载失败";
      failures.push({
        name: `文件加载失败 ${repoPath(String(item.name ?? ""))}`,
        detail: firstLine.trim(),
        location: repoPath(String(item.name ?? "")),
        kind: "test",
      });
      continue;
    }

    for (const assertion of assertions) {
      if (assertion.status !== "failed") continue;
      const raw = (assertion.failureMessages ?? []).join("\n");
      const firstLine = raw.split("\n").find((line) => line.trim()) ?? "断言失败";
      failures.push({
        name: assertion.fullName ?? assertion.title ?? "未命名用例",
        detail: firstLine.trim(),
        location: firstFrameLocation(raw, root, dir ? `${dir}/` : ""),
        kind: "test",
      });
    }
  }

  const total = typeof report.numTotalTests === "number" ? report.numTotalTests : seen;
  const base = { unit: "用例", files, passedCount: passed, skippedCount: skipped };

  if (total === 0) {
    return {
      ...base,
      status: FAIL,
      checks: 0,
      detail: "一个用例都没收集到",
      failures: failures.length > 0 ? failures : [{ name: "收集结果为空", detail: "", location: null, kind: "test" }],
    };
  }

  if (failures.length > 0 || report.numFailedTests > 0) {
    const failed = typeof report.numFailedTests === "number" ? report.numFailedTests : failures.length;
    return { ...base, status: FAIL, checks: total, detail: `${failed}/${total} 个用例失败`, failures };
  }

  /* 无设备时唯一能「跑完」的就是扫描那条用例（它自己提前 return，vitest 记成 passed）。
     所以阈值是「至多一条通过」而不是「一条都没通过」。 */
  if (skipped > 0 && passed <= 1) {
    return {
      ...base,
      status: SKIP,
      checks: total,
      detail: "",
      failures: [],
      skipReason: `${skipped}/${total} 条用例跳过（设备不在或被别处占用），有效通过 ${passed} 条`,
    };
  }

  /* 只跑了一部分：层仍然 PASS（没有失败），但没跑到的部分必须进未验证清单。 */
  const innerSkips = skipped > 0 ? [`${skipped}/${total} 条用例跳过（运行中途设备不可用）`] : [];

  return {
    ...base,
    status: PASS,
    checks: total,
    detail: `${passed}/${total} 个用例通过${skipped > 0 ? `，${skipped} 条跳过` : ""}`,
    failures: [],
    skipped: innerSkips,
  };
};

/** 把 doctor.py 的 `NO  <项>  — <说明>` 行取出来，作为 SKIP 的原因。 */
export const parseDoctorFailures = (stdout) => {
  const failures = [];
  for (const raw of String(stdout ?? "").split("\n")) {
    const line = raw.trim();
    /* 要求 NO 后面至少两个空格：doctor 的格式是 `NO  ` 前缀，这条约束
       让正文里恰好以「NO」开头的英文单词不会被当成缺条件项。 */
    if (!/^NO\s{2,}/.test(line)) continue;
    const rest = line.replace(/^NO\s{2,}/, "");
    const splitAt = rest.indexOf("  — ");
    failures.push({
      name: splitAt < 0 ? rest : rest.slice(0, splitAt).trim(),
      detail: splitAt < 0 ? "" : rest.slice(splitAt + "  — ".length).trim(),
    });
  }
  return failures;
};

/**
 * 把 drive.mjs 的「不动」判定翻译成一句人能读的 SKIP 原因。
 *
 * 为什么不是直接抄它那行 `SKIP  前置条件不满足（doctor 退出码 1）`：那句话对
 * 「用户该做什么」没有信息量。真正的时间顺序是 doctor 先列出哪个 `NO` 项不满足，
 * 所以优先用 NO 项。最容易撞上的是「没插设备」——这一种要明说「缺真机」，
 * 因为它是本层最常被误读成代码回归的情形。
 */
const bleSkipReason = (stdout, doctorFailures) => {
  const missedScan = doctorFailures.find((item) => /扫到\s*Lumen/.test(item.name));
  if (missedScan) {
    return `缺真机（未扫到 Lumen-* 设备；检查上电、是否被别处连着、蓝牙适配器）`;
  }
  if (doctorFailures.length > 0) {
    /* 固件版本、帧合法性之类：环境问题，同样不是代码回归。 */
    return doctorFailures
      .map((item) => `${item.name}${item.detail ? `（${item.detail.split("。")[0]}）` : ""}`)
      .join("；");
  }
  const line = String(stdout)
    .split("\n")
    .map((raw) => raw.trim())
    .find((raw) => raw.startsWith("SKIP"));
  if (line) return line.replace(/^SKIP\s+/, "");
  return "真机驱动判定前置条件不满足";
};

/**
 * 合成 drive.mjs 的退出码与它写的 vitest JSON。
 *
 * 退出码优先：drive 判 SKIP 时即便 JSON 里有几条 passed，也只能记 SKIP——
 * 那是它自己的语义（例如 doctor 通过但设备随后被抢连）。
 */
export function summarizeBleRun({ exitCode, jsonText, stdout = "", root = ".", dir = "" }) {
  const parsed = jsonText ? parseE2eJson(jsonText, { root, dir }) : null;
  const doctorFailures = parseDoctorFailures(stdout);

  if (exitCode === 3) {
    return {
      status: SKIP,
      checks: parsed?.checks ?? null,
      unit: "用例",
      detail: "",
      failures: [],
      skipReason: bleSkipReason(stdout, doctorFailures),
      passedCount: parsed?.passedCount ?? 0,
      skippedCount: parsed?.skippedCount ?? 0,
      extra: { files: parsed?.files ?? [] },
    };
  }

  if (parsed === null) {
    return {
      status: FAIL,
      checks: null,
      unit: "用例",
      detail: `drive.mjs 没有产出 vitest.json（退出码 ${exitCode}）`,
      failures: [],
      files: [],
    };
  }

  if (parsed.status === FAIL) {
    return { ...parsed, extra: { files: parsed.files } };
  }

  /* 用例全过但非零退出：收尾（复位、断开）出问题了，不能算过。
     用例全被跳过时走不到这里——那条路已经在上面按 SKIP 返回了。 */
  if (exitCode !== 0) {
    return {
      ...parsed,
      status: FAIL,
      detail: `用例均未失败但 drive.mjs 退出码 ${exitCode}`,
      extra: { files: parsed.files },
    };
  }

  return { ...parsed, extra: { files: parsed.files } };
}

/** 真机驱动脚本与体检脚本的路径（随 skill 目录走，不依赖 cwd）。 */
const bleScripts = (repoRoot) => ({
  drive: join(repoRoot, BLE_SKILL_DIR, "drive.mjs"),
  doctor: join(repoRoot, BLE_SKILL_DIR, "doctor.py"),
});

/**
 * 探测真机层的前置条件：脚本在不在、依赖装没装、本机 python 能不能 import bleak。
 *
 * 刻意**不在这里扫设备**：drive.mjs 自己会跑 doctor.py，扫一次蓝牙要好几秒，
 * 探两遍只是让每次 `--release` 多等一会儿。设备维度的判定全部交给 drive 的退出码 3。
 */
const probeBle = (repoRoot) => () => {
  const scripts = bleScripts(repoRoot);
  const missing = [];
  if (!existsSync(scripts.drive)) missing.push(`缺真机驱动脚本 ${BLE_SKILL_DIR}/drive.mjs`);
  if (!existsSync(join(repoRoot, "miniprogram", "node_modules", "vitest", "vitest.mjs"))) {
    missing.push("miniprogram 缺 vitest（真机用例由它执行）");
  }
  if (missing.length > 0) return missing;

  if (!hasCommand("python")) {
    /* bleak 是网关的依赖；没有 python 就谈不上扫描。 */
    missing.push("缺 python / bleak（真机网关依赖 bleak）");
    return missing;
  }
  const res = spawnSync("python", ["-c", "import bleak"], { encoding: "utf8", timeout: 20_000 });
  if (res.status !== 0) {
    missing.push("缺 python / bleak（`import bleak` 失败）");
  }
  return missing;
};

/** 跑真机层。整轮（体检 + 16 条真机用例）在本机约一分钟，超时给到 10 分钟。 */
const runBle = ({ repoRoot }) => {
  const started = Date.now();
  const scripts = bleScripts(repoRoot);
  /* 给子进程一个确定的 RUN_ID，这样 JSON 落在已知目录里——否则只能猜它的时间戳，
     猜错就会把「没读到 JSON」误报成「零用例失败」。 */
  const RUN_ID = `orchestrator-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  const jsonPath = join(repoRoot, "miniprogram", ".auto", "evidence-ble", RUN_ID, "vitest.json");

  const res = spawnSync(process.execPath, [scripts.drive, "--scenario", "all"], {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: 600_000,
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, RUN_ID, FORCE_COLOR: "0" },
  });
  const durationMs = Date.now() - started;
  const stdout = `${res.stdout ?? ""}${res.stderr ?? ""}`;

  if (res.error) {
    return { status: FAIL, checks: null, unit: "用例", detail: String(res.error.message), failures: [], durationMs };
  }

  const jsonText = existsSync(jsonPath) ? readFileSync(jsonPath, "utf8") : null;
  const summary = summarizeBleRun({
    exitCode: res.status ?? 1,
    jsonText,
    stdout,
    root: join(repoRoot, "miniprogram"),
    dir: "miniprogram",
  });

  return { ...summary, durationMs };
};

/* ------------------------------------------------------------------ */
/* 层规格：把清单里的层定义变成可执行的东西                            */
/* ------------------------------------------------------------------ */

/**
 * 构造默认五层。probe 不通就是 SKIP，不跑；probe 通过才执行。
 * 只有 cheap 的层在默认（不带参数）运行时被选中。
 */
export function buildLayerSpecs(manifest, { repoRoot = REPO } = {}) {
  const specs = {};

  specs.firmware = {
    name: "firmware",
    label: manifest.layers.firmware?.label ?? "固件",
    cheap: true,
    probe: () => {
      const missing = [];
      if (!hasCommand(process.platform === "win32" ? "gcc" : "gcc")) missing.push("gcc");
      if (!hasCommand("node")) missing.push("node");
      return missing;
    },
    run: runFirmware,
  };

  /* 两层的探测都是「依赖装没装」。没装不是失败——是这台机器还没准备好，
     所以要 SKIP 并写清缺什么，而不是跑一遍 npm 然后报一堆看不懂的错。
     逐个检查真的会用到的两个 CLI：只判 node_modules 存在会把空目录也放进来。 */
  for (const [name, dirName] of [
    ["mp", "miniprogram"],
    ["server", "server"],
  ]) {
    specs[name] = {
      name,
      label: manifest.layers[name]?.label ?? name,
      cheap: true,
      probe: () => {
        const base = join(repoRoot, dirName);
        if (!existsSync(join(base, "node_modules"))) return [`${dirName}/node_modules 不存在`];
        const missing = [];
        if (!existsSync(join(base, "node_modules", "vitest", "vitest.mjs"))) missing.push(`${dirName} 缺 vitest`);
        if (!existsSync(join(base, "node_modules", "typescript", "bin", "tsc"))) missing.push(`${dirName} 缺 typescript`);
        return missing;
      },
      run: () => runNodeLayer({ dirName, repoRoot }),
    };
  }

  specs.ui = {
    name: "ui",
    label: manifest.layers.ui?.label ?? "渲染回归",
    /* 需要本机开着微信开发者工具，所以不进默认（不带参数）那一轮。 */
    cheap: false,
    unit: "断言",
    probe: probeUi,
    run: runUi,
  };

  specs.ble = {
    name: "ble",
    label: manifest.layers.ble?.label ?? "真机 e2e",
    /* 需要插着 ESP32 且没被别处连着，不进默认那一轮。 */
    cheap: false,
    unit: "用例",
    probe: probeBle(repoRoot),
    run: () => runBle({ repoRoot }),
  };

  return specs;
}

/** 空层：还没接入的层用这个占位，报告里明确写「尚未接入」而不是静默缺席。 */
export const notWiredYet = (name, label, cheap = false) => ({
  name,
  label,
  cheap,
  probe: () => [`${name} 层尚未接入编排器`],
  run: () => ({
    status: SKIP,
    checks: null,
    unit: "用例",
    detail: "尚未接入",
    failures: [],
    skipReason: `${name} 层尚未接入编排器`,
  }),
});

/* ------------------------------------------------------------------ */
/* 执行                                                               */
/* ------------------------------------------------------------------ */

/**
 * 跑一批层规格，返回结构化结果。规格可注入 —— 测试用假层验证报告结构，
 * 不需要真的跑测试。
 */
export function executeLayers(specs, { repoRoot = REPO, startedAt = nowIso() } = {}) {
  const results = [];

  for (const spec of specs) {
    const t0 = Date.now();
    const missing = spec.probe ? spec.probe() : [];

    if (missing.length > 0) {
      results.push({
        name: spec.name,
        label: spec.label,
        status: SKIP,
        checks: null,
        unit: spec.unit ?? "用例",
        detail: "",
        failures: [],
        skipReason: missing.join("、"),
        durationMs: Date.now() - t0,
      });
      continue;
    }

    const out = spec.run();
    results.push({
      name: spec.name,
      label: spec.label,
      status: out.status,
      checks: out.checks ?? null,
      unit: out.unit ?? "用例",
      detail: out.detail ?? "",
      failures: out.failures ?? [],
      skipReason: out.skipReason ?? null,
      /* 层整体 PASS 但内部有「本应跑却没跑」的步骤（#108 的 SKIPPED 标签）。
         它不改变层状态，但必须出现在未验证清单里。 */
      skipped: out.skipped ?? [],
      extra: out.extra ?? null,
      durationMs: out.durationMs ?? Date.now() - t0,
    });
  }

  const statuses = results.map((r) => r.status);
  return {
    runId: runIdOf(new Date(startedAt)),
    startedAt,
    finishedAt: nowIso(),
    head: {
      commit: git(["rev-parse", "--short", "HEAD"], "unknown"),
      branch: git(["rev-parse", "--abbrev-ref", "HEAD"], "unknown"),
      dirty: git(["status", "--porcelain"]) !== "",
      host: hostname(),
      platform: `${platform()} ${osRelease()}`,
      cpus: cpus().length,
      layers: results.map((r) => r.name),
    },
    layers: results,
    conclusion: statuses.includes(FAIL) ? FAIL : PASS,
  };
}

/** 从清单里取出每个已登记文件的说明，供报告明细用。 */
export function describeFiles(manifest, results, repoRoot = REPO) {
  const checksByLayer = new Map(results.map((r) => [r.name, r.checks]));
  /* 每个测试文件自己的用例数只有结构化输出给得出。拿不到就留空，
     不能回退成层总数——那会让「这个文件的用例数掉了」永远看不出来。 */
  const perFile = new Map();
  const layered = new Set();
  for (const layer of results) {
    const files = layer.extra?.files ?? [];
    if (files.length > 0) layered.add(layer.name);
    for (const file of files) perFile.set(file.file, file.checks);
  }
  return Object.entries(manifest.files)
    .map(([file, entry]) => {
      /* 固件那层是一个测试文件、一次输出，层总数就是文件数；
         而 mp/server 有了按文件的数字之后就不该再拿层总数冒充单文件。 */
      const checks = perFile.has(file)
        ? perFile.get(file)
        : layered.has(entry.layer)
          ? null
          : checksByLayer.get(entry.layer) ?? null;
      return {
        path: file,
        layer: entry.layer,
        covers: entry.covers,
        ticket: entry.ticket ?? null,
        checks,
        fromOutput: perFile.has(file),
      };
    })
    .sort((a, b) => a.layer.localeCompare(b.layer) || a.path.localeCompare(b.path));
}

/* ------------------------------------------------------------------ */
/* 渲染                                                               */
/* ------------------------------------------------------------------ */

const fmtDuration = (ms) => (ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`);

const statusCell = (status) => {
  if (status === PASS) return "✅ PASS";
  if (status === FAIL) return "❌ FAIL";
  return "⏭️ SKIP";
};

/** 报告六段的 Markdown 渲染。给人读；机器读的是同一份结果对象的 JSON。 */
export function renderReport(report, { title = "测试报告" } = {}) {
  const { head, layers, files = [], previous = null } = report;
  const skipped = layers.filter((l) => l.status === SKIP);
  const failed = layers.filter((l) => l.status === FAIL);
  /* 层内被显式标成 SKIPPED 的步骤（#108）。层本身可能仍是 PASS，
     所以不能只看层状态——「跑了一半」和「全跑了」必须显示得不一样。 */
  const innerSkips = layers.flatMap((layer) =>
    (layer.skipped ?? []).map((reason) => ({ layer, reason })),
  );
  const lines = [];

  lines.push(`# ${title}`, "");

  /* 1. 头部 */
  lines.push(`- **运行**：${report.startedAt}`);
  lines.push(`- **commit**：\`${head.commit}\`（分支 \`${head.branch}\`${head.dirty ? "，**工作区有未提交改动**" : ""}）`);
  lines.push(`- **机器**：${head.host} · ${head.platform} · ${head.cpus} 核`);
  lines.push(`- **触发了**：${head.layers.length ? head.layers.join(" / ") : "（无）"}`);
  lines.push(`- **结论**：${report.conclusion === FAIL ? "❌ 有失败" : "✅ 通过"}`);
  if (skipped.length > 0) {
    lines.push(`- **本轮未验证**：${skipped.map((l) => l.label).join("、")}`);
  }
  if (innerSkips.length > 0) {
    lines.push(`- **层内未验证**：${innerSkips.map((item) => `${item.layer.label}（${item.reason}）`).join("；")}`);
  }
  lines.push("");

  /* 2. 分层结果表 */
  lines.push("## 分层结果", "");
  lines.push("| 层 | 结果 | 用例数 | 耗时 | 说明 |");
  lines.push("|---|---|---|---|---|");
  for (const layer of layers) {
    const count = layer.checks === null ? "—" : `${layer.checks} ${layer.unit}`;
    lines.push(
      `| ${layer.label} | ${statusCell(layer.status)} | ${count} | ${fmtDuration(layer.durationMs)} | ${layer.detail || (layer.skipReason ?? "")} |`,
    );
  }
  lines.push("");

  /* 3. 未验证清单 —— 最重要的一段 */
  lines.push("## 未验证清单", "");
  if (skipped.length === 0 && innerSkips.length === 0) {
    lines.push("本轮没有未验证的层。", "");
  } else {
    for (const layer of skipped) {
      lines.push(`- **${layer.label}**：${layer.skipReason ?? "原因未记录"}`);
    }
    for (const item of innerSkips) {
      lines.push(`- **${item.layer.label}**：${item.reason}`);
    }
    lines.push("");
  }

  /* 4. 明细 */
  lines.push("## 明细", "");

  /* 4a. 固件按模块的断言数（#108）。取代文档里靠估算的占比表。 */
  for (const layer of layers) {
    const byTest = layer.extra?.byTest;
    if (!byTest || Object.keys(byTest).length === 0) continue;
    const entries = Object.entries(byTest).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    const total = entries.reduce((sum, [, count]) => sum + count, 0);
    lines.push(`### ${layer.label}：按测试函数的断言数`, "");
    lines.push(`共 ${entries.length} 个测试函数，${total} 条断言（按条数降序）。`, "");
    lines.push("| 测试函数 | 断言数 |");
    lines.push("|---|---|");
    for (const [name, count] of entries) {
      lines.push(`| \`${name}\` | ${count} |`);
    }
    lines.push("");
  }

  if (files.length === 0) {
    lines.push("（清单为空）", "");
  } else {
    const byLayer = new Map();
    for (const file of files) {
      if (!byLayer.has(file.layer)) byLayer.set(file.layer, []);
      byLayer.get(file.layer).push(file);
    }
    /* 按本轮触发的层顺序排，未触发的层排在后面——但它们仍要出现，
       否则「这一层有测试但本轮没跑」会从报告里消失。 */
    const order = [
      ...layers.map((layer) => layer.name),
      ...[...byLayer.keys()].filter((name) => !layers.some((layer) => layer.name === name)),
    ];
    for (const layerName of order) {
      const group = byLayer.get(layerName);
      if (!group || group.length === 0) continue;
      const layerInfo = layers.find((layer) => layer.name === layerName);
      lines.push(`### ${layerInfo?.label ?? layerName}`, "");
      lines.push("| 文件 | 覆盖 | 用例数 |");
      lines.push("|---|---|---|");
      for (const file of group) {
        const count = file.checks === null ? "—" : String(file.checks);
        lines.push(`| \`${file.path}\` | ${file.covers} | ${count} |`);
      }
      lines.push("");
    }
  }

  /* 5. 失败详情 */
  lines.push("## 失败详情", "");
  if (failed.length === 0) {
    lines.push("本轮没有失败。", "");
  } else {
    for (const layer of failed) {
      lines.push(`### ${layer.label}`, "");
      if (layer.detail) lines.push(layer.detail, "");
      if (layer.failures.length === 0) {
        lines.push("（没有逐条失败信息）", "");
      } else {
        /* 用例失败与类型错误分开列：修法完全不同，混在一起要先分辨哪条是哪类。 */
        const testFailures = layer.failures.filter((f) => f.kind !== "typecheck");
        const typeFailures = layer.failures.filter((f) => f.kind === "typecheck");

        if (testFailures.length > 0) {
          if (typeFailures.length > 0) lines.push("**用例失败**", "");
          for (const failure of testFailures) {
            lines.push(
              `- ${failure.name}${failure.detail ? ` — ${failure.detail}` : ""}${failure.location ? `（\`${failure.location}\`）` : ""}`,
            );
          }
          lines.push("");
        }
        if (typeFailures.length > 0) {
          lines.push("**类型错误**", "");
          for (const failure of typeFailures) {
            lines.push(
              `- \`${failure.location ?? "位置未知"}\` ${failure.name}${failure.detail ? ` — ${failure.detail}` : ""}`,
            );
          }
          lines.push("");
        }
      }
    }
  }

  /* 6. 与上次运行的差异 */
  lines.push("## 与上次运行", "");
  if (previous === null || previous === undefined) {
    lines.push("首次运行，无基线可比。", "");
  } else if (previous.error) {
    lines.push(`无法读取上次报告：${previous.error}`, "");
  } else {
    lines.push(previous.summary ?? "（差异计算未接入）", "");
  }

  return lines.join("\n");
}

export function writeReport(report, dir, { title } = {}) {
  mkdirSync(dir, { recursive: true });
  const md = renderReport(report, { title });
  writeFileSync(join(dir, "report.md"), `${md}\n`, "utf8");
  writeFileSync(join(dir, "report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return { dir, mdPath: join(dir, "report.md"), jsonPath: join(dir, "report.json") };
}

/* ------------------------------------------------------------------ */
/* CLI                                                                */
/* ------------------------------------------------------------------ */

const parseArgs = (argv) => {
  const layers = [];
  let release = false;
  let list = false;
  for (const arg of argv) {
    if (arg === "--release") release = true;
    else if (arg === "--list") list = true;
    else if (!arg.startsWith("-")) layers.push(arg);
  }
  return { layers, release, list };
};

function main() {
  const { layers, release, list } = parseArgs(process.argv.slice(2));

  let manifest;
  try {
    manifest = loadManifest(REPO);
  } catch (error) {
    console.error(`[test-run] 清单读取失败：${error.message ?? error}`);
    process.exit(2);
  }

  const wired = buildLayerSpecs(manifest);
  const allNames = Object.keys(manifest.layers);

  const fallback = (name) =>
    wired[name] ??
    notWiredYet(name, manifest.layers[name].label ?? name, manifest.layers[name].cheap === true);

  if (list) {
    for (const name of allNames) {
      const spec = fallback(name);
      const wiredMark = wired[name] ? "" : "（尚未接入）";
      console.log(`${name.padEnd(10)} ${spec.cheap ? "便宜" : "需环境"}  ${spec.label}${wiredMark}`);
    }
    return;
  }

  const selected = layers.length > 0 ? layers : allNames.filter((n) => manifest.layers[n].cheap);
  if (release) {
    for (const name of allNames) if (!selected.includes(name)) selected.push(name);
  }

  const unknown = selected.filter((name) => !manifest.layers[name]);
  if (unknown.length > 0) {
    console.error(`[test-run] 未知层：${unknown.join("、")}。可用：${allNames.join(" / ")}`);
    process.exit(2);
  }

  const specs = selected.map(fallback);
  const result = executeLayers(specs);
  result.files = describeFiles(manifest, result.layers);

  /* 清单漏登记 = 有人不知道自己跑了什么，正是这套流程要消灭的东西。
     所以它单独作为一条结论，让整轮判失败。 */
  const manifestCheck = checkManifest(manifest, REPO);
  result.manifest = {
    ok: manifestCheck.ok,
    total: manifestCheck.total,
    unregistered: manifestCheck.unregistered,
    missing: manifestCheck.missing,
    misplaced: manifestCheck.misplaced,
  };
  if (!manifestCheck.ok) {
    result.conclusion = FAIL;
    result.layers.push({
      name: "manifest",
      label: "清单查漏",
      status: FAIL,
      checks: manifestCheck.total,
      unit: "文件",
      detail: `有 ${manifestCheck.unregistered.length + manifestCheck.missing.length + manifestCheck.misplaced.length} 处不一致`,
      failures: [
        ...manifestCheck.unregistered.map((item) => ({ name: `未登记 ${item.file}`, detail: `应属 ${item.layer} 层` })),
        ...manifestCheck.missing.map((item) => ({ name: `文件不存在 ${item.file}`, detail: `登记为 ${item.layer} 层` })),
        ...manifestCheck.misplaced.map((item) => ({
          name: `层不一致 ${item.file}`,
          detail: `登记为 ${item.declared}，实际属 ${item.actual}`,
        })),
      ],
      durationMs: 0,
    });
  }

  const reportDir = release
    ? join(REPO, "docs", "evidence", "test-runs", result.runId)
    : join(REPO, ".reports", result.runId);

  const written = writeReport(result, reportDir);
  result.reportPath = written.mdPath;

  console.log(renderReport(result));
  console.log(`\n[test-run] 报告：${written.mdPath}`);

  process.exit(result.conclusion === FAIL ? 1 : 0);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
