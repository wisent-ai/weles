// Batch Pangram account registration.
// Registers the stated number of fresh accounts so each gets its own
// proxy/persona/domain from register.mjs. Does NOT run scans. How many accounts
// and how many at once are the caller's: both are required.

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runRecordingsDir } from '../../../../dist/session/run-recordings.js';

function stated(name, what) {
  const raw = process.env[name];
  const value = Number(raw);
  if (!raw || !Number.isSafeInteger(value) || !(value >= Number.MIN_VALUE)) {
    throw new Error(`${name} is ${raw ? `"${raw}", not a whole number above zero` : 'not set'}: ${what}; nothing is assumed`);
  }
  return value;
}
const COUNT = stated('PANGRAM_REGISTRATION_COUNT', 'how many Pangram accounts this batch registers');
const CONCURRENT = stated('PANGRAM_MAX_CONCURRENT', 'how many registrations run at once');
const SCRIPT = process.env.PANGRAM_REGISTER_SCRIPT || join(process.cwd(), 'src/trajectories/pangram/register.mjs');
const LABEL = process.env.ACTION || 'pangram_register_batch';

function redactSecrets(text) {
  return String(text || '')
    .replace(/[a-zA-Z0-9._-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, (m) => `***@${m.split('@').pop()}`)
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
        stdoutTail: redactSecrets(stdout),
        stderrTail: redactSecrets(stderr),
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
  console.error(`FAIL: ${e.message}`);
  process.exit(1);
});
