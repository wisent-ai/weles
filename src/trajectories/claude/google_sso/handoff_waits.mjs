// The waits of the Claude GIS handoff: until a page of the handoff moves on,
// until a pending state's own control enables, and the click on a control the
// page read tagged. Each wait ends on what the pages report, never on a clock.

import { clickGisTarget } from './gis_state/page_reading.mjs';
import { answerClaudeCaptcha } from './captcha_answer.mjs';
import { pageCondition } from '../../_shared/page/settled.mjs';

// Resolves once something that can change the handoff's state happens: the
// acting page navigates, closes, or the context opens another page.
export async function stateChange(page, active, url) {
  if (active.isClosed() || active.url() !== url) return;
  const { promise, resolve, reject } = Promise.withResolvers();
  const context = page.context();
  const onNavigated = (frame) => {
    if (frame === active.mainFrame() && frame.url() !== url) resolve();
  };
  const onCrash = () =>
    reject(new Error(`gis_continue: acting page crashed at ${active.url()}`));
  active.on('framenavigated', onNavigated);
  active.on('close', resolve);
  active.on('crash', onCrash);
  context.on('page', resolve);
  try {
    await promise;
  } finally {
    active.off('framenavigated', onNavigated);
    active.off('close', resolve);
    active.off('crash', onCrash);
    context.off('page', resolve);
  }
}

// Resolves once any page of the handoff moves on: one of the pages this round
// read navigates away from what it showed or closes, the context opens another
// page, or `also` (the page condition the caller waits for) settles. A wait on
// the acting page alone missed a run's popup: claude.ai's gate went disabled
// while Google's popup loaded, and the popup's navigation reached no
// listener. Every listener is removed when the wait ends.
async function anyPageChange(page, views, also) {
  const context = page.context();
  const { promise, resolve, reject } = Promise.withResolvers();
  const detach = [];
  const listen = (target, event, handler) => {
    target.on(event, handler);
    detach.push(() => target.off(event, handler));
  };
  for (const { p, st } of views) {
    if (p.isClosed() || p.url() !== st.url) resolve();
    listen(p, 'framenavigated', (frame) => {
      if (frame === p.mainFrame() && frame.url() !== st.url) resolve();
    });
    listen(p, 'close', resolve);
    listen(p, 'crash', () =>
      reject(new Error(`gis_continue: a handoff page crashed at ${p.url()}`)),
    );
  }
  listen(context, 'page', resolve);
  also.then(resolve, resolve);
  try {
    await promise;
  } finally {
    for (const off of detach) off();
  }
}

/** Click the control the page read tagged as `kind`, refused by name when it could not be clicked. */
export async function clickOfferedControl(active, kind) {
  const hit = await clickGisTarget(active, kind);
  if (!hit.clicked) {
    const current = new URL(active.url());
    const error = new Error(
      `gis_continue: ${kind} was not clicked at ${current.host}${current.pathname}: ${hit.reason}`,
    );
    error.code = 'gis_control_unavailable';
    throw error;
  }
}

/** Whether the element the page read tagged `kind` is present and no longer disabled. */
function taggedControlLive(kind) {
  const el = document.querySelector(`[data-weles-gis-pending="${kind}"]`);
  return Boolean(
    el &&
      !el.disabled &&
      el.getAttribute('aria-disabled') !== 'true' &&
      el.getAttribute('disabled') === null,
  );
}

/** Whether no challenge frame of the kinds the captcha solver answers is shown. */
function challengeGone() {
  return !Array.from(
    document.querySelectorAll(
      'iframe[src*="hcaptcha.com"][src*="frame=challenge"], iframe[src*="recaptcha"][src*="bframe"], iframe[src*="arkoselabs"], iframe[src*="challenges.cloudflare.com"]',
    ),
  ).some((frame) => frame.checkVisibility());
}

/**
 * The pending states of the handoff, each waited out until its own control
 * enables, its page renders, its challenge is answered, or any page of the
 * handoff moves on. The stage is visible in `weles runs show`, and the
 * operator ends a state that never moves with `weles runs cancel`. Answers
 * whether `variant` was one of them.
 */
export async function awaitPendingVariant({
  page,
  views,
  active,
  variant,
  mark,
}) {
  if (variant === 'claude_gis_gate_pending') {
    // claude.ai enables its Google button itself, or moves on.
    mark('gis_gate_pending');
    await anyPageChange(
      page,
      views,
      pageCondition(active, taggedControlLive, 'gis_button'),
    );
    return true;
  }
  if (variant === 'claude_app_loading') {
    mark('claude_app_loading');
    await anyPageChange(
      page,
      views,
      pageCondition(
        active,
        () => document.querySelector('[data-page-loading]') === null,
      ),
    );
    return true;
  }
  if (variant === 'oauth_consent_pending') {
    // The grant screen enables Authorize once its authorize data has loaded.
    mark('oauth_consent_pending');
    await anyPageChange(
      page,
      views,
      pageCondition(active, taggedControlLive, 'consent'),
    );
    return true;
  }
  if (variant === 'claude_captcha') {
    // claude.ai put a captcha challenge between Google's answer and its
    // consent screen. Weles answers it with its own solver; the loop then
    // reads whatever the page shows next. It is not claimed: a challenge
    // shown again at the same address after the answer is a new one.
    mark('claude_captcha_answer');
    await answerClaudeCaptcha(active, views, variant);
    await anyPageChange(page, views, pageCondition(active, challengeGone));
    return true;
  }
  return false;
}
