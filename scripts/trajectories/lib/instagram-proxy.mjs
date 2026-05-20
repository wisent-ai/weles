// Pick the best available US static-ISP proxy for Instagram trajectories.
// Oxylabs Residential rotating sticky triggered IG silent-SMS-suppression
// on 12/12 attempts 2026-05-19. Decodo Dedicated Static ISP (3 US IPs,
// AS Comcast) is the new default; Oxylabs rotating is used only when
// Decodo is not configured.
export function pickInstagramProxy() {
  if (process.env.BRIGHTDATA_BROWSER_WS) return 'none';
  if (process.env.PROXY_URL) return process.env.PROXY_URL;
  const dPorts = (process.env.DECODO_ISP_PORTS || '').split(',').filter(Boolean);
  const dHost = process.env.DECODO_ISP_HOST;
  const dUser = process.env.DECODO_ISP_USER;
  const dPass = process.env.DECODO_ISP_PASS;
  if (dHost && dPorts.length && dUser && dPass) {
    const port = dPorts[Math.floor(Math.random() * dPorts.length)];
    return `http://${dUser}:${dPass}@${dHost}:${port}`;
  }
  const oxyUser = process.env.OXYLABS_USERNAME;
  const oxyPass = process.env.OXYLABS_PASSWORD;
  if (oxyUser && oxyPass) {
    const sid = Math.floor(Math.random() * 9999999);
    return `http://customer-${oxyUser}-cc-us-sessid-${sid}:${oxyPass}@pr.oxylabs.io:7777`;
  }
  return 'none';
}
