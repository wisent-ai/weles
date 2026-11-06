/**
 * session_meta.json — the per-run provenance envelope, written once before
 * the browser exists (so a pre-launch failure still leaves a queryable row)
 * and once more with the realized values after launch. The per-step
 * screenshots and DOM dumps are recorded by run-provenance/step-artifacts.ts.
 */

import { writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type { Persona, PersonaDevice } from '../../browser/persona.js';
import type { Identity } from '../../utils/identity/identity.js';
import type { ExitReputation } from '../../proxy/quality/exit_geography.js';
import { environmentNames } from '../../utils/sanitize-env.js';
import { recordingsDir } from '../run-recordings.js';
import type { SessionProxy } from './session-request.js';

/** The indentation of the JSON records a person reads beside the recordings. */
export const JSON_INDENT = '  ';

// resolveProxy attaches pool bookkeeping (provider, sticky ids, exit
// reputation) beyond the launch-option shape async_api declares, and the
// exit-IP probe fills exit_ip in place after launch. This is the provenance
// view of that same object; the fields are read, never required.
interface ProxyProvenanceView {
  server?: string;
  username?: string;
  exit_ip?: string;
  platform?: string;
  provider?: string;
  sticky_session_id?: string;
  sticky_hash?: string;
  exit_reputation?: ExitReputation;
}

// G2: effective behavior-changing env vars snapshotted at session start. The
// list is intentionally generous — any flag that alters input path, browser
// selection/registration, instrumentation, recording, diagnostics, LinkedIn
// egress policy, or proxy-pool wiring. Reads process.env directly so the value
// reflects the live process at session start; unset flags surface as undefined.
const ENV_FLAG_KEYS = [
  'WELES_INPUT',
  'WELES_INSTANT_INPUT',
  'WELES_REGISTER_BROWSER',
  'WELES_ENABLE_CHROME147_STUBS',
  'WELES_DISABLE_HTTP2',
  'WELES_NO_INSTRUMENT',
  'WELES_FULL_DIAGNOSTICS',
  'WELES_PCAP_DIAGNOSTICS',
  'WELES_DISABLE_RECORDING',
  'WELES_ALLOW_LINKEDIN_DIRECT',
  'WELES_ALLOW_LINKEDIN_RESIDENTIAL',
  'WELES_ALLOW_LINKEDIN_UNDECLARED_PROXY',
  'LINKEDIN_REGISTER_PREWARM_URLS',
  'DECODO_ISP_PORTS',
  'DECODO_ISP_PORT',
  'DECODO_ISP_HOST',
  'WELES_FORCE_PROXY',
  'WELES_CAPTURE_RESPONSE_BODIES',
  'WELES_HOST_DIAGNOSTICS',
  'WELES_STORAGE_DIAGNOSTICS',
  'WELES_CDP_DIAGNOSTICS',
  'WELES_CDP_FIREHOSE',
  'WELES_CHROMIUM_NETLOG',
  'WELES_PROXY_DIAGNOSTICS_LABEL',
  'WELES_NOPECHA_EXT',
  'WELES_USER_DATA_DIR',
  'WELES_BROWSER_PROFILE_ROOT',
  'WELES_CACHE_DIR',
  'WELES_CHROMIUM_PROFILE_DIRECTORY',
  'WELES_PERSONA_COUNTRY',
  'WELES_USE_NATIVE_KEYCHAIN',
] as const;
export function snapshotEnvFlags(): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const k of ENV_FLAG_KEYS) out[k] = process.env[k];
  return out;
}

/** The SHA-256 digest of a diagnostic value, so logs correlate it without carrying it; null for no value. */
export function hashDiagnosticValue(value: unknown): string | null {
  if (typeof value !== 'string' || !value) return null;
  return createHash('sha256').update(value).digest('hex');
}

/** What a session records before its browser is up: the sampled device, or the stated persona. */
export interface SessionMetaRequest {
  label: string;
  persona: PersonaDevice;
  proxy: SessionProxy | undefined;
  proxyRequested: unknown;
  timingSeed: number;
}

export interface RealizedSessionMeta extends SessionMetaRequest {
  persona: Persona;
  realizedFingerprint: Record<string, unknown>;
  browserProvenance: unknown;
  identity: Identity | undefined;
}

export type StepPhase = 'before' | 'after' | 'error';

/** An artifact a step was supposed to leave behind, and why it is missing. */
export interface StepArtifactFailure {
  step: string;
  phase: StepPhase;
  artifact: 'screenshot' | 'dom';
  reason: string;
  at: string;
}

/** Where session_meta.json goes: the worker's ACTION directory, else the session label's. */
function metaPath(label: string): string {
  return join(recordingsDir(process.env.ACTION || label), 'session_meta.json');
}

// G19: shared per-run provenance writer — called EARLY (pre-launch) and again
// AFTER launch with the realized values. The early call guarantees that a
// pre-launch failure (proxy_unavailable, missing browser binary, launch
// crash) still leaves queryable provenance — persona, the proxy request and
// its resolution, the env snapshot, timing seed — instead of a black-hole row
// the diagnostics platform can't explain. realized_fingerprint / exit_ip /
// identity are null until the browser is up; the late call fills them in.
// Both writers keep the same key set so early and late writes can't drift on
// the keys the worker importer reads. session_meta lands in the ACTION dir
// (poll.ts imports + uploads from there), or under label for standalone runs.
export function writePrelaunchSessionMeta(request: SessionMetaRequest): void {
  if (!request.label) return;
  try {
    const proxyObj = request.proxy as ProxyProvenanceView | undefined;
    const pu = proxyObj?.server ? new URL(proxyObj.server) : null;
    const meta = {
      proxy_host: pu?.hostname,
      proxy_port: pu?.port,
      proxy_user_present: !!proxyObj?.username,
      proxy_user_hash: hashDiagnosticValue(proxyObj?.username),
      exit_ip: proxyObj?.exit_ip,
      platform: proxyObj?.platform,
      provider: proxyObj?.provider,
      browser_provenance: null,
      persona: request.persona,
      realized_fingerprint: null,
      proxy_requested: request.proxyRequested,
      env_flags: snapshotEnvFlags(),
      env_names: environmentNames(),
      sticky_session_id: proxyObj?.sticky_session_id,
      sticky_hash: proxyObj?.sticky_hash,
      exit_reputation: proxyObj?.exit_reputation,
      identity: undefined,
      timing_seed: request.timingSeed,
      started_at: new Date().toISOString(),
    };
    writeFileSync(
      metaPath(request.label),
      JSON.stringify(meta, null, JSON_INDENT),
    );
  } catch (error) {
    // The run goes on without it, but a missing session_meta.json makes the
    // importer report meta_missing; the cause is said here so that is explained.
    console.error(
      `[run-provenance] prelaunch session_meta.json for ${process.env.ACTION || request.label} was not written: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

// G14: write provenance for EVERY labelled run, proxied or not; proxy-derived
// fields are optional.
export function writeRealizedSessionMeta(realized: RealizedSessionMeta): void {
  if (!realized.label) return;
  try {
    const proxyObj = realized.proxy as ProxyProvenanceView | undefined;
    const u = proxyObj?.server ? new URL(proxyObj.server) : null;
    // Full per-run fingerprint provenance (G1): the randomized source
    // persona AND the realized fingerprint actually presented (UA, full
    // UA-CH brand list, navigator/screen/webgl), copied verbatim into
    // account_action_logs.result.session by the worker importer.
    // persona + realized_fingerprint are typed REQUIRED + non-null so a
    // future edit cannot silently drop them to null: persona is always
    // dressed, and async_api always attaches a realized fingerprint.
    const meta: {
      proxy_host?: string;
      proxy_port?: string;
      proxy_user_present: boolean;
      proxy_user_hash: unknown;
      exit_ip: unknown;
      platform: unknown;
      provider: unknown;
      browser_provenance: unknown;
      persona: Persona;
      realized_fingerprint: Record<string, unknown>;
      proxy_requested: unknown;
      env_flags: Record<string, string | undefined>;
      env_names: string[];
      sticky_session_id?: string;
      sticky_hash?: string;
      exit_reputation?: ExitReputation;
      identity?: Identity;
      timing_seed: number;
      started_at: string;
    } = {
      proxy_host: u?.hostname,
      proxy_port: u?.port,
      proxy_user_present: !!proxyObj?.username,
      proxy_user_hash: hashDiagnosticValue(proxyObj?.username),
      exit_ip: proxyObj?.exit_ip,
      platform: proxyObj?.platform,
      provider: proxyObj?.provider,
      browser_provenance: realized.browserProvenance,
      persona: realized.persona,
      realized_fingerprint: realized.realizedFingerprint,
      proxy_requested: realized.proxyRequested,
      // G2: snapshot the effective behavior-changing env vars at session
      // start so a run's exact mode (input path, browser registration,
      // diagnostics, LinkedIn egress policy, proxy pool wiring) is queryable.
      // Required Record (never null); individual flags are undefined when
      // unset — that absence is itself meaningful provenance.
      env_flags: snapshotEnvFlags(),
      // G15: the names of every runner env variable, never their values.
      env_names: environmentNames(),
      // G4: which sticky exit this session pinned to. Undefined for
      // non-sticky / url-form proxies (legitimately — only sticky-capable
      // providers populate it), so it is NOT forced non-null.
      sticky_session_id: proxyObj?.sticky_session_id,
      sticky_hash: proxyObj?.sticky_hash,
      // G11: full ip-api enrichment of the winning exit IP (ASN, ISP/org,
      // reverse-DNS, region/city/geo, proxy/hosting/mobile flags). Optional
      // — ip-api can fail or the run may have no exit IP.
      exit_reputation: proxyObj?.exit_reputation,
      // G6: full raw generated identity (first/last/username/email/password/
      // DOB) for EVERY run that has one — not just register. Raw values in
      // the row are explicitly approved. Present whenever a platform was
      // given (ws.identity is generated then); session_meta.json doubles as
      // the storage backup for non-register runs that never call saveAccount.
      identity: realized.identity,
      // Per-run human-timing seed (required): the run's pointer-trace and
      // typing choices are reproducible from the row.
      timing_seed: realized.timingSeed,
      started_at: new Date().toISOString(),
    };
    // G12: provenance goes into the worker's ACTION dir (set by poll.ts on
    // every spawned trajectory) so it lands where poll.ts imports + uploads
    // from — even when this WSession's label differs from the dispatch action
    // (health _in/_out, register _<attempt>, reddit submit, ticker scrapers).
    writeFileSync(
      metaPath(realized.label),
      JSON.stringify(meta, null, JSON_INDENT),
    );
  } catch (error) {
    console.error(
      `[run-provenance] realized session_meta.json for ${process.env.ACTION || realized.label} was not written: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
