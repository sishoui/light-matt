/**
 * 页面里的隐藏日志面板控制器：模型 + 合并刷新计时器。
 *
 * 拆分前这些字段散在 Page 实例上（logPanel / logFlushTimer）。放成独立类后
 * index.ts 只转发 tap 事件并把 refreshLink 的补丁 setData 出去。
 *
 * 合并规则不变：20Hz 的帧不能每帧 setData；暂停 / 隐藏时完全不动视图。
 */

import { LogPanelModel, type LogPanelRow } from "../../utils/ble/log-panel";
import type { FrameLog } from "../../utils/ble/log";
import { errorText } from "../../utils/ble/errors";

/** 日志面板的刷新合并间隔：帧可能以 20Hz 到达，不能每帧都 setData。 */
export const LOG_PANEL_REFRESH_MS = 200;

export interface LogHost {
  setData(patch: Record<string, unknown>): void;
}

/** 一次刷新的补丁（与拆分前 refreshLogPanel 的 setData 参数逐字一致）。 */
export interface LogViewPatch {
  logRows: LogPanelRow[];
  logCount: number;
  logPaused: boolean;
  logScrollTarget: string;
}

export class LogPanelView {
  private readonly panel: LogPanelModel;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private visible = false;
  private paused = false;
  private readonly host: LogHost;

  constructor(log: FrameLog, host: LogHost) {
    this.panel = new LogPanelModel(log);
    this.host = host;
  }

  /** 新帧到达：只在面板可见且未暂停时合并刷新（暂停时冻结视图）。 */
  onAppend(): void {
    this.scheduleRefresh();
  }

  /** 版本号点击：窗口内第 5 次切换面板可见性（spec §10）。 */
  onVersionTap(now: number): void {
    if (!this.panel.tapVersion(now)) {
      return;
    }
    this.visible = this.panel.visible;
    this.host.setData({ logVisible: this.visible, logHint: "" });
    if (this.visible) {
      this.refresh();
    }
  }

  /** 把面板模型当前视图同步到 data（行 + 计数 + 暂停态）。 */
  refresh(): void {
    const entries = this.panel.entries();
    const rows = this.panel.rows();
    const last = rows.length > 0 ? rows[rows.length - 1] : null;
    this.paused = this.panel.paused;
    this.host.setData({
      logRows: rows,
      logCount: entries.length,
      logPaused: this.panel.paused,
      // 跟随最新一帧；暂停时不动视图，恢复后再跳到末尾。
      logScrollTarget: !this.panel.paused && last !== null ? `log-row-${last.id}` : "",
    });
  }

  /** 合并刷新：20Hz 的帧不能每帧 setData；暂停/隐藏时完全不动视图。 */
  scheduleRefresh(): void {
    if (!this.visible || this.paused) {
      return;
    }
    if (this.flushTimer !== null) {
      return;
    }
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.refresh();
    }, LOG_PANEL_REFRESH_MS);
  }

  /** 暂停 = 冻结视图但继续记录（理由见 log-panel.ts）。 */
  onPauseTap(): void {
    const paused = this.panel.togglePause();
    this.paused = paused;
    this.host.setData({
      logPaused: paused,
      logHint: paused ? "已暂停视图（新帧仍在记录）" : "",
    });
    this.refresh();
  }

  onClearTap(): void {
    this.panel.clear();
    this.host.setData({ logHint: "" });
    this.refresh();
  }

  /** 复制当前视图：暂停时复制冻结的那一段，否则复制整个环形缓冲。 */
  onCopyTap(): void {
    const text = this.panel.copyText();
    if (text.length === 0) {
      this.host.setData({ logHint: "没有可复制的帧" });
      return;
    }
    const count = this.panel.entries().length;
    wx.setClipboardData({
      data: text,
      success: () => this.host.setData({ logHint: `已复制 ${count} 帧` }),
      fail: (err) => this.host.setData({ logHint: `复制失败：${errorText(err)}` }),
    });
  }

  onCloseTap(): void {
    this.panel.setVisible(false);
    this.visible = false;
    this.host.setData({ logVisible: false });
  }

  /** 页面卸载：停掉合并计时器。 */
  destroy(): void {
    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
  }
}
