// Create a Google Doc with FORMATTED content by enabling Docs'
// built-in "Automatically detect Markdown" preference, then typing
// cleaned markdown. The auto-detection converts # headings, **bold**,
// `code`, - bullets etc. to real Docs formatting as the characters
// land. Bypasses clipboard / paste entirely (those paths get
// intercepted by Docs' canvas-rendered editor).
//
// Content preprocessing strips HTML comments and converts the
// <!-- value name="X" --> ... <!-- /value --> validator markers into
// "**Answer:** <value>" lines so the rendered Doc reads as a clean
// Q+A form rather than markdown source with scaffolding.
//
// Run:
//   node weles/scripts/trajectories/google/drive/paste_doc.mjs \
//     --title "..." --content path/to/file.md
//
// Env mirror: DOC_TITLE, DOC_CONTENT_PATH, GM_EMAIL, GM_PASSWORD, BROWSER.

import { WSession } from '../../../../dist/session/wsession.js';
import { googleSso, getGoogleSsoCreds } from '../../_shared/services/google_sso.mjs';
import { humanClick, humanClickLocator, humanIdlePause } from '../../../../dist/human/mouse.js';
import { humanType } from '../../../../dist/human/keyboard.js';
import { readFileSync } from 'node:fs';

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const TITLE = arg('--title') || process.env.DOC_TITLE;
const CONTENT_PATH = arg('--content') || process.env.DOC_CONTENT_PATH;
const LABEL = 'drive_paste_doc';

if (!TITLE) { console.log('FAIL: --title (or DOC_TITLE) required'); process.exit(2); }
if (!CONTENT_PATH) { console.log('FAIL: --content (or DOC_CONTENT_PATH) required'); process.exit(2); }

const rawContent = readFileSync(CONTENT_PATH, 'utf8');

function log(...a) { console.log('[drive_paste_doc]', ...a); }

// Convert the draft's value-marker scaffolding into readable
// "**Answer:** <value>" lines, strip remaining HTML comments. Keeps
// markdown structure intact (headings, lists, bold, code) so Docs'
// markdown auto-detect can format on the fly during humanType.
function cleanContent(md) {
  let out = md.replace(/<!--\s*value\s+name="([^"]+)"[^>]*-->([\s\S]*?)<!--\s*\/value\s*-->/g, (_, _name, body) => {
    const v = body.trim();
    if (v === '') return '**Answer:** _(empty)_';
    return '**Answer:** ' + v;
  });
  out = out.replace(/<!--[\s\S]*?-->/g, '');
  return out;
}

async function resolveCreds() {
  const email = process.env.GM_EMAIL || 'lukasz.bartoszcze@gmail.com';
  if (process.env.GM_PASSWORD) return { email, password: process.env.GM_PASSWORD };
  const fromDb = await getGoogleSsoCreds(email);
  if (fromDb?.password) return fromDb;
  throw new Error('No password: set GM_PASSWORD or add a service_credentials row for ' + email);
}

const cleaned = cleanContent(rawContent);
log('clean: ' + rawContent.length + ' chars raw -> ' + cleaned.length + ' chars cleaned');

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

  // Enable "Automatically detect Markdown" so humanType characters
  // render as real headings / bold / lists. Strictly scope Tools to
  // the Docs menubar (prior run clicked a Smart Chip-related menuitem
  // and opened the Gemini notes panel — preferences dialog never
  // appeared). Logs menubar contents on miss for debugging.
  try {
    const menubarItems = await s.page.evaluate(() => { // allow-raw-playwright: read-only DOM scrape of menubar
      const mb = document.querySelector('[role="menubar"]');
      if (!mb) return { hasMenubar: false, items: [] };
      const items = Array.from(mb.querySelectorAll('[role="menuitem"]'));
      return {
        hasMenubar: true,
        items: items.map((el) => {
          const r = el.getBoundingClientRect();
          return {
            txt: (el.innerText || el.textContent || '').trim().slice(0, 40),
            x: r.x + r.width / 2,
            y: r.y + r.height / 2,
            w: r.width, h: r.height,
          };
        }),
      };
    });
    log('menubar items: ' + JSON.stringify(menubarItems.items.map((i) => i.txt)));
    let tools = null;
    for (const it of menubarItems.items) {
      if (/^Tools$/i.test(it.txt)) { tools = it; break; }
    }
    if (tools) {
      await humanClick(s.page, Math.round(tools.x), Math.round(tools.y));
      await humanIdlePause('deliberate');
      const prefBbox = await s.page.evaluate(() => { // allow-raw-playwright: read-only bbox of Preferences menu item
        const items = Array.from(document.querySelectorAll('[role="menuitem"]'));
        for (const el of items) {
          const txt = (el.innerText || el.textContent || '').trim();
          if (/^Preferences$/i.test(txt)) {
            const r = el.getBoundingClientRect();
            if (r.width >= 4 && r.height >= 4) return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
          }
        }
        return null;
      });
      if (prefBbox) {
        await humanClick(s.page, Math.round(prefBbox.x), Math.round(prefBbox.y));
        await humanIdlePause('deliberate');
        await humanIdlePause('deliberate');
        const mdProbe = await s.page.evaluate(() => { // allow-raw-playwright: read-only scrape of Preferences dialog
          const dlg = document.querySelector('[role="dialog"]');
          const root = dlg ? dlg : document;
          const checkboxes = Array.from(root.querySelectorAll('[role="checkbox"]')).map((cb) => {
            const r = cb.getBoundingClientRect();
            const parent = cb.closest('label');
            const ancestor = parent ? parent : cb.closest('div');
            const labelText = ancestor ? (ancestor.innerText || ancestor.textContent || '').trim().slice(0, 200) : '';
            return {
              labelText,
              isChecked: cb.getAttribute('aria-checked') === 'true',
              x: r.x + r.width / 2,
              y: r.y + r.height / 2,
            };
          });
          return { checkboxes, dialogTitle: dlg ? (dlg.querySelector('h1, h2, h3, [role="heading"]')?.textContent || '').trim() : '(no dialog)' };
        });
        log('preferences dialog title: ' + mdProbe.dialogTitle + ' / checkboxes: ' + mdProbe.checkboxes.length);
        let md = null;
        for (const cb of mdProbe.checkboxes) {
          if (/markdown/i.test(cb.labelText)) { md = cb; break; }
        }
        if (md && !md.isChecked) {
          await humanClick(s.page, Math.round(md.x), Math.round(md.y));
          await humanIdlePause('short');
          log('markdown auto-detect: enabled');
        } else if (md && md.isChecked) {
          log('markdown auto-detect: already enabled');
        } else {
          log('WARN: markdown checkbox not found. labels=' + JSON.stringify(mdProbe.checkboxes.map((c) => c.labelText.slice(0, 60))));
        }
        const okBbox = await s.page.evaluate(() => { // allow-raw-playwright: read-only bbox of OK button
          const btns = Array.from(document.querySelectorAll('button, [role="button"]'));
          for (const el of btns) {
            const txt = (el.innerText || el.textContent || '').trim();
            if (/^(OK|Done)$/i.test(txt)) {
              const r = el.getBoundingClientRect();
              if (r.width >= 4 && r.height >= 4) return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
            }
          }
          return null;
        });
        if (okBbox) {
          await humanClick(s.page, Math.round(okBbox.x), Math.round(okBbox.y));
          await humanIdlePause('deliberate');
        }
      } else {
        log('WARN: Preferences menuitem not visible after Tools click');
      }
    } else {
      log('WARN: "Tools" not in menubar — markdown auto-detect not enabled');
    }
  } catch (e) {
    log('WARN: enabling markdown auto-detect raised: ' + (e.message || String(e)).slice(0, 100));
  }

  // Click body canvas and type the cleaned content.
  const canvas = s.page.locator('.kix-appview-editor, .docs-texteventtarget-iframe, [contenteditable="true"]').first();
  await canvas.waitFor({ state: 'visible' });
  await humanClickLocator(s.page, canvas);
  await humanIdlePause('deliberate');
  log('typing ' + cleaned.length + ' chars');
  await humanType(s.page, cleaned);
  await humanIdlePause('long');
  log('body typed');

  try {
    const bbox = await s.page.evaluate(() => { // allow-raw-playwright: read-only bbox lookup of the title label
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
      const after = await s.page.evaluate(() => { // allow-raw-playwright: read-only DOM probe
        const inp = document.querySelector('input.docs-title-input');
        return {
          present: !!inp,
          visible: inp ? (inp.offsetWidth > 0 || inp.offsetHeight > 0) : false,
          activeIsTitle: document.activeElement === inp,
        };
      });
      if (after.present && after.visible && after.activeIsTitle) {
        await s.page.evaluate(() => { // allow-raw-playwright: read-only setSelectionRange on focused input
          const inp = document.querySelector('input.docs-title-input');
          if (inp && document.activeElement === inp) inp.setSelectionRange(0, inp.value.length);
        });
        await humanIdlePause('short');
        await humanType(s.page, TITLE);
        await humanIdlePause('short');
        await s.page.keyboard.press('Enter'); // allow-raw-playwright: commit-title Enter press
        await humanIdlePause('deliberate');
        const committed = await s.page.evaluate(() => { // allow-raw-playwright: read-only DOM probe of committed title
          const label = document.querySelector('.docs-title-input-label-inner');
          return label ? (label.textContent || '').trim() : null;
        });
        if (committed === TITLE) log('title set: ' + TITLE);
        else log('WARN: title commit not verified (label=' + JSON.stringify(committed) + ' expected=' + JSON.stringify(TITLE) + ')');
      } else {
        log('WARN: title input did not become editable after click — ' + JSON.stringify(after));
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
