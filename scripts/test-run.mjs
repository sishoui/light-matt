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
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { cpus, hostname, platform, release as osRelease } from "node:os";
import { dirname, join, resolve } from "node:path";
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
/* 层规格：把清单里的层定义变成可执行的东西                            */
/* ------------------------------------------------------------------ */

/**
 * 构造默认五层。probe 不通就是 SKIP，不跑；probe 通过才执行。
 * 只有 cheap 的层在默认（不带参数）运行时被选中。
 */
export function buildLayerSpecs(manifest) {
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

  specs.ui = {
    name: "ui",
    label: manifest.layers.ui?.label ?? "渲染回归",
    /* 需要本机开着微信开发者工具，所以不进默认（不带参数）那一轮。 */
    cheap: false,
    unit: "断言",
    probe: probeUi,
    run: runUi,
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
  return Object.entries(manifest.files)
    .map(([file, entry]) => ({
      path: file,
      layer: entry.layer,
      covers: entry.covers,
      ticket: entry.ticket ?? null,
      checks: checksByLayer.get(entry.layer) ?? null,
    }))
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
        for (const failure of layer.failures) {
          lines.push(`- ${failure.name}${failure.detail ? ` — ${failure.detail}` : ""}`);
        }
        lines.push("");
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
