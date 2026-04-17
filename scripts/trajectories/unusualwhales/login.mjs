// Log into unusualwhales.com with UW_EMAIL/UW_PASSWORD, save cookies for reuse.
// Usage: node scripts/trajectories/unusualwhales/login.mjs

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { WSession } from '../../../dist/session/wsession.js';
import { loadEnv } from './_envload.mjs';

loadEnv();

const email = process.env.UW_EMAIL;
const password = process.env.UW_PASSWORD;
if (!email || !password) {
  console.error('FAIL: UW_EMAIL and UW_PASSWORD must be set in weles/.env');
  process.exit(1);
}

const COOKIE_PATH = path.join(os.homedir(), '.weles', 'uw_cookies.json');
const LOGIN_URL = 'https://unusualwhales.com/login';

const proxyUrl = process.env.PROXY_URL || 'residential';
const s = await WSession.start({ label: 'uw_login', proxy: proxyUrl });

try {
  console.log('[uw_login] navigating to login page');
  await s.goto(LOGIN_URL);

  // Wait for ANY input to appear (UW may use non-standard selectors)
  let formReady = false;
  for (let i = 0; i < 30; i++) {
    const inputCount = await s.page.evaluate('document.querySelectorAll("input").length').catch(() => 0);
    if (inputCount >= 2) { formReady = true; console.log(`[uw_login] ${inputCount} inputs found after ${i + 1}s`); break; }
    await s.wait(1);
  }
  if (!formReady) {
    // Diagnostic dump
    const diag = await s.page.evaluate(`(() => ({
      url: location.href,
      title: document.title,
      bodyText: (document.body?.innerText || '').slice(0, 500),
      inputCount: document.querySelectorAll('input').length,
      buttonCount: document.querySelectorAll('button').length,
      hasForm: !!document.querySelector('form'),
      readyState: document.readyState,
    }))()`).catch((e) => ({ err: e.message }));
    console.error(`FAIL: login form never mounted. diag=${JSON.stringify(diag)}`);
    await s.page.screenshot({ path: '/tmp/uw_login_fail.png' }).catch(() => {});
    console.error('[uw_login] screenshot saved to /tmp/uw_login_fail.png');
    process.exit(1);
  }

  const inputs = await s.page.evaluate(`(() => Array.from(document.querySelectorAll('input')).map((i, idx) => ({ idx, name: i.name, type: i.type, id: i.id, ph: i.placeholder })))()`);
  console.log(`[uw_login] inputs: ${JSON.stringify(inputs)}`);

  const emailInput = inputs.find(i =>
    i.type === 'email' ||
    i.name === 'email' ||
    (i.ph || '').toLowerCase().includes('email') ||
    (i.ph || '').toLowerCase().includes('address') ||
    /email|username|login/i.test(i.id || ''),
  );
  const passInput = inputs.find(i =>
    i.type === 'password' ||
    i.name === 'password' ||
    (i.ph || '').toLowerCase().includes('password'),
  );
  if (!emailInput || !passInput) {
    console.error(`FAIL: could not identify inputs: ${JSON.stringify(inputs)}`);
    process.exit(1);
  }

  // Prefer name > id > placeholder > nth-of-type position
  const buildSel = (i) => {
    if (i.name) return `input[name="${i.name}"]`;
    if (i.id) return `input[id="${i.id}"]`;
    if (i.ph) return `input[placeholder="${i.ph}"]`;
    return `input:nth-of-type(${i.idx + 1})`;
  };
  const emailSel = buildSel(emailInput);
  const passSel = buildSel(passInput);
  console.log(`[uw_login] selectors: email=${emailSel} pass=${passSel}`);

  const fillField = (sel, val) => s.page.evaluate(`(({ sel, val }) => {
    const el = document.querySelector(sel);
    if (!el) return { ok: false, reason: 'not-found' };
    el.focus();
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(el, val);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return { ok: true };
  })(${JSON.stringify({ sel, val })})`);

  console.log(`[uw_login] filling email (${emailSel})`);
  await fillField(emailSel, email);
  await s.wait(1);
  console.log(`[uw_login] filling password`);
  await fillField(passSel, password);
  await s.wait(1);

  const submitted = await s.page.evaluate(`(() => {
    const btn = document.querySelector('button[type="submit"], input[type="submit"]');
    if (btn) { btn.click(); return { clicked: true, text: btn.innerText || btn.value }; }
    const form = document.querySelector('form');
    if (form) { form.requestSubmit?.(); return { clicked: 'form' }; }
    return { clicked: false };
  })()`);
  console.log(`[uw_login] submit: ${JSON.stringify(submitted)}`);

  let finalUrl = '';
  for (let i = 0; i < 30; i++) {
    await s.wait(2);
    finalUrl = s.page.url();
    if (!finalUrl.includes('/login')) break;
    const err = await s.page.evaluate(`(() => document.querySelector('[class*="error" i], [role="alert"]')?.innerText || null)()`).catch(() => null);
    if (err) console.log(`[uw_login] error banner: ${err.slice(0, 200)}`);
  }
  console.log(`[uw_login] final URL: ${finalUrl}`);

  if (finalUrl.includes('/login')) {
    console.error('FAIL: still on login page');
    process.exit(1);
  }

  const cookies = await s.ctx.cookies();
  fs.mkdirSync(path.dirname(COOKIE_PATH), { recursive: true });
  fs.writeFileSync(COOKIE_PATH, JSON.stringify(cookies, null, 2));
  console.log(`[uw_login] saved ${cookies.length} cookies to ${COOKIE_PATH}`);
  console.log('PASS');
} catch (e) {
  console.error(`FAIL: ${e.message}`);
  process.exit(1);
} finally {
  await s.close().catch(() => {});
}
