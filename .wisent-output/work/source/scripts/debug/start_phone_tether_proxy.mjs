#!/usr/bin/env node
// Start an explicit localhost proxy routed through a phone/tether interface.
//
// This makes the phone route explicit for Weles/diagnostic runs:
//   PROXY_URL=http://127.0.0.1:9001
//   DIAGNOSTIC_PROXY=http://127.0.0.1:9001
//   DIAGNOSTIC_SAME_IP_PROXY=http://127.0.0.1:9001
//
// The script refuses to use Wi-Fi/default routing. It binds outbound sockets to
// the selected interface IPv4 via scripts/phone-proxy.mjs.

import { networkInterfaces } from 'node:os';
import { execFileSync, spawn } from 'node:child_process';

const detectOnly = process.argv.includes('--detect-only') || process.env.PHONE_TETHER_DETECT_ONLY === '1';
const positionalArgs = process.argv.slice(2).filter((arg) => !arg.startsWith('--'));
const ifaceArg = positionalArgs[0] || process.env.PHONE_TETHER_IFACE || '';
const port = Number(positionalArgs[1] || process.env.PHONE_TETHER_PROXY_PORT || 9001);
const all = networkInterfaces();

function ipv4Of(iface) {
  return (all[iface] || []).find((addr) => addr.family === 'IPv4' && !addr.internal)?.address || '';
}

function candidates() {
  const wifi = wifiInterfaces();
  return Object.keys(all)
    .filter((iface) => !/^(lo|utun|awdl|llw|bridge|gif|stf|ap)/i.test(iface))
    .filter((iface) => !wifi.has(iface))
    .map((iface) => ({ iface, ipv4: ipv4Of(iface) }))
    .filter((row) => row.ipv4);
}

function wifiInterfaces() {
  try {
    const text = execFileSync('networksetup', ['-listallhardwareports'], { encoding: 'utf8' });
    const out = new Set();
    for (const block of text.split(/\n\n+/)) {
      if (!/Hardware Port:\s*Wi-Fi/i.test(block)) continue;
      const m = block.match(/Device:\s*(\S+)/i);
      if (m) out.add(m[1]);
    }
    return out;
  } catch {
    return new Set(['en0']);
  }
}

let selected = ifaceArg;
if (selected && !ipv4Of(selected)) {
  console.error(JSON.stringify({
    ok: false,
    error: 'selected_interface_has_no_ipv4',
    selected_interface: selected,
    visible_ipv4_interfaces: Object.keys(all).map((iface) => ({ iface, ipv4: ipv4Of(iface) })).filter((row) => row.ipv4),
  }, null, 2));
  process.exit(2);
}

if (!selected) {
  const rows = candidates();
  if (rows.length !== 1) {
    console.error(JSON.stringify({
      ok: false,
      error: rows.length === 0 ? 'no_phone_tether_ipv4_interface_detected' : 'ambiguous_phone_tether_interface',
      hint: 'Connect USB tethering, then rerun with PHONE_TETHER_IFACE=<iface> if multiple non-Wi-Fi IPv4 interfaces appear.',
      candidates: rows,
      visible_ipv4_interfaces: Object.keys(all).map((iface) => ({ iface, ipv4: ipv4Of(iface) })).filter((row) => row.ipv4),
    }, null, 2));
    process.exit(2);
  }
  selected = rows[0].iface;
}

const proxyUrl = `http://127.0.0.1:${port}`;
console.log(JSON.stringify({
  ok: true,
  detect_only: detectOnly,
  interface: selected,
  interface_ipv4: ipv4Of(selected),
  proxy_url: proxyUrl,
  env: {
    PROXY_URL: proxyUrl,
    DIAGNOSTIC_PROXY: proxyUrl,
    DIAGNOSTIC_SAME_IP_PROXY: proxyUrl,
    LINKEDIN_REGISTER_PROXY: proxyUrl,
    WELES_LINKEDIN_PROXY: proxyUrl,
    LINKEDIN_PROXY_KIND: 'phone_tether_static_current_ip',
    LINKEDIN_PROXY_COUNTRY: 'us',
  },
}, null, 2));

if (detectOnly) process.exit(0);

const child = spawn(process.execPath, ['scripts/phone-proxy.mjs', selected, String(port)], {
  stdio: 'inherit',
  cwd: process.cwd(),
  env: process.env,
});

process.on('SIGINT', () => child.kill('SIGINT'));
process.on('SIGTERM', () => child.kill('SIGTERM'));
child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 0);
});
