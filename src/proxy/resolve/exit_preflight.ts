// The checks one sticky exit passes before a session is handed it: the
// authenticated CONNECT, the sampled exit IP against burns and known-bad
// ranges, the country, and the platform probes. A verdict names why an exit
// was rejected, and whether the whole provider should be abandoned (a 407
// means the account is unfunded, so every sticky would fail the same way).
import type { LinkedInProbePersona } from '../policy.js';
import { diagHash, type ProxyPreflightAttempt } from './diagnostics.js';

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

export type ExitPreflightVerdict = { exitIp: string; rejected: boolean; abandonProvider: boolean };

/** Runs the preflight unless PROXY_SKIP_PREFLIGHT=1, in which case the exit is trusted unprobed. */
export async function preflightExit(input: ExitPreflightInput): Promise<ExitPreflightVerdict> {
  const { host, stickyUser, stickyPass, cc, platform, targetHost, displayName, sessId, preflightPersona, attemptDiag, isBurned } = input;
  const p = { proxy_port: input.port, display_name: displayName };
  let exitIp = '';
  let abandonProvider = false;
  if (process.env.PROXY_SKIP_PREFLIGHT) return { exitIp, rejected: false, abandonProvider };
  const probeHost = targetHost || 'api.ipify.org';
  let preflightContinue = false;
  try {
    const auth = Buffer.from(`${stickyUser}:${stickyPass}`).toString('base64');
    const net = await import('node:net');
    const status = await new Promise<number>((resolve) => {
      const sock = net.connect({ host, port: Number(p.proxy_port) }, () => sock.write(`CONNECT ${probeHost}:443 HTTP/1.1\r\nHost: ${probeHost}:443\r\nProxy-Authorization: Basic ${auth}\r\n\r\n`));
      const timer = setTimeout(() => { sock.destroy(); resolve(-1); }, 4000);
      sock.once('data', (d) => { clearTimeout(timer); sock.destroy(); const m = /^HTTP\/1\.[01] (\d{3})/.exec(d.toString()); resolve(m ? Number(m[1]) : 0); });
      sock.once('error', () => { clearTimeout(timer); resolve(-1); });
    });
    const ok = status === 200;
    attemptDiag.connect_status = status;
    if (!ok) {
      console.log(`[proxy] Pre-flight failed ${p.display_name} sticky=${sessId} status=${status}`);
      attemptDiag.rejected_reason = `connect_status:${status}`;
      preflightContinue = true;
      // 407 = account unfunded/suspended. Same credential, all sticks fail. Enqueue topup now.
      if (status === 407) { const { enqueueProviderTopup } = await import('../policy.js'); await enqueueProviderTopup(p.display_name).catch(() => {}); abandonProvider = true; }
    }
    else {
      // Sample exit IP for burn tracking + IPXO range filter.
      try {
        const { execSync } = await import('node:child_process');
        const proxyAuth = `http://${encodeURIComponent(stickyUser)}:${encodeURIComponent(stickyPass)}@${host}:${p.proxy_port}`;
        exitIp = execSync(`curl -s --max-time 6 -x "${proxyAuth}" https://api.ipify.org`, { encoding: 'utf8' }).trim();
      } catch (e: any) { console.log(`[proxy] exit-ip probe err: ${e.message?.slice(0, 80)}`); }
      console.log(`[proxy] sampled exit_ip="${exitIp}" sticky=${sessId}`);
      attemptDiag.exit_ip_present = !!exitIp;
      attemptDiag.exit_ip_hash = diagHash(exitIp);
      if (exitIp && /^82\.40\./.test(exitIp)) { console.log(`[proxy] Skipping IPXO exit ${exitIp}`); attemptDiag.rejected_reason = 'ipxo_exit'; preflightContinue = true; }
      else if (exitIp && platform && (await isBurned(exitIp, platform))) {
        console.log(`[proxy] Exit ${exitIp} already burned for ${platform} — rerolling sticky`);
        attemptDiag.rejected_reason = 'exit_ip_burned';
        preflightContinue = true;
      }
      if (!preflightContinue && exitIp && platform === 'linkedin') {
        const { linkedinSignupExitBurnReason } = await import('../policy.js');
        const signupBurnReason = linkedinSignupExitBurnReason(exitIp);
        if (signupBurnReason) {
          console.log(`[proxy] LinkedIn signup exit ${exitIp} is known-challenged (${signupBurnReason}) — rerolling sticky`);
          attemptDiag.rejected_reason = signupBurnReason;
          preflightContinue = true;
        }
      }
      // Country + LinkedIn register probe. The LinkedIn gate must test
      // /signup, not /login, because login-form access can false-positive
      // for register runs.
      if (!preflightContinue && exitIp) {
        const { verifyExitCountry, probeLinkedinSignup } = await import('../policy.js');
        const geo = cc ? await verifyExitCountry(exitIp, cc) : { result: 'unknown' as const };
        attemptDiag.geo_result = geo.result;
        attemptDiag.geo_exit_cc = geo.exitCc;
        if (geo.result === 'mismatch') { attemptDiag.rejected_reason = 'geo_mismatch'; preflightContinue = true; }
        if (!preflightContinue && platform === 'linkedin') {
          const { isLinkedinWarmedSignupExperiment } = await import('../policy.js');
          if (isLinkedinWarmedSignupExperiment()) {
            console.log(`[proxy] linkedin-probe skipped for warmed signup profile exit=${exitIp}`);
            attemptDiag.linkedin_probe_result = 'skipped_warm_profile';
          } else {
            const url = `http://${encodeURIComponent(stickyUser)}:${encodeURIComponent(stickyPass)}@${host}:${p.proxy_port}`;
            const probe = await probeLinkedinSignup(url, 8, preflightPersona);
            console.log(`[proxy] linkedin-probe exit=${exitIp} -> ${probe.result}${probe.bytes ? ` (${probe.bytes}B)` : ''}`);
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
        const proxyUrl = `http://${encodeURIComponent(stickyUser)}:${encodeURIComponent(stickyPass)}@${host}:${p.proxy_port}`;
        const route = await verifyTikTokRouting(proxyUrl);
        console.log(`[proxy] tiktok-route exit=${exitIp} -> ${route.result}${route.vregion ? ` (${route.vregion})` : ''}`);
        attemptDiag.tiktok_route_result = route.result;
        attemptDiag.tiktok_vregion_present = !!route.vregion;
        if (route.result !== 'standard') {
          console.log(`[proxy] TikTok routing not standard (${route.result}${route.vregion ? `=${route.vregion}` : ''}) — rerolling sticky`);
          attemptDiag.rejected_reason = `tiktok_route:${route.result}`;
          preflightContinue = true;
        }
      }
    }
  } catch { /* skip preflight on unexpected error, return as-is */ }
  return { exitIp, rejected: preflightContinue, abandonProvider };
}
