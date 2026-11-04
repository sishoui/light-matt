#!/usr/bin/env node
/**
 * 真实链路驱动的编排器。
 *
 * 为什么是「编排」而不是「自己连 BLE」：被测代码是 **TypeScript 产品代码**
 * （`BleTransport` / `ControlSession` / 帧编解码），只有 vitest 能编译它。所以
 * 真实往返必须由 `npm run test:ble`（vitest + `tests/e2e/wx-bridge.mjs` + Python
 * 网关）执行，本脚本负责三件事，且只负责这三件：
 *
 *   1. 先跑 `doctor.py`：设备在不在、烧的是哪版固件 —— 不满足就 SKIP；
 *   2. 用 JSON reporter 跑 vitest，把每条用例的通过 / 跳过 / 失败归档；
 *   3. 收尾：报告设备现场是否被留脏（段 / 电源 / 亮度）。
 *
 * 用法：
 *   node .zcode/skills/verify-lumen-ble/scripts/drive.mjs --list
 *   node .zcode/skills/verify-lumen-ble/scripts/drive.mjs --scenario all
 *   node .zcode/skills/verify-lumen-ble/scripts/drive.mjs --scenario "段下发"
 *   node .zcode/skills/verify-lumen-ble/scripts/drive.mjs --scenario all --no-doctor
 *
 * 退出码：0 = 全过；1 = 有真实失败；3 = SKIP（没设备 / 固件不对），**不是失败**。
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
/* scripts -> verify-lumen-ble -> skills -> .zcode -> 仓库根 */
const REPO = resolve(HERE, "../../../..");
const MP = join(REPO, "miniprogram");
const RUN_ID = process.env.RUN_ID || new Date().toISOString().replace(/[:.]/g, "-");
const EVIDENCE_ROOT = join(REPO, "miniprogram", ".auto", "evidence-ble");
const DOCTOR = join(HERE, "doctor.py");

const args = process.argv.slice(2);
const opt = (name, fallback = null) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback;
};

if (args.includes("--list")) {
  console.log(
    [
      "all       跑整份真机 e2e（tests/e2e/real-device.test.ts，8 条用例）",
      "",
      "前置：设备上电、未被别处连着、烧的是 v4 固件；本机装了 python + bleak。",
      "无设备时退出码 3（SKIP），不是失败。",
      "",
      "**没有按名字筛选选项**：这份 e2e 的第一条用例本身就是「扫到设备」，",
      "用 vitest 的 -t 过滤会把它一起过滤掉，于是 device 永远是 null、其余用例",
      "全部 skip（实测）。要跑单条请临时加 .only，跑完记得去掉。",
    ].join("\n"),
  );
  process.exit(0);
}

const scenario = opt("scenario", "all");
const skipDoctor = args.includes("--no-doctor");
if (scenario !== "all") {
  console.error(
    `不支持 --scenario "${scenario}"：这份 e2e 靠第一条用例（扫描）给后续用例提供设备，\n` +
      `按名字过滤会把扫描一起滤掉，结果全部 skip（实测）。请用 --scenario all。`,
  );
  process.exit(2);
}
const outDir = join(EVIDENCE_ROOT, RUN_ID);
mkdirSync(outDir, { recursive: true });

const writeEvidence = (payload) => {
  const file = join(outDir, `ble-${scenario.replace(/[^\w\u4e00-\u9fa5-]/g, "_")}.json`);
  writeFileSync(file, JSON.stringify({ scenario, runId: RUN_ID, at: new Date().toISOString(), ...payload }, null, 2));
  console.log(`evidence: ${file}`);
};

/* ---------------- 1. doctor：设备与固件 ---------------- */

let doctorOutput = "";
if (!skipDoctor) {
  console.log("=== doctor：设备与固件 ===");
  const doctor = spawnSync("python", [DOCTOR], { encoding: "utf8", cwd: REPO, timeout: 120_000 });
  doctorOutput = `${doctor.stdout ?? ""}${doctor.stderr ?? ""}`;
  process.stdout.write(doctorOutput);
  if (doctor.status !== 0) {
    /* doctor 失败 = 前置条件不满足。SKIP，不红：没有设备时「测试失败」是谎报。 */
    const noDevice = /扫到 Lumen-\*|连上设备/.test(doctorOutput) && /NO /.test(doctorOutput);
    console.log(
      `\nSKIP  前置条件不满足（doctor 退出码 ${doctor.status}）——${noDevice ? "设备不在或连不上" : "见上面的 NO 行"}。`,
    );
    writeEvidence({ exitCode: 3, reason: "skip: doctor failed", doctor: doctorOutput, vitest: null });
    process.exit(3);
  }
} else {
  console.log("（跳过 doctor，直接跑 vitest）");
}

/* ---------------- 2. vitest：真实往返 ---------------- */

console.log("\n=== 真实往返：npm run test:ble（vitest + Python 网关 + 真实 ESP32）===");

const vArgs = ["vitest", "run", "--config", "vitest.e2e.config.ts", "--reporter=json", "--outputFile", join(outDir, "vitest.json")];

const vitest = spawnSync("npx", vArgs, {
  encoding: "utf8",
  cwd: MP,
  shell: true,
  timeout: 600_000,
  env: { ...process.env, FORCE_COLOR: "0" },
});
const vitestOut = `${vitest.stdout ?? ""}${vitest.stderr ?? ""}`;
process.stdout.write(vitestOut);

/* ---------------- 3. 汇总：通过 / 跳过 / 失败分开报 ---------------- */

let summary = { passed: 0, failed: 0, skipped: 0, total: 0, cases: [] };
const jsonFile = join(outDir, "vitest.json");
if (existsSync(jsonFile)) {
  try {
    const report = JSON.parse(execFileSync("node", ["-e", `process.stdout.write(require('fs').readFileSync(${JSON.stringify(jsonFile)},'utf8'))`], { encoding: "utf8" }));
    for (const file of report.testResults ?? []) {
      for (const t of file.assertionResults ?? []) {
        summary.total += 1;
        const status = t.status === "passed" ? "passed" : t.status === "failed" ? "failed" : "skipped";
        summary[status] += 1;
        summary.cases.push({
          name: t.fullName ?? t.title,
          status,
          ...(status === "failed" ? { message: (t.failureMessages ?? []).join("\n").slice(0, 1500) } : {}),
        });
      }
    }
  } catch (e) {
    console.log(`（解析 JSON 报告失败：${e}）`);
  }
}

/* ---------------- 4. 结论 ---------------- */

let exitCode;
if (summary.failed > 0) {
  exitCode = 1;
  console.log(`\n===== ${summary.passed} passed / ${summary.failed} failed / ${summary.skipped} skipped =====`);
  for (const c of summary.cases.filter((x) => x.status === "failed")) {
    console.log(`FAIL  ${c.name}`);
  }
} else if (summary.total > 0 && summary.passed === 0 && summary.skipped === summary.total) {
  /* 全部 skip：设备没了但 doctor 过了（被别处抢连等）。SKIP，不红。 */
  exitCode = 3;
  console.log(`\n===== SKIP：${summary.skipped} 条全部跳过（设备可能被别处占用）=====`);
} else if (summary.total === 0) {
  exitCode = vitest.status === 0 ? 0 : 1;
  console.log("\n（没有解析到用例结果，按 vitest 退出码判定）");
} else {
  exitCode = 0;
  console.log(`\n===== ${summary.passed} passed / 0 failed / ${summary.skipped} skipped =====`);
}

writeEvidence({
  exitCode,
  reason: exitCode === 0 ? "pass" : exitCode === 3 ? "skip" : "fail",
  doctor: doctorOutput,
  vitest: summary,
});
process.exit(exitCode);
