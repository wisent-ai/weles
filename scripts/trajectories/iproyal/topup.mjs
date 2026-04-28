// IPRoyal residential top-up via direct API.
// Endpoint:    POST https://resi-api.iproyal.com/v1/residential/orders
// Auth:        Authorization: Bearer <api_token>
// Body:        { quantity: <GB> }  — charges from saved card OR account balance
// Pricing:     GET /v1/residential/orders/calculate-pricing?quantity=<N> first
//              so the operator sees expected cost before the purchase fires.
//
// Env:
//   IPROYAL_API_TOKEN              — required
//   IPROYAL_TOPUP_GB               — quantity to purchase (default 10)
//   IPROYAL_TOPUP_DRY_RUN=1        — only fetch pricing, don't actually purchase

const TOKEN = process.env.IPROYAL_API_TOKEN;
const QUANTITY = Number(process.env.IPROYAL_TOPUP_GB ?? '10');
const DRY = process.env.IPROYAL_TOPUP_DRY_RUN === '1';
const SUPABASE_URL = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';

if (!TOKEN) { console.log('FAIL: IPROYAL_API_TOKEN env required'); process.exit(1); }
if (!Number.isFinite(QUANTITY) || QUANTITY <= 0) { console.log(`FAIL: IPROYAL_TOPUP_GB must be a positive number (got "${process.env.IPROYAL_TOPUP_GB}")`); process.exit(1); }

const auth = { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' };

try {
  // 1. Pricing preview.
  const pr = await fetch(`https://resi-api.iproyal.com/v1/residential/orders/calculate-pricing?quantity=${QUANTITY}`, { headers: auth });
  const pricingTxt = await pr.text();
  if (!pr.ok) { console.log(`FAIL: pricing preview returned ${pr.status} ${pricingTxt.slice(0, 200)}`); process.exit(1); }
  console.log(`[iproyal/topup] pricing preview for ${QUANTITY} GB: ${pricingTxt.slice(0, 200)}`);

  if (DRY) { console.log(`PASS: dry run — would have ordered ${QUANTITY} GB (set IPROYAL_TOPUP_DRY_RUN=0 to actually buy)`); process.exit(0); }

  // 2. Place the order.
  const or = await fetch('https://resi-api.iproyal.com/v1/residential/orders', {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ quantity: QUANTITY }),
  });
  const orderTxt = await or.text();
  if (!or.ok) { console.log(`FAIL: order POST returned ${or.status} ${orderTxt.slice(0, 300)}`); process.exit(1); }
  console.log(`[iproyal/topup] order placed: ${orderTxt.slice(0, 300)}`);

  // 3. Re-fetch balance and persist to service_credentials so the resolver
  //    sees the new state immediately rather than waiting for the next
  //    scheduled balance probe.
  if (SUPABASE_URL && SUPABASE_KEY) {
    const br = await fetch('https://apid.iproyal.com/v1/reseller/balance', { headers: { 'X-Access-Token': TOKEN, 'Content-Type': 'application/json' } });
    if (br.ok) {
      const balance = Number((await br.text()).trim().replace(/^"|"$/g, ''));
      if (Number.isFinite(balance)) {
        for (const dn of ['IPRoyal Residential', 'IPRoyal Mobile']) {
          await fetch(`${SUPABASE_URL}/rest/v1/service_credentials?display_name=eq.${encodeURIComponent(dn)}`, {
            method: 'PATCH',
            headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
            body: JSON.stringify({ balance_usd: balance, updated_at: new Date().toISOString() }),
          });
        }
        console.log(`[iproyal/topup] post-purchase balance=$${balance} persisted`);
      }
    }
  }
  console.log(`PASS: IPRoyal topped up ${QUANTITY} GB`);
} catch (e) {
  console.log('FAIL:', e.message?.slice(0, 200));
  process.exit(1);
}
