// PacketStream balance check via real browser login. Replaces the agent-loop
// packetstream_balance.mjs (which paid LLM tokens to do the same scrape every
// run and was non-deterministic). Native login form — no Google SSO.
import { getServiceLogin } from '../../../dist/utils/credentials.js';
import { WSession } from '../../../dist/session/wsession.js';
import { patchEffectiveBalance } from '../_shared/services/proxy_probe.mjs';
import { pageSettled } from '../_shared/page/settled.mjs';
import { submitLoginForm } from '../_shared/services/native_login/submit.mjs';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runRecordingsDir } from '../../../dist/session/run-recordings.js';

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

const login = await getServiceLogin(DISPLAY_NAME);
if (!login) { console.log('FAIL: no PacketStream credentials in DB'); process.exit(1); }
console.log(`[trajectory] Using service login: ${login.email}`);

const s = await WSession.start({ label: 'packetstream_balance', browser: 'chromium' });
try {
  await s.goto(LOGIN_URL);

  const userIn = s.page.locator('input[name="username"], input[name="email"], input[autocomplete="username"]').filter({ visible: true }).first();
  await userIn.waitFor({ state: 'visible' });
  await userIn.click();
  await userIn.pressSequentially(login.email);

  const pwIn = s.page.locator('input[name="password"], input[type="password"]').filter({ visible: true }).first();
  await pwIn.waitFor({ state: 'visible' });
  await pwIn.click();
  await pwIn.pressSequentially(login.password);
  await submitLoginForm(s.page, pwIn);
  console.log(`[trajectory] post-login url=${s.page.url()}`);

  const response = await s.page.goto(DASH_URL, { waitUntil: 'domcontentloaded' });
  if (!response) throw new Error(`PACKETSTREAM_DASHBOARD_RESPONSE_MISSING: ${s.page.url()}`);
  if (!response.ok()) throw new Error(`PACKETSTREAM_DASHBOARD_HTTP_ERROR: HTTP ${response.status()} at ${response.url()}`);
  const responseError = await response.finished();
  if (responseError) throw new Error(`PACKETSTREAM_DASHBOARD_RESPONSE_FAILED: ${response.url()}`, { cause: responseError });
  await pageSettled(s.page);
  const observed = new URL(s.page.url());
  if (observed.origin !== new URL(DASH_URL).origin || observed.pathname === new URL(LOGIN_URL).pathname) {
    throw new Error(`PACKETSTREAM_DASHBOARD_DESTINATION_MISMATCH: requested ${DASH_URL}; observed ${s.page.url()}`);
  }

  const text = await s.page.evaluate(() => document.body.innerText);
  const balance = parseBalanceFromText(text);
  if (balance == null) {
    const dir = runRecordingsDir('packetstream_balance');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'dashboard-text.txt'), text);
    try { writeFileSync(join(dir, 'dashboard.html'), await s.page.content()); }
    catch (error) { console.error('PACKETSTREAM_DIAGNOSTIC_HTML_FAILED:', error); }
    try { await s.page.screenshot({ path: join(dir, 'dashboard.png'), fullPage: true }); }
    catch (error) { console.error('PACKETSTREAM_DIAGNOSTIC_SCREENSHOT_FAILED:', error); }
    throw new Error(`PACKETSTREAM_BALANCE_NOT_FOUND: no supported balance widget at ${s.page.url()}; dashboard text saved to ${dir}`);
  }
  console.log(`[trajectory] balance=$${balance}`);

  const patched = await patchEffectiveBalance(DISPLAY_NAME, balance);
  if (!patched) throw new Error(`PACKETSTREAM_BALANCE_NOT_PERSISTED: proxy record update did not succeed for ${DISPLAY_NAME}`);
  console.log(`PASS: dashboard=$${balance} (effective balance written + probed)`);
} catch (e) {
  console.error('FAIL:', e);
  process.exitCode = 1;
} finally {
  await s.close();
}
