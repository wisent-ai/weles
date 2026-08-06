// overleaf/history_scan.mjs — read a project's Overleaf-NATIVE version history
// via Overleaf's own JSON API from inside the authenticated session, and report
// which figures each collaborator DELETED. The GitHub sync flattens authorship
// onto the project owner, so only this native record attributes a figure
// deletion to a specific person (e.g. sarthakmunshi).
//
// Endpoints (confirmed from captured network in .work/inst/history_scan_*.json):
//   GET /project/<id>/changes/users           -> collaborator id -> name/email
//   GET /project/<id>/updates?min_count&before -> paginated save batches
//   GET /project/<id>/diff?from&to&pathname    -> per-file diff; chunks carry
//       {u|i|d, meta:{users:[id...], start_ts,end_ts}} so a `d` (deletion) is
//       attributable to the collaborator(s) in meta.users.
//
// Usage: node scripts/trajectories/overleaf/history_scan.mjs <PROJECT_ID_24hex>
//   HEADLESS=1 for headless (default visible — Google SSO heuristics).
// Output: .work/history_scan/figure_deletions.json (raw API + filtered result).

import { WSession } from '../../../dist/session/wsession.js';
import { googleSso, getGoogleSsoCreds } from '../_shared/services/google_sso.mjs';
import { humanIdlePause, humanClickLocator } from '../../../dist/human/mouse.js';
import { mkdirSync, writeFileSync } from 'node:fs';

const PROJECT = process.argv[2] || process.env.OVERLEAF_PROJECT;
if (!PROJECT || !/^[0-9a-fA-F]{24}$/.test(PROJECT)) {
  console.error('FAIL: need a 24-hex Overleaf project id as argv[2].');
  process.exit(1);
}

const SHOT_DIR = `${process.env.HOME}/Documents/CodingProjects/Wisent/weles/.work/history_scan`;
mkdirSync(SHOT_DIR, { recursive: true });

const login = await getGoogleSsoCreds();
if (!login) {
  console.error('FAIL: exact weles-google-sso-login grant unavailable.');
  process.exit(Number('1'));
}
console.log(`[history_scan] Google creds loaded for ${login.email}; project ${PROJECT}`);

const s = await WSession.start({ label: 'history_scan', browser: 'chromium', headful: process.env.HEADLESS !== '1' });

try {
  // ---- Google SSO (proven path from pull_github.mjs) ----
  await s.goto('https://www.overleaf.com/login');
  await humanIdlePause('short');
  const alreadyAuthed = /\/project(\?|$|\/)/.test(s.page.url());
  if (!alreadyAuthed) {
    const cookieBtn = s.page.getByRole('button', { name: /essential cookies only|accept all cookies/i }).first();
    if (await cookieBtn.count() > 0) { await humanClickLocator(s.page, cookieBtn); await s.page.waitForTimeout(500); } // allow-raw-playwright: cookie-banner settle
    const googleBtn = s.page.getByRole('button', { name: /log in with google|sign in with google/i }).or(
      s.page.getByRole('link', { name: /log in with google|sign in with google/i })).first();
    await googleBtn.waitFor({ state: 'visible' });
    await humanClickLocator(s.page, googleBtn);
    let popup = null;
    for (let i = 0; i < 20 && !popup; i += 1) {
      for (const p of s.ctx.pages()) { if (p !== s.page && /accounts\.google\.com/.test(p.url())) { popup = p; break; } }
      if (popup) break;
      if (/accounts\.google\.com/.test(s.page.url())) break;
      await s.page.waitForTimeout(250); // allow-raw-playwright: SSO-surface poll
    }
    if (popup) await popup.waitForLoadState('domcontentloaded');
    const ssoOpts = popup ? { originHost: 'overleaf.com', page: popup } : { originHost: 'overleaf.com' };
    const ok = await googleSso(s, login, ssoOpts);
    if (!ok) { console.error('FAIL: Google SSO did not complete'); await s.close(); process.exit(1); }
    let prev = '', stableTicks = 0, settledUrl = null;
    for (let i = 0; i < 60; i += 1) {
      await s.page.waitForTimeout(500); // allow-raw-playwright: settle poll
      const u = s.page.url();
      if (u !== prev) { prev = u; stableTicks = 0; continue; }
      stableTicks += 1;
      if (stableTicks >= 3 && !/accounts\.google\.com/.test(u)) { settledUrl = u; break; }
    }
    const finalUrl = settledUrl || s.page.url();
    console.log(`[history_scan] settled URL: ${finalUrl}`);
    if (/\/login(\?|$|\/)/.test(finalUrl)) { console.error('FAIL: returned to /login after SSO'); await s.close(); process.exit(1); }
  }

  // Land on the project so same-origin fetches to /project/<id>/... are allowed.
  await s.goto(`https://www.overleaf.com/project/${PROJECT}`);
  await humanIdlePause('deliberate');

  // ---- Read history via Overleaf's JSON API (authenticated, same-origin) ----
  const TEX_FILES = 'paper_revised.tex|paper_long.tex|paper_revised_35pageslimit.tex|paper_reading.tex|paper_control.tex'.split('|');
  const data = await s.page.evaluate(async ({ id, texFiles }) => {
    const J = async (u) => {
      try { const r = await fetch(u, { credentials: 'include', headers: { Accept: 'application/json' } }); if (!r.ok) return { __err: r.status, __u: u }; return await r.json(); }
      catch (e) { return { __ex: String(e), __u: u }; }
    };
    const users = await J(`/project/${id}/changes/users`);
    const latest = await J(`/project/${id}/latest/history`);
    let updates = [], before = null, guard = 0;
    while (guard < 400) {
      guard += 1;
      const page = await J(`/project/${id}/updates?min_count=50` + (before ? `&before=${before}` : ''));
      const arr = (page && page.updates) || [];
      if (!arr.length) break;
      updates = updates.concat(arr);
      const nb = page && page.nextBeforeTimestamp;
      if (!nb) break;
      before = nb;
    }
    let minV = Infinity, maxV = -Infinity;
    for (const u of updates) {
      if (typeof u.fromV === 'number') minV = Math.min(minV, u.fromV);
      if (typeof u.toV === 'number') maxV = Math.max(maxV, u.toV);
    }
    if (!isFinite(minV)) minV = 0;
    if (!isFinite(maxV)) maxV = (latest && (latest.version ?? latest.toV)) || 0;
    const FIGRE = /\\begin\{figure|\\includegraphics|\\label\{fig:/;
    const isSarthak = (u) => !!u && ((u.email && /sarthak/i.test(u.email)) || (u.first_name && /sarthak/i.test(u.first_name)) || u.id === '56befde938ab078a7a2b6917');
    const fileErrors = {};
    // Net (v0..latest) figure deletions — the ones that stuck.
    const figEvents = [];
    for (const f of texFiles) {
      const d = await J(`/project/${id}/diff?from=${minV}&to=${maxV}&pathname=${encodeURIComponent(f)}`);
      if (d && d.__err) { fileErrors[f] = d.__err; continue; }
      for (const c of ((d && d.diff) || [])) {
        if (c && typeof c.d === 'string' && FIGRE.test(c.d)) figEvents.push({ file: f, users: (c.meta && c.meta.users) || [], ts: (c.meta && (c.meta.end_ts || c.meta.start_ts)) || null, text: c.d.slice(0, 300) });
      }
    }
    // Per-Sarthak-save-batch diffs — catches figures he deleted that were later
    // re-added (churn the net diff misses, e.g. ones the owner restored).
    const sRanges = [];
    for (const u of updates) {
      const us = (u.meta && u.meta.users) || u.users || [];
      if (us.some(isSarthak) && typeof u.fromV === 'number' && typeof u.toV === 'number') sRanges.push([u.fromV, u.toV, (u.meta && (u.meta.end_ts || u.meta.start_ts)) || null]);
    }
    const sarthakFigDeletes = [];
    let calls = 0;
    for (const r of sRanges) {
      if (calls >= 3000) break;
      for (const f of texFiles) {
        if (calls >= 3000) break;
        calls += 1;
        const d = await J(`/project/${id}/diff?from=${r[0]}&to=${r[1]}&pathname=${encodeURIComponent(f)}`);
        for (const c of ((d && d.diff) || [])) {
          if (c && typeof c.d === 'string' && FIGRE.test(c.d)) {
            const us = (c.meta && c.meta.users) || [];
            if (us.some(isSarthak)) sarthakFigDeletes.push({ file: f, fromV: r[0], toV: r[1], ts: r[2], text: c.d });
          }
        }
      }
    }
    return { users, latest, updateCount: updates.length, minV, maxV, sRangeCount: sRanges.length, diffCalls: calls, fileErrors, figEvents, sarthakFigDeletes };
  }, { id: PROJECT, texFiles: TEX_FILES });

  writeFileSync(`${SHOT_DIR}/figure_deletions.json`, JSON.stringify(data, null, 2));

  // Map collaborator ids -> readable names from the /changes/users payload.
  const idName = {};
  const ulist = Array.isArray(data.users) ? data.users : (data.users && data.users.users) || [];
  for (const u of ulist) {
    const nm = [u.first_name, u.last_name].filter(Boolean).join(' ') || u.email || u.name || u.id;
    if (u.id) idName[u.id] = nm;
  }
  const nameOf = (ids) => (ids || []).map((x) => idName[x] || x).join(', ') || '(unknown)';

  console.log(`[history_scan] users=${JSON.stringify(ulist).slice(0, 600)}`);
  console.log(`[history_scan] updates=${data.updateCount} range=${data.minV}..${data.maxV} fileErrors=${JSON.stringify(data.fileErrors)}`);
  console.log(`[history_scan] net figure deletions (stuck): ${data.figEvents.length}`);
  for (const e of data.figEvents) {
    const flat = e.text.replace(/\s+/g, ' ').slice(0, 150);
    console.log(`[history_scan] NET-DEL ${e.file} by=[${nameOf(e.users)}] ts=${e.ts} :: ${flat}`);
  }
  console.log(`[history_scan] Sarthak save-batches: ${data.sRangeCount}; diff calls: ${data.diffCalls}; Sarthak figure deletions: ${data.sarthakFigDeletes.length}`);
  for (const e of data.sarthakFigDeletes) {
    const flat = e.text.replace(/\s+/g, ' ').slice(0, 170);
    console.log(`[history_scan] SARTHAK-DEL ${e.file} v${e.fromV}->${e.toV} ts=${e.ts} :: ${flat}`);
  }
  await s.close();
  process.exit(0);
} catch (err) {
  console.error('[history_scan] unhandled error:', err && err.message ? err.message : err);
  try { const html = await s.page.content(); writeFileSync(`${SHOT_DIR}/exception.html`, html); } catch {}
  await s.close();
  process.exit(2);
}
