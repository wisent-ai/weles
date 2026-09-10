// App Store Connect analytics scraper: pulls app metrics (downloads, revenue, crashes) for each app.
// Requires valid session — run apple/login.mjs first to store cookies.
// Outputs JSON to stdout with per-app metrics.

import { getSocialAccount } from '../../../dist/utils/credentials.js';
import { WSession } from '../../../dist/session/wsession.js';

const acct = await getSocialAccount('apple');
if (!acct) { console.log('FAIL: no apple account'); process.exit(1); }

const s = await WSession.start({ label: 'apple_asc_analytics', proxy: process.env.PROXY_URL || undefined });
try {
  await s.goto('https://appstoreconnect.apple.com/apps');
  await s.wait(8);
  // If redirected to idmsa, session expired — bail
  if ((s.page.url?.() ?? '').includes('idmsa.apple.com')) {
    console.log('FAIL: session expired, rerun apple/login.mjs');
    process.exit(2);
  }
  // Scrape the apps list — each row has data-app-id, app name, bundle id
  const apps = await s.page.evaluate(`(() => {
    const rows = Array.from(document.querySelectorAll('tr[data-app-id], a[href*="/apps/"]'));
    return rows.slice(0, 20).map(r => ({
      id: r.getAttribute('data-app-id') || r.href?.match(/apps\\/(\\d+)/)?.[1],
      name: r.querySelector('[class*=name], [class*=title]')?.textContent?.trim() || r.textContent?.trim()?.slice(0, 60),
    })).filter(a => a.id);
  })()`).catch(() => []);
  console.log(`[asc-analytics] found ${apps.length} apps`);
  const results = [];
  for (const app of apps) {
    await s.goto(`https://appstoreconnect.apple.com/analytics/app/${app.id}/overview`);
    await s.wait(6);
    const metrics = await s.page.evaluate(`(() => {
      const grab = (label) => {
        const el = Array.from(document.querySelectorAll('*')).find(e => e.textContent?.trim().toLowerCase() === label.toLowerCase());
        return el?.parentElement?.querySelector('[class*=value], [class*=metric]')?.textContent?.trim() || null;
      };
      return {
        impressions: grab('Impressions'),
        downloads: grab('Total Downloads') || grab('Downloads'),
        sales: grab('Sales') || grab('Proceeds'),
        crashes: grab('Crashes'),
      };
    })()`).catch(() => ({}));
    results.push({ ...app, ...metrics });
    console.log(`[asc-analytics] ${app.name}:`, JSON.stringify(metrics));
  }
  console.log('PASS:', JSON.stringify(results));
} catch (e) {
  console.log('FAIL:', e.message?.slice(0, 200));
  process.exit(1);
} finally {
  await s.close();
}
