import type { DeviceRow, RegisteredDeviceRow, UserRow } from "./db.js";

/** 只读视图。整页没有任何 <form> / 写按钮 / 可编辑控件。 */

function esc(value: unknown): string {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function fmtTime(ms: number | null): string {
  if (ms === null || ms === undefined) return "—";
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return "—";
  const pad = (n: number): string => String(n).padStart(2, "0");
  return (
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
    `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`
  );
}

function layout(title: string, body: string): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · lumen</title>
<style>
  :root { color-scheme: light; }
  body { font: 14px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; margin: 0; padding: 24px; color: #1b1b1b; background: #fafafa; }
  h1 { font-size: 18px; margin: 0 0 4px; }
  .sub { color: #6b6b6b; margin: 0 0 20px; }
  table { border-collapse: collapse; width: 100%; background: #fff; box-shadow: 0 0 0 1px #e3e3e3; }
  th, td { text-align: left; padding: 8px 12px; border-bottom: 1px solid #eee; white-space: nowrap; }
  th { background: #f4f4f4; font-weight: 600; }
  tr:last-child td { border-bottom: 0; }
  .num { text-align: right; font-variant-numeric: tabular-nums; }
  .empty { color: #6b6b6b; padding: 16px; }
  .hint { color: #6b6b6b; font-size: 12px; margin-top: 16px; }
  code { background: #efefef; padding: 1px 4px; border-radius: 3px; }
</style>
</head>
<body>
${body}
<p class="hint">只读看板：没有编辑、删除或任何写操作入口。</p>
</body>
</html>
`;
}

export function devicesPage(rows: readonly DeviceRow[]): string {
  const body =
    rows.length === 0
      ? `<p class="empty">还没有使用记录。</p>`
      : `<table>
<thead><tr>
  <th>设备</th><th>聚合键</th>
  <th class="num">使用次数</th><th class="num">用户数</th>
  <th>最后出现</th><th class="num">可见 MAC 数</th>
</tr></thead>
<tbody>
${rows
  .map(
    (r) => `<tr>
  <td>${esc(r.device_name ?? "（无广播名）")}</td>
  <td><code>${esc(r.device_key)}</code></td>
  <td class="num">${esc(r.use_count)}</td>
  <td class="num">${esc(r.user_count)}</td>
  <td>${esc(fmtTime(r.last_seen_at))}</td>
  <td class="num">${esc(r.mac_count)}</td>
</tr>`,
  )
  .join("\n")}
</tbody>
</table>
<p class="hint">聚合口径见 <code>server/README.md</code>：同一台设备按广播名归一，
MAC 数 &gt; 1 表示广播名撞车。使用次数 = 连接会话数，不是心跳数。</p>`;

  return layout(
    "设备",
    `<h1>设备</h1>
<p class="sub">按最后出现时间倒序 · 共 ${rows.length} 台</p>
${body}
<p class="hint"><a href="/admin/users">→ 用户列表</a> · <a href="/admin/registry">→ 设备登记表</a></p>`,
  );
}

/**
 * 设备登记表（v3）：`devices` + `user_devices` 的实体列表，与上面的日志聚合视图
 * 不是一回事 —— 前者是「登记过的设备实体」，后者是「日志按 device_key 聚合」。
 *
 * led_counts / firmware_ver 必须明确标注为非权威缓存：它们只在设备离线时
 * 提供一点信息，真实配置永远以设备 NVS 为准。
 */
export function registeredDevicesPage(rows: readonly RegisteredDeviceRow[]): string {
  const body =
    rows.length === 0
      ? `<p class="empty">还没有登记过的设备。</p>`
      : `<table>
<thead><tr>
  <th>硬件 ID</th><th>备注名（全局默认）</th>
  <th>最后在线</th><th>登记时间</th>
  <th class="num">登记用户数</th>
  <th>灯珠数 / 固件版本（缓存，非权威）</th>
</tr></thead>
<tbody>
${rows
  .map(
    (r) => `<tr>
  <td><code>${esc(r.hardware_id)}</code></td>
  <td>${esc(r.display_name ?? "（未命名）")}</td>
  <td>${esc(fmtTime(r.last_seen_at))}</td>
  <td>${esc(fmtTime(r.created_at))}</td>
  <td class="num">${esc(r.user_count)}</td>
  <td><code>${esc(r.led_counts ?? "—")}</code> / ${esc(r.firmware_ver ?? "—")}</td>
</tr>`,
  )
  .join("\n")}
</tbody>
</table>
<p class="hint">这是「谁登记过」的展示，<strong>不是</strong>访问控制：任何人扫到设备都能连。
灯珠数与固件版本只是离线时的提示，配置真相在设备 NVS 里。</p>`;

  return layout(
    "设备登记表",
    `<h1>设备登记表</h1>
<p class="sub">按最后在线时间倒序 · 共 ${rows.length} 台</p>
${body}
<p class="hint"><a href="/admin/devices">→ 日志聚合设备</a> · <a href="/admin/users">→ 用户列表</a></p>`,
  );
}

export function usersPage(rows: readonly UserRow[]): string {
  const body =
    rows.length === 0
      ? `<p class="empty">还没有用户。</p>`
      : `<table>
<thead><tr>
  <th>用户</th><th>标识</th>
  <th class="num">使用次数</th><th class="num">设备数</th>
  <th>首次出现</th><th>最后出现</th>
</tr></thead>
<tbody>
${rows
  .map(
    (r) => `<tr>
  <td>${esc(r.display_name ?? "（未命名）")}</td>
  <td><code>${esc(r.user_key)}</code></td>
  <td class="num">${esc(r.use_count)}</td>
  <td class="num">${esc(r.device_count)}</td>
  <td>${esc(fmtTime(r.first_seen_at))}</td>
  <td>${esc(fmtTime(r.last_seen_at))}</td>
</tr>`,
  )
  .join("\n")}
</tbody>
</table>`;

  return layout(
    "用户",
    `<h1>用户</h1>
<p class="sub">按最后出现时间倒序 · 共 ${rows.length} 人</p>
${body}
<p class="hint"><a href="/admin/devices">→ 设备列表</a></p>`,
  );
}

export function unauthorizedPage(): string {
  return layout(
    "需要登录",
    `<h1>需要登录</h1>
<p class="sub">看板不可匿名访问。</p>
<p>请用 HTTP Basic 凭据访问，例如：<code>curl -u admin:&lt;password&gt; /admin/devices</code>。</p>`,
  );
}
