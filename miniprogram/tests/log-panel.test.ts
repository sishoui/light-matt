/** 隐藏日志面板：连点判定、暂停/清空/复制、200 帧上限、console 同源。 */

import { describe, expect, it, vi } from "vitest";

import {
  LOG_PANEL_TAP_COUNT,
  LogPanelModel,
  TapSequence,
  formatFrameTime,
  formatLogLine,
} from "../utils/ble/log-panel";
import { FrameLog } from "../utils/ble/log";

function entry(i: number, overrides: Partial<Parameters<FrameLog["push"]>[0]> = {}) {
  return {
    ts: new Date(2026, 0, 2, 3, 4, 5, 678).getTime() + i,
    dir: "tx" as const,
    hex: `A5 02 01 ${i.toString(16).padStart(2, "0").toUpperCase()}`,
    command: 0x01,
    seq: i,
    parsed: `SetPower power=1`,
    ...overrides,
  };
}

describe("TapSequence（连点 5 次）", () => {
  it("窗口内第 5 次触发，且触发后重新计数", () => {
    const taps = new TapSequence();
    for (let i = 0; i < LOG_PANEL_TAP_COUNT - 1; i += 1) {
      expect(taps.tap(1000 + i * 100)).toBe(false);
    }
    expect(taps.count).toBe(4);
    expect(taps.tap(1400)).toBe(true);
    expect(taps.count).toBe(0);
    expect(taps.tap(1500)).toBe(false);
  });

  it("点击间隔超过窗口时重新累计", () => {
    const taps = new TapSequence(5, 2000);
    for (let i = 0; i < 4; i += 1) {
      expect(taps.tap(i * 100)).toBe(false);
    }
    // 第 5 次与第 1 次相隔 2100ms：第 1 次过期，只剩 4 次，不触发。
    expect(taps.tap(2100)).toBe(false);
    expect(taps.count).toBe(4);
  });

  it("时间回退不产生负数保留（防御性）", () => {
    const taps = new TapSequence();
    expect(taps.tap(5000)).toBe(false);
    expect(taps.tap(4000)).toBe(false);
    expect(taps.count).toBe(1);
  });
});

describe("LogPanelModel", () => {
  it("连点版本号 5 次才开启/关闭", () => {
    const panel = new LogPanelModel(new FrameLog());
    for (let i = 0; i < 4; i += 1) {
      expect(panel.tapVersion(1000 + i * 50)).toBe(false);
    }
    expect(panel.visible).toBe(false);
    expect(panel.tapVersion(1200)).toBe(true);
    expect(panel.visible).toBe(true);
    // 再连点 5 次关闭。
    for (let i = 0; i < 4; i += 1) {
      expect(panel.tapVersion(2000 + i * 50)).toBe(false);
    }
    expect(panel.tapVersion(2200)).toBe(true);
    expect(panel.visible).toBe(false);
  });

  it("200 帧上限：溢出后只保留最近 200，面板视图同步", () => {
    const log = new FrameLog({ capacity: 200 });
    const panel = new LogPanelModel(log);
    for (let i = 0; i < 250; i += 1) {
      log.push(entry(i));
    }
    const rows = panel.rows();
    expect(rows.length).toBe(200);
    expect(rows[0].id).toBe(51);
    expect(rows[199].id).toBe(250);
  });

  it("每一行包含时间戳 / 方向 / hex / 命令名与参数", () => {
    const log = new FrameLog();
    const panel = new LogPanelModel(log);
    log.push(entry(7));
    log.push(entry(8, { dir: "rx", command: 0x80, parsed: "ACK SetPower cmd=0x01 result=0x00 OK" }));

    const [txRow, rxRow] = panel.rows();
    expect(txRow.time).toBe("03:04:05.685");
    expect(txRow.dir).toBe("tx");
    expect(txRow.arrow).toBe("->");
    expect(txRow.hex).toBe("A5 02 01 07");
    expect(txRow.name).toBe("SetPower");
    expect(txRow.seq).toBe("7 (0x07)");
    expect(txRow.parsed).toBe("SetPower power=1");
    expect(rxRow.dir).toBe("rx");
    expect(rxRow.arrow).toBe("<-");
    expect(rxRow.name).toBe("ACK");
  });

  it("暂停 = 冻结视图但继续记录；恢复后立刻看到新帧", () => {
    const log = new FrameLog();
    const panel = new LogPanelModel(log);
    log.push(entry(1));
    log.push(entry(2));

    expect(panel.togglePause()).toBe(true);
    expect(panel.paused).toBe(true);
    expect(panel.entries().length).toBe(2);

    // 暂停期间新帧仍进入环形缓冲（不丢数据），视图不动。
    log.push(entry(3));
    log.push(entry(4));
    expect(panel.entries().length).toBe(2);
    expect(log.snapshot().length).toBe(4);

    expect(panel.togglePause()).toBe(false);
    expect(panel.entries().length).toBe(4);
  });

  it("清空：缓冲与冻结快照一起清；暂停时清空后继续冻结", () => {
    const log = new FrameLog();
    const panel = new LogPanelModel(log);
    log.push(entry(1));
    panel.pause();
    panel.clear();
    expect(log.snapshot()).toEqual([]);
    expect(panel.entries()).toEqual([]);
    expect(panel.paused).toBe(true);

    log.push(entry(2));
    expect(panel.entries()).toEqual([]); // 仍冻结在空视图
    panel.resume();
    expect(panel.entries().length).toBe(1);
  });

  it("复制：暂停时复制冻结段，否则复制整个缓冲，格式一行一帧", () => {
    const log = new FrameLog();
    const panel = new LogPanelModel(log);
    log.push(entry(1, { seq: 1 }));
    log.push(entry(2, { seq: 2 }));
    panel.pause();
    log.push(entry(3, { seq: 3 }));

    const pausedText = panel.copyText();
    expect(pausedText.split("\n").length).toBe(2);
    expect(pausedText).toContain("seq=1 (0x01)");
    expect(pausedText).not.toContain("seq=3 (0x03)");
    expect(pausedText).not.toContain("A5 02 01 03");

    panel.resume();
    const fullText = panel.copyText();
    expect(fullText.split("\n").length).toBe(3);
    expect(fullText).toContain("seq=3 (0x03)");
    expect(fullText.endsWith("\n")).toBe(false);
  });

  it("formatLogLine 与复制文本同格式", () => {
    const log = new FrameLog();
    const e = log.push(entry(9));
    expect(formatLogLine(e)).toBe(
      "03:04:05.687 -> A5 02 01 09 | SetPower seq=9 (0x09) | SetPower power=1",
    );  });

  it("formatFrameTime 补零到毫秒", () => {
    expect(formatFrameTime(new Date(2026, 0, 2, 3, 4, 5, 7).getTime())).toBe("03:04:05.007");
    expect(formatFrameTime(new Date(2026, 0, 2, 23, 59, 59, 999).getTime())).toBe(
      "23:59:59.999",
    );
  });
});

describe("console 与面板同源", () => {
  it("FrameLog 的 console 镜像与面板读取的是同一条 FrameLogEntry", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      const log = new FrameLog({ mirrorToConsole: true });
      const panel = new LogPanelModel(log);
      const pushed = log.push(entry(5));

      // console 每帧一条，且包含与该帧相同的 hex / 命令名 / seq。
      expect(spy).toHaveBeenCalledTimes(1);
      const mirrored = String(spy.mock.calls[0][0]);
      expect(mirrored).toContain(pushed.hex);
      expect(mirrored).toContain("seq=5 (0x05)");
      expect(mirrored).toContain("SetPower");

      // 面板没有自己的副本：读到的就是同一条记录（同 id、同字段）。
      const row = panel.rows()[0];
      expect(row.id).toBe(pushed.id);
      expect(row.hex).toBe(pushed.hex);
      expect(row.seq).toBe("5 (0x05)");
      expect(row.parsed).toBe(pushed.parsed);
    } finally {
      spy.mockRestore();
    }
  });

  it("开发版关闭时不打 console，但面板照常可用", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      const log = new FrameLog({ mirrorToConsole: false });
      const panel = new LogPanelModel(log);
      log.push(entry(1));
      expect(spy).not.toHaveBeenCalled();
      expect(panel.rows().length).toBe(1);
    } finally {
      spy.mockRestore();
    }
  });
});
