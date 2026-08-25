/**
 * LinkedIn cookie refresh via direct fetch — bypasses browser (and PerimeterX
 * client-side JS challenge). POSTs to /checkpoint/lg/login-submit with stored
 * cookies + credentials. If LinkedIn accepts without px_token, returns li_at.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { runRecordingsDir } from '../../../../dist/session/run-recordings.js';
import { readAccount, updateAccountMetadata } from '../../_shared/skarbiec_accounts.mjs';

const ACCOUNT_ITEM = process.env.WELES_LOGIN_ITEM || process.env.ACCOUNT_ITEM;
if (!ACCOUNT_ITEM) { console.log('FAIL: WELES_LOGIN_ITEM required'); process.exit(1); }

function writeBan(signal, details) {
  try {
    const dir = runRecordingsDir('linkedin_cookie_refresh');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'ban_signal.json'), JSON.stringify({ account_item: ACCOUNT_ITEM, action: 'linkedin_cookie_refresh', signal, healthy: signal === 'healthy', details: details ?? {}, ts: new Date().toISOString() }, null, 2));
  } catch {}
}

const acct = readAccount(ACCOUNT_ITEM);
if (!acct?.username) { writeBan('account_not_found', {}); console.log('FAIL: account not found'); process.exit(1); }
const meta = acct.metadata ?? {};
const email = meta.email ?? acct.username;
const password = acct.password ?? '';
const storedCookies = (meta.cookies ?? []).filter(c => /\.linkedin\.com|\.www\.linkedin\.com/.test(c.domain ?? ''));
if (!password) { writeBan('no_password', {}); console.log('FAIL: no stored password'); process.exit(1); }

const cookieHeader = storedCookies.map(c => `${c.name}=${c.value}`).join('; ');
console.log(`[refresh] account=${acct.username} email=${email} stored_cookies=${storedCookies.length}`);

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36';
const loginPage = await fetch('https://www.linkedin.com/uas/login', {
  headers: { 'User-Agent': UA, 'Accept': 'text/html', Cookie: cookieHeader },
});
const setCookieRaw = loginPage.headers.getSetCookie?.() ?? [];
const setCookieMap = new Map(storedCookies.map(c => [c.name, c.value]));
for (const sc of setCookieRaw) { const m = sc.match(/^([^=]+)=([^;]+)/); if (m) setCookieMap.set(m[1], m[2]); }
const fullCookieHeader = [...setCookieMap.entries()].map(([n, v]) => `${n}=${v}`).join('; ');
const html = await loginPage.text();
const csrfMatch = html.match(/name="loginCsrfParam"\s+value="([^"]+)"/);
const csrf = csrfMatch?.[1] ?? '';
console.log(`[refresh] login_page status=${loginPage.status} csrf=${csrf.slice(0, 16)} cookies=${setCookieMap.size}`);
if (!csrf) { writeBan('no_csrf', { status: loginPage.status, body_excerpt: html.slice(0, 200) }); console.log('FAIL: no CSRF token'); process.exit(1); }

const formBody = new URLSearchParams({
  session_key: email, session_password: password,
  loginCsrfParam: csrf,
  trk: 'guest_homepage-basic_sign-in-submit',
  fp_data: 'default',
});
const submit = await fetch('https://www.linkedin.com/checkpoint/lg/login-submit', {
  method: 'POST',
  headers: { 'User-Agent': UA, 'Accept': 'text/html', 'Content-Type': 'application/x-www-form-urlencoded', 'Origin': 'https://www.linkedin.com', 'Referer': 'https://www.linkedin.com/uas/login', Cookie: fullCookieHeader },
  body: formBody.toString(), redirect: 'manual',
});
const submitCookies = submit.headers.getSetCookie?.() ?? [];
const liAt = submitCookies.find(c => c.startsWith('li_at='))?.match(/^li_at=([^;]+)/)?.[1] ?? '';
const location = submit.headers.get('location') ?? '';
console.log(`[refresh] submit status=${submit.status} location=${location} li_at=${liAt ? liAt.slice(0, 16) + '...' : 'none'}`);

if (liAt) {
  for (const sc of submitCookies) { const m = sc.match(/^([^=]+)=([^;]+)/); if (m) setCookieMap.set(m[1], m[2]); }
  const newCookies = [...setCookieMap.entries()].map(([name, value]) => ({ name, value, domain: '.www.linkedin.com', path: '/', secure: true, httpOnly: true, sameSite: 'None' }));
  const merged = { ...meta, cookies: newCookies };
  delete merged.cookies_stale_at;
  updateAccountMetadata(ACCOUNT_ITEM, merged);
  writeBan('healthy', { status: submit.status, location, li_at_prefix: liAt.slice(0, 16) });
  console.log(`PASS: li_at refreshed for ${acct.username}`);
} else {
  const body = await submit.text().catch(() => '');
  writeBan('checkpoint', { status: submit.status, location, has_set_cookie: submitCookies.length, body_excerpt: body.slice(0, 300) });
  console.log(`FAIL: no li_at — server response status=${submit.status} location=${location}`);
  process.exit(1);
}
