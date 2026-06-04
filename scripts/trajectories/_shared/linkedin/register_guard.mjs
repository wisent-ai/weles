import { humanClickLocator, humanIdlePause } from '../../../../dist/human/mouse.js';
import { isIP } from 'node:net';

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
      iframes: Array.from(document.querySelectorAll('iframe')).map((f) => ({
        id: f.id,
        name: f.name,
        title: f.title,
        src: f.src,
        visible: visible(f),
      })).slice(0, 20),
      bodyText: (document.body?.innerText ?? '').trim().replace(/\s+/g, ' ').slice(0, 240),
    };
  }, url).catch(() => ({ url, title: '', pageKey: '', inputs: [], buttons: [] }));
}

export function getLinkedinChallengeSignal(summary = {}) {
  const isDormantInvisibleRecaptcha = (f = {}) => {
    try {
      const u = new URL(f.src ?? '');
      return /(^|\.)google\.com$/.test(u.hostname) &&
        /\/recaptcha\/enterprise\/anchor/.test(u.pathname) &&
        u.searchParams.get('size') === 'invisible';
    } catch {
      return false;
    }
  };
  const inputText = (summary.inputs ?? []).flatMap((i) => [i.name, i.id, i.type, i.autocomplete]).join(' ');
  const buttonText = (summary.buttons ?? []).flatMap((b) => [b.text, b.href]).join(' ');
  const visibleInputNames = new Set((summary.inputs ?? []).filter((i) => i.visible).flatMap((i) => [i.name, i.id]));
  const hasVisibleSignupForm =
    (visibleInputNames.has('email-address') || /email-address|\bemail\b/i.test(inputText)) &&
    (visibleInputNames.has('password') || /password/i.test(inputText)) &&
    /Agree & Join|Continue/i.test(buttonText);
  const visibleIframeText = (summary.iframes ?? [])
    .filter((f) => f.visible && !isDormantInvisibleRecaptcha(f))
    .flatMap((f) => [f.id, f.name, f.title, f.src]).join(' ');
  const allIframeText = (summary.iframes ?? [])
    .filter((f) => !isDormantInvisibleRecaptcha(f))
    .flatMap((f) => [f.id, f.name, f.title, f.src]).join(' ');
  const pageText = [
    summary.url,
    summary.title,
    summary.pageKey,
    summary.bodyText,
  ].join(' ').toLowerCase();
  const haystack = [
    pageText,
    inputText,
    buttonText,
    allIframeText,
  ].join(' ').toLowerCase();
  // The normal LinkedIn signup page embeds invisible reCAPTCHA Enterprise and
  // ProTechTS/security-verification iframes while the form remains usable.
  // Treat those as risk instrumentation, not a blocking challenge.
  if (/\/checkpoint|checkpoint/.test(pageText) && !/email[-_\s]?verification|confirmation code|one-time-code|\bpin\b/.test(pageText)) return 'checkpoint_page';
  if (/\/checkpoint\/challenge|challengeiframe|arkose/i.test(haystack) && !hasVisibleSignupForm) return 'challenge_page';
  if (/recaptcha|captcha|security verification/i.test(visibleIframeText) && !hasVisibleSignupForm) return 'challenge_page';
  if (/recaptcha|captcha|security verification|verify you are human|unusual activity/i.test(pageText) && !hasVisibleSignupForm) return 'challenge_page';
  return '';
}

export async function assertNoLinkedinChallengePage(session, stage = '') {
  const summary = await summarizeLinkedinPage(session.page);
  const signal = getLinkedinChallengeSignal(summary);
  if (signal) {
    throw new Error(`DETECTION_TRIGGERED: ${signal} stage=${stage} summary=${JSON.stringify(summary).slice(0, 700)}`);
  }
  return summary;
}

export async function getLinkedinAuthState(session) {
  const finalUrl = session.page.url?.() ?? '';
  const cookies = await session.ctx.cookies().catch(() => []);
  const linkedinCookies = cookies.filter((c) => /linkedin\.com$/.test(c.domain ?? ''));
  const liAt = linkedinCookies.find((c) => c.name === 'li_at' && c.value);
  return {
    final_url: finalUrl,
    linkedin_cookie_count: linkedinCookies.length,
    has_li_at: Boolean(liAt),
    li_at_domain: liAt?.domain ?? '',
    li_at_expires: liAt?.expires ?? null,
  };
}

export function summarizeLinkedinProxyState(session, requestedProxy = '', expectedExitIp = '') {
  const cfg = session.proxyConfig ?? {};
  let serverHost = '';
  let serverPort = '';
  let serverScheme = '';
  try {
    const u = new URL(cfg.server ?? '');
    serverHost = u.hostname;
    serverPort = u.port;
    serverScheme = u.protocol.replace(/:$/, '');
  } catch {}
  return {
    requested: String(requestedProxy).startsWith('http') ? '[url-form]' : String(requestedProxy).slice(0, 80),
    server_host: serverHost,
    server_port: serverPort,
    server_scheme: serverScheme,
    provider: cfg.provider ?? '',
    proxy_type: cfg.proxy_type ?? '',
    platform: cfg.platform ?? '',
    country: cfg.country ?? '',
    expected_exit_ip: expectedExitIp || '',
    actual_exit_ip: cfg.exit_ip ?? '',
  };
}

export async function getLinkedinFailureDiagnostics(session, requestedProxy = '', expectedExitIp = '') {
  const page = await summarizeLinkedinPage(session.page).catch((e) => ({ error: e.message?.slice(0, 160) }));
  return {
    auth: await getLinkedinAuthState(session).catch((e) => ({ error: e.message?.slice(0, 160) })),
    proxy: summarizeLinkedinProxyState(session, requestedProxy, expectedExitIp),
    challenge_signal: page?.error ? '' : getLinkedinChallengeSignal(page),
    page,
  };
}

export async function assertLinkedinAuthenticatedRegistration(session, stage = '') {
  const state = await getLinkedinAuthState(session);
  const challengeSignal = getLinkedinChallengeSignal({ url: state.final_url });
  if (challengeSignal) {
    throw new Error(`DETECTION_TRIGGERED: ${challengeSignal} stage=${stage} final_url=${state.final_url.slice(0, 160)}`);
  }
  if (/^https?:\/\/www\.linkedin\.com\/signup\/?$/.test(state.final_url) || state.final_url.includes('/signup/api/')) {
    throw new Error(`signup_did_not_complete: stage=${stage} final_url=${state.final_url}`);
  }
  if (/verify|email-verification|email_verification|checkpoint/.test(state.final_url)) {
    throw new Error(`signup_verification_incomplete: stage=${stage} final_url=${state.final_url}`);
  }
  if (!state.has_li_at) {
    throw new Error(`signup_did_not_authenticate: stage=${stage} final_url=${state.final_url} linkedin_cookie_count=${state.linkedin_cookie_count}`);
  }
  return state;
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
  try {
    const res = await session.ctx.request.get('https://api.ipify.org', { timeout: 15000 });
    actual = (await res.text()).trim();
  } catch (e) {
    throw new Error(`PROXY_DRIFT_CHECK_FAILED: stage=${stage} err=${e.message?.slice(0, 120)}`);
  }
  if (!actual) throw new Error(`PROXY_DRIFT_CHECK_FAILED: stage=${stage} empty_exit_ip`);
  if (!isIP(actual)) {
    throw new Error(`PROXY_DRIFT_CHECK_FAILED: stage=${stage} invalid_exit_ip=${actual.slice(0, 80)}`);
  }
  const expected = expectedExitIp || session.proxyConfig.exit_ip || actual;
  if (expected && actual && expected !== actual) {
    throw new Error(`PROXY_DRIFT: stage=${stage} expected=${expected} actual=${actual}`);
  }
  session.proxyConfig.exit_ip = actual;
  return actual;
}

export function assertLinkedinRegisterProxyRequest(requestedProxy = '') {
  const raw = String(requestedProxy ?? '').trim().toLowerCase();
  if (!raw || raw === 'none' || raw === 'direct') {
    throw new Error(`PROXY_NOT_DEDICATED_ISP: requested=${raw || 'empty'}`);
  }
  if (/^(https?:|socks)/.test(raw)) {
    throw new Error('PROXY_NOT_DEDICATED_ISP: url_form_proxy_request');
  }
  if (/\boxylabs\b/.test(raw) || /(?:^|[.:/])7777(?:\b|\/|$)/.test(raw) || /(?:^|\.)?(?:pr|isp|disp)\.oxylabs\.io\b/.test(raw)) {
    throw new Error(`PROXY_NOT_DEDICATED_ISP: retired_linkedin_proxy requested=${raw.slice(0, 80)}`);
  }
  if (/\b(residential|mobile|datacenter)\b/.test(raw) && !/\bisp\b/.test(raw)) {
    throw new Error(`PROXY_NOT_DEDICATED_ISP: requested=${raw.slice(0, 80)}`);
  }
  if (!/\bisp\b/.test(raw)) {
    throw new Error(`PROXY_NOT_DEDICATED_ISP: missing_isp_request requested=${raw.slice(0, 80)}`);
  }
}

export function assertLinkedinDedicatedIspProxy(session, requestedProxy = '') {
  const raw = String(requestedProxy).toLowerCase();
  const server = String(session.proxyConfig?.server ?? '').toLowerCase();
  const username = String(session.proxyConfig?.username ?? '').toLowerCase();
  const provider = String(session.proxyConfig?.provider ?? '').toLowerCase();
  const proxyType = String(session.proxyConfig?.proxy_type ?? '').toLowerCase();
  const isUrlForm = /^(https?:|socks)/.test(raw);
  if (/\b(residential|mobile|datacenter)\b/.test(raw) && !/\bisp\b/.test(raw)) {
    throw new Error(`PROXY_NOT_DEDICATED_ISP: requested=${raw.slice(0, 80)}`);
  }
  const retiredLinkedinProxy =
    /\boxylabs\b/.test(raw) ||
    provider === 'oxylabs' ||
    /(^|\/\/|\.)(?:pr|isp|disp)\.oxylabs\.io(?::|\/|$)/.test(server) ||
    /(?:^|\/\/)(?:195\.86\.|152\.233\.|209\.38\.)/.test(server) ||
    /:7777(?:\/|$)/.test(server);
  if (retiredLinkedinProxy) {
    throw new Error(`PROXY_NOT_DEDICATED_ISP: retired_linkedin_proxy requested=${raw.slice(0, 80)} server=${server.slice(0, 80)} provider=${provider}`);
  }
  if (isUrlForm && !proxyType) {
    throw new Error('PROXY_NOT_DEDICATED_ISP: unclassified_url_proxy');
  }
  if (!proxyType) {
    throw new Error('PROXY_NOT_DEDICATED_ISP: missing_proxy_type');
  }
  if (proxyType && proxyType !== 'isp') {
    throw new Error(`PROXY_NOT_DEDICATED_ISP: proxy_type=${proxyType}`);
  }
  const rotatingGateway = /pr\.oxylabs\.io|geo\.iproyal\.com|brd\.superproxy\.io|packetstream|pingproxies|:7777|:12321|:22225/.test(server);
  const stickyCredential = /sessid-|_session-|[-_]session[-_]|_s_\d+/.test(username);
  if (rotatingGateway || stickyCredential) {
    throw new Error(`PROXY_NOT_DEDICATED_ISP: server=${server} username=${username.slice(0, 40)}`);
  }
}

export function classifyLinkedinRegisterFailure(errorMessage = '', finalUrl = '') {
  if (/^(PROXY_|PROXY_NOT_DEDICATED_ISP)/.test(errorMessage) || finalUrl.startsWith('chrome-error://')) return 'proxy_failed';
  if (errorMessage.startsWith('ACCOUNT_PERSIST_FAILED')) return 'account_persist_failed';
  if (errorMessage.startsWith('PHONE_VERIFICATION_REQUIRED')) return 'phone_verification_required';
  if (errorMessage.startsWith('DETECTION_TRIGGERED')) return 'detection_triggered';
  if (/signup_(did_not_complete|verification_incomplete|did_not_authenticate)/.test(errorMessage)) return 'registration_not_accepted';
  if (/captcha|challenge|checkpoint/i.test(finalUrl) || /captcha|challenge|checkpoint/i.test(errorMessage)) return 'captcha_challenge';
  if (/signup_form_unavailable/.test(errorMessage)) return 'form_unavailable';
  return 'action_failed';
}

export function linkedinRegisterExitCode(signal = '') {
  if (signal === 'detection_triggered' || signal === 'captcha_challenge') return 2;
  if (signal === 'proxy_failed') return 3;
  if (signal === 'phone_verification_required') return 4;
  if (signal === 'registration_not_accepted') return 4;
  if (signal === 'account_persist_failed') return 5;
  return 1;
}
