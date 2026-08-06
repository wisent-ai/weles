// Probe NCBR LSI 6.5 collection routes from the already-open authenticated page.
// This does not create or update records. It only calls GET/HEAD/OPTIONS on
// route variants to find any raw list endpoint that can expose row IDs.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { WSession } from '../../../dist/session/wsession.js';
import { runRecordingsDir } from '../../../dist/session/run-recordings.js';

const LABEL = 'ncbr_probe_6_5_collection_routes';
const OUT_DIR = runRecordingsDir(LABEL);
mkdirSync(OUT_DIR, { recursive: true });

const BASE = 'https://lsi2.ncbr.gov.pl';
const VERSION_ID = 'a11cf7c9-9306-4ac6-a43a-7048789ce0ff';
const SECTION_ID = 'bdb2c7b3-92d9-4778-9ecc-b4c5bda7d32b';
const COLLECTION = 'koszty_posrednie_kolekcja';
const PREFIX = `${BASE}/api/beneficiary/project-versions/${VERSION_ID}/project-sections/${SECTION_ID}/registries-values`;

const urls = [
  `${PREFIX}`,
  `${PREFIX}/${COLLECTION}`,
  `${PREFIX}/${COLLECTION}/`,
  `${PREFIX}/${COLLECTION}?itemsPerPage=50&page=1`,
  `${PREFIX}/${COLLECTION}/collection-objects`,
  `${PREFIX}/${COLLECTION}/collection-objects/`,
  `${PREFIX}/${COLLECTION}/collection-objects?itemsPerPage=50&page=1`,
  `${PREFIX}/${COLLECTION}/collection-objects?pagination=false`,
  `${PREFIX}/${COLLECTION}/collection-objects.json`,
  `${PREFIX}/${COLLECTION}/collection-objects/list`,
  `${PREFIX}/${COLLECTION}/collection-objects/search`,
];

async function request(page, method, url) {
  return await page.evaluate(async ({ method, url }) => {
    try {
      const res = await fetch(url, {
        method,
        credentials: 'include',
        headers: { Accept: 'application/json' },
      });
      const text = method === 'HEAD' ? '' : await res.text();
      return {
        method,
        url,
        status: res.status,
        statusText: res.statusText,
        allow: res.headers.get('allow'),
        contentType: res.headers.get('content-type'),
        text: text.slice(0, 1600),
      };
    } catch (error) {
      return {
        method,
        url,
        error: String(error?.message || error),
      };
    }
  }, { method, url });
}

const s = await WSession.start({
  label: LABEL,
  operatorCdp: true,
  record: false,
});

const report = [];
try {
  for (const url of urls) {
    for (const method of ['HEAD', 'GET', 'OPTIONS']) {
      report.push(await request(s.page, method, url));
    }
  }
  writeFileSync(join(OUT_DIR, 'routes.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally {
  await s.close();
}
