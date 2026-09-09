// Reading one live page of the GIS handoff, and clicking the one thing that read
// tagged.
//
// The read is a single evaluate so the facts cannot disagree with each other,
// and the click re-finds the tagged element after scrolling it into view rather
// than trusting a coordinate from an earlier poll.
import { humanClick } from '../../../../../dist/human/mouse.js';
import { navEval } from '../page_controls.mjs';

// Diagnostic slice sizes for the state read below, and the smallest box that
// counts as a rendered control. A 1x1 tracking pixel with role="button" is not
// an affordance; 4px is the same floor waitForEnabledThenClick uses.
const GIS_MIN_BOX_PX = 4;
const GIS_DIAG_URL_CHARS = 300;
const GIS_DIAG_TITLE_CHARS = 120;
const GIS_DIAG_BODY_CHARS = 240;

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
  const live = (el) => !(el.disabled
    || el.getAttribute('aria-disabled') === 'true'
    || el.getAttribute('disabled') !== null);
  const label = (el) => (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
  // Tag the element the state machine will act on, so the click re-finds exactly
  // this element (after scrolling it into view) instead of trusting a coordinate
  // read one poll earlier. Tags from the previous poll are cleared first.
  for (const stale of Array.from(document.querySelectorAll('[data-weles-gis]'))) stale.removeAttribute('data-weles-gis');
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

  // A selectable account row is an element carrying data-identifier="<email>"
  // (proven by the recorded chooser document). Elements that merely mention the
  // address are NOT rows: on Google's "you will sign in to Claude again" screen
  // the only such element is the switcher
  // <div role="link" jsname="af8ijd" aria-label="Wybrane konto: <email>. Przełącz konto">,
  // and treating it as a row made the step click "switch account" once per
  // debounce window for the whole deadline (run cbf8fb03, 2026-08-17T20:48Z).
  // The selector guarantees the attribute is there, so it is read as itself.
  const rows = Array.from(document.querySelectorAll('[data-identifier]')).filter((el) => shown(el));
  const wanted = (arg.email || '').trim().toLowerCase();
  const mine = wanted
    ? rows.find((el) => el.getAttribute('data-identifier').trim().toLowerCase() === wanted)
    : null;
  // With no identifier to match and a single row offered, that row is the only
  // thing it could be. Several rows and no match is never a guess.
  const soleRow = !mine && rows.length === 1 ? rows[0] : null;
  const others = rows.filter((el) => el !== mine);

  // Google's affirmative control. Wording first, because that is the only thing
  // that separates it from "Anuluj"/"Cancel" beside it (both are
  // button[jsname="LgbsSe"] with identical classes on the confirm screen), and a
  // negative label is never clicked. #submit_approve_access is Google's own id on
  // the older scope screen and wins when present.
  const affirmative = /^(continue|next|allow|confirm|agree|i agree|kontynuuj|dalej|zezwól|potwierdź|zgadzam się)$/i;
  const negative = /^(cancel|back|not now|no thanks|deny|anuluj|wstecz|nie teraz|odmów)$/i;
  const affirmativeButton = () => {
    const structural = pick('#submit_approve_access button, #submit_approve_access, [data-primary-action-label] button', 'primary');
    if (structural) return structural;
    const buttons = Array.from(document.querySelectorAll('button, [role="button"]'))
      .filter((el) => shown(el) && live(el) && !negative.test(label(el)));
    const named = buttons.find((el) => affirmative.test(label(el)));
    return named ? point(named, 'primary') : null;
  };

  const state = {
    ok: true,
    url: location.href.slice(0, arg.maxUrl),
    host: location.host,
    pathname: location.pathname,
    title: (document.title || '').slice(0, arg.maxTitle),
    rowCount: rows.length,
    rowIdentifiers: rows.map((el) => el.getAttribute('data-identifier').slice(0, arg.maxTitle)),
    accountRow: mine ? point(mine, 'account_row') : (soleRow ? point(soleRow, 'account_row') : null),
    accountRowMatchedBy: mine ? 'data_identifier' : (soleRow ? 'sole_row' : null),
    otherAccountRow: others.length ? point(others[0], 'other_account') : null,
    // claude.ai's own grant affordance, in either language this fleet sees.
    consent: pick('button,[role="button"]', 'consent', /^(authorize|allow|zezwól|zezwol|autoryzuj)$/i),
    gisButton: pick('button,[role="button"]', 'gis_button', /continue with google|^google$/i),
    identifierField: Boolean(document.querySelector('input[type="text"][autocomplete*="username"], input#identifierId, input[name="identifier"], input[type="email"]')),
    passwordField: Boolean(document.querySelector('input[type="password"]')),
    bodyText: (document.body?.innerText || '').replace(/\s+/g, ' ').slice(0, arg.maxBody),
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
  const spot = await navEval(page, (k) => {
    const el = document.querySelector(`[data-weles-gis="${k}"]`);
    if (!el) return null;
    el.scrollIntoView({ block: 'center', inline: 'center' });
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return null;
    const x = r.x + r.width / 2;
    const y = r.y + r.height / 2;
    const hit = document.elementFromPoint(x, y);
    const reachable = Boolean(hit) && (hit === el || el.contains(hit) || hit.contains(el));
    return { x, y, reachable, hit: hit ? `${hit.tagName}.${(hit.className || '').toString().slice(0, 40)}` : null };
  }, null, kind);
  if (!spot) return { clicked: false, reason: `no element tagged ${kind}` };
  if (!spot.reachable) return { clicked: false, reason: `${kind} covered by ${spot.hit}` };
  await humanClick(page, Math.round(spot.x), Math.round(spot.y));
  return { clicked: true, reason: null };
}

// Read one live page through that probe. A navigation mid-read means "not ready,
// look again", which navEval already turns into the null default.
export async function observeGisPage(p, email) {
  return navEval(p, readGisState, null, {
    email,
    minBox: GIS_MIN_BOX_PX,
    maxUrl: GIS_DIAG_URL_CHARS,
    maxTitle: GIS_DIAG_TITLE_CHARS,
    maxBody: GIS_DIAG_BODY_CHARS,
  });
}
