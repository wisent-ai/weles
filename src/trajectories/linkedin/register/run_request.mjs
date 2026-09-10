/**
 * What the LinkedIn signup run was handed before it touched the form: the
 * request read out of the environment, the warm profile it is asked to replay,
 * and the browser fingerprint check that can call the whole run off before a
 * single account is spent.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { FP_SCRIPT, NETWORK_FP_URL, parseNetworkFingerprint } from '../../../../dist/diagnostics/fingerprint_probe.js';
import { analyze, pickBaseline } from '../../../../dist/diagnostics/fingerprint_analyzer.js';
import { runRecordingsDir } from '../../../../dist/session/run-recordings.js';
import { writeSubmitDiagnostics } from './diagnostics.mjs';

export const SIGNUP_URL = 'https://www.linkedin.com/signup';
export const DEFAULT_ENTRY_URL = SIGNUP_URL;
// Default lowered to 10 so known persistent tells (e.g. screen.availTop,
// WebRTC local-IP leak) trigger an early quit instead of burning an account
// on LinkedIn. Operators can raise it once those signals are clean.
const EARLY_FP_RISK_THRESHOLD = Number(process.env.WELES_EARLY_FP_RISK ?? 10);

export async function earlyFingerprintCheck(s) {
  if (process.env.WELES_EARLY_FP === '0') return null;
  const dir = runRecordingsDir('linkedin_register');
  mkdirSync(dir, { recursive: true });
  try {
    await s.goto('about:blank');
    const js = await s.page.evaluate(FP_SCRIPT);
    await s.page.goto(NETWORK_FP_URL, { waitUntil: 'domcontentloaded' });
    const raw = await s.page.evaluate(`document.body.innerText || document.body.textContent || ''`);
    const network = parseNetworkFingerprint(raw);
    const payload = { capturedAt: new Date().toISOString(), source: 'weles-early', browser: s._browserProvenance?.browser ?? 'unknown', js, network };
    const baselineDir = process.env.WELES_BASELINE_DIR || join(process.cwd(), 'recordings', 'baselines');
    const selection = existsSync(baselineDir)
      ? pickBaseline(baselineDir, payload)
      : { path: '', data: {}, absent: 'no baseline directory on this host — the early report is scored without a recorded baseline' };
    if (selection.absent) console.log(`[register] early fingerprint baseline: ${selection.absent}`);
    const baseline = selection.data;
    const baselinePath = selection.path;
    const report = analyze(payload, baseline);
    report.meta.subjectPath = join(dir, 'early_fingerprint.json');
    report.meta.baselinePath = baselinePath;
    writeFileSync(report.meta.subjectPath, JSON.stringify(payload, null, 2));
    writeFileSync(join(dir, 'early_detection_report.json'), JSON.stringify(report, null, 2));
    console.log(`[register] early fingerprint risk=${report.summary.riskScore} critical=${report.summary.critical} baselineMatched=${report.meta.baselineMatched}`);
    if (report.summary.riskScore >= EARLY_FP_RISK_THRESHOLD || report.summary.critical > 0) {
      throw new Error(`FINGERPRINT_INCONSISTENT: early risk=${report.summary.riskScore} critical=${report.summary.critical} findings=${report.findings.map(f => f.id).join(',')}`);
    }
    return report;
  } catch (e) {
    if (String(e.message ?? e).startsWith('FINGERPRINT_INCONSISTENT')) throw e;
    console.log(`[register] early fingerprint check skipped: ${String(e).slice(0, 120)}`);
    return null;
  }
}

function parseLinkedinUrlList(value = '') {
  return String(value)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => new URL(s, 'https://www.linkedin.com/').toString())
    .filter((url) => /(^|\.)linkedin\.com$/i.test(new URL(url).hostname));
}

// Persona + identity + browser + OS + input rotation all centralized in
// WSession.start (platform: 'linkedin'). No browser/OS/input pin — rolls
// naturally like the keeper does.
export const requestedProxy = process.env.LINKEDIN_REGISTER_PROXY ?? process.env.LINKEDIN_PROXY ?? process.env.PROXY_URL ?? 'isp decodo us';
export const requestedEntryUrl = process.env.LINKEDIN_REGISTER_ENTRY_URL ?? DEFAULT_ENTRY_URL;
export const STOP_AFTER_SIGNUP_READY = process.env.LINKEDIN_REGISTER_STOP_AFTER_SIGNUP_READY === '1';
export const HEADLESS = process.env.HEADLESS === '1' || process.env.WELES_HEADLESS === '1' || process.env.LINKEDIN_REGISTER_HEADLESS === '1';
const envPrewarmUrls = parseLinkedinUrlList(process.env.LINKEDIN_REGISTER_PREWARM_URLS ?? '');
const defaultPrewarmUrls = process.env.LINKEDIN_REGISTER_DEFAULT_PREWARM === '1' && envPrewarmUrls.length === 0
  ? ['https://www.linkedin.com/', 'https://www.linkedin.com/signup']
  : [];
export const guestPrewarmUrls = [...envPrewarmUrls, ...defaultPrewarmUrls];
export const warmProfileDir = process.env.LINKEDIN_REGISTER_WARM_PROFILE_DIR || process.env.WELES_USER_DATA_DIR || '';
function loadWarmManifest(dir = '') {
  if (!dir) return null;
  try {
    const p = join(dir, 'warm_manifest.json');
    if (!existsSync(p)) return null;
    const raw = JSON.parse(readFileSync(p, 'utf8'));
    if (raw?.schema !== 'linkedin_register_warm_profile.v1') return null;
    return raw;
  } catch {
    return null;
  }
}
export const warmManifest = loadWarmManifest(warmProfileDir);
const replayProxyUrl = warmManifest?.proxy_replay?.url || '';
export const sessionProxy = replayProxyUrl || requestedProxy;
export const registerBrowser = process.env.WELES_REGISTER_BROWSER || warmManifest?.persona?.browser || (warmProfileDir ? 'chromium' : undefined);
export const registerOs = process.env.WELES_REGISTER_OS || warmManifest?.persona?.os || (warmProfileDir ? 'windows' : undefined);
export const registerPersona = warmManifest?.persona || undefined;
export function safeRequestedProxy(value = '') {
  const raw = String(value ?? '');
  return /^(https?:|socks)/i.test(raw) ? '[url-form]' : raw.slice(0, 80);
}

export async function replayWarmProfile(s) {
  if (warmManifest?.proxy_metadata && s.proxyConfig) {
    Object.assign(s.proxyConfig, Object.fromEntries(Object.entries({
      exit_ip: warmManifest.proxy_metadata.exit_ip,
      provider: warmManifest.proxy_metadata.provider,
      proxy_type: warmManifest.proxy_metadata.proxy_type,
      country: warmManifest.proxy_metadata.country,
      platform: warmManifest.proxy_metadata.platform,
      sticky_session_id: warmManifest.proxy_metadata.sticky_session_id,
      sticky_hash: warmManifest.proxy_metadata.sticky_hash,
      exit_reputation: warmManifest.proxy_metadata.exit_reputation,
    }).filter(([, v]) => v !== null && v !== undefined && v !== '')));
  }
  if (warmManifest) {
    await writeSubmitDiagnostics('warm_manifest_replay', {
      manifest_schema: warmManifest.schema,
      profile_dir: warmManifest.profile_dir,
      persona_replayed: Boolean(registerPersona),
      proxy_replayed: Boolean(replayProxyUrl),
      persona: registerPersona,
      proxy_metadata: warmManifest.proxy_metadata ?? null,
      session_proxy: {
        server: s.proxyConfig?.server ?? null,
        provider: s.proxyConfig?.provider ?? null,
        proxy_type: s.proxyConfig?.proxy_type ?? null,
        country: s.proxyConfig?.country ?? null,
        exit_ip: s.proxyConfig?.exit_ip ?? null,
        sticky_session_id: s.proxyConfig?.sticky_session_id ?? null,
        sticky_hash: s.proxyConfig?.sticky_hash ?? null,
      },
    });
  }
}
