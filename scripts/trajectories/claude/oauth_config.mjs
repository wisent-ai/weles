// Shared constants for the claude login trajectory.
//
// GROUND TRUTH (2026-05-18): captured the EXACT authorize URL the
// real `claude` CLI v2.1.143 generates via `script -q claude
// setup-token`:
//   https://claude.com/cai/oauth/authorize?code=true
//     &client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e
//     &response_type=code
//     &redirect_uri=https://platform.claude.com/oauth/code/callback
//     &scope=user:inference
//     &code_challenge=...&code_challenge_method=S256&state=...
// Every prior "Authorization failed — Invalid request format" was
// caused by hitting the WRONG endpoint (claude.ai/oauth/authorize)
// with the WRONG scope (4-scope list). The CLI uses the
// claude.com/cai host and a SINGLE scope: user:inference.

export const CLAUDE_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
// claude.com/cai/oauth/authorize was captured from the real CLI's
// setup-token OSC-8 hyperlink, but curl proved it just 307-redirects
// to claude.ai/oauth/authorize with identical params — a pointless
// extra hop. The endpoint was NEVER the cause of "Invalid request
// format". Use the canonical claude.ai endpoints directly.
export const CLAUDE_AUTHORIZE_URL = 'https://claude.ai/oauth/authorize';
export const CLAUDE_TOKEN_URL = 'https://claude.ai/v1/oauth/token';

// Hosted callback — claude.com displays the code on this page for
// the headless/manual flow (code=true). The trajectory reads it
// from the DOM (no loopback listener).
export const CLAUDE_REDIRECT_URI = 'https://platform.claude.com/oauth/code/callback';

// The real CLI sends EXACTLY one scope.
export const CLAUDE_OAUTH_SCOPES = [
  'user:inference',
];
