// Shared constants for the claude login trajectory.
// Values cited from https://claude.ai/oauth/claude-code-client-metadata
// (public OAuth client metadata for the claude-code CLI).

export const CLAUDE_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
export const CLAUDE_AUTHORIZE_URL = 'https://claude.ai/oauth/authorize';
export const CLAUDE_TOKEN_URL = 'https://claude.ai/v1/oauth/token';

// Default scope set the claude-code CLI requests on session bootstrap.
// Trimmed list of scopes — each entry mirrors a scope claude-code asks
// for when it spins up a new login session.
export const CLAUDE_OAUTH_SCOPES = [
  'user:inference',
  'user:profile',
  'user:sessions:claude_code',
  'user:mcp_servers',
  'user:file_upload',
];
