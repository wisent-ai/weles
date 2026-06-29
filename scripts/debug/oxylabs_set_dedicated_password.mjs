// Set Oxylabs Dedicated ISP sub-user password to a known test value and verify proxy auth.
import { WSession } from '../../dist/session/wsession.js';
import { googleSso, getGoogleSsoCreds } from '../trajectories/_shared/services/google_sso.mjs';
import { humanIdlePause, humanClickLocator } from '../../dist/human/mouse.js';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import net from 'node:net';

const TEST_PASSWORD = 'WisentTest1_';
const OUT = join(process.cwd(), '.work', 'oxylabs_set_dedicated_password');
mkdirSync(OUT, { recursive: true });

const login = await getGoogleSsoCreds();
if (!login) { console.log('FAIL: no Google SSO creds'); process.exit(1); }

const s = await WSession.start({ label: 'oxylabs_set_dedicated_password', browser: 'chromium' });
try {
  await s.goto('https://dashboard.oxylabs.io/');
  await humanIdlePause('long');
  const gsiFrame = s.page.frames().find(f => /gsi\/button/.test(f.url()));
  const popupPromise = s.page.waitForEvent('popup');
  await humanClickLocator(s.page, gsiFrame.locator('div[role="button"]').first());
  const popup = await Promise.race([popupPromise, new Promise((_, rej) => setTimeout(() => rej(new Error('popup-timeout')), 15000))]);
  const ok = await googleSso(s, login, { originHost: 'oxylabs.io', page: popup });
  if (!ok) { console.log('FAIL: Google SSO'); process.exit(1); }
  for (let i = 0; i < 60; i++) { await humanIdlePause('short'); if (!/^https:\/\/dashboard\.oxylabs\.io\/en\/?(\?.*)?$/.test(s.page.url())) break; }

  await s.goto('https://dashboard.oxylabs.io/en/overview/dedicated-isp/users');
  await humanIdlePause('long');
  await s.page.screenshot({ path: join(OUT, '00_users.png'), fullPage: true });

  const editBtn = s.page.locator('tr').filter({ hasText: 'wisentdisp_Bkgs5' }).locator('button, a').filter({ hasText: /Edit user|Change password/i }).first();
  await editBtn.waitFor({ state: 'visible', timeout: 15000 });
  await humanClickLocator(s.page, editBtn);
  await humanIdlePause('long');
  await s.page.screenshot({ path: join(OUT, '01_change_password.png'), fullPage: true });

  // Find password input(s) by type or placeholder.
  const input = s.page.locator('input[type="password"], input[type="text"][name="password"]').filter({ visible: true }).first();
  await input.fill('');
  await input.fill(TEST_PASSWORD);
  await humanIdlePause('short');

  const buttons = await s.page.evaluate(() => Array.from(document.querySelectorAll('button, [role="button"]')).filter(b => b.offsetParent).map(b => b.innerText.trim()).slice(0, 30));
  writeFileSync(join(OUT, 'buttons.json'), JSON.stringify(buttons, null, 2));
  console.log('visible buttons before save:', buttons);

  const saveBtn = s.page.locator('button:has-text("Save"), button:has-text("Submit"), button:has-text("Update"), button:has-text("Confirm"), button[type="submit"]').filter({ visible: true }).last();
  await saveBtn.click({ force: true }).catch(() => {});
  await humanIdlePause('deliberate');
  await s.page.screenshot({ path: join(OUT, '02_after_save.png'), fullPage: true });
  const text = await s.page.evaluate(() => document.body.innerText);
  writeFileSync(join(OUT, 'after_save.txt'), text);
  console.log('after save text:', text.slice(0, 1500));

  function probe({ host, port, username, password }) {
    return new Promise((resolve) => {
      const sock = net.connect({ host, port, timeout: 10000 });
      let done = false;
      const finish = (r) => { if (done) return; done = true; try { sock.destroy(); } catch {} resolve(r); };
      sock.on('error', e => finish({ error: e.message }));
      sock.on('timeout', () => finish({ error: 'timeout' }));
      sock.on('connect', () => {
        const auth = Buffer.from(`${username}:${password}`).toString('base64');
        sock.write(`CONNECT api.ipify.org:443 HTTP/1.1\r\nHost: api.ipify.org:443\r\nProxy-Authorization: Basic ${auth}\r\n\r\n`);
      });
      let buf = '';
      sock.on('data', c => { buf += c.toString('latin1'); if (buf.includes('\r\n\r\n')) finish({ raw: buf.slice(0, 2000) }); });
    });
  }
  const pres = await probe({ host: 'disp.oxylabs.io', port: 8001, username: 'customer-wisentdisp_Bkgs5', password: TEST_PASSWORD });
  console.log('proxy auth result:', pres.raw?.split('\r\n')[0] || pres.error);
} finally {
  await s.close();
}
