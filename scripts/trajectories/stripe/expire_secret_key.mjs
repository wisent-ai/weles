import { createHash, timingSafeEqual } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { readScopedLogin, readScopedSecret } from '../../_shared/scoped-secrets.mjs';
import { parseStripeExpireSecretKeyParams } from '../../../dist/worker/stripe-expire-params.js';
import { WSession } from '../../../dist/session/wsession.js';
import { googleSso } from '../_shared/services/google_sso.mjs';

const ACTION = 'stripe_expire_secret_key';
const SECRET_SERVICE = 'stripeIncident';
const SECRET_FIELD = 'api_key';
const API_URL = 'https://api.stripe.com/v1/account';
const DASHBOARD_URL = 'https://dashboard.stripe.com/apikeys';

function loadPlan() {
  let raw;
  try {
    raw = JSON.parse(process.env.WELES_STRIPE_EXPIRE_PLAN || '{}');
  } catch {
    throw new Error('invalid WELES_STRIPE_EXPIRE_PLAN JSON');
  }
  return parseStripeExpireSecretKeyParams(raw);
}

function fingerprint(secret) {
  return createHash('sha256').update(secret, 'utf8').digest('hex');
}

function fingerprintsMatch(actual, expected) {
  return timingSafeEqual(Buffer.from(actual, 'hex'), Buffer.from(expected, 'hex'));
}

async function probe(secret) {
  const response = await fetch(API_URL, {
    method: 'GET',
    headers: { Authorization: `Bearer ${secret}` },
    redirect: 'error',
  });
  let accountId = null;
  if (response.status === 200) {
    const document = await response.json();
    accountId = typeof document?.id === 'string' ? document.id : null;
  } else {
    await response.arrayBuffer().catch(() => null);
  }
  return { status: response.status, accountId };
}

async function ensureDashboardSession(session) {
  await session.page.goto(DASHBOARD_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await session.page.waitForTimeout(2_000);
  if (!/login|signin/i.test(session.page.url())
      && await session.page.locator('input[type="email"], input[name="email"]').count() === 0) {
    return;
  }
  const google = session.page.getByRole('button', { name: /google/i })
    .or(session.page.getByRole('link', { name: /google/i })).first();
  if (!await google.isVisible().catch(() => false)) {
    throw new Error('PROVIDER_REFUSAL:stripe_dashboard_auth_required_without_google_sso');
  }
  const popupPromise = session.context.waitForEvent('page', { timeout: 10_000 }).catch(() => null);
  await google.click();
  const popup = await popupPromise;
  const signedIn = await googleSso(session, readScopedLogin('googleSso'), {
    originHost: 'stripe.com',
    ...(popup ? { page: popup } : {}),
  });
  if (!signedIn) throw new Error('PROVIDER_REFUSAL:stripe_google_sso_failed');
  await session.page.goto(DASHBOARD_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await session.page.waitForTimeout(2_000);
  if (/login|signin/i.test(session.page.url())) {
    throw new Error('PROVIDER_REFUSAL:stripe_dashboard_session_not_established');
  }
}

async function findExactKeyRow(page, lastFour) {
  const rows = page.locator('tr, [role="row"]').filter({ hasText: lastFour });
  const count = await rows.count();
  if (count !== 1) {
    throw new Error(`PROVIDER_REFUSAL:stripe_key_row_match_count=${count}`);
  }
  return rows.first();
}

async function expireKey(page, row) {
  let actionButton = row.getByRole('button', { name: /more|actions|options|overflow/i }).first();
  if (!await actionButton.isVisible().catch(() => false)) actionButton = row.locator('button').last();
  if (!await actionButton.isVisible().catch(() => false)) {
    throw new Error('PROVIDER_REFUSAL:stripe_key_action_menu_unavailable');
  }
  await actionButton.click();
  const expire = page.getByRole('menuitem', { name: /expire key/i })
    .or(page.getByRole('button', { name: /expire key/i }))
    .or(page.getByText(/^expire key$/i)).first();
  if (!await expire.isVisible().catch(() => false)) {
    throw new Error('PROVIDER_REFUSAL:stripe_expire_key_action_unavailable');
  }
  await expire.click();
  const dialog = page.getByRole('dialog').last();
  const confirm = dialog.getByRole('button', { name: /^expire key$/i })
    .or(dialog.getByRole('button', { name: /^expire$/i })).last();
  if (!await confirm.isVisible().catch(() => false)) {
    throw new Error('PROVIDER_REFUSAL:stripe_expire_confirmation_unavailable');
  }
  await confirm.click();
}

const plan = loadPlan();
const secret = readScopedSecret(SECRET_SERVICE, SECRET_FIELD);
const actualFingerprint = fingerprint(secret);
if (!fingerprintsMatch(actualFingerprint, plan.expected_fingerprint)) {
  throw new Error('ADMISSION_REFUSAL:incident_secret_fingerprint_mismatch');
}

const before = await probe(secret);
if (before.status !== 200 || before.accountId !== plan.provider_account_id) {
  throw new Error(`ADMISSION_REFUSAL:stripe_preflight_status=${before.status};account_match=${before.accountId === plan.provider_account_id}`);
}

const session = await WSession.start({
  label: 'stripe-provider-incident-remediation',
  browser: 'chromium',
  headless: process.env.HEADLESS === '1' || process.env.WELES_HEADLESS === '1',
});
try {
  await ensureDashboardSession(session);
  const row = await findExactKeyRow(session.page, secret.slice(-4));
  await expireKey(session.page, row);
  let after = await probe(secret);
  for (let attempt = 0; attempt < 12 && after.status !== 401; attempt += 1) {
    await session.page.waitForTimeout(2_500);
    after = await probe(secret);
  }
  if (after.status !== 401) {
    throw new Error(`PROVIDER_REFUSAL:stripe_old_key_post_expiry_status=${after.status}`);
  }
  const evidenceDir = join(process.cwd(), 'recordings', 'stripe_expire_secret_key');
  mkdirSync(evidenceDir, { recursive: true });
  await session.page.screenshot({ path: join(evidenceDir, `${plan.incident_reference}-expired.png`), fullPage: true })
    .catch(() => null);
  console.log(JSON.stringify({
    action: ACTION,
    incident_reference: plan.incident_reference,
    fingerprint: actualFingerprint,
    provider_account_id: plan.provider_account_id,
    preflight_http_status: before.status,
    old_key_http_status: after.status,
    expired: true,
  }));
} finally {
  try {
    if (typeof session.shutdown === 'function') await session.shutdown();
    else if (typeof session.close === 'function') await session.close();
  } catch {
    // Provider result must survive a best-effort browser shutdown.
  }
}
