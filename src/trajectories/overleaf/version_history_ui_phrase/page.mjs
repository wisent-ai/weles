// The page basics: text normalisation, the summary writer, DOM dumps, clicking visible
// text and reaching the dashboard.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runRecordingsDir } from '../../../../dist/session/run-recordings.js';
import { humanClickLocator, humanIdlePause } from '../../../../dist/human/mouse.js';
import { OUTPUT_PATH, OUT_DIR } from './settings.mjs';

export function norm(s) {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

export function writeSummary(summary) {
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
export async function dump(s, tag) {
  shotN += 1;
  const base = `${OUT_DIR}/${String(shotN).padStart(2, '0')}_${tag}`;
  const html = await s.page.content().catch(() => '');
  const text = await s.page.evaluate(() => document.body.innerText).catch(() => '');
  writeFileSync(`${base}.html`, html);
  writeFileSync(`${base}.txt`, text);
  console.log(`[version_history_ui] ${tag} url=${s.page.url()} html=${base}.html text=${base}.txt`);
  return { html: `${base}.html`, text: `${base}.txt`, bodyText: text };
}

export async function clickText(page, re) {
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

export async function ensureDashboard(s) {
  await s.goto('https://www.overleaf.com/project');
  await humanIdlePause('deliberate');
  const current = s.page.url();
  const body = await s.page.evaluate(() => document.body.innerText).catch(() => '');
  if (/\/login(?:[/?#]|$)/.test(current) || /Log in with Google|Log in/i.test(body.slice(0, 1000))) {
    return false;
  }
  return true;
}
