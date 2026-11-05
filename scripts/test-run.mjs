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
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { cpus, hostname, platform, release as osRelease, tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
// @ts-expect-error -- 同目录的工具脚本是 .mjs，没有类型声明
import { checkManifest, loadManifest } from "./check-test-manifest.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO = resolve(HERE, "..");

const errorMessage = (error) => String(error?.message ?? error);

/** 层执行抛异常时降级成 FAIL，而不是让整轮无报告。 */
const failedLayer = (spec, durationMs, detail) => ({
  name: spec.name,
  label: spec.label,
  status: FAIL,
  checks: null,
  unit: spec.unit ?? "用例",
  detail,
  failures: [{ name: detail, detail: "" }],
  skipReason: null,
  skipped: [],
  extra: null,
  durationMs,
});

/** 把清单查漏的五类问题摊平成一份可渲染的失败清单。 */
export function manifestIssues(check) {
  return [
    ...(check.unregistered ?? []).map((item) => ({ name: `未登记 ${item.file}`, detail: `应属 ${item.layer} 层` })),
    ...(check.missing ?? []).map((item) => ({ name: `文件不存在 ${item.file}`, detail: `登记为 ${item.layer} 层` })),
    ...(check.misplaced ?? []).map((item) => ({
      name: `层不一致 ${item.file}`,
      detail: `登记为 ${item.declared}，实际属 ${item.actual}`,
    })),
    ...(check.unknownLayer ?? []).map((item) => ({ name: `未知层 ${item.file}`, detail: `声明了 ${item.layer}` })),
    ...(check.emptyCovers ?? []).map((item) => ({ name: `缺少覆盖说明 ${item.file}`, detail: "covers 是空的" })),
  ];
}

const VALID_STATUSES = new Set(["PASS", "FAIL", "SKIP"]);
const PASS = "PASS";
const FAIL = "FAIL";
const SKIP = "SKIP";

const nowIso = () => new Date().toISOString();
const runIdOf = (date = new Date()) =>
  date.toISOString().replace(/[:.]/g, "-").replace("Z", "");

/**
 * 两个报告池：日常运行写本地（被 gitignore），发布全量归档进 git。
 *
 * 分开的不只是目录，还有「上一次」的索敌范围：日常报告与归档互相当基线，
 * 两边都会得到一个跟本轮无关的数字。而发布归档只有跟上一份归档比，
 * 「这次比上次多跑了哪层」才有意义。
 */
export function reportRoots(release, repoRoot = REPO) {
  const root = release
    ? join(repoRoot, "docs", "evidence", "test-runs")
    : join(repoRoot, ".reports");
  return { runRoot: root, baselineRoot: root };
}

/**
 * 同一毫秒内跑两次（脚本被循环调用、CI 缓存目录、时钟精度不足）会撞同一个
 * 目录名。撞名就是静默覆盖——上一份证据还没进 git 就被这一份换掉了，
 * 而报告里看不出任何异常。
 *
 * 序号补两位：`-02` 要排在 `-10` 前面，否则字典序就不再等于时间序，
 * `findPreviousReportDir` 会挑错基线。
 */
export function uniqueRunId(baseId, taken = []) {
  const used = new Set(taken);
  if (!used.has(baseId)) return baseId;
  for (let n = 2; n < 100; n += 1) {
    const candidate = `${baseId}-${String(n).padStart(2, "0")}`;
    if (!used.has(candidate)) return candidate;
  }
  throw new Error(`同一毫秒内运行次数过多：${baseId}`);
}

/** 在给定目录里挑一个没被占用的 RUN_ID。目录不存在时就是第一个。 */
export function pickRunId(runRoot, date = new Date()) {
  let taken = [];
  try {
    taken = readdirSync(runRoot);
  } catch {
    taken = [];
  }
  return uniqueRunId(runIdOf(date), taken);
}

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
    /* 向量自检失败只退出码非零、不打 [FAIL] 前缀，断言统计照样是「全过」。
       只写「退出码 1」会让失败详情段落空着——把 stderr 的尾巴带出来，
       否则得手动重跑才知道哪条向量错了。 */
    const tail = String(res.stderr ?? "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .slice(-8);
    return {
      ...parsed,
      status: FAIL,
      detail: `退出码 ${res.status}${tail.length > 0 ? `：${tail[tail.length - 1]}` : ""}`,
      failures: tail.map((line) => ({ name: line, detail: "" })),
      skipped,
      durationMs,
    };
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
 *   3. 用例数取**实际收集数**，不抄文档里的手抄数字。
 */

/**
 * 走查用例组的已知分歧行在 vitest 里的标题前缀（`titleOf` 生成）。
 *
 * 它们 skip 的原因是「这条发现今天还在」，不是「设备中途没了」。混成一类
 * 会把 12 条已确认的缺陷报成「运行中途设备不可用」——一句明确错误的诊断。
 */
export const KNOWN_DIVERGENCE_PREFIX = "[已知分歧";

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
  /* 跳过原因按标题前缀分流：已知分歧是「这条缺陷今天还在」，不是环境问题。 */
  let knownDivergenceSkips = 0;

  for (const item of results) {
    const assertions = Array.isArray(item.assertionResults) ? item.assertionResults : [];
    const isSkip = (a) => a.status === "skipped" || a.status === "pending" || a.status === "todo";
    const fileSkipped = assertions.filter(isSkip).length;
    passed += assertions.filter((a) => a.status === "passed").length;
    skipped += fileSkipped;
    seen += assertions.length;
    knownDivergenceSkips += assertions.filter(
      (a) => isSkip(a) && String(a.title ?? a.fullName ?? "").startsWith(KNOWN_DIVERGENCE_PREFIX),
    ).length;

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

  /* 只跑了一部分：层仍然 PASS（没有失败），但没跑到的部分必须进未验证清单。
   *
   * 两类跳过必须分开报。走查用例组的已知分歧行是**今天该失败的 12 项发现**：
   * 把它们归进「运行中途设备不可用」是一句明确错误的诊断，也会让
   * 「这轮验了 12 项缺陷」和「这轮设备中途掉了」在报告里长得一样。 */
  const divergenceSkips = Math.min(knownDivergenceSkips, skipped);
  const deviceDownSkips = skipped - divergenceSkips;
  const innerSkips = [];
  if (divergenceSkips > 0) {
    innerSkips.push(
      `${divergenceSkips} 条跳过是已知分歧（走查用例组里规格 #127 的发现，今天预期仍未修好）`,
    );
  }
  if (deviceDownSkips > 0) {
    innerSkips.push(`${deviceDownSkips}/${total} 条用例跳过（运行中途设备不可用）`);
  }

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

/** 跑真机层。整轮（体检 + 全部真机用例）在本机约一分钟，超时给到 10 分钟。 */
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
      /* 固件测试入口是 .cmd，只能在 cmd.exe 里跑。别的平台上把它交给 sh
         必然失败，会被误判成「代码回归」——那是环境缺失，不是测试失败。 */
      if (process.platform !== "win32") return ["固件层需要 Windows + cmd.exe"];
      const missing = [];
      if (!hasCommand("gcc")) missing.push("gcc");
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

    /* 探测与执行都必须兜住异常。工具的核心承诺是「产出一份能自证的报告」，
       而 readFileSync / spawn / 写只读目录都可能抛——让异常打穿到这里，
       结果是一份报告都不写，连「哪层崩了」都留不下。 */
    let missing;
    try {
      missing = spec.probe ? spec.probe() : [];
    } catch (error) {
      results.push(failedLayer(spec, Date.now() - t0, `探测时异常：${errorMessage(error)}`));
      continue;
    }

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

    let out;
    try {
      out = spec.run();
    } catch (error) {
      results.push(failedLayer(spec, Date.now() - t0, `执行时异常：${errorMessage(error)}`));
      continue;
    }
    /* 状态只允许三态。缺省或拼错时降级成 FAIL 并写明——
       否则 undefined 会渲染成「不是 FAIL 也不带原因」的假绿。 */
    if (!VALID_STATUSES.has(out.status)) {
      results.push(failedLayer(spec, Date.now() - t0, `层返回了非法状态：${String(out.status)}`));
      continue;
    }
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
/* 与上次运行的差异（#109）                                            */
/* ------------------------------------------------------------------ */

/**
 * 差异只比「用例数」，不逐条比用例名。
 *
 * 为什么不做逐条比对：用例名会改，改名会产生整屏噪音，把一个真信号（某个文件少了
 * 12 条）淹掉。文件级的数字变化才是能直接触发警觉的东西。
 *
 * 这里只接受两份已落盘的 report.json 形状（顶层 files 数组 + layers 数组），
 * 不接受内存里的层结果——差异节的语义就是「和上一次那份文件比」。
 */
const isCount = (value) => typeof value === "number" && Number.isFinite(value);
const failureKey = (failure) => `${failure?.location ?? ""}|${failure?.name ?? ""}`;

export function diffRuns(current, previous) {
  /* 只比本轮真正跑了的层。否则「这次只跑了固件」会拿上次的全量报告当基线，
     其余 77 个文件全落进「无法比对」把真正要看的内容淹掉。
     判据取本轮层的 status：没被触发的层在 report.json 里根本不存在。 */
  const ranLayers = new Set((current?.layers ?? []).map((layer) => layer?.name).filter(Boolean));
  const scopedToRun = (file) => ranLayers.has(file.layer);

  const currentFiles = new Map(
    (current?.files ?? []).filter(scopedToRun).map((file) => [file.path, file]),
  );
  /* 上次没跑这一层时，它的文件全都没有逐文件数字。那种情况不是「可比较性
     变了」，是根本没得比——拿它记「无法比对」会把 unchanged 永久打成 false，
     每次都报一堆假差异。 */
  const previousRanLayers = new Set((previous?.layers ?? []).map((layer) => layer?.name).filter(Boolean));
  const previousFiles = new Map(
    (previous?.files ?? [])
      .filter((file) => scopedToRun(file) && previousRanLayers.has(file.layer))
      .map((file) => [file.path, file]),
  );

  const changed = [];
  const added = [];
  const removed = [];
  /* 一边拿得到数字、另一边拿不到时才记「无法比对」：这代表可比较性变了，
     值得看一眼。两边都拿不到（该层两轮都没跑）说明这个文件本来就没有逐文件
     数字，列出来只会把 80 行「—/—」塞进每一份报告里。 */
  const notCompared = [];
  let comparable = 0;

  for (const [path, file] of currentFiles) {
    const before = previousFiles.get(path);
    if (before === undefined) {
      added.push({ path, layer: file.layer, current: file.checks ?? null });
      continue;
    }
    if (!isCount(file.checks) || !isCount(before.checks)) {
      if (isCount(file.checks) !== isCount(before.checks)) {
        notCompared.push({ path, layer: file.layer, previous: before.checks ?? null, current: file.checks ?? null });
      }
      continue;
    }
    comparable += 1;
    if (file.checks !== before.checks) {
      changed.push({
        path,
        layer: file.layer,
        previous: before.checks,
        current: file.checks,
        delta: file.checks - before.checks,
      });
    }
  }

  for (const [path, file] of previousFiles) {
    if (currentFiles.has(path)) continue;
    removed.push({ path, layer: file.layer, previous: file.checks ?? null });
  }

  const currentLayers = (current?.layers ?? []).filter((layer) => layer && layer.name);
  const previousLayers = new Map(
    (previous?.layers ?? []).filter((layer) => layer && layer.name).map((layer) => [layer.name, layer]),
  );

  /* 上次就已经红的失败不该算「这次新出现的」——否则一条陈年失败每天都很刺眼，
     真正的新失败反而看不出来。 */
  const previousFailureKeys = new Set();
  for (const layer of previousLayers.values()) {
    for (const failure of layer.failures ?? []) previousFailureKeys.add(`${layer.name}|${failureKey(failure)}`);
  }

  /* SKIP 按层判：上次这层就没跑成，这次还是它，不算新增。
     层内显式 skip（#108 的 SKIPPED 标签）单独按原因判——层可能照跑，只是少了一步。 */
  const previousSkippedLayers = new Set(
    [...previousLayers.values()].filter((layer) => layer.status === SKIP).map((layer) => layer.name),
  );
  const previousInnerSkips = new Set();
  for (const layer of previousLayers.values()) {
    for (const reason of layer.skipped ?? []) previousInnerSkips.add(`${layer.name}|${reason}`);
  }

  const newFailures = [];
  const seenFailures = new Set();
  const newSkips = [];
  const seenSkips = new Set();
  const layers = [];

  for (const layer of currentLayers) {
    const label = layer.label ?? layer.name;
    for (const failure of layer.failures ?? []) {
      const key = `${layer.name}|${failureKey(failure)}`;
      if (previousFailureKeys.has(key) || seenFailures.has(key)) continue;
      seenFailures.add(key);
      newFailures.push({
        layer: layer.name,
        label,
        name: failure.name ?? "未命名用例",
        detail: failure.detail ?? "",
        location: failure.location ?? null,
      });
    }

    /* 只认「上次这一层真的跑了、这次没跑成」。上次根本没触发这一层
       （例如日常只跑便宜三层、这次加了 --release）时不叫「新出现的跳过」——
       它本来就一直在未验证清单里，重复报到差异节只会稀释真信号。 */
    if (layer.status === SKIP && previousLayers.has(layer.name) && !previousSkippedLayers.has(layer.name)) {
      const reason = layer.skipReason ?? "原因未记录";
      const key = `${layer.name}|${reason}`;
      if (!seenSkips.has(key)) {
        seenSkips.add(key);
        newSkips.push({ layer: layer.name, label, reason, kind: "layer" });
      }
    }
    for (const reason of layer.skipped ?? []) {
      if (!previousLayers.has(layer.name)) continue;
      const key = `${layer.name}|${reason}`;
      if (previousInnerSkips.has(key) || seenSkips.has(key)) continue;
      seenSkips.add(key);
      newSkips.push({ layer: layer.name, label, reason, kind: "inner" });
    }

    const before = previousLayers.get(layer.name);
    if (before === undefined) continue;
    /* 只在状态变了时列一层。用例数的变化在文件表里已经有了，层表再来一遍
       会让单文件层（固件、渲染回归）把同一件事说两遍。 */
    if (before.status === layer.status) continue;
    layers.push({
      name: layer.name,
      label,
      previousStatus: before.status,
      currentStatus: layer.status,
      previousChecks: before.checks ?? null,
      currentChecks: layer.checks ?? null,
    });
  }

  const byPath = (a, b) => a.path.localeCompare(b.path);
  changed.sort(byPath);
  added.sort(byPath);
  removed.sort(byPath);
  notCompared.sort(byPath);

  return {
    runId: current?.runId ?? null,
    previousRunId: previous?.runId ?? null,
    previousStartedAt: previous?.startedAt ?? null,
    comparable,
    files: { changed, added, removed },
    notCompared,
    layers,
    newFailures,
    newSkips,
    /* 全都空才算「无变化」：某个文件降了、出现新红、出现新的没跑成，
       任意一条都不该被一句「无变化」盖掉。可比较性变了（一边拿不到数字）
       同样不算无变化——那意味着有一层没跑出逐文件结果。 */
    unchanged:
      changed.length === 0 &&
      added.length === 0 &&
      removed.length === 0 &&
      notCompared.length === 0 &&
      newFailures.length === 0 &&
      newSkips.length === 0 &&
      layers.length === 0,
  };
}

/**
 * 找「上一次」的报告目录。
 *
 * RUN_ID 是 ISO 时间戳变形（`2026-11-04T16-11-58-431`），时区统一是 Z，
 * 所以字典序就是时间序。只取严格小于当前 RUN_ID 的目录——相等说明是同一轮
 * （重跑同一目录），拿自己当基线会得到一份永远「无变化」的报告。
 *
 * 没有 report.json 的目录不当基线：写了一半的运行不能冒充上一次。
 */
export function findPreviousReportDir(baseDir, runId) {
  let entries;
  try {
    entries = readdirSync(baseDir, { withFileTypes: true });
  } catch {
    return null;
  }

  const candidates = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => name < runId)
    .filter((name) => existsSync(join(baseDir, name, "report.json")))
    .sort();

  return candidates.length === 0 ? null : candidates[candidates.length - 1];
}

/**
 * 读上一次的报告。坏 JSON 与 schema 不兼容都不抛错——差异节是报告的一部分，
 * 不能因为「上一份写坏了」就让整轮测试失败。
 */
export function readPreviousReport(dir) {
  let raw;
  try {
    raw = readFileSync(join(dir, "report.json"), "utf8");
  } catch (error) {
    return { error: `读不到 report.json（${error.message ?? error}）` };
  }

  let report;
  try {
    report = JSON.parse(raw);
  } catch (error) {
    return { error: `report.json 不是合法 JSON（${error.message ?? error}）` };
  }

  if (report === null || typeof report !== "object" || Array.isArray(report)) {
    return { error: "schema 不兼容：顶层不是对象" };
  }
  if (!Array.isArray(report.layers)) {
    return { error: "schema 不兼容：layers 不是数组" };
  }
  if (report.files !== undefined && !Array.isArray(report.files)) {
    return { error: "schema 不兼容：files 不是数组" };
  }

  return { report };
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
export function renderReport(report, { title = "测试报告", release = false } = {}) {
  const { head, layers, files = [], previous = null } = report;
  const skipped = layers.filter((l) => l.status === SKIP);
  const failed = layers.filter((l) => l.status === FAIL);
  /* 层内被显式标成 SKIPPED 的步骤（#108）。层本身可能仍是 PASS，
     所以不能只看层状态——「跑了一半」和「全跑了」必须显示得不一样。 */
  const innerSkips = layers.flatMap((layer) =>
    (layer.skipped ?? []).map((reason) => ({ layer, reason })),
  );
  /* 发布归档的「没覆盖到」必须单独成段、放在标题正下方。
     普通顶部那行「本轮未验证」在长报告里只是一条列表项，而这一份是要
     被半年后的自己当成「当时发版测过了」的东西——被误读成全绿比没归档更糟。
     没有 SKIP 的层时不写这段：永远挂着的警告跟没有警告一样。 */
  const lines = [];

  lines.push(`# ${title}`, "");

  if (release && skipped.length > 0) {
    lines.push(
      `> ⚠️ **发布级证据，但本轮发布未覆盖：${skipped.map((l) => l.label).join("、")}。**`,
      ">",
      `> ${skipped.map((l) => `${l.label}：${l.skipReason ?? "原因未记录"}`).join("；")}`,
      ">",
      "> 这些层本轮没有跑，不能按通过计。下面每一段都是在「上述层未验证」的前提下写的。",
      "",
    );
  }

  /* 1. 头部 */
  lines.push(`- **运行**：${report.startedAt}`);
  lines.push(`- **commit**：\`${head.commit}\`（分支 \`${head.branch}\`${head.dirty ? "，**工作区有未提交改动**" : ""}）`);
  lines.push(`- **机器**：${head.host} · ${head.platform} · ${head.cpus} 核`);
  lines.push(`- **触发了**：${head.layers.length ? head.layers.join(" / ") : "（无）"}`);
  if (release) {
    /* 发布归档要能一眼数清五层各自的结果，不用往下翻表。 */
    lines.push(`- **五层结果**：${layers.map((l) => `${l.label} ${statusCell(l.status)}`).join(" · ")}`);
  }
  /*
   * 结论行必须如实反映「有没有层没跑」（#116）。
   *
   * 以前只要不是 FAIL 就写「✅ 通过」，于是整层 SKIP 时报告顶部仍是一个绿勾——
   * 「没跑」和「跑过了」在终端上长得一样，这正是这一轮要修的可信度问题。
   * 现在的口径：
   *   - 有失败        → ❌ 有失败
   *   - 有整层没跑    → ⚠️ 未全验证（写明哪几层）
   *   - 只跳过层内项  → ✅ 通过（N 项层内跳过）
   *   - 其余          → ✅ 通过
   * 退出码不动：SKIP 仍然不算失败（缺环境是常态），但结论文字不能再给它背书。
   */
  const verdict = (() => {
    if (report.conclusion === FAIL) {
      return "❌ 有失败";
    }
    if (skipped.length > 0) {
      return `⚠️ 未全验证（${skipped.map((l) => l.label).join("、")} 未跑）`;
    }
    if (innerSkips.length > 0) {
      return `✅ 通过（${innerSkips.length} 项层内跳过）`;
    }
    return "✅ 通过";
  })();
  lines.push(`- **结论**：${verdict}`);
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

  /* 6. 与上次运行的差异（#109）——只比用例数，不做逐用例比对 */
  lines.push("## 与上次运行", "");
  if (previous === null || previous === undefined) {
    lines.push("首次运行，无基线可比。", "");
  } else if (previous.error) {
    lines.push(`无法读取上次报告：${previous.error}`, "");
  } else if (previous.summary) {
    /* 兼容更早的占位形状（曾用 summary 字段），也方便外部直接塞一段文字。 */
    lines.push(previous.summary, "");
  } else {
    lines.push(...renderDiff(previous), "");
  }

  return lines.join("\n");
}

/**
 * 差异节的正文。
 *
 * 顺序是刻意的：先说「有没有变化」，再说新红与新没跑成（这两类最需要人动手），
 * 最后才是逐文件的数字。用例数是一份统计，新失败是一个待办——待办放前面。
 */
function renderDiff(diff) {
  const lines = [];
  const { files } = diff;
  const baseline = diff.previousRunId ? `\`${diff.previousRunId}\`` : "上一次运行";
  lines.push(`对比基线：${baseline}${diff.previousStartedAt ? `（${diff.previousStartedAt}）` : ""}`, "");

  if (diff.unchanged) {
    lines.push(
      `**无变化**：本次比对了 ${diff.comparable} 个测试文件的用例数，与上次一致；也没有新出现的失败或跳过。`,
      "",
    );
    return lines;
  }

  if (diff.newFailures.length > 0) {
    lines.push(`### 新出现的失败（${diff.newFailures.length} 条）`, "");
    for (const failure of diff.newFailures) {
      lines.push(
        `- **${failure.label}** ${failure.name}${failure.detail ? ` — ${failure.detail}` : ""}${failure.location ? `（\`${failure.location}\`）` : ""}`,
      );
    }
    lines.push("");
  }

  if (diff.newSkips.length > 0) {
    lines.push(`### 新出现的跳过（${diff.newSkips.length} 项）`, "");
    for (const item of diff.newSkips) {
      const kind = item.kind === "inner" ? "层内步骤" : "整层";
      lines.push(`- **${item.label}**（${kind}）：${item.reason}`);
    }
    lines.push("");
  }

  if (files.changed.length > 0) {
    lines.push(`### 用例数变化（${files.changed.length} 个文件）`, "");
    lines.push("| 文件 | 上次 | 本次 | 差值 |");
    lines.push("|---|---|---|---|");
    for (const item of files.changed) {
      lines.push(`| \`${item.path}\` | ${item.previous} | ${item.current} | ${item.delta > 0 ? "+" : ""}${item.delta} |`);
    }
    lines.push("");
  }

  if (files.added.length > 0) {
    lines.push(`### 新增文件（${files.added.length} 个）`, "");
    for (const item of files.added) {
      lines.push(`- \`${item.path}\`（${item.layer} 层，本次 ${item.current === null ? "—" : `${item.current} 用例`}）`);
    }
    lines.push("");
  }

  if (files.removed.length > 0) {
    /* 消失的文件通常意味着清单查漏会报错，但差异节也要指名道姓：
       只看到查漏失败的人不知道该去哪找。 */
    lines.push(`### 消失文件（${files.removed.length} 个）`, "");
    for (const item of files.removed) {
      lines.push(`- \`${item.path}\`（${item.layer} 层，上次 ${item.previous === null ? "—" : `${item.previous} 用例`}）`);
    }
    lines.push("");
  }

  if (diff.layers && diff.layers.length > 0) {
    lines.push(`### 层变化（${diff.layers.length} 层）`, "");
    lines.push("| 层 | 上次 | 本次 | 上次用例数 | 本次用例数 |");
    lines.push("|---|---|---|---|---|");
    for (const item of diff.layers) {
      lines.push(
        `| ${item.label} | ${statusCell(item.previousStatus)} | ${statusCell(item.currentStatus)} | ${item.previousChecks ?? "—"} | ${item.currentChecks ?? "—"} |`,
      );
    }
    lines.push("");
  }

  if (diff.notCompared && diff.notCompared.length > 0) {
    /* 数字缺失时宁可说「没比」也不当成 0：伪造的差值比没有差值更糟。 */
    lines.push(`### 无法比对（${diff.notCompared.length} 个文件）`, "");
    for (const item of diff.notCompared) {
      lines.push(`- \`${item.path}\`：上次 ${item.previous ?? "—"}，本次 ${item.current ?? "—"}（有一侧没拿到用例数）`);
    }
    lines.push("");
  }

  lines.push(`本次共比对 ${diff.comparable} 个测试文件的用例数。`);
  return lines;
}

/**
 * 找基线并算出差异。任何一步失败都只影响差异节，不影响本轮结论——
 * 「上一份报告坏了」不是这次代码有问题。
 */
export function loadBaseline(baseDir, runId, current = null) {
  const previousDir = findPreviousReportDir(baseDir, runId);
  if (previousDir === null) return null;
  const loaded = readPreviousReport(join(baseDir, previousDir));
  if (loaded.error) return { error: `${previousDir}：${loaded.error}` };
  if (current === null) return loaded.report;
  return diffRuns(current, loaded.report);
}

export function writeReport(report, dir, { title, release = false } = {}) {
  mkdirSync(dir, { recursive: true });
  const md = renderReport(report, { title, release });
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
      /* 五类问题必须全都列出来：只数三类会让「covers 全是空格」这种清单
         变成「❌ FAIL / 有 0 处不一致 /（没有逐条失败信息）」——红了却说不出
         为什么，而 --release 归档的正是这份报告。 */
      detail: `有 ${manifestIssues(manifestCheck).length} 处不一致`,
      failures: manifestIssues(manifestCheck),
      durationMs: 0,
    });
  }

  /* 两个池子分开：日常报告写本地（被 gitignore），发布全量归档进 git。
     目录名带毫秒，但同毫秒撞名时补序号——覆盖掉一份还没进 git 的证据
     是看不见的损失，补一位序号成本几乎为零。 */
  const { runRoot, baselineRoot } = reportRoots(release, REPO);
  result.runId = pickRunId(runRoot, new Date(result.startedAt));
  result.release = release;
  const reportDir = join(runRoot, result.runId);

  /* 基线与本次报告在同一个池子里找：日常报告只和日常报告比，发布归档只和
     归档比。两条路径混着找会让「上次」变成一台机器上的私有历史，
     归档里那几份反而永远没有基线。 */
  const previous = loadBaseline(baselineRoot, result.runId, result);
  if (previous !== null) result.previous = previous;

  const written = writeReport(result, reportDir, { release });
  result.reportPath = written.mdPath;

  console.log(renderReport(result, { release }));
  console.log(`\n[test-run] 报告：${written.mdPath}`);
  if (release) {
    console.log("[test-run] 发布级证据：这份报告应随本次发布一起提交进 git。");
  }

  process.exit(result.conclusion === FAIL ? 1 : 0);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
