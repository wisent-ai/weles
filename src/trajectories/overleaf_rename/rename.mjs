// overleaf_rename/rename.mjs — fully automated Overleaf project rename.
// Reuses the proven Google-SSO scaffold (import_github.mjs). Logs in once, then
// for each "<24hex projectId>=<new name>" arg: scrapes the current dashboard
// name (substantiation), POSTs /project/<id>/rename with the page CSRF token,
// and re-scrapes to verify. Renaming does NOT touch the GitHub sync link.
//
// Usage:
//   WELES_NO_INSTRUMENT=1 WELES_DISABLE_RECORDING=1 \
//   node src/trajectories/overleaf_rename/rename.mjs "<24hex>=New Name" [...]

import { WSession } from '../../../dist/session/wsession.js';
import { googleSso, getGoogleSsoCreds } from '../_shared/services/google_sso.mjs';
import { humanIdlePause, humanClickLocator } from '../../../dist/human/mouse.js';

const PAIRS = process.argv.slice(2).map((a) => {
  const i = a.indexOf('=');
  if (i < 0) return null;
  const id = a.slice(0, i).trim();
  const name = a.slice(i + 1).trim();
  if (!/^[0-9a-fA-F]{24}$/.test(id) || !name) return null;
  return { id, name };
}).filter(Boolean);
if (PAIRS.length === 0) { console.error('FAIL: need "<24hex>=New Name" args'); process.exit(1); }

const login = await getGoogleSsoCreds();
if (!login) { console.error('FAIL: getGoogleSsoCreds() returned null'); process.exit(1); }
console.log(`[rename] creds for ${login.email}; ${PAIRS.length} project(s)`);

const s = await WSession.start({ label: 'overleaf_rename', browser: 'chromium', headful: process.env.HEADLESS !== '1' });

async function ensureLoggedIn() {
  await s.goto('https://www.overleaf.com/login');
  await humanIdlePause('short');
  if (/\/project(\?|$|\/)/.test(s.page.url())) { console.log('[rename] already authed via cookies'); return; }
  const cookieBtn = s.page.getByRole('button', { name: /essential cookies only|accept all cookies/i }).first();
  if (await cookieBtn.count() > 0) {
    await humanClickLocator(s.page, cookieBtn);
    await s.page.waitForTimeout(500);  // allow-raw-playwright: cookie-banner dismiss settle
  }
  const googleBtn = s.page.getByRole('button', { name: /log in with google|sign in with google/i })
    .or(s.page.getByRole('link', { name: /log in with google|sign in with google/i })).first();
  await googleBtn.waitFor({ state: 'visible' });
  const pp = s.page.waitForEvent('popup').then((p) => p, () => null);
  await humanClickLocator(s.page, googleBtn);
  const popup = await Promise.race([pp, new Promise((r) => setTimeout(() => r(null), 5000))]);  // allow-raw-playwright: Promise.race deadline
  const ok = popup
    ? await googleSso(s, login, { originHost: 'overleaf.com', page: popup })
    : await googleSso(s, login, { originHost: 'overleaf.com' });
  if (!ok) { console.error('FAIL: Google SSO did not complete'); await s.close(); process.exit(1); }
  let prev = '', stable = 0, settled = null;
  for (let i = 0; i < 60; i += 1) {
    await s.page.waitForTimeout(500);  // allow-raw-playwright: SSO URL settle poll
    const u = s.page.url();
    if (u !== prev) { prev = u; stable = 0; continue; }
    stable += 1;
    if (stable >= 3 && !/accounts\.google\.com/.test(u)) { settled = u; break; }
  }
  const fin = settled || s.page.url();
  console.log(`[rename] settled URL: ${fin}`);
  if (/\/login(\?|$|\/)/.test(fin)) { console.error('FAIL: back at /login after SSO'); await s.close(); process.exit(1); }
  if (!/\/project(\?|$|\/)/.test(fin)) await s.goto('https://www.overleaf.com/project');
}

async function currentName(id) {
  if (!/\/project(\?|$|\/)/.test(s.page.url())) await s.goto('https://www.overleaf.com/project');
  await s.page.locator('a[href*="/project/"]').first().waitFor({ state: 'visible' });
  return s.page.evaluate((pid) => {
    const a = document.querySelector(`a[href*="/project/${pid}"]`);
    if (!a) return null;
    const t = (a.textContent || '').trim();
    return t === '' ? null : t;
  }, id);
}

async function renameOne(id, newName) {
  const before = await currentName(id);
  console.log(`[rename] ${id} current name: ${JSON.stringify(before)}`);
  const res = await s.page.evaluate(async ({ pid, name }) => {
    function csrf() {
      if (typeof window.csrfToken === 'string' && window.csrfToken) return window.csrfToken;
      const m = document.querySelector('meta[name="ol-csrfToken"], meta[name="csrf-token"]');
      return m ? m.getAttribute('content') : null;
    }
    const token = csrf();
    if (!token) return { ok: false, status: 0, err: 'no csrf token found on page' };
    const r = await fetch(`/project/${pid}/rename`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': token, Accept: 'application/json' },
      body: JSON.stringify({ newProjectName: name }),
      credentials: 'include',
    });
    return { ok: r.ok, status: r.status, err: r.ok ? null : await r.text().catch((e) => String(e)) };
  }, { pid: id, name: newName });
  console.log(`[rename] ${id} POST /rename -> ok=${res.ok} status=${res.status}${res.err ? ' err=' + String(res.err).slice(0, 200) : ''}`);
  if (!res.ok) throw new Error(`rename POST failed status=${res.status} ${String(res.err).slice(0, 200)}`);
  await s.goto('https://www.overleaf.com/project');
  await humanIdlePause('short');
  const after = await currentName(id);
  console.log(`[rename] ${id} name after: ${JSON.stringify(after)}`);
  if (after !== newName) throw new Error(`verify mismatch: expected ${JSON.stringify(newName)} got ${JSON.stringify(after)}`);
  return { id, before, after };
}

try {
  await ensureLoggedIn();
  const results = [];
  for (const { id, name } of PAIRS) {
    try {
      const r = await renameOne(id, name);
      results.push({ ...r, ok: true });
      console.log(`[rename] OK ${id}: ${JSON.stringify(r.before)} -> ${JSON.stringify(r.after)}`);
    } catch (e) {
      results.push({ id, ok: false, err: e?.message || String(e) });
      console.error(`[rename] FAIL ${id}: ${e?.message || e}`);
    }
  }
  console.log('\n[rename] ===== summary =====');
  for (const r of results) console.log(r.ok ? `  OK   ${r.id} -> ${r.after}` : `  FAIL ${r.id}: ${r.err}`);
  const good = results.filter((r) => r.ok).length;
  console.log(`[rename] done — ${good}/${results.length} renamed`);
  await s.close();
  process.exit(good === results.length ? 0 : 2);
} catch (e) {
  console.error('[rename] fatal:', e?.message || e);
  await s.close();
  process.exit(2);
}
