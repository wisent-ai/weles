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

/**
 * Generate a plausible-looking unregistered domain name that is topical
 * (connected to Wisent, Polish tech, Pilates, California, SF) and resembles
 * a real service rather than a throwaway mail provider.
 * Uses an LLM call for creative naming, then verifies availability.
 * Does NOT register anything — returns only a candidate name.
 * Fails loudly if the LLM is unavailable — no silent degradation to random names.
 */
export async function suggestDomainName(tld = '.com'): Promise<string> {
  const existing = await listExistingDomains();
  const seen = new Set<string>();
  let lastError: string | null = null;

  for (let batch = 0; batch < 3; batch++) {
    let candidates: string[] = [];
    try {
      const raw = callClaude(buildDomainPrompt(12, existing));
      candidates = parseNamesFromLlm(raw);
    } catch (e: any) {
      lastError = e.message?.slice(0, 120) ?? 'unknown';
      console.log(`[domain] LLM call failed (batch ${batch + 1}/3): ${lastError}`);
      continue;
    }
    if (!candidates.length) {
      lastError = 'LLM returned no valid candidates';
      console.log(`[domain] ${lastError} (batch ${batch + 1}/3)`);
      continue;
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

  throw new Error(`LLM domain suggestion failed after 3 batches${lastError ? ` — last error: ${lastError}` : ''}. Fix the LLM call (check claude CLI availability and quota) and retry.`);
}
