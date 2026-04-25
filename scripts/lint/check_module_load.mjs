// Walk every compiled module under dist/ and try to require() it.
// Reports any module that crashes at load time. Catches circular-import and
// prototype-augmentation bugs of the same class as the 5960e6f → 9319340 atoms
// regression. Side-effect-free: never opens a browser, never POSTs anywhere.
import { readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const distRoot = join(here, '..', '..', 'dist');
const req = createRequire(import.meta.url);

// dist/scripts/ and dist/diagnostics/property_trap.js are page-side init
// scripts injected via addInitScript, not Node modules — skip them.
const isInjectOnly = (p) => /\/(scripts|diagnostics\/property_trap)\b/.test(p);

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (p.endsWith('.js') && !isInjectOnly(p)) out.push(p);
  }
  return out;
}

const files = walk(distRoot).sort();
let pass = 0; const fails = [];
for (const f of files) {
  try { req(f); pass++; }
  catch (e) { fails.push({ f: f.replace(distRoot + '/', ''), msg: (e?.message || String(e)).slice(0, 200) }); }
}
console.log(`loaded ${pass} / ${files.length} modules`);
if (fails.length) {
  console.log(`\nFAILURES (${fails.length}):`);
  for (const x of fails) console.log(`  ${x.f}\n    ${x.msg}`);
  process.exitCode = 1;
} else {
  console.log('OK: every dist/ module loads cleanly');
}
