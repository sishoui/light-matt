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
