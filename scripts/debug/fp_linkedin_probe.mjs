#!/usr/bin/env node
/**
 * Minimal fingerprint probe: open LinkedIn signup in Weles and exit.
 * Produces an inst.json under recordings/fp_linkedin_probe/ for analysis.
 */
import { WSession } from '../../dist/session/wsession.js';

const requestedProxy = process.env.LINKEDIN_REGISTER_PROXY ?? process.env.LINKEDIN_PROXY ?? process.env.PROXY_URL ?? 'isp decodo us';

let s = null;
try {
  s = await WSession.start({
    label: 'fp_linkedin_probe',
    proxy: requestedProxy,
    targetHost: 'www.linkedin.com',
    platform: 'linkedin',
    browser: process.env.WELES_REGISTER_BROWSER || undefined,
    os: process.env.WELES_REGISTER_OS || undefined,
  });
  await s.goto('https://www.linkedin.com/signup');
  await s.page.waitForTimeout(5000);
  console.log(`[fp_linkedin_probe] URL: ${s.page.url()}`);
} catch (e) {
  console.error(`[fp_linkedin_probe] ERROR: ${e.message}`);
  process.exitCode = 1;
} finally {
  await s?.close?.();
}
