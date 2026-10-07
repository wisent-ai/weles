// The evidence a failed GIS handoff leaves behind: the DOM of every live page,
// written next to the run's other recordings, plus an index naming them.
//
// Include popup documents as well as the parent. The index names pages whose
// DOM could not be read or stored and records the corresponding failure.
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
      missing.push({
        url: st?.url ?? null,
        variant: v,
        reason: `DOM not read: ${readError.message}`,
      });
      continue;
    }
    const path = join(dir, `gis_unhandled_${variant}_p${i}_${v}_${stamp}.html`);
    try {
      writeFileSync(path, html);
      written.push({
        path,
        url: st?.url ?? null,
        title: st?.title ?? null,
        variant: v,
      });
    } catch (writeError) {
      missing.push({
        url: st?.url ?? null,
        variant: v,
        reason: `DOM not written to ${path}: ${writeError.message}`,
      });
    }
  }
  const indexPath = join(dir, `gis_unhandled_${variant}_${stamp}.json`);
  try {
    writeFileSync(
      indexPath,
      JSON.stringify({ variant, pages: written, missing }, null, 2),
    );
  } catch (indexError) {
    console.log(
      `[google_sso] the DOM index ${indexPath} could not be written: ${indexError.message}`,
    );
  }
  return { indexPath, written, missing };
}
