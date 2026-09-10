// Parametric cross-login runner.
//
// Action: <platform>_login_via_<provider>
// Resolved by dispatch.ts to this file with env: PLATFORM, PROVIDER set
// from the action name. Looks up the per-(target, provider) OAuth-button
// regex + target URL in the TARGETS table and delegates to runCrossLogin.
//
// To add a new (target, provider) pair: add a row to TARGETS, no new
// trajectory file needed, no dispatch.ts edit needed beyond the catch-all
// `login_via_<provider>` route.

import { runCrossLogin } from '../_shared/oauth/cross_login.mjs';

const TARGETS = {
  reddit: {
    apple:    { url: 'https://www.reddit.com/login',           regex: /^\s*Sign in with Apple\s*$/i },
  },
  tiktok: {
    google:   { url: 'https://www.tiktok.com/login',           regex: /^\s*Continue with Google\s*$/i },
    apple:    { url: 'https://www.tiktok.com/login',           regex: /^\s*Continue with Apple\s*$/i },
    facebook: { url: 'https://www.tiktok.com/login',           regex: /^\s*Continue with Facebook\s*$/i },
  },
  twitter: {
    apple:    { url: 'https://x.com/i/flow/login',             regex: /^\s*Sign in with Apple\s*$/i },
  },
  instagram: {
    facebook: { url: 'https://www.instagram.com/accounts/login/', regex: /^\s*Log in with Facebook\s*$/i },
  },
  linkedin: {
    google:    { url: 'https://www.linkedin.com/login',        regex: /^\s*Sign in with Google\s*$/i },
    apple:     { url: 'https://www.linkedin.com/login',        regex: /^\s*Sign in with Apple\s*$/i },
    microsoft: { url: 'https://www.linkedin.com/login',        regex: /^\s*Sign in with Microsoft\s*$/i },
  },
  github: {
    google: { url: 'https://github.com/login', regex: /^\s*Continue with Google\s*$/i },
    apple:  { url: 'https://github.com/login', regex: /^\s*Continue with Apple\s*$/i },
  },
  snapchat: {
    google: { url: 'https://accounts.snapchat.com/accounts/login', regex: /^\s*Continue with Google\s*$/i },
  },
  producthunt: {
    // PH renders the homepage on / and needs a "Sign in" click to open the
    // OAuth modal before the provider buttons exist in the DOM. opener regex
    // matches the topbar Sign in link; the runner clicks it before searching
    // for the provider button.
    twitter:  { url: 'https://www.producthunt.com/', regex: /^\s*(Sign in with X|Continue with X|Sign up with Twitter|Continue with Twitter)\s*$/i, opener: /^\s*Sign in\s*$/i },
    google:   { url: 'https://www.producthunt.com/', regex: /^\s*(Sign in with Google|Continue with Google|Sign up with Google)\s*$/i, opener: /^\s*Sign in\s*$/i },
    apple:    { url: 'https://www.producthunt.com/', regex: /^\s*(Sign in with Apple|Continue with Apple|Sign up with Apple)\s*$/i, opener: /^\s*Sign in\s*$/i },
    facebook: { url: 'https://www.producthunt.com/', regex: /^\s*(Sign in with Facebook|Continue with Facebook|Sign up with Facebook)\s*$/i, opener: /^\s*Sign in\s*$/i },
  },
  threads: {
    instagram: { url: 'https://www.threads.net/login', regex: /^\s*Continue with Instagram\s*$/i },
  },
};

const platform = process.env.PLATFORM ?? '';
const provider = process.env.PROVIDER ?? '';

if (!platform || !provider) {
  console.log(`FAIL: cross_login requires PLATFORM and PROVIDER env (got platform="${platform}" provider="${provider}")`);
  process.exit(1);
}

const cell = TARGETS[platform]?.[provider];
if (!cell) {
  console.log(`FAIL: no cross-login cell for ${platform} via ${provider} — add a row to TARGETS`);
  process.exit(1);
}

await runCrossLogin({
  targetPlatform: platform,
  targetUrl: cell.url,
  provider,
  providerButtonRegex: cell.regex,
  openerButtonRegex: cell.opener,
});
