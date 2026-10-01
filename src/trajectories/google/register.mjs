import { WSession } from '../../../dist/session/wsession.js';
import { approveQr } from './_qr_approve.mjs';
import { humanFill } from '../../../dist/human/keyboard.js';
import { humanClickLocator } from '../../../dist/human/mouse.js';
import { pageSettled } from '../_shared/page/settled.mjs';
import { autocompleteField, clickFirst, control, field } from '../_shared/page/offers.mjs';

const SIGNUP_URL = 'https://accounts.google.com/signup/v2/createaccount?biz=false&cc=US&continue=https%3A%2F%2Fwww.youtube.com%2Fsignin%3Faction_handle_signin%3Dtrue&dsh=S0&flowEntry=SignUp&flowName=GlifWebSignIn&hl=en&service=youtube';

const BASE_PROXY = process.env.PROXY_URL || 'residential';

// Rotate the sticky-session id per attempt; the URL forms of PacketStream,
// IPRoyal, Pingproxies and Oxylabs embed it as session-NNNN / sessid-NNNN / _s_NNNN.
function freshProxy() {
  if (!BASE_PROXY || BASE_PROXY === 'none' || !BASE_PROXY.startsWith('http')) return BASE_PROXY;
  const sid = Math.floor(Math.random() * 9_000_000 + 1_000_000);
  return BASE_PROXY
    .replace(/session-\d+/g, `session-${sid}`)
    .replace(/sessid-\d+/g, `sessid-${sid}`)
    .replace(/_s_\d+/g, `_s_${sid}`);
}

// The flow's primary action: Google renders Next as a button or a
// role="button" with the localized caption; the accessible name is the one
// stable handle. False when the page offers none.
async function clickNext(page) {
  const next = page.getByRole('button', { name: /^(next|weiter|suivant|siguiente)$/i }).first();
  if (!(await next.isVisible())) return false;
  // Direct locator click: the session-idle timer expires during a longer wait.
  await humanClickLocator(page, next);
  return true;
}

function hostOf(page) {
  return new globalThis.URL(page.url()).hostname;
}

// A visible phone input: Google rotates its name and id, but it autocompletes
// as tel; the birthday fields are type=tel too and are excluded by name.
async function phoneInput(page) {
  const tel = await autocompleteField(page, 'tel');
  if (tel) return tel;
  const candidates = page.locator('input[type="tel"]:not([name="day"]):not([name="month"]):not([name="year"]):not(#day):not(#month):not(#year)');
  const first = candidates.first();
  return (await first.isVisible()) ? first : null;
}

async function signup(s) {
  const page = s.page;
  const id = await s.generateIdentity('google');
  const gmailUser = id.username.toLowerCase().replace(/[^a-z0-9]/g, '');
  const firstName = id.firstName;
  const lastName = id.lastName;
  console.log(`[google] identity: ${firstName} ${lastName} / ${gmailUser}@gmail.com`);

  // A tunnel or proxy failure on the first request means this sticky exit is
  // dead; the outer loop rotates to a fresh one on `proxy_dead`.
  const isProxyErr = (m) => /TUNNEL_CONNECTION_FAILED|PROXY_CONNECTION_FAILED|ABORTED|EMPTY_RESPONSE|502|nav_timed_out/.test(m ?? '');
  try {
    const r = await page.goto(SIGNUP_URL, { waitUntil: 'commit' });
    console.log(`[google] signup nav ok: status=${r?.status()} url=${r?.url()?.slice(0, 80)}`);
  } catch (e) {
    console.log(`[google] signup nav err: ${e.message?.slice(0, 200)}`);
    if (isProxyErr(e.message)) throw new Error('proxy_dead');
    throw e;
  }
  await page.locator('input[name="firstName"]').waitFor({ state: 'visible' });
  await pageSettled(page);

  console.log('[google] step 2: name');
  await s.fill('First name', firstName);
  await pageSettled(page);
  await s.fill('Last name', lastName);
  await pageSettled(page);
  await clickNext(page);
  await pageSettled(page);

  // Birthday and gender: Material comboboxes need trusted clicks.
  console.log('[google] step 3: birthday + gender');
  const birthMonth = Number(id.birthMonth) || 6;
  await humanClickLocator(page, page.locator('#month').first());
  await pageSettled(page);
  await page.locator(`li[data-value="${birthMonth}"]`).first().click({ force: true });
  await pageSettled(page);
  const dayLoc = page.locator('input[name="day"], input#day').first();
  if (await dayLoc.count()) await humanFill(page, dayLoc, String(id.birthDay));
  await pageSettled(page);
  const yearLoc = page.locator('input[name="year"], input#year').first();
  if (await yearLoc.count()) await humanFill(page, yearLoc, String(id.birthYear));
  await pageSettled(page);
  await humanClickLocator(page, page.getByRole('combobox', { name: /^gender$/i }));
  await pageSettled(page);
  await humanClickLocator(page, page.getByRole('option', { name: /rather not say/i }));
  await pageSettled(page);

  const urlBefore = page.url();
  await clickNext(page);
  await pageSettled(page);
  if (urlBefore === page.url()) {
    console.log('[google] stuck on birthday/gender page (URL unchanged)');
    throw new Error('birthday_stuck');
  }

  console.log(`[google] step 4: username ${gmailUser}`);
  if (await clickFirst(page, 'button', ['Create your own Gmail address'])) await pageSettled(page);
  await s.fill('Username', gmailUser);
  await pageSettled(page);
  await clickNext(page);
  await pageSettled(page);

  // A username Google refuses is marked invalid on its own input.
  const username = page.locator('input[name="Username"], input[aria-label="Username"]').first();
  if ((await username.isVisible()) && (await username.getAttribute('aria-invalid')) === 'true') {
    const retry = gmailUser + String(Math.floor(Math.random() * 900 + 100));
    console.log(`[google] username refused, retrying ${retry}`);
    await s.fill('Username', retry);
    await pageSettled(page);
    await clickNext(page);
    await pageSettled(page);
  }

  console.log('[google] step 5: password');
  await s.fill('Password', id.password);
  await pageSettled(page);
  await s.fill('Confirm', id.password);
  await pageSettled(page);
  await clickNext(page);
  await pageSettled(page);

  // Step 6: phone verification, or the QR block in front of it.
  console.log(`[google] step 6: url=${page.url().slice(-40)}`);
  let phone = await phoneInput(page);
  if (!phone) {
    // Whatever alternative the page offers that leads to a phone field.
    for (const alt of ['Try another way', "Can't scan", 'Use phone instead', 'Another method', 'Text message', 'Call me', 'Verify by phone']) {
      if (await clickFirst(page, 'button', [alt]) || await clickFirst(page, 'link', [alt])) {
        await pageSettled(page);
        phone = await phoneInput(page);
        if (phone) { console.log(`[google] got phone input via "${alt}"`); break; }
      }
    }
  }
  if (!phone) {
    // No phone route offered: approve the QR with the saved approver session,
    // then walk the intro screens until the phone field appears.
    try {
      await approveQr(page);
      console.log('[google] QR approved — waiting for phone-entry page');
    } catch (e) {
      console.log(`[google] QR approval failed: ${e.message?.slice(0, 200)}`);
      throw new Error('qr_code_blocked');
    }
    for (let i = 0; i < 20 && !phone; i++) {
      phone = await phoneInput(page);
      if (phone) break;
      if (!(await clickNext(page)) && !(await clickFirst(page, 'button', ['Continue', 'Use phone number']))) {
        throw new Error(`google offers no phone field and no control to continue at ${page.url()}`);
      }
      await pageSettled(page);
    }
    if (!phone) throw new Error('qr_code_blocked');
  }

  console.log('[google] phone verification');
  const smsRes = await s.checkSms('google', 'US');
  if (smsRes.startsWith('error')) {
    console.log(`[google] SMS error: ${smsRes}`);
    throw new Error('sms_unavailable');
  }
  const number = smsRes.replace(/^phone:\s*/i, '').trim();
  console.log(`[google] phone: ${number}`);
  await humanFill(page, phone, number);
  await pageSettled(page);
  await clickNext(page);
  await pageSettled(page);

  console.log('[google] waiting for SMS code...');
  const code = await s.pollSmsCode();
  if (!code || code.startsWith('error') || code === 'no code received') throw new Error(`sms code not delivered: ${code}`);
  console.log(`[google] SMS code: ${code}`);
  const codeField = (await field(page, 'code')) ?? (await autocompleteField(page, 'one-time-code')) ?? (await phoneInput(page));
  if (!codeField) throw new Error('google offers no field for the SMS code');
  await humanFill(page, codeField, code);
  await pageSettled(page);
  await clickNext(page);
  await pageSettled(page);

  // Steps 7+: recovery email (skip), terms (agree), confirmation — each
  // offers its control; the flow ends on a Google product.
  for (let i = 0; i < 6; i++) {
    const host = hostOf(page);
    if (host === 'myaccount.google.com' || host === 'mail.google.com' || host.endsWith('youtube.com')) break;
    if (await control(page, 'button', 'I agree') || await control(page, 'button', 'Accept')) {
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await pageSettled(page);
    }
    if (await clickFirst(page, 'button', ['Skip', 'I agree', 'Accept', 'Confirm'])) { await pageSettled(page); continue; }
    if (!(await clickNext(page))) throw new Error(`google offers no control to continue at ${page.url()}`);
    await pageSettled(page);
  }

  // Success is the account session, not what the page says.
  const cookies = await s.ctx.cookies();
  const googleCookies = cookies.filter(c => c.domain?.includes('google.com') && /^(SID|HSID|SSID|SAPISID|APISID|__Secure-\w+)/.test(c.name));
  console.log(`[google] final url: ${page.url()}, auth cookies: ${googleCookies.map(c => c.name).join(',')}`);
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
const proxy = freshProxy();
console.log(`\n=== Google signup proxy=${proxy.slice(-60)} ===`);
const s = await WSession.start({ label: 'google_register', proxy, targetHost: 'accounts.google.com' });
instrumentSession(s);
try {
  const username = await signup(s);
  console.log(`PASS: ${username}`);
} catch (e) {
  console.log(`FAIL: ${e.message?.slice(0, 200)}`);
  process.exitCode = 1;
} finally {
  await s.close();
}
