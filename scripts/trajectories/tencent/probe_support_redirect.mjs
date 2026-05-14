// One-shot probe of the /support/redirect?step=999 page that Tencent sends
// authenticated users to when /hy3d is hit on an account without the AI3D
// service activated. Goal: dump the DOM so we know what to click next.

import { WSession } from '../../../dist/session/wsession.js';
import { loadTencentCookies } from './login.mjs';
import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { humanIdlePause } from '../../../dist/human/mouse.js';

// Probe many candidate AI3D-activation URLs — the /hy3d path is a dead-end
const CANDIDATES = [
  'https://console.tencentcloud.com/hy3d',
  'https://console.tencentcloud.com/ai3d',
  'https://console.tencentcloud.com/aiart',
  'https://console.tencentcloud.com/cam/policy?keyword=ai3d',
  'https://console.tencentcloud.com/cam/role',
  'https://www.tencentcloud.com/products/ai3d',
  'https://console.tencentcloud.com/expense/overview',
  'https://console.tencentcloud.com/billing/cost',
  'https://console.intl.cloud.tencent.com/ai3d',
  'https://console.intl.cloud.tencent.com/ai3d/console',
  'https://console.intl.cloud.tencent.com/hunyuan',
];
const URL = CANDIDATES[0];
const PERSONA_PATH = join(homedir(), '.weles', 'cookie-jars', 'tencent_persona.json');

async function main() {
  let pinned = null;
  try { pinned = JSON.parse(readFileSync(PERSONA_PATH, 'utf8')); } catch {}
  const s = await WSession.start({ label: 'tencent_probe_support', browser: 'chromium', persona: pinned ?? undefined });
  try {
    const cookies = loadTencentCookies();
    await s.page.context().addCookies(cookies);
    console.log(`[probe] injected ${cookies.length} cookies`);

    for (const target of CANDIDATES) {
      console.log(`\n[probe] === ${target} ===`);
      await s.page.goto(target, { waitUntil: 'domcontentloaded' }).catch((e) => console.log(`[probe] goto warn: ${e.message?.slice(0, 80)}`));
      await humanIdlePause('long');
      console.log(`[probe] final URL: ${s.page.url()}`);
      const dump = await s.page.evaluate(() => ({ title: document.title, body: (document.body?.innerText || '').slice(0, 600), btns: Array.from(document.querySelectorAll('button, a')).filter(e => e.offsetParent).slice(0, 8).map(e => (e.innerText || '').trim().slice(0, 60)).filter(t => t) })).catch(() => ({}));
      console.log(`[probe] title: ${dump.title}`);
      console.log(`[probe] body excerpt: ${(dump.body || '').replace(/\n/g, ' | ').slice(0, 400)}`);
      console.log(`[probe] visible buttons: ${JSON.stringify(dump.btns)}`);
    }
    await humanIdlePause('deliberate');
  } finally {
    await s.close();
  }
}

main().catch((e) => { console.error('[probe] fatal:', e); process.exit(1); });
