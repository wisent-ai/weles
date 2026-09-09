// What the run does when the pool has nothing left to scan with: it starts the
// Pangram register trajectory as a child process, tells from that child's exit
// code and output whether an account was really created, keeps a daily register
// ledger with the output tails as evidence, and holds the two retry budgets the
// whole run obeys. A registration that does not produce an account stays a
// failed registration carrying its own reason.

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { todayKey } from './pool_rotation.mjs';

export function maxAccountAttempts() {
  const raw = Number(process.env.PANGRAM_MAX_ACCOUNT_ATTEMPTS || 8);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 8;
}

export function registerAfterCreditFailures() {
  const raw = Number(process.env.PANGRAM_REGISTER_AFTER_CREDIT_FAILURES || 1);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 1;
}

function autoRegisterLedgerPath() {
  return process.env.PANGRAM_AUTO_REGISTER_LEDGER_FILE || join(process.env.HOME || process.cwd(), '.weles', 'pangram-auto-register.json');
}

export function readAutoRegisterLedger() {
  const path = autoRegisterLedgerPath();
  if (!existsSync(path)) return {};
  const parsed = JSON.parse(readFileSync(path, 'utf8'));
  return parsed && typeof parsed === 'object' ? parsed : {};
}

function writeAutoRegisterLedger(ledger) {
  const path = autoRegisterLedgerPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(ledger, null, 2));
}

export function maxAutoRegisters() {
  const raw = Number(process.env.PANGRAM_MAX_AUTO_REGISTERS || 3);
  return Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : 3;
}

export function autoRegisterCountToday(ledger) {
  return Number(ledger?.[todayKey()]?.count || 0);
}

async function runPangramRegisterChild(reason, mode) {
  const ledger = readAutoRegisterLedger();
  const limit = maxAutoRegisters();
  const todayCount = autoRegisterCountToday(ledger);
  if (todayCount >= limit) {
    return { success: false, reason: `daily_auto_register_limit ${todayCount}/${limit}` };
  }

  const script = process.env.PANGRAM_REGISTER_SCRIPT || join(process.cwd(), 'src/trajectories/pangram/register.mjs');
  if (!existsSync(script)) {
    return { success: false, reason: `register_script_not_found:${script}` };
  }

  const childEnv = {
    ...process.env,
    PANGRAM_AUTO_REGISTER_RUN: '1',
    WELES_RUN_ID: process.env.WELES_RUN_ID || `pangram-auto-register-${Date.now()}`,
    ACTION: `pangram_auto_register_${mode}_${Date.now()}`,
  };

  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script], {
      env: childEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('close', (code) => {
      const success = code === 0 && /PASS:\s*pangram account ready/i.test(stdout);
      ledger[todayKey()] = ledger[todayKey()] || { count: 0, runs: [] };
      ledger[todayKey()].count += 1;
      ledger[todayKey()].runs.push({
        reason,
        mode,
        success,
        exitCode: code,
        ts: new Date().toISOString(),
        stdoutTail: stdout.slice(-2000),
        stderrTail: stderr.slice(-1000),
      });
      writeAutoRegisterLedger(ledger);
      resolve({ success, reason: success ? 'registered' : `register_failed:${code}`, stdout, stderr, ledgerDay: ledger[todayKey()] });
    });
  });
}

export async function autoRegisterPangramAccount(reason) {
  return runPangramRegisterChild(reason, 'proxy');
}
