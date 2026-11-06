// Where OpenAI's half of the handoff ends, and the one page it puts in front of
// that end.
//
// auth.openai.com is an intermediate host, so "done" is a small named set of
// URLs rather than "left Google". The Codex consent page is the one screen the
// CLI cannot get past on its own, and a workspace that has device-code
// authorization switched off says so by rendering its Continue button disabled —
// a settings problem with its own error code, not something to wait out.
import { navEval } from '../../_shared/page/navigation/read.mjs';
import { humanClickLocator } from '../../../../dist/human/mouse.js';

/** The consent page's own submit control. */
const CONSENT_SUBMIT = 'form button[type="submit"], form input[type="submit"]';

/** The Codex consent page, by origin and path. */
const CONSENT_PAGE =
  'https://auth.openai.com/sign-in-with-chatgpt/codex/consent';

// The URLs that end OpenAI's half, as host name and path prefix: any path on
// the hosts Codex CLI receives its token from (platform.openai.com,
// chatgpt.com); on auth.openai.com only the device flow's callback and
// success pages; and on localhost the callback of the local server
// `codex login` (no --device-auth) starts. Any other URL does not end it.
const TERMINAL_URLS = [
  { hostname: 'platform.openai.com', path: '/' },
  { hostname: 'chatgpt.com', path: '/' },
  { hostname: 'auth.openai.com', path: '/codex/device/callback' },
  { hostname: 'auth.openai.com', path: '/codex/device/success' },
  { hostname: 'auth.openai.com', path: '/deviceauth/callback' },
  { hostname: 'localhost', path: '/auth/callback' },
  { hostname: 'localhost', path: '/success' },
];

/** Whether the URL is one where OpenAI's half of the handoff has ended. */
export function isTerminalUrl(href) {
  if (!URL.canParse(href)) return false;
  const url = new URL(href);
  const hostname = url.hostname.toLowerCase();
  const pathname = url.pathname.toLowerCase();
  return TERMINAL_URLS.some(
    (terminal) =>
      terminal.hostname === hostname && pathname.startsWith(terminal.path),
  );
}

export async function handleCodexConsentPage(page, mark) {
  const url = new URL(page.url());
  if (`${url.origin}${url.pathname}` !== CONSENT_PAGE) return false;
  mark('codex_consent_page');
  // A read whose document was replaced mid-evaluation answers "no control
  // yet" (navigation/read.mjs); the caller looks again on the next page.
  const state = await navEval(
    page,
    (selector) => {
      const control = document.querySelector(selector);
      if (!control) return { found: false };
      return {
        found: true,
        disabled: control.matches(':disabled, [aria-disabled="true"]'),
      };
    },
    { found: false },
    CONSENT_SUBMIT,
  );
  if (!state.found) return false;
  if (state.disabled) {
    const e = new Error(
      'CODEX_DEVICE_AUTH_DISABLED: ChatGPT Security Settings require enabling "Device code authorization for Codex" before Codex CLI can sign in',
    );
    e.code = 'CODEX_DEVICE_AUTH_DISABLED';
    throw e;
  }
  await humanClickLocator(page, page.locator(CONSENT_SUBMIT).first());
  mark('codex_consent_clicked');
  // The non-device flow redirects to a local server; the device flow
  // redirects back to auth.openai.com. Wait for either terminal URL, for as
  // long as Playwright's own navigation default allows.
  if (isTerminalUrl(page.url())) return true;
  try {
    await page.waitForURL((next) => isTerminalUrl(next.href));
    return true;
  } catch (e) {
    throw new Error(
      `post-consent: no terminal redirect (final=${page.url()})`,
      { cause: e },
    );
  }
}
