#!/usr/bin/env node
// Browser-side proxy/leak audit. This intentionally does not touch LinkedIn.
//
// Usage:
//   npm run build
//   node scripts/debug/browser_proxy_leak_audit.mjs "$LINKEDIN_REGISTER_PROXY"
//
// Optional env:
//   LINKEDIN_PROXY_COUNTRY=US
//   WELES_EXPECTED_TIMEZONE=America/New_York
//   WELES_EXPECTED_LANGUAGE=en-US

import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { WSession } from '../../dist/session/wsession.js';
import { generatePersona } from '../../dist/browser/persona.js';
import { resolveProxy } from '../../dist/proxy/config.js';
import { auditProxyQuality } from '../../dist/proxy/quality.js';

const OUT_DIR = 'recordings/audits';
const LABEL = 'browser_proxy_leak_audit';

const cliProxySpec = process.argv.slice(2).find((arg) => !String(arg).startsWith('-'));
const proxySpec = cliProxySpec
  ?? process.env.LINKEDIN_REGISTER_PROXY
  ?? process.env.WELES_LINKEDIN_PROXY
  ?? process.env.PROXY_URL
  ?? 'direct';
const exactLinkedinProxyRequired = process.env.WELES_BROWSER_PROXY_AUDIT_ALLOW_DIRECT !== '1';

const expected = {
  country: process.env.LINKEDIN_PROXY_COUNTRY ?? process.env.WELES_PROXY_COUNTRY ?? undefined,
  timezone: process.env.WELES_EXPECTED_TIMEZONE ?? undefined,
  language: process.env.WELES_EXPECTED_LANGUAGE ?? undefined,
};

function hashValue(value) {
  if (!value) return null;
  return createHash('sha256').update(String(value)).digest('hex').slice(0, 16);
}

function redactIp(ip) {
  if (!ip) return null;
  return { hash: hashValue(ip), family: ip.includes(':') ? 'ipv6' : 'ipv4' };
}

function redactUrl(raw) {
  if (!raw) return raw;
  try {
    const u = new URL(raw);
    u.username = '';
    u.password = '';
    return u.toString();
  } catch {
    return String(raw).replace(/\/\/[^@/]*@/, '//');
  }
}

function proxySummary(proxy) {
  if (!proxy) return null;
  let host = null;
  let port = null;
  let protocol = null;
  try {
    const u = new URL(proxy.server);
    host = u.hostname;
    port = u.port ? Number(u.port) : null;
    protocol = u.protocol.replace(/:$/, '');
  } catch {
    host = proxy.server;
  }
  const sticky = `${proxy.username ?? ''} ${proxy.password ?? ''}`.match(/(?:sessid-|session-|_s_)([A-Za-z0-9_-]+)/i)?.[1];
  const endpoint = host ? `${protocol ?? 'unknown'}://${host}${port ? `:${port}` : ''}` : null;
  const ref = [endpoint ?? proxy.server, proxy.username ?? '', proxy.password ?? ''].join('|');
  return {
    server: redactUrl(proxy.server),
    protocol,
    host,
    port,
    has_auth: !!(proxy.username || proxy.password),
    ref_hash: hashValue(ref),
    endpoint_hash: hashValue(endpoint),
    username_hash: hashValue(proxy.username),
    password_hash: hashValue(proxy.password),
    sticky_id_hash: hashValue(sticky),
  };
}

async function browserIpProbe(page, url, name) {
  const started = Date.now();
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    const text = await page.evaluate(`document.body.innerText || document.body.textContent || ''`);
    const parsed = JSON.parse(text);
    const ip = typeof parsed.ip === 'string' ? parsed.ip : null;
    return {
      name,
      ok: !!ip,
      url: new URL(url).host,
      ip: redactIp(ip),
      ip_hash: hashValue(ip),
      family: ip?.includes(':') ? 'ipv6' : 'ipv4',
      duration_ms: Date.now() - started,
    };
  } catch (e) {
    return {
      name,
      ok: false,
      url: new URL(url).host,
      error: String(e?.message ?? e).slice(0, 200),
      duration_ms: Date.now() - started,
    };
  }
}

async function collectWebrtcCandidates(page) {
  await page.goto('about:blank', { waitUntil: 'domcontentloaded', timeout: 10_000 }).catch(() => {});
  await page.setContent?.('<!doctype html><title>weles proxy leak audit</title><body>weles proxy leak audit</body>').catch(async () => {
    await page.goto('data:text/html,<title>weles proxy leak audit</title><body>weles proxy leak audit</body>', {
      waitUntil: 'domcontentloaded',
      timeout: 10_000,
    }).catch(() => {});
  });
  return await page.evaluate(`async () => {
    const out = {
      supported: typeof RTCPeerConnection !== 'undefined',
      candidates: [],
      errors: [],
    };
    if (!out.supported) return out;
    const parse = (candidate) => {
      const parts = String(candidate || '').split(/\\s+/);
      const typIdx = parts.indexOf('typ');
      return {
        raw: String(candidate || '').slice(0, 300),
        protocol: parts[2] || null,
        address: parts[4] || null,
        port: parts[5] || null,
        type: typIdx >= 0 ? parts[typIdx + 1] || null : null,
        tcpType: parts.includes('tcptype') ? parts[parts.indexOf('tcptype') + 1] || null : null,
      };
    };
    try {
      const pc = new RTCPeerConnection({ iceServers: [{ urls: ['stun:stun.l.google.com:19302', 'stun:global.stun.twilio.com:3478'] }] });
      pc.createDataChannel('audit');
      pc.onicecandidate = (event) => {
        if (event.candidate?.candidate) out.candidates.push(parse(event.candidate.candidate));
      };
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 5000);
        pc.onicegatheringstatechange = () => {
          if (pc.iceGatheringState === 'complete') {
            clearTimeout(timer);
            resolve();
          }
        };
      });
      pc.close();
    } catch (e) {
      out.errors.push(String(e && e.message || e).slice(0, 200));
    }
    return out;
  }`);
}

function classifyAddress(address) {
  if (!address) return { class: 'missing', redacted: null };
  if (/\.local$/i.test(address)) return { class: 'mdns_local', redacted: '<mdns.local>' };
  if (/^(10\.|192\.168\.|172\.(1[6-9]|2\\d|3[01])\.)/.test(address)) return { class: 'private_ipv4', redacted: '<private_ipv4>' };
  if (/^(127\.|0\.0\.0\.0)/.test(address)) return { class: 'loopback_ipv4', redacted: '<loopback_ipv4>' };
  if (/^f[cd][0-9a-f]{2}:/i.test(address) || /^fe80:/i.test(address)) return { class: 'private_ipv6', redacted: '<private_ipv6>' };
  if (/^[0-9a-f:.]+$/i.test(address) && address.includes(':')) return { class: 'public_ipv6', redacted: redactIp(address) };
  if (/^\d+\.\d+\.\d+\.\d+$/.test(address)) return { class: 'public_ipv4', redacted: redactIp(address) };
  return { class: 'unknown', redacted: hashValue(address) };
}

function summarizeWebrtc(raw, nodeQuality, browserExitHashes) {
  const candidates = Array.isArray(raw?.candidates) ? raw.candidates : [];
  const publicCandidates = [];
  const summarized = candidates.map((c) => {
    const classified = classifyAddress(c.address);
    if (classified.class.startsWith('public_')) publicCandidates.push({ ...c, classified });
    return {
      type: c.type,
      protocol: c.protocol,
      tcpType: c.tcpType,
      address_class: classified.class,
      address: classified.redacted,
      port_present: !!c.port,
    };
  });
  const directHash = hashValue(nodeQuality?.direct_ip_probe?.ip);
  const exitHash = hashValue(nodeQuality?.exit_ip_probe?.ip);
  const publicHashes = publicCandidates.map((c) => hashValue(c.address)).filter(Boolean);
  return {
    supported: !!raw?.supported,
    error_count: Array.isArray(raw?.errors) ? raw.errors.length : 0,
    errors: raw?.errors ?? [],
    candidate_count: candidates.length,
    candidates: summarized,
    public_candidate_hashes: [...new Set(publicHashes)],
    public_candidate_matches_browser_exit: publicHashes.some((h) => browserExitHashes.includes(h)),
    public_candidate_matches_node_proxy_exit: !!exitHash && publicHashes.includes(exitHash),
    public_candidate_matches_node_direct_ip: !!directHash && publicHashes.includes(directHash),
    has_private_or_mdns_candidates: summarized.some((c) => ['private_ipv4', 'private_ipv6', 'mdns_local'].includes(c.address_class)),
  };
}

function riskLabels({ nodeQuality, browserIp, webrtc, proxyConfigured }) {
  const risks = [];
  const browserHashes = browserIp.probes.filter((p) => p.ok && p.ip_hash).map((p) => p.ip_hash);
  const directHash = hashValue(nodeQuality?.direct_ip_probe?.ip);
  const exitHash = hashValue(nodeQuality?.exit_ip_probe?.ip);
  if (exactLinkedinProxyRequired && !proxyConfigured) risks.push('exact_linkedin_proxy_not_configured');
  if (proxyConfigured && browserHashes.includes(directHash)) risks.push('browser_uses_direct_ip');
  if (proxyConfigured && exitHash && !browserHashes.includes(exitHash)) risks.push('browser_exit_differs_from_node_proxy_exit');
  if (proxyConfigured && nodeQuality?.direct_equals_exit) risks.push('node_direct_equals_proxy_exit');
  if (browserIp.ipv6_available && browserIp.ipv4_hash && browserIp.ipv6_hash && browserIp.ipv4_hash !== browserIp.ipv6_hash) risks.push('browser_ipv4_ipv6_exit_split');
  if (webrtc.public_candidate_matches_node_direct_ip && proxyConfigured) risks.push('webrtc_direct_ip_leak');
  if (webrtc.public_candidate_hashes.length > 0 && !webrtc.public_candidate_matches_browser_exit && !webrtc.public_candidate_matches_node_proxy_exit) risks.push('webrtc_unexpected_public_candidate');
  if (nodeQuality?.inferred_ip_class === 'datacenter') risks.push('datacenter_ip_class');
  if (nodeQuality?.coherence?.country_matches_expected === false) risks.push('country_mismatch');
  if (nodeQuality?.coherence?.timezone_matches_expected === false) risks.push('timezone_mismatch');
  return [...new Set(risks)];
}

const proxy = await resolveProxy(proxySpec);
const proxyConfigured = proxySpec !== 'direct' && !!proxy;
const nodeQuality = await auditProxyQuality(proxy, expected);
const persona = generatePersona({
  country: expected.country ?? 'US',
  os: 'macos',
  browser: 'chromium',
});

let browserIp;
let webrtc;
let sessionMeta = null;
const s = await WSession.start({
  label: LABEL,
  proxy: proxySpec,
  persona,
  injectStorage: false,
  record: false,
  passkeyStub: false,
  arkoseCapture: false,
  authFetchCapture: false,
  codecShim: false,
  pageInstrumentation: false,
  completeNetworkCapture: false,
});
try {
  const probes = [
    await browserIpProbe(s.page, 'https://api.ipify.org?format=json', 'browser_ipv4'),
    await browserIpProbe(s.page, 'https://api64.ipify.org?format=json', 'browser_auto_v4_or_v6'),
    await browserIpProbe(s.page, 'https://api6.ipify.org?format=json', 'browser_ipv6_only'),
  ];
  const ipv4 = probes.find((p) => p.name === 'browser_ipv4' && p.ok);
  const ipv6 = probes.find((p) => p.name === 'browser_ipv6_only' && p.ok);
  browserIp = {
    probes,
    ipv4_hash: ipv4?.ip_hash ?? null,
    ipv6_hash: ipv6?.ip_hash ?? null,
    ipv6_available: !!ipv6,
  };
  const rawWebrtc = await collectWebrtcCandidates(s.page);
  const browserExitHashes = probes.filter((p) => p.ok && p.ip_hash).map((p) => p.ip_hash);
  webrtc = summarizeWebrtc(rawWebrtc, nodeQuality, browserExitHashes);
  sessionMeta = s.sessionMeta ?? null;
} finally {
  await s.close();
}

const report = {
  generated_at: new Date().toISOString(),
  scope: 'Browser-side proxy/IP/WebRTC leak audit; does not touch LinkedIn',
  proxy_spec: proxySpec.startsWith('http') ? '<url>' : proxySpec,
  exact_linkedin_proxy_required: exactLinkedinProxyRequired,
  proxy: proxySummary(proxy),
  expected,
  persona: {
    os: persona.os,
    browser: persona.browser,
    language: persona.language,
    timezone: persona.timezone,
    platform: persona.platform,
    screen: persona.screen,
    gpu: persona.gpu,
  },
  node_proxy_quality: {
    exit_ip: redactIp(nodeQuality?.exit_ip_probe?.ip),
    direct_ip: redactIp(nodeQuality?.direct_ip_probe?.ip),
    direct_equals_exit: nodeQuality?.direct_equals_exit ?? null,
    inferred_ip_class: nodeQuality?.inferred_ip_class ?? null,
    country_code: nodeQuality?.coherence?.country_code ?? null,
    timezone_id: nodeQuality?.coherence?.timezone_id ?? null,
    coherence: nodeQuality?.coherence ?? null,
    proxy_summary: nodeQuality?.proxy ?? null,
  },
  browser_ip: browserIp,
  webrtc,
  session_meta_available: !!sessionMeta,
  session_meta_summary: sessionMeta ? {
    browser_visible_diagnostics: sessionMeta.browser_visible_diagnostics ?? null,
    storage_policy: sessionMeta.storage_policy ?? null,
    complete_network_capture: sessionMeta.complete_network_capture ?? null,
    startup_fingerprint_probe_present: !!sessionMeta.startup_fingerprint_probe,
  } : null,
};
report.risk_labels = riskLabels({ nodeQuality, browserIp, webrtc, proxyConfigured });
const browserUsesProxyExit = proxyConfigured
  ? !!hashValue(nodeQuality?.exit_ip_probe?.ip) && browserIp.probes.some((p) => p.ip_hash === hashValue(nodeQuality?.exit_ip_probe?.ip))
  : null;
const browserUsesDirectIp = proxyConfigured
  ? !!hashValue(nodeQuality?.direct_ip_probe?.ip) && browserIp.probes.some((p) => p.ip_hash === hashValue(nodeQuality?.direct_ip_probe?.ip))
  : null;
report.linkedin_relevance = {
  exact_linkedin_proxy_proved: proxyConfigured
    && browserUsesProxyExit === true
    && browserUsesDirectIp !== true
    && !report.risk_labels.includes('browser_exit_differs_from_node_proxy_exit'),
  browser_uses_proxy_exit: browserUsesProxyExit,
  browser_uses_direct_ip: browserUsesDirectIp,
  webrtc_direct_ip_leak: report.risk_labels.includes('webrtc_direct_ip_leak'),
  ipv6_split: report.risk_labels.includes('browser_ipv4_ipv6_exit_split'),
  sticky_id_hash: proxySummary(proxy)?.sticky_id_hash ?? null,
};

mkdirSync(OUT_DIR, { recursive: true });
const outPath = join(OUT_DIR, `browser_proxy_leak_audit_${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
writeFileSync(outPath, JSON.stringify(report, null, 2));
console.log(JSON.stringify({
  outPath,
  proxy_spec: report.proxy_spec,
  browser_probe_ok: report.browser_ip.probes.map((p) => ({ name: p.name, ok: p.ok, family: p.family ?? null, error: p.error ?? null })),
  webrtc_candidate_count: report.webrtc.candidate_count,
  risk_labels: report.risk_labels,
}, null, 2));
