import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
// @ts-expect-error -- 仓库根的工具脚本是 .mjs，没有类型声明
import {
  buildLayerSpecs,
  combineNodeLayerResults,
  describeFiles,
  executeLayers,
  parseFirmwareOutput,
  parseTscOutput,
  parseVitestJson,
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


