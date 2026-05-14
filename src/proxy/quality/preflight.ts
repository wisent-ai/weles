// Preflight check for a proxy URL: discovers the exit IP via a public ip
// echo endpoint, then classifies it. Use before any register trajectory so
// we never burn a signup attempt on a datacenter-class proxy.
//
// Uses curl(1) — avoids a hard dependency on a node HTTP client with proxy
// support. curl is present on every weles host.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { classifyIp, type ClassifyResult, type IpQuality, isAcceptableForRegister } from './classify.js';

const exec = promisify(execFile);
const PROBE_URL = 'https://api.ipify.org';
const PROBE_DEADLINE_MS = 15_000;

export interface PreflightResult {
  ok: boolean;
  ip: string;
  classification?: ClassifyResult;
  error?: string;
}

function buildCurlArgs(proxyUrl: string): string[] {
  const baseFlags = ['-sS', '--max-time', '15'];
  const proxyFlags = ['--proxy', proxyUrl];
  return [...baseFlags, ...proxyFlags, PROBE_URL];
}

export async function preflightProxy(proxyUrl: string): Promise<PreflightResult> {
  if (!proxyUrl) return { ok: false, ip: '', error: 'empty proxy url' };
  try {
    const opts = Object.assign({}, { timeout: PROBE_DEADLINE_MS });
    const { stdout } = await exec('curl', buildCurlArgs(proxyUrl), opts);
    const ip = stdout.trim();
    if (!/^\d+\.\d+\.\d+\.\d+$/.test(ip)) {
      return { ok: false, ip, error: `probe returned non-IPv4: ${ip.slice(0, 60)}` };
    }
    const classification = await classifyIp(ip);
    const acceptable = isAcceptableForRegister(classification.quality);
    return { ok: acceptable, ip, classification };
  } catch (e: any) {
    return { ok: false, ip: '', error: e?.message ? String(e.message).slice(0, 200) : 'proxy probe failed' };
  }
}

export function summarizePreflight(r: PreflightResult): string {
  if (!r.ok && !r.classification) return `preflight FAIL ip=${r.ip || '?'} err=${r.error ?? '?'}`;
  const q = r.classification?.quality ?? ('unknown' as IpQuality);
  const org = r.classification?.org ?? '';
  const verdict = r.ok ? 'ACCEPT' : 'REJECT';
  return `preflight ${verdict} ip=${r.ip} quality=${q} org="${org.slice(0, 50)}"`;
}
