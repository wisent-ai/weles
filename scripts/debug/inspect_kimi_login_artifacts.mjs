import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.argv[2] || 'recordings/local/kimi_login';
const artifact = process.argv[3] || '';

function printSection(title, body) {
  console.log(`\n=== ${title} ===`);
  console.log(String(body || '').slice(0, 12000));
}

function readText(name) {
  return readFileSync(join(dir, name), 'utf8');
}

try {
  if (artifact.endsWith('.json')) {
    throw new Error('skipping DOM for JSON artifact');
  }
  const domName = artifact || 'session_dom_20260624_201514.html';
  const html = readText(domName);
  for (const needle of ['Continue with Google', 'Log in to', 'phone-login', 'google']) {
    const i = html.indexOf(needle);
    const snippet = i >= 0 ? html.slice(Math.max(0, i - 1400), i + 2200) : `not found: ${needle}`;
    printSection(`DOM around ${needle}`, snippet);
  }
} catch (e) {
  printSection('DOM read failed', e?.message || e);
}

try {
  if (artifact.endsWith('.json')) {
    const j = JSON.parse(readFileSync(join(dir, artifact), 'utf8'));
    printSection('inst summary', JSON.stringify({
      label: j.label,
      started_at: j.started_at,
      closed_at: j.closed_at,
      events_tail: (j.playwright_events || []).slice(-40),
      stdout_tail: (j.stdout || []).slice(-40),
      errors_tail: (j.pageerrors || []).slice(-20),
      log_tail: (j.console || []).slice(-20),
      sibling_files: j.sibling_files,
    }, null, 2));
  }
} catch (e) {
  printSection('inst read failed', e?.message || e);
}

try {
  const lines = readText('network.ndjson').split('\n').filter(Boolean);
  const out = [];
  for (const line of lines) {
    try {
      const o = JSON.parse(line);
      const url = o.url || o.request?.url || '';
      if (!/kimi\.com|google|moonshot/i.test(url)) continue;
      out.push(JSON.stringify({
        type: o.type || o.event || o.method,
        status: o.status || o.response?.status,
        method: o.method || o.request?.method,
        url,
      }).slice(0, 800));
    } catch {}
  }
  printSection('network kimi/google', out.join('\n'));
} catch (e) {
  printSection('network read failed', e?.message || e);
}

try {
  const report = JSON.parse(readText('detection_report.json'));
  printSection('detection report', JSON.stringify(report, null, 2));
} catch (e) {
  printSection('detection read failed', e?.message || e);
}
