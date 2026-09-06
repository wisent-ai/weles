#!/usr/bin/env node
// Auto-wypełnianie wniosku SMART na generatorze PARP (lsi2.parp.gov.pl)
// z draftów lokalnych Wisent Polska.
//
// Workflow:
//   1) parser draftów (parse_drafts.mjs) ekstrahuje JSON {name: {value, length}}
//   2) field_map.json mapuje name na selektor CSS w generatorze PARP
//   3) trajektoria otwiera generator, czeka na keeper-driven login (2FA),
//      iteruje po wartościach, wpisuje humanType dla każdego mapowanego pola.
//
// Uruchomienie:
//   FENG_VALUES=/tmp/values.json FENG_FIELD_MAP=./field_map.json \
//     node smart_wniosek_fill.mjs
//
// Bez env: domyślne ścieżki względem tego pliku (parser i field_map.json
// w tym samym katalogu, values regenerowany na lecie z parse_drafts.mjs).

import { readFileSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { WSession } from '../../../dist/session/wsession.js';
import { humanFill } from '../../../dist/human/keyboard.js';
import { humanClickLocator, humanIdlePause } from '../../../dist/human/mouse.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
// Polski LSI dla SMART (PARP) działa na lsi.parp.gov.pl (Generator Wniosków FENG 2021–2027).
// Konsorcja NCBR są na lsi2.ncbr.gov.pl/logowanie. Dla osobnego naboru SMART
// dla MŚP używa się lsi-fn.parp.gov.pl. Generator jest aplikacją Vue/React,
// więc DOM ujawnia się dopiero po hydration — selektory trzeba odzyskać
// z otwartej przeglądarki, nie z raw HTML.
const GENERATOR_URL = process.env.PARP_GENERATOR_URL || 'https://lsi.parp.gov.pl/';
const FIELD_MAP_PATH = process.env.FENG_FIELD_MAP || resolve(__dirname, 'field_map.json');
const VALUES_PATH = process.env.FENG_VALUES || null;

function loadValues() {
  if (VALUES_PATH && existsSync(VALUES_PATH)) {
    return JSON.parse(readFileSync(VALUES_PATH, 'utf8'));
  }
  const parser = resolve(__dirname, 'parse_drafts.mjs');
  const out = execSync(`node ${JSON.stringify(parser)}`, { encoding: 'utf8' });
  return JSON.parse(out);
}

function loadFieldMap() {
  if (!existsSync(FIELD_MAP_PATH)) {
    throw new Error(`field_map.json nie znaleziony pod ${FIELD_MAP_PATH}`);
  }
  return JSON.parse(readFileSync(FIELD_MAP_PATH, 'utf8'));
}

async function currentUrl(s) {
  return await s.page.url();
}

async function isOnLoginPage(s) {
  const url = await currentUrl(s);
  return /\/login|\/auth|\/signin/.test(url);
}

async function fillTextLike(s, selector, value) {
  const locator = s.page.locator(selector).first();
  await locator.waitFor({ state: 'visible' });
  await humanFill(s, locator, value);
  await humanIdlePause('short');
}

async function fillSelect(s, selector, option) {
  const trigger = s.page.locator(selector).first();
  await trigger.waitFor({ state: 'visible' });
  await humanClickLocator(s, trigger);
  await humanIdlePause('short');
  const opt = s.page.locator(`${selector} option`, { hasText: option }).first();
  await opt.waitFor({ state: 'visible' });
  await humanClickLocator(s, opt);
  await humanIdlePause('short');
}

async function fillCheckbox(s, selector, want) {
  const locator = s.page.locator(selector).first();
  await locator.waitFor({ state: 'visible' });
  const checked = await locator.isChecked();
  if (checked !== want) await humanClickLocator(s, locator);
}

async function fillRadio(s, selector, optionValue) {
  const radioSel = `${selector}[value="${optionValue}"]`;
  const locator = s.page.locator(radioSel).first();
  await locator.waitFor({ state: 'visible' });
  await humanClickLocator(s, locator);
  await humanIdlePause('short');
}

async function applyField(s, name, spec, payload, summary) {
  const sel = spec.selector;
  if (!sel || sel.startsWith('TODO')) {
    summary.skipped.push({ name, reason: 'no selector' });
    return;
  }
  try {
    if (spec.type === 'text' || spec.type === 'textarea') {
      await fillTextLike(s, sel, payload.value);
    } else if (spec.type === 'select') {
      await fillSelect(s, sel, spec.option || payload.value);
    } else if (spec.type === 'checkbox') {
      const want = payload.value.trim().toUpperCase() === 'TAK';
      await fillCheckbox(s, sel, want);
    } else if (spec.type === 'radio') {
      await fillRadio(s, sel, spec.option || payload.value);
    } else {
      summary.skipped.push({ name, reason: `unknown type ${spec.type}` });
      return;
    }
    summary.filled.push({ name, length: payload.length });
  } catch (e) {
    summary.errors.push({ name, error: (e.message || '').slice(0, 200) });
  }
}

async function main() {
  const values = loadValues();
  const fieldMap = loadFieldMap();
  console.log(`[feng] ${Object.keys(values).length} wartości w drafcie, ${Object.keys(fieldMap).length} mapowań w field_map`);

  const operatorCdp = Boolean(process.env.WELES_OPERATOR_CDP_URL);
  const s = await WSession.start({
    label: 'feng_smart_wniosek_fill',
    proxy: process.env.PROXY_URL,
    operatorCdp,
  });
  if (operatorCdp) console.log('[feng] podłączony przez uwierzytelnioną bramę operatora CDP');

  console.log(`[feng] otwieram generator: ${GENERATOR_URL}`);
  await s.goto(GENERATOR_URL);

  console.log('[feng] CZEKAM NA RĘCZNE ZALOGOWANIE w keeperze (PARP wymaga 2FA SMS).');
  console.log('[feng] Otwórz osobne CDP-attached okno na tę WSession i przejdź przez login + 2FA.');
  console.log('[feng] Trajektoria sprawdza co 5s czy URL nie jest już na /login.');
  for (let i = 0; i < 240; i++) {
    if (!(await isOnLoginPage(s))) break;
    await s.wait(5);
  }
  if (await isOnLoginPage(s)) {
    console.error('FAIL: po 20 minutach wciąż na stronie loginu. Przerwałem.');
    process.exitCode = 1;
    await s.close();
    return;
  }
  console.log(`[feng] zalogowany, URL: ${await currentUrl(s)}`);

  if (process.env.FENG_WNIOSEK_URL) {
    console.log(`[feng] nawiguję do wniosku: ${process.env.FENG_WNIOSEK_URL}`);
    await s.goto(process.env.FENG_WNIOSEK_URL);
    await humanIdlePause('deliberate');
  } else {
    console.log('[feng] FENG_WNIOSEK_URL nie ustawione — używam aktualnego URL.');
    console.log('[feng] Otwórz w keeperze wniosek do edycji, dopisz URL do envu i uruchom ponownie jeśli trzeba.');
  }

  const summary = { filled: [], skipped: [], errors: [], missing_map: [] };

  for (const [name, payload] of Object.entries(values)) {
    const spec = fieldMap[name];
    if (!spec) {
      summary.missing_map.push(name);
      continue;
    }
    console.log(`[feng] -> ${name} (${spec.type}, ${payload.length} znaków)`);
    await applyField(s, name, spec, payload, summary);
  }

  console.log('\n[feng] PODSUMOWANIE');
  console.log(`  wypełnione:  ${summary.filled.length}`);
  console.log(`  pominięte:   ${summary.skipped.length}`);
  console.log(`  błędy:       ${summary.errors.length}`);
  console.log(`  brak mapowania (do dopisania w field_map.json): ${summary.missing_map.length}`);
  if (summary.missing_map.length > 0) {
    console.log('  pierwsze 20 nazw bez mapowania:');
    for (const n of summary.missing_map.slice(0, 20)) console.log(`    ${n}`);
  }
  if (summary.errors.length > 0) {
    console.log('  błędy szczegółowo:');
    for (const e of summary.errors) console.log(`    ${e.name}: ${e.error}`);
  }
  console.log('\n[feng] Sesja zostaje otwarta na 1h żebyś mógł przejrzeć wypełnione pola i ręcznie poprawić.');
  console.log('[feng] Ctrl+C kończy sesję.');
  await s.wait(3600);
  await s.close();
}

main().catch((e) => {
  console.error('FAIL:', e);
  process.exitCode = 1;
});
