// Classify an IPv4 address as residential, datacenter, or unknown.
// Uses whois netname/org matching against the lists in ./lists.ts. Results
// are cached to .work/ip_classifier_cache.json so repeat lookups are free.

import { execFile } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { DATACENTER_ORGS, RESIDENTIAL_ORGS, WHOIS_FIELDS } from './lists.js';

const exec = promisify(execFile);
const CACHE_PATH = join(process.cwd(), '.work', 'ip_classifier_cache.json');
const WHOIS_DEADLINE_MS = 10_000;

export type IpQuality = 'residential' | 'datacenter' | 'unknown';

export interface ClassifyResult {
  ip: string;
  quality: IpQuality;
  org: string;
  netname: string;
  source: 'cache' | 'whois';
  matched_term?: string;
}

function loadCache(): Record<string, ClassifyResult> {
  try { if (existsSync(CACHE_PATH)) return JSON.parse(readFileSync(CACHE_PATH, 'utf8')); } catch { /* ignore */ }
  return {};
}

function saveCache(cache: Record<string, ClassifyResult>): void {
  try {
    mkdirSync(dirname(CACHE_PATH), { recursive: true });
    writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2));
  } catch { /* ignore */ }
}

async function whoisLookup(ip: string): Promise<{ org: string; netname: string }> {
  const opts = Object.assign({}, { timeout: WHOIS_DEADLINE_MS });
  try {
    const { stdout } = await exec('whois', [ip], opts);
    const out: Record<string, string> = {};
    for (const line of stdout.split('\n')) {
      for (const f of WHOIS_FIELDS) {
        const re = new RegExp(`^\\s*${f}\\s*:\\s*(.+)$`, 'i');
        const m = line.match(re);
        if (m && !out[f.toLowerCase()]) out[f.toLowerCase()] = m[1].trim();
      }
    }
    const org = out['orgname'] ? out['orgname']
      : out['organization'] ? out['organization']
      : out['org-name'] ? out['org-name']
      : out['descr'] ? out['descr']
      : '';
    const netname = out['netname'] ? out['netname'] : '';
    return { org, netname };
  } catch {
    return { org: '', netname: '' };
  }
}

function matchAny(haystack: string, needles: ReadonlyArray<string>): string {
  const lower = haystack.toLowerCase();
  for (const n of needles) if (lower.includes(n.toLowerCase())) return n;
  return '';
}

export async function classifyIp(ip: string): Promise<ClassifyResult> {
  const cache = loadCache();
  if (cache[ip]) return { ...cache[ip], source: 'cache' };
  const { org, netname } = await whoisLookup(ip);
  const combined = `${org} | ${netname}`;
  const dcMatch = matchAny(combined, DATACENTER_ORGS);
  const resMatch = matchAny(combined, RESIDENTIAL_ORGS);
  let quality: IpQuality = 'unknown';
  let matched_term = '';
  if (dcMatch) { quality = 'datacenter'; matched_term = dcMatch; }
  else if (resMatch) { quality = 'residential'; matched_term = resMatch; }
  const result: ClassifyResult = { ip, quality, org, netname, source: 'whois', matched_term };
  cache[ip] = result;
  saveCache(cache);
  return result;
}

export function isAcceptableForRegister(quality: IpQuality): boolean {
  return quality === 'residential' || quality === 'unknown';
}
