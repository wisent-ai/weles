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

/** Announce the operation before waiting; retain its completion separately. */
function beginStep(label) {
  const began = new Date();
  const step = {
    operation: label,
    pid: process.pid,
    began_at: began.toISOString(),
  };
  process.stdout.write(`${JSON.stringify({ startup_step: step })}\n`);
  return () => {
    const ended = new Date();
    process.stdout.write(
      `${JSON.stringify({ startup_step: { ...step, ended_at: ended.toISOString(), duration_ms: ended - began } })}\n`,
    );
  };
}

export function runCommand(command, args, label) {
  const end = beginStep(label);
  try {
    return spawnSync(command, args, { encoding: 'utf8', env: process.env });
  } finally {
    end();
  }
}

export async function runAsync(label, operation) {
  const end = beginStep(label);
  try {
    return await operation();
  } catch (error) {
    throw new Error(
      `${label}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  } finally {
    end();
  }
}

export function run(command, args, label) {
  const result = runCommand(command, args, label);
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
