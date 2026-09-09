import { createHash, randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

// Public OAuth clients and endpoints from the providers' authentication protocols.
// These exchanges never invoke a provider CLI or touch its local credential store.
const OPENAI = { origin: 'https://auth.openai.com', client: 'app_EMoamEEZ73f0CkXaXp7hrann' };
const KIMI = { origin: 'https://auth.kimi.com', client: '17e5f671-d194-4dfb-9706-5516cb48c098' };
const CLAUDE = {
  authorize: 'https://claude.ai/oauth/authorize',
  token: 'https://console.anthropic.com/v1/oauth/token',
  redirect: 'https://console.anthropic.com/oauth/code/callback',
  client: '9d1c250a-e61b-44d9-88ed-5944d1962f5e',
  scopes: 'user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload',
};

export class AuthenticationFailure extends Error {
  constructor(code, stage, message, status = null) {
    super(message);
    this.code = code;
    this.stage = stage;
    this.status = status;
  }
}

async function post(url, payload, form = false) {
  let response;
  try {
    response = await fetch(url, {
      method: 'POST', redirect: 'error',
      headers: { 'content-type': form ? 'application/x-www-form-urlencoded' : 'application/json' },
      body: form ? new URLSearchParams(payload) : JSON.stringify(payload),
    });
  } catch (error) {
    throw new AuthenticationFailure('oauth_transport_failed', 'oauth_exchange', `${url}: ${error.message}`);
  }
  let data;
  try { data = await response.json(); }
  catch { throw new AuthenticationFailure('oauth_response_invalid', 'oauth_exchange', `${url} did not return JSON`, response.status); }
  return { status: response.status, ok: response.ok, data };
}

function accepted(answer, stage) {
  if (answer.ok) return answer.data;
  const detail = answer.data.error_description || answer.data.message || answer.data.error?.message
    || (typeof answer.data.error === 'string' ? answer.data.error : 'provider refused the OAuth request');
  throw new AuthenticationFailure('oauth_provider_refused', stage, String(detail), answer.status);
}

function credential(provider, tokens, expectedEmail) {
  if (!tokens.access_token || !tokens.refresh_token) {
    throw new AuthenticationFailure('oauth_grant_incomplete', 'grant_validation',
      'The provider did not return both an access token and a refresh token');
  }
  if (provider === 'codex') {
    let identity;
    try { identity = JSON.parse(Buffer.from(tokens.id_token.split('.')[1], 'base64url').toString()); }
    catch { throw new AuthenticationFailure('oauth_identity_missing', 'grant_validation', 'OpenAI did not return a readable identity token'); }
    if (identity.email?.toLowerCase() !== expectedEmail.toLowerCase()) {
      throw new AuthenticationFailure('oauth_identity_mismatch', 'grant_validation',
        'The OpenAI grant belongs to a different account than the selected Skarbiec login');
    }
    return { auth_mode: 'chatgpt', tokens: {
      access_token: tokens.access_token, refresh_token: tokens.refresh_token,
      id_token: tokens.id_token, account_id: identity['https://api.openai.com/auth']?.chatgpt_account_id,
    }, last_refresh: new Date().toISOString() };
  }
  if (provider === 'claude') {
    const email = tokens.account?.email_address;
    if (email && email.toLowerCase() !== expectedEmail.toLowerCase()) {
      throw new AuthenticationFailure('oauth_identity_mismatch', 'grant_validation',
        'The Anthropic grant belongs to a different account than the selected Skarbiec login');
    }
    return { claudeAiOauth: {
      accessToken: tokens.access_token, refreshToken: tokens.refresh_token,
      expiresAt: Date.now() + tokens.expires_in * 1000,
      scopes: String(tokens.scope || CLAUDE.scopes).split(' '),
    } };
  }
  return { ...tokens, expires_at: Math.floor(Date.now() / 1000) + tokens.expires_in };
}

/** Start an OAuth transaction; only the approved Weles browser sees its URL/code. */
export async function beginOAuth(provider) {
  if (provider === 'claude') {
    const verifier = randomBytes(32).toString('base64url');
    const state = randomBytes(32).toString('base64url');
    const query = new URLSearchParams({ client_id: CLAUDE.client, response_type: 'code',
      redirect_uri: CLAUDE.redirect, scope: CLAUDE.scopes, state, code: 'true',
      code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256' });
    return { provider, url: `${CLAUDE.authorize}?${query}`, verifier, state };
  }
  const configuration = provider === 'codex' ? OPENAI : KIMI;
  const path = provider === 'codex' ? '/api/accounts/deviceauth/usercode' : '/api/oauth/device_authorization';
  const data = accepted(await post(`${configuration.origin}${path}`, { client_id: configuration.client }, provider === 'kimi'), 'device_authorization');
  return { provider, data, url: provider === 'codex' ? `${OPENAI.origin}/codex/device` : data.verification_uri_complete,
    code: data.user_code || data.usercode,
    expiresAt: Date.now() + (data.expires_in || 900) * 1000 };
}

export async function finishOAuth(transaction, expectedEmail, displayedCode) {
  const { provider } = transaction;
  if (provider === 'claude') {
    const [code, state] = String(displayedCode).split('#');
    if (!code || state !== transaction.state) {
      throw new AuthenticationFailure('oauth_state_mismatch', 'oauth_callback', 'The authorization callback does not match this login transaction');
    }
    const tokens = accepted(await post(CLAUDE.token, {
      grant_type: 'authorization_code', client_id: CLAUDE.client, code, state,
      redirect_uri: CLAUDE.redirect, code_verifier: transaction.verifier,
    }), 'token_exchange');
    return credential(provider, tokens, expectedEmail);
  }
  while (Date.now() < transaction.expiresAt) {
    const { data } = transaction;
    const answer = provider === 'codex'
      ? await post(`${OPENAI.origin}/api/accounts/deviceauth/token`, { device_auth_id: data.device_auth_id, user_code: transaction.code })
      : await post(`${KIMI.origin}/api/oauth/token`, { client_id: KIMI.client, device_code: data.device_code,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code' }, true);
    if (answer.ok) {
      if (provider === 'kimi') return credential(provider, answer.data, expectedEmail);
      const tokens = accepted(await post(`${OPENAI.origin}/oauth/token`, {
        grant_type: 'authorization_code', client_id: OPENAI.client,
        code: answer.data.authorization_code, code_verifier: answer.data.code_verifier,
        redirect_uri: `${OPENAI.origin}/deviceauth/callback`,
      }, true), 'token_exchange');
      return credential(provider, tokens, expectedEmail);
    }
    const pending = provider === 'codex' ? [403, 404].includes(answer.status)
      : ['authorization_pending', 'slow_down'].includes(answer.data.error);
    if (!pending) accepted(answer, 'device_authorization');
    const interval = Math.max(1, Number(data.interval) || 5) + (answer.data.error === 'slow_down' ? 5 : 0);
    await delay(interval * 1000);
  }
  throw new AuthenticationFailure('oauth_device_expired', 'device_authorization', 'The provider authorization transaction expired');
}
