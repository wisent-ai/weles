// overleaf/version_history_ui_phrase.mjs
//
// UI-only Weles trajectory for Overleaf Version History. It opens the Overleaf
// dashboard/editor and clicks the History UI. It does not call Overleaf project
// JSON/history endpoints directly.
//
// Usage:
//   node src/trajectories/overleaf/version_history_ui_phrase.mjs <project-id-or-title> <phrase-or-query-text>

import { googleSso, getGoogleSsoCreds } from '../_shared/services/google_sso.mjs';
import { humanIdlePause, humanClickLocator } from '../../../dist/human/mouse.js';
import { humanType } from '../../../dist/human/keyboard.js';
import { runRecordingsDir } from '../../../dist/session/run-recordings.js';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const target = process.argv[2] || process.env.OVERLEAF_PROJECT ||
  'Classifier Decision Boundaries Yield Stronger Steering Vectors';
const queryText = process.argv.slice(3).join(' ') || process.env.OVERLEAF_QUERY_TEXT || process.env.OVERLEAF_PHRASE || '';
const isId = /^[0-9a-fA-F]{24}$/.test(target);

const OUT_DIR = `${process.env.HOME}/Documents/CodingProjects/Wisent/weles/.work/version_history_ui_phrase`;
mkdirSync(OUT_DIR, { recursive: true });
const OUTPUT_PATH = process.env.OVERLEAF_OUTPUT || `${OUT_DIR}/summary.json`;
const MAIN_TEX = process.env.OVERLEAF_MAIN_TEX || 'main.tex';
const MAX_HISTORY_CLICKS = Math.max(0, Number.parseInt(process.env.OVERLEAF_HISTORY_MAX_CLICKS || '8', 10) || 0);

process.env.WELES_DISABLE_RECORDING = '1';
process.env.WELES_NO_RESPONSE_BODIES = '1';
process.env.WELES_CHROMIUM_NETLOG = '0';
process.env.WELES_FULL_DIAGNOSTICS = '0';
process.env.WELES_NO_INSTRUMENT = '1';
process.env.WELES_PAGE_DIAGNOSTICS = '0';

const [{ WSession }, { SessionStore }] = await Promise.all([
  import('../../../dist/session/wsession.js'),
  import('../../../dist/session/store.js'),
]);

const PROFILE_DIR = `${process.env.HOME}/Documents/CodingProjects/Wisent/weles/.work/overleaf_browser_profile`;
if (process.env.WELES_OVERLEAF_PERSISTENT_PROFILE !== '0' && !process.env.WELES_USER_DATA_DIR) {
  mkdirSync(PROFILE_DIR, { recursive: true });
  process.env.WELES_USER_DATA_DIR = PROFILE_DIR;
}

function norm(s) {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

function writeSummary(summary) {
  const text = JSON.stringify(summary, null, 2);
  writeFileSync(OUTPUT_PATH, text);
  try {
    const runDir = runRecordingsDir('version_history_ui_phrase');
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, 'overleaf_version_history_summary.json'), text);
  } catch (err) {
    console.log(`[version_history_ui] summary artifact write failed: ${err?.message || String(err)}`);
  }
}

let shotN = 0;
async function dump(s, tag) {
  shotN += 1;
  const base = `${OUT_DIR}/${String(shotN).padStart(2, '0')}_${tag}`;
  const html = await s.page.content().catch(() => '');
  const text = await s.page.evaluate(() => document.body.innerText).catch(() => '');
  writeFileSync(`${base}.html`, html);
  writeFileSync(`${base}.txt`, text);
  console.log(`[version_history_ui] ${tag} url=${s.page.url()} html=${base}.html text=${base}.txt`);
  return { html: `${base}.html`, text: `${base}.txt`, bodyText: text };
}

async function clickText(page, re) {
  const hit = page.locator('button,a,[role="button"],[role="menuitem"]')
    .filter({ hasText: re, visible: true })
    .or(page.getByLabel(re).filter({ visible: true })).first();
  if (await hit.count() === 0) return null;
  const clicked = await hit.evaluate((el) => ({
    text: (el.textContent || '').trim(),
    aria: el.getAttribute('aria-label') || '',
    id: el.id || '',
    cls: el.className || '',
  }));
  await humanClickLocator(page, hit);
  return clicked;
}

async function ensureDashboard(s) {
  await s.goto('https://www.overleaf.com/project');
  await humanIdlePause('deliberate');
  const current = s.page.url();
  const body = await s.page.evaluate(() => document.body.innerText).catch(() => '');
  if (/\/login(?:[/?#]|$)/.test(current) || /Log in with Google|Log in/i.test(body.slice(0, 1000))) {
    return false;
  }
  return true;
}

async function loginWithGoogleUi(s) {
  await s.goto('https://www.overleaf.com/login');
  await humanIdlePause('short');
  const cookieBtn = s.page.getByRole('button', { name: /essential cookies only|accept all cookies/i }).first();
  if (await cookieBtn.count() > 0) {
    await humanClickLocator(s.page, cookieBtn);
    await s.page.waitForTimeout(500);
  }
  const googleBtn = s.page.getByRole('button', { name: /log in with google|sign in with google/i })
    .or(s.page.getByRole('link', { name: /log in with google|sign in with google/i }))
    .filter({ visible: true })
    .first();
  await googleBtn.waitFor({ state: 'visible', timeout: 15000 });

  let popupCaught = null;
  const popupPromise = s.page.waitForEvent('popup').then((p) => { popupCaught = p; return p; }, () => null);
  await humanClickLocator(s.page, googleBtn);
  const popup = await Promise.race([
    popupPromise,
    new Promise((resolve) => setTimeout(() => resolve(null), 5000)),
  ]);

  let surface = popup || popupCaught;
  if (!surface) {
    for (let i = 0; i < 40; i += 1) {
      for (const p of s.ctx.pages()) {
        if (p !== s.page && /accounts\.google\.com/.test(p.url())) { surface = p; break; }
      }
      if (surface) break;
      if (/accounts\.google\.com/.test(s.page.url())) { surface = s.page; break; }
      await s.page.waitForTimeout(250);
    }
  }
  if (!surface) throw new Error('Google SSO surface did not open');

  const creds = await getGoogleSsoCreds();
  if (!creds) throw new Error('getGoogleSsoCreds() returned null for Overleaf Google SSO');

  const emailInputCount = await surface.locator('input[type="email"], input[name="identifier"], input#identifierId').filter({ visible: true }).count().catch(() => 0);
  if (emailInputCount === 0) {
    const useAnother = surface.getByText(/Use another account/i).filter({ visible: true }).first();
    if (await useAnother.count() > 0) {
      await humanClickLocator(surface, useAnother);
      await humanIdlePause('deliberate');
    }
  }

  const ok = await googleSso(s, creds, { originHost: 'overleaf.com', page: surface });
  if (!ok) throw new Error('Google SSO did not complete');

  for (let i = 0; i < 60; i += 1) {
    await s.page.waitForTimeout(500);
    const url = s.page.url();
    if (/overleaf\.com\/project/.test(url)) return true;
    if (!/accounts\.google\.com|login/.test(url)) {
      await s.goto('https://www.overleaf.com/project');
      return true;
    }
  }
  await s.goto('https://www.overleaf.com/project');
  return true;
}

async function resolveAndOpenProject(s) {
  if (isId) {
    await s.goto(`https://www.overleaf.com/project/${target}`);
    await humanIdlePause('deliberate');
    return target;
  }

  const needle = target.toLowerCase();
  const anchorSel = 'a[href*="/project/"]';
  await s.page.locator(anchorSel).first().waitFor({ state: 'visible', timeout: 15000 });
  const anchorLoc = s.page.locator(anchorSel);
  let lastCount = -1;
  for (let i = 0; i < 20; i += 1) {
    const count = await anchorLoc.count();
    if (count > 0) await anchorLoc.nth(count - 1).scrollIntoViewIfNeeded().catch(() => {});
    if (count === lastCount) break;
    lastCount = count;
    await s.page.waitForTimeout(500);
  }

  const match = await s.page.evaluate((needle) => {
    const links = Array.from(document.querySelectorAll('a[href*="/project/"]'));
    for (const a of links) {
      const href = a.getAttribute('href') || '';
      const m = href.match(/\/project\/([0-9a-fA-F]{24})(?:[/?#]|$)/);
      const text = (a.textContent || '').trim();
      if (m && text.toLowerCase().includes(needle)) return { id: m[1], text, href };
    }
    return null;
  }, needle);
  if (!match) throw new Error(`dashboard has no project title containing "${target}"`);

  const link = s.page.locator(`a[href*="/project/${match.id}"]`).first();
  await humanClickLocator(s.page, link);
  await humanIdlePause('deliberate');
  return match.id;
}

async function openHistoryUi(s) {
  const historyButton = s.page.getByRole('button', { name: /^History$/i }).filter({ visible: true }).first();
  if (await historyButton.count() > 0) {
    await humanClickLocator(s.page, historyButton);
    await humanIdlePause('deliberate');
    return 'toolbar-history-button';
  }

  const menuClick = await clickText(s.page, /^Menu$|^File$/i);
  if (menuClick) {
    await s.page.waitForTimeout(800);
    const item = s.page.getByRole('menuitem', { name: /show version history/i }).filter({ visible: true }).first();
    if (await item.count() > 0) {
      await humanClickLocator(s.page, item);
      await humanIdlePause('deliberate');
      return 'file-menu-show-version-history';
    }
    const clicked = await clickText(s.page, /show version history/i);
    if (clicked) {
      await humanIdlePause('deliberate');
      return 'dom-show-version-history';
    }
  }

  const clicked = await clickText(s.page, /^History$|show version history/i);
  if (clicked) {
    await humanIdlePause('deliberate');
    return 'dom-history';
  }
  throw new Error('could not find History / Show version history control');
}

async function summarizeVisible(page, queryText) {
  return await page.evaluate((queryText) => {
    const normalize = (s) => String(s || '').replace(/\s+/g, ' ').trim();
    const texts = [];
    const addText = (label, value) => {
      const text = String(value || '');
      if (text.length < 20) return;
      if (texts.some((entry) => entry.text === text)) return;
      texts.push({ label, text });
    };
    const addDoc = (label, doc) => {
      if (!doc) return;
      try {
        if (typeof doc === 'string') addText(label, doc);
        else if (typeof doc.toString === 'function') addText(label, doc.toString());
        else if (typeof doc.getValue === 'function') addText(label, doc.getValue());
      } catch {
        // Ignore inaccessible editor internals.
      }
    };
    const seenObjects = new Set();
    const inspectObject = (obj, label, depth = 0) => {
      if (!obj || (typeof obj !== 'object' && typeof obj !== 'function')) return;
      if (seenObjects.has(obj) || depth > 3) return;
      seenObjects.add(obj);
      try { if (typeof obj.getValue === 'function') addText(`${label}.getValue`, obj.getValue()); } catch {}
      try { addDoc(`${label}.state.doc`, obj.state?.doc); } catch {}
      try { addDoc(`${label}.view.state.doc`, obj.view?.state?.doc); } catch {}
      try { if (typeof obj.doc?.getValue === 'function') addText(`${label}.doc.getValue`, obj.doc.getValue()); } catch {}
      try { if (typeof obj.cm?.getValue === 'function') addText(`${label}.cm.getValue`, obj.cm.getValue()); } catch {}
      for (const key of ['view', 'editor', 'sourceEditor', '_editor', 'cm', 'codeMirror', 'doc', 'state', 'model']) {
        try { inspectObject(obj[key], `${label}.${key}`, depth + 1); } catch {}
      }
    };
    const inspectDomEditorState = () => {
      const selectors = [
        '.cm-editor',
        '.cm-content',
        '.cm-scroller',
        '.CodeMirror',
        '.CodeMirror-code',
        '[class*="cm-"]',
        '[class*="CodeMirror"]',
      ];
      for (const el of Array.from(document.querySelectorAll(selectors.join(',')))) {
        inspectObject(el, `dom.${el.className || el.tagName}`);
        try {
          for (const key of Reflect.ownKeys(el)) {
            const value = el[key];
            inspectObject(value, `dom.${String(key)}`);
          }
        } catch {
          // Some browser objects reject property enumeration.
        }
      }
    };
    const inspectKnownGlobals = () => {
      for (const key of ['_ide', 'ide', 'editor', 'editorManager', 'angular', 'webpackChunkoverleaf']) {
        try { inspectObject(window[key], `window.${key}`); } catch {}
      }
      try {
        const current = window._ide?.editorManager?.getCurrentEditor?.();
        inspectObject(current, 'window._ide.editorManager.getCurrentEditor');
      } catch {}
      try {
        const current = window.ide?.editorManager?.getCurrentEditor?.();
        inspectObject(current, 'window.ide.editorManager.getCurrentEditor');
      } catch {}
    };
    const tokenizeWithOffsets = (s) => {
      const out = [];
      const re = /[A-Za-z0-9]+/g;
      let m;
      while ((m = re.exec(String(s || '')))) {
        out.push({ token: m[0].toLowerCase(), start: m.index, end: m.index + m[0].length });
      }
      return out;
    };
    const bestTokenWindow = (body, wanted) => {
      const targetTokens = tokenizeWithOffsets(wanted).map((t) => t.token);
      const bodyTokens = tokenizeWithOffsets(body);
      if (targetTokens.length < 3 || bodyTokens.length < targetTokens.length) return null;
      let best = null;
      for (let i = 0; i <= bodyTokens.length - targetTokens.length; i += 1) {
        let hits = 0;
        for (let j = 0; j < targetTokens.length; j += 1) {
          if (bodyTokens[i + j].token === targetTokens[j]) hits += 1;
        }
        const score = hits / targetTokens.length;
        if (!best || score > best.score) {
          best = { score, start: bodyTokens[i].start, end: bodyTokens[i + targetTokens.length - 1].end, hits };
        }
      }
      const threshold = targetTokens.length >= 10 ? 0.82 : 0.9;
      return best && best.score >= threshold ? best : null;
    };
    const bestDocumentText = () => {
      const looksLikeLatex = (text) =>
        /\\documentclass|\\begin\{document\}|\\title\{|\\section\{|\\subsection\{|\\paragraph\{/.test(text);
      const docs = texts
        .filter((entry) => entry.text.length >= 500 && looksLikeLatex(entry.text))
        .sort((left, right) => right.text.length - left.text.length);
      return docs[0] || null;
    };
    const wanted = normalize(queryText);
    const body = document.body.innerText || '';
    const rawBody = document.documentElement.textContent || '';
    inspectDomEditorState();
    inspectKnownGlobals();
    const candidates = [];
    for (const el of Array.from(document.querySelectorAll('button,a,[role="button"],li,div'))) {
      const text = normalize(el.textContent || '');
      if (!text || text.length < 3 || text.length > 500) continue;
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      if (rect.width <= 0 || rect.height <= 0 || style.visibility === 'hidden' || style.display === 'none') continue;
      candidates.push(text);
      if (candidates.length >= 120) break;
    }
    const editorText = texts.map((entry) => entry.text).join('\n\n');
    const documentText = bestDocumentText();
    const nbody = normalize([body, rawBody, editorText].filter(Boolean).join(' '));
    const idx = wanted ? nbody.indexOf(wanted) : -1;
    const fuzzy = idx >= 0 ? null : bestTokenWindow(nbody, wanted);
    const targetIndex = idx >= 0 ? idx : (fuzzy ? fuzzy.start : -1);
    const targetEnd = idx >= 0 ? idx + wanted.length : (fuzzy ? fuzzy.end : -1);
    return {
      title: document.title,
      url: location.href,
      targetIndex,
      targetMatchKind: idx >= 0 ? 'exact' : (fuzzy ? 'token_window' : 'none'),
      targetScore: idx >= 0 ? 1 : (fuzzy?.score ?? 0),
      targetContext: targetIndex >= 0 ? nbody.slice(Math.max(0, targetIndex - 500), targetEnd + 500) : null,
      documentText: documentText?.text ?? null,
      documentTextSource: documentText?.label ?? null,
      documentTextLength: documentText?.text.length ?? 0,
      editorTextSources: texts.map((entry) => ({ label: entry.label, length: entry.text.length })).slice(0, 20),
      visibleItems: Array.from(new Set(candidates)).slice(0, 80),
      bodyHead: nbody.slice(0, 3000),
    };
  }, queryText);
}

async function revealQueryInEditor(page, queryText) {
  const wanted = norm(queryText);
  if (!wanted) return { attempted: false, reason: 'empty-query' };

  const before = await summarizeVisible(page, wanted);
  if (before.targetIndex >= 0) {
    return {
      attempted: false,
      reason: 'already-found',
      targetMatchKind: before.targetMatchKind,
      targetScore: before.targetScore,
    };
  }

  const attempts = [];
  for (const shortcut of ['Meta+f', 'Control+f']) {
    try {
      await page.keyboard.press(shortcut);
      await page.waitForTimeout(300);
      await humanType(page, wanted);
      await page.waitForTimeout(700);
      await page.keyboard.press('Enter').catch(() => {});
      await page.waitForTimeout(700);
      await page.keyboard.press('Escape').catch(() => {});
      await page.waitForTimeout(1000);
      const after = await summarizeVisible(page, wanted);
      attempts.push({
        shortcut,
        targetMatchKind: after.targetMatchKind,
        targetScore: after.targetScore,
        targetIndex: after.targetIndex,
      });
      if (after.targetIndex >= 0) return { attempted: true, method: shortcut, attempts };
    } catch (err) {
      attempts.push({ shortcut, error: err?.message || String(err) });
    }
  }

  try {
    const found = await page.evaluate((text) => {
      if (typeof window.find !== 'function') return false;
      return window.find(text, false, false, true, false, true, false);
    }, wanted);
    await page.waitForTimeout(1000);
    const after = await summarizeVisible(page, wanted);
    attempts.push({
      method: 'window.find',
      found,
      targetMatchKind: after.targetMatchKind,
      targetScore: after.targetScore,
      targetIndex: after.targetIndex,
    });
    if (after.targetIndex >= 0) return { attempted: true, method: 'window.find', attempts };
  } catch (err) {
    attempts.push({ method: 'window.find', error: err?.message || String(err) });
  }

  return { attempted: true, method: null, attempts };
}

async function clickVisibleText(page, text, tag, exact = false) {
  const loc = exact
    ? page.getByText(text, { exact: true }).filter({ visible: true }).first()
    : page.getByText(text).filter({ visible: true }).first();
  if (await loc.count() > 0) {
    await loc.scrollIntoViewIfNeeded().catch(() => {});
    await humanClickLocator(page, loc);
    await page.waitForTimeout(1500);
    return { tag, text, clicked: true, method: 'locator' };
  }

  const fallback = page.locator('button,a,[role="button"],[role="treeitem"],li')
    .filter({ hasText: text, visible: true }).first();
  if (await fallback.count() === 0) return { tag, text, clicked: false, method: null };
  const detail = await fallback.evaluate((el) => ({
    text: String(el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 300),
    tagName: el.tagName,
    role: el.getAttribute('role') || '',
  }));
  await humanClickLocator(page, fallback);
  await page.waitForTimeout(1500);
  return { tag, text, clicked: true, method: 'locator-fallback', clicked: detail };
}

async function probeHistoryState(s, tag, queryText, reveal = false) {
  const revealResult = reveal ? await revealQueryInEditor(s.page, queryText) : null;
  const d = await dump(s, tag);
  const summary = await summarizeVisible(s.page, queryText);
  return {
    tag,
    path: d.text,
    url: s.page.url(),
    targetIndex: summary.targetIndex,
    targetMatchKind: summary.targetMatchKind,
    targetScore: summary.targetScore,
    targetContext: summary.targetContext,
    documentText: summary.documentText,
    documentTextSource: summary.documentTextSource,
    documentTextLength: summary.documentTextLength,
    editorTextSources: summary.editorTextSources,
    revealResult,
    bodyHead: summary.bodyHead,
    visibleItems: summary.visibleItems,
  };
}

const s = await WSession.start({
  label: 'version_history_ui_phrase',
  browser: 'chromium',
  headful: process.env.HEADLESS !== '1',
});

try {
  const store = new SessionStore();
  const injected = await store.injectPlaywright(s.ctx, process.env.OVERLEAF_AUTH_LABEL || 'overleaf').catch(() => false);
  console.log(`[version_history_ui] injectedCookies=${injected}`);

  if (!(await ensureDashboard(s))) {
    console.log('[version_history_ui] not authenticated; using Google SSO UI fallback');
    await loginWithGoogleUi(s);
    await store.capturePlaywright(s.ctx, process.env.OVERLEAF_AUTH_LABEL || 'overleaf').catch(() => {});
    if (!(await ensureDashboard(s))) throw new Error('still not authenticated after Google SSO UI flow');
  }
  await dump(s, 'dashboard');
  const projectId = await resolveAndOpenProject(s);
  const editorDump = await dump(s, `editor_${projectId.slice(0, 8)}`);
  if (/Restricted|permission to load this page/i.test(editorDump.bodyText)) {
    throw new Error(`project opened as restricted: ${s.page.url()}`);
  }

  const method = await openHistoryUi(s);
  await s.page.waitForTimeout(3000);
  await dump(s, `history_open_${method}`);

  const summary = await summarizeVisible(s.page, queryText);
  const probes = [];
  const clicks = [];
  probes.push(await probeHistoryState(s, 'probe_initial_history', queryText));
  if (MAIN_TEX) {
    clicks.push(await clickVisibleText(s.page, MAIN_TEX, 'click_current_main_tex', true));
    probes.push(await probeHistoryState(s, 'probe_current_main_tex', queryText, true));
  }

  const historyTargets = Array.from(new Set(summary.visibleItems || []))
    .map(norm)
    .filter((candidate) => candidate.length >= 3 && candidate.length <= 160)
    .filter((candidate) => MAIN_TEX ? candidate !== MAIN_TEX : true)
    .slice(0, MAX_HISTORY_CLICKS);
  for (let i = 0; i < historyTargets.length; i += 1) {
    const label = `click_history_${String(i + 1).padStart(2, '0')}`;
    clicks.push(await clickVisibleText(s.page, historyTargets[i], label));
    probes.push(await probeHistoryState(s, `probe_history_${String(i + 1).padStart(2, '0')}`, queryText));
    if (MAIN_TEX) {
      clicks.push(await clickVisibleText(s.page, MAIN_TEX, `${label}_main_tex`, true));
      probes.push(await probeHistoryState(s, `probe_history_${String(i + 1).padStart(2, '0')}_main_tex`, queryText, true));
    }
  }

  const output = {
    target,
    projectId,
    queryText: norm(queryText),
    phrase: norm(queryText),
    mainTex: MAIN_TEX,
    method,
    clicks,
    probes,
    summary,
  };
  writeSummary(output);
  console.log(JSON.stringify({ projectId, method, summaryPath: OUTPUT_PATH, summary }, null, 2));

  await s.close();
  process.exit(0);
} catch (err) {
  const message = err && err.message ? err.message : String(err);
  await dump(s, 'exception').catch(() => {});
  console.error(`[version_history_ui] FAIL: ${message}`);
  await s.close();
  process.exit(2);
}
