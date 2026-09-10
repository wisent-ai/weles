// Which page owns the decision right now, and what that page is called.
//
// The names here are either proven by the 2026-08-17 recording or are Google
// sign-in surfaces this trajectory already drives elsewhere; anything else stays
// 'unknown' and ends up in the failure message rather than being guessed at. The
// ranking lives beside the naming because a diagnostic that disagreed with the
// trajectory about these states would be worse than no diagnostic.

// Highest priority first. A live Google page always outranks the parent's
// "Continue with Google" gate, because the parent still shows that gate while
// the popup holds the account decision — that is exactly the pair of states the
// 2026-08-17 run mistook for "nothing happened" and re-clicked.
const GIS_VARIANT_PRIORITY = [
  'code_page',
  'oauth_consent',
  'google_rejected',
  'google_account_chooser',
  'google_chooser_without_account',
  'google_identifier',
  'google_password',
  'google_confirm_continue',
  'google_challenge',
  'google_other',
  'claude_gis_gate',
  'claude_app_authenticated',
  'unknown',
];

// Rank of a state. Exported with classifyGisState because the two together are
// the whole definition of "which page owns the decision right now", and the
// failure message names those same states — a diagnostic that disagrees with
// the trajectory about them would be worse than no diagnostic.
export function gisVariantRank(variant) {
  const i = GIS_VARIANT_PRIORITY.indexOf(variant);
  return i < 0 ? GIS_VARIANT_PRIORITY.length : i;
}

// Name the state the page is in. Every name here is either proven by the
// 2026-08-17 recording or is a Google sign-in surface this file already drives
// elsewhere; anything else stays 'unknown' and ends up in the failure message
// rather than being guessed at.
export function classifyGisState(st) {
  if (!st || !st.ok) return 'unknown';
  if (st.host === 'platform.claude.com') return 'code_page';
  if (st.host === 'accounts.google.com') {
    if (/\/signin\/rejected|deniedsigninrejected/.test(st.pathname)) return 'google_rejected';
    if (st.accountRow) return 'google_account_chooser';
    if (/accountchooser|oauthchooseaccount/.test(st.pathname) && st.rowCount > 0) return 'google_chooser_without_account';
    // Identifier first: the sign-in flow this file drives starts at the email
    // field, so a page offering both fields is an identifier page. A page with
    // only a password field is Google re-verifying an existing session, which
    // this step does not drive — it is named in the failure instead of guessed.
    if (st.identifierField) return 'google_identifier';
    if (st.passwordField) return 'google_password';
    // Account already chosen, Google asking to confirm it: the state run cbf8fb03
    // sat in for 300s. It is /v3/signin/accountchooser with NO data-identifier
    // row at all, the heading "Zalogujesz się ponownie w usłudze Claude", the
    // selected-account switcher, and "Anuluj"/"Dalej" — the affirmative button is
    // the whole action. The older scope screen (/signin/oauth, /o/oauth2) is the
    // same decision, so both resolve here.
    if (st.googlePrimary) return 'google_confirm_continue';
    if (/\/signin\/(v2\/)?challenge/.test(st.pathname)) return 'google_challenge';
    return 'google_other';
  }
  if (st.consent) return 'oauth_consent';
  if (st.gisButton) return 'claude_gis_gate';
  // Signed in, but claude.ai answered the CLI's authorize request with the app
  // itself: run 19ac8c0f ended on https://claude.ai/new titled "New chat -
  // Claude" as the only live page, with no grant affordance and no gate. The
  // session is exactly what the authorize URL needs, so this state is driven by
  // re-issuing that URL here rather than waited out.
  if (/(^|\.)claude\.(ai|com)$/.test(st.host) && !/^\/(login|oauth)(\/|$)/.test(st.pathname)) {
    return 'claude_app_authenticated';
  }
  return 'unknown';
}
