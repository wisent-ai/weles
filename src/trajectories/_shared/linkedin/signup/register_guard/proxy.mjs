// The proxy a LinkedIn registration runs through: its summarised state, the diagnostics of a
// failure, and the assertions that it is the requested, stable, dedicated ISP exit.
//
// Every judgement reads the resolved proxy record (provider, proxy_type, sticky_session_id,
// server) and the one retirement record, Skarbiec's retired_proxy_pools setting; nothing is
// guessed from words or address shapes in the request, and no environment switch lets a
// registration run unproxied.
import { isIP } from 'node:net';
import { retiredProviderReason } from '../../../../../../dist/proxy/resolve/exit/retired.js';
import {
  requestsNoProxy,
  requestsUrlForm,
} from '../../../../../../dist/proxy/resolve/url_form.js';
import {
  getLinkedinAuthState,
  getLinkedinChallengeSignal,
  summarizeLinkedinPage,
} from './page_state.mjs';

// The one proxy type a LinkedIn registration runs through: a dedicated ISP exit, whose
// address stays the account's for its whole life (proxy/sources/provider_credentials.ts).
const DEDICATED_ISP = 'isp';

// A field the record states, or null when it states none: an absent field is reported as
// absent, never as an empty value that reads like one that was measured.
function stated(value) {
  if (value === undefined || value === null || value === '') return null;
  return value;
}

// The proxy server address the record names, or the reason it names none.
function serverAddress(server) {
  if (!server) return { error: 'the session states no proxy server' };
  if (!URL.canParse(server)) {
    return {
      error: `proxy server ${JSON.stringify(server)} does not parse as a URL`,
    };
  }
  const u = new URL(server);
  return {
    host: u.hostname,
    port: u.port,
    scheme: u.protocol.replace(/:$/, ''),
  };
}

export function summarizeLinkedinProxyState(
  session,
  requestedProxy,
  expectedExitIp,
) {
  const cfg = session.proxyConfig;
  const requested = stated(requestedProxy);
  return {
    requested:
      requested !== null && requestsUrlForm(String(requested))
        ? '[url-form]'
        : requested,
    server: cfg
      ? serverAddress(cfg.server)
      : { error: 'the session has no proxy' },
    provider: stated(cfg?.provider),
    proxy_type: stated(cfg?.proxy_type),
    platform: stated(cfg?.platform),
    country: stated(cfg?.country),
    expected_exit_ip: stated(expectedExitIp),
    actual_exit_ip: stated(cfg?.exit_ip),
  };
}

export async function getLinkedinFailureDiagnostics(
  session,
  requestedProxy,
  expectedExitIp,
) {
  const page = await summarizeLinkedinPage(session.page).catch((e) => ({
    error: e.message,
  }));
  return {
    auth: await getLinkedinAuthState(session).catch((e) => ({
      error: e.message,
    })),
    proxy: summarizeLinkedinProxyState(session, requestedProxy, expectedExitIp),
    challenge_signal: page?.error ? null : getLinkedinChallengeSignal(page),
    page,
  };
}

export async function assertLinkedinProxyStable(
  session,
  stage,
  expectedExitIp,
) {
  if (!session.proxyConfig?.server) {
    throw new Error(
      'PROXY_REQUIRED: linkedin_register requires proxied dedicated ISP traffic',
    );
  }
  let actual;
  try {
    const res = await session.ctx.request.get('https://api.ipify.org');
    if (!res.ok())
      throw new Error(
        `exit address service answered ${res.status()} ${res.statusText()}`,
      );
    actual = (await res.text()).trim();
  } catch (e) {
    throw new Error(
      `PROXY_DRIFT_CHECK_FAILED: stage=${stage} err=${e.message}`,
    );
  }
  if (!actual)
    throw new Error(`PROXY_DRIFT_CHECK_FAILED: stage=${stage} empty_exit_ip`);
  if (!isIP(actual)) {
    throw new Error(
      `PROXY_DRIFT_CHECK_FAILED: stage=${stage} invalid_exit_ip=${actual}`,
    );
  }
  // The exit this registration is bound to: the one the caller already observed, else the
  // one the session's record pinned. Before either is known the first observation binds it.
  const bound = expectedExitIp ? expectedExitIp : session.proxyConfig.exit_ip;
  if (bound && bound !== actual) {
    throw new Error(
      `PROXY_DRIFT: stage=${stage} expected=${bound} actual=${actual}`,
    );
  }
  session.proxyConfig.exit_ip = actual;
  return actual;
}

// Refuses, before a browser starts, a request that cannot resolve to a dedicated ISP
// record: no proxy at all, or a proxy URL, which declares no provider or proxy type.
// Everything else is judged on the record the request resolves to.
export function assertLinkedinRegisterProxyRequest(requestedProxy) {
  if (requestsNoProxy(requestedProxy)) {
    throw new Error(
      `PROXY_REQUIRED: linkedin_register requires a dedicated ISP proxy; requested=${JSON.stringify(requestedProxy)}`,
    );
  }
  if (requestsUrlForm(requestedProxy.trim())) {
    throw new Error(
      'PROXY_NOT_DEDICATED_ISP: url_form_proxy_request (a proxy URL declares no provider or proxy type; request the provider pool instead)',
    );
  }
}

// Refuses a session whose resolved proxy record is not a live dedicated ISP exit, naming
// the field of the record that decides it.
export function assertLinkedinDedicatedIspProxy(session, requestedProxy) {
  const cfg = session.proxyConfig;
  const requested = JSON.stringify(requestedProxy);
  if (!cfg?.server) {
    throw new Error(
      `PROXY_REQUIRED: the session for requested=${requested} runs with no proxy`,
    );
  }
  const server = serverAddress(cfg.server);
  if (server.error) throw new Error(`PROXY_NOT_DEDICATED_ISP: ${server.error}`);
  if (!cfg.provider) {
    throw new Error(
      `PROXY_NOT_DEDICATED_ISP: missing_provider server=${server.host} requested=${requested}`,
    );
  }
  if (!cfg.proxy_type) {
    throw new Error(
      `PROXY_NOT_DEDICATED_ISP: missing_proxy_type provider=${cfg.provider} server=${server.host}`,
    );
  }
  if (cfg.proxy_type !== DEDICATED_ISP) {
    throw new Error(
      `PROXY_NOT_DEDICATED_ISP: proxy_type=${cfg.proxy_type} provider=${cfg.provider}`,
    );
  }
  const retired = retiredProviderReason(server.host, server.port);
  if (retired) {
    throw new Error(
      `PROXY_NOT_DEDICATED_ISP: retired_linkedin_proxy reason=${retired} provider=${cfg.provider} server=${server.host}:${server.port}`,
    );
  }
  if (cfg.sticky_session_id) {
    throw new Error(
      `PROXY_NOT_DEDICATED_ISP: the ${cfg.provider} record carries rotating-pool session ${cfg.sticky_session_id}; a dedicated ISP exit has none`,
    );
  }
}
