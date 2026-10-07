import { updateAccountMetadata } from '../skarbiec/accounts.mjs';

/**
 * Cookie-jar freshness gate — second line of defense after auth-probe.mjs.
 *
 * Stored cookies alone do not prove an authenticated session. Providers can
 * bind them to the device and connection that established the session and
 * return a logged-out shell without redirecting.
 *
 *   auth-probe.mjs catches the symptom (no authed DOM marker visible).
 *   This module catches what can be known before injecting: a jar no
 *   verified login minted, or one minted under another proxy or persona,
 *   is not injected; we mark cookies stale and exit, which the routine
 *   layer turns into a fresh form-login enqueue on the next tick. How long
 *   a platform honours a session is the platform's: expired cookies are
 *   dropped by the browser itself and a revoked session is what
 *   auth-probe.mjs observes. The per-platform age windows (6 h to 7 d)
 *   once here were nobody's statement.
 *
 * Two functions:
 *   - persistFreshCookieJar(acct, cookies)
 *       Called by *_login.mjs trajectories AFTER assertAuthed has confirmed
 *       the form login produced a real authed session. Stamps
 *       metadata.cookies + metadata.cookies_minted_at so downstream actions
 *       know the jar is "freshly minted by a verified login". This is the
 *       ONLY place cookies_minted_at should be written outside of
 *       WSession.saveAccount (register flow) — no in-trajectory cookie
 *       refresh shortcuts.
 *
 *   - loadFreshCookieJarOrFail(acct, { platform, label })
 *       Called by every action trajectory before injecting cookies. Throws
 *       CookieJarStaleError if:
 *         (a) metadata.cookies is empty / missing
 *         (b) metadata.cookies_minted_at is missing or not a timestamp (the
 *             jar was not stamped by a verified login)
 *         (c) the jar was minted under a different proxy or persona
 *       Returns the cookie array on success.
 */

export class CookieJarStaleError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'CookieJarStaleError';
    this.details = details;
  }
}

/**
 * Reduce a proxy descriptor to a stable signature suitable for binding a
 * cookie jar to its minting egress identity. We deliberately keep this
 * coarse — host+port — because:
 *   - residential providers rotate session usernames + sometimes IPs
 *     within a sticky window; we don't want to invalidate the jar on a
 *     normal rotation
 *   - host+port pins the provider + entry point, which is the level at
 *     which platforms appear to bind sessions in practice
 * Accepts either a ProxyConfig-shaped object ({ host, port, ... }) or a
 * proxy URL string. Returns 'direct' when no proxy is in play.
 */
// Map a proxy username to its provider name. The host can vary across
// CONNECTs to the same provider (oxylabs DNS-resolves pr.oxylabs.io to
// many gateway IPs and the selector picks one at random per call -- see
// src/proxy/config.ts:207-220) so a host-only signature spuriously
// flips between two valid oxylabs sessions and trips
// cookie_jar_proxy_mismatch on every consecutive action. Username keeps
// the provider stable.
const USER_PROVIDER_RE = [
  [/^customer-.*-cc-[a-z]{2}-sessid-\d+/i, 'oxylabs'],
  [/^brd-customer-/i, 'brightdata'],
  [/_c_[a-z]{2}_s_\d+/i, 'pingproxies'],
];
function providerFromUser(user) {
  if (!user) return null;
  for (const [re, name] of USER_PROVIDER_RE) if (re.test(user)) return name;
  return null;
}

export function proxySignature(proxyOrUrl) {
  if (!proxyOrUrl) return 'direct';
  // ProxyConfig shape
  if (typeof proxyOrUrl === 'object' && proxyOrUrl.host) {
    const port = proxyOrUrl.port ? String(proxyOrUrl.port) : '';
    const prov = providerFromUser(proxyOrUrl.username);
    if (prov) return `${prov}:${port}`.replace(/:$/, '');
    return `${proxyOrUrl.host}:${port}`.replace(/:$/, '');
  }
  // URL string shape ("http://user:pass@host:port")
  if (typeof proxyOrUrl === 'string') {
    try {
      const u = new URL(proxyOrUrl);
      const prov = providerFromUser(u.username ? decodeURIComponent(u.username) : '');
      if (prov) return `${prov}:${u.port || ''}`.replace(/:$/, '');
      return `${u.hostname}:${u.port || ''}`.replace(/:$/, '');
    } catch { return 'direct'; }
  }
  return 'direct';
}

/**
 * Stable per-persona id. Persona objects don't carry an explicit id; we
 * derive one from canvasSeed which is random per generated persona and
 * persisted in metadata.persona. Two different sessions with the same
 * canvasSeed are treated as the same identity.
 */
export function personaSignature(persona) {
  if (!persona) return null;
  if (persona.canvasSeed != null) return `cs:${persona.canvasSeed}`;
  // Fallback: hash a few stable fields. Cheap djb2.
  const s = `${persona.userAgentOs ?? ''}|${persona.gpu?.renderer ?? ''}|${persona.timezone ?? ''}|${persona.language ?? ''}`;
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return `h:${h}`;
}

/**
 * Validate that the stored cookie jar was minted by a verified login AND
 * under the same proxy + persona that's about to inject it. Returns the
 * cookie array on success; throws CookieJarStaleError otherwise.
 *
 * Optional context fields:
 *   currentProxyUrl  — pass the resolveAccountSession result so we can
 *                      compare the stored cookies_minted_proxy stamp.
 *                      Mismatch ⇒ jar bound to a different egress IP, fail.
 *   currentPersona   — same idea for persona; mismatch ⇒ different
 *                      device fingerprint than was registered, fail.
 *   skipBindingCheck — escape hatch for the rare trajectory that legitimately
 *                      runs without a session context (debug, probes).
 *                      Default false.
 */
export function loadFreshCookieJarOrFail(acct, { platform, label, currentProxyUrl, currentPersona, skipBindingCheck = false }) {
  const cookies = Array.isArray(acct?.metadata?.cookies) ? acct.metadata.cookies : null;
  if (!cookies || cookies.length === 0) {
    throw new CookieJarStaleError(`cookie_jar_empty: no cookies stored for ${platform}/${acct?.username ?? '?'} — login required`, {
      platform, label, reason: 'empty', account_id: acct?.id ?? null,
    });
  }
  const mintedAtRaw = acct?.metadata?.cookies_minted_at;
  if (!mintedAtRaw) {
    throw new CookieJarStaleError(`cookie_jar_unstamped: no cookies_minted_at — jar predates freshness regime, login required`, {
      platform, label, reason: 'no_minted_at', account_id: acct?.id ?? null,
    });
  }
  const mintedMs = Date.parse(mintedAtRaw);
  if (!Number.isFinite(mintedMs)) {
    throw new CookieJarStaleError(`cookie_jar_bad_mint_ts: cookies_minted_at=${mintedAtRaw} not a valid ISO ts — login required`, {
      platform, label, reason: 'bad_minted_at', mintedAtRaw, account_id: acct?.id ?? null,
    });
  }
  // --- Proxy + persona binding checks ---
  // If the jar was minted under a different proxy or persona than the one
  // about to inject it, the platform's server-side session binding will
  // reject the replay (exact failure mode: TikTok serves logged-out shell,
  // no URL bounce). Skip check when explicitly disabled or when no context
  // is available (browse trajectories, debug probes).
  if (!skipBindingCheck) {
    const storedProxy = acct?.metadata?.cookies_minted_proxy ?? null;
    const storedPersona = acct?.metadata?.cookies_minted_persona ?? null;

    if (storedProxy && currentProxyUrl) {
      // cookies_minted_proxy is stored as a pre-resolved signature string
      // (e.g. "gate.oxylabs.io:1234"), NOT a URL or ProxyConfig object.
      const storedSig = typeof storedProxy === 'string' && !storedProxy.includes('://') ? storedProxy : proxySignature(storedProxy);
      const currentSig = proxySignature(currentProxyUrl);
      // Legacy sigs are "<ip>:<port>", new sigs are "<provider>:<port>" --
      // tolerate the migration when ports match (next login overwrites it).
      const portsMatch = storedSig.split(':')[1] === currentSig.split(':')[1];
      const looksLikeMigration = portsMatch && /^(oxylabs|brightdata|pingproxies|packetstream|iproyal):/.test(currentSig) && /^\d+\.\d+\.\d+\.\d+:/.test(storedSig);
      if (storedSig !== 'direct' && currentSig !== 'direct' && storedSig !== currentSig && !looksLikeMigration) {
        throw new CookieJarStaleError(`cookie_jar_proxy_mismatch: jar minted under proxy=${storedSig} but current proxy=${currentSig} for ${platform} — login required`, {
          platform, label, reason: 'proxy_mismatch', stored_proxy: storedSig, current_proxy: currentSig, account_id: acct?.id ?? null,
        });
      }
    }
    if (storedPersona && currentPersona) {
      // cookies_minted_persona is stored as a pre-resolved signature string
      // (e.g. "cs:12345"), NOT a persona object.
      const storedSig = typeof storedPersona === 'string' ? storedPersona : personaSignature(storedPersona);
      const currentSig = personaSignature(currentPersona);
      if (storedSig && currentSig && storedSig !== currentSig) {
        throw new CookieJarStaleError(`cookie_jar_persona_mismatch: jar minted under persona=${storedSig} but current persona=${currentSig} for ${platform} — login required`, {
          platform, label, reason: 'persona_mismatch', stored_persona: storedSig, current_persona: currentSig, account_id: acct?.id ?? null,
        });
      }
    }
  }

  return cookies;
}

/**
 * Persist a freshly-minted cookie jar back to the account's Skarbiec record.
 * Stamps both cookies_updated_at and cookies_minted_at.
 *
 * Callers MUST have just verified the session is genuinely authed (e.g.
 * passed assertAuthed or otherwise confirmed real login). Calling this
 * after a cookie injection without re-verifying is a bug — the whole point
 * of the freshness gate is that cookies_minted_at proves a fresh login
 * happened, not just that some cookies got copied around.
 */
export async function persistFreshCookieJar(acct, cookies, { currentProxyUrl, currentPersona, persistProxy = false } = {}) {
  if (!acct?.id) return { ok: false, reason: 'no_skarbiec_account_id' };
  const now = new Date().toISOString();
  // Stamp proxy + persona at minting time so loadFreshCookieJarOrFail can
  // refuse jars replayed from a different egress identity.
  const mintedProxy = currentProxyUrl
    ? (typeof currentProxyUrl === 'string'
      ? proxySignature(currentProxyUrl)
      : proxySignature(currentProxyUrl))
    : (acct?.metadata?.proxy
      ? proxySignature(acct.metadata.proxy)
      : null);
  const mintedPersona = currentPersona
    ? personaSignature(currentPersona)
    : (acct?.metadata?.persona
      ? personaSignature(acct.metadata.persona)
      : null);
  const nextMetadata = { ...(acct.metadata ?? {}), cookies, cookies_updated_at: now, cookies_minted_at: now, cookies_minted_proxy: mintedProxy, cookies_minted_persona: mintedPersona };
  if (persistProxy && typeof currentProxyUrl === 'string' && currentProxyUrl) { try { const u = new URL(currentProxyUrl); nextMetadata.proxy = { host: u.hostname, port: Number(u.port), protocol: u.protocol.replace(/:$/, ''), username: decodeURIComponent(u.username || ''), password: decodeURIComponent(u.password || '') }; } catch {} }
  // Clear cookies_stale_at — the whole point of persisting fresh cookies is
  // they're no longer stale. getSocialAccount and the routine selector skip
  // an account whose stale mark is newer than its minted cookies. Same
  // pattern as linkedin/recover/cookie_refresh.mjs, which clears it too.
  delete nextMetadata.cookies_stale_at;
  try {
    updateAccountMetadata(acct.id, nextMetadata);
  } catch (error) {
    return { ok: false, reason: 'skarbiec_write_failed', body: String(error?.message ?? error) };
  }
  // Mutate the in-memory acct so subsequent code in the same process sees
  // the fresh stamp without an extra DB round-trip.
  acct.metadata = nextMetadata;
  return { ok: true, minted_at: now };
}
