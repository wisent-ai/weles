// Repair/probe NCBR LSI section 6.5 using the already-open authenticated page.
//
// This is intentionally a Weles trajectory, not a standalone CDP helper in the
// application repo. It attaches to the existing browser debugging endpoint and
// uses the page's own authenticated fetch context. It does not click or type in
// the UI.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { WSession } from '../../../dist/session/wsession.js';
import { runRecordingsDir } from '../../../dist/session/run-recordings.js';

const LABEL = 'ncbr_repair_6_5_existing_window';
const OUT_DIR = runRecordingsDir(LABEL);
mkdirSync(OUT_DIR, { recursive: true });

const BASE = 'https://lsi2.ncbr.gov.pl';
const VERSION_ID = 'a11cf7c9-9306-4ac6-a43a-7048789ce0ff';
const PROJECT_ID = '433468ab-ff8a-4bd2-9f03-7da65ba73e1f';
const SECTION_6_5 = 'bdb2c7b3-92d9-4778-9ecc-b4c5bda7d32b';
const COLLECTION = 'koszty_posrednie_kolekcja';
const GOOD_RYCZALT = '1bce6c18-c3c3-4391-bfc3-4b17b56e680a';

const urls = {
  auth: `${BASE}/api/beneficiary/project/${PROJECT_ID}/get-user-permissions`,
  values: `${BASE}/api/beneficiary/project-versions/${VERSION_ID}/project-sections/${SECTION_6_5}/registries-values`,
  projectRegistries: `${BASE}/api/beneficiary/project-versions/${VERSION_ID}/project-registries`,
  collection: `${BASE}/api/beneficiary/project-versions/${VERSION_ID}/project-sections/${SECTION_6_5}/registries-values/${COLLECTION}/collection-objects`,
  validate: `${BASE}/api/beneficiary/project-versions/${VERSION_ID}/validate-project`,
};

async function browserFetch(page, url, options = {}) {
  return await page.evaluate(
    async ({ url, options }) => {
      const res = await fetch(url, {
        credentials: 'include',
        headers: { Accept: 'application/json', ...(options.headers || {}) },
        ...options,
      });
      const text = await res.text();
      let data = null;
      try { data = JSON.parse(text); } catch {}
      return {
        status: res.status,
        statusText: res.statusText,
        headers: Object.fromEntries(res.headers.entries()),
        text: text.slice(0, 4000),
        data,
      };
    },
    { url, options },
  );
}

const s = await WSession.start({
  label: LABEL,
  operatorCdp: true,
  record: false,
});

const report = {
  pageUrl: await s.page.url(),
  target: { section: SECTION_6_5, collection: COLLECTION, goodRyczalt: GOOD_RYCZALT },
  steps: [],
};

try {
  report.steps.push({ name: 'auth', result: await browserFetch(s.page, urls.auth) });
  report.steps.push({ name: 'before_values', result: await browserFetch(s.page, urls.values) });

  // Probe whether the collection endpoint can clear the collection directly.
  // If the backend supports DELETE at collection level, this is the exact fix:
  // remove corrupted rows, then section values should become readable.
  report.steps.push({
    name: 'delete_collection_endpoint',
    result: await browserFetch(s.page, urls.collection, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
    }),
  });

  report.steps.push({ name: 'after_delete_values', result: await browserFetch(s.page, urls.values) });

  // If direct clear did not work, try validation only to get a richer server
  // payload. This endpoint is what the UI calls for "Sprawdź wniosek"; it can
  // return structured validation paths, but may fail with the same SQL error.
  report.steps.push({
    name: 'validate_project',
    result: await browserFetch(s.page, urls.validate, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    }),
  });

  writeFileSync(join(OUT_DIR, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally {
  await s.close();
}
