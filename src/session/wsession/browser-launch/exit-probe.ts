// Which exit the proxy actually gave us. Recorded on the proxy object itself,
// so provenance and cost accounting read the same value.

import { isIP } from 'node:net';
import type { BrowserContext } from 'playwright';
import echo from '../../../trajectories/_shared/network/egress-echo.json';
import type { SessionProxy } from '../session-request.js';

export async function probeExitIp(launch: {
  ctx: BrowserContext;
  label: string;
  proxy: SessionProxy | undefined;
}): Promise<void> {
  const proxy = launch.proxy;
  if (!proxy?.server) return;
  // Provenance and cost accounting read exit_ip, so a probe that did not
  // learn it says why rather than leaving the exit silently unknown.
  try {
    const r = await launch.ctx.request.get(echo.url);
    if (!r.ok()) {
      console.error(
        `[launch] ${launch.label}: exit IP probe answered HTTP ${r.status()}; the proxy exit stays unknown`,
      );
      return;
    }
    const t = (await r.text()).trim();
    if (isIP(t)) proxy.exit_ip = t;
    else
      console.error(
        `[launch] ${launch.label}: exit IP probe answered no address (${JSON.stringify(t)}); the proxy exit stays unknown`,
      );
  } catch (error) {
    console.error(
      `[launch] ${launch.label}: exit IP probe failed; the proxy exit stays unknown: ${error}`,
    );
  }
}
