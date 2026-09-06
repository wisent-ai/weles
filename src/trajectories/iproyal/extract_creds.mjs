// Extract the REAL IPRoyal residential proxy username:password from the
// Google-SSO dashboard. Root cause of the 407: IPROYAL_USERNAME/PASSWORD
// in .env are the placeholder `wisentagent01` — never the credentials the
// real SSO account (lukasz.bartoszcze@gmail.com) issues in its dashboard.
// Logs in via the same SSO path balance.mjs uses, opens the residential
// product page, dumps it for inspection, and parses the proxy
// username:password so they can be written into .env + GCP.
import { WSession } from '../../../dist/session/wsession.js';
import { googleSso, getGoogleSsoCreds } from '../_shared/services/google_sso.mjs';
import { humanIdlePause, humanClickLocator } from '../../../dist/human/mouse.js';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const LOGIN_URL = 'https://dashboard.iproyal.com/login';
const OUT = join(process.cwd(), '.work', 'iproyal_extract_creds');
mkdirSync(OUT, { recursive: true });

const login = await getGoogleSsoCreds();
if (!login) { console.log('FAIL: no Google SSO creds'); process.exit(1); }
console.log(`[extract] Using Google SSO: ${login.email}`);

const s = await WSession.start({ label: 'iproyal_extract_creds', browser: 'chromium' });
try {
  await s.goto(LOGIN_URL);
  await humanIdlePause('deliberate');

  let popup = null;
  const popupPromise = s.page.waitForEvent('popup');
  const gBtn = s.page.locator('button:has-text("Login with Google"), button:has-text("Continue with Google")').filter({ visible: true }).first();
  await humanClickLocator(s.page, gBtn);
  try {
    popup = await Promise.race([
      popupPromise,
      new Promise((_, rej) => setTimeout(() => rej(new Error('popup-timeout')), 15000)),  // allow-raw-playwright: Promise.race deadline
    ]);
  } catch (e) { console.log(`FAIL: Google login popup did not open (${e.message})`); process.exit(1); }
  await popup.waitForLoadState('domcontentloaded');

  const ok = await googleSso(s, login, { originHost: 'iproyal.com', page: popup });
  if (!ok) { console.log('FAIL: Google SSO did not complete'); process.exit(1); }

  for (let i = 0; i < 60; i++) {
    await humanIdlePause('short');
    if (!/\/login/.test(s.page.url())) break;
  }
  console.log(`[extract] post-login url=${s.page.url()}`);

  // Walk the known IPRoyal residential access pages. The dashboard shows
  // the proxy username + password (and a proxy-list / host:port) on the
  // residential product detail page. Try each, dump every page, parse.
  const CANDIDATES = [
    'https://dashboard.iproyal.com/royal-residential/access',
    'https://dashboard.iproyal.com/royal-residential',
    'https://dashboard.iproyal.com/residential/access',
    'https://dashboard.iproyal.com/residential',
    'https://dashboard.iproyal.com/proxy/residential',
    'https://dashboard.iproyal.com/',
  ];

  const found = {};
  for (const url of CANDIDATES) {
    let text = '';
    try {
      await s.page.goto(url, { waitUntil: 'domcontentloaded' });
      await humanIdlePause('long');
      const tag = url.replace(/[^a-z0-9]+/gi, '_').slice(0, 60);
      text = await s.page.evaluate(() => document.body.innerText);  // allow-raw-playwright: read-only innerText, no DOM interaction
      writeFileSync(join(OUT, `${tag}.txt`), text);
      writeFileSync(join(OUT, `${tag}.html`), await s.page.content());
      await s.page.screenshot({ path: join(OUT, `${tag}.png`), fullPage: true });
      console.log(`[extract] dumped ${url} (textlen=${text.length}, final=${s.page.url()})`);

      const fields = await s.page.evaluate(() => {  // allow-raw-playwright: read-only field/value scrape, no click/scroll/submit
        const out = {};
        for (const inp of Array.from(document.querySelectorAll('input'))) {
          const k = (inp.name || inp.id || inp.getAttribute('aria-label') || inp.placeholder || '').toLowerCase();
          const v = inp.value || '';
          if (!v) continue;
          if (/user|login/.test(k)) out.username = v;
          else if (/pass/.test(k)) out.password = v;
          else if (/host|endpoint|server/.test(k)) out.host = v;
          else if (/port/.test(k)) out.port = v;
        }
        return out;
      });
      Object.assign(found, Object.fromEntries(Object.entries(fields).filter(([, v]) => v)));

      // Common dashboard pattern: a "user:pass@host:port" connection string
      // or labelled "Username <x>" / "Password <y>" lines in body text.
      const cs = text.match(/([A-Za-z0-9._-]+):([A-Za-z0-9._-]{6,})@([a-z0-9.-]+\.[a-z]{2,}):(\d{2,5})/);
      if (cs) { found.username ??= cs[1]; found.password ??= cs[2]; found.host ??= cs[3]; found.port ??= cs[4]; }
      const um = text.match(/user(?:name)?\s*[:\n]\s*([A-Za-z0-9._-]{4,})/i);
      const pm = text.match(/pass(?:word)?\s*[:\n]\s*([A-Za-z0-9._-]{6,})/i);
      if (um) found.username ??= um[1];
      if (pm) found.password ??= pm[1];

      if (found.username && found.password) { console.log(`[extract] credentials found on ${url}`); break; }
    } catch (e) {
      console.log(`[extract] ${url} err: ${(e.message || String(e)).slice(0, 120)}`);
    }
  }

  writeFileSync(join(OUT, 'extracted.json'), JSON.stringify(found, null, 2));
  if (found.username && found.password) {
    console.log(`PASS: extracted IPRoyal creds username=${found.username} host=${found.host ?? '?'} port=${found.port ?? '?'} (password ${found.password.length} chars) -> ${OUT}/extracted.json`);
  } else {
    console.log(`FAIL: could not parse IPRoyal proxy creds — inspect dumps in ${OUT}/ (txt+html+png per candidate page)`);
    process.exit(1);
  }
} catch (e) {
  console.log('FAIL:', (e.message || String(e)).slice(0, 200));
  process.exit(1);
} finally {
  await s.close();
}
