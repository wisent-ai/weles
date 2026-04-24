import { WSession } from '../../../dist/session/wsession.js';
import { approveQr } from './_qr_approve.mjs';

const SIGNUP_URL = 'https://accounts.google.com/signup/v2/createaccount?biz=false&cc=US&continue=https%3A%2F%2Fwww.youtube.com%2Fsignin%3Faction_handle_signin%3Dtrue&dsh=S0&flowEntry=SignUp&flowName=GlifWebSignIn&hl=en&service=youtube';
const MAX_RETRIES = 15;
const USE_BRIGHTDATA = !!process.env.BRIGHTDATA_BROWSER_WS;
const BASE_PROXY = USE_BRIGHTDATA ? 'none' : (process.env.PROXY_URL || 'residential');
const sleep = (s) => new Promise(r => setTimeout(r, s * 1000));

// Rotate sticky-session id per attempt so a dead/overloaded relay on one
// session doesn't block every attempt. Works for PacketStream / IPRoyal /
// Pingproxies / Oxylabs URL formats that embed session-NNNN in user or pass.
function freshProxy() {
  if (!BASE_PROXY || BASE_PROXY === 'none' || !BASE_PROXY.startsWith('http')) return BASE_PROXY;
  const sid = Math.floor(Math.random() * 9_000_000 + 1_000_000);
  return BASE_PROXY
    .replace(/session-\d+/g, `session-${sid}`)
    .replace(/sessid-\d+/g, `sessid-${sid}`)
    .replace(/_s_\d+/g, `_s_${sid}`);
}

async function readPage(s) {
  return (await s.page.evaluate(`(() => (document.body?.innerText ?? '').substring(0, 2000))()`).catch(() => '')).toLowerCase();
}

async function clickNext(s) {
  await s.click('Next').catch(() => {});
  // Also try a locator-click on Next in one of the common locale strings.
  await s.page.locator('button, div[role="button"]').filter({ hasText: /^(next|weiter|suivant|siguiente)$/i }).first().click().catch(() => {});
}

async function signup(s) {
  const id = await s.generateIdentity('google');
  const gmailUser = id.username.toLowerCase().replace(/[^a-z0-9]/g, '');
  const firstName = id.firstName;
  const lastName = id.lastName;
  console.log(`[google] identity: ${firstName} ${lastName} / ${gmailUser}@gmail.com`);

  // Fail fast on proxy/tunnel errors so outer loop rotates to a fresh sticky session.
  const isProxyErr = (m) => /TUNNEL_CONNECTION_FAILED|PROXY_CONNECTION_FAILED|ABORTED|EMPTY_RESPONSE|TIMED_OUT|502|nav_timed_out/.test(m ?? '');
  // Wall-clock watchdog around goto. Playwright's default timeout is disabled
  // in wsession (0=infinite), so without this a silent relay hangs forever.
  const wallTime = (p, ms) => Promise.race([p, new Promise((_, rj) => setTimeout(() => rj(new Error('nav_timed_out')), ms))]);
  // Navigate to signup URL. waitUntil: 'commit' fires when response headers
  // arrive (fastest sync point) — main content will finish loading during
  // our subsequent sleep. Budget: 90s since the residential relay can be
  // slow on the first real HTTP request through a fresh tunnel.
  try {
    const r = await wallTime(s.page.goto(SIGNUP_URL, { waitUntil: 'commit' }), 90_000);
    console.log(`[google] signup nav ok: status=${r?.status()} url=${r?.url()?.slice(0, 80)}`);
  } catch (e) {
    console.log(`[google] signup nav err: ${e.message?.slice(0, 200)}`);
    if (isProxyErr(e.message)) throw new Error('proxy_dead');
    throw e;
  }
  // Wait for form to render: first-name input appears.
  try { await s.page.locator('input[name="firstName"]').waitFor({ state: 'visible' }); }
  catch (e) { console.log(`[google] form wait err: ${e.message?.slice(0, 150)}`); }
  await sleep(2);

  // Step 2: first / last name
  console.log('[google] step 2: name');
  await s.fill('First name', firstName).catch(() => {});
  await sleep(0.5);
  await s.fill('Last name', lastName).catch(() => {});
  await sleep(1);
  await clickNext(s);
  await sleep(4);

  // Step 3: birthday + gender
  // Google uses Material Design comboboxes — JS .click() is ignored (isTrusted=false).
  // Use Playwright locator clicks directly (trusted via CDP).
  console.log('[google] step 3: birthday + gender');
  const birthMonth = Number(id.birthMonth) || 6;

  await s.page.locator('#month').click().catch((e) => console.log(`[google] #month click: ${e.message?.slice(0, 60)}`));
  await sleep(1.5);
  await s.page.locator(`li[data-value="${birthMonth}"]`).first().click({ force: true }).catch((e) => console.log(`[google] month option click: ${e.message?.slice(0, 60)}`));
  await sleep(1);

  await s.page.locator('input[name="day"], input#day').first().fill(String(id.birthDay)).catch(() => {});
  await sleep(0.3);
  await s.page.locator('input[name="year"], input#year').first().fill(String(id.birthYear)).catch(() => {});
  await sleep(0.5);

  // Gender: click the role=combobox labeled "Gender", then click the "Rather not say" option
  const genderCombobox = s.page.getByRole('combobox', { name: /^gender$/i });
  await genderCombobox.click().catch((e) => console.log(`[google] gender combobox click: ${e.message?.slice(0, 60)}`));
  await sleep(1.5);
  // Options render as [role="option"] after opening
  await s.page.getByRole('option', { name: /rather not say/i }).click().catch((e) => console.log(`[google] gender option click: ${e.message?.slice(0, 60)}`));
  await sleep(1);

  const genderVal = await s.page.evaluate(`(() => {
    // Look for selected value — may be in combobox textContent or a hidden input
    var cb = Array.from(document.querySelectorAll('[role="combobox"]')).find(el => /gender/i.test(el.textContent || ''));
    return cb ? cb.textContent.trim() : '';
  })()`).catch(() => '');
  console.log(`[google] gender: ${genderVal || '(empty)'}`);

  const urlBefore = s.page.url?.() ?? '';
  await clickNext(s);
  await sleep(4);
  const urlAfter = s.page.url?.() ?? '';
  if (urlBefore === urlAfter && urlAfter.includes('birthdaygender')) {
    console.log('[google] stuck on birthday/gender page (URL unchanged)');
    throw new Error('birthday_stuck');
  }

  // Step 4: username
  console.log(`[google] step 4: username ${gmailUser}`);
  await s.click('Create your own Gmail address').catch(() => {});
  await sleep(1);
  await s.fill('Username', gmailUser).catch(() => {});
  await sleep(1);
  await clickNext(s);
  await sleep(4);

  let pageText = await readPage(s);
  if (pageText.includes('taken') || pageText.includes('already')) {
    const retry = gmailUser + String(Math.floor(Math.random() * 900 + 100));
    console.log(`[google] username taken, retrying ${retry}`);
    await s.fill('Username', retry).catch(() => {});
    await sleep(1);
    await clickNext(s);
    await sleep(4);
  }

  // Step 5: password
  console.log('[google] step 5: password');
  await s.fill('Password', id.password).catch(() => {});
  await sleep(0.5);
  await s.fill('Confirm', id.password).catch(() => {});
  await sleep(1);
  await clickNext(s);
  await sleep(5);

  // Step 6: phone verification (or QR code block). Try hard to reach a phone input.
  async function findPhoneInput() {
    return await s.page.evaluate(`(() => {
      // Match any visible tel-like input. Google rotates name/id across locales
      // and A/B tests, so also accept inputs whose aria-label mentions phone.
      var el = Array.from(document.querySelectorAll('input')).find(i => {
        if (i.offsetParent === null) return false;
        var type = (i.type || '').toLowerCase();
        var name = (i.name || '').toLowerCase();
        var id = (i.id || '').toLowerCase();
        var ac = (i.getAttribute('autocomplete') || '').toLowerCase();
        var al = (i.getAttribute('aria-label') || '').toLowerCase();
        // Exclude birthday fields — Google uses type=tel for them too.
        if (/^(day|month|year)$/.test(name) || /^(day|month|year)$/.test(id) || /birth|day|month|year/.test(al)) return false;
        return ac === 'tel' || /phone/.test(name) || /phone/.test(id) || /phone/.test(al);
      });
      if (!el) return null;
      if (el.id) return '#' + el.id;
      if (el.name) return 'input[name="' + el.name + '"]';
      return 'input[type="tel"]';
    })()`).catch(() => null);
  }

  pageText = await readPage(s);
  const url = s.page.url?.() ?? '';
  console.log(`[google] step 6: url=${url.slice(-40)} text=${pageText.slice(0, 100).replace(/\n/g, ' ')}`);

  let phoneSel = await findPhoneInput();

  // If page looks like QR code, systematically try alternative paths
  if (!phoneSel && (pageText.includes('qr code') || pageText.includes('scan') || pageText.includes('verify some info'))) {
    console.log('[google] QR/verify step — trying alternative paths');
    for (const alt of ['Try another way', "can't scan", 'Use phone instead', 'another method', 'Text message', 'Call me', 'Verify by phone']) {
      if (phoneSel) break;
      await s.click(alt).catch(() => {});
      await sleep(3);
      phoneSel = await findPhoneInput();
      if (phoneSel) console.log(`[google] got phone input via "${alt}"`);
    }
    if (!phoneSel) {
      // No phone option — try QR approval via pre-saved approver cookies.
      try {
        await approveQr(s.page);
        console.log('[google] QR approved — waiting for phone-entry page');
      } catch (e) {
        console.log(`[google] QR approval failed: ${e.message?.slice(0, 200)}`);
        throw new Error('qr_code_blocked');
      }
      // After approval Google goes to /mophoneverification/initial which is
      // an intro screen with a Next/Continue button, then /phonenumber which
      // has the actual input. Click repeatedly and dump buttons when stuck.
      for (let i = 0; i < 20; i++) {
        phoneSel = await findPhoneInput();
        const u = s.page.url?.() ?? '';
        if (phoneSel) { console.log(`[google] phone input appeared via ${phoneSel} (url=${u.slice(-60)})`); break; }
        if (i === 3 || i === 10) {
          const btns = await s.page.evaluate(`(() => Array.from(document.querySelectorAll('button, [role="button"], a'))
            .filter(e => e.offsetParent !== null).map(e => ((e.innerText || e.textContent || '').trim() || e.getAttribute('aria-label') || '').slice(0, 40)).filter(Boolean))()`).catch(() => []);
          console.log(`[google] mophone buttons (url=${u.slice(-50)}): ${JSON.stringify(btns).slice(0, 300)}`);
        }
        await clickNext(s);
        await s.click('Continue').catch(() => {});
        await s.click('Use phone number').catch(() => {});
        await sleep(3);
      }
    }
  }

  if (phoneSel) {
    console.log(`[google] phone verification via ${phoneSel}`);
    const smsRes = await s.checkSms('google', 'US');
    if (smsRes.startsWith('error')) {
      console.log(`[google] SMS error: ${smsRes}`);
      throw new Error('sms_unavailable');
    }
    const phone = smsRes.replace(/^phone:\s*/i, '').trim();
    console.log(`[google] phone: ${phone}`);
    await s.page.locator(phoneSel).first().fill(phone).catch(async () => {
      await s.page.locator(phoneSel).first().click().catch(() => {});
      await s.page.keyboard.type(phone, { delay: 40 }).catch(() => {});
    });
    await sleep(1);
    await clickNext(s);
    await sleep(6);

    console.log('[google] waiting for SMS code...');
    const code = await s.pollSmsCode();
    if (!code || code.startsWith('error') || code.includes('no code')) {
      throw new Error('sms_timeout');
    }
    console.log(`[google] SMS code: ${code}`);
    for (const cs of ['input[name="code"]', 'input[type="tel"]', 'input#code']) {
      const el = s.page.locator(cs).first();
      if (await el.isVisible().catch(() => false)) {
        await el.fill(code).catch(() => {});
        break;
      }
    }
    await sleep(1);
    await clickNext(s);
    await sleep(5);
  } else if (pageText.includes('skip')) {
    await s.click('Skip').catch(() => {});
    await sleep(3);
  }

  // Step 7+8: skip recovery email, accept terms, confirm
  for (let i = 0; i < 6; i++) {
    pageText = await readPage(s);
    if (pageText.includes('recovery') || pageText.includes('add another')) { await s.click('Skip').catch(() => {}); }
    if (pageText.includes('i agree') || pageText.includes('agree to')) { await s.page.evaluate(`window.scrollTo(0, document.body.scrollHeight)`).catch(() => {}); await sleep(1); await s.click('I agree').catch(() => {}); await s.click('Accept').catch(() => {}); }
    if (pageText.includes('confirm') && pageText.includes('account')) { await s.click('Confirm').catch(() => {}); }
    await clickNext(s);
    await sleep(3);
    const u = s.page.url?.() ?? '';
    if (u.includes('myaccount.google.com') || u.includes('mail.google.com') || u.includes('youtube.com')) break;
  }

  // Verify success
  const finalUrl = s.page.url?.() ?? '';
  const cookies = await s.ctx.cookies().catch(() => []);
  const googleCookies = cookies.filter(c => c.domain?.includes('google.com') && /^(SID|HSID|SSID|SAPISID|APISID|__Secure-\w+)/.test(c.name));
  console.log(`[google] final url: ${finalUrl}, auth cookies: ${googleCookies.map(c => c.name).join(',')}`);
  if (googleCookies.length < 2) throw new Error('no_auth_cookies');

  const result = await s.saveAccount('google', {
    username: gmailUser,
    email: `${gmailUser}@gmail.com`,
    password: id.password,
    name: `${firstName} ${lastName}`,
  });
  console.log(`[google] ${result}`);
  return gmailUser;
}

function instrumentSession(s) {
  s.page.on('crash', () => console.log('[evt] RENDERER CRASHED'));
  s.ctx.on('close', () => console.log('[evt] ctx.close'));
  const br = s.ctx.browser?.();
  if (br) br.on('disconnected', () => console.log('[evt] browser.disconnected'));
}

for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
  const proxy = freshProxy();
  console.log(`\n=== Google signup attempt ${attempt}/${MAX_RETRIES} proxy=${proxy.slice(-60)} ===`);
  const s = await WSession.start({ label: `google_register_${attempt}`, proxy });
  instrumentSession(s);
  try {
    const username = await signup(s);
    console.log(`PASS: ${username}`);
    await s.close();
    process.exit(0);
  } catch (e) {
    console.log(`FAIL (attempt ${attempt}): ${e.message?.slice(0, 200)}`);
    await s.close().catch(() => {});
    if (attempt === MAX_RETRIES) { console.log('All attempts exhausted'); process.exit(1); }
    await sleep(3);
  }
}
