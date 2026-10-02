#!/usr/bin/env node
import { pageSettled } from '../../_shared/page/settled.mjs';
// Automatyczny login do lsi.parp.gov.pl przez reset hasła.
// Email idzie na adres konta PARP (PARP_EMAIL); link resetu czyta Skrzynka (skrzynka sync / message list).
// Po reset: zapisuje nowe hasło do ~/.weles/parp_login.json i loguje się.

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { runRecordingsDir } from '../../../../dist/session/run-recordings.js';
import { randomBytes } from 'node:crypto';

import { WSession } from '../../../../dist/session/wsession.js';
import { humanFill } from '../../../../dist/human/keyboard.js';
import { humanClickLocator, humanIdlePause } from '../../../../dist/human/mouse.js';

const EMAIL = process.env.PARP_EMAIL;
if (!EMAIL) throw new Error('set PARP_EMAIL to the PARP account address');
const STORE = join(homedir(), '.weles', 'parp_login.json');
const NEW_PASSWORD = randomBytes(16).toString('base64url').slice(0, 24) + 'Aa1!';
const RESET_SENDER = process.env.PARP_RESET_SENDER || 'lsi@parp.gov.pl';
const LOGIN_URL = 'https://lsi.parp.gov.pl/';
const SKRZYNKA = process.env.SKRZYNKA_BIN || 'skrzynka';

const RESET_TRIGGERS = ['Zapomniałem hasła', 'Nie pamiętam hasła', 'Reset hasła', 'Przypomnij hasło'];
const EMAIL_SELECTORS = ['input[type="email"]', 'input[name="email"]', 'input[id*="email" i]', 'input[placeholder*="email" i]'];
const SUBMIT_TEXTS = ['Resetuj hasło', 'Wyślij link', 'Wyślij', 'Submit'];
const PASSWORD_SELECTORS_NEW = ['input[type="password"][name*="new" i]', 'input[type="password"]:nth-of-type(1)', 'input[type="password"]'];
const PASSWORD_SELECTORS_CONFIRM = ['input[type="password"][name*="confirm" i]', 'input[type="password"]:nth-of-type(2)'];
const CONFIRM_TEXTS = ['Ustaw hasło', 'Zapisz', 'Zatwierdź', 'Potwierdź'];

function logn(msg) { console.log(`[parp_login] ${msg}`); }

async function url(s) { return await s.page.url(); }

async function screenshot(s, name) {
  const path = join(runRecordingsDir('parp_login'), `parp_${name}_${Date.now()}.png`);
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

function skrzynka(args) {
  return JSON.parse(execFileSync(SKRZYNKA, args, { encoding: 'utf8' }));
}

function resetMailbox() {
  const mailbox = skrzynka(['mailbox', 'list']).find((m) => m.email.toLowerCase() === EMAIL.toLowerCase());
  if (!mailbox) {
    throw new Error(`Skrzynka has no mailbox ${EMAIL}; import its Skarbiec item with skrzynka mailbox import`);
  }
  return mailbox.id;
}

// A reset link is one that leads back into the site being logged into, below
// its front page, in mail from the reset sender received after `requestedAt`;
// older mail and homepage or footer links never qualify.
function resetLink(body) {
  const host = new URL(LOGIN_URL).host;
  return [...body.matchAll(/https?:\/\/[^\s<>"]+/gi)].map((m) => m[0]).find((candidate) => {
    const url = new URL(candidate);
    return url.host === host && (url.pathname.length > 1 || url.search.length > 0);
  });
}

// One sync and read of the PARP mailbox in Skrzynka; Skrzynka offers no push
// or blocking read, so a reset mail that has not arrived yet is null for the
// caller to report.
function readResetLink(requestedAt) {
  const mailboxId = resetMailbox();
  skrzynka(['sync', '--mailbox', mailboxId]);
  const link = skrzynka(['message', 'list', '--mailbox', mailboxId, '--limit', '100'])
    .filter((m) => m.sender.toLowerCase().includes(RESET_SENDER.toLowerCase())
      && Date.parse(m.received_at) >= requestedAt)
    .sort((a, b) => b.received_at.localeCompare(a.received_at))
    .map((m) => resetLink(m.body_text))
    .find(Boolean);
  if (link) logn(`znalazłem link reset: ${link}...`);
  return link ?? null;
}

async function main() {
  const s = await WSession.start({ label: 'parp_login', proxy: process.env.PROXY_URL });

  logn('otwieram lsi.parp.gov.pl');
  await s.goto(LOGIN_URL);
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

  const requestedAt = Date.now();
  if (!(await clickByAnyText(s, SUBMIT_TEXTS))) {
    logn('FAIL: nie znalazłem przycisku submit');
    process.exitCode = 1;
    await s.close();
    return;
  }
  await humanIdlePause('deliberate');
  await screenshot(s, 'reset_submitted');

  logn('czytam skrzynkę PARP w Skrzynce');
  const link = readResetLink(requestedAt);
  if (!link) {
    logn(`FAIL: mail resetowy od ${RESET_SENDER} jeszcze nie dotarł do skrzynki ${EMAIL} w Skrzynce; uruchom ponownie, gdy przyjdzie (albo PARP ma captcha / blokadę resetu).`);
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

  await pageSettled(s.page);
  await s.close();
}

main().catch((e) => {
  console.error('FAIL:', e);
  process.exitCode = 1;
});
