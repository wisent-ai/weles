// Apple Developer ID Application certificate creation.
// One-use Skarbiec capabilities authorize email, password and 2FA; Stado owns
// execution and placement.

import { WSession } from '../../../dist/session/wsession.js';
import { cancelCapability } from '../../../dist/utils/capability.js';
import { parseAppleLoginCapabilities } from '../../../dist/utils/identity/apple-login-capabilities.js';
import { getSocialAccount } from '../../../dist/utils/credentials.js';
import { preflightAppleChallengeRelay } from '../../auth/apple-account-placement.mjs';
import { ADD_URL, DOWNLOAD_WAIT_MS, FILE_INPUT_WAIT_MS, NAVIGATION_WAIT_MS, PORTAL_POLLS } from './create_developer_id/constants.mjs';
import { absoluteWorkerPath, clickButton, clickChoice, isDevPortalUrl } from './create_developer_id/portal.mjs';
import { signInWithCapabilities } from './create_developer_id/sign_in.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
// Eight hex from the Stado queue, or the UUID the Weles API assigns and then
// forces into ACTION_LOG_ID. Both name one run; refusing the second one meant
// refusing every run Stado dispatches.
const JOB = /^(?:[0-9a-f]{8}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
const ACCOUNT = /^weles-apple-[a-z0-9][a-z0-9-]{0,126}-account$/;
const guardId = (process.env.APPLE_AUTH_GUARD_ID?.trim() ?? '').toLowerCase();
const accountId = process.env.WELES_LOGIN_ITEM?.trim() ?? '';
const actionLogId = process.env.ACTION_LOG_ID?.trim() ?? '';
if (!UUID.test(guardId)) throw new Error('[apple-create-developer-id] invalid guard id');
if (!ACCOUNT.test(accountId)) throw new Error('[apple-create-developer-id] invalid Apple account item');
if (!JOB.test(actionLogId)) throw new Error('[apple-create-developer-id] invalid Stado job id');

const csrPath = absoluteWorkerPath(process.env.APPLE_CSR_PATH, 'APPLE_CSR_PATH');
const certificatePath = absoluteWorkerPath(process.env.APPLE_CERTIFICATE_PATH, 'APPLE_CERTIFICATE_PATH');

let capabilityRefs = [];

async function cancelSessionCapabilities() {
  if (capabilityRefs.length !== 3) throw new Error('capability cleanup unavailable');
  const failures = [];
  for (const capability of capabilityRefs) {
    try { await cancelCapability(capability.capability_id, guardId); }
    catch (error) { failures.push(error instanceof Error ? error.message : String(error)); }
  }
  if (failures.length > 0) throw new Error(`capability cleanup unconfirmed: ${failures.join('; ')}`);
}

/** Choose the certificate type, upload the CSR and download the issued certificate. */
async function createCertificate(page) {
  await page.goto(ADD_URL, { waitUntil: 'domcontentloaded', timeout: NAVIGATION_WAIT_MS });
  await s.wait(6);
  if (!/developer\.apple\.com\/account\/resources\/certificates\/add/.test(page.url())) {
    throw new Error(`certificate add page unavailable at ${page.url()}`);
  }
  console.log('[apple-create-developer-id] CERTIFICATE_TYPE_PAGE');

  if (!(await clickChoice(page, /^Developer ID Application$/i))) {
    const text = (await page.locator('body').innerText().catch((e) => `unreadable: ${e.message}`)).replace(/\s+/g, ' ').slice(0, 1000);
    throw new Error(`Developer ID Application choice missing; page=${text}`);
  }
  await s.wait(1);
  if (!(await clickButton(page, /^continue$/i))) throw new Error('certificate type Continue control missing');
  await s.wait(4);

  const fileInput = page.locator('input[type="file"]').first();
  await fileInput.waitFor({ state: 'attached', timeout: FILE_INPUT_WAIT_MS });
  await fileInput.setInputFiles(csrPath);
  console.log('[apple-create-developer-id] CSR_UPLOADED');
  await s.wait(1);
  if (!(await clickButton(page, /^continue$/i))) throw new Error('CSR Continue control missing');
  await s.wait(6);

  const downloadPromise = page.waitForEvent('download', { timeout: DOWNLOAD_WAIT_MS });
  if (!(await clickButton(page, /download/i))) throw new Error('certificate Download control missing');
  const download = await downloadPromise;
  await download.saveAs(certificatePath);
  console.log(`[apple-create-developer-id] CERTIFICATE_SAVED=${certificatePath}`);
}

console.log(`[apple-create-developer-id] account ${accountId}, CSR ${csrPath}`);
let sessionClosed = true;
let s = null;
try {
  const capabilities = parseAppleLoginCapabilities(process.env.APPLE_LOGIN_CAPABILITIES_JSON, guardId);
  capabilityRefs = [
    capabilities.email,
    capabilities.password,
    capabilities.two_factor.capability,
  ];
  // Resolve the holder, its exact GUI user, this worker's broker and the
  // installed relay before opening a browser or spending a password attempt.
  // The preflight reads state only and opens no native prompt.
  const preflightAccount = await getSocialAccount('apple');
  const identity = (preflightAccount?.metadata?.email ?? preflightAccount?.username ?? '').trim();
  const challengeRoute = preflightAppleChallengeRelay(identity, guardId);
  console.log(
    `[apple-create-developer-id] Apple challenge route `
    + `${challengeRoute.holder}/${challengeRoute.user} -> ${challengeRoute.destination}`,
  );

  s = await WSession.start({ label: 'apple_create_developer_id', headless: process.env.WELES_HEADLESS === '1' });
  sessionClosed = false;
  await s.page.goto(ADD_URL, { waitUntil: 'domcontentloaded', timeout: NAVIGATION_WAIT_MS });
  await s.wait(5);

  const { postPasswordState, twoFactorReceipt } = await signInWithCapabilities(s, { capabilities, guardId, identity });

  let portalObserved = postPasswordState === 'dashboard';
  for (let poll = 0; !portalObserved && poll < PORTAL_POLLS; poll += 1) {
    portalObserved = isDevPortalUrl(s.page.url?.() ?? '');
    if (!portalObserved) await s.wait(1);
  }
  if (!portalObserved) throw new Error(`did not reach developer portal, still at ${s.page.url()}`);

  await createCertificate(s.page);
  if (twoFactorReceipt) {
    // Certificate issuance, not filling the code, proves provider acceptance.
    console.log(`APPLE_TWO_FACTOR_RECEIPT=${JSON.stringify({
      ...twoFactorReceipt,
      provider_accepted: true,
    })}`);
  }
} catch (error) {
  console.error(`FAIL=${error instanceof Error ? error.message.slice(0, 1200) : String(error).slice(0, 1200)}`);
  try { await cancelSessionCapabilities(); } catch (cleanupError) { console.error(`[apple-create-developer-id] ${cleanupError.message}`); }
  process.exitCode = 1;
} finally {
  if (s && !sessionClosed) { await s.close().catch((e) => console.error(`[apple-create-developer-id] close: ${e.message}`)); sessionClosed = true; }
}
process.exit(process.exitCode ?? 0);
