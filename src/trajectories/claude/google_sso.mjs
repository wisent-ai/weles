// Google-SSO sub-flow for the claude login trajectory.
//
// ROOT CAUSE (live SSH evidence): claude.ai's "Continue with Google" is a
// Google Identity Services (GIS) button, not a classic OAuth redirect.
// Clicking it with no Google session logs "Provider's accounts list is
// empty." and does nothing (no popup, no nav). So we must establish a
// Google session at accounts.google.com FIRST, then load claude.ai's
// authorize URL — GIS then has an account and the click completes.
//
// This file holds that handoff and the bounds that govern it. Reading a page and
// clicking what that read tagged, naming the state a page is in, entering the
// Google credentials, computing the 2FA code, and writing the DOM of a failed
// run are modules beside it.
import { enterGoogleCredentials } from './google_sso/google_credentials.mjs';
import { clickGisTarget, observeGisPage } from './google_sso/gis_state/page_reading.mjs';
import { classifyGisState, gisVariantRank } from './google_sso/gis_state/variants.mjs';
import { dumpGisFailureDom } from './google_sso/failure_dom.mjs';
import { pageCondition, pageSettled } from '../_shared/page/settled.mjs';

export { waitForEnabledThenClick } from './google_sso/page_controls.mjs';
export { readGisState } from './google_sso/gis_state/page_reading.mjs';
export { classifyGisState, gisVariantRank } from './google_sso/gis_state/variants.mjs';

// The GIS handoff is governed by what the pages report, never by a clock or a
// count of attempts: the old fixed 4-attempt loop clicked the button again
// while Google's chooser was still sitting in a popup nobody was driving. A
// state is acted on once; until it changes the loop waits for the event that
// can change it (a navigation of the acting page, a new page, the page
// closing). A state this step does not drive, still shown once its page has
// settled, is reported by name with its DOM.
//
// How many times the authorize URL may be re-driven when claude.ai answers it
// with the app instead of the consent screen. Once the Google half succeeds the
// session exists, and claude.ai then consumes the CLI's authorize request and
// lands on /new; re-issuing it in the same session is what produces the consent
// screen and the callback page. Bounded and named, so an authorize URL that has
// really been spent fails as itself.
const GIS_AUTHORIZE_REDRIVES = Number(process.env.CLAUDE_GIS_AUTHORIZE_REDRIVES || 2);

// Variants this step drives; any other state that holds still is a failure.
const DRIVEN_VARIANTS = new Set([
  'code_page', 'claude_gis_gate', 'claude_gis_gate_pending', 'google_rejected', 'google_account_chooser',
  'google_chooser_without_account', 'google_identifier', 'google_confirm_continue',
  'oauth_consent', 'claude_app_authenticated', 'claude_app_loading',
]);

// Resolves once something that can change the handoff's state happens: the
// acting page navigates, closes, or the context opens another page.
async function stateChange(page, active, url) {
  if (active.isClosed() || active.url() !== url) return;
  const { promise, resolve, reject } = Promise.withResolvers();
  const context = page.context();
  const onNavigated = (frame) => {
    if (frame === active.mainFrame() && frame.url() !== url) resolve();
  };
  const onCrash = () => reject(new Error(`gis_continue: acting page crashed at ${active.url()}`));
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
// the acting page alone missed run a7f41fd6's popup: claude.ai's gate went
// disabled while Google's popup loaded, and the popup's navigation reached
// no listener. Every listener is removed when the wait ends.
async function anyPageChange(page, views, also) {
  const context = page.context();
  const { promise, resolve, reject } = Promise.withResolvers();
  const detach = [];
  const listen = (target, event, handler) => {
    target.on(event, handler);
    detach.push(() => target.off(event, handler));
  };
  for (const { p, st } of views) {
    const url = st?.url ?? p.url();
    if (p.isClosed() || p.url() !== url) resolve();
    listen(p, 'framenavigated', (frame) => { if (frame === p.mainFrame() && frame.url() !== url) resolve(); });
    listen(p, 'close', resolve);
    listen(p, 'crash', () => reject(new Error(`gis_continue: a handoff page crashed at ${p.url()}`)));
  }
  listen(context, 'page', resolve);
  also.then(resolve, resolve);
  try {
    await promise;
  } finally {
    for (const off of detach) off();
  }
}

async function clickOfferedControl(active, kind) {
  const hit = await clickGisTarget(active, kind);
  if (!hit.clicked) {
    const current = new URL(active.url());
    const error = new Error(`gis_continue: ${kind} was not clicked at ${current.host}${current.pathname}: ${hit.reason}`);
    error.code = 'gis_control_unavailable';
    throw error;
  }
}

export async function doGoogleSso({
  page, login, authorizeUrl, mark,
  humanFill, humanClickLocator, humanType,
}) {
  mark('google_prelogin_goto');
  await page.goto('https://accounts.google.com/ServiceLogin?hl=en', { waitUntil: 'commit' });

  await enterGoogleCredentials({ page, login, mark, humanFill, humanClickLocator, humanType });

  // Session established. Now load claude.ai's OAuth — GIS sees the account.
  mark('goto_authorize');
  await page.goto(authorizeUrl, { waitUntil: 'commit' });
  await pageSettled(page);

  mark('gis_continue');
  // GIS can place account selection in a popup while the parent still shows
  // its sign-in gate. Inspect every live page and select the intended account
  // by data-identifier, not localized text; keep the popup available to finish.
  const seen = new WeakSet();
  const onPopup = (p) => { if (!seen.has(p)) { seen.add(p); mark('gis_popup'); } };
  page.context().on('page', onPopup);
  let freshEntryTried = false;
  const lastActions = new WeakMap();
  let views = [];
  let authorizeRedrives = 0;
  let stuck = null;
  try {
    for (;;) {
      views = [];
      for (const p of page.context().pages()) {
        if (p.isClosed()) continue;
        // The caller supplies the selected account's login. Match Google's
        // data-identifier to that identity, never a row position or label.
        // Google closes its popup once the account is confirmed, and a read
        // that started a moment before ends with 'Target page, context or
        // browser has been closed' (run 4904c60a failed on exactly that right
        // after gis_confirm_continue). A page that is closed after its read
        // failed is simply gone; any other failure stands.
        let st;
        try {
          st = await observeGisPage(p, login.email);
        } catch (error) {
          if (p.isClosed()) continue;
          throw error;
        }
        views.push({ p, st, variant: classifyGisState(st) });
      }
      views.sort((a, b) => gisVariantRank(a.variant) - gisVariantRank(b.variant));
      const view = views[0];
      if (!view) { stuck = null; break; }
      const { p: active, st, variant } = view;

      if (variant === 'code_page') { mark('code_page'); return active; }

      // A state this step does not drive: give its page the chance to settle
      // into a driven one, then report it by name. Google's popup is such a
      // page for the moment between the confirmed account and its closing,
      // and run 40f115ef failed in that moment ('Target page, context or
      // browser has been closed' from pageSettled): a page that closed while
      // it settled is gone, and the next round reads the pages that remain.
      if (!DRIVEN_VARIANTS.has(variant)) {
        let again;
        try {
          await pageSettled(active);
          again = classifyGisState(await observeGisPage(active, login.email));
        } catch (error) {
          if (active.isClosed()) continue;
          throw error;
        }
        if (!DRIVEN_VARIANTS.has(again)) { stuck = view; break; }
        continue;
      }

      // Acting twice on a state that has not changed yet is what produced the
      // popup pile-up, so an identical (variant, url) is acted on once; until it
      // changes, the loop waits for the event that can change it.
      const actionKey = `${variant}|${st?.url ?? ''}`;
      if (actionKey === lastActions.get(active)) {
        await stateChange(page, active, st.url);
        continue;
      }
      const claim = () => { lastActions.set(active, actionKey); };

      if (variant === 'claude_gis_gate') {
        // The gate is only meaningful while no Google page is holding the
        // decision; otherwise clicking it opens yet another popup. A click that
        // just opened a popup shows up once the gate page has settled.
        await pageSettled(active);
        const google = page.context().pages().find((p) => !p.isClosed() && /accounts\.google\.com/.test(p.url()));
        if (google) {
          await stateChange(page, google, google.url());
          continue;
        }
        claim();
        mark('gis_click_continue');
        await clickOfferedControl(active, 'gis_button');
        continue;
      }

      if (variant === 'claude_gis_gate_pending') {
        // Nothing to click yet: the page enables its Google button itself, or
        // moves on. Either ends this wait; the operator sees the stage in
        // `weles runs show` and can end a gate that never opens.
        mark('gis_gate_pending');
        const enabled = pageCondition(active, () => Array.from(document.querySelectorAll('button,[role="button"]'))
          .some((el) => /continue with google|^google$/i.test((el.innerText || el.textContent || '').trim())
            && !el.disabled && el.getAttribute('aria-disabled') !== 'true'));
        // A navigation ends the page read with a destroyed context; any page
        // of the handoff moving on (Google's popup loading) also ends it.
        await anyPageChange(page, views, enabled);
        continue;
      }

      if (variant === 'claude_app_loading') {
        // The app is still loading: wait for its last loading marker to go
        // or for the page to move on. The stage is visible in `weles runs
        // show`, and the operator ends a page that never loads with
        // `weles runs cancel`.
        mark('claude_app_loading');
        const rendered = pageCondition(active, () => document.querySelector('[data-page-loading]') === null);
        await anyPageChange(page, views, rendered);
        continue;
      }

      if (variant === 'google_rejected') {
        const dump = await dumpGisFailureDom(views, variant);
        throw new Error(`gis_continue: Google refused this sign-in (variant 'google_rejected') at ${st.host}${st.pathname}; body="${st.bodyText}"; DOM snapshot: ${dump.written[0]?.path ?? dump.indexPath}`);
      }

      if (variant === 'google_account_chooser') {
        claim();
        mark('gis_account_chooser');
        // Only the configured identity's exact data-identifier match is selected.
        console.log(`[google_sso] selecting account row by ${st.accountRowMatchedBy} (${st.rowIdentifiers.join(', ')})`);
        await clickOfferedControl(active, 'account_row');
        continue;
      }

      if (variant === 'google_chooser_without_account') {
        // The signed-in session is not the account we need: take the chooser's
        // other row ("use another account"), which lands on the identifier page
        // handled below.
        if (!st.otherAccountRow) {
          await pageSettled(active);
          if (!(await observeGisPage(active, login.email)).otherAccountRow) { stuck = view; break; }
          continue;
        }
        claim();
        mark('gis_use_another_account');
        await clickOfferedControl(active, 'other_account');
        continue;
      }

      if (variant === 'google_identifier') {
        if (freshEntryTried) { stuck = view; break; }
        claim();
        freshEntryTried = true;
        await enterGoogleCredentials({ page: active, login, mark, humanFill, humanClickLocator, humanType });
        continue;
      }

      if (variant === 'google_confirm_continue') {
        claim();
        mark('gis_confirm_continue');
        await clickOfferedControl(active, 'primary');
        continue;
      }

      if (variant === 'oauth_consent') {
        claim();
        mark('oauth_consent_click');
        await clickOfferedControl(active, 'consent');
        // The SPA POSTs /v1/oauth/.../authorize (slow in headless, renders a
        // spinner) and then redirects to platform.claude.com. That redirect is
        // just another state this same loop observes.
        continue;
      }

      if (variant === 'claude_app_authenticated') {
        // The Google half is done and the session is live; claude.ai simply
        // consumed the CLI's authorize request and showed the app. Re-issue that
        // exact URL in this session: with the session present it renders the grant
        // screen, which the loop then handles as oauth_consent, and the callback
        // page the CLI expects arrives as code_page.
        if (authorizeRedrives >= GIS_AUTHORIZE_REDRIVES) {
          const dump = await dumpGisFailureDom(views, 'claude_authorize_consumed');
          throw new Error(`gis_continue: claude_authorize_consumed — claude.ai answered the authorize URL with its app ${authorizeRedrives + 1} times (now ${st.url} title="${st.title}"); the CLI's authorize request is spent, a new one is needed; DOM snapshot: ${dump.written[0]?.path ?? dump.indexPath}`);
        }
        claim();
        authorizeRedrives += 1;
        mark('gis_authorize_redrive');
        await active.goto(authorizeUrl, { waitUntil: 'commit' });
        await pageSettled(active);
        continue;
      }
    }

    const variant = stuck?.variant ?? 'no_live_page';
    const dump = await dumpGisFailureDom(views, variant);
    const where = stuck?.st ? `${stuck.st.host}${stuck.st.pathname} title="${stuck.st.title}"` : 'no live page';
    const evidence = dump.written.map((w) => w.path).join(', ') || dump.indexPath;
    const rows = stuck?.st?.rowIdentifiers?.length ? ` rows=[${stuck.st.rowIdentifiers.join(', ')}]` : '';
    throw new Error(`gis_continue: unhandled variant '${variant}' at ${where}${rows} after its page settled; live pages=${views.map((v) => v.variant).join('+') || 'none'}; DOM snapshot: ${evidence}`);
  } finally {
    page.context().off('page', onPopup);
  }
}
