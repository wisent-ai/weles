// The checks one sticky exit passes before a session is handed it: the
// authenticated CONNECT, the sampled exit IP against burns and excluded
// ranges, the country, and the platform probes. A verdict names why an exit
// was rejected, and whether the whole provider should be abandoned (a 407
// means the account is unfunded, so every sticky would fail the same way).
import type { LinkedInProbePersona } from '../policy.js';
import { verifyExitCountry } from '../quality/exit_geography.js';
import { acceptLanguageFor } from '../../browser/persona.js';
import { personaLocale } from '../../browser/persona/locale.js';
import { diagHash, type ProxyPreflightAttempt } from './diagnostics.js';
import { excludedExitReason } from './exit/excluded.js';
import {
  HTTP_OK,
  PROXY_AUTHENTICATION_REQUIRED,
  openTunnel,
  readExitAddress,
  type ProxyEndpoint,
} from './exit/tunnel.js';
import { publicAddressService } from '../../utils/runtime/public-address.js';
import { describeError } from '../../_shared/error-chain/index.cjs';

export type ExitPreflightInput = {
  host: string;
  port: string;
  stickyUser: string;
  stickyPass: string;
  cc: string;
  platform: string | undefined;
  targetHost: string | undefined;
  displayName: string;
  sessId: number;
  preflightPersona: LinkedInProbePersona | undefined;
  attemptDiag: ProxyPreflightAttempt;
  isBurned: (ip: string, platform?: string) => Promise<boolean>;
};

export type ExitPreflightVerdict = {
  exitIp: string;
  rejected: boolean;
  abandonProvider: boolean;
};

/**
 * Whether the authenticated CONNECT opened; otherwise the reason, recorded
 * on the attempt, and whether the provider itself is unfunded.
 */
async function connectVerdict(
  proxy: ProxyEndpoint,
  probeHost: string,
  displayName: string,
  attemptDiag: ProxyPreflightAttempt,
  probePort?: number,
): Promise<{ rejected: boolean; abandonProvider: boolean }> {
  const answer = await openTunnel(proxy, probeHost, probePort);
  if ('failure' in answer) {
    attemptDiag.rejected_reason = `connect_failed: ${answer.failure}`;
    return { rejected: true, abandonProvider: false };
  }
  answer.socket.destroy();
  if (answer.status !== undefined) attemptDiag.connect_status = answer.status;
  if (answer.status === HTTP_OK)
    return { rejected: false, abandonProvider: false };
  attemptDiag.rejected_reason = `connect_answered: ${answer.statusLine}`;
  if (answer.status !== PROXY_AUTHENTICATION_REQUIRED)
    return { rejected: true, abandonProvider: false };
  // The account is unfunded or suspended: every sticky of the same
  // credential fails, so the provider is abandoned and its top-up enqueued.
  const { enqueueProviderTopup } = await import('../policy.js');
  await enqueueProviderTopup(displayName).catch((topupError: unknown) => {
    const cause = describeError(topupError);
    attemptDiag.rejected_reason = `${attemptDiag.rejected_reason}; top-up not enqueued: ${cause}`;
  });
  return { rejected: true, abandonProvider: true };
}

/**
 * The persona the platform probes present through an exit in `country`:
 * the browser dresses the persona in that country's language once the exit
 * is chosen (`dressPersona`), so the probe sends the same Accept-Language.
 * A persona that already states one keeps it.
 */
function probedAs(
  persona: LinkedInProbePersona | undefined,
  country: string | undefined,
): LinkedInProbePersona | undefined {
  if (!persona?.browser || persona.acceptLanguage) return persona;
  const { language } = personaLocale({ country });
  return {
    ...persona,
    acceptLanguage: acceptLanguageFor(persona.browser, language),
  };
}

/** Runs the preflight unless PROXY_SKIP_PREFLIGHT=1, in which case the exit is trusted unprobed. */
export async function preflightExit(
  input: ExitPreflightInput,
): Promise<ExitPreflightVerdict> {
  const {
    cc,
    platform,
    targetHost,
    displayName,
    sessId,
    preflightPersona,
    attemptDiag,
    isBurned,
  } = input;
  let exitIp = '';
  if (process.env.PROXY_SKIP_PREFLIGHT)
    return { exitIp, rejected: false, abandonProvider: false };
  const proxy: ProxyEndpoint = {
    host: input.host,
    port: Number(input.port),
    username: input.stickyUser,
    password: input.stickyPass,
  };
  const proxyUrl = `http://${encodeURIComponent(proxy.username)}:${encodeURIComponent(proxy.password)}@${proxy.host}:${input.port}`;
  let preflightContinue = false;
  // The country the exit was measured in, else the one the run asked for:
  // the browser is dressed in its locale, so the probes present it too.
  let exitCountry = cc;
  try {
    const service = publicAddressService();
    const probeHost = targetHost || service.hostname;
    const connected = await connectVerdict(
      proxy,
      probeHost,
      displayName,
      attemptDiag,
      targetHost || !service.port ? undefined : Number(service.port),
    );
    if (connected.rejected) {
      console.log(
        `[proxy] Pre-flight failed ${displayName} sticky=${sessId}: ${attemptDiag.rejected_reason}`,
      );
      return {
        exitIp,
        rejected: true,
        abandonProvider: connected.abandonProvider,
      };
    }
    // An exit that cannot be read cannot be checked for burns, country or
    // platform routing; it is rerolled, not used unchecked.
    try {
      exitIp = await readExitAddress(proxy, service);
    } catch (error) {
      const cause = describeError(error);
      console.log(`[proxy] exit-ip probe err: ${cause}`);
      attemptDiag.rejected_reason = `exit_ip_unreadable: ${cause}`;
      preflightContinue = true;
    }
    console.log(`[proxy] sampled exit_ip="${exitIp}" sticky=${sessId}`);
    attemptDiag.exit_ip_present = !!exitIp;
    attemptDiag.exit_ip_hash = diagHash(exitIp);
    const excluded = exitIp ? excludedExitReason(exitIp) : undefined;
    if (excluded) {
      console.log(`[proxy] Skipping excluded exit ${exitIp} (${excluded})`);
      attemptDiag.rejected_reason = `excluded_exit: ${excluded}`;
      preflightContinue = true;
    } else if (exitIp && platform && (await isBurned(exitIp, platform))) {
      console.log(
        `[proxy] Exit ${exitIp} already burned for ${platform} — rerolling sticky`,
      );
      attemptDiag.rejected_reason = 'exit_ip_burned';
      preflightContinue = true;
    }
    if (!preflightContinue && exitIp && platform === 'linkedin') {
      const { linkedinSignupExitBurnReason } = await import('../policy.js');
      const signupBurnReason = linkedinSignupExitBurnReason(exitIp);
      if (signupBurnReason) {
        console.log(
          `[proxy] LinkedIn signup exit ${exitIp} is known-challenged (${signupBurnReason}) — rerolling sticky`,
        );
        attemptDiag.rejected_reason = signupBurnReason;
        preflightContinue = true;
      }
    }
    // Country + LinkedIn register probe. The LinkedIn gate must test
    // /signup, not /login, because login-form access can false-positive
    // for register runs.
    if (!preflightContinue && exitIp) {
      const { probeLinkedinSignup } = await import('../policy.js');
      const geo = cc
        ? await verifyExitCountry(exitIp, cc)
        : { result: 'unknown' as const };
      attemptDiag.geo_result = geo.result;
      attemptDiag.geo_exit_cc = geo.exitCc;
      exitCountry = geo.exitCc ?? cc;
      if (geo.result === 'mismatch') {
        attemptDiag.rejected_reason = 'geo_mismatch';
        preflightContinue = true;
      }
      if (!preflightContinue && platform === 'linkedin') {
        const { isLinkedinWarmedSignupExperiment } = await import(
          '../policy.js'
        );
        if (isLinkedinWarmedSignupExperiment()) {
          console.log(
            `[proxy] linkedin-probe skipped for warmed signup profile exit=${exitIp}`,
          );
          attemptDiag.linkedin_probe_result = 'skipped_warm_profile';
        } else {
          const probe = await probeLinkedinSignup(
            proxyUrl,
            probedAs(preflightPersona, exitCountry),
          );
          console.log(
            `[proxy] linkedin-probe exit=${exitIp} -> ${probe.result}${probe.bytes ? ` (${probe.bytes}B)` : ''}`,
          );
          attemptDiag.linkedin_probe_result = probe.result;
          attemptDiag.linkedin_probe_bytes = probe.bytes;
          attemptDiag.linkedin_probe_request = probe.request;
          attemptDiag.linkedin_probe_transport = probe.transport;
          attemptDiag.linkedin_probe_body_markers = probe.body_markers;
          attemptDiag.linkedin_probe_response_body = probe.response_body;
          attemptDiag.linkedin_probe_error = probe.error;
          if (probe.result !== 'form') {
            attemptDiag.rejected_reason = `linkedin_probe:${probe.result}`;
            preflightContinue = true;
          }
        }
      }
    }
    // TikTok-specific: require US-TTP standard cluster. Reject
    // both US-TTP2 (high-risk) and unknown (probe flake) — the
    // trajectory cannot recover from a TTP2 page bootstrap.
    if (!preflightContinue && platform === 'tiktok') {
      const { verifyTikTokRouting } = await import('../policy.js');
      const route = await verifyTikTokRouting(
        proxyUrl,
        probedAs(preflightPersona, exitCountry),
      );
      console.log(
        `[proxy] tiktok-route exit=${exitIp} -> ${route.result}${route.vregion ? ` (${route.vregion})` : ''}`,
      );
      attemptDiag.tiktok_route_result = route.result;
      attemptDiag.tiktok_vregion_present = !!route.vregion;
      if (route.result !== 'standard') {
        console.log(
          `[proxy] TikTok routing not standard (${route.result}${route.vregion ? `=${route.vregion}` : ''}) — rerolling sticky`,
        );
        attemptDiag.rejected_reason = `tiktok_route:${route.result}`;
        preflightContinue = true;
      }
    }
  } catch (error) {
    // A preflight that failed checked nothing: the sticky is rerolled with the
    // cause recorded, never handed to the run as if it had passed.
    const message = describeError(error);
    console.log(`[proxy] preflight err: ${message}`);
    attemptDiag.rejected_reason = `preflight_error: ${message}`;
    preflightContinue = true;
  }
  return { exitIp, rejected: preflightContinue, abandonProvider: false };
}
