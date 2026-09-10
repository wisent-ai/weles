#!/usr/bin/env node
// Discovery selektorów dla generatora PARP. Po keeper-driven loginie i otwarciu
// wniosku do edycji, walks DOM i ekstrahuje każdy widoczny input/textarea/
// select/checkbox/radio z najbliższym labelem. Generuje candidate field_map.json
// z fuzzy-matchem nazw etykiet do nazw pól z draftu (`values.json`).
//
// Użycie:
//   FENG_WNIOSEK_URL='https://lsi.parp.gov.pl/wnioski/edit/12345' \
//     node src/trajectories/feng/dump_selectors.mjs
//
// Output:
//   .work/discovered_selectors.json   pełna lista (label, selector, type)
//   .work/proposed_field_map.json     propozycja mapowania nazw SMART do selektorów
//   .work/missing_mappings.txt        nazwy SMART bez dopasowania po fuzzy match

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { WSession } from '../../../dist/session/wsession.js';
import { humanIdlePause } from '../../../dist/human/mouse.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WORK_DIR = resolve(__dirname, '.work');
const VALUES_PATH = resolve(WORK_DIR, 'values.json');
const FIELD_MAP_PATH = resolve(__dirname, 'field_map.json');
const GENERATOR_URL = process.env.PARP_GENERATOR_URL || 'https://lsi.parp.gov.pl/';

if (!existsSync(WORK_DIR)) mkdirSync(WORK_DIR, { recursive: true });

function loadJSON(path) {
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null;
}

function normalize(s) {
  return (s || '')
    .normalize('NFD').replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function tokenize(s) {
  return normalize(s).split(/\s+/).filter(Boolean);
}

function jaccard(a, b) {
  const A = new Set(a); const B = new Set(b);
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  const uni = A.size + B.size - inter;
  return uni === 0 ? 0 : inter / uni;
}

async function isOnLoginPage(s) {
  const url = await s.page.url();
  return /\/login|\/auth|\/signin|logowanie/.test(url);
}

async function dumpFromDom(s) {
  return await s.page.evaluate(() => {
    function visible(el) {
      const r = el.getBoundingClientRect();
      const st = window.getComputedStyle(el);
      return r.width > 0 && r.height > 0 && st.visibility !== 'hidden' && st.display !== 'none';
    }
    function pickSelector(el) {
      const id = el.id;
      const cy = el.getAttribute('data-cy');
      const testId = el.getAttribute('data-test-id');
      const name = el.name;
      const aria = el.getAttribute('aria-label');
      if (id) return '#' + CSS.escape(id);
      if (cy) return `[data-cy="${cy}"]`;
      if (testId) return `[data-test-id="${testId}"]`;
      if (name) return `${el.tagName.toLowerCase()}[name="${name}"]`;
      if (aria) return `[aria-label="${aria}"]`;
      return null;
    }
    function pickLabel(el) {
      const explicit = el.id ? document.querySelector(`label[for="${CSS.escape(el.id)}"]`) : null;
      if (explicit?.textContent?.trim()) return explicit.textContent.trim();
      const aria = el.getAttribute('aria-label');
      if (aria) return aria;
      const labelledBy = el.getAttribute('aria-labelledby');
      const labelledNode = labelledBy ? document.getElementById(labelledBy) : null;
      if (labelledNode?.textContent?.trim()) return labelledNode.textContent.trim();
      const ancestorLabel = el.closest('label');
      if (ancestorLabel?.textContent?.trim()) return ancestorLabel.textContent.trim();
      const formGroup = el.closest('[class*="form-group"], [class*="field"], [class*="form-item"]');
      const groupLabel = formGroup?.querySelector('label, .label, .field-label, [class*="label"]');
      if (groupLabel?.textContent?.trim()) return groupLabel.textContent.trim();
      return '';
    }
    const out = [];
    const nodes = document.querySelectorAll('input, textarea, select');
    for (const el of nodes) {
      if (!visible(el)) continue;
      const type = (el.tagName === 'TEXTAREA') ? 'textarea'
                 : (el.tagName === 'SELECT') ? 'select'
                 : (el.type === 'checkbox') ? 'checkbox'
                 : (el.type === 'radio') ? 'radio'
                 : 'text';
      const selector = pickSelector(el);
      if (!selector) continue;
      out.push({
        label: pickLabel(el).slice(0, 200),
        selector,
        type,
        maxLength: el.maxLength > 0 ? el.maxLength : null,
        placeholder: el.placeholder || null,
      });
    }
    return out;
  });
}

function fuzzyMatch(values, discovered) {
  const matched = {};
  const missing = [];
  const valueNames = Object.keys(values).sort();
  const discIndex = discovered.map((d) => ({ ...d, tokens: tokenize(d.label) }));
  for (const name of valueNames) {
    const nameTokens = tokenize(name.replace(/^SMART\s+/, '').replace(/[A-Z]\d+/g, ''));
    let best = null;
    let bestScore = 0;
    for (const d of discIndex) {
      const score = jaccard(nameTokens, d.tokens);
      if (score > bestScore) { bestScore = score; best = d; }
    }
    if (best && bestScore >= 0.3) {
      matched[name] = {
        selector: best.selector,
        type: best.type,
        note: `discovered (jaccard=${bestScore.toFixed(2)}, label="${best.label.slice(0, 80)}")`,
      };
    } else {
      missing.push(`${name}\t${bestScore.toFixed(2)}\t${best?.label?.slice(0, 60) || '(no match)'}`);
    }
  }
  return { matched, missing };
}

async function main() {
  const values = loadJSON(VALUES_PATH);
  if (!values) {
    console.error(`FAIL: brak ${VALUES_PATH}. Najpierw uruchom: node parse_drafts.mjs > .work/values.json`);
    process.exitCode = 1;
    return;
  }

  const operatorCdp = Boolean(process.env.WELES_OPERATOR_CDP_URL);
  const s = await WSession.start({
    label: 'feng_dump_selectors',
    proxy: process.env.PROXY_URL,
    operatorCdp,
  });
  if (operatorCdp) console.log('[feng] podłączony przez uwierzytelnioną bramę operatora CDP');

  console.log(`[feng] otwieram generator: ${GENERATOR_URL}`);
  await s.goto(GENERATOR_URL);

  console.log('[feng] CZEKAM na keeper-driven login i nawigację do edycji wniosku.');
  console.log('[feng] Sprawdzam co 5 sekund czy URL nie jest na login.');
  for (let i = 0; i < 240; i++) {
    if (!(await isOnLoginPage(s))) break;
    await s.wait(5);
  }
  if (await isOnLoginPage(s)) {
    console.error('FAIL: wciąż na login. Przerwałem.');
    process.exitCode = 1;
    await s.close();
    return;
  }

  if (process.env.FENG_WNIOSEK_URL) {
    console.log(`[feng] nawiguję do wniosku: ${process.env.FENG_WNIOSEK_URL}`);
    await s.goto(process.env.FENG_WNIOSEK_URL);
    await humanIdlePause('deliberate');
  }

  console.log('[feng] Walks DOM, ekstrahuję wszystkie widoczne inputy.');
  const discovered = await dumpFromDom(s);
  console.log(`[feng] Znaleziono ${discovered.length} pól na aktualnej stronie.`);

  writeFileSync(resolve(WORK_DIR, 'discovered_selectors.json'),
    JSON.stringify(discovered, null, 2));

  const { matched, missing } = fuzzyMatch(values, discovered);
  console.log(`[feng] Fuzzy match: ${Object.keys(matched).length} dopasowań, ${missing.length} bez dopasowania.`);

  const existing = loadJSON(FIELD_MAP_PATH) || {};
  const merged = { ...existing };
  for (const [name, spec] of Object.entries(matched)) {
    if (existing[name]?.selector && !existing[name].selector.startsWith('TODO')) continue;
    merged[name] = { ...existing[name], ...spec };
  }
  writeFileSync(resolve(WORK_DIR, 'proposed_field_map.json'),
    JSON.stringify(merged, null, 2));

  writeFileSync(resolve(WORK_DIR, 'missing_mappings.txt'),
    'SMART NAME\tBEST SCORE\tBEST LABEL\n' + missing.join('\n') + '\n');

  console.log('[feng] Output:');
  console.log(`  ${resolve(WORK_DIR, 'discovered_selectors.json')}`);
  console.log(`  ${resolve(WORK_DIR, 'proposed_field_map.json')}`);
  console.log(`  ${resolve(WORK_DIR, 'missing_mappings.txt')}`);
  console.log('[feng] Sesja zostaje otwarta na nawigację do innej sekcji wniosku.');
  console.log('[feng] Re-run trajektorii żeby zebrać kolejne pola.');
  await s.wait(1800);
  await s.close();
}

main().catch((e) => {
  console.error('FAIL:', e);
  process.exitCode = 1;
});
