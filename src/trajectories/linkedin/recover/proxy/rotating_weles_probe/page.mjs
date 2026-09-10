// What the signup page and LinkedIn's API answers say about the exit the probe came from.
import { getLinkedinChallengeSignal } from '../../../../_shared/linkedin/signup/register_guard.mjs';

export async function summarizeSignup(page) {
  return await page.evaluate(() => {
    const visible = (el) => {
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden';
    };
    return {
      url: location.href,
      title: document.title,
      pageKey: document.querySelector('meta[name="pageKey"]')?.getAttribute('content') || '',
      bodyText: (document.body?.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 800),
      inputs: Array.from(document.querySelectorAll('input')).map((i) => ({
        name: i.name,
        id: i.id,
        type: i.type,
        autocomplete: i.getAttribute('autocomplete') || '',
        visible: visible(i),
      })).slice(0, 30),
      buttons: Array.from(document.querySelectorAll('button,a')).filter(visible).map((el) => ({
        tag: el.tagName.toLowerCase(),
        text: (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 120),
        href: el instanceof HTMLAnchorElement ? el.href : '',
      })).slice(0, 30),
      iframes: Array.from(document.querySelectorAll('iframe')).map((f) => ({
        id: f.id,
        name: f.name,
        title: f.title,
        src: f.src,
        visible: visible(f),
        width: Math.round(f.getBoundingClientRect().width),
        height: Math.round(f.getBoundingClientRect().height),
      })).slice(0, 30),
    };
  });
}

export function classifySummary(summary) {
  const signal = getLinkedinChallengeSignal(summary);
  const visibleInputs = new Set((summary.inputs || []).filter((i) => i.visible).flatMap((i) => [i.name, i.id, i.type]));
  const buttonText = (summary.buttons || []).map((b) => b.text).join(' ');
  const hasSignupFields =
    (visibleInputs.has('email-address') || visibleInputs.has('email')) &&
    visibleInputs.has('password') &&
    /Agree & Join|Continue/i.test(buttonText);
  if (signal) return { result: 'challenge', signal };
  if (hasSignupFields) return { result: 'form', signal: '' };
  return { result: 'unknown', signal: '' };
}

export function redactText(text = '') {
  return String(text)
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '<redacted-email>')
    .replace(/("(?:password|email|emailAddress|firstName|lastName|first-name|last-name|csrfToken|loginCsrfParam)"\s*:\s*)"[^"]*"/gi, '$1"<redacted>"')
    .slice(0, 3000);
}

export async function summarizeApiResponse(res) {
  if (!res) return null;
  let bodyText = '';
  let bodyJson = null;
  try {
    bodyText = await res.text();
    bodyJson = JSON.parse(bodyText);
  } catch {}
  return {
    status: res.status(),
    url: res.url(),
    body_keys: bodyJson && typeof bodyJson === 'object' ? Object.keys(bodyJson).slice(0, 40) : null,
    has_challenge_url: Boolean(bodyJson?.challengeUrl),
    challenge_url_prefix: bodyJson?.challengeUrl ? String(bodyJson.challengeUrl).slice(0, 180) : '',
    body_redacted: redactText(bodyText),
  };
}

export async function linkedinAuthState(session) {
  const cookies = await session.ctx.cookies().catch(() => []);
  const linkedinCookies = cookies.filter((c) => /linkedin\.com$/.test(c.domain ?? ''));
  return {
    final_url: session.page.url(),
    linkedin_cookie_count: linkedinCookies.length,
    has_li_at: linkedinCookies.some((c) => c.name === 'li_at' && c.value),
  };
}
