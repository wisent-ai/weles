import { readScopedProxy } from '../../_shared/scoped-secrets.mjs';

// Pick the best available US static-ISP proxy for Instagram trajectories.
// Prefer the configured dedicated ISP endpoint; use the existing residential
// fallback only when that endpoint is not configured.
export function pickInstagramProxy() {
  const dPorts = (process.env.DECODO_ISP_PORTS || '')
    .split(',')
    .filter(Boolean);
  const dHost = process.env.DECODO_ISP_HOST;
  const dUser = process.env.DECODO_ISP_USER;
  const dPass = process.env.DECODO_ISP_PASS;
  if (dHost && dPorts.length && dUser && dPass) {
    const port = dPorts[Math.floor(Math.random() * dPorts.length)];
    return `http://${encodeURIComponent(dUser)}:${encodeURIComponent(dPass)}@${dHost}:${port}`;
  }
  const creds = readScopedProxy('oxylabsResidential');
  const sid = Math.floor(Math.random() * 9999999);
  return `http://customer-${encodeURIComponent(creds.username)}-cc-us-sessid-${sid}:${encodeURIComponent(creds.password)}@pr.oxylabs.io:7777`;
}
