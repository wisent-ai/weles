/**
 * Aggregate health / login / register smoke-test runner for all platforms.
 *
 * Runs each platform's health probe (and optional login/register trajectory)
 * as isolated child processes, collects structured results, and writes an
 * aggregated JSON report.
 *
 * Env:
 *   PLATFORMS=linkedin,instagram,twitter,tiktok,reddit,discord  (default: all)
 *   RUN_LOGIN=1      also run <platform>_login.mjs
 *   RUN_REGISTER=1   also run <platform>_register.mjs (expensive; captcha/SMS)
 *   REPORT_DIR       directory for aggregated report (default: recordings/health_run_<ts>)
 */
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..', '..', '..');

const ALL_PLATFORMS = ['linkedin', 'instagram', 'twitter', 'tiktok', 'reddit', 'discord'];
const platforms = (process.env.PLATFORMS ?? ALL_PLATFORMS.join(','))
  .split(',')
  .map((p) => p.trim().toLowerCase())
  .filter((p) => ALL_PLATFORMS.includes(p));

const runLogin = process.env.RUN_LOGIN === '1';
const runRegister = process.env.RUN_REGISTER === '1';

function runNode(scriptPath, envExtra = {}) {
  return new Promise((resolve) => {
    const cwd = repoRoot;
    const cmd = 'node';
    const args = ['--env-file=.env', scriptPath];
    const child = spawn(cmd, args, {
      cwd,
      env: { ...process.env, ...envExtra },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const out = [];
    const err = [];
    child.stdout.on('data', (d) => out.push(d.toString()));
    child.stderr.on('data', (d) => err.push(d.toString()));
    child.on('close', (code) => {
      resolve({
        exitCode: code ?? 0,
        stdout: out.join(''),
        stderr: err.join(''),
      });
    });
    child.on('error', (e) => {
      resolve({
        exitCode: -1,
        stdout: out.join(''),
        stderr: err.join('') + `\nspawn error: ${e.message}`,
      });
    });
  });
}

function parseSignal(stdout) {
  const m = stdout.match(/signal=(\S+)/);
  return m ? m[1] : null;
}

function parseResultKind(stdout, exitCode) {
  if (stdout.includes('PASS:')) return 'PASS';
  if (stdout.includes('FAIL:')) return 'FAIL';
  if (exitCode === 0) return 'OK';
  return 'FAIL';
}

async function runPlatform(platform) {
  const results = { platform, healthy: false, checks: {} };

  // Health probe
  const healthPath = join(repoRoot, 'scripts', 'trajectories', platform, 'health.mjs');
  const health = await runNode(healthPath);
  const healthSignal = parseSignal(health.stdout);
  results.checks.health = {
    script: `scripts/trajectories/${platform}/health.mjs`,
    exitCode: health.exitCode,
    signal: healthSignal,
    result: healthSignal === 'healthy' ? 'PASS' : health.exitCode === 0 ? 'OK' : 'FAIL',
    stdout: health.stdout.slice(-2000),
    stderr: health.stderr.slice(-500),
  };
  results.healthy = results.checks.health.result === 'PASS';

  // Login trajectory
  if (runLogin) {
    const loginPath = join(repoRoot, 'scripts', 'trajectories', `${platform}_login.mjs`);
    const login = await runNode(loginPath);
    results.checks.login = {
      script: `scripts/trajectories/${platform}_login.mjs`,
      exitCode: login.exitCode,
      result: parseResultKind(login.stdout, login.exitCode),
      stdout: login.stdout.slice(-2000),
      stderr: login.stderr.slice(-500),
    };
  }

  // Register smoke test
  if (runRegister) {
    const registerPath = join(repoRoot, 'scripts', 'trajectories', `${platform}_register.mjs`);
    const register = await runNode(registerPath);
    results.checks.register = {
      script: `scripts/trajectories/${platform}_register.mjs`,
      exitCode: register.exitCode,
      result: parseResultKind(register.stdout, register.exitCode),
      stdout: register.stdout.slice(-2000),
      stderr: register.stderr.slice(-500),
    };
  }

  return results;
}

const startedAt = new Date().toISOString();
const reportDir = process.env.REPORT_DIR
  ? join(repoRoot, process.env.REPORT_DIR)
  : join(repoRoot, 'recordings', `health_run_${startedAt.replace(/[:.]/g, '-')}`);
mkdirSync(reportDir, { recursive: true });

console.log(`[health:all] platforms=${platforms.join(',')} login=${runLogin} register=${runRegister}`);
console.log(`[health:all] reportDir=${reportDir}`);

const platformResults = [];
for (const platform of platforms) {
  console.log(`\n[health:all] === ${platform} ===`);
  const r = await runPlatform(platform);
  platformResults.push(r);
  const health = r.checks.health;
  console.log(`[health:all] ${platform} health.signal=${health.signal ?? 'n/a'} result=${health.result}`);
  if (r.checks.login) console.log(`[health:all] ${platform} login.result=${r.checks.login.result}`);
  if (r.checks.register) console.log(`[health:all] ${platform} register.result=${r.checks.register.result}`);
}

const summary = {
  started_at: startedAt,
  finished_at: new Date().toISOString(),
  platforms,
  run_login: runLogin,
  run_register: runRegister,
  results: platformResults,
  healthy_count: platformResults.filter((p) => p.healthy).length,
  total_count: platformResults.length,
};

const reportPath = join(reportDir, 'health_report.json');
writeFileSync(reportPath, JSON.stringify(summary, null, 2));
console.log(`\n[health:all] aggregated report -> ${reportPath}`);
console.log(`[health:all] healthy ${summary.healthy_count}/${summary.total_count}`);

const allHealthy = summary.healthy_count === summary.total_count;
process.exit(allHealthy ? 0 : 2);
