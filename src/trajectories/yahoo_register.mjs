import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { WSession } from '../../dist/session/wsession.js';
import { humanType } from '../../dist/human/keyboard.js';
import { humanClickLocator, humanIdlePause } from '../../dist/human/mouse.js';
import { runRecordingsDir } from '../../dist/session/run-recordings.js';

const LABEL = 'yahoo_register';
const SIGNUP_URL = 'https://login.yahoo.com/account/create?specId=usernameregsimplified&done=https%3A%2F%2Ffinance.yahoo.com%2F';
const FINANCE_URL = 'https://finance.yahoo.com/';
const MAX_RETRIES = Number(process.env.YAHOO_REGISTER_RETRIES ?? 2);

function writeJson(name, value) {
  const dir = runRecordingsDir(LABEL);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), JSON.stringify(value, null, 2));
}

function monthNumber(value) {
  const months = ['january','february','march','april','may','june','july','august','september','october','november','december'];
  const lower = String(value || '').toLowerCase();
  const idx = months.indexOf(lower);
  if (idx >= 0) return String(idx + 1).padStart(2, '0');
  const n = Number(value);
  return Number.isFinite(n) ? String(Math.max(1, Math.min(12, Math.trunc(n)))).padStart(2, '0') : '01';
}

async function bodyText(page) {
  return await page.evaluate(() => document.body?.innerText || '').catch(() => '');
}

async function fillFirst(page, selectors, value) {
  for (const selector of selectors) {
    const loc = page.locator(selector).filter({ visible: true }).first();
    if (await loc.count() && await loc.isVisible({ timeout: 1500 }).catch(() => false)) {
      await humanClickLocator(page, loc);
      await humanFill(page, loc, '').catch(() => {});
      await humanType(page, value);
      return true;
    }
  }
  return false;
}

async function clickFirst(page, selectors, label) {
  for (const selector of selectors) {
    const loc = page.locator(selector).filter({ visible: true }).first();
    if (await loc.count() && await loc.isVisible({ timeout: 1500 }).catch(() => false)) {
      await humanClickLocator(page, loc);
      return true;
    }
  }
  throw new Error(`${label}_not_found`);
}

async function checkbox(page) {
  const terms = page.locator('input#checkTerms, input[name="checkTerms"], input[type="checkbox"]').filter({ visible: true }).first();
  if (await terms.count()) {
    const checked = await terms.isChecked().catch(() => false);
    if (!checked) await humanClickLocator(page, terms);
  }
}

async function submitNext(page) {
  await clickFirst(page, [
    'button[name="signup"]',
    'button[type="submit"]:has-text("Next")',
    'button:has-text("Next")',
    'button:has-text("Continue")',
    'button:has-text("Send code")',
    'button:has-text("Verify")',
  ], 'next_button');
}

async function fillSignupForm(s, id) {
  const page = s.page;
  const existingEmail = await page.locator('input#reg-email, input[name="email"]').filter({ visible: true }).first().count().catch(() => 0);
  await fillFirst(page, ['input#reg-firstName', 'input[name="firstName"]', 'input[autocomplete="given-name"]'], id.firstName) || (() => { throw new Error('first_name_input_not_found'); })();
  await fillFirst(page, ['input#reg-lastName', 'input[name="lastName"]', 'input[autocomplete="family-name"]'], id.lastName) || (() => { throw new Error('last_name_input_not_found'); })();
  if (existingEmail) {
    await fillFirst(page, ['input#reg-email', 'input[name="email"]'], id.email) || (() => { throw new Error('email_input_not_found'); })();
    await fillFirst(page, ['input#reg-birthYear', 'input[name="birthYear"]', 'input[id*="birthYear" i]'], String(id.birthYear)) || (() => { throw new Error('birth_year_input_not_found'); })();
  } else {
    await fillFirst(page, ['input#reg-userId', 'input[name="userId"]'], id.username) || (() => { throw new Error('user_id_input_not_found'); })();
    await fillFirst(page, ['input#reg-password', 'input[name="password"]', 'input[type="password"]'], id.password) || (() => { throw new Error('password_input_not_found'); })();
    await fillFirst(page, ['input[name="mm"]', 'input[id$="-mm"]', 'input[placeholder*="Month" i]'], monthNumber(id.birthMonth)) || (() => { throw new Error('birth_month_input_not_found'); })();
    await fillFirst(page, ['input[name="dd"]', 'input[id$="-dd"]', 'input[placeholder*="Day" i]'], String(id.birthDay).padStart(2, '0')) || (() => { throw new Error('birth_day_input_not_found'); })();
    await fillFirst(page, ['input[name="yyyy"]', 'input[id$="-yyyy"]', 'input[placeholder*="Year" i]'], String(id.birthYear)) || (() => { throw new Error('birth_year_input_not_found'); })();
    await checkbox(page);
  }
  await submitNext(page);
}

async function maybeHandlePhone(s) {
  const page = s.page;
  const phoneInput = page.locator('input[type="tel"], input[name*="phone" i], input[id*="phone" i]').filter({ visible: true }).first();
  if (!(await phoneInput.count()) || !(await phoneInput.isVisible({ timeout: 1500 }).catch(() => false))) return false;

  const phone = await s.checkSms('yahoo', process.env.YAHOO_SMS_COUNTRY || 'US');
  if (phone.startsWith('error')) throw new Error(`yahoo_sms_unavailable: ${phone}`);
  const digits = s.resolveEnv('$YAHOO_NEW_PHONE').replace(/^\+?1/, '').replace(/\D/g, '');
  await humanClickLocator(page, phoneInput);
  await humanFill(page, phoneInput, '').catch(() => {});
  await humanType(page, digits);
  await submitNext(page);
  await humanIdlePause('long');
  return true;
}

async function maybeHandleCode(s, id) {
  const page = s.page;
  const codeInput = page.locator('input[name*="code" i], input[id*="code" i], input[autocomplete="one-time-code"], input[type="tel"][maxlength="6"], input[type="text"][maxlength="6"]').filter({ visible: true }).first();
  if (!(await codeInput.count()) || !(await codeInput.isVisible({ timeout: 1500 }).catch(() => false))) return false;
  const text = await bodyText(page);
  let code = null;
  if (/email|e-mail|inbox|verification code/i.test(text)) {
    code = await s.checkEmail(id.email, 'yahoo');
    if (!code || /^no code|^error/i.test(code)) throw new Error(`yahoo_email_otp_failed: ${code}`);
  } else {
    code = await s.pollSmsCode();
    if (!code || /^no code|^error/i.test(code)) throw new Error(`yahoo_sms_otp_failed: ${code}`);
  }
  await humanClickLocator(page, codeInput);
  await humanFill(page, codeInput, '').catch(() => {});
  await humanType(page, code);
  await submitNext(page);
  await humanIdlePause('long');
  return true;
}

async function maybeHandlePassword(page, password) {
  const passwordInput = page.locator('input[name="password"], input[type="password"], input[id*="password" i]').filter({ visible: true }).first();
  if (!(await passwordInput.count()) || !(await passwordInput.isVisible({ timeout: 1500 }).catch(() => false))) return false;
  await humanClickLocator(page, passwordInput);
  await humanFill(page, passwordInput, '').catch(() => {});
  await humanType(page, password);
  const confirm = page.locator('input[name*="confirm" i], input[id*="confirm" i]').filter({ visible: true }).first();
  if (await confirm.count() && await confirm.isVisible({ timeout: 1000 }).catch(() => false)) {
    await humanClickLocator(page, confirm);
    await humanFill(page, confirm, '').catch(() => {});
    await humanType(page, password);
  }
  await submitNext(page);
  await humanIdlePause('long');
  return true;
}

async function maybeOpenPasswordSetup(page) {
  const text = await bodyText(page);
  if (!/Welcome to Yahoo/i.test(text) || !/password/i.test(text)) return false;
  const change = page.locator('a:has-text("Change password"), a:has-text("Create password"), button:has-text("Change password"), button:has-text("Create password")').filter({ visible: true }).first();
  if (!(await change.count()) || !(await change.isVisible({ timeout: 1500 }).catch(() => false))) return false;
  await humanClickLocator(page, change);
  await humanIdlePause('long');
  return true;
}

async function successState(s) {
  let url = s.page.url?.() ?? '';
  let text = await bodyText(s.page);
  if (/Welcome to Yahoo/i.test(text)) {
    const done = s.page.locator('button:has-text("Done")').filter({ visible: true }).first();
    if (await done.count() && await done.isVisible({ timeout: 1000 }).catch(() => false)) {
      await humanClickLocator(s.page, done);
      await humanIdlePause('long');
    }
  } else if (/login\.yahoo\.com/.test(url) && /create a yahoo account|verification code|phone|password|next/i.test(text)) {
    return { ok: false, url, accountUi: 0, sample: text.slice(0, 500) };
  }
  await s.goto(FINANCE_URL).catch(() => {});
  await humanIdlePause('deliberate');
  url = s.page.url?.() ?? '';
  text = await bodyText(s.page);
  const loggedOut = /sign in|create account|login\.yahoo/i.test(text) && /login\.yahoo\.com/.test(url);
  const accountUi = await s.page.locator('button[aria-label*="account" i], a[href*="account" i], a[href*="login.yahoo.com/account"]').count().catch(() => 0);
  return { ok: !loggedOut && (/finance\.yahoo\.com/.test(url) || accountUi > 0), url, accountUi, sample: text.slice(0, 500) };
}

for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
  const s = await WSession.start({ label: LABEL, proxy: process.env.PROXY_URL || 'none', browser: 'chromium', platform: 'yahoo', headless: process.env.YAHOO_HEADLESS === '1' });
  try {
    const id = s.identity || await s.generateIdentity('yahoo');
    const accountEmail = id.email;
    console.log(`[yahoo] attempt=${attempt}/${MAX_RETRIES} identity=${id.username} email=${accountEmail}`);

    await s.goto(SIGNUP_URL);
    await humanIdlePause('deliberate');
    await fillSignupForm(s, id);
    await humanIdlePause('long');

    for (let i = 0; i < 24; i++) {
      const text = await bodyText(s.page);
      if (/captcha|robot|verify you are human|security check/i.test(text)) {
        const solved = await s.solveCaptcha().catch((e) => `captcha err: ${e.message}`);
        console.log(`[yahoo] captcha result=${solved}`);
        await humanIdlePause('long');
      }
      if (await maybeOpenPasswordSetup(s.page)) continue;
      if (await maybeHandlePhone(s)) continue;
      if (await maybeHandleCode(s, id)) continue;
      if (await maybeHandlePassword(s.page, id.password)) continue;
      const state = await successState(s);
      if (state.ok) {
        await s.saveAccount('yahoo', {
          username: id.username,
          email: accountEmail,
          password: id.password,
          name: `${id.firstName} ${id.lastName}`,
          status: 'verified',
        });
        const payload = { ok: true, username: id.username, email: accountEmail, final_url: state.url, accountUi: state.accountUi, completed_at: new Date().toISOString() };
        writeJson('yahoo_register_result.json', payload);
        writeJson('ban_signal.json', { action: LABEL, healthy: true, signal: 'healthy', details: { final_url: state.url }, ts: new Date().toISOString() });
        console.log(`PASS: yahoo ${accountEmail}`);
        await s.close();
        process.exit(0);
      }
      await humanIdlePause('short');
    }
    const final = await successState(s);
    throw new Error(`yahoo_register_no_success final_url=${final.url} sample=${final.sample.slice(0, 160)}`);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.log(`FAIL attempt=${attempt}: ${message.slice(0, 300)}`);
    writeJson('yahoo_register_result.json', { ok: false, error: message, completed_at: new Date().toISOString() });
    writeJson('ban_signal.json', { action: LABEL, healthy: false, signal: 'register_failed', details: { error: message }, ts: new Date().toISOString() });
    await s.close().catch(() => {});
    if (attempt === MAX_RETRIES) process.exit(1);
    await humanIdlePause('deliberate');
  }
}
