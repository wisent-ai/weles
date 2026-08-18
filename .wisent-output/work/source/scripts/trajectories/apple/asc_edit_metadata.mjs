// App Store Connect: edit app metadata (description, keywords, promo text).
// Args: APP_ID, plus any of DESCRIPTION / KEYWORDS / PROMO_TEXT / WHATS_NEW env vars.

import { getSocialAccount } from '../../../dist/utils/credentials.js';
import { WSession } from '../../../dist/session/wsession.js';

const APP_ID = process.env.APP_ID;
if (!APP_ID) { console.log('FAIL: APP_ID env var required'); process.exit(1); }

const fields = {
  description: process.env.DESCRIPTION,
  keywords: process.env.KEYWORDS,
  promotionalText: process.env.PROMO_TEXT,
  whatsNew: process.env.WHATS_NEW,
};
const toUpdate = Object.entries(fields).filter(([, v]) => v);
if (!toUpdate.length) { console.log('FAIL: at least one of DESCRIPTION/KEYWORDS/PROMO_TEXT/WHATS_NEW must be set'); process.exit(1); }

const acct = await getSocialAccount('apple');
if (!acct) { console.log('FAIL: no apple account'); process.exit(1); }

const s = await WSession.start({ label: 'apple_asc_edit_metadata', proxy: process.env.PROXY_URL || undefined });
try {
  await s.goto(`https://appstoreconnect.apple.com/apps/${APP_ID}/distribution/info`);
  await s.wait(8);
  if ((s.page.url?.() ?? '').includes('idmsa.apple.com')) {
    console.log('FAIL: session expired, rerun apple/login.mjs');
    process.exit(2);
  }

  for (const [field, value] of toUpdate) {
    // ASC uses textareas keyed by data-test-id or name
    const sel = `textarea[name="${field}"], textarea[data-test-id*="${field}"], textarea[aria-label*="${field}" i]`;
    const el = s.page.locator(sel).first();
    if (await el.isVisible().catch(() => false)) {
      await el.fill(value);
      console.log(`[asc-edit] ${field} set (${value.length} chars)`);
    } else {
      console.log(`[asc-edit] WARN: ${field} field not found on page`);
    }
  }
  await s.wait(1);

  // Save button
  await s.page.locator('button:has-text("Save"), button[data-test-id="save"]').click();
  await s.wait(5);

  console.log(`PASS: updated ${toUpdate.map(([k]) => k).join(', ')} for app ${APP_ID}`);
} catch (e) {
  console.log('FAIL:', e.message?.slice(0, 200));
  process.exit(1);
} finally {
  await s.close();
}
