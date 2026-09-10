import FS from 'node:fs';
const d = JSON.parse(FS.readFileSync(process.argv[2] || '/tmp/tv_drawings.json', 'utf8'));
const all = {};
for (const b of d.network_api || []) {
  let body;
  try { body = JSON.parse(b.body); } catch (e) { process.stderr.write('parse fail: ' + e.message + '\n'); continue; }
  if (!body.success) continue;
  const srcs = body.payload?.sources || {};
  process.stderr.write(`URL: ${b.url.slice(0, 120)}... sources=${Object.keys(srcs).length}\n`);
  let dumped = false;
  for (const [id, src] of Object.entries(srcs)) {
    const t = src.state?.type || '';
    if (!dumped) { process.stderr.write('FULL SRC: ' + JSON.stringify(src, null, 2).slice(0, 3000) + '\n'); dumped = true; }
    process.stderr.write(`  src ${id}: type=${t} keys=${Object.keys(src).join(',')} ptsLen=${(src.points||[]).length}\n`);
    if (!/Trend|Line|Wedge|Tri/i.test(t)) continue;
    // Try multiple point locations
    // points are nested 2-deep: src.state.points
    const pts = src.state?.points || src.points || [];
    process.stderr.write(`    state type=${t}, pts=${pts.length}\n`);
    if (pts.length === 0) {
      process.stderr.write(`    state keys: ${Object.keys(src.state || {}).join(',')}\n`);
      continue;
    }
    all[id] = { id, symbol: src.symbol, type: t,
                points: pts.map(p => ({
                  time: p.time_t,
                  date: p.time_t ? new Date(p.time_t * 1000).toISOString().slice(0, 10) : null,
                  price: p.price,
                  interval: p.interval
                })) };
  }
}
console.log(JSON.stringify(Object.values(all), null, 2));
