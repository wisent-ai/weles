import { WSession } from '../../../dist/session/wsession.js';
import { doGoogleSso, waitForEnabledThenClick } from './google_sso.mjs';

const login = {
  email: process.env.CODEX_EMAIL || '',
  password: process.env.CODEX_PASSWORD || '',
};
if (!login.email || !login.password) {
  console.error('Set CODEX_EMAIL and CODEX_PASSWORD');
  process.exit(1);
}

const session = await WSession.start({ label:'inspect_settings', headless:false, browser:'chromium' });
const page = session.page;

try {
  await doGoogleSso({
    page, login, authorizeUrl: 'https://chatgpt.com/auth/login', mark: () => {},
    humanFill: async (p, loc, text) => { await loc.fill(text); },
    humanClickLocator: async (p, loc) => { await loc.click(); },
    humanIdlePause: async () => { await page.waitForTimeout(500); },
    humanType: async (p, text) => { await page.keyboard.type(text); },
  });
} catch (e) {
  console.log('google sso result:', e.message);
}

try {
  await waitForEnabledThenClick(page, /continue with google/i);
  for (let i=0;i<100;i++){
    const url = page.url();
    const body = await page.evaluate(()=>document.body?.innerText||'').catch(()=>'');
    if (/chatgpt\.com/.test(url) && !/auth\/login|log in or sign up/i.test(body)) break;
    await page.waitForTimeout(300);
  }
} catch (e) { console.log('chatgpt gis error:', e.message); }

const anchors = ['#settings/data-controls','#settings/security','#settings/security-and-login','#settings/safety','#settings/apps'];
for (const anchor of anchors) {
  try {
    await page.goto(`https://chatgpt.com/${anchor}`, { waitUntil:'commit' });
  } catch (e) {
    if (!/interrupted by another navigation/i.test(e.message)) throw e;
  }
  await page.waitForTimeout(3000);
  const text = await page.evaluate(() => (document.body?.innerText || '').replace(/\s+/g,' '));
  const found = text.match(/device code.{0,120}/i) || text.match(/codex.{0,80}auth/i) || text.match(/codex.{0,80}device/i);
  console.log(`\n=== ${anchor} ===`);
  console.log(found ? found[0] : '(no device code mention)');
}

await session.close();
