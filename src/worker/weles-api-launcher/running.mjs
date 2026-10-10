/**
 * Running things, and stopping when one of them cannot run.
 *
 * A launcher that swallowed a failed child would leave the unit reported as
 * active while nothing serves, so every refusal here ends the process with a
 * sentence naming what failed.
 */
import { spawnSync } from 'node:child_process';
import { statSync } from 'node:fs';

export function refuse(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

/** `KEY=value` lines the deployment wrote, with the shell quoting it used. */
function loadEnvFile(path) {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const separator = trimmed.indexOf('=');
    if (separator <= 0) continue;
    const key = trimmed
      .slice(0, separator)
      .replace(/^export\s+/, '')
      .trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = trimmed.slice(separator + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

/**
 * Run one startup step and keep its answer. The step is named on stdout
 * when it begins and when it ends, with the instant of each: a step that
 * never returns is then the last `began` line the unit log carries, read
 * there by whoever asks why the API never bound, instead of a log that ends
 * at the previous step's output and says nothing about which program is
 * still waiting on what.
 */
export function run(command, args, label) {
  const began = new Date();
  process.stdout.write(`[weles-api] ${label}: began ${began.toISOString()}\n`);
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    env: process.env,
  });
  const ended = new Date();
  process.stdout.write(
    `[weles-api] ${label}: ended ${ended.toISOString()} after ${ended - began} ms\n`,
  );
  if (result.error) refuse(`${label} could not run: ${result.error.message}`);
  if (result.status !== 0) {
    refuse(
      `${label} refused (exit ${result.status ?? 'none'}, signal ${result.signal ?? 'none'}): ${(result.stderr || result.stdout || 'no diagnostic output').trim()}`,
    );
  }
  return result.stdout.trim();
}

export function executable(path) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}
