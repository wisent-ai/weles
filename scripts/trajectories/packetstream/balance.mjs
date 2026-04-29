// PacketStream balance check via real browser login. Replaces the agent-loop
// packetstream_balance.mjs (which paid LLM tokens to do the same scrape every
// run and was non-deterministic). Native login form — no Google SSO.
import { getServiceLogin } from '../../../dist/utils/credentials.js';
import { WSession } from '../../../dist/session/wsession.js';

const LOGIN_URL = 'https://app.packetstream.io/login';
const DASH_URL  = 'https://app.packetstream.io';
const DISPLAY_NAME = 'PacketStream';

function parseBalanceFromText(text) {
  if (!text) return null;
  const labeled = text.match(/(?:balance|credit[s]?|account|wallet|funds)[^\n$]{0,40}\$([0-9]+(?:\.[0-9]{1,2})?)/i);
  if (labeled) return Number(labeled[1]);
  const dollar = text.match(/\$([0-9]+\.[0-9]{2})\b/);
  if (dollar) return Number(dollar[1]);
  return null;
}

async function patchServiceBalance(displayName, balance) {
  const supabaseUrl = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
  if (!supabaseUrl || !key) return false;
  const r = await fetch(`${supabaseUrl}/rest/v1/service_credentials?display_name=eq.${encodeURIComponent(displayName)}`, {
    method: 'PATCH',
    headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
    body: JSON.stringify({ balance_usd: balance, updated_at: new Date().toISOString() }),
  });
  return r.ok;
}

const login = await getServiceLogin(DISPLAY_NAME);
if (!login) { console.log('FAIL: no PacketStream credentials in DB'); process.exit(1); }
console.log(`[trajectory] Using service login: ${login.email}`);

const s = await WSession.start({ label: 'packetstream_balance', browser: 'chromium' });
try {
  await s.goto(LOGIN_URL);
  await s.page.waitForTimeout(1500);

  const userIn = s.page.locator('input[name="username"], input[name="email"], input[autocomplete="username"]').filter({ visible: true }).first();
  await userIn.waitFor({ state: 'visible' });
  await userIn.click();
  await userIn.pressSequentially(login.email, { delay: 25 });

  const pwIn = s.page.locator('input[name="password"], input[type="password"]').filter({ visible: true }).first();
  await pwIn.waitFor({ state: 'visible' });
  await pwIn.click();
  await pwIn.pressSequentially(login.password, { delay: 25 });
  await s.page.waitForTimeout(300);
  await pwIn.press('Enter');

  for (let i = 0; i < 20; i++) { await s.page.waitForTimeout(1000); if (!/\/login/.test(s.page.url())) break; }
  if (/\/login/.test(s.page.url())) { console.log(`FAIL: still on /login after submit (${s.page.url()})`); process.exit(1); }
  console.log(`[trajectory] post-login url=${s.page.url()}`);

  if (!/app\.packetstream\.io\/?$/.test(s.page.url())) await s.page.goto(DASH_URL, { waitUntil: 'domcontentloaded' });
  await s.page.waitForTimeout(3000);

  const text = await s.page.evaluate(() => document.body.innerText);
  const balance = parseBalanceFromText(text);
  if (balance == null) { console.log(`FAIL: could not parse balance from dashboard text (${text.length} chars)`); process.exit(1); }
  console.log(`[trajectory] balance=$${balance}`);

  const patched = await patchServiceBalance(DISPLAY_NAME, balance);
  if (!patched) { console.log('FAIL: balance scraped but PATCH service_credentials failed'); process.exit(1); }
  console.log(`PASS: balance=$${balance} (persisted)`);
} catch (e) {
  console.log('FAIL:', e.message?.slice(0, 200));
  process.exit(1);
} finally {
  await s.close();
}
