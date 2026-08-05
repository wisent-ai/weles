#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { access, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs, stateRoot } from './lib.mjs';

const args = parseArgs();
const state = stateRoot(args);
async function optionalJson(path) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if (error?.code === 'ENOENT') return null; throw error; }
}
async function count(path) {
  try { return (await readdir(path)).length; }
  catch (error) { if (error?.code === 'ENOENT') return 0; throw error; }
}
const current = await optionalJson(join(state, 'current.json'));
const previous = await optionalJson(join(state, 'previous.json'));
let wrapperPresent = false;
if (current?.wrapperPath) {
  try { await access(current.wrapperPath); wrapperPresent = true; } catch { wrapperPresent = false; }
}
let stado = null;
if (current?.host) {
  try {
    stado = JSON.parse(execFileSync(process.env.STADO_BIN ?? 'stado', [
      'service', 'status', 'weles-worker', '--json',
    ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
  } catch (error) {
    stado = { error: error instanceof Error ? error.message : String(error) };
  }
}
const status = {
  schema: 'weles.release-status.v1',
  stateRoot: state,
  current,
  previous,
  wrapperPresent,
  installationCount: await count(join(state, 'installations')),
  receiptCount: await count(join(state, 'receipts')),
  stado,
};
process.stdout.write(`${JSON.stringify(status, null, 2)}\n`);
