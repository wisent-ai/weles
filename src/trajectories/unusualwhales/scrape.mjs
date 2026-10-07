import { pageSettled } from '../_shared/page/settled.mjs';
// Scrape unusualwhales.com ticker data using cached session cookies.
// Usage: node src/trajectories/unusualwhales/scrape.mjs --ticker ORCL --page overview
//   pages: overview | flow | darkpool | gex
//   optional: --screenshot /path/to/out.png
// Outputs JSON to stdout on success, non-zero exit on failure.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// Redirect all console.log to stderr so stdout is pure JSON output.
console.log = (...a) => process.stderr.write(a.map(String).join(' ') + '\n');

const { WSession } = await import('../../../dist/session/wsession.js');
const { loadEnv } = await import('./_envload.mjs');
const { persistContext } = await import('./_persist.mjs');

loadEnv();

// Parse args
const args = {};
for (let i = 2; i < process.argv.length; i += 2) {
  args[process.argv[i].replace(/^--/, '')] = process.argv[i + 1];
}
const ticker = (args.ticker || process.env.TICKER || '').toUpperCase();
const page = args.page || process.env.PAGE || 'overview';
// `pages` is comma-separated; if present, scrape all of them in one
// Playwright session (login once, navigate per page, persist per page).
// Single-job-per-ticker shape — replaces the old one-job-per-page blast.
const pagesArg = args.pages || process.env.PAGES || '';
const pagesList = pagesArg
  ? pagesArg
      .split(',')
      .map((p) => p.trim())
      .filter(Boolean)
  : null;
const screenshotPath = args.screenshot;
const startDate = args['start-date'] || process.env.START_DATE || '';
const endDate = args['end-date'] || process.env.END_DATE || '';
const qs = (() => {
  const p = new URLSearchParams();
  if (startDate) p.set('start_date', startDate);
  if (endDate) p.set('end_date', endDate);
  if (startDate && !endDate) p.set('end_date', startDate);
  const s = p.toString();
  return s ? `?${s}` : '';
})();
if (!ticker) {
  console.error('FAIL: --ticker required');
  process.exit(1);
}

// Every path below was extracted live from the authenticated UW sidebar
// via src/trajectories/unusualwhales/_probe_urls.mjs. Do not add a
// page here without verifying it appears in the <a href> list that probe
// emits, otherwise the scrape will hit a 404.
const PAGE_URLS = {
  // The options-flow page accepts a ticker and a bounded history limit.
  option_flow_alerts: (t) =>
    `https://unusualwhales.com/option-flow-alerts?ticker_symbol=${t}&limit=500`,
  overview: (t) => `https://unusualwhales.com/stock/${t}/overview${qs}`,
  chart: (t) => `https://unusualwhales.com/stock/${t}/chart${qs}`,
  flow_alerts: (t) => `https://unusualwhales.com/stock/${t}/flow-alerts${qs}`,
  flow_history: (t) =>
    `https://unusualwhales.com/stock/${t}/options-flow-history${qs}`,
  flow_overview: (t) =>
    `https://unusualwhales.com/stock/${t}/flow-overview${qs}`,
  net_premium: (t) => `https://unusualwhales.com/stock/${t}/net-premium${qs}`,
  nope: (t) => `https://unusualwhales.com/stock/${t}/nope${qs}`,
  darkpool: (t) => `https://unusualwhales.com/stock/${t}/darkpool${qs}`,
  greeks: (t) => `https://unusualwhales.com/stock/${t}/greeks`,
  greek_exposure: (t) => `https://unusualwhales.com/stock/${t}/greek-exposure`,
  chains: (t) => `https://unusualwhales.com/stock/${t}/option-chains`,
  oi_changes: (t) =>
    `https://unusualwhales.com/stock/${t}/open-interest-changes`,
  options_charting: (t) =>
    `https://unusualwhales.com/stock/${t}/options-charting`,
  volatility: (t) => `https://unusualwhales.com/stock/${t}/volatility`,
  insiders: (t) => `https://unusualwhales.com/stock/${t}/insiders`,
  institutions: (t) => `https://unusualwhales.com/stock/${t}/institutions`,
  shorts: (t) => `https://unusualwhales.com/stock/${t}/shorts`,
  analysts: (t) => `https://unusualwhales.com/stock/${t}/analysts`,
  earnings: (t) => `https://unusualwhales.com/stock/${t}/earnings`,
  dividends: (t) => `https://unusualwhales.com/stock/${t}/dividends`,
  financials: (t) => `https://unusualwhales.com/stock/${t}/financials`,
  risk: (t) => `https://unusualwhales.com/stock/${t}/risk`,
  seasonality: (t) => `https://unusualwhales.com/stock/${t}/seasonality`,
  stock_talk: (t) => `https://unusualwhales.com/stock/${t}/stock-talk`,
};
if (!PAGE_URLS[page]) {
  console.error(
    `FAIL: unknown page '${page}', must be one of: ${Object.keys(PAGE_URLS).join(', ')}`,
  );
  process.exit(1);
}

const email = process.env.UW_EMAIL;
const password = process.env.UW_PASSWORD;
if (!email || !password) {
  console.error('FAIL: UW_EMAIL and UW_PASSWORD must be set in weles/.env');
  process.exit(1);
}

// UW is a paid SaaS dashboard we authenticate to with a single shared
// session; per-request residential rotation is not required and the
// residential pool's pre-flight checks have repeatedly failed on the
// mac-mini host. Default to direct (no proxy). Set PROXY_URL=residential
// (or pass --proxy=residential via params.proxy_url_override) to opt in.
const proxyUrl = process.env.PROXY_URL || 'direct';
const s = await WSession.start({
  label: `uw_scrape_${ticker}`,
  proxy: proxyUrl,
});
global._s = s;

async function doLogin(sess) {
  console.error('[uw_scrape] logging in');
  await sess.goto('https://unusualwhales.com/login');
  await sess.page.waitForFunction(
    () => document.querySelectorAll('input').length >= 2,
  );
  const inputs = await sess.page.evaluate(
    `(() => Array.from(document.querySelectorAll('input')).map((i, idx) => ({ idx, name: i.name, type: i.type, id: i.id, ph: i.placeholder })))()`,
  );
  const emailIn = inputs.find(
    (i) =>
      i.type === 'email' ||
      i.name === 'email' ||
      /email|address/i.test(i.ph || ''),
  );
  const passIn = inputs.find(
    (i) => i.type === 'password' || i.name === 'password',
  );
  if (!emailIn || !passIn) {
    console.error(`FAIL: login inputs not found: ${JSON.stringify(inputs)}`);
    process.exit(1);
  }
  const sel = (i) =>
    i.name
      ? `input[name="${i.name}"]`
      : i.id
        ? `input[id="${i.id}"]`
        : `input[placeholder="${i.ph}"]`;
  const submit = async () => {
    const submitLoc = sess.page
      .locator('button[type="submit"], input[type="submit"]')
      .first();
    if (await submitLoc.count()) await submitLoc.click().catch(() => {});
    else
      await sess.page
        .evaluate('document.querySelector("form")?.requestSubmit()')
        .catch(() => {});
  };
  // After a submit the page either leaves /login or settles on it.
  const redirected = async () => {
    await pageSettled(sess.page);
    if (sess.page.url().includes('/login')) return false;
    console.error(`[uw_scrape] logged in, now at ${sess.page.url()}`);
    return true;
  };
  // UW's login carries a risk-based Google reCAPTCHA v2 checkbox that silently
  // auto-passes for low-risk sessions and only demands an image challenge
  // otherwise. So submit with plain credentials first (the common case), and
  // only pay for a captcha solve when that submit is actually blocked.
  await sess.fillSelector(sel(emailIn), email);
  await sess.fillSelector(sel(passIn), password);
  await submit();
  if (await redirected()) return;
  console.error('[uw_scrape] plain submit blocked — attempting captcha solve');
  await sess.goto('https://unusualwhales.com/login');
  await sess.fillSelector(sel(emailIn), email);
  await sess.fillSelector(sel(passIn), password);
  console.error(`[uw_scrape] captcha: ${await sess.solveCaptcha()}`);
  await submit();
  if (await redirected()) return;
  throw new Error(
    `login did not leave /login after the captcha; still at ${sess.page.url()}`,
  );
}

// Scrape one UW page within an already-authenticated Playwright session.
async function scrapeOnePage(sess, tk, pg, ssPath) {
  if (!PAGE_URLS[pg]) {
    console.error(`[uw_scrape] unknown page '${pg}'`);
    return { skipped: true, reason: 'unknown_page' };
  }
  const url = PAGE_URLS[pg](tk);
  console.error(`[uw_scrape] [${pg}] -> ${url}`);
  await sess.goto(url);
  // The page has rendered when it has loaded and its DOM has gone quiet; a
  // count of seconds, a 500-character body and a reload at the fifteenth were
  // guesses at that.
  await pageSettled(sess.page);
  // Select the available time-range preset before extracting alerts.
  if (pg === 'option_flow_alerts') {
    try {
      const timeBtn = sess.page
        .locator('button:has-text("TIME RANGE")')
        .first();
      if (await timeBtn.count()) {
        await timeBtn.click();
        await pageSettled(sess.page);
        const last7 = sess.page
          .locator('button:has-text("Last 7 Days")')
          .first();
        if (await last7.count()) {
          await last7.click();
          await pageSettled(sess.page);
        }
        const applyBtn = sess.page.locator('button:has-text("Apply")').first();
        if (await applyBtn.count()) {
          await applyBtn.click();
          await pageSettled(sess.page);
        }
        console.error(`[uw_scrape] [${pg}] applied Last 7 Days TIME RANGE`);
      }
    } catch (e) {
      console.error(`[uw_scrape] [${pg}] TIME RANGE drive threw: ${e.message}`);
    }
  }
  const authStatus = await sess.page.evaluate(() => {
    const b = document.body?.innerText || '';
    return {
      stale: /Viewing data from.*days ago.*Subscribe for live/i.test(b),
      guest: /Sign In/.test(b) && !/Sign Out/.test(b),
    };
  }); // allow-raw-playwright: read-only DOM
  // UW renders inside inner scroll container; `fullPage:true` misses it.
  // Resize viewport to deepest scrollHeight, snapshot, restore.
  if (ssPath) {
    try {
      // The deepest scroll container's own height, plus nothing chosen here.
      const maxH = await sess.page.evaluate(() => {
        let h = Math.max(
          document.documentElement.scrollHeight || 0,
          document.body?.scrollHeight || 0,
        );
        for (const el of document.querySelectorAll('*')) {
          const st = getComputedStyle(el);
          if (
            (st.overflowY === 'auto' || st.overflowY === 'scroll') &&
            el.scrollHeight > el.clientHeight
          )
            h = Math.max(h, el.scrollHeight);
        }
        return h;
      });
      const origVp = sess.page.viewportSize();
      if (maxH > origVp.height)
        await sess.page.setViewportSize({ width: origVp.width, height: maxH }); // allow-raw-playwright: viewport resize for full-content capture
      await pageSettled(sess.page);
      await sess.page.screenshot({ path: ssPath, fullPage: false }); // allow-raw-playwright: viewport-sized PNG (sized to full content)
      if (maxH > origVp.height) await sess.page.setViewportSize(origVp); // allow-raw-playwright: restore
      console.error(`[uw_scrape] [${pg}] screenshot at ${maxH}px tall`);
    } catch (e) {
      console.error(`[uw_scrape] [${pg}] screenshot threw: ${e.message}`);
    }
  }
  const data = await sess.page.evaluate(() => {
    // allow-raw-playwright: read-only DOM extraction
    const out = { url: location.href, title: document.title };
    out.tables = Array.from(document.querySelectorAll('table')).map((t) => ({
      headers: Array.from(t.querySelectorAll('thead th, thead td')).map((h) =>
        h.innerText.trim(),
      ),
      rows: Array.from(t.querySelectorAll('tbody tr')).map((r) =>
        Array.from(r.querySelectorAll('td, th')).map((c) => c.innerText.trim()),
      ),
    }));
    // Non-table extractors for UW pages that render charts/cards/SVG instead of tables.
    out.cards = Array.from(
      document.querySelectorAll(
        '[class*="card" i], [class*="Card" i], [class*="kpi" i], [class*="metric" i]',
      ),
    )
      .map((el) => {
        const label =
          el
            .querySelector('[class*="label" i], [class*="title" i], h3, h4, h5')
            ?.innerText?.trim() || '';
        const value =
          el
            .querySelector('[class*="value" i], [class*="figure" i], strong, b')
            ?.innerText?.trim() ||
          el.innerText?.trim() ||
          '';
        return { label, value };
      })
      .filter((c) => c.label || c.value);
    // ChartIQ / Highcharts / Recharts / D3 series data — every <path d="M...">
    // SVG path that draws a line or bar plus the data-point text labels.
    out.svgSeries = Array.from(document.querySelectorAll('svg')).map((svg) => ({
      pathCount: svg.querySelectorAll('path').length,
      circleCount: svg.querySelectorAll('circle').length,
      rectCount: svg.querySelectorAll('rect').length,
      textLabels: Array.from(svg.querySelectorAll('text'))
        .map((t) => t.innerText?.trim() || t.textContent?.trim() || '')
        .filter(Boolean),
      ariaLabels: Array.from(svg.querySelectorAll('[aria-label]'))
        .map((e) => e.getAttribute('aria-label'))
        .filter(Boolean),
    }));
    // ChartIQ canvas charts expose data via window.CIQ — capture if present.
    out.ciq =
      typeof window.CIQ !== 'undefined' ? Object.keys(window.CIQ) : null;
    // Highcharts data accessor
    if (typeof window.Highcharts !== 'undefined' && window.Highcharts.charts) {
      out.highcharts = window.Highcharts.charts.filter(Boolean).map((c) =>
        c.series?.map((s) => ({
          name: s.name,
          dataLen: s.data?.length || 0,
          data: (s.data || []).map((d) => ({ x: d.x, y: d.y })),
        })),
      );
    }
    out.bodyText = document.body?.innerText || '';
    return out;
  });
  const persisted = await persistContext({
    ticker: tk,
    page: pg,
    data,
    screenshotPath: ssPath,
    metadata: { auth: authStatus, source: 'scrape.mjs' },
  });
  console.error(`[uw_scrape] [${pg}] persisted=${persisted.id}`);
  return { data, persisted };
}

try {
  await doLogin(s);
  await pageSettled(s.page);
  const allPages = pagesList && pagesList.length > 0 ? pagesList : [page];
  const results = [];
  for (const pg of allPages) {
    // Per-page screenshot: in single-page mode, honor the --screenshot CLI
    // path if provided; otherwise (multi-page or no path) write a temp PNG
    // per page so persistContext can upload each to Stado alongside its
    // stock_context row. Previously multi-page mode silently passed null
    // here, so 25-page jobs produced zero screenshots.
    const ssPath =
      allPages.length === 1 && screenshotPath
        ? screenshotPath
        : path.join(os.tmpdir(), `uw_${ticker}_${pg}_${Date.now()}.png`);
    try {
      results.push({
        page: pg,
        ...(await scrapeOnePage(s, ticker, pg, ssPath)),
      });
    } catch (e) {
      console.error(`[uw_scrape] [${pg}] threw: ${e.message}`);
      results.push({ page: pg, error: e.message });
    }
    if (ssPath !== screenshotPath) {
      try {
        fs.unlinkSync(ssPath);
      } catch (e) {
        /* tolerable */
      }
    }
    // Free renderer memory before next page (SIGKILL 137 happened at 24000px cap).
    try {
      await s.goto('about:blank');
    } catch (e) {
      console.error(`[uw_scrape] about:blank: ${e.message}`);
    }
  }
  process.stdout.write(
    JSON.stringify({ ticker, pages: allPages, results }) + '\n',
  );
  process.exit(0);
} catch (e) {
  console.error(`FAIL: ${e.message}`);
  process.exit(1);
} finally {
  await (global._s || s).close().catch(() => {});
}
