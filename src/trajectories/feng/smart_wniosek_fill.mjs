#!/usr/bin/env node
import { urlMatching } from '../_shared/page/settled.mjs';
import { closeOperatorRequest, openOperatorRequest } from '#operator-request';
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
//   FENG_VALUES=./build/values.json FENG_FIELD_MAP=./field_map.json \
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
import { humanClickLocator } from '../../../dist/human/mouse.js';

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

function isLoginUrl(url) {
  return /\/login|\/auth|\/signin/.test(new URL(url).pathname);
}

async function operatorAction(s, kind, instruction, observe, detail) {
  const request = openOperatorRequest({
    kind,
    account: `PARP browser session ${s.label} (process ${process.pid}; identity selected in the browser)`,
    run: s.label,
    instruction,
  });
  console.log(`[feng] prośba operatora: ${request.id}; powiadomienie przyjęte: ${request.pages.some((attempt) => attempt.ok)}`);
  try {
    await observe();
  } catch (error) {
    closeOperatorRequest(request.id, false, `The browser stage failed: ${String(error?.message || error)}`);
    throw error;
  }
  closeOperatorRequest(request.id, true, detail);
}

async function reviewPageClosed(page) {
  if (page.isClosed()) throw new Error('FENG_REVIEW_PAGE_CLOSED: the page closed before review began');
  const { promise, resolve, reject } = Promise.withResolvers();
  const onCrash = () => reject(new Error('FENG_REVIEW_PAGE_CRASHED: the review page crashed'));
  page.on('close', resolve);
  page.on('crash', onCrash);
  try {
    await promise;
  } finally {
    page.off('close', resolve);
    page.off('crash', onCrash);
  }
}

async function fillTextLike(s, selector, value) {
  const locator = s.page.locator(selector).first();
  await locator.waitFor({ state: 'visible' });
  await humanFill(s, locator, value);
}

async function fillSelect(s, selector, option) {
  const trigger = s.page.locator(selector).first();
  await trigger.waitFor({ state: 'visible' });
  await humanClickLocator(s, trigger);
  const opt = s.page.locator(`${selector} option`, { hasText: option }).first();
  await opt.waitFor({ state: 'visible' });
  await humanClickLocator(s, opt);
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
    summary.errors.push({ name, error: (e.message || '') });
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
  try {
    if (operatorCdp) console.log('[feng] podłączony przez uwierzytelnioną bramę operatora CDP');
    console.log(`[feng] otwieram generator: ${GENERATOR_URL}`);
    await s.goto(GENERATOR_URL);

    if (isLoginUrl(await currentUrl(s))) {
      await operatorAction(s, 'feng-portal-login',
        'Zaloguj się do generatora PARP i wykonaj wymagane 2FA w tej sesji Weles. Automat wznowi pracę, gdy strona opuści ścieżkę logowania.',
        () => urlMatching(s.page, (url) => !isLoginUrl(url)),
        'The browser left its login route; this observation does not independently verify the signed-in account.');
    }
    console.log(`[feng] aktualna strona po etapie logowania: ${await currentUrl(s)}`);

    if (process.env.FENG_WNIOSEK_URL) {
      console.log(`[feng] nawiguję do wniosku: ${process.env.FENG_WNIOSEK_URL}`);
      await s.goto(process.env.FENG_WNIOSEK_URL);
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
      process.exitCode = 1;
      console.log('  błędy szczegółowo:');
      for (const e of summary.errors) console.log(`    ${e.name}: ${e.error}`);
    }

    await operatorAction(s, 'feng-form-review',
      'Przejrzyj pola wniosku PARP w tej sesji Weles. Gdy skończysz, zamknij stronę przeglądarki. Automat nie potwierdza zapisu na serwerze ani nie wysyła wniosku. Ctrl+C anuluje przebieg.',
      () => reviewPageClosed(s.page),
      'The review page was closed; this does not prove that the form was saved or submitted.');
  } finally {
    await s.close();
  }
}

main().catch((e) => {
  console.error('FAIL:', e);
  process.exitCode = 1;
});
