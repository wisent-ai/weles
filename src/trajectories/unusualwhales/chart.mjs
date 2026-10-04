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

  // Find the chart container. The tab may be many levels above the chart
  // (or in a sibling). Try: closest ancestor that has BOTH the tab text AND
  // an svg/canvas whose height > 200 (a real chart, not an icon).
  const box = await s.page.evaluate(`(tabText => {
    const all = Array.from(document.querySelectorAll('button, a, div[role="tab"], [class*="tab"]'));
    const active = all.find(e => e.innerText.trim() === tabText);
    if (!active) return { err: 'tab not found' };
    let node = active.parentElement;
    for (let i = 0; i < 15 && node; i++) {
      const charts = node.querySelectorAll('svg, canvas');
      for (const c of charts) {
        const cr = c.getBoundingClientRect();
        if (cr.height > 200 && cr.width > 200) {
          const r = node.getBoundingClientRect();
          return { x: r.x, y: r.y, width: r.width, height: r.height, depth: i, chartH: cr.height };
        }
      }
      node = node.parentElement;
    }
    // No ancestor chart found — try all large SVGs/canvases on the page
    const big = Array.from(document.querySelectorAll('svg, canvas'))
      .map(c => ({ c, r: c.getBoundingClientRect() }))
      .filter(x => x.r.height > 200 && x.r.width > 400)
      .sort((a,b) => b.r.height * b.r.width - a.r.height * a.r.width);
    if (big.length) {
      // Assume the first (largest) is the active chart. Get its container.
      let n = big[0].c.parentElement;
      for (let i = 0; i < 5 && n; i++) {
        const r = n.getBoundingClientRect();
        if (r.height > big[0].r.height + 40) {
          return { x: r.x, y: r.y, width: r.width, height: r.height, note: 'used largest svg' };
        }
        n = n.parentElement;
      }
      const r = big[0].r;
      return { x: r.x, y: r.y, width: r.width, height: r.height, note: 'svg itself' };
    }
    return { err: 'no chart found' };
  })(${JSON.stringify(tab)})`);
  console.error(`[chart] container search: ${JSON.stringify(box)}`);

  if (box && !box.err && box.width > 100 && box.height > 100) {
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
