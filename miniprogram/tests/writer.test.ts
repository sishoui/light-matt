/**
 * 写入串行化：假通道（spec 允许的唯一假件之一）。
 * 断言同一时刻最多一个 sendOne 在飞，且 FIFO 顺序不被打乱。
 */

import { describe, expect, it } from "vitest";

import { SerialWriter } from "../utils/ble/writer";

function deferred() {
  let resolve!: () => void;
  let reject!: (err: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("SerialWriter", () => {
  it("10 帧入队后最多一个在飞，顺序保持", async () => {
    const gates: Array<ReturnType<typeof deferred>> = [];
    const started: number[] = [];
    let inFlight = 0;
    let maxConcurrent = 0;

    const writer = new SerialWriter(async (bytes) => {
      inFlight += 1;
      maxConcurrent = Math.max(maxConcurrent, inFlight);
      started.push(bytes[0]);
      const gate = deferred();
      gates.push(gate);
      await gate.promise;
      inFlight -= 1;
    });

    const promises = Array.from({ length: 10 }, (_, i) =>
      writer.enqueue(new Uint8Array([i])),
    );

    // 让第一个 sendOne 启动
    await Promise.resolve();
    expect(started).toEqual([0]);

    for (let i = 0; i < 10; i += 1) {
      // 每次只放行当前在飞的那一帧
      expect(gates.length).toBe(i + 1);
      gates[i].resolve();
      await promises[i];
      await Promise.resolve();
    }

    await Promise.all(promises);
    expect(maxConcurrent).toBe(1);
    expect(started).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(writer.busy).toBe(false);
  });

  it("reset 后所有等待者 reject，后续入队立即失败", async () => {
    const gate = deferred();
    const writer = new SerialWriter(async () => {
      await gate.promise;
    });

    const first = writer.enqueue(new Uint8Array([0]));
    const second = writer.enqueue(new Uint8Array([1]));
    await Promise.resolve();

    const reason = new Error("连接已断开");
    writer.reset(reason);

    await expect(first).rejects.toBe(reason);
    await expect(second).rejects.toBe(reason);
    await expect(writer.enqueue(new Uint8Array([2]))).rejects.toBe(reason);

    gate.resolve();
  });

  it("单帧失败不影响队列继续（失败向下传递，后续帧照常发送）", async () => {
    const sent: number[] = [];
    let call = 0;
    const writer = new SerialWriter(async (bytes) => {
      call += 1;
      if (call === 1) {
        throw new Error("写失败");
      }
      sent.push(bytes[0]);
    });

    const first = writer.enqueue(new Uint8Array([0]));
    const second = writer.enqueue(new Uint8Array([1]));
    await expect(first).rejects.toThrow("写失败");
    await expect(second).resolves.toBeUndefined();
    expect(sent).toEqual([1]);
  });
});
