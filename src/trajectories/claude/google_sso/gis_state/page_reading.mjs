// Reading one live page of the GIS handoff, and clicking the one thing that read
// tagged.
//
// The read is a single evaluate so the facts cannot disagree with each other,
// and the click re-finds the tagged element after scrolling it into view rather
// than trusting a coordinate from an earlier poll.
import { humanClick } from '../../../../../dist/human/mouse.js';
import { navEval } from '../page_controls.mjs';

// The smallest box that counts as a rendered control. A 1x1 tracking pixel
// with role="button" is not an affordance; 4px is the same floor
// waitForEnabledThenClick uses. Titles, identifiers and the body are read whole.
const GIS_MIN_BOX_PX = 4;

// One read of one page: everything the state machine decides on, collected in a
// single evaluate so the facts cannot disagree with each other. Element centres
// come back as points because every click goes through humanClick.
//
// Exported as a standalone function of its argument (no closure over module
// state) so a recorded DOM snapshot can be replayed through the exact code the
// live run uses — this surface is diagnosed from recorded DOM, so the reading of
// that DOM must not be a second implementation.
export const readGisState = (arg) => {
  const rect = (el) => el.getBoundingClientRect();
  const shown = (el) => {
    const r = rect(el);
    return r.width >= arg.minBox && r.height >= arg.minBox;
  };
  const live = (el) =>
    !(
      el.disabled ||
      el.getAttribute('aria-disabled') === 'true' ||
      el.getAttribute('disabled') !== null
    );
  const label = (el) =>
    (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
  // Tag the element the state machine will act on, so the click re-finds exactly
  // this element (after scrolling it into view) instead of trusting a coordinate
  // read one poll earlier. Tags from the previous poll are cleared first.
  for (const stale of Array.from(document.querySelectorAll('[data-weles-gis]')))
    stale.removeAttribute('data-weles-gis');
  const point = (el, kind) => {
    el.setAttribute('data-weles-gis', kind);
    const r = rect(el);
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  };
  const pick = (selector, kind, re) => {
    for (const el of Array.from(document.querySelectorAll(selector))) {
      if (!shown(el) || !live(el)) continue;
      if (re && !re.test(label(el))) continue;
      return point(el, kind);
    }
    return null;
  };

  // Selectable account rows carry data-identifier. Text mentioning the address
  // can instead be an account-switch action and must not count as a row.
  const rows = Array.from(
    document.querySelectorAll('[data-identifier]'),
  ).filter((el) => el.getAttribute('data-identifier').trim() && shown(el));
  const wanted = (arg.email || '').trim().toLowerCase();
  const mine = wanted
    ? rows.find(
        (el) =>
          el.getAttribute('data-identifier').trim().toLowerCase() === wanted,
      )
    : null;
  // A different account is not a substitute, even when it is the only row.
  // "Use another account" is a separate control, never another identity's row.

  // Google's affirmative control. Wording first, because that is the only thing
  // that separates it from "Anuluj"/"Cancel" beside it (both are
  // button[jsname="LgbsSe"] with identical classes on the confirm screen), and a
  // negative label is never clicked. #submit_approve_access is Google's own id on
  // the older scope screen and wins when present.
  const affirmative =
    /^(continue|next|allow|confirm|agree|i agree|kontynuuj|dalej|zezwól|potwierdź|zgadzam się)$/i;
  const negative =
    /^(cancel|back|not now|no thanks|deny|anuluj|wstecz|nie teraz|odmów)$/i;
  const affirmativeButton = () => {
    const structural = pick(
      '#submit_approve_access button, #submit_approve_access, [data-primary-action-label] button',
      'primary',
    );
    if (structural) return structural;
    const buttons = Array.from(
      document.querySelectorAll('button, [role="button"]'),
    ).filter((el) => shown(el) && live(el) && !negative.test(label(el)));
    const named = buttons.find((el) => affirmative.test(label(el)));
    return named ? point(named, 'primary') : null;
  };

  const state = {
    ok: true,
    url: location.href,
    host: location.host,
    pathname: location.pathname,
    title: document.title,
    rowCount: rows.length,
    rowIdentifiers: rows.map((el) => el.getAttribute('data-identifier')),
    accountRow: mine ? point(mine, 'account_row') : null,
    accountRowMatchedBy: mine ? 'data_identifier' : null,
    otherAccountRow: pick(
      'button,[role="button"],[role="link"],li,a',
      'other_account',
      /^(use another account|add account|dodaj konto|inne konto|użyj innego konta)$/i,
    ),
    // claude.ai's own grant affordance, in either language this fleet sees.
    consent: pick(
      'button,[role="button"]',
      'consent',
      /^(authorize|allow|zezwól|zezwol|autoryzuj)$/i,
    ),
    // The grant screen renders Authorize and Decline disabled while it loads
    // its authorize data: run 23bf6ab4 read the screen 70 ms after
    // /v1/oauth/<org>/authorize was requested, both buttons disabled="".
    consentPending: Array.from(
      document.querySelectorAll('button,[role="button"]'),
    ).some(
      (el) =>
        shown(el) &&
        !live(el) &&
        /^(authorize|allow|zezwól|zezwol|autoryzuj)$/i.test(label(el)),
    ),
    gisButton: pick(
      'button,[role="button"]',
      'gis_button',
      /continue with google|^google$/i,
    ),
    // claude.ai renders its "Continue with Google" button disabled until its
    // Google library is ready: run c5f8838e failed on that page as 'unknown'
    // two seconds after the authorize URL loaded.
    gisButtonPending: Array.from(
      document.querySelectorAll('button,[role="button"]'),
    ).some(
      (el) =>
        shown(el) &&
        !live(el) &&
        /continue with google|^google$/i.test(label(el)),
    ),
    // claude.ai serves its authorize page as an app shell that renders later:
    // run 5661801e recorded claude.ai/oauth/authorize titled "Claude" with an
    // empty #root under [data-page-loading] and no control at all, and run
    // c891c574 the same page with #root rendered around a [role=status]
    // [data-page-loading] spinner. Either is the app still loading: a state
    // of its own, waited out, not a failure. A rendered control outranks it,
    // because the consent, gate and app checks are classified first.
    appLoading: document.querySelector('[data-page-loading]') !== null,
    // claude.ai answers some sign-ins with an hCaptcha challenge right after
    // Google's popup closes (run 23bf6ab4: "Drag the letter to the place where
    // it fits", an hcaptcha.com frame=challenge iframe over the login page).
    captchaChallenge: Array.from(
      document.querySelectorAll(
        'iframe[src*="hcaptcha.com"][src*="frame=challenge"], iframe[src*="recaptcha"][src*="bframe"], iframe[src*="arkoselabs"], iframe[src*="challenges.cloudflare.com"]',
      ),
    ).some(shown),
    identifierField: Array.from(
      document.querySelectorAll(
        'input[type="text"][autocomplete*="username"], input#identifierId, input[name="identifier"], input[type="email"]',
      ),
    ).some(shown),
    passwordField: Array.from(
      document.querySelectorAll('input[type="password"]'),
    ).some(shown),
    bodyText: document.body ? document.body.innerText.replace(/\s+/g, ' ') : '',
  };
  // Only look for the affirmative button once no row is waiting to be picked:
  // picking the account always precedes confirming it.
  state.googlePrimary = state.accountRow ? null : affirmativeButton();
  return state;
};

// Click the element the last probe tagged: scroll it into the middle of the
// viewport, re-read its box there, refuse when something else owns that point,
// and only then move the pointer onto it. The coordinate a probe read before a
// scroll or a re-render is not where the affordance is now.
export async function clickGisTarget(page, kind) {
  const spot = await navEval(
    page,
    (k) => {
      const el = document.querySelector(`[data-weles-gis="${k}"]`);
      if (!el) return null;
      el.scrollIntoView({ block: 'center', inline: 'center' });
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) return null;
      const x = r.x + r.width / 2;
      const y = r.y + r.height / 2;
      const hit = document.elementFromPoint(x, y);
      const reachable =
        Boolean(hit) && (hit === el || el.contains(hit) || hit.contains(el));
      return {
        x,
        y,
        reachable,
        hit: hit ? [hit.tagName, ...hit.classList].join('.') : null,
      };
    },
    null,
    kind,
  );
  if (!spot) return { clicked: false, reason: `no element tagged ${kind}` };
  if (!spot.reachable)
    return { clicked: false, reason: `${kind} covered by ${spot.hit}` };
  await humanClick(page, Math.round(spot.x), Math.round(spot.y));
  return { clicked: true, reason: null };
}

// Read one live page through that probe. A navigation mid-read means "not ready,
// look again", which navEval already turns into the null default.
export async function observeGisPage(p, email) {
  return navEval(p, readGisState, null, {
    email,
    minBox: GIS_MIN_BOX_PX,
  });
}
