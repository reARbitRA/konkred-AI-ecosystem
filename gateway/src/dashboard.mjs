/**
 * Minimal zero-dependency HTML status dashboard (served at `/`).
 * Renders pool saturation, cache stats and recent caller activity.
 */
import { escapeHtml } from './util.mjs';
import { gatewayStats } from './gateway/gateway.mjs';
import { watchdogStatus } from './watchdog.mjs';
import { config } from './config.mjs';

const bar = (available, total) => {
  const pct = total > 0 ? Math.round((available / total) * 100) : 0;
  const colour = pct === 0 ? '#e5484d' : pct < 40 ? '#f5a623' : '#30a46c';
  return `<div class="bar"><span style="width:${pct}%;background:${colour}"></span></div><small>${available}/${total} keys · ${pct}%</small>`;
};

export const renderDashboard = () => {
  const stats = gatewayStats();
  const wd = watchdogStatus();

  const providerRows = stats.pool.providers
    .map(
      (p) => `<tr>
        <td><strong>${escapeHtml(p.name)}</strong><br><small>${escapeHtml(p.id)}</small></td>
        <td>${p.models}</td>
        <td>${bar(p.available, p.keys)}</td>
        <td>${p.soonestAvailabilityMs ? `${Math.ceil(p.soonestAvailabilityMs / 1000)}s` : '—'}</td>
      </tr>`,
    )
    .join('');

  const callerRows = stats.callers.length
    ? stats.callers
        .map(
          (c) => `<tr><td>${escapeHtml(c.userId)}</td><td>${escapeHtml(c.tier)}</td><td>${c.rpmUsed}/${c.rpmLimit ?? '∞'}</td><td>${c.day.requests}</td><td>${c.stats.total}</td><td>${c.stats.rejected}</td></tr>`,
        )
        .join('')
    : '<tr><td colspan="6"><em>No caller activity yet.</em></td></tr>';

  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Konkred Gateway · Status</title>
<style>
  :root{color-scheme:dark}
  body{margin:0;padding:32px;background:#0b0d10;color:#e6e6e6;font:14px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
  h1{font-size:20px;margin:0 0 4px} h2{font-size:14px;text-transform:uppercase;letter-spacing:.08em;color:#8b949e;margin:32px 0 12px}
  .sub{color:#8b949e;margin-bottom:24px}
  .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px}
  .card{background:#12161b;border:1px solid #1f262d;border-radius:10px;padding:14px}
  .card b{display:block;font-size:22px;margin-bottom:2px}
  table{width:100%;border-collapse:collapse;background:#12161b;border:1px solid #1f262d;border-radius:10px;overflow:hidden}
  th,td{text-align:left;padding:10px 12px;border-bottom:1px solid #1f262d;vertical-align:top}
  th{background:#161b21;color:#8b949e;font-weight:600;font-size:12px;text-transform:uppercase;letter-spacing:.05em}
  tr:last-child td{border-bottom:none}
  .bar{height:6px;background:#1f262d;border-radius:99px;overflow:hidden;margin-bottom:4px}
  .bar span{display:block;height:100%}
  small{color:#8b949e}
  code{background:#161b21;padding:2px 6px;border-radius:6px}
</style></head>
<body>
  <h1>⚡ Konkred Free-API Maximizer v2</h1>
  <div class="sub">Quota-aware multi-provider gateway · registry built ${escapeHtml(stats.registry.registryBuiltAt ?? 'unknown')} ·
  ${stats.registry.modelCount} models / ${stats.registry.providerCount} providers · env <code>${escapeHtml(config.env)}</code></div>

  <div class="grid">
    <div class="card"><b>${stats.pool.availableKeys}/${stats.pool.totalKeys}</b><small>keys available</small></div>
    <div class="card"><b>${stats.cache.live}</b><small>cached responses</small></div>
    <div class="card"><b>${stats.cache.hits}</b><small>cache hits</small></div>
    <div class="card"><b>${stats.dedup.inflight}</b><small>in-flight (deduped)</small></div>
    <div class="card"><b>${wd.ticks}</b><small>watchdog ticks</small></div>
    <div class="card"><b>${stats.callers.length}</b><small>active callers</small></div>
  </div>

  <h2>Provider pool</h2>
  <table><thead><tr><th>Provider</th><th>Models</th><th>Capacity</th><th>Next slot</th></tr></thead>
  <tbody>${providerRows || '<tr><td colspan="4"><em>No providers configured.</em></td></tr>'}</tbody></table>

  <h2>Caller activity</h2>
  <table><thead><tr><th>User</th><th>Tier</th><th>RPM</th><th>Today</th><th>Total</th><th>Rejected</th></tr></thead>
  <tbody>${callerRows}</tbody></table>

  <h2>Endpoints</h2>
  <table><tbody>
    <tr><td><code>POST /api/ai</code></td><td>Quota-aware inference (header <code>x-api-key</code>)</td></tr>
    <tr><td><code>GET /api/health</code></td><td>Liveness probe (no auth)</td></tr>
    <tr><td><code>GET /api/ready</code></td><td>Readiness probe — 503 when every key is cooling</td></tr>
    <tr><td><code>GET /api/models</code></td><td>Registry listing (header <code>x-api-key</code>)</td></tr>
    <tr><td><code>GET /api/status</code></td><td>Deep JSON status (header <code>x-admin-key</code>)</td></tr>
  </tbody></table>
</body></html>`;
};

export default renderDashboard;
