// Read-only inspector for the current NEW NCBR project IDs.
// Does not close the attached browser/page.

import { chromium } from 'playwright';

const endpoint = process.env.NCBR_CDP_ENDPOINT || 'http://127.0.0.1:9223';
const projectId = '7ee80d9a-67dd-4d99-becd-8dda407221c1';
const base = 'https://lsi2.ncbr.gov.pl';

const browser = await chromium.connectOverCDP(endpoint);
const context = browser.contexts()[0];
const page = context?.pages()[0];

if (!page) {
  console.log(JSON.stringify({ error: 'NO_PAGE' }, null, 2));
  process.exit(0);
}

await page.goto(`${base}/projekt/${projectId}/projekt_step/4e260fae-c455-41ce-bba3-d0df2a8767fd`, { waitUntil: 'domcontentloaded', timeout: 120000 });
await page.waitForTimeout(5000);

const result = await page.evaluate(async ({ base, projectId }) => {
  async function fetchText(path) {
    const res = await fetch(`${base}${path}`, { credentials: 'include', headers: { Accept: 'application/json' } });
    const text = await res.text();
    let data = null;
    try { data = JSON.parse(text); } catch {}
    return { status: res.status, text: text.slice(0, 1200), data };
  }

  const project = await fetchText(`/api/beneficiary/project/${projectId}`);
  const projectsPlural = await fetchText(`/api/beneficiary/projects/${projectId}`);
  const permissions = await fetchText(`/api/beneficiary/project/${projectId}/get-user-permissions`);
  const storage = {};
  for (const [k, v] of Object.entries(localStorage)) {
    if (/project|version|application|wniosek|beneficiary/i.test(k)) storage[k] = String(v).slice(0, 1000);
  }
  const resources = performance.getEntriesByType('resource')
    .map((e) => e.name)
    .filter((name) => /project-versions|project-sections|project\/|registries-values|APPLICATION_DATA/i.test(name))
    .slice(-80);
  return {
    href: location.href,
    project,
    projectsPlural,
    permissions,
    storage,
    resources,
  };
}, { base, projectId });

console.log(JSON.stringify(result, null, 2));
process.exit(0);
