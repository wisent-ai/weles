import { readScopedProxy } from '../../_shared/scoped-secrets.mjs';

// Pick the best available US static-ISP proxy for Instagram trajectories.
// Oxylabs Residential rotating sticky triggered IG silent-SMS-suppression
// on 12/12 attempts 2026-05-19. Decodo Dedicated Static ISP (3 US IPs,
// AS Comcast) is the new default; Oxylabs rotating is used only when
// Decodo is not configured.
export function pickInstagramProxy() {
  const dPorts = (process.env.DECODO_ISP_PORTS || '').split(',').filter(Boolean);
  const dHost = process.env.DECODO_ISP_HOST;
  const dUser = process.env.DECODO_ISP_USER;
  const dPass = process.env.DECODO_ISP_PASS;
  if (dHost && dPorts.length && dUser && dPass) {
    const port = dPorts[Math.floor(Math.random() * dPorts.length)];
    return `http://${encodeURIComponent(dUser)}:${encodeURIComponent(dPass)}@${dHost}:${port}`;
  }
  const creds = readScopedProxy('oxylabsResidential');
  const sid = Math.floor(Math.random() * Number('9999999'));
  return `http://customer-${encodeURIComponent(creds.username)}-cc-us-sessid-${sid}:${encodeURIComponent(creds.password)}@pr.oxylabs.io:7777`;
}
