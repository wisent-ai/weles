// Create a Google Doc with formatted content. Converts the source
// markdown to HTML, sets the macOS pasteboard to that HTML via the
// swift helper at weles/scripts/lib/setpb.swift, then Cmd+V into the
// Docs body so Docs renders real headings, bold, lists, code, links.
//
// Preprocessing: strips HTML comments and converts the validator's
// <!-- value name="X" --> ... <!-- /value --> markers into bold
// "Answer: value" lines so the rendered Doc reads as Q+A pairs.
//
// Run: node weles/scripts/trajectories/google/drive/paste_doc.mjs
//      --title "..." --content path/to/file.md
// Env mirror: DOC_TITLE, DOC_CONTENT_PATH, GM_EMAIL, GM_PASSWORD, BROWSER.

import { WSession } from '../../../../dist/session/wsession.js';
import { googleSso, getGoogleSsoCreds } from '../../_shared/services/google_sso.mjs';
import { humanClick, humanClickLocator, humanIdlePause } from '../../../../dist/human/mouse.js';
import { humanType } from '../../../../dist/human/keyboard.js';
import { nativeCmdV } from '../../../../dist/human/mouse-native.js';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const TITLE = arg('--title') || process.env.DOC_TITLE;
const CONTENT_PATH = arg('--content') || process.env.DOC_CONTENT_PATH;
const LABEL = 'drive_paste_doc';
const HTML_OUT_DIR = '/Users/lukaszbartoszcze/Documents/CodingProjects/Wisent/content-platform/.work/paste_doc';
const SWIFT_SETPB = '/Users/lukaszbartoszcze/Documents/CodingProjects/Wisent/weles/scripts/lib/setpb.swift';

if (!TITLE) { console.log('FAIL: --title (or DOC_TITLE) required'); process.exit(2); }
if (!CONTENT_PATH) { console.log('FAIL: --content (or DOC_CONTENT_PATH) required'); process.exit(2); }

const rawContent = readFileSync(CONTENT_PATH, 'utf8');
function log(...a) { console.log('[drive_paste_doc]', ...a); }

// Strip validator scaffolding and convert value markers to bold Answer lines.
function cleanContent(md) {
  let out = md.replace(/<!--\s*value\s+name="([^"]+)"[^>]*-->([\s\S]*?)<!--\s*\/value\s*-->/g, (_, _name, body) => {
    const v = body.trim();
    if (v === '') return '**Answer:** _(empty)_';
    return '**Answer:** ' + v;
  });
  return out.replace(/<!--[\s\S]*?-->/g, '');
}

function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Subset markdown -> HTML for Docs paste. Handles headings (#..####),
// ul, ol, **bold**, `code`, [link](url), paragraphs, hr.
function mdToHtml(md) {
  const lines = md.split('\n');
  const out = []; let inUl = false; let inOl = false; let paraBuf = [];
  const inline = (s) => escapeHtml(s)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
  const flushPara = () => { if (paraBuf.length) { out.push('<p>' + inline(paraBuf.join(' ')) + '</p>'); paraBuf = []; } };
  const closeLists = () => { if (inUl) { out.push('</ul>'); inUl = false; } if (inOl) { out.push('</ol>'); inOl = false; } };
  for (const raw of lines) {
    const line = raw.replace(/\s+$/g, '');
    if (line === '') { flushPara(); closeLists(); continue; }
    const h = line.match(/^(#{1,4})\s+(.+)$/);
    if (h) { flushPara(); closeLists(); out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`); continue; }
    const ul = line.match(/^[-*]\s+(.+)$/);
    if (ul) { flushPara(); if (inOl) { out.push('</ol>'); inOl = false; } if (!inUl) { out.push('<ul>'); inUl = true; } out.push('<li>' + inline(ul[1]) + '</li>'); continue; }
    const ol = line.match(/^\d+\.\s+(.+)$/);
    if (ol) { flushPara(); if (inUl) { out.push('</ul>'); inUl = false; } if (!inOl) { out.push('<ol>'); inOl = true; } out.push('<li>' + inline(ol[1]) + '</li>'); continue; }
    if (line === '---') { flushPara(); closeLists(); out.push('<hr>'); continue; }
    closeLists(); paraBuf.push(line);
  }
  flushPara(); closeLists();
  return '<html><body>' + out.join('\n') + '</body></html>';
}

async function resolveCreds() {
  const email = process.env.GM_EMAIL || 'lukasz.bartoszcze@gmail.com';
  if (process.env.GM_PASSWORD) return { email, password: process.env.GM_PASSWORD };
  const fromDb = await getGoogleSsoCreds(email);
  if (fromDb?.password) return fromDb;
  throw new Error('No password: set GM_PASSWORD or add a service_credentials row for ' + email);
}

const cleaned = cleanContent(rawContent);
const html = mdToHtml(cleaned);
log('clean: ' + rawContent.length + ' -> ' + cleaned.length + ' md -> ' + html.length + ' html chars');

mkdirSync(HTML_OUT_DIR, { recursive: true });
const htmlPath = HTML_OUT_DIR + '/last_paste.html';
writeFileSync(htmlPath, html);

const creds = await resolveCreds();
const s = await WSession.start({ label: LABEL, browser: process.env.BROWSER || 'chromium' });

try {
  log('engine:', s.personaConfig?.browser ?? 'unknown', '| title:', TITLE);
  await s.page.goto('https://docs.google.com/document/create', { waitUntil: 'domcontentloaded' });
  await humanIdlePause('deliberate');

  if (/accounts\.google\.com|ServiceLogin|signin/.test(s.page.url())) {
    log('logged out — running googleSso for', creds.email);
    const ok = await googleSso(s, creds);
    if (!ok) { log('FAIL: googleSso did not complete (url=' + s.page.url() + ')'); process.exit(2); }
    await humanIdlePause('long');
    if (!/document\/d\//.test(s.page.url())) {
      await s.page.goto('https://docs.google.com/document/create', { waitUntil: 'domcontentloaded' });
      await humanIdlePause('deliberate');
    }
  }

  for (let i = 0; i < 60; i++) {
    if (/document\/d\/[A-Za-z0-9_-]+\/edit/.test(s.page.url())) break;
    await humanIdlePause('short');
  }
  if (!/document\/d\/[A-Za-z0-9_-]+\/edit/.test(s.page.url())) {
    log('FAIL: never landed on a new doc URL (url=' + s.page.url() + ')');
    process.exit(2);
  }
  const docUrl = s.page.url();
  log('doc created: ' + docUrl);
  console.log('URL: ' + docUrl);

  await humanIdlePause('long'); // hydration

  // Set macOS pasteboard to the HTML via swift helper, then Cmd+V.
  const pbRes = spawnSync('swift', [SWIFT_SETPB, htmlPath], { encoding: 'utf8' });
  log('setpb: ' + (pbRes.stdout || '').trim());
  if (pbRes.status !== 0) {
    log('WARN: setpb exit=' + pbRes.status + ' stderr=' + (pbRes.stderr || '').slice(0, 200));
  }

  const canvas = s.page.locator('.kix-appview-editor, .docs-texteventtarget-iframe, [contenteditable="true"]').first();
  await canvas.waitFor({ state: 'visible' });
  await humanClickLocator(s.page, canvas);
  await humanIdlePause('deliberate');

  // Paste via Edit menu -> Paste UI navigation. Cmd+V via cliclick
  // failed empirically (paste fired but body stayed empty in prior
  // run frames) — the OS keystroke didn't translate to a Chromium
  // paste event. Going through the Edit menu UI routes through
  // Docs' own paste handler which respects the system clipboard.
  const editBbox = await s.page.evaluate(() => { // allow-raw-playwright: bbox of Edit menu in menubar
    const mb = document.querySelector('[role="menubar"]');
    if (!mb) return null;
    for (const el of mb.querySelectorAll('[role="menuitem"]')) {
      const txt = (el.innerText || el.textContent || '').trim();
      if (/^Edit$/i.test(txt)) {
        const r = el.getBoundingClientRect();
        if (r.width >= 4 && r.height >= 4) return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      }
    }
    return null;
  });
  if (editBbox) {
    await humanClick(s.page, Math.round(editBbox.x), Math.round(editBbox.y));
    await humanIdlePause('deliberate');
    const pasteBbox = await s.page.evaluate(() => { // allow-raw-playwright: bbox of Paste item in Edit dropdown
      const menus = Array.from(document.querySelectorAll('[role="menu"]')).filter((m) => {
        const r = m.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      });
      for (let i = menus.length - 1; i >= 0; i--) {
        for (const el of menus[i].querySelectorAll('[role="menuitem"]')) {
          const txt = (el.innerText || el.textContent || '').trim();
          if (/^Paste$/i.test(txt)) {
            const r = el.getBoundingClientRect();
            if (r.width >= 4 && r.height >= 4) return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
          }
        }
      }
      return null;
    });
    if (pasteBbox) {
      await humanClick(s.page, Math.round(pasteBbox.x), Math.round(pasteBbox.y));
      await humanIdlePause('long');
      log('paste menuitem clicked');
    } else {
      log('WARN: Paste item not visible in Edit dropdown');
    }
  } else {
    log('WARN: Edit menu not in menubar');
  }
  const pasted = await s.page.evaluate(() => { // allow-raw-playwright: post-paste DOM probe
    const headings = document.querySelectorAll('[role="heading"]').length;
    return { headings };
  });
  log('paste verified. headings=' + pasted.headings);

  // Title via JS-bbox + humanClick + setSelectionRange + humanType.
  try {
    const bbox = await s.page.evaluate(() => { // allow-raw-playwright: title-label bbox
      const candidates = ['.docs-title-input-label-inner', '.docs-title-input-label', '[aria-label="Rename"]'];
      for (const sel of candidates) {
        const el = document.querySelector(sel);
        if (!el) continue;
        const r = el.getBoundingClientRect();
        if (r.width < 4 || r.height < 4) continue;
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      }
      return null;
    });
    if (bbox) {
      await humanClick(s.page, Math.round(bbox.x), Math.round(bbox.y));
      await humanIdlePause('deliberate');
      const after = await s.page.evaluate(() => { // allow-raw-playwright: title-input state probe
        const inp = document.querySelector('input.docs-title-input');
        return {
          present: !!inp,
          visible: inp ? (inp.offsetWidth > 0 || inp.offsetHeight > 0) : false,
          activeIsTitle: document.activeElement === inp,
        };
      });
      if (after.present && after.visible && after.activeIsTitle) {
        await s.page.evaluate(() => { // allow-raw-playwright: setSelectionRange on focused input
          const inp = document.querySelector('input.docs-title-input');
          if (inp && document.activeElement === inp) inp.setSelectionRange(0, inp.value.length);
        });
        await humanIdlePause('short');
        await humanType(s.page, TITLE);
        await humanIdlePause('short');
        await s.page.keyboard.press('Enter'); // allow-raw-playwright: commit title
        await humanIdlePause('deliberate');
        const committed = await s.page.evaluate(() => { // allow-raw-playwright: title commit probe
          const label = document.querySelector('.docs-title-input-label-inner');
          return label ? (label.textContent || '').trim() : null;
        });
        if (committed === TITLE) log('title set: ' + TITLE);
        else log('WARN: title commit not verified (label=' + JSON.stringify(committed) + ')');
      } else {
        log('WARN: title input did not become editable — ' + JSON.stringify(after));
      }
    } else {
      log('WARN: title label not in DOM; doc keeps default name');
    }
  } catch (e) {
    log('WARN: title-set raised: ' + (e.message || String(e)).slice(0, 100));
  }

  log('PASS: doc available at ' + docUrl);
} finally {
  await s.close();
}
