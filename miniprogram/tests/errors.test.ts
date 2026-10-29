/** 错误码分诊与文案。 */

import { describe, expect, it } from "vitest";

import { errorText, iosStateText, resultText, triage } from "../utils/ble/errors";
import { WxCallError, WxCallTimeoutError } from "../utils/ble/wx-promise";

function failWith(errCode: number): WxCallError {
  return new WxCallError("test", { errCode, errMsg: "mock" });
}

describe("triage", () => {
  it("10006 → reconnect（不重试写）", () => {
    expect(triage(failWith(10006))).toBe("reconnect");
  });
  it("10008 → retry-after-gap（怀疑 notify 后立即写）", () => {
    expect(triage(failWith(10008))).toBe("retry-after-gap");
  });
  it("10001 → wait-adapter（非致命）", () => {
    expect(triage(failWith(10001))).toBe("wait-adapter");
  });
  it("10000 / 10004 / 10005 → reinit", () => {
    expect(triage(failWith(10000))).toBe("reinit");
    expect(triage(failWith(10004))).toBe("reinit");
    expect(triage(failWith(10005))).toBe("reinit");
  });
  it("超时按断线处理，其它错误 fatal", () => {
    expect(triage(new WxCallTimeoutError("write", 2000))).toBe("reconnect");
    expect(triage(failWith(10013))).toBe("fatal");
  });
});

describe("errorText", () => {
  it("10001 显示「请打开蓝牙」", () => {
    expect(errorText(failWith(10001))).toBe("请打开蓝牙");
  });
  it("未知错误码保留原始信息", () => {
    expect(errorText(failWith(99999))).toContain("errCode=99999");
  });
});

describe("iosStateText", () => {
  it("state 0-4 都有文案", () => {
    for (let state = 0; state <= 4; state += 1) {
      expect(iosStateText(state).length).toBeGreaterThan(0);
    }
    expect(iosStateText(4)).toContain("请打开蓝牙");
    expect(iosStateText(3)).toContain("未授权");
  });
});

describe("resultText", () => {
  it("覆盖协议 §5 的全部结果码", () => {
    for (let code = 1; code <= 9; code += 1) {
      expect(resultText(code)).not.toContain("unknown");
    }
  });
});
