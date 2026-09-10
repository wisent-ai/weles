// The proxy a LinkedIn registration runs through: its summarised state, the diagnostics of a
// failure, and the assertions that it is the requested, stable, dedicated ISP exit.
import { isIP } from 'node:net';
import { getLinkedinAuthState, getLinkedinChallengeSignal, summarizeLinkedinPage } from './page_state.mjs';

export function summarizeLinkedinProxyState(session, requestedProxy = '', expectedExitIp = '') {
  const cfg = session.proxyConfig ?? {};
  let serverHost = '';
  let serverPort = '';
  let serverScheme = '';
  try {
    const u = new URL(cfg.server ?? '');
    serverHost = u.hostname;
    serverPort = u.port;
    serverScheme = u.protocol.replace(/:$/, '');
  } catch {}
  return {
    requested: String(requestedProxy).startsWith('http') ? '[url-form]' : String(requestedProxy).slice(0, 80),
    server_host: serverHost,
    server_port: serverPort,
    server_scheme: serverScheme,
    provider: cfg.provider ?? '',
    proxy_type: cfg.proxy_type ?? '',
    platform: cfg.platform ?? '',
    country: cfg.country ?? '',
    expected_exit_ip: expectedExitIp || '',
    actual_exit_ip: cfg.exit_ip ?? '',
  };
}

export async function getLinkedinFailureDiagnostics(session, requestedProxy = '', expectedExitIp = '') {
  const page = await summarizeLinkedinPage(session.page).catch((e) => ({ error: e.message?.slice(0, 160) }));
  return {
    auth: await getLinkedinAuthState(session).catch((e) => ({ error: e.message?.slice(0, 160) })),
    proxy: summarizeLinkedinProxyState(session, requestedProxy, expectedExitIp),
    challenge_signal: page?.error ? '' : getLinkedinChallengeSignal(page),
    page,
  };
}

export async function assertLinkedinProxyStable(session, stage, expectedExitIp = '') {
  if (!session.proxyConfig?.server) {
    if (process.env.LINKEDIN_ALLOW_NO_PROXY === '1') return session.proxyConfig?.exit_ip || '';
    throw new Error('PROXY_REQUIRED: linkedin_register requires proxied dedicated ISP traffic');
  }
  let actual = '';
  try {
    const res = await session.ctx.request.get('https://api.ipify.org', { timeout: 15000 });
    actual = (await res.text()).trim();
  } catch (e) {
    throw new Error(`PROXY_DRIFT_CHECK_FAILED: stage=${stage} err=${e.message?.slice(0, 120)}`);
  }
  if (!actual) throw new Error(`PROXY_DRIFT_CHECK_FAILED: stage=${stage} empty_exit_ip`);
  if (!isIP(actual)) {
    throw new Error(`PROXY_DRIFT_CHECK_FAILED: stage=${stage} invalid_exit_ip=${actual.slice(0, 80)}`);
  }
  const expected = expectedExitIp || session.proxyConfig.exit_ip || actual;
  if (expected && actual && expected !== actual) {
    throw new Error(`PROXY_DRIFT: stage=${stage} expected=${expected} actual=${actual}`);
  }
  session.proxyConfig.exit_ip = actual;
  return actual;
}

export function assertLinkedinRegisterProxyRequest(requestedProxy = '') {
  const raw = String(requestedProxy ?? '').trim().toLowerCase();
  if (raw === 'none' || raw === 'direct') {
    if (process.env.LINKEDIN_ALLOW_NO_PROXY === '1') return;
  }
  if (!raw || raw === 'none' || raw === 'direct') {
    throw new Error(`PROXY_NOT_DEDICATED_ISP: requested=${raw || 'empty'}`);
  }
  if (/^(https?:|socks)/.test(raw)) {
    throw new Error('PROXY_NOT_DEDICATED_ISP: url_form_proxy_request');
  }
  if (/\boxylabs\b/.test(raw) || /(?:^|[.:/])7777(?:\b|\/|$)/.test(raw) || /(?:^|\.)?(?:pr|isp|disp)\.oxylabs\.io\b/.test(raw)) {
    throw new Error(`PROXY_NOT_DEDICATED_ISP: retired_linkedin_proxy requested=${raw.slice(0, 80)}`);
  }
  if (/\b(residential|mobile|datacenter)\b/.test(raw) && !/\bisp\b/.test(raw)) {
    throw new Error(`PROXY_NOT_DEDICATED_ISP: requested=${raw.slice(0, 80)}`);
  }
  if (!/\bisp\b/.test(raw)) {
    throw new Error(`PROXY_NOT_DEDICATED_ISP: missing_isp_request requested=${raw.slice(0, 80)}`);
  }
}

export function assertLinkedinDedicatedIspProxy(session, requestedProxy = '') {
  const raw = String(requestedProxy).toLowerCase();
  if (raw === 'none' || raw === 'direct') {
    if (process.env.LINKEDIN_ALLOW_NO_PROXY === '1') return;
  }
  const server = String(session.proxyConfig?.server ?? '').toLowerCase();
  const username = String(session.proxyConfig?.username ?? '').toLowerCase();
  const provider = String(session.proxyConfig?.provider ?? '').toLowerCase();
  const proxyType = String(session.proxyConfig?.proxy_type ?? '').toLowerCase();
  const isUrlForm = /^(https?:|socks)/.test(raw);
  if (/\b(residential|mobile|datacenter)\b/.test(raw) && !/\bisp\b/.test(raw)) {
    throw new Error(`PROXY_NOT_DEDICATED_ISP: requested=${raw.slice(0, 80)}`);
  }
  const retiredLinkedinProxy =
    /\boxylabs\b/.test(raw) ||
    provider === 'oxylabs' ||
    /(^|\/\/|\.)(?:pr|isp|disp)\.oxylabs\.io(?::|\/|$)/.test(server) ||
    /(?:^|\/\/)(?:195\.86\.|152\.233\.|209\.38\.)/.test(server) ||
    /:7777(?:\/|$)/.test(server);
  if (retiredLinkedinProxy) {
    throw new Error(`PROXY_NOT_DEDICATED_ISP: retired_linkedin_proxy requested=${raw.slice(0, 80)} server=${server.slice(0, 80)} provider=${provider}`);
  }
  if (isUrlForm && !proxyType) {
    throw new Error('PROXY_NOT_DEDICATED_ISP: unclassified_url_proxy');
  }
  if (!proxyType) {
    throw new Error('PROXY_NOT_DEDICATED_ISP: missing_proxy_type');
  }
  if (proxyType && proxyType !== 'isp') {
    throw new Error(`PROXY_NOT_DEDICATED_ISP: proxy_type=${proxyType}`);
  }
  const rotatingGateway = /pr\.oxylabs\.io|geo\.iproyal\.com|brd\.superproxy\.io|packetstream|pingproxies|:7777|:12321|:22225/.test(server);
  const stickyCredential = /sessid-|_session-|[-_]session[-_]|_s_\d+/.test(username);
  if (rotatingGateway || stickyCredential) {
    throw new Error(`PROXY_NOT_DEDICATED_ISP: server=${server} username=${username.slice(0, 40)}`);
  }
}

