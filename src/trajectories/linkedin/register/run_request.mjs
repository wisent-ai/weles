/**
 * What the LinkedIn signup run was handed before it touched the form: the
 * request read out of the environment, the warm profile it is asked to replay,
 * and the browser fingerprint check that can call the whole run off before a
 * single account is spent.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { FP_SCRIPT } from '../../../../dist/diagnostics/fingerprint_probe.js';
import {
  NETWORK_FP_URL,
  parseNetworkFingerprint,
} from '../../../../dist/diagnostics/network/fingerprint.js';
import {
  analyze,
  pickBaseline,
} from '../../../../dist/diagnostics/fingerprint_analyzer.js';
import { runRecordingsDir } from '../../../../dist/session/run-recordings.js';
import { writeSubmitDiagnostics } from './diagnostics.mjs';
import { statedNumber, statedProxy } from '../../_shared/inputs/stated.mjs';
import { statedOnboardingProfile } from '../../_shared/linkedin/onboarding/work_school.mjs';

export const SIGNUP_URL = 'https://www.linkedin.com/signup';
export const DEFAULT_ENTRY_URL = SIGNUP_URL;
// The role and school the new account's profile shows: read with the request,
// so a run missing one is refused before any browser or account is spent.
export const ONBOARDING_PROFILE = statedOnboardingProfile();

/** Recording files are written indented by one tab, readable by a person. */
const JSON_INDENT = '\t';

// How many warning findings make the early fingerprint check quit before
// LinkedIn sees the account is the caller's to state: it trades a burned
// account against a skipped run, and only the operator weighs that. Any
// critical finding quits on its own. A check that cannot run is the run's
// failure with its cause; WELES_EARLY_FP=0 is the stated way to run without it.
export async function earlyFingerprintCheck(s) {
  if (process.env.WELES_EARLY_FP === '0') return null;
  const warningLimit = statedNumber(
    'WELES_EARLY_FP_WARNINGS',
    'the number of early fingerprint warnings at which the registration quits before LinkedIn',
  );
  const dir = runRecordingsDir('linkedin_register');
  mkdirSync(dir, { recursive: true });
  await s.goto('about:blank');
  const js = await s.page.evaluate(FP_SCRIPT);
  await s.page.goto(NETWORK_FP_URL, { waitUntil: 'domcontentloaded' });
  const raw = await s.page.evaluate(
    `document.body.innerText || document.body.textContent || ''`,
  );
  const network = parseNetworkFingerprint(raw);
  const payload = {
    capturedAt: new Date().toISOString(),
    source: 'weles-early',
    browser: s._browserProvenance ? s._browserProvenance.browser : null,
    js,
    network,
  };
  const baselineDir =
    process.env.WELES_BASELINE_DIR ||
    join(process.cwd(), 'recordings', 'baselines');
  if (!existsSync(baselineDir)) {
    throw new Error(
      `FINGERPRINT_UNCHECKED: no baseline directory ${baselineDir} (WELES_BASELINE_DIR) to compare the early fingerprint with; set WELES_EARLY_FP=0 to register without the check`,
    );
  }
  const { path: baselinePath, data: baseline } = pickBaseline(baselineDir, payload);
  const report = analyze(payload, baseline);
  report.meta.subjectPath = join(dir, 'early_fingerprint.json');
  report.meta.baselinePath = baselinePath;
  writeFileSync(report.meta.subjectPath, JSON.stringify(payload, null, JSON_INDENT));
  writeFileSync(
    join(dir, 'early_detection_report.json'),
    JSON.stringify(report, null, JSON_INDENT),
  );
  console.log(
    `[register] early fingerprint critical=${report.summary.critical} warning=${report.summary.warning} baseline=${baselinePath}`,
  );
  if (report.summary.critical || report.summary.warning >= warningLimit) {
    throw new Error(
      `FINGERPRINT_INCONSISTENT: early critical=${report.summary.critical} warning=${report.summary.warning} (limit ${warningLimit}) findings=${report.findings.map((f) => f.id).join(',')}`,
    );
  }
  return report;
}

/** The LinkedIn addresses a comma-separated variable lists; none when it is not set. */
function statedLinkedinUrls(name) {
  const value = process.env[name];
  if (value === undefined) return [];
  return value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => new URL(s, SIGNUP_URL).toString())
    .filter((url) => /(^|\.)linkedin\.com$/i.test(new URL(url).hostname));
}

/** The first of `names` set in the environment, or null when none is. */
function firstStated(...names) {
  for (const name of names) {
    const value = process.env[name];
    if (value) return value;
  }
  return null;
}

// Persona + identity + browser + OS + input rotation all centralized in
// WSession.start (platform: 'linkedin'). No browser/OS/input pin — rolls
// naturally like the keeper does.
export const requestedProxy = statedProxy(
  'the LinkedIn signup',
  'LINKEDIN_REGISTER_PROXY',
  'LINKEDIN_PROXY',
);
export const requestedEntryUrl =
  process.env.LINKEDIN_REGISTER_ENTRY_URL ?? DEFAULT_ENTRY_URL;
export const STOP_AFTER_SIGNUP_READY =
  process.env.LINKEDIN_REGISTER_STOP_AFTER_SIGNUP_READY === '1';
export const HEADLESS =
  process.env.HEADLESS === '1' ||
  process.env.WELES_HEADLESS === '1' ||
  process.env.LINKEDIN_REGISTER_HEADLESS === '1';

/**
 * The guest pages read before signup: the ones LINKEDIN_REGISTER_PREWARM_URLS
 * lists, or, when it lists none and LINKEDIN_REGISTER_DEFAULT_PREWARM is 1,
 * LinkedIn's home page and the signup page itself.
 */
function prewarmUrls() {
  const listed = statedLinkedinUrls('LINKEDIN_REGISTER_PREWARM_URLS');
  if (listed.length || process.env.LINKEDIN_REGISTER_DEFAULT_PREWARM !== '1') return listed;
  return [new URL('/', SIGNUP_URL).toString(), SIGNUP_URL];
}
export const guestPrewarmUrls = prewarmUrls();

/** The warm Chromium profile directory to replay, or null when the run states none. */
export const warmProfileDir = firstStated('LINKEDIN_REGISTER_WARM_PROFILE_DIR', 'WELES_USER_DATA_DIR');

// A warm profile without a manifest replays nothing. One whose manifest cannot
// be read or is not a warm-profile manifest is refused: read as none, the
// registration ran through a different proxy and persona than the profile was
// warmed with.
function loadWarmManifest(dir) {
  if (!dir) return null;
  const p = join(dir, 'warm_manifest.json');
  if (!existsSync(p)) return null;
  let raw;
  try {
    raw = JSON.parse(readFileSync(p, 'utf8'));
  } catch (cause) {
    throw new Error(
      `warm profile manifest ${p} cannot be read: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
  if (raw?.schema !== 'linkedin_register_warm_profile.v1') {
    throw new Error(
      `warm profile manifest ${p} is not a linkedin_register_warm_profile.v1 manifest`,
    );
  }
  return raw;
}
export const warmManifest = loadWarmManifest(warmProfileDir);
const replayProxyUrl = warmManifest?.proxy_replay?.url;
export const sessionProxy = replayProxyUrl || requestedProxy;

/** The persona the warm profile was made with, when its manifest states one. */
function warmPersona() {
  if (!warmManifest?.persona) return undefined;
  return warmManifest.persona;
}
export const registerPersona = warmPersona();

/**
 * The browser the run asks for: the stated one, the warm persona's, or
 * Chromium when a warm profile directory is replayed without either, since a
 * profile directory is Chromium's user-data format. Unstated otherwise, and
 * WSession rotates it.
 */
function registerBrowserOf() {
  const stated = firstStated('WELES_REGISTER_BROWSER');
  if (stated) return stated;
  if (registerPersona?.browser) return registerPersona.browser;
  if (warmProfileDir) return 'chromium';
  return undefined;
}
export const registerBrowser = registerBrowserOf();

/** The OS the run asks for: the stated one or the warm persona's; unstated otherwise, and WSession rotates it. */
function registerOsOf() {
  const stated = firstStated('WELES_REGISTER_OS');
  if (stated) return stated;
  if (registerPersona?.os) return registerPersona.os;
  return undefined;
}
export const registerOs = registerOsOf();

/** The proxy as it may be logged: a URL-form proxy carries credentials, so only its form is named. */
export function safeRequestedProxy(value) {
  const raw = String(value);
  return /^(https?:|socks)/i.test(raw) ? '[url-form]' : raw;
}

/** The proxy facts of a session as the diagnostics record them; absent fields stay absent. */
function sessionProxyFacts(proxyConfig) {
  if (!proxyConfig) return undefined;
  const { server, provider, proxy_type, country, exit_ip, sticky_session_id, sticky_hash } = proxyConfig;
  return { server, provider, proxy_type, country, exit_ip, sticky_session_id, sticky_hash };
}

export async function replayWarmProfile(s) {
  if (warmManifest?.proxy_metadata && s.proxyConfig) {
    Object.assign(
      s.proxyConfig,
      Object.fromEntries(
        Object.entries({
          exit_ip: warmManifest.proxy_metadata.exit_ip,
          provider: warmManifest.proxy_metadata.provider,
          proxy_type: warmManifest.proxy_metadata.proxy_type,
          country: warmManifest.proxy_metadata.country,
          platform: warmManifest.proxy_metadata.platform,
          sticky_session_id: warmManifest.proxy_metadata.sticky_session_id,
          sticky_hash: warmManifest.proxy_metadata.sticky_hash,
          exit_reputation: warmManifest.proxy_metadata.exit_reputation,
        }).filter(([, v]) => v !== null && v !== undefined && v !== ''),
      ),
    );
  }
  if (warmManifest) {
    await writeSubmitDiagnostics('warm_manifest_replay', {
      manifest_schema: warmManifest.schema,
      profile_dir: warmManifest.profile_dir,
      persona_replayed: Boolean(registerPersona),
      proxy_replayed: Boolean(replayProxyUrl),
      persona: registerPersona,
      proxy_metadata: warmManifest.proxy_metadata,
      session_proxy: sessionProxyFacts(s.proxyConfig),
    });
  }
}
