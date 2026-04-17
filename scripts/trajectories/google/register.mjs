import { WSession } from '../../../dist/session/wsession.js';

const SIGNUP_URL = 'https://accounts.google.com/signup/v2/createaccount?biz=false&cc=US&continue=https%3A%2F%2Fwww.youtube.com%2Fsignin%3Faction_handle_signin%3Dtrue&dsh=S0&flowEntry=SignUp&flowName=GlifWebSignIn&hl=en&service=youtube';
const MAX_RETRIES = 3;
const USE_BRIGHTDATA = !!process.env.BRIGHTDATA_BROWSER_WS;
const proxy = USE_BRIGHTDATA ? 'none' : (process.env.PROXY_URL || 'residential');
const sleep = (s) => new Promise(r => setTimeout(r, s * 1000));

async function readPage(s) {
  return (await s.page.evaluate(`(() => (document.body?.innerText ?? '').substring(0, 2000))()`).catch(() => '')).toLowerCase();
}

async function clickNext(s) {
  await s.click('Next').catch(() => {});
  await s.page.evaluate(`(() => {
    var btns = Array.from(document.querySelectorAll('button, div[role="button"]'));
    var next = btns.find(b => /^(next|weiter|suivant|siguiente)$/i.test(b.textContent?.trim() ?? ''));
    if (next) next.click();
  })()`).catch(() => {});
}

async function signup(s) {
  const id = await s.generateIdentity('google');
  const gmailUser = id.username.toLowerCase().replace(/[^a-z0-9]/g, '');
  const firstName = id.firstName;
  const lastName = id.lastName;
  console.log(`[google] identity: ${firstName} ${lastName} / ${gmailUser}@gmail.com`);

  // Prewarm: visit youtube.com so the referrer looks natural
  await s.goto('https://www.youtube.com').catch(() => {});
  await sleep(2);

  // Step 1: navigate to signup
  await s.goto(SIGNUP_URL);
  await sleep(5);

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

  // Step 6: phone verification (or QR code block)
  pageText = await readPage(s);
  const url = s.page.url?.() ?? '';
  console.log(`[google] step 6: url=${url.slice(-40)} text=${pageText.slice(0, 80).replace(/\n/g, ' ')}`);

  if (pageText.includes('qr code') || (pageText.includes('scan') && pageText.includes('phone'))) {
    console.log('[google] QR code block — trying "Try another way"');
    await s.click('Try another way').catch(() => {});
    await s.click("can't scan").catch(() => {});
    await sleep(3);
    pageText = await readPage(s);
    if (pageText.includes('qr code') || pageText.includes('scan')) {
      throw new Error('qr_code_blocked');
    }
  }

  if (pageText.includes('phone') || pageText.includes('verify')) {
    console.log('[google] phone verification page');
    const smsRes = await s.checkSms('google', 'US');
    if (smsRes.startsWith('error')) {
      console.log(`[google] SMS error: ${smsRes}`);
      throw new Error('sms_unavailable');
    }
    const phone = smsRes.replace(/^phone:\s*/i, '').trim();
    console.log(`[google] phone: ${phone}`);
    await s.fill('Phone number', phone).catch(() => {});
    await sleep(1);
    await clickNext(s);
    await sleep(5);

    console.log('[google] waiting for SMS code...');
    const code = await s.pollSmsCode();
    if (!code || code.startsWith('error') || code.includes('no code')) {
      throw new Error('sms_timeout');
    }
    console.log(`[google] SMS code: ${code}`);
    await s.fill('Enter code', code).catch(() => {});
    await s.fill('code', code).catch(() => {});
    await sleep(1);
    await clickNext(s);
    await sleep(5);
  } else if (pageText.includes('skip')) {
    await s.click('Skip').catch(() => {});
    await sleep(3);
  }

  // Step 7: skip recovery email
  pageText = await readPage(s);
  if (pageText.includes('recovery') || pageText.includes('add another')) {
    console.log('[google] step 7: skipping recovery email');
    await s.click('Skip').catch(() => {});
    await clickNext(s);
    await sleep(3);
  }

  // Step 8: review + terms
  for (let i = 0; i < 5; i++) {
    pageText = await readPage(s);
    if (pageText.includes('i agree') || pageText.includes('agree to')) {
      console.log('[google] step 8: accepting terms');
      await s.page.evaluate(`window.scrollTo(0, document.body.scrollHeight)`).catch(() => {});
      await sleep(1);
      await s.click('I agree').catch(() => {});
      await s.click('Accept').catch(() => {});
      await sleep(4);
    }
    if (pageText.includes('confirm') && pageText.includes('account')) {
      await s.click('Confirm').catch(() => {});
      await clickNext(s);
      await sleep(4);
    }
    await clickNext(s);
    await sleep(2);
    const currentUrl = s.page.url?.() ?? '';
    if (currentUrl.includes('myaccount.google.com') || currentUrl.includes('mail.google.com') || currentUrl.includes('youtube.com')) break;
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

for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
  console.log(`\n=== Google signup attempt ${attempt}/${MAX_RETRIES} ===`);
  const s = await WSession.start({ label: `google_register_${attempt}`, proxy });
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
