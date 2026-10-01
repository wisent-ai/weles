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
import { pageSettled } from '../_shared/page/settled.mjs';

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
  'code_page', 'claude_gis_gate', 'google_rejected', 'google_account_chooser',
  'google_chooser_without_account', 'google_identifier', 'google_confirm_continue',
  'oauth_consent', 'claude_app_authenticated',
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
  humanFill, humanClickLocator, humanIdlePause, humanType,
}) {
  mark('google_prelogin_goto');
  await page.goto('https://accounts.google.com/ServiceLogin?hl=en', { waitUntil: 'commit' });

  await enterGoogleCredentials({ page, login, mark, humanFill, humanClickLocator, humanType });

  // Session established. Now load claude.ai's OAuth — GIS sees the account.
  mark('goto_authorize');
  await page.goto(authorizeUrl, { waitUntil: 'commit' });
  await humanIdlePause('deliberate');

  mark('gis_continue');
  // How this handoff actually behaves, from the recorded run
  // e9b443eb-8e50-4836-a5a6-6671af07cbd2 (claude_login, 2026-08-17T01:03:49Z to
  // 01:07:56Z) under the worker's recordings root: its session.har lists five
  // pages — the trajectory's page plus four popups titled "Logowanie – Konta
  // Google" opened at 01:05:13, 01:05:55, 01:06:36 and 01:07:17, one per click
  // of "Continue with Google". GIS opens them with
  // prompt=select_account%20consent&display=popup, so Google renders its
  // account chooser there every time, and the popup's own document
  // (/v3/signin/accountchooser, embedded in that HAR) carries the row as
  // <div role="link" jsname="MBVUVe" data-identifier="controlyourai@gmail.com"
  // data-button-type="multipleChoiceIdentifier"> in Polish, with no continue
  // button at all — clicking the row IS the action. The step that failed closed
  // the first popup, then polled only the parent, which claude.ai had bounced to
  // /login?selectAccount=true&returnTo=%2Foauth%2Fauthorize... — the state
  // session_dom_20260816_180756.html shows. Popups two to four were never
  // adopted (the listener kept only the first) and sat unattended on the
  // chooser. So: never close the popup, read every live page each poll, act on
  // the state that page is in, and select the account by data-identifier
  // instead of by localized text.
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
        // login.email is this account's own login field, resolved by
        // getServiceLogin from the display name the caller's vault login item id
        // selected, and it is the value Google puts in the row's data-identifier
        // (proven: the recorded chooser row for Claude_controlyourai carries
        // data-identifier="controlyourai@gmail.com"). That is what makes the row
        // selectable by identity rather than by position or localized label.
        const st = await observeGisPage(p, login.email);
        views.push({ p, st, variant: classifyGisState(st) });
      }
      views.sort((a, b) => gisVariantRank(a.variant) - gisVariantRank(b.variant));
      const view = views[0];
      if (!view) { stuck = null; break; }
      const { p: active, st, variant } = view;

      if (variant === 'code_page') { mark('code_page'); return active; }

      // A state this step does not drive: give its page the chance to settle
      // into a driven one, then report it by name.
      if (!DRIVEN_VARIANTS.has(variant)) {
        await pageSettled(active);
        const again = classifyGisState(await observeGisPage(active, login.email));
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
        await humanIdlePause('deliberate');
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
        await humanIdlePause('long');
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
        await humanIdlePause('long');
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
        await humanIdlePause('long');
        continue;
      }

      if (variant === 'oauth_consent') {
        claim();
        mark('oauth_consent_click');
        await clickOfferedControl(active, 'consent');
        // The SPA POSTs /v1/oauth/.../authorize (slow in headless, renders a
        // spinner) and then redirects to platform.claude.com. That redirect is
        // just another state this same loop observes.
        await humanIdlePause('long');
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
        await humanIdlePause('deliberate');
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
