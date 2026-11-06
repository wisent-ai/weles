#!/usr/bin/env node
// Name the version `npm version` just wrote into package.json as the
// declaration's candidate. It is run by hand after `npm version`, which
// itself follows adopt-published (https://weles.wisent.com/docs/versions lists the three commands),
// so the declaration says which release this tree replaces and which version
// it becomes, the two things the version gate compares with the baseline and
// the manifest.
//
// Usage: node scripts/release/version/declare-candidate.mjs [--root <directory>]

import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { repositoryRoot } from '../../../src/release/index.mjs';

const { values } = parseArgs({ options: { root: { type: 'string' } } });
const root = values.root ? resolve(values.root) : repositoryRoot();
const declarationPath = join(root, 'release', 'version-change.json');
const declaration = JSON.parse(readFileSync(declarationPath, 'utf8'));
const candidate = JSON.parse(
  readFileSync(join(root, 'package.json'), 'utf8'),
).version;
if (typeof candidate !== 'string') {
  throw new Error('package.json names no version to declare as the candidate');
}
if (candidate === declaration.current) {
  throw new Error(
    `package.json still names ${candidate}, the release Stado serves; npm version did not bump it`,
  );
}
declaration.candidate = candidate;
writeFileSync(declarationPath, `${JSON.stringify(declaration, null, '  ')}\n`);
console.log(`${declarationPath}: ${declaration.current} -> ${candidate}`);
