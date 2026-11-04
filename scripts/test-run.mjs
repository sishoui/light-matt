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

export const parseFirmwareOutput = (stdout) => {
  const checksMatch = stdout.match(/all (\d+) checks passed/);
  const failedMatch = stdout.match(/(\d+)\/(\d+) checks failed/);
  const vectorsMatch = stdout.match(/vectors: (\d+) cases/);

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
    };
  }
  if (checksMatch) {
    return {
      status: PASS,
      checks: Number(checksMatch[1]),
      unit: "断言",
      detail: `${checksMatch[1]} 条断言通过`,
      failures,
      extra: { vectors: vectorsMatch ? Number(vectorsMatch[1]) : null },
    };
  }
  return { status: FAIL, checks: null, unit: "断言", detail: "输出里找不到断言统计", failures: [] };
};

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

  /* 显式 skip 标签（#108 会把 run-tests.cmd 改成输出它）目前还不存在，
     但编排器先认这个前缀，免得将来改了脚本这里还要动。 */
  const skipLine = stdout
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.startsWith("SKIPPED:"));

  if (skipLine) {
    return { ...parsed, status: PASS, skipReason: skipLine.slice("SKIPPED:".length).trim(), durationMs };
  }

  if (res.error) {
    return { status: FAIL, checks: null, unit: "断言", detail: String(res.error.message), failures: [], durationMs };
  }
  if (res.status !== 0 && parsed.status === PASS) {
    return { ...parsed, status: FAIL, detail: `退出码 ${res.status}`, durationMs };
  }
  return { ...parsed, durationMs };
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
  if (skipped.length === 0) {
    lines.push("本轮没有未验证的层。", "");
  } else {
    for (const layer of skipped) {
      lines.push(`- **${layer.label}**：${layer.skipReason ?? "原因未记录"}`);
    }
    lines.push("");
  }

  /* 4. 明细 */
  lines.push("## 明细", "");
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
