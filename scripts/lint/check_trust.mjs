#!/usr/bin/env node
/**
 * Scan scripts/trajectories/ for patterns that dispatch untrusted DOM events.
 * Fails non-zero when found; exits 0 if clean. See docs/DETECTION_ANTIPATTERNS.md.
 *
 * Flags:
 *   1. `.click()` inside a page.evaluate(...) call — isTrusted=false. The
 *      evaluate call is located by finding the opening `page.evaluate(` and
 *      walking forward with paren+bracket+quote tracking until the matching
 *      close is found. Only `.click()` within that span is reported.
 *   2. `dispatchEvent(new MouseEvent(` anywhere (isTrusted=false mouse events).
 *
 * Does NOT flag:
 *   - s.jsClick()            — deliberate shadow-DOM escape hatch
 *   - dispatchEvent(new Event('input' | 'change', ...))  — React controlled-input
 *   - locator.click() / page.mouse.click() / page.click() — CDP-routed
 */
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';

const ROOT = join(process.cwd(), 'scripts', 'trajectories');

async function walk(dir) {
  const out = [];
  for (const ent of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, ent.name);
    if (ent.isDirectory()) out.push(...await walk(p));
    else if (ent.name.endsWith('.mjs')) out.push(p);
  }
  return out;
}

// Walk a source string starting at `from` (which points just past an opening
// paren) and return the index of the matching close-paren, tracking string
// literals, template literals, line/block comments, and nested brackets.
function findMatchingClose(src, from) {
  let depth = 1;
  let i = from;
  while (i < src.length) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') { i = src.indexOf('\n', i); if (i < 0) return -1; i++; continue; }
    if (c === '/' && src[i + 1] === '*') { const e = src.indexOf('*/', i + 2); if (e < 0) return -1; i = e + 2; continue; }
    if (c === '"' || c === "'") {
      i++;
      while (i < src.length && src[i] !== c) { if (src[i] === '\\') i++; i++; }
      i++; continue;
    }
    if (c === '`') {
      i++;
      while (i < src.length && src[i] !== '`') {
        if (src[i] === '\\') { i += 2; continue; }
        if (src[i] === '$' && src[i + 1] === '{') { i += 2; let d = 1; while (i < src.length && d > 0) { if (src[i] === '{') d++; else if (src[i] === '}') d--; i++; } continue; }
        i++;
      }
      i++; continue;
    }
    if (c === '(') depth++;
    else if (c === ')') { depth--; if (depth === 0) return i; }
    i++;
  }
  return -1;
}

const EVALUATE_OPEN_RE = /\bpage\.evaluate\s*\(/g;
// Any `.click()` call inside an evaluate body — preceding expression can be
// an identifier OR a function-call result (e.g. querySelector(...)?.click()).
const CLICK_CALL_RE = /\.click\s*\(\s*\)/g;
const MOUSE_EVENT_RE = /dispatchEvent\s*\(\s*new\s+MouseEvent\s*\(/g;

function lineFor(src, pos) { return src.slice(0, pos).split('\n').length; }

// Replace // and /* */ comments with spaces of equal length so line numbers
// remain correct and no `page.evaluate(` in a comment is detected as code.
function stripComments(src) {
  let out = '';
  let i = 0;
  while (i < src.length) {
    if (src[i] === '/' && src[i + 1] === '/') { const e = src.indexOf('\n', i); const end = e < 0 ? src.length : e; out += ' '.repeat(end - i); i = end; continue; }
    if (src[i] === '/' && src[i + 1] === '*') { const e = src.indexOf('*/', i + 2); const end = e < 0 ? src.length : e + 2; for (let k = i; k < end; k++) out += src[k] === '\n' ? '\n' : ' '; i = end; continue; }
    if (src[i] === '"' || src[i] === "'" || src[i] === '`') {
      const q = src[i]; out += q; i++;
      while (i < src.length && src[i] !== q) { if (src[i] === '\\') { out += src[i]; i++; } out += src[i]; i++; }
      if (i < src.length) { out += src[i]; i++; }
      continue;
    }
    out += src[i]; i++;
  }
  return out;
}

async function main() {
  const files = await walk(ROOT);
  const hits = [];
  for (const f of files) {
    const raw = await readFile(f, 'utf8');
    const src = stripComments(raw);
    const rel = relative(process.cwd(), f);
    EVALUATE_OPEN_RE.lastIndex = 0;
    MOUSE_EVENT_RE.lastIndex = 0;
    let m;
    while ((m = EVALUATE_OPEN_RE.exec(src))) {
      const openPos = m.index + m[0].length;
      const closePos = findMatchingClose(src, openPos);
      if (closePos < 0) continue;
      const body = src.slice(openPos, closePos);
      CLICK_CALL_RE.lastIndex = 0;
      let cm;
      while ((cm = CLICK_CALL_RE.exec(body))) {
        const absPos = openPos + cm.index;
        const line = lineFor(src, absPos);
        const preview = src.slice(Math.max(0, absPos - 30), absPos + 60).replace(/\s+/g, ' ');
        hits.push({ file: rel, line, kind: 'click-in-evaluate', preview });
      }
    }
    while ((m = MOUSE_EVENT_RE.exec(src))) {
      hits.push({ file: rel, line: lineFor(src, m.index), kind: 'dispatch-mouseevent', preview: src.slice(m.index, m.index + 80) });
    }
  }
  if (hits.length === 0) { console.log(`[lint-trust] OK — scanned ${files.length} trajectory files, no anti-patterns`); process.exit(0); }
  console.log(`[lint-trust] FAIL — ${hits.length} anti-pattern hit(s) across ${new Set(hits.map(h => h.file)).size} file(s):\n`);
  for (const h of hits) console.log(`  ${h.file}:${h.line}  [${h.kind}]  ${h.preview}`);
  console.log(`\nSee docs/DETECTION_ANTIPATTERNS.md §1 for the sanctioned replacements (s.click / s.clickSelector / s.page.locator(sel).click()).`);
  process.exit(2);
}

main().catch((e) => { console.error(e); process.exit(3); });
