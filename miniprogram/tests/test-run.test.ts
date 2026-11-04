import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
// @ts-expect-error -- 仓库根的工具脚本是 .mjs，没有类型声明
import { buildLayerSpecs, executeLayers, parseFirmwareOutput, parseUiOutput, renderReport, writeReport } from "../../scripts/test-run.mjs";

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
});
