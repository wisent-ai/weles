#!/usr/bin/env node
// Automatyczny login do lsi.parp.gov.pl przez reset hasła.
// Email idzie na lukasz.bartoszcze@wisent.ai (Gmail OAuth dostępne).
// Po reset: zapisuje nowe hasło do ~/.weles/parp_login.json i loguje się.

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { randomBytes } from 'node:crypto';

import { WSession } from '../../../../dist/session/wsession.js';
import { humanFill } from '../../../../dist/human/keyboard.js';
import { humanClickLocator, humanIdlePause } from '../../../../dist/human/mouse.js';

const EMAIL = process.env.PARP_EMAIL || 'lukasz.bartoszcze@wisent.ai';
const STORE = join(homedir(), '.weles', 'parp_login.json');
const NEW_PASSWORD = randomBytes(16).toString('base64url').slice(0, 24) + 'Aa1!';
const GMAIL_QUERY = process.env.PARP_GMAIL_QUERY || 'from:lsi@parp.gov.pl subject:hasło';
const DRIVE_DIR = '/Users/lukaszbartoszcze/Documents/CodingProjects/Wisent/growth-tactics/google_drive';
const PY = '/Library/Frameworks/Python.framework/Versions/3.12/bin/python3.12';

const RESET_TRIGGERS = ['Zapomniałem hasła', 'Nie pamiętam hasła', 'Reset hasła', 'Przypomnij hasło'];
const EMAIL_SELECTORS = ['input[type="email"]', 'input[name="email"]', 'input[id*="email" i]', 'input[placeholder*="email" i]'];
const SUBMIT_TEXTS = ['Resetuj hasło', 'Wyślij link', 'Wyślij', 'Submit'];
const PASSWORD_SELECTORS_NEW = ['input[type="password"][name*="new" i]', 'input[type="password"]:nth-of-type(1)', 'input[type="password"]'];
const PASSWORD_SELECTORS_CONFIRM = ['input[type="password"][name*="confirm" i]', 'input[type="password"]:nth-of-type(2)'];
const CONFIRM_TEXTS = ['Ustaw hasło', 'Zapisz', 'Zatwierdź', 'Potwierdź'];

function logn(msg) { console.log(`[parp_login] ${msg}`); }

async function url(s) { return await s.page.url(); }

async function screenshot(s, name) {
  const dir = '/Users/lukaszbartoszcze/Documents/CodingProjects/Wisent/weles/scripts/trajectories/feng/.work';
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const path = join(dir, `parp_${name}_${Date.now()}.png`);
  await s.page.screenshot({ path, fullPage: true });
  logn(`screenshot: ${path}`);
  return path;
}

async function clickByAnyText(s, texts) {
  for (const text of texts) {
    const locator = s.page.getByText(text, { exact: false }).first();
    if ((await locator.count()) > 0) {
      logn(`klikam: "${text}"`);
      await humanClickLocator(s, locator);
      return true;
    }
  }
  return false;
}

async function fillByAnySelector(s, selectors, value) {
  for (const sel of selectors) {
    const locator = s.page.locator(sel).first();
    if ((await locator.count()) > 0) {
      logn(`fill: ${sel}`);
      await humanFill(s, locator, value);
      return true;
    }
  }
  return false;
}

function pollGmailForResetLink(maxIterations) {
  for (let i = 0; i < maxIterations; i++) {
    try {
      const list = execSync(`cd ${JSON.stringify(DRIVE_DIR)} && ${PY} search_drive.py gmail-search ${JSON.stringify(GMAIL_QUERY)} 2>&1`, { encoding: 'utf8' });
      const firstId = list.split('\n').find(l => l.match(/^[0-9a-f]{16}\s+\|/))?.split(' ')[0];
      if (firstId) {
        const body = execSync(`cd ${JSON.stringify(DRIVE_DIR)} && ${PY} search_drive.py gmail-read ${firstId} 2>&1`, { encoding: 'utf8' });
        const m = body.match(/https?:\/\/[^\s<>"]+(?:reset|password|hasło|token)[^\s<>"]*/i);
        if (m) {
          logn(`znalazłem link reset: ${m[0].slice(0, 80)}...`);
          return m[0];
        }
      }
    } catch (e) {
      logn(`gmail poll error: ${(e.message || '').slice(0, 100)}`);
    }
    execSync('sleep 10');
  }
  return null;
}

async function main() {
  const s = await WSession.start({ label: 'parp_login', proxy: process.env.PROXY_URL });

  logn('otwieram lsi.parp.gov.pl');
  await s.goto('https://lsi.parp.gov.pl/');
  await humanIdlePause('deliberate');
  await screenshot(s, 'login_page');

  logn('klikam link reset hasła');
  if (!(await clickByAnyText(s, RESET_TRIGGERS))) {
    logn('FAIL: nie znalazłem linka reset hasła');
    process.exitCode = 1;
    await s.close();
    return;
  }
  await humanIdlePause('deliberate');
  await screenshot(s, 'reset_form');

  logn(`wpisuję email: ${EMAIL}`);
  if (!(await fillByAnySelector(s, EMAIL_SELECTORS, EMAIL))) {
    logn('FAIL: nie znalazłem pola email');
    process.exitCode = 1;
    await s.close();
    return;
  }
  await humanIdlePause('short');

  if (!(await clickByAnyText(s, SUBMIT_TEXTS))) {
    logn('FAIL: nie znalazłem przycisku submit');
    process.exitCode = 1;
    await s.close();
    return;
  }
  await humanIdlePause('deliberate');
  await screenshot(s, 'reset_submitted');

  logn('poll Gmail na link reset');
  const link = pollGmailForResetLink(30);
  if (!link) {
    logn('FAIL: nie dostałem maila resetowego. Może PARP ma captcha, blokadę reset, albo email idzie indziej.');
    process.exitCode = 1;
    await s.close();
    return;
  }

  logn(`navigates do reset URL`);
  await s.goto(link);
  await humanIdlePause('deliberate');
  await screenshot(s, 'reset_link_opened');

  logn(`wpisuję nowe hasło (zapisuję do ${STORE})`);
  if (!existsSync(STORE.replace(/\/[^/]+$/, ''))) {
    mkdirSync(STORE.replace(/\/[^/]+$/, ''), { recursive: true });
  }
  writeFileSync(STORE, JSON.stringify({ email: EMAIL, password: NEW_PASSWORD, createdAt: new Date().toISOString() }, null, 2));

  if (!(await fillByAnySelector(s, PASSWORD_SELECTORS_NEW, NEW_PASSWORD))) {
    logn('FAIL: nie znalazłem pola nowe hasło');
    process.exitCode = 1;
    await s.close();
    return;
  }
  const confirmFilled = await fillByAnySelector(s, PASSWORD_SELECTORS_CONFIRM, NEW_PASSWORD);
  logn(`pola hasła wypełnione (confirm: ${confirmFilled})`);
  await humanIdlePause('short');

  await clickByAnyText(s, CONFIRM_TEXTS);
  await humanIdlePause('deliberate');
  await screenshot(s, 'after_password_set');

  logn(`final URL po reset: ${await url(s)}`);
  logn(`OK: hasło zapisane do ${STORE}`);

  await s.wait(1800);
  await s.close();
}

main().catch((e) => {
  console.error('FAIL:', e);
  process.exitCode = 1;
});
