#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs, requiredArg } from './lib.mjs';

const args = parseArgs();
const decision = JSON.parse(await readFile(resolve(requiredArg(args, 'decision')), 'utf8'));
const baseline = JSON.parse(await readFile(resolve(requiredArg(args, 'baseline')), 'utf8'));
const declaration = JSON.parse(await readFile(resolve(requiredArg(args, 'declaration')), 'utf8'));
const manifest = JSON.parse(await readFile(resolve(requiredArg(args, 'manifest')), 'utf8'));

if (declaration.schema !== 'weles.version-change.v1') throw new Error('unsupported version declaration schema');
if (typeof declaration.breaking !== 'boolean') throw new Error('version declaration breaking must be boolean');
if (typeof declaration.reason !== 'string' || !declaration.reason.trim()) throw new Error('version declaration reason is required');
if (baseline.version !== declaration.current) throw new Error(`baseline version ${baseline.version} does not match declaration current ${declaration.current}`);
if (decision.current !== declaration.current) throw new Error(`AutoVersion current ${decision.current} does not match declaration current ${declaration.current}`);
if (manifest.version !== declaration.candidate) throw new Error(`package version ${manifest.version} does not match declaration candidate ${declaration.candidate}`);
if (!['internal', 'additive', 'breaking'].includes(decision.change)) throw new Error(`unsupported AutoVersion change ${decision.change}`);
if (!Array.isArray(decision.added) || !Array.isArray(decision.removed)) throw new Error('AutoVersion decision has no surface difference');
if (declaration.breaking && decision.change !== 'breaking') throw new Error('declared breaking change was not escalated by AutoVersion');

if (declaration.candidate === declaration.current) {
  if (decision.change !== 'internal') throw new Error(`surface changed but package remains ${declaration.current}; AutoVersion requires ${decision.next}`);
} else if (decision.next !== declaration.candidate) {
  throw new Error(`package declares ${declaration.candidate}, but AutoVersion requires ${decision.next}`);
}

process.stdout.write(`${JSON.stringify({
  schema: 'weles.version-verdict.v1',
  released: declaration.current,
  declared: declaration.candidate,
  change: decision.change,
  required: decision.next,
  breakingDeclared: declaration.breaking,
  added: decision.added,
  removed: decision.removed,
}, null, 2)}\n`);
