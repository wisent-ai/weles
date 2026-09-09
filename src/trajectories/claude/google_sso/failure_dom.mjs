// The evidence a failed GIS handoff leaves behind: the DOM of every live page,
// written next to the run's other recordings, plus an index naming them.
//
// The 2026-08-17 investigation had to reconstruct the popup from session.har
// because the only DOM snapshot was the parent page's. So every live page is
// written here — and a page whose DOM could not be read or could not be stored
// is named in the index with its reason, because an evidence file that silently
// does not exist is the same dead end that investigation started from.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runRecordingsDir } from '../../../../dist/session/run-recordings.js';

export async function dumpGisFailureDom(pages, variant) {
  const dir = runRecordingsDir(process.env.ACTION || 'claude_login');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const written = [];
  const missing = [];
  for (let i = 0; i < pages.length; i += 1) {
    const { p, st, variant: v } = pages[i];
    if (p.isClosed()) continue;
    let html;
    try {
      html = await p.content();
    } catch (readError) {
      missing.push({ url: st?.url ?? null, variant: v, reason: `DOM not read: ${readError.message.slice(0, 200)}` });
      continue;
    }
    const path = join(dir, `gis_unhandled_${variant}_p${i}_${v}_${stamp}.html`);
    try {
      writeFileSync(path, html);
      written.push({ path, url: st?.url ?? null, title: st?.title ?? null, variant: v });
    } catch (writeError) {
      missing.push({ url: st?.url ?? null, variant: v, reason: `DOM not written to ${path}: ${writeError.message.slice(0, 200)}` });
    }
  }
  const indexPath = join(dir, `gis_unhandled_${variant}_${stamp}.json`);
  try { writeFileSync(indexPath, JSON.stringify({ variant, pages: written, missing }, null, 2)); }
  catch (indexError) { console.log(`[google_sso] the DOM index ${indexPath} could not be written: ${indexError.message.slice(0, 200)}`); }
  return { indexPath, written, missing };
}
