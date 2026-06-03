#!/usr/bin/env node
// Parser draftów wniosku FENG SMART/STEP. Skanuje katalog markdownów,
// wyciąga bloki <!-- value name="X" -->Y<!-- /value --> i emituje flat JSON
// na stdout: { "X": { value, sourceFile, length } }.
//
// Użycie:
//   node parse_drafts.mjs <draft_root_dir>
//   node parse_drafts.mjs <draft_root_dir> > /tmp/values.json
//
// Domyślny katalog jeśli arg nie podany:
//   ../../../content-platform/applications/feng-sciezka-smart/sprind-version

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = resolve(
  __dirname,
  '../../../../content-platform/applications/feng-sciezka-smart/sprind-version',
);

function walkMd(root) {
  const out = [];
  for (const entry of readdirSync(root)) {
    if (entry.startsWith('.')) continue;
    const full = join(root, entry);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...walkMd(full));
    else if (entry.endsWith('.md')) out.push(full);
  }
  return out;
}

function extractValues(text, sourceFile, warnings) {
  const out = {};
  // Strip backtick-quoted spans so documentation examples like
  // `<!-- value name="..." -->` inside prose don't show up as real markers.
  const sanitized = text.replace(/`[^`\n]*`/g, '');
  const re = /<!--\s*value\s+name="([^"]+)"\s*-->([\s\S]*?)<!--\s*\/value\s*-->/g;
  let m;
  while ((m = re.exec(sanitized))) {
    const name = m[1].trim();
    if (/^[.]+$/.test(name)) continue;
    const value = m[2].trim();
    out[name] = { value, sourceFile, length: [...value].length };
  }
  return out;
}

function main() {
  const root = resolve(process.argv[2] || DEFAULT_ROOT);
  const files = walkMd(root);
  const all = {};
  const dupes = [];
  for (const f of files) {
    const text = readFileSync(f, 'utf8');
    const values = extractValues(text, f);
    for (const [name, payload] of Object.entries(values)) {
      if (all[name] !== undefined) {
        dupes.push({ name, first: all[name].sourceFile, second: payload.sourceFile });
      }
      all[name] = payload;
    }
  }
  if (dupes.length > 0) {
    process.stderr.write(`WARN: ${dupes.length} duplicated value name(s):\n`);
    for (const d of dupes) {
      process.stderr.write(`  ${d.name}\n    first:  ${d.first}\n    second: ${d.second}\n`);
    }
  }
  process.stderr.write(`OK: parsed ${Object.keys(all).length} value(s) from ${files.length} file(s) under ${root}\n`);
  process.stdout.write(JSON.stringify(all, null, 2) + '\n');
}

main();
