// CapMonster balance probe via direct API call.
// Endpoint: POST https://api.capmonster.cloud/getBalance
// Auth:     clientKey in JSON body. Response: { errorId: 0, balance: <USD> }

const KEY = process.env.CAPMONSTER_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';

if (!KEY) { console.log('FAIL: CAPMONSTER_API_KEY env required'); process.exit(1); }
if (!SUPABASE_URL || !SUPABASE_KEY) { console.log('FAIL: SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY required'); process.exit(1); }

try {
  const r = await fetch('https://api.capmonster.cloud/getBalance', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clientKey: KEY }),
  });
  if (!r.ok) { console.log(`FAIL: API returned ${r.status} ${(await r.text()).slice(0, 200)}`); process.exit(1); }
  const j = await r.json();
  if (j.errorId !== 0) { console.log(`FAIL: CapMonster errorId=${j.errorId} ${j.errorDescription ?? ''}`); process.exit(1); }
  const balance = Number(j.balance);
  if (!Number.isFinite(balance)) { console.log(`FAIL: balance not numeric: ${JSON.stringify(j).slice(0, 200)}`); process.exit(1); }
  await fetch(`${SUPABASE_URL}/rest/v1/service_credentials?display_name=eq.CapMonster%20Cloud`, {
    method: 'PATCH',
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
    body: JSON.stringify({ balance_usd: balance, updated_at: new Date().toISOString() }),
  });
  console.log(`PASS: CapMonster balance=$${balance}`);
} catch (e) {
  console.log('FAIL:', e.message?.slice(0, 200));
  process.exit(1);
}
