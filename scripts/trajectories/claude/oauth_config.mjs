// Shared constants for the claude login trajectory.
// Values cited from https://claude.ai/oauth/claude-code-client-metadata
// (public OAuth client metadata for the claude-code CLI).

export const CLAUDE_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
export const CLAUDE_AUTHORIZE_URL = 'https://claude.ai/oauth/authorize';
export const CLAUDE_TOKEN_URL = 'https://claude.ai/v1/oauth/token';

// The claude-code OAuth client is registered ONLY for the hosted
// callback (and portless loopback). A ported loopback redirect_uri
// (http://127.0.0.1:<port>/callback) is rejected by claude.ai with
// "Authorization failed — Invalid request format" (video 07:12Z &
// 15:52Z). The hosted callback displays the code on-page for the
// headless/manual-paste flow; the trajectory reads it from the DOM.
export const CLAUDE_REDIRECT_URI = 'https://platform.claude.com/oauth/code/callback';

// EXACT scope string + order the real claude-code CLI sends. The
// prior list had wrong order and an extra user:file_upload, which
// (with the bad redirect_uri) produced the malformed-request error.
export const CLAUDE_OAUTH_SCOPES = [
  'user:profile',
  'user:inference',
  'user:sessions:claude_code',
  'user:mcp_servers',
];
