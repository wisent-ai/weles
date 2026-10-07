import { pageSettled } from '../_shared/page/settled.mjs';
import { loginUnusualWhales } from './session/login.mjs';
// Fetch a specific sub-chart from the UW flow-overview page by clicking its
// tab and screenshotting just that chart element.
// Usage: node src/trajectories/unusualwhales/chart.mjs \
//          --ticker ORCL --tab "Net Prem" --out /path/to/out.png

console.log = (...a) => process.stderr.write(a.map(String).join(' ') + '\n');
const { WSession } = await import('../../../dist/session/wsession.js');
const { loadEnv } = await import('./_envload.mjs');
const { persistContext } = await import('./_persist.mjs');
loadEnv();

const args = {};
for (let i = 2; i < process.argv.length; i += 2) args[process.argv[i].replace(/^--/, '')] = process.argv[i + 1];
const ticker = (args.ticker || '').toUpperCase();
const tab = args.tab || 'Net Prem';
const outPath = args.out;
if (!ticker || !outPath) { console.error('FAIL: --ticker and --out required'); process.exit(1); }

const email = process.env.UW_EMAIL;
const password = process.env.UW_PASSWORD;
if (!email || !password) { console.error('FAIL: UW creds not set'); process.exit(1); }

const s = await WSession.start({ label: `uw_chart_${ticker}`, proxy: process.env.PROXY_URL || 'residential' });

try {
  await loginUnusualWhales(s, email, password);
  const url = `https://unusualwhales.com/stock/${ticker}/flow-overview`;
  console.error(`[chart] navigating to ${url}`);
  await s.goto(url);
  // The page has rendered when it has loaded and its DOM has gone quiet.
  await pageSettled(s.page);

  // Click the tab by matching button text — use Playwright locator with
  // exact-text filter so the click dispatches with isTrusted=true.
  const tabLoc = s.page.locator('button, a, div[role="tab"], [class*="tab"]').filter({ hasText: new RegExp(`^${tab.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}$`) }).first();
  const tabCount = await tabLoc.count();
  let clicked = { ok: false, count: tabCount };
  if (tabCount) { await tabLoc.scrollIntoViewIfNeeded().catch(() => {}); await tabLoc.click().catch(() => {}); clicked = { ok: true, tag: 'locator' }; }
  console.error(`[chart] clicked tab "${tab}": ${JSON.stringify(clicked)}`);
  if (!clicked.ok) {
    console.error(`FAIL: tab "${tab}" not found in page (candidates=${clicked.count})`);
    process.exit(1);
  }
  await pageSettled(s.page); // let chart re-render

  // Find the chart container: the page's largest svg/canvas by drawn area is
  // the chart (icons are smaller than it), and its container is the nearest
  // ancestor it shares with the clicked tab. No size thresholds are chosen.
  const box = await s.page.evaluate(`(tabText => {
    const all = Array.from(document.querySelectorAll('button, a, div[role="tab"], [class*="tab"]'));
    const active = all.find(e => e.innerText.trim() === tabText);
    if (!active) return { err: 'tab not found' };
    const area = (el) => { const r = el.getBoundingClientRect(); return r.width * r.height; };
    const chart = Array.from(document.querySelectorAll('svg, canvas'))
      .reduce((best, c) => (best && area(best) >= area(c) ? best : c), null);
    if (!chart || !area(chart)) return { err: 'no drawn svg or canvas on the page' };
    let node = chart.parentElement;
    while (node && !node.contains(active)) node = node.parentElement;
    if (!node) return { err: 'the chart shares no container with the tab' };
    const r = node.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height, chartArea: area(chart) };
  })(${JSON.stringify(tab)})`);
  console.error(`[chart] container search: ${JSON.stringify(box)}`);

  if (box && !box.err && box.width && box.height) {
    console.error(`[chart] screenshotting clip: ${JSON.stringify(box)}`);
    await s.page.screenshot({ path: outPath, clip: { x: box.x, y: box.y, width: box.width, height: box.height } });
  } else {
    console.error(`FAIL: no chart container found for tab "${tab}": ${JSON.stringify(box)}`);
    process.exit(1);
  }
  console.error(`[chart] saved to ${outPath}`);

  const persisted = await persistContext({
    ticker,
    page: 'chart',
    tab,
    data: { url, box, clickedTag: clicked.tag },
    screenshotPath: outPath,
    metadata: { source: 'chart.mjs' },
  });
  console.error(`[chart] persisted row id=${persisted.id} uri=${persisted.screenshot_uri || 'none'}`);
} catch (e) {
  console.error(`FAIL: ${e.message}`);
  process.exit(1);
} finally {
  await s.close().catch(() => {});
}
