import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
// @ts-expect-error -- 仓库根的工具脚本是 .mjs，没有类型声明
import {
  buildLayerSpecs,
  combineNodeLayerResults,
  describeFiles,
  diffRuns,
  executeLayers,
  findPreviousReportDir,
  parseFirmwareOutput,
  parseSkippedTags,
  parseTestCounts,
  parseTscOutput,
  parseUiOutput,
  parseVitestJson,
  readPreviousReport,
  renderReport,
  writeReport,
} from "../../scripts/test-run.mjs";

/**
 * 编排器的外在行为有三面：报告的结论对不对、三态语义守不守、退出码对不对。
 * 全部用假层驱动，不真的跑测试——真跑一遍只能证明「今天这台机器能跑」。
 */

const layer = (name, overrides: Record<string, unknown> = {}) => ({
  name,
  label: `${name} 层`,
  cheap: true,
  probe: () => [],
  run: () => ({ status: "PASS", checks: 10, unit: "用例", detail: "10 条通过", failures: [] }),
  ...overrides,
});

const fakeManifest = (files: Record<string, unknown> = {}) => ({
  layers: {
    firmware: { label: "固件", cheap: true },
    mp: { label: "小程序", cheap: true },
    ui: { label: "渲染", cheap: false },
  },
  files,
});

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "lumen-report-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("executeLayers", () => {
  it("全通过时结论为通过", () => {
    const result = executeLayers([layer("firmware"), layer("mp")]);

    expect(result.conclusion).toBe("PASS");
    expect(result.layers.map((l: { status: string }) => l.status)).toEqual(["PASS", "PASS"]);
  });

  it("任意一层失败时结论为失败", () => {
    const result = executeLayers([
      layer("firmware"),
      layer("mp", {
        run: () => ({ status: "FAIL", checks: 3, unit: "用例", detail: "1 条失败", failures: [{ name: "断言 A", detail: "期望 1 实得 2" }] }),
      }),
    ]);

    expect(result.conclusion).toBe("FAIL");
    expect(result.layers[1].failures).toHaveLength(1);
  });

  it("探测不通的层记 SKIP，不执行它的 run", () => {
    let ran = false;
    const result = executeLayers([
      layer("ui", {
        probe: () => ["缺微信开发者工具自动化端口"],
        run: () => {
          ran = true;
          return { status: "PASS", checks: 1, unit: "用例", detail: "", failures: [] };
        },
      }),
    ]);

    expect(ran).toBe(false);
    expect(result.layers[0].status).toBe("SKIP");
    expect(result.layers[0].skipReason).toBe("缺微信开发者工具自动化端口");
  });

  it("SKIP 不影响结论，但会进未验证清单", () => {
    const result = executeLayers([
      layer("mp"),
      layer("ui", { probe: () => ["缺自动化端口"] }),
    ]);

    expect(result.conclusion).toBe("PASS");
    const md = renderReport(result);
    expect(md).toContain("## 未验证清单");
    expect(md).toContain("缺自动化端口");
  });

  it("每个 SKIP 都必须带原因，不会出现原因不明的跳过", () => {
    const result = executeLayers([layer("ui", { probe: () => ["缺真机"] })]);

    for (const item of result.layers) {
      if (item.status !== "SKIP") continue;
      expect(String(item.skipReason ?? "").trim().length).toBeGreaterThan(0);
    }
  });

  it("头部记下 commit、分支、机器与触发了哪些层", () => {
    const result = executeLayers([layer("firmware"), layer("mp")]);

    expect(result.head.commit).toBeTruthy();
    expect(result.head.branch).toBeTruthy();
    expect(result.head.host).toBeTruthy();
    expect(result.head.layers).toEqual(["firmware", "mp"]);
    expect(result.runId).toBeTruthy();
  });

  it("计时是实测的，不是填零", () => {
    const result = executeLayers([
      layer("slow", {
        run: () => {
          const until = Date.now() + 12;
          while (Date.now() < until) {
            /* 空转一小会儿，制造可测的耗时 */
          }
          return { status: "PASS", checks: 1, unit: "用例", detail: "", failures: [] };
        },
      }),
    ]);

    expect(result.layers[0].durationMs).toBeGreaterThanOrEqual(0);
    expect(typeof result.layers[0].durationMs).toBe("number");
  });
});

describe("renderReport 六段", () => {
  const base = () =>
    executeLayers([
      layer("firmware", { run: () => ({ status: "PASS", checks: 13996, unit: "断言", detail: "13996 条断言通过", failures: [], extra: { vectors: 93 } }) }),
      layer("ui", { probe: () => ["缺微信开发者工具自动化端口"] }),
    ]);

  it("六段标题都在", () => {
    const md = renderReport(base());

    expect(md).toContain("## 分层结果");
    expect(md).toContain("## 未验证清单");
    expect(md).toContain("## 明细");
    expect(md).toContain("## 失败详情");
    expect(md).toContain("## 与上次运行");
    expect(md.startsWith("# 测试报告")).toBe(true);
  });

  it("分层结果表有三态单元格", () => {
    const md = renderReport(base());

    expect(md).toContain("✅ PASS");
    expect(md).toContain("⏭️ SKIP");
  });

  it("失败时分层表与失败详情都反映出来", () => {
    const md = renderReport(
      executeLayers([
        layer("mp", {
          run: () => ({ status: "FAIL", checks: 5, unit: "用例", detail: "2 条失败", failures: [{ name: "home-search", detail: "期望 3 实得 1" }] }),
        }),
      ]),
    );

    expect(md).toContain("❌ FAIL");
    expect(md).toContain("home-search");
    expect(md).toContain("期望 3 实得 1");
  });

  it("没有失败时明确说没有，而不是留空白", () => {
    expect(renderReport(base())).toContain("本轮没有失败");
  });

  it("首次运行写明无基线", () => {
    expect(renderReport(base())).toContain("首次运行，无基线可比");
  });

  it("上次报告损坏时写明原因，不抛错", () => {
    const report = { ...base(), previous: { error: "JSON 解析失败" } };

    expect(() => renderReport(report)).not.toThrow();
    expect(renderReport(report)).toContain("JSON 解析失败");
  });

  it("明细按层展开，每个文件带说明", () => {
    const report = base();
    report.files = [
      { path: "miniprogram/tests/a.test.ts", layer: "mp", covers: "某个行为", ticket: null, checks: 7 },
    ];
    const md = renderReport(report);

    expect(md).toContain("miniprogram/tests/a.test.ts");
    expect(md).toContain("某个行为");
  });

  it("工作区有未提交改动时头部标出来", () => {
    const report = base();
    report.head.dirty = true;

    expect(renderReport(report)).toContain("工作区有未提交改动");
  });
});

describe("writeReport", () => {
  it("同目录写 md 与 json 两份", () => {
    const result = executeLayers([layer("firmware")]);
    const written = writeReport(result, join(dir, "run-1"));

    const md = readFileSync(written.mdPath, "utf8");
    const json = JSON.parse(readFileSync(written.jsonPath, "utf8"));

    expect(md).toContain("## 未验证清单");
    expect(json.conclusion).toBe("PASS");
    expect(json.layers[0].name).toBe("firmware");
  });

  it("json 字段名稳定，可被下次运行读取比对", () => {
    const result = executeLayers([layer("firmware")]);
    const written = writeReport(result, join(dir, "run-2"));

    const json = JSON.parse(readFileSync(written.jsonPath, "utf8"));

    for (const key of ["runId", "startedAt", "finishedAt", "head", "layers", "conclusion"]) {
      expect(json, `缺少字段 ${key}`).toHaveProperty(key);
    }
    for (const key of ["name", "label", "status", "checks", "unit", "durationMs"]) {
      expect(json.layers[0], `层结果缺少字段 ${key}`).toHaveProperty(key);
    }
  });

  it("重复写同一目录会覆盖，不会追加出脏数据", () => {
    const result = executeLayers([layer("firmware")]);
    const target = join(dir, "run-3");

    writeReport(result, target);
    const second = writeReport(result, target);

    expect(JSON.parse(readFileSync(second.jsonPath, "utf8")).layers).toHaveLength(1);
  });
});

describe("固件输出解析", () => {
  it("从真实输出格式里取出断言数与向量数", () => {
    const ok = parseFirmwareOutput(
      ["vectors: 93 cases from docs/protocol-testvectors-v4.json", "all 13996 checks passed"].join("\n"),
    );

    expect(ok.status).toBe("PASS");
    expect(ok.checks).toBe(13996);
    expect(ok.extra.vectors).toBe(93);
  });

  it("失败输出里取出失败条数与失败行", () => {
    const failed = parseFirmwareOutput(
      ["[FAIL] test_x.c:42: a.b == 3", "vectors: 93 cases from x", "2/13996 checks failed"].join("\n"),
    );

    expect(failed.status).toBe("FAIL");
    expect(failed.checks).toBe(13996);
    expect(failed.failures).toHaveLength(1);
    expect(failed.failures[0].name).toContain("a.b == 3");
  });

  it("输出里没有统计时判失败，而不是默认通过", () => {
    const garbage = parseFirmwareOutput("gcc: error: something broke");

    expect(garbage.status).toBe("FAIL");
  });
});

/* ------------------------------------------------------------------ */
/* 小程序层与后端层                                                    */
/* ------------------------------------------------------------------ */

/* 样本取自真实运行：`npx vitest run --reporter=json` 的字段名就是这么写的。
   用手抄的样本而不是现场跑一次，是因为现场跑一次只能证明「今天这台机器能跑」，
   而这里要锁的是解析契约。 */
const VITEST_JSON_OK = JSON.stringify({
  numTotalTestSuites: 4,
  numPassedTestSuites: 4,
  numFailedTestSuites: 0,
  numPendingTestSuites: 0,
  numTotalTests: 42,
  numPassedTests: 42,
  numFailedTests: 0,
  numPendingTests: 0,
  numTodoTests: 0,
  success: true,
  startTime: 1793809042193,
  testResults: [
    {
      name: "C:/repo/miniprogram/tests/add-device.test.ts",
      status: "passed",
      message: "",
      startTime: 1793809042193,
      endTime: 1793809042203.5,
      assertionResults: [
        { ancestorTitles: ["搜索匹配"], fullName: "搜索匹配 去首尾空白", status: "passed", title: "去首尾空白", duration: 1.7, failureMessages: [], meta: {} },
        { ancestorTitles: ["搜索匹配"], fullName: "搜索匹配 不区分大小写", status: "passed", title: "不区分大小写", duration: 0.4, failureMessages: [], meta: {} },
      ],
    },
    {
      name: "C:/repo/miniprogram/tests/chunk.test.ts",
      status: "passed",
      message: "",
      startTime: 1793809042193,
      endTime: 1793809042210.1,
      assertionResults: Array.from({ length: 24 }, (_, i) => ({
        ancestorTitles: ["分片"],
        fullName: `分片 用例 ${i}`,
        status: "passed",
        title: `用例 ${i}`,
        duration: 0.2,
        failureMessages: [],
        meta: {},
      })),
    },
    {
      name: "C:/repo/miniprogram/tests/codec.test.ts",
      status: "passed",
      message: "",
      startTime: 1793809042193,
      endTime: 1793809042212.9,
      assertionResults: Array.from({ length: 16 }, (_, i) => ({
        ancestorTitles: ["编解码"],
        fullName: `编解码 用例 ${i}`,
        status: "passed",
        title: `用例 ${i}`,
        duration: 0.3,
        failureMessages: [],
        meta: {},
      })),
    },
  ],
});

const VITEST_JSON_FAIL = JSON.stringify({
  numTotalTestSuites: 1,
  numPassedTestSuites: 0,
  numFailedTestSuites: 1,
  numPendingTestSuites: 0,
  numTotalTests: 2,
  numPassedTests: 1,
  numFailedTests: 1,
  numPendingTests: 0,
  numTodoTests: 0,
  success: false,
  startTime: 1793809042193,
  testResults: [
    {
      name: "C:/repo/miniprogram/tests/__probe-fail.test.ts",
      status: "failed",
      message: "",
      startTime: 1793809042193,
      endTime: 1793809042200.2,
      assertionResults: [
        { ancestorTitles: ["探针"], fullName: "探针 会失败的用例", status: "failed", title: "会失败的用例", duration: 7.4, failureMessages: [
          "AssertionError: expected 2 to be 3 // Object.is equality\n    at C:\\repo\\miniprogram\\tests\\__probe-fail.test.ts:5:19\n    at file:///C:/repo/miniprogram/node_modules/@vitest/runner/dist/index.js:146:14",
        ], meta: {} },
      ],
    },
  ],
});

/* tsc 的报错格式是 `文件(行,列): error TSxxxx: 文案`，样本取自真实失败输出。 */
const TSC_OUTPUT_FAIL = [
  "__tsc-probe.ts(1,7): error TS2322: Type 'string' is not assignable to type 'number'.",
  "tests/broken.test.ts(42,13): error TS7006: Parameter 'x' implicitly has an 'any' type.",
].join("\n");

describe("vitest 结构化输出解析", () => {
  it("用例数来自 JSON，且按文件分得开", () => {
    const parsed = parseVitestJson(VITEST_JSON_OK, { root: "C:/repo/miniprogram" });

    expect(parsed.status).toBe("PASS");
    expect(parsed.checks).toBe(42);
    expect(parsed.unit).toBe("用例");
    expect(parsed.files).toEqual([
      { file: "tests/add-device.test.ts", checks: 2, status: "passed" },
      { file: "tests/chunk.test.ts", checks: 24, status: "passed" },
      { file: "tests/codec.test.ts", checks: 16, status: "passed" },
    ]);
  });

  it("总数与按文件加总一致——否则就是解析漏了文件", () => {
    const parsed = parseVitestJson(VITEST_JSON_OK, { root: "C:/repo/miniprogram" });
    const sum = parsed.files.reduce((acc: number, f: { checks: number }) => acc + f.checks, 0);

    expect(sum).toBe(parsed.checks);
  });

  it("失败详情带断言原文与文件:行，且不把 node_modules 里的栈帧当位置", () => {
    const parsed = parseVitestJson(VITEST_JSON_FAIL, { root: "C:/repo/miniprogram" });

    expect(parsed.status).toBe("FAIL");
    expect(parsed.checks).toBe(2);
    expect(parsed.failures).toHaveLength(1);
    expect(parsed.failures[0].name).toContain("探针 会失败的用例");
    expect(parsed.failures[0].detail).toContain("expected 2 to be 3");
    expect(parsed.failures[0].location).toBe("tests/__probe-fail.test.ts:5");
  });

  it("读不动的 JSON 判失败，不会静默当成零用例通过", () => {
    const parsed = parseVitestJson("{ 不是 JSON", { root: "C:/repo/miniprogram" });

    expect(parsed.status).toBe("FAIL");
    expect(parsed.checks).toBeNull();
    expect(parsed.detail).toContain("JSON");
  });

  it("一个用例都没有也算失败——空跑不该看起来像通过", () => {
    const empty = parseVitestJson(JSON.stringify({ numTotalTests: 0, success: true, testResults: [] }), { root: "C:/repo/miniprogram" });

    expect(empty.status).toBe("FAIL");
  });
});

describe("tsc 输出解析", () => {
  it("报错被解析成带文件与行的 failures", () => {
    const parsed = parseTscOutput(TSC_OUTPUT_FAIL, { root: "C:/repo/miniprogram" });

    expect(parsed.status).toBe("FAIL");
    expect(parsed.failures).toHaveLength(2);
    expect(parsed.failures[0].name).toContain("TS2322");
    expect(parsed.failures[0].detail).toContain("not assignable to type 'number'");
    expect(parsed.failures[0].location).toBe("__tsc-probe.ts:1");
    expect(parsed.failures[1].location).toBe("tests/broken.test.ts:42");
  });

  it("没有输出就是没有类型错误", () => {
    const parsed = parseTscOutput("", { root: "C:/repo/miniprogram" });

    expect(parsed.status).toBe("PASS");
    expect(parsed.failures).toEqual([]);
  });

  it("有报错但格式认不出来时仍判失败，不吞掉", () => {
    const parsed = parseTscOutput("tsc: 莫名其妙地死了", { root: "C:/repo/miniprogram" });

    expect(parsed.status).toBe("FAIL");
    expect(parsed.detail).toContain("莫名其妙");
  });
});

describe("两层合成：vitest 与 tsc 都计入同一层", () => {
  const vitestOk = () => parseVitestJson(VITEST_JSON_OK, { root: "C:/repo/miniprogram" });
  const vitestFail = () => parseVitestJson(VITEST_JSON_FAIL, { root: "C:/repo/miniprogram" });
  const tscOk = () => parseTscOutput("", { root: "C:/repo/miniprogram" });
  const tscFail = () => parseTscOutput(TSC_OUTPUT_FAIL, { root: "C:/repo/miniprogram" });

  it("用例通过但类型错误时整层判 FAIL", () => {
    const merged = combineNodeLayerResults(vitestOk(), tscFail());

    expect(merged.status).toBe("FAIL");
    expect(merged.failures.some((f: { name: string }) => /TS2322/.test(f.name))).toBe(true);
    expect(merged.detail).toContain("类型错误");
  });

  it("用例失败但类型干净时整层判 FAIL，且用例数仍然报出来", () => {
    const merged = combineNodeLayerResults(vitestFail(), tscOk());

    expect(merged.status).toBe("FAIL");
    expect(merged.checks).toBe(2);
    expect(merged.failures[0].location).toBe("tests/__probe-fail.test.ts:5");
  });

  it("两件事都好才 PASS，并按文件带上用例数", () => {
    const merged = combineNodeLayerResults(vitestOk(), tscOk());

    expect(merged.status).toBe("PASS");
    expect(merged.checks).toBe(42);
    expect(merged.extra.files).toHaveLength(3);
    expect(merged.extra.typecheck).toBe("PASS");
  });
});

describe("层规格的探测", () => {
  const fakeManifest = () => ({
    layers: {
      mp: { label: "小程序单测", cheap: true },
      server: { label: "后端单测", cheap: true },
    },
    files: {},
  });

  it("mp 与 server 都已接入（不再是占位实现）", () => {
    const specs = buildLayerSpecs(fakeManifest(), {
      repoRoot: mkdtempSync(join(tmpdir(), "lumen-wired-")),
    });

    expect(specs.mp).toBeTruthy();
    expect(specs.server).toBeTruthy();
    expect(specs.mp.cheap).toBe(true);
  });

  it("node_modules 不存在时该层 SKIP 并写明缺什么", () => {
    const root = mkdtempSync(join(tmpdir(), "lumen-nodeps-"));
    try {
      const specs = buildLayerSpecs(fakeManifest(), { repoRoot: root });

      const mpMissing = specs.mp.probe();
      const serverMissing = specs.server.probe();

      expect(mpMissing.join("")).toContain("miniprogram/node_modules");
      expect(serverMissing.join("")).toContain("server/node_modules");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("SKIP 的层带着原因进报告，而不是静默缺席", () => {
    const root = mkdtempSync(join(tmpdir(), "lumen-nodeps2-"));
    try {
      const specs = buildLayerSpecs(fakeManifest(), { repoRoot: root });
      const result = executeLayers([specs.mp, specs.server]);

      expect(result.layers.map((l: { status: string }) => l.status)).toEqual(["SKIP", "SKIP"]);
      expect(result.layers[0].skipReason).toContain("node_modules");
      const md = renderReport(result);
      expect(md).toContain("miniprogram/node_modules");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("报告明细里的按文件用例数", () => {
  const manifest = () => ({
    layers: {
      mp: { label: "小程序单测", cheap: true },
      firmware: { label: "固件 host 测试", cheap: true },
    },
    files: {
      "miniprogram/tests/add-device.test.ts": { layer: "mp", covers: "搜索匹配", ticket: "#92" },
      "miniprogram/tests/chunk.test.ts": { layer: "mp", covers: "分片重组" },
      "firmware/test/test_skeleton.c": { layer: "firmware", covers: "固件全量" },
    },
  });

  it("每个文件拿到自己那一份用例数，不是层总数", () => {
    const parsed = parseVitestJson(VITEST_JSON_OK, { root: "C:/repo/miniprogram", dir: "miniprogram" });
    const result = executeLayers([
      layer("mp", { run: () => combineNodeLayerResults(parsed, { status: "PASS", failures: [], detail: "" }) }),
    ]);

    const files = describeFiles(manifest(), result.layers, "C:/repo");
    const addDevice = files.find((f: { path: string }) => f.path.endsWith("add-device.test.ts"));
    const chunk = files.find((f: { path: string }) => f.path.endsWith("chunk.test.ts"));

    expect(addDevice.checks).toBe(2);
    expect(chunk.checks).toBe(24);
    expect(addDevice.fromOutput).toBe(true);
  });

  it("明细表把每个文件的用例数写在对应行上", () => {
    const parsed = parseVitestJson(VITEST_JSON_OK, { root: "C:/repo/miniprogram", dir: "miniprogram" });
    const result = executeLayers([
      layer("mp", { run: () => combineNodeLayerResults(parsed, { status: "PASS", failures: [], detail: "" }) }),
    ]);
    result.files = describeFiles(manifest(), result.layers, "C:/repo");
    const md = renderReport(result);

    expect(md).toContain("| `miniprogram/tests/add-device.test.ts` | 搜索匹配 | 2 |");
    expect(md).toContain("| `miniprogram/tests/chunk.test.ts` | 分片重组 | 24 |");
  });

  it("结构化输出里没有这个文件时留空，不拿层总数冒充", () => {
    const parsed = parseVitestJson(VITEST_JSON_OK, { root: "C:/repo/miniprogram", dir: "miniprogram" });
    const result = executeLayers([
      layer("mp", { run: () => combineNodeLayerResults(parsed, { status: "PASS", failures: [], detail: "" }) }),
    ]);
    const files = describeFiles(
      { ...manifest(), files: { "miniprogram/tests/未跑到.test.ts": { layer: "mp", covers: "没跑到" } } },
      result.layers,
      "C:/repo",
    );

    expect(files[0].checks).toBeNull();
    expect(files[0].fromOutput).toBe(false);
  });
});

describe("失败详情分清用例失败与类型错误", () => {
  it("两类失败分开列，各自带定位", () => {
    const merged = combineNodeLayerResults(
      parseVitestJson(VITEST_JSON_FAIL, { root: "C:/repo/miniprogram", dir: "miniprogram" }),
      parseTscOutput(TSC_OUTPUT_FAIL, { root: "C:/repo/miniprogram" }),
    );
    const result = executeLayers([layer("mp", { run: () => merged })]);
    const md = renderReport(result);

    expect(md).toContain("**用例失败**");
    expect(md).toContain("**类型错误**");
    expect(md).toContain("`miniprogram/tests/__probe-fail.test.ts:5`");
    expect(md).toContain("`__tsc-probe.ts:1`");
    expect(md).toContain("TS2322");
  });

  it("用例通过、类型报错时分层表仍是 FAIL", () => {
    const merged = combineNodeLayerResults(
      parseVitestJson(VITEST_JSON_OK, { root: "C:/repo/miniprogram", dir: "miniprogram" }),
      parseTscOutput(TSC_OUTPUT_FAIL, { root: "C:/repo/miniprogram" }),
    );
    const result = executeLayers([layer("mp", { run: () => merged })]);
    const md = renderReport(result);

    expect(result.conclusion).toBe("FAIL");
    expect(md).toContain("| mp 层 | ❌ FAIL | 42 用例 |");
  });
});

/**
 * #108：固件侧从「只有一个总数」变成「按测试函数的真实数字」，
 * 以及 node 缺失时那个静默 skip 必须变成可见记录。
 *
 * 样本取自固件测试的真实输出（`TESTCOUNT <函数名> <断言数>`，一行一个函数）。
 * 断言里刻意保留那条最大的 `vectors` 桶：向量阶段不在任何 test_*() 里跑，
 * 不单独记就对不上总数。
 */
describe("固件按测试函数的断言数（#108）", () => {
  const REAL_SAMPLE = [
    "vectors: 93 cases from docs/protocol-testvectors-v4.json",
    "TESTCOUNT vectors 2732",
    "TESTCOUNT test_checksum 10",
    "TESTCOUNT test_set_power_reducer 47",
    "TESTCOUNT test_set_brightness_reducer 70",
    "TESTCOUNT test_retired_commands 98",
    "TESTCOUNT test_encode_ack_all_results 123",
    "TESTCOUNT test_gamma 21",
    "TESTCOUNT test_planar_null_safety 7",
    "all 13996 checks passed",
  ].join("\n");

  /* 上面样本里各行的数字之和。写死它是故意的：改样本就会同时改这里的期望。 */
  const SAMPLE_SUM = 2732 + 10 + 47 + 70 + 98 + 123 + 21 + 7;

  it("按函数名分组解析出断言数", () => {
    const counts = parseTestCounts(REAL_SAMPLE);

    expect(counts.byTest["vectors"]).toBe(2732);
    expect(counts.byTest["test_checksum"]).toBe(10);
    expect(counts.byTest["test_set_power_reducer"]).toBe(47);
    expect(counts.byTest["test_encode_ack_all_results"]).toBe(123);
    expect(counts.count).toBe(8);
  });

  it("解析后的总数等于各行之和", () => {
    const counts = parseTestCounts(REAL_SAMPLE);

    expect(counts.total).toBe(SAMPLE_SUM);
    expect(Object.values(counts.byTest).reduce((sum: number, n: unknown) => sum + Number(n), 0)).toBe(SAMPLE_SUM);
  });

  it("同一函数出现多次时累加，不静默覆盖", () => {
    const counts = parseTestCounts(["TESTCOUNT test_a 5", "TESTCOUNT test_a 7"].join("\n"));

    expect(counts.byTest["test_a"]).toBe(12);
    expect(counts.total).toBe(12);
    expect(counts.count).toBe(1);
  });

  it("只认行首前缀，行内出现同名单词不算", () => {
    const counts = parseTestCounts(
      ["gcc: error: TESTCOUNT test_x 99", "# TESTCOUNT test_y 5", "TESTCOUNT test_z 3"].join("\n"),
    );

    expect(Object.keys(counts.byTest)).toEqual(["test_z"]);
    expect(counts.total).toBe(3);
  });

  it("统计行走真输出时，分组数字挂进层结果的 extra.byTest", () => {
    const parsed = parseFirmwareOutput(REAL_SAMPLE);

    expect(parsed.status).toBe("PASS");
    expect(parsed.extra.byTest["vectors"]).toBe(2732);
    expect(parsed.extra.vectors).toBe(93);
    /* 分组之和必须能对上总数——总数由 all N checks passed 单独给出。
       样本不是全量，所以这里比的是样本自身之和，不是 13996。 */
    expect(Object.values(parsed.extra.byTest).reduce((sum: number, n: unknown) => sum + Number(n), 0)).toBe(SAMPLE_SUM);
  });

  it("没有统计行时 byTest 为 null，不伪造空分组", () => {
    const parsed = parseFirmwareOutput("all 13996 checks passed");

    expect(parsed.extra.byTest).toBeNull();
  });

  it("报告明细里出现按模块的数字表", () => {
    const result = executeLayers([
      layer("firmware", {
        run: () => ({
          status: "PASS",
          checks: 13996,
          unit: "断言",
          detail: "13996 条断言通过",
          failures: [],
          extra: { vectors: 93, byTest: { vectors: 2732, test_checksum: 10 } },
        }),
      }),
    ]);

    const md = renderReport(result);
    expect(md).toContain("按测试函数的断言数");
    expect(md).toContain("`test_checksum`");
    expect(md).toContain("2732");
  });
});

describe("显式 skip 标签（#108）", () => {
  const SKIPPED_LINE = "SKIPPED: v4 vector self-check (node not found)";

  it("识别成未验证项而不是失败", () => {
    const reasons = parseSkippedTags([SKIPPED_LINE, "all 13996 checks passed"].join("\n"));

    expect(reasons).toEqual(["v4 vector self-check (node not found)"]);
  });

  it("标签只出现在行首才算，正文里提到不算", () => {
    expect(parseSkippedTags("note: SKIPPED: not a tag")).toEqual([]);
  });

  it("空原因不记，避免出现「原因不明」的未验证项", () => {
    expect(parseSkippedTags("SKIPPED:   ")).toEqual([]);
  });

  it("层仍是 PASS，但未验证清单里能看到它", () => {
    const result = executeLayers([
      layer("firmware", {
        run: () => ({
          status: "PASS",
          checks: 13996,
          unit: "断言",
          detail: "13996 条断言通过",
          failures: [],
          skipped: ["v4 vector self-check (node not found)"],
        }),
      }),
    ]);

    expect(result.conclusion).toBe("PASS");
    const md = renderReport(result);
    expect(md).toContain("## 未验证清单");
    expect(md).toContain("v4 vector self-check (node not found)");
    expect(md).toContain("层内未验证");
  });
});

/**
 * 渲染回归（ui 层）的输出解析。
 *
 * 样本是 `scripts/verify-v5.mjs` 真实输出的形状：每行 `PASS  名字` 或
 * `FAIL  名字  — 差异`，末尾一行汇总。解析器必须自己数行——只信汇总行的话，
 * 失败详情里就拿不到断言名，报告也就没法让人直接跳过去修。
 */
describe("渲染回归输出解析", () => {
  const SAMPLE_PASS = [
    "PASS  小程序启动、页面已注册",
    "PASS  「我的」页切深色后根节点是 theme-dark  — theme-dark",
    "PASS  原生滑块的激活色是深色主题色  — #8FA9C4",
    "PASS  搜索框按名称过滤  — {\"searching\":true,\"hits\":1,\"name\":\"书桌\"}",
    "PASS  圆盘刻度 1–100  — 100",
    "",
    "===== 5 passed / 0 failed =====",
  ].join("\n");

  const SAMPLE_FAIL = [
    "PASS  小程序启动、页面已注册",
    "PASS  首页有搜索框",
    "FAIL  灯组卡片一列排布",
    "FAIL  方案恰好三个圆形按钮  — 2",
    "PASS  没有整条「已连接」状态栏",
    "",
    "===== 3 passed / 2 failed =====",
  ].join("\n");

  it("从真实输出里数出断言数并判 PASS", () => {
    const ok = parseUiOutput(SAMPLE_PASS, 0);

    expect(ok.status).toBe("PASS");
    expect(ok.checks).toBe(5);
    expect(ok.unit).toBe("断言");
    expect(ok.failures).toEqual([]);
  });

  it("有 FAIL 时判失败，失败详情带断言名与差异描述", () => {
    const failed = parseUiOutput(SAMPLE_FAIL, 1);

    expect(failed.status).toBe("FAIL");
    expect(failed.checks).toBe(5);
    expect(failed.failures).toHaveLength(2);
    expect(failed.failures[0].name).toBe("灯组卡片一列排布");
    expect(failed.failures[0].detail).toBe("");
    expect(failed.failures[1].name).toBe("方案恰好三个圆形按钮");
    expect(failed.failures[1].detail).toBe("2");
    expect(failed.detail).toContain("2/5");
  });

  it("SKIPPED: 前缀被识别成 SKIP 并带原因，不是 FAIL", () => {
    const skipped = parseUiOutput("SKIPPED: 缺微信开发者工具自动化端口（ws://127.0.0.1:9501：ECONNREFUSED）\n", 0);

    expect(skipped.status).toBe("SKIP");
    expect(skipped.failures).toEqual([]);
    expect(String(skipped.skipReason)).toContain("缺微信开发者工具自动化端口");
  });

  it("断言全过但退出码非零时判失败，不因行都是 PASS 就放过", () => {
    expect(parseUiOutput(SAMPLE_PASS, 1).status).toBe("FAIL");
  });

  it("输出里一条断言行都没有时判失败，而不是默认通过", () => {
    expect(parseUiOutput("Error: something blew up", 1).status).toBe("FAIL");
  });
});

describe("ui 层接线", () => {
  it("ui 层需要环境，不进默认那一轮", () => {
    const specs = buildLayerSpecs(fakeManifest());

    expect(specs.ui.name).toBe("ui");
    expect(specs.ui.cheap).toBe(false);
    expect(typeof specs.ui.probe).toBe("function");
    expect(typeof specs.ui.run).toBe("function");
  });

  it("端口探不通时记 SKIP，且它的 run 根本不被调用", () => {
    const specs = buildLayerSpecs(fakeManifest());
    let ran = false;
    const gated = {
      ...specs.ui,
      probe: () => ["缺微信开发者工具自动化端口"],
      run: () => {
        ran = true;
        return { status: "FAIL", checks: null, unit: "断言", detail: "不该跑到这里", failures: [] };
      },
    };

    const result = executeLayers([gated]);

    expect(ran).toBe(false);
    expect(result.layers[0].status).toBe("SKIP");
    expect(result.layers[0].skipReason).toBe("缺微信开发者工具自动化端口");
    /* SKIP 不影响退出码语义：全 SKIP 的一轮结论仍是 PASS。 */
    expect(result.conclusion).toBe("PASS");
  });

  it("脚本的 --probe 真的握手，而不是只测 TCP", async () => {
    /* 端口开着但窗口没开自动化模式时，TCP 连得上、WebSocket 握手却失败。
       只测 TCP 会让 probe 说「可连」、run 立刻 SKIP——同一份环境两个结论。
       这条锁住 probe 走的是握手路径：输出要么是可连，要么带缺端口原因，
       不会出现「探通但真连失败」那种沉默的第三种状态。 */
    const script = readFileSync(resolve(__dirname, "../../scripts/verify-v5.mjs"), "utf8");

    expect(script).toContain("await probeAutomator.connect");
    const probeBlock = script.slice(script.indexOf('includes("--probe")'));
    expect(probeBlock.slice(0, 1200)).toContain("connect");
  });
});

/* ------------------------------------------------------------------ */
/* 与上次运行的差异（#109）                                            */
/* ------------------------------------------------------------------ */

/**
 * 差异节只做一件事：用例数变化。逐用例比对不在范围内——用例名会改，
 * 逐条比对全是噪音，而「某个文件的用例数掉了 12 条」是能直接触发警觉的信号。
 *
 * 这里的样本直接写成 report.json 的形状（顶层 files + layers），
 * 因为差异节的输入就是上一次落盘的那份 JSON，不是内存里的层结果。
 */
const mkRun = ({
  runId = "2026-11-04T10-00-00-000",
  startedAt = "2026-11-04T10:00:00.000Z",
  files = [] as Array<{ path: string; layer: string; covers?: string; checks: number | null; fromOutput?: boolean }>,
  layers = [] as Array<Record<string, unknown>>,
} = {}) => ({
  runId,
  startedAt,
  head: { commit: "abc1234", branch: "ticket/109", dirty: false, host: "h", platform: "win32", cpus: 8, layers: [] },
  layers,
  files: files.map((f) => ({ covers: "说明", ticket: null, fromOutput: f.checks !== null, ...f })),
  conclusion: "PASS",
});

const file = (path: string, layer: string, checks: number | null) => ({ path, layer, checks });

const okLayer = (name: string, checks: number, extra: Record<string, unknown> = {}) => ({
  name,
  label: `${name} 层`,
  status: "PASS",
  checks,
  unit: "用例",
  detail: "",
  failures: [] as Array<Record<string, unknown>>,
  skipReason: null,
  skipped: [] as string[],
  extra,
});

const skipLayer = (name: string, reason: string) => ({
  ...okLayer(name, null as unknown as number),
  status: "SKIP",
  checks: null,
  skipReason: reason,
});

describe("diffRuns 用例数变化", () => {
  it("两次用例数相同 → 判为无变化", () => {
    const current = mkRun({
      files: [file("miniprogram/tests/a.test.ts", "mp", 10)],
      layers: [okLayer("mp", 10)],
    });
    const previous = mkRun({
      runId: "2026-11-03T10-00-00-000",
      files: [file("miniprogram/tests/a.test.ts", "mp", 10)],
      layers: [okLayer("mp", 10)],
    });

    const diff = diffRuns(current, previous);

    expect(diff.unchanged).toBe(true);
    expect(diff.files.changed).toEqual([]);
    expect(renderReport({ ...current, previous: diff })).toContain("无变化");
  });

  it("某文件用例数减少时列出上次值、本次值与负差值", () => {
    const current = mkRun({
      files: [file("miniprogram/tests/a.test.ts", "mp", 12)],
      layers: [okLayer("mp", 12)],
    });
    const previous = mkRun({
      files: [file("miniprogram/tests/a.test.ts", "mp", 24)],
      layers: [okLayer("mp", 24)],
    });

    const diff = diffRuns(current, previous);
    const changed = diff.files.changed.find((f: { path: string }) => f.path.endsWith("a.test.ts"));

    expect(changed).toMatchObject({ previous: 24, current: 12, delta: -12 });
    expect(diff.unchanged).toBe(false);

    const md = renderReport({ ...current, previous: diff });
    expect(md).toContain("miniprogram/tests/a.test.ts");
    expect(md).toContain("| 24 | 12 | -12 |");
  });

  it("新增文件与消失文件都标出来，不混进「变化」表", () => {
    const current = mkRun({
      files: [file("miniprogram/tests/a.test.ts", "mp", 5), file("miniprogram/tests/新增.test.ts", "mp", 3)],
      layers: [okLayer("mp", 8)],
    });
    const previous = mkRun({
      files: [file("miniprogram/tests/a.test.ts", "mp", 5), file("miniprogram/tests/消失.test.ts", "mp", 7)],
      layers: [okLayer("mp", 12)],
    });

    const diff = diffRuns(current, previous);

    expect(diff.files.added.map((f: { path: string }) => f.path)).toEqual(["miniprogram/tests/新增.test.ts"]);
    expect(diff.files.removed.map((f: { path: string }) => f.path)).toEqual(["miniprogram/tests/消失.test.ts"]);
    expect(diff.files.changed).toEqual([]);

    const md = renderReport({ ...current, previous: diff });
    expect(md).toContain("新增文件");
    expect(md).toContain("miniprogram/tests/新增.test.ts");
    expect(md).toContain("消失文件");
    expect(md).toContain("miniprogram/tests/消失.test.ts");
  });

  it("新出现的 FAIL 与 SKIP 分开列出，上次就有的失败不再重复", () => {
    const shared = { name: "旧失败", detail: "上次也红", location: "a.ts:1" };
    const fresh = { name: "新失败", detail: "这次才红", location: "b.ts:2" };
    const current = mkRun({
      layers: [
        { ...okLayer("mp", 3), status: "FAIL", failures: [shared, fresh] },
        skipLayer("ui", "缺微信开发者工具自动化端口"),
      ],
    });
    const previous = mkRun({
      layers: [
        { ...okLayer("mp", 3), status: "FAIL", failures: [shared] },
        okLayer("ui", 49),
      ],
    });

    const diff = diffRuns(current, previous);

    expect(diff.newFailures.map((f: { name: string }) => f.name)).toEqual(["新失败"]);
    expect(diff.newSkips.map((s: { reason: string }) => s.reason)).toEqual(["缺微信开发者工具自动化端口"]);

    const md = renderReport({ ...current, previous: diff });
    expect(md).toContain("新出现的失败");
    expect(md).toContain("新失败");
    expect(md).toContain("新出现的跳过");
    expect(md).toContain("缺微信开发者工具自动化端口");
  });

  it("两次都没跑成同一层时不算「新出现的 SKIP」", () => {
    const current = mkRun({ layers: [skipLayer("ui", "缺端口")] });
    const previous = mkRun({ layers: [skipLayer("ui", "缺端口")] });

    expect(diffRuns(current, previous).newSkips).toEqual([]);
  });

  it("上次根本没触发这一层时不算「新出现的 SKIP」", () => {
    /* 日常只跑便宜三层、这次加了 --release 才会出现这种形状。
       ui 本来就一直在未验证清单里，报到差异节只会稀释真信号。 */
    const current = mkRun({ layers: [okLayer("mp", 5), skipLayer("ui", "缺端口")] });
    const previous = mkRun({ layers: [okLayer("mp", 5)] });

    expect(diffRuns(current, previous).newSkips).toEqual([]);
  });

  it("层状态从 PASS 掉到 SKIP 时层变化表里有它", () => {
    const current = mkRun({ layers: [skipLayer("ui", "缺端口")] });
    const previous = mkRun({ layers: [okLayer("ui", 49)] });

    const changed = diffRuns(current, previous).layers;

    expect(changed).toHaveLength(1);
    expect(changed[0]).toMatchObject({ name: "ui", previousStatus: "PASS", currentStatus: "SKIP" });
    expect(renderReport({ ...current, previous: diffRuns(current, previous) })).toContain("层变化");
  });

  it("任一文件拿不到逐文件数字时不拿 null 当 0 算差值", () => {
    const current = mkRun({ files: [file("ble/a.test.ts", "ble", null)], layers: [okLayer("ble", null as unknown as number)] });
    const previous = mkRun({ files: [file("ble/a.test.ts", "ble", null)], layers: [okLayer("ble", null as unknown as number)] });

    const diff = diffRuns(current, previous);

    expect(diff.files.changed).toEqual([]);
    expect(diff.comparable).toBe(0);
  });
});

describe("「上一次」报告的定位", () => {
  const seed = (base: string, runIds: string[], { bad = "" } = {}) => {
    for (const id of runIds) {
      const target = join(base, id);
      mkdirSync(target, { recursive: true });
      writeFileSync(join(target, "report.json"), bad || JSON.stringify(mkRun({ runId: id })), "utf8");
    }
  };

  it("取比当前 RUN_ID 小的最新一目录，忽略更新的目录", () => {
    const base = join(dir, ".reports");
    seed(base, ["2026-11-03T09-00-00-000", "2026-11-04T09-00-00-000", "2026-11-05T09-00-00-000"]);

    expect(findPreviousReportDir(base, "2026-11-04T12-00-00-000")).toBe("2026-11-04T09-00-00-000");
  });

  it("没有更早的目录时返回 null（首次运行）", () => {
    const base = join(dir, ".reports");
    seed(base, ["2026-11-05T09-00-00-000"]);

    expect(findPreviousReportDir(base, "2026-11-04T12-00-00-000")).toBeNull();
  });

  it("目录里没有 report.json 时跳过它，不把它当基线", () => {
    const base = join(dir, ".reports");
    seed(base, ["2026-11-03T09-00-00-000"]);
    mkdirSync(join(base, "2026-11-04T09-00-00-000"), { recursive: true });

    expect(findPreviousReportDir(base, "2026-11-04T12-00-00-000")).toBe("2026-11-03T09-00-00-000");
  });

  it("坏 JSON 与 schema 不兼容都返回原因，不抛错", () => {
    const broken = join(dir, "broken");
    mkdirSync(broken, { recursive: true });
    writeFileSync(join(broken, "report.json"), "{ 不是 JSON", "utf8");

    const badJson = readPreviousReport(broken);
    expect(String(badJson.error)).toContain("JSON");
    expect(() => readPreviousReport(broken)).not.toThrow();

    const wrongShape = join(dir, "wrong-shape");
    mkdirSync(wrongShape, { recursive: true });
    writeFileSync(join(wrongShape, "report.json"), JSON.stringify({ layers: "不是数组" }), "utf8");

    const badSchema = readPreviousReport(wrongShape);
    expect(String(badSchema.error)).toContain("layers");
    expect(() => renderReport({ ...mkRun(), previous: badSchema })).not.toThrow();
  });

  it("读得到时返回上一次的报告对象", () => {
    const target = join(dir, "ok");
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, "report.json"), JSON.stringify(mkRun({ runId: "r1" })), "utf8");

    expect(readPreviousReport(target).report.runId).toBe("r1");
  });
});
