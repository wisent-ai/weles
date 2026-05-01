/**
 * LLM-driven domain name suggestion.
 *
 * Calls claude -p to generate topical, brand-like domain names
 * (connected to Wisent, Polish tech, Pilates, California, SF),
 * then checks availability via Namecheap.
 */

import { spawnSync } from 'node:child_process';
import { checkDomain } from './provision.js';

const DOMAIN_TOPICS = [
  'Wisent (the European bison species, nature conservation)',
  'Polish technology and startups (Poland as a tech hub)',
  'Pilates and mindful movement studios',
  'California culture and lifestyle',
  'San Francisco Bay Area tech and urban life',
];

function buildDomainPrompt(count: number, existingDomains: string[]): string {
  return `Generate ${count} creative domain name ideas (second-level only, no TLD) for email addresses used by a real business. The domains should feel like legitimate companies or services — not disposable mail providers.

The business is connected to these topics:
${DOMAIN_TOPICS.map((t, i) => `  ${i + 1}. ${t}`).join('\n')}

Rules:
- Each name must be 5-20 characters, lowercase, letters only (no hyphens, no digits unless they genuinely enhance the brand)
- Should sound like a real startup, studio, or publication — not a keyword soup
- Avoid names that obviously signal "email service" (no mail, inbox, relay, dot, post)
- Do not reuse any of these existing domains: ${existingDomains.join(', ')}
- Return ONLY a JSON array of strings, nothing else. Example: ["wisentlabs", "polskahub"]`;
}

const CLAUDE_CLI_TIMEOUT = 60000;

function callClaude(prompt: string): string {
  const proc = spawnSync('claude', ['-p', '--output-format', 'json'], {
    input: prompt,
    timeout: CLAUDE_CLI_TIMEOUT,
    encoding: 'utf-8',
    maxBuffer: 1024 * 1024,
  });
  if (proc.error) throw proc.error;
  if (proc.status !== 0) throw new Error(`claude -p exited ${proc.status}: ${proc.stderr?.slice(0, 200)}`);
  try {
    const wrapped = JSON.parse(proc.stdout);
    return wrapped.result ?? proc.stdout;
  } catch {
    return proc.stdout;
  }
}

function parseNamesFromLlm(raw: string): string[] {
  const match = raw.match(/\[[\s\S]*\]/);
  if (!match) return [];
  try {
    const arr = JSON.parse(match[0]);
    if (!Array.isArray(arr)) return [];
    return arr.filter((s: any) => typeof s === 'string' && /^[a-z0-9]{5,20}$/.test(s));
  } catch {
    return [];
  }
}

async function listExistingDomains(): Promise<string[]> {
  const url = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
  if (!url || !key) return [];
  try {
    const res = await fetch(`${url}/rest/v1/inbound_email_domains?select=domain`, {
      headers: { apikey: key, Authorization: `Bearer ${key}` },
    });
    if (!res.ok) return [];
    const rows = (await res.json()) as Array<{ domain: string }>;
    return rows.map(r => r.domain);
  } catch {
    return [];
  }
}

const COMBO_PREFIXES = ['acorn','apex','arch','aurum','base','bloom','cedar','clear','crest','dawn','dune','echo','ember','field','flint','forge','gable','glen','haven','iris','iron','jade','keel','knoll','lark','latch','leaf','lime','loom','lynx','mason','mesa','mill','nest','noble','nova','oak','opal','pike','pine','pivot','plum','pond','prism','quay','ridge','sage','salt','shore','silk','slate','spar','stone','summit','tide','vale','verd','vine','wave','weld','wick','wind','zeal'];
const COMBO_SUFFIXES = ['base','belt','bit','bolt','box','cast','core','craft','dock','drive','fact','flow','fold','gate','grid','haul','hive','hub','kind','lane','lead','link','mark','mesh','mint','mode','nest','node','pace','path','peak','pin','pulse','reach','ridge','root','route','run','shift','shore','sight','span','spark','stack','stage','stem','step','stone','stride','sync','trail','trend','turn','vale','vault','view','walk','ward','wave','way','well','wire','works','yard'];

async function comboSuggest(tld: string): Promise<string> {
  const pick = (arr: string[]) => arr[Math.floor(Math.random() * arr.length)];
  for (let attempt = 0; attempt < 40; attempt++) {
    const sld = `${pick(COMBO_PREFIXES)}${pick(COMBO_SUFFIXES)}`;
    if (sld.length < 5 || sld.length > 20) continue;
    const domain = `${sld}${tld}`;
    try {
      const avail = await checkDomain(domain);
      if (avail.available && !avail.premium) return domain;
    } catch {}
  }
  throw new Error('Could not find an available domain name after combo attempts');
}

/**
 * Generate a plausible-looking unregistered domain name that is topical
 * (connected to Wisent, Polish tech, Pilates, California, SF) and resembles
 * a real service rather than a throwaway mail provider.
 * Uses an LLM call for creative naming, then verifies availability.
 * Does NOT register anything — returns only a candidate name.
 */
export async function suggestDomainName(tld = '.com'): Promise<string> {
  const existing = await listExistingDomains();
  const seen = new Set<string>();

  for (let batch = 0; batch < 3; batch++) {
    let candidates: string[] = [];
    try {
      const raw = callClaude(buildDomainPrompt(12, existing));
      candidates = parseNamesFromLlm(raw);
    } catch (e: any) {
      console.log(`[domain] LLM name generation failed: ${e.message?.slice(0, 120)}`);
    }
    if (!candidates.length) {
      console.log('[domain] LLM returned no valid candidates, trying word combination');
      return comboSuggest(tld);
    }

    for (const sld of candidates) {
      if (seen.has(sld)) continue;
      seen.add(sld);
      const domain = `${sld}${tld}`;
      try {
        const avail = await checkDomain(domain);
        if (avail.available && !avail.premium) return domain;
        console.log(`[domain] ${domain} unavailable or premium, skipping`);
      } catch {}
    }
  }

  throw new Error('Could not find an available plausible domain name after LLM suggestions');
}
