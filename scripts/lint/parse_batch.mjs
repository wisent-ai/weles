// Parse one or more test-batch JSON dumps and emit a per-action table.
// When multiple files are passed, each action's BEST result wins (a later
// batch's "completed" supersedes an earlier batch's "failed").
import { readFileSync } from 'node:fs';

const paths = process.argv.slice(2);
if (!paths.length) paths.push('/tmp/batch_final.json');
const all = paths.flatMap(p => JSON.parse(readFileSync(p, 'utf8')));
// Per-action best wins: completed+healthy > completed+envblock > failed
function rank(r) {
  const sig = r.result?.ban_signal?.signal ?? 'n/a';
  if (r.status === 'completed' && sig === 'healthy') return 5;
  if (r.status === 'completed' && /shadowbanned|suspended|ip_blocked|checkpoint|rate_limited|captcha_challenge|reset_failed|proxy_failed/.test(sig)) return 4;
  if (r.status === 'completed') return 3;
  // Among failures, prefer ones with platform-classified signals (proxy_failed,
  // checkpoint, captcha, action_failed) over 'healthy' (page reached but no
  // ban detected, least informative for a failure) over unknown_error.
  if (/proxy_failed|checkpoint|captcha_challenge|action_failed|reset_failed|shadowbanned|suspended/.test(sig)) return 2;
  if (sig !== 'unknown' && sig !== 'unknown_error' && sig !== 'n/a') return 1;
  return 0;
}
const best = new Map();
for (const r of all) {
  const cur = best.get(r.action);
  if (!cur || rank(r) > rank(cur)) best.set(r.action, r);
}
const rows = [...best.values()];

const lines = [];
const tally = { completed_healthy: 0, completed_envblock: 0, completed_unknown: 0, failed_unknown: 0, failed_other: 0 };

for (const r of rows) {
  const sig = r.result?.ban_signal?.signal ?? 'n/a';
  const err = (r.error ?? '').slice(0, 80).replace(/\s+/g, ' ');
  let bucket;
  if (r.status === 'completed' && sig === 'healthy') { bucket = 'completed_healthy'; tally.completed_healthy++; }
  else if (r.status === 'completed' && /shadowbanned|suspended|ip_blocked|checkpoint|rate_limited|captcha_challenge|reset_failed|proxy_failed/.test(sig)) { bucket = 'completed_envblock'; tally.completed_envblock++; }
  else if (r.status === 'completed') { bucket = 'completed_unknown'; tally.completed_unknown++; }
  else if (sig === 'unknown_error' || sig === 'unknown') { bucket = 'failed_unknown'; tally.failed_unknown++; }
  else { bucket = 'failed_other'; tally.failed_other++; }
  lines.push({ action: r.action, status: r.status, signal: sig, bucket, err });
}

lines.sort((a, b) => a.action.localeCompare(b.action));
const w = (s, n) => s.padEnd(n).slice(0, n);
if (process.env.EMIT_FAILED) {
  // Write the still-failing rows (excluding env-block) to /tmp/failed_to_rerun.json
  // for the rerun_failed.mjs companion script to pick up.
  const out = rows.filter(r => {
    const sig = r.result?.ban_signal?.signal;
    if (r.status === 'completed' && (sig === 'healthy' || /shadowbanned|suspended|ip_blocked|checkpoint|reset_failed/.test(sig ?? ''))) return false;
    return true;
  });
  const fs2 = await import('node:fs');
  fs2.writeFileSync(process.env.EMIT_FAILED, JSON.stringify(out));
  console.log(`emitted ${out.length} failed rows to ${process.env.EMIT_FAILED}`);
  process.exit(0);
}
console.log(`${w('action', 36)} ${w('status', 11)} ${w('signal', 22)} ${w('bucket', 22)} error`);
console.log('-'.repeat(120));
for (const x of lines) console.log(`${w(x.action, 36)} ${w(x.status, 11)} ${w(x.signal, 22)} ${w(x.bucket, 22)} ${x.err}`);
console.log('');
console.log(`Total: ${rows.length}`);
console.log(`completed + healthy        : ${tally.completed_healthy}`);
console.log(`completed + env-block      : ${tally.completed_envblock}  (account/proxy issue, not bug)`);
console.log(`completed + other signal   : ${tally.completed_unknown}`);
console.log(`failed   + unknown(_error) : ${tally.failed_unknown}  (likely trajectory crash)`);
console.log(`failed   + classified sig  : ${tally.failed_other}`);
