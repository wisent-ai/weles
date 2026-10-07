#!/usr/bin/env node
// Record the release a new version replaces in runtime.rollback_compatible_with
// of .wisent-release.json. `stado release submit` refuses a version that does
// not name the release it would replace, and every rollout target would
// quarantine its digest; writing the entry by hand at each bump is how it was
// forgotten. npm runs this before `npm version` changes package.json
// (`preversion`), so the version it reads there is the one being replaced.
//
// Usage: node scripts/release/rollback-compat.mjs [--replaces <version>]
//   --replaces names the replaced release when the bump already happened.

import { readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

const MANIFEST = '.wisent-release.json';
const { values } = parseArgs({ options: { replaces: { type: 'string' } } });
const replaced = values.replaces ?? JSON.parse(readFileSync('package.json', 'utf8')).version;
if (!/^\d+\.\d+\.\d+$/.test(String(replaced))) {
  throw new Error(`the replaced release must be a version such as the one in package.json; got ${replaced}`);
}
const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'));
const runtime = manifest.runtime;
if (!runtime || !Array.isArray(runtime.rollback_compatible_with)) {
  throw new Error(`${MANIFEST} has no runtime.rollback_compatible_with list to record ${replaced} in`);
}
if (runtime.rollback_compatible_with.includes(replaced)) {
  console.log(`${MANIFEST} already names ${replaced} as rollback-compatible`);
} else {
  runtime.rollback_compatible_with = [replaced, ...runtime.rollback_compatible_with];
  writeFileSync(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`${MANIFEST}: ${replaced} recorded as rollback-compatible`);
}
