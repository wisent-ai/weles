// Bright Data zone credentials extractor.
//
// Logs into BrightData via Google SSO, navigates to /cp/zones, picks the
// first residential zone (or creates one if none exist), scrapes the zone
// username + password from the Access Parameters panel, and prints them
// as ENV-variable assignments for the operator to paste into .env.
//
// Why we need this: weles' resolveProxy expects BRIGHTDATA_USERNAME +
// BRIGHTDATA_PASSWORD. The DB row for "Bright Data" only has the Google
// SSO login (lukasz.bartoszcze@gmail.com), not the per-zone proxy
// credentials. This trajectory bridges that gap.
//
// 2FA: the operator will get a Google "Was that you?" tap-to-approve
// notification on their phone during SSO. The trajectory waits up to 90s.

import { getServiceLogin } from '../../../dist/utils/credentials.js';
import { WSession } from '../../../dist/session/wsession.js';
import { googleSso } from '../_shared/services/google_sso.mjs';

const login = await getServiceLogin('Bright Data');
if (!login) { console.log('FAIL: no Bright Data creds in service_credentials'); process.exit(1); }
console.log(`[trajectory] Using service login: ${login.email}`);

const s = await WSession.start({ label: 'brightdata_get_zone_credentials', browser: 'chromium' });

try {
  await s.goto('https://brightdata.com/cp/login');
  await s.page.waitForTimeout(2500);

  await s.page.locator('button:has-text("Log in with Google")').filter({ visible: true }).first().click();

  const ok = await googleSso(s, login, { originHost: 'brightdata.com' });
  if (!ok) { console.log('FAIL: Google SSO did not return to brightdata.com'); process.exit(1); }
  await s.page.waitForTimeout(4000);

  // Dismiss any first-login modal/survey popups.
  for (const sel of ['button:has-text("Skip")', 'button:has-text("X")', '[aria-label="Close"]', 'button:has-text("Got it")', 'button:has-text("Maybe later")']) {
    const btn = s.page.locator(sel).first();
    if (await btn.isVisible().catch(() => false)) {
      await btn.click({ force: true }).catch(() => {});
      await s.page.waitForTimeout(400);
    }
  }

  // Step 1: list zones at /cp/zones (the "My Proxies" section).
  console.log('[trajectory] navigating to /cp/zones');
  await s.page.goto('https://brightdata.com/cp/zones', { waitUntil: 'domcontentloaded' });
  await s.page.waitForTimeout(6000);

  // Skip "What is your role?" + similar onboarding modals that block the page.
  for (const sel of ['button:has-text("Skip")', 'a:has-text("Skip")', 'button:has-text("Skip for now")', '[aria-label="Close"]', 'button[aria-label="Close"]']) {
    const btn = s.page.locator(sel).filter({ visible: true }).first();
    if (await btn.isVisible().catch(() => false)) {
      await btn.click({ force: true }).catch(() => {});
      console.log(`[trajectory] dismissed modal via ${sel}`);
      await s.page.waitForTimeout(1000);
    }
  }

  // BrightData uses a custom non-<tr> table for zones. Match any anchor whose
  // path is /cp/zones/<name> and exclude the known sidebar/nav slugs. The
  // actual zones page also has the zone name as plain text in a div with
  // class containing "name". Use both signals.
  const zones = await s.page.evaluate(() => {
    const out = [];
    const navList = ['dashboard', 'event_log', 'playground', 'documentation', 'new', 'create'];
    // Pattern A: anchor to zone detail.
    for (const a of document.querySelectorAll('a[href*="/cp/zones/"]')) {
      const href = a.getAttribute('href') || '';
      const m = href.match(/\/cp\/zones\/([^/?#]+)$/);
      if (!m) continue;
      if (navList.includes(m[1].toLowerCase())) continue;
      const row = a.closest('tr') || a.closest('[role="row"]') || a.closest('div');
      out.push({ name: m[1], rowText: (row?.textContent || '').slice(0, 200), via: 'anchor' });
    }
    // Pattern B: zone names in body text matching residential_proxy* / dc_proxy* / mobile_proxy*.
    const bodyText = document.body.innerText || '';
    for (const re of [/\bresidential_proxy\d*\b/g, /\bdc_proxy\d*\b/g, /\bmobile_proxy\d*\b/g, /\bisp_proxy\d*\b/g]) {
      let m; while ((m = re.exec(bodyText)) !== null) out.push({ name: m[0], rowText: '', via: 'bodytext' });
    }
    return out;
  });
  // De-dup
  const seen = new Set();
  const uniqueZones = zones.filter(z => { if (seen.has(z.name)) return false; seen.add(z.name); return true; });
  console.log(`[trajectory] found ${uniqueZones.length} actual zone(s) (deduped)`);
  for (const z of uniqueZones.slice(0, 8)) console.log(`  - ${z.name} (via=${z.via}) row="${z.rowText.slice(0, 80).replace(/\s+/g,' ')}"`);
  // Substitute the deduped list into the original variable.
  const zonesArr = uniqueZones;
  let resi = zonesArr.find(z => /residential/i.test(z.name) && !/isp|datacenter|mobile/i.test(z.name)) ?? zonesArr.find(z => /residential/i.test(z.rowText)) ?? zonesArr[0];

  if (!resi) {
    // No zone exists yet. Click "Create Proxy" — the button is in the page
    // but may be off-screen / inside a fixed toolbar so isVisible() lies.
    // Use force:true to bypass the visibility check.
    console.log('[trajectory] no zones — clicking "Create Proxy"');
    await s.page.locator('button:has-text("Create Proxy")').first().click({ force: true }).catch((e) => console.log(`[trajectory] Create Proxy click err: ${e.message?.slice(0,80)}`));
    await s.page.waitForTimeout(5000);
    console.log(`[trajectory] post-click url=${s.page.url()}`);
    await s.page.screenshot({ path: 'recordings/brightdata_get_zone_credentials/after_create_proxy.png', fullPage: true }).catch(() => {});
    const postClickButtons = await s.page.evaluate(() => Array.from(document.querySelectorAll('button, a, [role="button"]'))
      .filter(b => b.offsetParent !== null && (b.textContent || '').trim().length > 0)
      .slice(0, 40)
      .map(b => ({ tag: b.tagName, text: (b.textContent || '').trim().slice(0, 80), href: b.getAttribute?.('href') })));
    console.log('[trajectory] visible buttons/links after Create Proxy click:');
    for (const b of postClickButtons) console.log(`  ${b.tag} "${b.text}" href=${b.href}`);

    // Pick "Residential proxies" product card.
    for (const sel of [
      'div:has-text("Residential proxies")',
      'button:has-text("Residential proxies")',
      'div[data-id*="residential"]',
      'div:has-text("Residential")',
    ]) {
      const c = s.page.locator(sel).filter({ visible: true }).first();
      if (await c.isVisible().catch(() => false)) {
        await c.click({ force: true }).catch(() => {});
        console.log(`[trajectory] picked product: ${sel}`);
        await s.page.waitForTimeout(2500);
        break;
      }
    }

    // Click through Add zone / Activate / Save / Continue.
    for (let step = 0; step < 5; step++) {
      let clicked = false;
      for (const sel of [
        'button:has-text("Add zone")',
        'button:has-text("Activate")',
        'button:has-text("Start")',
        'button:has-text("Continue")',
        'button:has-text("Save")',
        'button:has-text("Confirm")',
        'button:has-text("Add")',
      ]) {
        const c = s.page.locator(sel).filter({ visible: true }).first();
        if (await c.isVisible().catch(() => false)) {
          await c.click({ force: true }).catch(() => {});
          console.log(`[trajectory] step${step}: clicked ${sel}`);
          await s.page.waitForTimeout(3500);
          clicked = true;
          break;
        }
      }
      if (!clicked) break;
    }

    // Re-list zones after creation.
    await s.page.goto('https://brightdata.com/cp/zones', { waitUntil: 'domcontentloaded' });
    await s.page.waitForTimeout(6000);
    const zones2 = await s.page.evaluate(() => {
      const out = [];
      const links = document.querySelectorAll('a[href*="/cp/zones/"]');
      const navList = ['dashboard', 'event_log', 'playground', 'documentation', 'new', 'create'];
      for (const a of links) {
        const href = a.getAttribute('href') || '';
        const m = href.match(/\/cp\/zones\/([^/?#]+)$/);
        if (!m) continue;
        if (navList.includes(m[1].toLowerCase())) continue;
        const row = a.closest('tr') || a.closest('[role="row"]');
        if (!row) continue;
        out.push({ name: m[1], rowText: (row?.textContent || '').trim().slice(0, 200) });
      }
      return out;
    });
    console.log(`[trajectory] after-create: found ${zones2.length} zone(s)`);
    for (const z of zones2.slice(0, 6)) console.log(`  - name=${z.name}`);
    resi = zones2.find(z => /residential/i.test(z.rowText) && !/isp|datacenter|mobile/i.test(z.rowText)) ?? zones2[0];
    if (!resi) {
      console.log('FAIL: no zones after create attempt. Listing visible buttons + links on /cp/zones:');
      const debug = await s.page.evaluate(() => {
        const btns = Array.from(document.querySelectorAll('button, a'))
          .filter(b => b.offsetParent !== null)
          .slice(0, 30)
          .map(b => ({ tag: b.tagName, text: (b.textContent || '').trim().slice(0, 60), href: b.getAttribute?.('href') }));
        return btns;
      });
      console.log(JSON.stringify(debug, null, 2));
      process.exit(2);
    }
  }
  console.log(`[trajectory] selected zone: ${resi.name}`);

  // Step 2: open zone detail. BrightData uses JS-driven navigation — there's
  // no /cp/zones/<name> URL. Click the zone-name text in the table to trigger
  // the correct in-app routing.
  console.log(`[trajectory] clicking zone name "${resi.name}" to open detail`);
  // Use a Playwright locator that matches an exact-text-content element. The
  // zone-list table renders the name in either an <a>, <td>, or role=cell.
  // Locator click goes through CDP so trust signals are clean.
  const zoneLink = s.page.locator(`a, button, [role="button"], [role="link"], [role="cell"], td, span, div`).filter({ hasText: new RegExp(`^\\s*${resi.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`) }).filter({ visible: true }).first();
  let clicked = { found: false };
  if (await zoneLink.count()) {
    await zoneLink.click({ force: true }).catch(() => {});
    const tag = await zoneLink.evaluate(el => el.tagName).catch(() => '');
    clicked = { found: true, tag };
  }
  console.log(`[trajectory] click result:`, JSON.stringify(clicked));
  await s.page.waitForTimeout(8000);
  console.log(`[trajectory] after-click url=${s.page.url()}`);
  await s.page.screenshot({ path: 'recordings/brightdata_get_zone_credentials/zone_detail.png', fullPage: true }).catch(() => {});

  // Skip any modals that appear on the zone detail page.
  for (const sel of ['button:has-text("Skip")', 'button:has-text("Got it")', 'button[aria-label="Close"]', '[aria-label="Close"]', 'button:has-text("Close")']) {
    const btn = s.page.locator(sel).filter({ visible: true }).first();
    if (await btn.isVisible().catch(() => false)) { await btn.click({ force: true }).catch(() => {}); await s.page.waitForTimeout(500); }
  }

  // The password may need updating before it's usable. Look for "Update password"
  // / "Generate password" / "Reset password" CTAs and click them. BrightData
  // periodically expires zone passwords and shows a banner asking for rotation.
  for (const sel of [
    'button:has-text("Update password")',
    'button:has-text("Generate password")',
    'button:has-text("Reset password")',
    'button:has-text("New password")',
    'a:has-text("Update password")',
  ]) {
    const btn = s.page.locator(sel).filter({ visible: true }).first();
    if (await btn.isVisible().catch(() => false)) {
      console.log(`[trajectory] clicking ${sel} to rotate the zone password`);
      await btn.click({ force: true }).catch(() => {});
      await s.page.waitForTimeout(2500);
      // Confirmation dialog may appear; click Confirm/Yes/Update.
      for (const csel of ['button:has-text("Update")', 'button:has-text("Confirm")', 'button:has-text("Yes")', 'button:has-text("Continue")']) {
        const c = s.page.locator(csel).filter({ visible: true }).first();
        if (await c.isVisible().catch(() => false)) { await c.click({ force: true }).catch(() => {}); await s.page.waitForTimeout(2500); break; }
      }
      break;
    }
  }

  // Click any "Show password" / eye-icon toggle to reveal the password.
  for (const sel of [
    'button[aria-label*="Show" i]',
    'button[aria-label*="reveal" i]',
    'button[title*="Show" i]',
    '[data-test*="show-password"]',
    '[data-id*="show-password"]',
    'svg[data-icon="eye"]',
    'i.fa-eye',
    '.eye-icon',
  ]) {
    const els = await s.page.locator(sel).all().catch(() => []);
    for (const el of els) {
      if (await el.isVisible().catch(() => false)) {
        await el.click({ force: true }).catch(() => {});
        await s.page.waitForTimeout(300);
      }
    }
  }
  await s.page.waitForTimeout(1500);
  await s.page.screenshot({ path: 'recordings/brightdata_get_zone_credentials/after_reveal.png', fullPage: true }).catch(() => {});

  // Scrape access params. BrightData typically renders them as labeled rows
  // ("Host: ... Port: ... User: brd-customer-... Password: ...").
  const creds = await s.page.evaluate(() => {
    const text = document.body.innerText;
    // Try labeled form first.
    const grab = (label) => {
      const re = new RegExp(`${label}\\s*[:\\n]\\s*([\\S]+)`, 'i');
      const m = text.match(re);
      return m ? m[1].trim() : null;
    };
    const username = grab('User') ?? grab('Username') ?? grab('Login');
    const password = grab('Password') ?? grab('Pass');
    const host = grab('Host') ?? grab('Server');
    const port = grab('Port');
    // Fallback: scan inputs for value attributes (Bright Data often puts
    // username + password in <input value="..."> elements).
    const inputs = Array.from(document.querySelectorAll('input'));
    const values = inputs.map(i => ({ id: i.id || i.name || '', type: i.type, value: i.value || '' }));
    return { username, password, host, port, inputs: values, textSnippet: text.slice(0, 1500) };
  });

  // BrightData username pattern: brd-customer-<customerId>-zone-<zoneName>[-extras]
  const looksLikeUser = (s) => /^brd-customer-/.test(s ?? '');

  let username = creds.username;
  if (!looksLikeUser(username)) {
    // Try input scan: pick the input whose value starts with brd-customer-
    const cand = creds.inputs.find(i => looksLikeUser(i.value));
    if (cand) username = cand.value;
  }

  let password = creds.password;
  // Most zone passwords are 12-char alphanumeric. Reject obvious non-passwords.
  const looksLikePassword = (s) => typeof s === 'string' && /^[A-Za-z0-9_!-]{8,40}$/.test(s) && !/[\s,;]/.test(s);
  if (!looksLikePassword(password)) {
    // Try input[type=password] scan.
    const cand = creds.inputs.find(i => i.type === 'password' && looksLikePassword(i.value));
    if (cand) password = cand.value;
  }
  if (!looksLikePassword(password)) {
    // Scan ALL inputs for short alphanumeric strings that aren't the username.
    const cand = creds.inputs.find(i => i.value && i.value !== username && looksLikePassword(i.value));
    if (cand) password = cand.value;
  }

  console.log('---');
  console.log(`zone_name        : ${resi.name}`);
  console.log(`zone_username    : ${username ?? '(NOT FOUND)'}`);
  console.log(`zone_password    : ${password ?? '(NOT FOUND)'}`);
  console.log(`host             : ${creds.host ?? 'brd.superproxy.io (default)'}`);
  console.log(`port             : ${creds.port ?? '22225 (default)'}`);
  console.log('---');
  if (!username || !password) {
    console.log('FAIL: could not extract username + password from zone page. First 600 chars of page text:');
    console.log(creds.textSnippet.slice(0, 600).replace(/\n/g, ' | '));
    console.log('inputs found:', JSON.stringify(creds.inputs.slice(0, 12)));
    process.exit(3);
  }

  console.log('');
  console.log('=== ENV VARS TO ADD TO weles/.env ===');
  console.log(`BRIGHTDATA_USERNAME=${username}`);
  console.log(`BRIGHTDATA_PASSWORD=${password}`);
  console.log(`BRIGHTDATA_ZONE=${resi.name}`);
  console.log('=====================================');
  console.log('');
  console.log(`PASS: scraped zone credentials for ${resi.name}`);
} catch (e) {
  console.log('FAIL:', e.message?.slice(0, 300));
  process.exit(1);
} finally {
  await s.close();
}
