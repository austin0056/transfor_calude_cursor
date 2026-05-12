import type { KeyUsageSummary, DailyUsageRow } from "../keys.js";
import { config } from "../config.js";

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function fmtNum(n: number | null | undefined): string {
  if (n == null) return "0";
  return n.toLocaleString("en-US");
}

function fmtDate(d: Date | string | null | undefined): string {
  if (!d) return "—";
  const date = typeof d === "string" ? new Date(d) : d;
  if (Number.isNaN(date.getTime())) return "—";
  return date.toISOString().replace("T", " ").slice(0, 19);
}

const baseStyles = `
  :root {
    --bg: #0f1115; --panel: #171a21; --border: #262a33;
    --text: #e7e9ee; --muted: #8a93a4; --accent: #7c9cff;
    --good: #6cd48c; --bad: #ff6b6b;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: var(--bg); color: var(--text);
    font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  }
  a { color: var(--accent); text-decoration: none; }
  a:hover { text-decoration: underline; }
  .wrap { max-width: 1100px; margin: 0 auto; padding: 32px 24px; }
  .header {
    display: flex; align-items: baseline; justify-content: space-between;
    margin-bottom: 24px;
  }
  .header h1 { margin: 0; font-size: 20px; font-weight: 600; }
  .header .muted { color: var(--muted); font-size: 12px; }
  .card {
    background: var(--panel); border: 1px solid var(--border);
    border-radius: 8px; padding: 20px; margin-bottom: 20px;
  }
  .card h2 { margin: 0 0 14px; font-size: 15px; font-weight: 600; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th, td {
    text-align: left; padding: 10px 8px;
    border-bottom: 1px solid var(--border); vertical-align: middle;
  }
  th { color: var(--muted); font-weight: 500; font-size: 12px; }
  tr:last-child td { border-bottom: none; }
  .key-cell { font-family: ui-monospace, Menlo, monospace; font-size: 12px; }
  .badge {
    display: inline-block; padding: 2px 8px; border-radius: 4px;
    font-size: 11px; font-weight: 500;
  }
  .badge-ok { background: rgba(108, 212, 140, 0.15); color: var(--good); }
  .badge-off { background: rgba(255, 107, 107, 0.15); color: var(--bad); }
  form.inline { display: inline; }
  input[type=text], input[type=password] {
    background: #0b0d12; border: 1px solid var(--border);
    border-radius: 6px; color: var(--text); padding: 8px 10px;
    font-size: 13px; min-width: 220px;
  }
  input[type=text]:focus, input[type=password]:focus {
    outline: none; border-color: var(--accent);
  }
  button {
    background: var(--accent); color: #0b0d12; border: none;
    border-radius: 6px; padding: 8px 14px; font-size: 13px;
    font-weight: 600; cursor: pointer;
  }
  button.secondary {
    background: transparent; color: var(--text);
    border: 1px solid var(--border);
  }
  button.danger { background: var(--bad); color: #fff; }
  button:hover { opacity: 0.9; }
  .row-actions button { padding: 4px 10px; font-size: 12px; margin-right: 4px; }
  .flash {
    background: rgba(124, 156, 255, 0.12); border: 1px solid var(--accent);
    color: var(--text); border-radius: 6px; padding: 10px 14px;
    margin-bottom: 16px; font-size: 13px;
    word-break: break-all;
  }
  .flash code {
    font-family: ui-monospace, Menlo, monospace;
    background: #0b0d12; padding: 2px 6px; border-radius: 4px;
  }
  .login-wrap {
    min-height: 100vh; display: flex; align-items: center; justify-content: center;
  }
  .login-card {
    background: var(--panel); border: 1px solid var(--border);
    border-radius: 8px; padding: 28px 32px; width: 320px;
  }
  .login-card h1 { margin: 0 0 4px; font-size: 18px; }
  .login-card p { margin: 0 0 18px; color: var(--muted); font-size: 12px; }
  .login-card label { display: block; font-size: 12px; color: var(--muted); margin-bottom: 6px; }
  .login-card input { width: 100%; margin-bottom: 14px; }
  .login-card button { width: 100%; }
  .err { color: var(--bad); font-size: 12px; margin-bottom: 12px; }
  .stat-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; }
  .stat {
    background: #0b0d12; border: 1px solid var(--border);
    border-radius: 6px; padding: 12px 14px;
  }
  .stat .label { color: var(--muted); font-size: 11px; }
  .stat .value { font-size: 20px; font-weight: 600; margin-top: 4px; }
`;

export function loginPage(opts: { error?: string } = {}): string {
  return `<!doctype html>
<html><head>
<meta charset="utf-8">
<title>Admin Login</title>
<style>${baseStyles}</style>
</head><body>
<div class="login-wrap">
  <form class="login-card" method="post" action="/admin/login">
    <h1>Admin Login</h1>
    <p>Anthropic → OpenAI Bridge</p>
    ${opts.error ? `<div class="err">${escapeHtml(opts.error)}</div>` : ""}
    <label>Password</label>
    <input type="password" name="password" autofocus required>
    <button type="submit">Sign in</button>
  </form>
</div>
</body></html>`;
}

export interface DashboardData {
  summaries: KeyUsageSummary[];
  daily: DailyUsageRow[];
  newlyCreatedKey?: string;
  flash?: string;
}

export function dashboardPage(data: DashboardData): string {
  const totalIn = data.summaries.reduce((a, s) => a + Number(s.input_tokens), 0);
  const totalOut = data.summaries.reduce((a, s) => a + Number(s.output_tokens), 0);
  const totalReq = data.summaries.reduce((a, s) => a + Number(s.request_count), 0);
  const totalKeys = data.summaries.filter((s) => s.enabled).length;

  const keyRows = data.summaries
    .map((s) => {
      const enabled = s.enabled ?? false;
      const actions = s.api_key_id != null
        ? `
          <form class="inline" method="post" action="/admin/keys/${s.api_key_id}/toggle">
            <button type="submit" class="secondary">${enabled ? "Disable" : "Enable"}</button>
          </form>
          <form class="inline" method="post" action="/admin/keys/${s.api_key_id}/delete"
                onsubmit="return confirm('Delete this key? Usage logs will be kept but detached.');">
            <button type="submit" class="danger">Delete</button>
          </form>
        `
        : "";
      return `<tr>
        <td class="key-cell">${escapeHtml(s.key ?? "")}</td>
        <td>${escapeHtml(s.name ?? "")}</td>
        <td><span class="badge ${enabled ? "badge-ok" : "badge-off"}">${enabled ? "active" : "disabled"}</span></td>
        <td>${fmtNum(Number(s.request_count))}</td>
        <td>${fmtNum(Number(s.input_tokens))}</td>
        <td>${fmtNum(Number(s.output_tokens))}</td>
        <td>${fmtNum(Number(s.cache_read_input_tokens))}</td>
        <td>${fmtDate(s.last_request_at)}</td>
        <td class="row-actions">${actions}</td>
      </tr>`;
    })
    .join("\n");

  const dailyRows = data.daily
    .map(
      (d) => `<tr>
        <td>${escapeHtml(d.day)}</td>
        <td>${fmtNum(Number(d.request_count))}</td>
        <td>${fmtNum(Number(d.input_tokens))}</td>
        <td>${fmtNum(Number(d.output_tokens))}</td>
      </tr>`,
    )
    .join("\n");

  const flash = data.newlyCreatedKey
    ? `<div class="flash">
         New key created. Copy it now — it will not be shown again in full after refresh.<br>
         <code>${escapeHtml(data.newlyCreatedKey)}</code>
       </div>`
    : data.flash
      ? `<div class="flash">${escapeHtml(data.flash)}</div>`
      : "";

  return `<!doctype html>
<html><head>
<meta charset="utf-8">
<title>Bridge Admin</title>
<style>${baseStyles}</style>
</head><body>
<div class="wrap">
  <div class="header">
    <div>
      <h1>Anthropic → OpenAI Bridge</h1>
      <div class="muted">Upstream model: <code>${escapeHtml(config.upstream.model)}</code> → exposed as <code>${escapeHtml(config.exposedModel)}</code></div>
    </div>
    <form method="post" action="/admin/logout">
      <button type="submit" class="secondary">Logout</button>
    </form>
  </div>

  ${flash}

  <div class="card">
    <h2>Last 30 days</h2>
    <div class="stat-grid">
      <div class="stat"><div class="label">Active keys</div><div class="value">${fmtNum(totalKeys)}</div></div>
      <div class="stat"><div class="label">Requests</div><div class="value">${fmtNum(totalReq)}</div></div>
      <div class="stat"><div class="label">Input tokens</div><div class="value">${fmtNum(totalIn)}</div></div>
      <div class="stat"><div class="label">Output tokens</div><div class="value">${fmtNum(totalOut)}</div></div>
    </div>
  </div>

  <div class="card">
    <h2>Create new API key</h2>
    <form method="post" action="/admin/keys/create" style="display:flex; gap:10px;">
      <input type="text" name="name" placeholder="Name or description (optional)">
      <button type="submit">Create</button>
    </form>
  </div>

  <div class="card">
    <h2>API keys · usage (30d)</h2>
    <table>
      <thead><tr>
        <th>Key</th><th>Name</th><th>Status</th>
        <th>Req</th><th>Input</th><th>Output</th><th>Cache read</th>
        <th>Last used</th><th></th>
      </tr></thead>
      <tbody>${keyRows || `<tr><td colspan="9" style="color:var(--muted); text-align:center; padding:20px;">No keys yet. Create one above.</td></tr>`}</tbody>
    </table>
  </div>

  <div class="card">
    <h2>Daily totals (14d)</h2>
    <table>
      <thead><tr><th>Day</th><th>Requests</th><th>Input tokens</th><th>Output tokens</th></tr></thead>
      <tbody>${dailyRows || `<tr><td colspan="4" style="color:var(--muted); text-align:center; padding:20px;">No traffic yet.</td></tr>`}</tbody>
    </table>
  </div>
</div>
</body></html>`;
}
