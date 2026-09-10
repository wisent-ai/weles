// What the LinkedIn signup page shows: its form selectors, a summary of the page, the
// challenge it presents, and whether the session is authenticated.

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

export async function firstVisible(page, selector, timeout = 2500) {
  const loc = page.locator(selector).filter({ visible: true }).first();
  try {
    await loc.waitFor({ state: 'visible', timeout });
    return loc;
  } catch {
    return null;
  }
}

export async function summarizeLinkedinPage(page) {
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
  if (/\/checkpoint\/challenge|challengeiframe|arkose/i.test(haystack) && !hasVisibleSignupForm) return 'challenge_page';
  if (/recaptcha|captcha|security verification/i.test(visibleIframeText) && !hasVisibleSignupForm) return 'challenge_page';
  if (/recaptcha|captcha|security verification|verify you are human|unusual activity/i.test(pageText) && !hasVisibleSignupForm) return 'challenge_page';
  if (/\/checkpoint|checkpoint/.test(pageText) && !/email[-_\s]?verification|confirmation code|one-time-code|\bpin\b/.test(pageText)) return 'checkpoint_page';
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

