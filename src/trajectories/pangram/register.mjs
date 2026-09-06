// Pangram registration/login bootstrap for authenticated audits.
// DIAG=1 only dumps visible controls; normal mode creates and persists an account.

import { randomBytes } from 'node:crypto';
import { WSession } from '../../../dist/session/wsession.js';
import { humanClickLocator, humanIdlePause } from '../../../dist/human/mouse.js';
import { humanType } from '../../../dist/human/keyboard.js';
import { generatePersona } from '../../../dist/browser/persona.js';

function pickEmailDomain() {
  const domains = (process.env.PANGRAM_EMAIL_DOMAINS || 'wisentmedia.com')
    .split(',').map((s) => s.trim()).filter(Boolean);
  return domains[Math.floor(Math.random() * domains.length)];
}

function generateEmail() {
  if (process.env.PANGRAM_EMAIL) return process.env.PANGRAM_EMAIL;
  const domain = pickEmailDomain();
  const local = process.env.PANGRAM_EMAIL_LOCAL_PART || `svc.pangram.${randomBytes(4).toString('hex')}`;
  return `${local}@${domain}`;
}

function countryHintFromProxy(proxyUrl) {
  if (!proxyUrl) return undefined;
  const cc = String(proxyUrl).toLowerCase().match(/\b(us|uk|gb|br|de|fr|nl|ca|au)\b/)?.[0];
  return cc === 'uk' ? 'gb' : cc;
}

function proxyUrlFromConfig(config) {
  const auth = config.username && config.password
    ? `${encodeURIComponent(config.username)}:${encodeURIComponent(config.password)}@`
    : config.username
      ? `${encodeURIComponent(config.username)}@`
      : '';
  return `${config.protocol}://${auth}${config.host}:${config.port}`;
}

async function selectRegistrationProxy() {
  const explicit = process.env.PANGRAM_REGISTRATION_PROXY_URL;
  if (explicit) {
    const u = new URL(explicit);
    return {
      proxyUrl: explicit,
      proxyConfig: {
        host: u.hostname,
        port: Number(u.port),
        protocol: u.protocol.replace(/:$/, ''),
        username: u.username ? decodeURIComponent(u.username) : undefined,
        password: u.password ? decodeURIComponent(u.password) : undefined,
      },
    };
  }

  const { selectByCapability } = await import('../../../dist/proxy/capability.js');
  const { resolveProxy } = await import('../../../dist/proxy/config.js');
  const action = 'pangram_register';
  const targetHost = 'www.pangram.com';
  const country = process.env.PANGRAM_REGISTRATION_COUNTRY || 'us';
  const tried = [];

  for (let i = 0; i < 5; i += 1) {
    const winner = await selectByCapability(action, tried);
    if (!winner) {
      console.log(`[pangram_register] no provider passes capability for ${action}`);
      break;
    }
    const filter = `isp ${winner.provider} ${country}`.trim();
    const pw = await resolveProxy(filter, targetHost);
    if (pw?.server) {
      const u = new URL(pw.server);
      console.log(`[pangram_register] proxy=${u.hostname}:${u.port} provider=${pw.provider || winner.provider}`);
      const proxyConfig = {
        host: u.hostname,
        port: Number(u.port),
        protocol: u.protocol.replace(/:$/, ''),
        username: pw.username,
        password: pw.password,
        country: pw.country,
        provider: pw.provider || winner.provider,
      };
      return {
        proxyUrl: proxyUrlFromConfig(proxyConfig),
        proxyConfig,
      };
    }
    tried.push(winner.provider);
  }
  console.log('[pangram_register] no isp proxy available; falling back to direct egress');
  return null;
}

const RESEND_KEY = process.env.RESEND_RECEIVING_API_KEY || '';
const SIGNUP_URL = process.env.PANGRAM_SIGNUP_URL || 'https://www.pangram.com/signup';
const EMAIL = generateEmail();
const FIRST_NAME = process.env.PANGRAM_FIRST_NAME || 'Wisent';
const LAST_NAME = process.env.PANGRAM_LAST_NAME || 'Audit';
const PASSWORD = process.env.PANGRAM_PASSWORD || (() => {
  const upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const lower = 'abcdefghijkmnopqrstuvwxyz';
  const digit = '23456789';
  const special = '!@#$%&*';
  const all = upper + lower + digit + special;
  const pick = (s) => s[randomBytes(1)[0] % s.length];
  const out = [pick(upper), pick(lower), pick(digit), pick(special)];
  for (let i = 0; i < 14; i += 1) out.push(pick(all));
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = randomBytes(1)[0] % (i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out.join('');
})();

async function dismissCookies(page) {
  const btn = page.getByRole('button', { name: /allow all|accept all|akceptuj/i }).first();
  if (await btn.count() > 0 && await btn.isVisible().catch(() => false)) {
    await humanClickLocator(page, btn).catch(() => btn.click()); // allow-raw-playwright: fallback only if human click fails on consent button
    await humanIdlePause('short');
  }
}

async function dumpControls(page) {
  return page.evaluate(() => ({
    url: location.href,
    body: (document.body?.innerText || '').replace(/\s+/g, ' ').slice(0, 1500),
    inputs: Array.from(document.querySelectorAll('input, textarea')).filter((el) => el.getClientRects().length).map((el) => ({
      tag: el.tagName,
      type: el.getAttribute('type'),
      name: el.getAttribute('name'),
      placeholder: el.getAttribute('placeholder'),
      autocomplete: el.getAttribute('autocomplete'),
      valueLen: String(el.value || '').length,
    })).slice(0, 30),
    buttons: Array.from(document.querySelectorAll('button, [role="button"], a')).filter((el) => el.getClientRects().length).map((el) => ({
      tag: el.tagName,
      role: el.getAttribute('role'),
      text: (el.textContent || el.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim().slice(0, 120),
      href: el.getAttribute('href'),
      disabled: Boolean(el.disabled) || el.getAttribute('aria-disabled') === 'true',
    })).filter((x) => x.text || x.href).slice(0, 80),
  })); // allow-raw-playwright: read-only signup diagnostics
}

async function clickByText(page, pattern) {
  const loc = page.getByRole('button', { name: pattern }).first();
  if (await loc.count() > 0 && await loc.isVisible().catch(() => false)) {
    await humanClickLocator(page, loc);
    await humanIdlePause('deliberate');
    return true;
  }
  const link = page.getByRole('link', { name: pattern }).first();
  if (await link.count() > 0 && await link.isVisible().catch(() => false)) {
    await humanClickLocator(page, link);
    await humanIdlePause('deliberate');
    return true;
  }
  return false;
}

async function fillFirst(page, locators, value) {
  for (const locator of locators) {
    const loc = locator.first();
    if (await loc.count() === 0) continue;
    if (!await loc.isVisible().catch(() => false)) continue;
    await humanClickLocator(page, loc);
    await humanIdlePause('short');
    await loc.fill(''); // allow-raw-playwright: clear controlled signup field before human typing
    await humanType(page, value);
    return true;
  }
  return false;
}

async function fetchInboxRecent() {
  const r = await fetch('https://api.resend.com/emails/receiving?limit=20', { headers: { Authorization: `Bearer ${RESEND_KEY}` } });
  const j = await r.json();
  return Array.isArray(j.data) ? j.data : [];
}

async function fetchEmailBody(id) {
  const r = await fetch(`https://api.resend.com/emails/receiving/${id}`, { headers: { Authorization: `Bearer ${RESEND_KEY}` } });
  return r.json();
}

async function waitForPangramMail(email, sinceMs) {
  for (let i = 0; i < 24; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5000)); // allow-raw-playwright: bounded Resend polling
    const inbox = await fetchInboxRecent().catch(() => []);
    const hit = inbox.find((m) => {
      const to = (Array.isArray(m.to) ? m.to : []).map((t) => typeof t === 'string' ? t : t.email || '').join(',').toLowerCase();
      const from = String(m.from || '').toLowerCase();
      const subj = String(m.subject || '').toLowerCase();
      const created = m.created_at ? Date.parse(m.created_at) : 0;
      return to.includes(email.toLowerCase()) && created >= sinceMs - 60_000 && (from.includes('pangram') || subj.includes('pangram') || subj.includes('verify'));
    });
    if (!hit) continue;
    const body = await fetchEmailBody(hit.id);
    const text = `${body.subject || ''}\n${body.text || ''}\n${body.html || ''}`;
    const code = text.match(/\b\d{5,6}\b/)?.[0] || null;
    const links = [...text.matchAll(/https?:\/\/[^\s"'<>]+/g)].map((m) => m[0].replace(/&amp;/g, '&'));
    const pangramLink = links.find((u) => /pangram\.com/i.test(u)) || null;
    return { id: hit.id, subject: body.subject || hit.subject || '', code, pangramLink };
  }
  return null;
}

async function sessionStatus(page) {
  return page.evaluate(async () => {
    const res = await fetch('https://web.pangram.com/api/session-status/', { credentials: 'include' });
    return { status: res.status, body: await res.text() };
  }).catch((e) => ({ status: 0, body: String(e?.message || e) })); // allow-raw-playwright: authenticated same-origin status probe
}

async function loginWithPassword(page) {
  const emailOk = await fillFirst(page, [
    page.locator('input[type="email"]'),
    page.locator('input[name*="email" i]'),
    page.locator('input[placeholder*="email" i]'),
  ], EMAIL);
  const passwordOk = await fillFirst(page, [
    page.locator('input[type="password"]').first(),
    page.locator('input[name*="password" i]').first(),
    page.locator('input[placeholder*="password" i]').first(),
  ], PASSWORD);
  if (!emailOk || !passwordOk) return false;
  return clickByText(page, /^sign in$/i);
}

function isAuthenticatedStatus(status) {
  try {
    const parsed = JSON.parse(status.body);
    return parsed?.isAuthenticated === true;
  } catch {
    return /"isAuthenticated"\s*:\s*true/i.test(String(status.body || ''));
  }
}

const regProxy = process.env.PANGRAM_NO_PROXY === '1' ? null : await selectRegistrationProxy();
const persona = generatePersona({ country: countryHintFromProxy(regProxy?.proxyUrl), browser: 'chromium' });
console.log(`[pangram_register] email=${EMAIL} proxy=${regProxy?.proxyUrl ? 'yes' : 'direct'} domain=${EMAIL.split('@')[1]} persona_os=${persona?.userAgentOs || 'default'}`);
const s = await WSession.start({
  label: 'pangram_register',
  browser: 'chromium',
  targetHost: 'www.pangram.com',
  proxy: regProxy?.proxyUrl,
  persona,
});
const sinceMs = Date.now();

try {
  await s.goto(SIGNUP_URL);
  await humanIdlePause('long');
  await dismissCookies(s.page);

  if (process.env.DIAG === '1') {
    console.log(JSON.stringify(await dumpControls(s.page), null, 2));
    process.exit(0);
  }

  console.log(`[pangram_register] email=${EMAIL}`);
  await clickByText(s.page, /email|password|sign up with email|continue with email/i).catch(() => false);

  const emailOk = await fillFirst(s.page, [
    s.page.locator('input[type="email"]'),
    s.page.locator('input[name*="email" i]'),
    s.page.locator('input[placeholder*="email" i]'),
  ], EMAIL);
  if (!emailOk) throw new Error('email_field_not_found');

  const passwordOk = await fillFirst(s.page, [
    s.page.locator('input[type="password"]').nth(0),
    s.page.locator('input[name*="password" i]'),
    s.page.locator('input[placeholder*="password" i]'),
  ], PASSWORD);
  if (!passwordOk) throw new Error('password_field_not_found');

  const passwordFields = s.page.locator('input[type="password"]');
  if (await passwordFields.count() > 1) {
    const confirm = passwordFields.nth(1);
    if (await confirm.isVisible().catch(() => false)) {
      await humanClickLocator(s.page, confirm);
      await confirm.fill(''); // allow-raw-playwright: clear confirmation field
      await humanType(s.page, PASSWORD);
    }
  }
  await fillFirst(s.page, [
    s.page.locator('input[placeholder*="confirm" i]'),
    s.page.locator('input[name*="confirm" i]'),
  ], PASSWORD);

  await fillFirst(s.page, [
    s.page.locator('input[name*="first" i]'),
    s.page.locator('input[placeholder*="first" i]'),
  ], FIRST_NAME);
  await fillFirst(s.page, [
    s.page.locator('input[name*="last" i]'),
    s.page.locator('input[placeholder*="last" i]'),
  ], LAST_NAME);

  const termsResult = await s.page.evaluate(() => {
    const visible = (el) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    };
    const boxes = Array.from(document.querySelectorAll('input[type="checkbox"]')).filter(visible);
    for (const box of boxes) {
      const context = [
        box.closest('label')?.innerText,
        box.parentElement?.innerText,
        box.closest('div')?.innerText,
        box.closest('form')?.innerText,
      ].filter(Boolean).join(' ').toLowerCase();
      if (/terms|conditions|privacy/.test(context) && !box.checked) {
        box.click();
        return { clicked: true, context: context.slice(0, 120) };
      }
    }
    return { clicked: false, visibleCount: boxes.length };
  }); // allow-raw-playwright: click the terms checkbox selected by its adjacent terms/privacy text
  console.log(`[pangram_register] terms=${JSON.stringify(termsResult)}`);
  await humanIdlePause('short');

  const submitted = await clickByText(s.page, /sign up|create account|continue|get started|submit/i);
  if (!submitted) throw new Error('submit_button_not_found');

  await humanIdlePause('long');

  let status = await sessionStatus(s.page);
  if (!isAuthenticatedStatus(status)) {
    const mail = RESEND_KEY ? await waitForPangramMail(EMAIL, sinceMs) : null;
    console.log(`[pangram_register] mail=${mail ? JSON.stringify({ subject: mail.subject, hasCode: Boolean(mail.code), hasLink: Boolean(mail.pangramLink) }) : 'none'}`);
    if (mail?.code) {
      const codeInput = s.page.locator('input[autocomplete="one-time-code"], input[name*="code" i], input[maxlength="6"], input[maxlength="5"]').first();
      if (await codeInput.count() > 0 && await codeInput.isVisible().catch(() => false)) {
        await humanClickLocator(s.page, codeInput);
        await humanType(s.page, mail.code);
        await clickByText(s.page, /verify|continue|submit/i).catch(() => false);
        await humanIdlePause('long');
      }
    }
    if (mail?.pangramLink) {
      await s.goto(mail.pangramLink);
      await humanIdlePause('long');
    }
    status = await sessionStatus(s.page);
    if (!isAuthenticatedStatus(status)) {
      const pageText = await s.page.evaluate(() => document.body?.innerText || '').catch(() => ''); // allow-raw-playwright: read page state after verify link
      if (/log in to your account|sign in|password/i.test(pageText)) {
        const loggedIn = await loginWithPassword(s.page);
        console.log(`[pangram_register] post_verify_login=${loggedIn}`);
        await humanIdlePause('long');
        status = await sessionStatus(s.page);
      }
    }
  }

  console.log(`[pangram_register] session_status=${status.status} body=${status.body.slice(0, 300)}`);
  if (!isAuthenticatedStatus(status)) {
    throw new Error('pangram_not_authenticated_after_signup');
  }

  const result = await s.saveAccount('pangram', { username: EMAIL, email: EMAIL, password: PASSWORD, status: 'created' });
  console.log(`[pangram_register] saveAccount=${result}`);
  console.log(`PASS: pangram account ready ${EMAIL}`);
} catch (e) {
  console.log(`FAIL: ${String(e?.message || e).slice(0, 300)}`);
  process.exitCode = 1;
} finally {
  await s.close();
}
