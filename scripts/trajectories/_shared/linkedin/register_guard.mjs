import { humanClickLocator, humanIdlePause } from '../../../../dist/human/mouse.js';

export const LINKEDIN_SIGNUP_EMAIL_SELECTOR = [
  'form.join-form input[name="email-address"]',
  'form.join-form input#email-address',
  'form.join-form input[type="email"]',
  'input[name="email-address"]',
  'input#email-address',
].join(', ');

export const LINKEDIN_SIGNUP_PASSWORD_SELECTOR = [
  'form.join-form input[name="password"]',
  'form.join-form input#password',
  'form.join-form input[autocomplete="new-password"]',
  'form.join-form input[type="password"]',
  'input[name="password"]:not([name="session_password"])',
  'input#password',
].join(', ');

async function firstVisible(page, selector, timeout = 2500) {
  const loc = page.locator(selector).filter({ visible: true }).first();
  try {
    await loc.waitFor({ state: 'visible', timeout });
    return loc;
  } catch {
    return null;
  }
}

async function summarizeLinkedinPage(page) {
  const url = page.url?.() ?? '';
  return await page.evaluate((u) => {
    const visible = (el) => {
      const r = el.getBoundingClientRect();
      const s = window.getComputedStyle(el);
      return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
    };
    return {
      url: u,
      title: document.title,
      pageKey: document.querySelector('meta[name="pageKey"]')?.content ?? '',
      inputs: Array.from(document.querySelectorAll('input')).map((i) => ({
        name: i.name,
        id: i.id,
        type: i.type,
        autocomplete: i.getAttribute('autocomplete') ?? '',
        visible: visible(i),
      })).slice(0, 20),
      buttons: Array.from(document.querySelectorAll('button,a')).filter(visible).map((b) => ({
        tag: b.tagName.toLowerCase(),
        text: (b.innerText || b.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 60),
        href: b.getAttribute('href') ?? '',
      })).slice(0, 20),
    };
  }, url).catch(() => ({ url, title: '', pageKey: '', inputs: [], buttons: [] }));
}

async function nudgeIntoSignup(page) {
  const joinSelectors = [
    'a[href*="/signup"]:has-text("Join now")',
    'a:has-text("Join now")',
    'button:has-text("Join now")',
    'a[href*="/signup"]',
  ];
  for (const sel of joinSelectors) {
    const loc = await firstVisible(page, sel, 1200);
    if (!loc) continue;
    await humanClickLocator(page, loc).catch(() => {});
    await page.waitForLoadState('domcontentloaded', { timeout: 8000 }).catch(() => {});
    return `clicked:${sel}`;
  }
  const url = page.url?.() ?? '';
  if (!/\/signup/.test(url)) {
    await page.goto('https://www.linkedin.com/signup', { waitUntil: 'domcontentloaded', timeout: 30000 });
    return 'goto:/signup';
  }
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
  return 'reload:/signup';
}

export async function ensureLinkedinSignupForm(session, maxAttempts = 3) {
  const page = session.page;
  const actions = [];
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const emailLoc = await firstVisible(page, LINKEDIN_SIGNUP_EMAIL_SELECTOR, attempt === 0 ? 3500 : 7000);
    const pwdLoc = emailLoc ? await firstVisible(page, LINKEDIN_SIGNUP_PASSWORD_SELECTOR, 1500) : null;
    if (emailLoc && pwdLoc) {
      console.log(`[linkedin_register] signup form ready after ${attempt + 1} attempt(s) actions=${actions.join('|') || 'none'}`);
      return { emailLoc, pwdLoc };
    }
    actions.push(await nudgeIntoSignup(page));
    await humanIdlePause('deliberate').catch(() => {});
  }
  const summary = await summarizeLinkedinPage(page);
  throw new Error(`signup_form_unavailable: ${JSON.stringify(summary).slice(0, 900)}`);
}

export async function assertLinkedinProxyStable(session, stage, expectedExitIp = '') {
  if (!session.proxyConfig?.server) throw new Error('PROXY_REQUIRED: linkedin_register requires proxied dedicated ISP traffic');
  let actual = '';
  let probePage = null;
  try {
    probePage = await session.ctx.newPage();
    await probePage.goto('https://api.ipify.org', { waitUntil: 'domcontentloaded', timeout: 15000 });
    actual = (await probePage.locator('body').innerText({ timeout: 5000 })).trim();
  } catch (e) {
    throw new Error(`PROXY_DRIFT_CHECK_FAILED: stage=${stage} err=${e.message?.slice(0, 120)}`);
  } finally {
    await probePage?.close?.().catch(() => {});
  }
  const expected = expectedExitIp || session.proxyConfig.exit_ip || actual;
  if (expected && actual && expected !== actual) {
    throw new Error(`PROXY_DRIFT: stage=${stage} expected=${expected} actual=${actual}`);
  }
  if (!actual) throw new Error(`PROXY_DRIFT_CHECK_FAILED: stage=${stage} empty_exit_ip`);
  session.proxyConfig.exit_ip = actual;
  return actual;
}

export function assertLinkedinDedicatedIspProxy(session, requestedProxy = '') {
  const raw = String(requestedProxy).toLowerCase();
  const server = String(session.proxyConfig?.server ?? '').toLowerCase();
  const username = String(session.proxyConfig?.username ?? '').toLowerCase();
  if (/\b(residential|mobile|datacenter)\b/.test(raw) && !/\bisp\b/.test(raw)) {
    throw new Error(`PROXY_NOT_DEDICATED_ISP: requested=${raw.slice(0, 80)}`);
  }
  const rotatingGateway = /pr\.oxylabs\.io|geo\.iproyal\.com|brd\.superproxy\.io|packetstream|pingproxies|:7777|:12321|:22225/.test(server);
  const stickyCredential = /sessid-|_session-|[-_]session[-_]|_s_\d+/.test(username);
  if (rotatingGateway || stickyCredential) {
    throw new Error(`PROXY_NOT_DEDICATED_ISP: server=${server} username=${username.slice(0, 40)}`);
  }
}

export function classifyLinkedinRegisterFailure(errorMessage = '', finalUrl = '') {
  if (/^(PROXY_|PROXY_NOT_DEDICATED_ISP)/.test(errorMessage) || finalUrl.startsWith('chrome-error://')) return 'proxy_failed';
  if (errorMessage.startsWith('DETECTION_TRIGGERED')) return 'detection_triggered';
  if (/captcha|challenge|checkpoint/i.test(finalUrl) || /captcha|challenge|checkpoint/i.test(errorMessage)) return 'captcha_challenge';
  if (/signup_form_unavailable/.test(errorMessage)) return 'form_unavailable';
  return 'action_failed';
}
