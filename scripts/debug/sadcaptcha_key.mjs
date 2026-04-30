// Login to SadCaptcha, scrape API key from dashboard.
import { getServiceLogin } from '../../dist/utils/credentials.js';
import { WSession } from '../../dist/session/wsession.js';

const login = await getServiceLogin('SadCaptcha');
if (!login) { console.log('FAIL: no creds'); process.exit(1); }

const s = await WSession.start({ label: 'sadcaptcha_key', browser: 'chromium' });
try {
  await s.goto('https://www.sadcaptcha.com/login');
  await s.page.waitForTimeout(2000);
  const userIn = s.page.locator('input[name="username"], input[type="email"]').filter({ visible: true }).first();
  await userIn.click();
  await userIn.pressSequentially(login.email, { delay: 25 });
  const pwIn = s.page.locator('input[name="password"], input[type="password"]').filter({ visible: true }).first();
  await pwIn.click();
  await pwIn.pressSequentially(login.password, { delay: 25 });
  await pwIn.press('Enter');
  for (let i = 0; i < 15; i++) { await s.page.waitForTimeout(1000); if (!/\/login/.test(s.page.url())) break; }
  console.log('post-login url:', s.page.url());
  await s.page.goto('https://www.sadcaptcha.com/dashboard', { waitUntil: 'domcontentloaded' });
  await s.page.waitForTimeout(5000);
  const txt = await s.page.evaluate(() => document.body.innerText);
  // Look for API key — typically a 32-char hex or similar
  const keyMatch = txt.match(/[a-f0-9]{32,64}/gi);
  console.log('keys found:', keyMatch);
  console.log('--- dashboard text (first 2000 chars) ---');
  console.log(txt.slice(0, 2000));
} catch (e) {
  console.log('FAIL:', e.message);
} finally {
  await s.close();
}
