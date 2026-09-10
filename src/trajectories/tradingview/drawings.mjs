// Extract drawings from a TradingView chart via CDP connection to user's Chrome.
// Prereq: user launches Chrome with:
//   "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
//     --remote-debugging-port=9222 \
//     --user-data-dir="$HOME/Library/Application Support/Google/Chrome"
// Then navigates to their TV chart with drawings already made.
// Usage: node src/trajectories/tradingview/drawings.mjs --ticker ORCL
// Output: /tmp/tv_drawings.json with dump of all drawing-like state.

console.log = (...a) => process.stderr.write(a.map(String).join(' ') + '\n');

const args = {};
for (let i = 2; i < process.argv.length; i += 2) args[process.argv[i].replace(/^--/, '')] = process.argv[i + 1];
const ticker = (args.ticker || 'ORCL').toUpperCase();
const cdpUrl = args.cdp || 'http://localhost:9222';

console.error(`[tv_draw] querying tabs at ${cdpUrl}/json/list`);
const tabsResp = await fetch(`${cdpUrl}/json/list`);
const tabs = await tabsResp.json();
const chartTab = tabs.find(t => t.url && t.url.includes('tradingview.com/chart'));
if (!chartTab) { console.error('FAIL: no TradingView chart tab open. Navigate to TV chart with drawings.'); process.exit(1); }
console.error(`[tv_draw] found chart tab: ${chartTab.url}`);
const wsUrl = chartTab.webSocketDebuggerUrl;
const ws = new WebSocket(wsUrl);
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });

let msgId = 1;
function cdp(method, params) {
  return new Promise((resolve, reject) => {
    const id = msgId++;
    const handler = (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id === id) {
        ws.removeEventListener('message', handler);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
      }
    };
    ws.addEventListener('message', handler);
    ws.send(JSON.stringify({ id, method, params }));
  });
}
const s = {
  wait: (n) => new Promise(r => setTimeout(r, n * 1000)),  // allow-raw-playwright: review — context-dependent timer
  close: async () => ws.close(),
  page: { evaluate: async (js) => {
    const r = await cdp('Runtime.evaluate', { expression: `(async () => { ${js.startsWith('(') ? 'return ' + js : js} })()`, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
    return r.result.value;
  }}
};

const FS = await import('node:fs');
const OUT_FILE = args.out || '/tmp/tv_drawings.json';

try {
  await s.wait(2);

  // Enable network monitoring with large buffers
  await cdp('Network.enable', { maxResourceBufferSize: 50_000_000, maxTotalBufferSize: 200_000_000 });
  const apiResponses = [];
  const bodyPromises = [];
  let msgCount = 0, respCount = 0;
  ws.addEventListener('message', (e) => {
    msgCount++;
    let msg;
    try { msg = JSON.parse(e.data); } catch (_) { return; }
    if (msg.method === 'Network.responseReceived') {
      respCount++;
      const url = msg.params.response.url;
      if (/charts-storage|linetool|drawing|layout.*sources/i.test(url)) {
        apiResponses.push({ reqId: msg.params.requestId, url });
      }
    }
  });

  // Reload the chart to capture the drawings API call
  console.error('[tv_draw] reloading to capture drawings API');
  await cdp('Page.reload', { ignoreCache: false });
  await s.wait(8);

  // Get cookies + UA from Chrome via CDP
  const { cookies } = await cdp('Network.getAllCookies', {});
  const tvCookies = cookies.filter(c => /tradingview/i.test(c.domain));
  const cookieHeader = tvCookies.map(c => `${c.name}=${c.value}`).join('; ');
  const ua = await cdp('Runtime.evaluate', { expression: 'navigator.userAgent', returnByValue: true });
  const uaStr = ua.result.value;
  const headers = {
    'User-Agent': uaStr,
    'Cookie': cookieHeader,
    'Referer': chartTab.url,
    'Origin': 'https://www.tradingview.com',
    'Accept': 'application/json, text/plain, */*',
  };
  const bodies = [];
  const bodyErrors = [];
  for (const r of apiResponses) {
    try {
      const resp = await fetch(r.url, { headers });
      const txt = await resp.text();
      bodies.push({ url: r.url, status: resp.status, body: txt.slice(0, 500000) });
    } catch (e) {
      bodyErrors.push({ url: r.url, err: e.message });
    }
  }

  const extracted = await s.page.evaluate(`(async () => {
    const out = { url: location.href, localStorage_all_keys: [], localStorage: {}, idb: {}, tv_probe: {} };
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      out.localStorage_all_keys.push(k);
      try {
        const v = localStorage.getItem(k) || '';
        out.localStorage[k] = v.length < 100000 ? v : '[trunc ' + v.length + ']';
      } catch (e) {}
    }
    try {
      if (window.TradingView) {
        out.tv_probe.keys = Object.keys(window.TradingView).slice(0, 50);
        try { out.tv_probe.activeChart_keys = window.TradingView.activeChart ? Object.keys(window.TradingView.activeChart()).slice(0, 80) : null; } catch (e) {}
      }
    } catch (e) { out.tv_probe.err = e.message; }
    try {
      const dbs = await indexedDB.databases();
      for (const db of dbs) {
        const entry = { version: db.version, stores: [], contents: {} };
        out.idb[db.name] = entry;
        await new Promise((resolve) => {
          const req = indexedDB.open(db.name, db.version);
          req.onsuccess = (e) => {
            const d = e.target.result;
            entry.stores = Array.from(d.objectStoreNames);
            let remaining = entry.stores.length;
            if (remaining === 0) { d.close(); resolve(); return; }
            for (const sname of entry.stores) {
              try {
                const tx = d.transaction(sname, 'readonly');
                const st = tx.objectStore(sname);
                const req2 = st.getAll();
                req2.onsuccess = () => {
                  try {
                    const vals = req2.result || [];
                    entry.contents[sname] = vals.slice(0, 5).map(v => {
                      try { return JSON.stringify(v).slice(0, 2000); } catch(_) { return String(v).slice(0, 500); }
                    });
                    entry.contents[sname + '__count'] = vals.length;
                  } catch (e) {}
                  if (--remaining === 0) { d.close(); resolve(); }
                };
                req2.onerror = () => { if (--remaining === 0) { d.close(); resolve(); } };
              } catch (e) { if (--remaining === 0) { d.close(); resolve(); } }
            }
          };
          req.onerror = () => resolve();
        });
      }
    } catch (e) { out.idb_error = e.message; }
    return out;
  })()`);

  extracted.network_api = bodies;
  extracted.network_urls = apiResponses.map(r => r.url);
  extracted.body_errors = bodyErrors;
  extracted.msg_stats = { total: msgCount, responses: respCount, tv_responses: apiResponses.length };
  // Deep probe: look for initial state in scripts
  const scan = await s.page.evaluate(`(() => {
    const scripts = Array.from(document.querySelectorAll('script'));
    const hits = [];
    for (const sc of scripts) {
      const txt = sc.textContent || '';
      if (/linetool|line_tool|shapes|drawings_points|chart_layout/i.test(txt)) {
        hits.push({ snippet: txt.slice(0, 5000), len: txt.length });
      }
    }
    const body = document.body ? document.body.outerHTML.length : 0;
    return { script_hits: hits, body_len: body };
  })()`);
  extracted.script_probe = scan;
  FS.writeFileSync(OUT_FILE, JSON.stringify(extracted, null, 2));
  process.stderr.write(`\n[tv_draw] dumped drawing candidates to ${OUT_FILE}\n`);
} catch (e) {
  console.error(`FAIL: ${e.message}\n${e.stack}`);
  process.exit(1);
} finally {
  await s.close().catch(() => {});
  process.exit(0);
}
