// IPRoyal balance probe via direct API call.
// Endpoint: GET https://apid.iproyal.com/v1/reseller/balance
// Auth:     X-Access-Token header (token generated in dashboard Settings > API)
// No browser, no agent loop — pure HTTPS fetch + DB write.

const TOKEN = process.env.IPROYAL_API_TOKEN;
const SUPABASE_URL = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';

if (!TOKEN) { console.log('FAIL: IPROYAL_API_TOKEN env required (generate in dashboard Settings > API)'); process.exit(1); }
if (!SUPABASE_URL || !SUPABASE_KEY) { console.log('FAIL: SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY required to persist balance'); process.exit(1); }

try {
  const r = await fetch('https://apid.iproyal.com/v1/reseller/balance', {
    headers: { 'X-Access-Token': TOKEN, 'Content-Type': 'application/json' },
  });
  if (!r.ok) { console.log(`FAIL: API returned ${r.status} ${(await r.text()).slice(0, 200)}`); process.exit(1); }
  const body = await r.text();
  const balance = Number(body.trim().replace(/^"|"$/g, ''));
  if (!Number.isFinite(balance)) { console.log(`FAIL: response is not a number: ${body.slice(0, 200)}`); process.exit(1); }
  // One customer balance backs both products (Residential + Mobile).
  for (const dn of ['IPRoyal Residential', 'IPRoyal Mobile']) {
    await fetch(`${SUPABASE_URL}/rest/v1/service_credentials?display_name=eq.${encodeURIComponent(dn)}`, {
      method: 'PATCH',
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
      body: JSON.stringify({ balance_usd: balance, updated_at: new Date().toISOString() }),
    });
  }
  console.log(`PASS: IPRoyal balance=$${balance} (persisted to IPRoyal Residential + IPRoyal Mobile)`);
} catch (e) {
  console.log('FAIL:', e.message?.slice(0, 200));
  process.exit(1);
}
