// Bright Data balance probe via direct API call.
// Endpoint: GET https://api.brightdata.com/customer/balance
// Auth:     Authorization: Bearer <api_token>
// Response: { balance: <USD>, pending_balance: <USD> }

const TOKEN = process.env.BRIGHTDATA_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';

if (!TOKEN) { console.log('FAIL: BRIGHTDATA_API_KEY env required (generate in dashboard Settings > API)'); process.exit(1); }
if (!SUPABASE_URL || !SUPABASE_KEY) { console.log('FAIL: SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY required'); process.exit(1); }

try {
  const r = await fetch('https://api.brightdata.com/customer/balance', { headers: { Authorization: `Bearer ${TOKEN}` } });
  if (!r.ok) { console.log(`FAIL: API returned ${r.status} ${(await r.text()).slice(0, 200)}`); process.exit(1); }
  const j = await r.json();
  const balance = Number(j.balance);
  if (!Number.isFinite(balance)) { console.log(`FAIL: balance not numeric: ${JSON.stringify(j).slice(0, 200)}`); process.exit(1); }
  await fetch(`${SUPABASE_URL}/rest/v1/service_credentials?display_name=eq.Bright%20Data`, {
    method: 'PATCH',
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
    body: JSON.stringify({ balance_usd: balance, updated_at: new Date().toISOString() }),
  });
  console.log(`PASS: Bright Data balance=$${balance} pending=$${j.pending_balance ?? 0}`);
} catch (e) {
  console.log('FAIL:', e.message?.slice(0, 200));
  process.exit(1);
}
