/** 200 帧环形缓冲。 */

import { describe, expect, it } from "vitest";

import { FrameLog } from "../utils/ble/log";

describe("FrameLog", () => {
  it("超过 capacity 后只保留最近 200 条，id 单调", () => {
    const log = new FrameLog({ capacity: 200 });
    for (let i = 0; i < 250; i += 1) {
      log.push({ ts: i, dir: "tx", hex: "A5", parsed: `#${i}` });
    }
    const snapshot = log.snapshot();
    expect(snapshot.length).toBe(200);
    expect(snapshot[0].id).toBe(51);
    expect(snapshot[199].id).toBe(250);
    expect(snapshot[199].parsed).toBe("#249");
  });

  it("onAppend 每条都收到，反注册后停止", () => {
    const log = new FrameLog();
    const seen: number[] = [];
    const off = log.onAppend((entry) => seen.push(entry.id));
    log.push({ ts: 1, dir: "tx", hex: "A5", parsed: "a" });
    log.push({ ts: 2, dir: "rx", hex: "A5", parsed: "b" });
    off();
    log.push({ ts: 3, dir: "tx", hex: "A5", parsed: "c" });
    expect(seen).toEqual([1, 2]);
  });

  it("clear 后 snapshot 为空", () => {
    const log = new FrameLog();
    log.push({ ts: 1, dir: "tx", hex: "A5", parsed: "a" });
    log.clear();
    expect(log.snapshot()).toEqual([]);
  });
});
