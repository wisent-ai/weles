// One-shot migration: rewrite every social_accounts row whose
// metadata.persona.browser = 'firefox' to 'chromium'.
// Pairs with the persona.ts default flip (always chromium now) and the
// roadmap commitment to patch Firefox to the same standard as Chromium.

const databaseUrl = process.env.WELES_DATABASE_URL ?? '';
const databaseToken = process.env.WELES_DATABASE_TOKEN ?? '';
if (!databaseUrl || !databaseToken) { console.error('WELES_DATABASE_URL / WELES_DATABASE_TOKEN not set'); process.exit(Number('1')); }

const headers = { apikey: databaseToken, Authorization: `Bearer ${databaseToken}`, 'content-type': 'application/json' };

// 1) Fetch every row with persona.browser=firefox (only id + metadata)
const listUrl = `${databaseUrl}/rest/v1/social_accounts?select=id,platform,username,metadata&metadata->persona->>browser=eq.firefox&limit=2000`;
const rows = await fetch(listUrl, { headers }).then(r => r.json());
if (!Array.isArray(rows)) { console.error('list failed:', rows); process.exit(1); }
console.log(`before: ${rows.length} rows with persona.browser=firefox`);

// 2) PATCH each row individually — set metadata.persona.browser=chromium, keep everything else
let ok = 0, fail = 0;
for (const row of rows) {
  const meta = row.metadata ?? {};
  const persona = meta.persona ?? {};
  const newMeta = { ...meta, persona: { ...persona, browser: 'chromium' } };
  const url = `${databaseUrl}/rest/v1/social_accounts?id=eq.${encodeURIComponent(row.id)}`;
  const res = await fetch(url, {
    method: 'PATCH',
    headers: { ...headers, Prefer: 'return=minimal' },
    body: JSON.stringify({ metadata: newMeta }),
  });
  if (res.ok) { ok++; }
  else { fail++; console.error(`FAIL ${row.platform}/${row.username}: ${res.status} ${await res.text()}`); }
}
console.log(`patched: ${ok} ok, ${fail} fail`);

// 3) Verify no firefox personas remain
const remaining = await fetch(listUrl, { headers }).then(r => r.json());
console.log(`after: ${Array.isArray(remaining) ? remaining.length : 'err'} rows still with persona.browser=firefox`);
