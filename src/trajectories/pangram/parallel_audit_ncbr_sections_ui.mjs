// Parallel orchestrator for audit_ncbr_sections_ui.mjs.
// It only launches independent UI audit processes; it does not call Pangram APIs.

import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const WEL = '/Users/lukaszbartoszcze/Documents/CodingProjects/Wisent/weles';
const ROOT = '/Users/lukaszbartoszcze/Documents/CodingProjects/Wisent/backends/STEP_sciezka_A_Wisent';
const REPORT_ROOT = process.env.REPORT_ROOT || join(ROOT, 'pangram_section_audit');
const TS = new Date().toISOString().replace(/[:.]/g, '-');
const RUN_PREFIX = process.env.WELES_RUN_ID || `ncbr-pangram-parallel-${TS}`;
const ONLY_PATH = process.env.ONLY_PATH || '';
const MAX_PARALLEL = Number(process.env.MAX_PARALLEL || 4);
const MAX_CHECKS_PER_SHARD = process.env.MAX_CHECKS_PER_SHARD || process.env.MAX_CHECKS || '999';
const DEFAULT_SHARDS = ONLY_PATH.toUpperCase() === 'A'
  ? ['^A 1\\.', '^A 2\\.', '^A 3\\.', '^A 4\\.', '^A 5\\.', '^A 6\\.', '^A 7', '^A 8', '^A 9\\.', '^A 10\\.']
  : ['^B 1\\.', '^B 2\\.', '^B 3\\.', '^B 4\\.', '^B 5\\.', '^B 6\\.', '^B 7', '^B 8', '^B 9\\.', '^B 10\\.'];

const shards = (process.env.SECTION_PATTERNS || process.env.PANGRAM_AUDIT_SHARDS || DEFAULT_SHARDS.join('|||'))
  .split(process.env.SECTION_PATTERNS?.includes('|||') || process.env.PANGRAM_AUDIT_SHARDS?.includes('|||') ? '|||' : ',')
  .map((s) => s.trim())
  .filter(Boolean);

const accounts = (process.env.ACCOUNT_IDS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

function slug(s) {
  return String(s)
    .normalize('NFKD')
    .replace(/[^\w.-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80);
}

function parseLastJson(stdout) {
  const match = String(stdout || '').match(/\{[\s\S]*\}\s*$/);
  if (!match) return null;
  try { return JSON.parse(match[0]); } catch { return null; }
}

function runShard(shard, index) {
  const runId = `${RUN_PREFIX}-shard-${String(index + 1).padStart(2, '0')}-${slug(shard)}`;
  const accountId = accounts.length ? accounts[index % accounts.length] : '';
  const env = {
    ...process.env,
    WELES_RUN_ID: runId,
    SECTION_PATTERN: shard,
    MAX_CHECKS: MAX_CHECKS_PER_SHARD,
  };
  if (ONLY_PATH) env.ONLY_PATH = ONLY_PATH;
  if (accountId) env.ACCOUNT_IDS = accountId;

  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--env-file=.env', 'src/trajectories/pangram/audit_ncbr_sections_ui.mjs'], {
      cwd: WEL,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; process.stdout.write(`[${index + 1}] ${d}`); });
    child.stderr.on('data', (d) => { stderr += d; process.stderr.write(`[${index + 1}] ${d}`); });
    child.on('close', (code, signal) => {
      resolve({
        index,
        shard,
        runId,
        accountId: accountId || null,
        code,
        signal,
        summary: parseLastJson(stdout),
        stdoutTail: stdout.slice(-4000),
        stderrTail: stderr.slice(-4000),
      });
    });
  });
}

const outDir = join(REPORT_ROOT, RUN_PREFIX);
mkdirSync(outDir, { recursive: true });

const results = [];
let next = 0;
let active = 0;

await new Promise((resolve) => {
  const pump = () => {
    while (active < Math.max(1, MAX_PARALLEL) && next < shards.length) {
      const index = next;
      const shard = shards[next++];
      active += 1;
      runShard(shard, index).then((result) => {
        results[index] = result;
        active -= 1;
        writeFileSync(join(outDir, 'parallel_report.partial.json'), JSON.stringify({
          runPrefix: RUN_PREFIX,
          generatedAt: new Date().toISOString(),
          onlyPath: ONLY_PATH || null,
          maxParallel: MAX_PARALLEL,
          results: results.filter(Boolean),
        }, null, 2));
        pump();
      });
    }
    if (next >= shards.length && active === 0) resolve();
  };
  pump();
});

const report = {
  runPrefix: RUN_PREFIX,
  generatedAt: new Date().toISOString(),
  onlyPath: ONLY_PATH || null,
  maxParallel: MAX_PARALLEL,
  maxChecksPerShard: MAX_CHECKS_PER_SHARD,
  shardCount: shards.length,
  failedShardCount: results.filter((r) => r.code !== 0).length,
  checkedCount: results.reduce((sum, r) => sum + Number(r.summary?.checkedCount || 0), 0),
  humanCount: results.reduce((sum, r) => sum + Number(r.summary?.humanCount || 0), 0),
  aiGeneratedCount: results.reduce((sum, r) => sum + Number(r.summary?.aiGeneratedCount || 0), 0),
  skippedCount: results.reduce((sum, r) => sum + Number(r.summary?.skippedCount || 0), 0),
  results,
};

const reportPath = join(outDir, 'parallel_report.json');
writeFileSync(reportPath, JSON.stringify(report, null, 2));
console.log(JSON.stringify({ ...report, reportPath }, null, 2));
process.exit(report.failedShardCount ? 2 : 0);
