// Read-only comparator for two local NCBR Pangram UI audit reports.

import { readFileSync } from 'node:fs';

const [aPath, bPath] = process.argv.slice(2);
if (!aPath || !bPath) {
  console.error('usage: node compare_ncbr_audit_reports.mjs <old-audit-report.json> <new-audit-report.json>');
  process.exit(2);
}

function load(path) {
  return JSON.parse(readFileSync(path, 'utf8')).results || [];
}

function summarize(results) {
  const sections = new Map();
  for (const r of results) {
    const key = r.id;
    if (!sections.has(key)) {
      sections.set(key, {
        id: key,
        title: r.title || '',
        checked: 0,
        human: 0,
        ai_generated: 0,
        ai_assisted: 0,
        soft_human: 0,
        skipped: 0,
        missing: 0,
      });
    }
    const s = sections.get(key);
    if (r.status === 'checked' || r.status === 'reused') {
      s.checked += 1;
      if (r.verdict === 'human') s.human += 1;
      if (r.verdict === 'ai_generated') s.ai_generated += 1;
      if (r.verdict === 'ai_assisted') s.ai_assisted += 1;
      if (r.verdict === 'human' && (r.ai_percent ?? 0) >= 50) s.soft_human += 1;
    } else {
      s.skipped += 1;
      if (r.status === 'missing_source') s.missing += 1;
    }
  }
  return sections;
}

function klass(s) {
  if (!s) return 'NO_SOURCE';
  if (s.ai_generated || s.ai_assisted) return 'BAD';
  if (s.checked && s.soft_human) return 'SOFT';
  if (s.checked) return 'OK';
  if (s.missing) return 'MISSING';
  return 'SKIPPED';
}

function badCount(s) {
  return s ? s.ai_generated + s.ai_assisted : 0;
}

function totals(results) {
  const checked = results.filter((r) => r.status === 'checked' || r.status === 'reused');
  const human = checked.filter((r) => r.verdict === 'human').length;
  const soft = checked.filter((r) => r.verdict === 'human' && (r.ai_percent ?? 0) >= 50).length;
  const aiGenerated = checked.filter((r) => r.verdict === 'ai_generated').length;
  const aiAssisted = checked.filter((r) => r.verdict === 'ai_assisted').length;
  return {
    total: results.length,
    checked: checked.length,
    human,
    ai_generated: aiGenerated,
    ai_assisted: aiAssisted,
    bad: aiGenerated + aiAssisted,
    soft_human: soft,
    strict_human: human - soft,
    skipped: results.length - checked.length,
  };
}

const aResults = load(aPath);
const bResults = load(bPath);
const a = summarize(aResults);
const b = summarize(bResults);
const ids = [...new Set([...a.keys(), ...b.keys()])].sort((x, y) => x.localeCompare(y, 'pl', { numeric: true }));

console.log(`TOTAL_A\t${JSON.stringify(totals(aResults))}`);
console.log(`TOTAL_B\t${JSON.stringify(totals(bResults))}`);
console.log('id\ttitle\told_class\told_checked\told_human\told_ai_generated\told_ai_assisted\told_soft_human\told_skipped\tnew_class\tnew_checked\tnew_human\tnew_ai_generated\tnew_ai_assisted\tnew_soft_human\tnew_skipped\tdelta_bad');
for (const id of ids) {
  const oldS = a.get(id);
  const newS = b.get(id);
  console.log([
    id,
    newS?.title || oldS?.title || '',
    klass(oldS),
    oldS?.checked || 0,
    oldS?.human || 0,
    oldS?.ai_generated || 0,
    oldS?.ai_assisted || 0,
    oldS?.soft_human || 0,
    oldS?.skipped || 0,
    klass(newS),
    newS?.checked || 0,
    newS?.human || 0,
    newS?.ai_generated || 0,
    newS?.ai_assisted || 0,
    newS?.soft_human || 0,
    newS?.skipped || 0,
    badCount(newS) - badCount(oldS),
  ].join('\t'));
}
