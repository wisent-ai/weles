// Batch Pangram account registration.
// Registers N fresh accounts so each gets its own proxy/persona/domain from register.mjs.
// Does NOT run scans. Safe to run manually; defaults are conservative.

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runRecordingsDir } from '../../../dist/session/run-recordings.js';

const COUNT = Math.max(1, Number(process.env.PANGRAM_REGISTRATION_COUNT || 3));
const CONCURRENT = Math.max(1, Number(process.env.PANGRAM_MAX_CONCURRENT || 1));
const SCRIPT = process.env.PANGRAM_REGISTER_SCRIPT || join(process.cwd(), 'src/trajectories/pangram/register.mjs');
const LABEL = process.env.ACTION || 'pangram_register_batch';

function redactSecrets(text) {
  return String(text || '')
    .replace(/[a-zA-Z0-9._-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, (m) => `${m.split('@')[0].slice(0, 4)}***@${m.split('@')[1]}`)
    .replace(/ya29\.[A-Za-z0-9._-]+/g, '<token>');
}

function runRegister(index) {
  const action = `pangram_register_${index + 1}`;
  const env = {
    ...process.env,
    ACTION: action,
    PANGRAM_AUTO_REGISTER_RUN: '1',
  };
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SCRIPT], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('close', (code) => {
      const success = code === 0 && /PASS:\s*pangram account ready/i.test(stdout);
      const emailMatch = stdout.match(/email=([^\s]+)/);
      const accountMatch = stdout.match(/account saved:\s*pangram\/([^\s]+)/);
      resolve({
        index,
        success,
        exitCode: code,
        email: emailMatch?.[1] || null,
        username: accountMatch?.[1] || null,
        stdoutTail: redactSecrets(stdout.slice(-2500)),
        stderrTail: redactSecrets(stderr.slice(-1500)),
      });
    });
  });
}

async function runBatch() {
  if (!existsSync(SCRIPT)) throw new Error(`register script not found: ${SCRIPT}`);
  const results = [];
  const reportDir = runRecordingsDir(LABEL);
  mkdirSync(reportDir, { recursive: true });

  console.log(`[pangram_register_batch] count=${COUNT} concurrent=${CONCURRENT} script=${SCRIPT}`);

  for (let i = 0; i < COUNT; i += CONCURRENT) {
    const chunk = [];
    for (let j = 0; j < CONCURRENT && i + j < COUNT; j += 1) {
      chunk.push(runRegister(i + j));
    }
    const chunkResults = await Promise.all(chunk);
    for (const r of chunkResults) {
      console.log(`[pangram_register_batch] ${r.index + 1}/${COUNT} success=${r.success} email=${r.email || '?'}`);
      results.push(r);
    }
  }

  const report = {
    count: COUNT,
    concurrent: CONCURRENT,
    successful: results.filter((r) => r.success).length,
    failed: results.filter((r) => !r.success).length,
    results,
    ts: new Date().toISOString(),
  };

  const reportPath = join(reportDir, 'report.json');
  writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ reportPath, ...report }, null, 2));
  process.exit(report.failed > 0 ? 2 : 0);
}

runBatch().catch((e) => {
  console.error(`FAIL: ${e.message?.slice(0, 300)}`);
  process.exit(1);
});
