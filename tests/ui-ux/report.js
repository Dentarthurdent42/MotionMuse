export function generateReport(results) {
  const allIssues = results.flatMap(r => r.evaluation.issues ?? []);
  const errorCount   = allIssues.filter(i => i.severity === 'error').length;
  const warningCount = allIssues.filter(i => i.severity === 'warning').length;
  const scored = results.filter(r => r.evaluation.score != null);
  const avgScore = scored.length
    ? (scored.reduce((s, r) => s + r.evaluation.score, 0) / scored.length).toFixed(1)
    : 'N/A';

  function scoreColor(s) {
    if (s >= 8) return '#22c55e';
    if (s >= 6) return '#f59e0b';
    return '#ef4444';
  }

  function severityColor(s) {
    return { error: '#ef4444', warning: '#f59e0b', info: '#60a5fa' }[s] ?? '#94a3b8';
  }

  const cards = results.map(r => {
    const ev = r.evaluation;
    const issues = ev.issues ?? [];
    const issueRows = issues.length
      ? issues.map(iss => `
        <tr>
          <td><span class="badge" style="background:${severityColor(iss.severity)}22;color:${severityColor(iss.severity)}">${iss.severity}</span></td>
          <td>${esc(iss.area)}</td>
          <td>${esc(iss.description)}</td>
          <td>${esc(iss.suggestion)}</td>
        </tr>`).join('')
      : `<tr><td colspan="4" class="no-issues">✓ No issues found</td></tr>`;

    return `
  <section class="card">
    <div class="card-head">
      <h2>${esc(r.label)}</h2>
      <span class="score" style="color:${ev.score != null ? scoreColor(ev.score) : '#64748b'}">${ev.score ?? '—'}<span class="score-denom">${ev.score != null ? '/10' : ''}</span></span>
    </div>
    <p class="card-summary">${esc(ev.summary ?? '')}</p>
    <div class="card-body">
      <div class="screenshot-wrap">
        <img src="data:image/png;base64,${r.image}" alt="${esc(r.label)}" loading="lazy" />
      </div>
      <div class="issues-wrap">
        <table>
          <thead><tr><th>Severity</th><th>Area</th><th>Issue</th><th>Suggestion</th></tr></thead>
          <tbody>${issueRows}</tbody>
        </table>
      </div>
    </div>
  </section>`;
  }).join('\n');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>UI/UX Report — Music Maker</title>
<style>
  *, *::before, *::after { box-sizing: border-box; }
  body {
    font-family: system-ui, -apple-system, sans-serif;
    background: #0b0e14; color: #cbd5e1;
    margin: 0; padding: 24px;
  }
  .page { max-width: 1200px; margin: 0 auto; }
  h1 { font-size: 1.25rem; font-weight: 700; color: #f1f5f9; margin: 0 0 4px; }
  .subtitle { font-size: 0.8rem; color: #64748b; margin: 0 0 24px; }
  .summary-bar { display: flex; flex-wrap: wrap; gap: 12px; margin-bottom: 36px; }
  .stat {
    background: #151b27; border: 1px solid #1e293b;
    border-radius: 10px; padding: 14px 20px; min-width: 100px;
  }
  .stat-value { font-size: 1.8rem; font-weight: 700; line-height: 1; }
  .stat-label { font-size: 0.7rem; color: #64748b; text-transform: uppercase; letter-spacing: .08em; margin-top: 4px; }
  .card {
    background: #151b27; border: 1px solid #1e293b;
    border-radius: 12px; margin-bottom: 28px; overflow: hidden;
  }
  .card-head {
    display: flex; align-items: center; justify-content: space-between;
    padding: 14px 20px; background: #0f1520; border-bottom: 1px solid #1e293b;
  }
  .card-head h2 { margin: 0; font-size: 0.9rem; font-weight: 600; color: #e2e8f0; }
  .score { font-size: 1.6rem; font-weight: 800; }
  .score-denom { font-size: 0.9rem; font-weight: 400; color: #475569; }
  .card-summary { margin: 10px 20px; font-size: 0.8rem; color: #94a3b8; }
  .card-body { display: grid; grid-template-columns: auto 1fr; gap: 20px; padding: 0 20px 20px; align-items: start; }
  .screenshot-wrap img { display: block; width: 200px; border-radius: 8px; border: 1px solid #1e293b; }
  table { width: 100%; border-collapse: collapse; font-size: 0.78rem; }
  thead tr { background: #0f1520; }
  th { text-align: left; padding: 8px 10px; color: #64748b; font-weight: 600; font-size: 0.7rem; text-transform: uppercase; letter-spacing: .06em; }
  td { padding: 8px 10px; border-bottom: 1px solid #1e293b; vertical-align: top; }
  .badge {
    display: inline-block; padding: 2px 7px; border-radius: 4px;
    font-size: 0.68rem; font-weight: 700; text-transform: uppercase; letter-spacing: .04em;
  }
  .no-issues { color: #22c55e; text-align: center; padding: 16px; font-size: 0.82rem; }
  @media (max-width: 700px) {
    .card-body { grid-template-columns: 1fr; }
    .screenshot-wrap img { width: 100%; max-width: 320px; }
  }
</style>
</head>
<body>
<div class="page">
  <h1>UI/UX Test Report — Music Maker</h1>
  <p class="subtitle">Generated ${new Date().toUTCString()}</p>

  <div class="summary-bar">
    <div class="stat">
      <div class="stat-value" style="color:${scoreColor(parseFloat(avgScore))}">${avgScore}</div>
      <div class="stat-label">Avg Score</div>
    </div>
    <div class="stat">
      <div class="stat-value" style="color:#ef4444">${errorCount}</div>
      <div class="stat-label">Errors</div>
    </div>
    <div class="stat">
      <div class="stat-value" style="color:#f59e0b">${warningCount}</div>
      <div class="stat-label">Warnings</div>
    </div>
    <div class="stat">
      <div class="stat-value">${results.length}</div>
      <div class="stat-label">Screenshots</div>
    </div>
  </div>

${cards}
</div>
</body>
</html>`;
}

function esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
