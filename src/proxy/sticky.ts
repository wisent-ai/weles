/**
 * Stored sticky-session refresh. resolveAccountSession persists a per-account
 * proxy config in social_accounts.metadata.proxy. Sticky session IDs expire
 * after the provider's TTL (PacketStream ~30min, Oxylabs ~10min sometimes),
 * after which CONNECT returns 502/407 and Chromium reports
 * ERR_TUNNEL_CONNECTION_FAILED. Pre-flight the stored sticky; if dead, rotate
 * the session id in-place keeping host/port/country stable.
 */
import type { ProxyConfig } from './config.js';

const SESSION_PATTERNS: { user?: RegExp; pass?: RegExp; build: (cfg: ProxyConfig, sid: number) => ProxyConfig }[] = [
  { pass: /_session-\d+/, build: (cfg, sid) => ({ ...cfg, password: cfg.password!.replace(/_session-\d+/, `_session-${sid}`) }) },
  { user: /-sessid-\d+/, build: (cfg, sid) => ({ ...cfg, username: cfg.username!.replace(/-sessid-\d+/, `-sessid-${sid}`) }) },
  { user: /_s_\d+/, build: (cfg, sid) => ({ ...cfg, username: cfg.username!.replace(/_s_\d+/, `_s_${sid}`) }) },
  { user: /-session-\d+/, build: (cfg, sid) => ({ ...cfg, username: cfg.username!.replace(/-session-\d+/, `-session-${sid}`) }) },
];

async function preflight(cfg: ProxyConfig, host: string): Promise<boolean> {
  if (!cfg.host || !cfg.port) return false;
  const auth = Buffer.from(`${cfg.username ?? ''}:${cfg.password ?? ''}`).toString('base64');
  const net = await import('node:net');
  return new Promise<boolean>((resolve) => {
    const sock = net.connect({ host: cfg.host, port: Number(cfg.port) }, () => {
      sock.write(`CONNECT ${host}:443 HTTP/1.1\r\nHost: ${host}:443\r\nProxy-Authorization: Basic ${auth}\r\n\r\n`);
    });
    const timer = setTimeout(() => { sock.destroy(); resolve(false); }, 4000);
    sock.once('data', (d) => { clearTimeout(timer); sock.destroy(); resolve(/^HTTP\/1\.[01] 200/.test(d.toString())); });
    sock.once('error', () => { clearTimeout(timer); resolve(false); });
  });
}

function rotate(cfg: ProxyConfig): ProxyConfig | null {
  const sid = Math.floor(Math.random() * 9000000 + 1000000);
  for (const pat of SESSION_PATTERNS) {
    if (pat.user && cfg.username && pat.user.test(cfg.username)) return pat.build(cfg, sid);
    if (pat.pass && cfg.password && pat.pass.test(cfg.password)) return pat.build(cfg, sid);
  }
  return null;
}

export async function refreshStickyIfDead(cfg: ProxyConfig, targetHost = 'api.ipify.org'): Promise<ProxyConfig | null> {
  if (process.env.PROXY_SKIP_PREFLIGHT === '1') return cfg;
  if (await preflight(cfg, targetHost)) return cfg;
  for (let i = 0; i < 3; i++) {
    const rotated = rotate(cfg);
    if (!rotated) { console.log(`[sticky] no rotatable session pattern for user=${cfg.username?.slice(0, 30)} pass=${cfg.password?.slice(0, 30)}`); return null; }
    if (await preflight(rotated, targetHost)) {
      console.log(`[sticky] rotated dead session on ${cfg.host} -> new sticky working`);
      return rotated;
    }
  }
  console.log(`[sticky] all rotation attempts failed on ${cfg.host}`);
  return null;
}
