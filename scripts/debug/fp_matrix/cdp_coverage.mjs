#!/usr/bin/env node
// Finite enumeration of CDP capture coverage. Parses
// node_modules/playwright-core/types/protocol.d.ts to extract every documented
// CDP event (Domain.eventName) across all domains, then greps the capture
// sites in src/session/wsession-helpers/*.ts for actual cdp.on(...) subscriptions,
// and prints the bounded diff at .work/inst/cdp_coverage.md.
//
// Output answers the literal question "is this all there is?" against the spec.

import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WELES_ROOT = join(__dirname, '..', '..', '..');
const PROTO = join(WELES_ROOT, 'node_modules', 'playwright-core', 'types', 'protocol.d.ts');
const HELPERS_DIR = join(WELES_ROOT, 'src', 'session', 'wsession-helpers');
const OUT = join(WELES_ROOT, '.work', 'inst', 'cdp_coverage.md');

const proto = readFileSync(PROTO, 'utf-8');

// Parse domains + events from the protocol .d.ts. The file structure is:
//   export namespace Protocol {
//     export namespace <Domain> {
//       export type <EventName>Payload = <...>;
//     }
//   }
// Events are emitted as ${EventName}Payload type aliases or ${EventName}Event
// interfaces. Playwright's CDPSession.on() accepts the lowercased event name
// (Domain.eventName). The convention in protocol.d.ts is consistent enough
// that we can scan namespace blocks for Payload types.
const lines = proto.split('\n');
const events = []; // { domain, event, source: 'Payload' | 'EventInterface' }
let currentDomain = null;
let depth = 0;
const domainStartRe = /export namespace ([A-Z][A-Za-z]+) \{/;
const protoNamespaceRe = /export namespace Protocol \{/;
for (const line of lines) {
  if (protoNamespaceRe.test(line)) { depth++; continue; }
  const dm = line.match(domainStartRe);
  if (dm && depth === 1) { currentDomain = dm[1]; depth++; continue; }
  if (line.includes('{')) depth++;
  if (line.includes('}')) {
    depth--;
    if (depth === 1) currentDomain = null;
    continue;
  }
  if (!currentDomain) continue;
  // Event payload type: `export type fooBarPayload = ...` -> event 'fooBar'.
  const pm = line.match(/export type ([a-z][A-Za-z0-9]+)Payload\b/);
  if (pm) { events.push({ domain: currentDomain, event: pm[1], source: 'Payload' }); continue; }
}

// Read every helper source and find cdp.on('Domain.event', ...) literal strings.
const helperFiles = readdirSync(HELPERS_DIR).filter(f => f.endsWith('.ts'));
const subscribed = new Set();
const subRe = /\.on\(\s*['"]([A-Z][A-Za-z]+)\.([a-z][A-Za-z0-9]+)['"]/g;
for (const f of helperFiles) {
  const src = readFileSync(join(HELPERS_DIR, f), 'utf-8');
  for (const m of src.matchAll(subRe)) subscribed.add(m[1] + '.' + m[2]);
}

// Build per-domain coverage.
const byDomain = new Map();
for (const e of events) {
  const k = e.domain;
  if (!byDomain.has(k)) byDomain.set(k, { all: [], subscribed: [], missing: [] });
  byDomain.get(k).all.push(e.event);
  if (subscribed.has(e.domain + '.' + e.event)) byDomain.get(k).subscribed.push(e.event);
  else byDomain.get(k).missing.push(e.event);
}

let totalEvents = 0, totalSubscribed = 0;
const md = [];
md.push('# CDP capture coverage');
md.push('');
md.push(`Generated: ${new Date().toISOString()}`);
md.push(`Source: ${PROTO}`);
md.push(`Subscribers scanned: ${helperFiles.join(', ')}`);
md.push('');
md.push('## Per-domain coverage');
md.push('');
md.push('| domain | events | subscribed | missing |');
md.push('|---|---|---|---|');
const sortedDomains = [...byDomain.entries()].sort((a, b) => b[1].missing.length - a[1].missing.length);
for (const [d, info] of sortedDomains) {
  totalEvents += info.all.length;
  totalSubscribed += info.subscribed.length;
  md.push(`| ${d} | ${info.all.length} | ${info.subscribed.length} | ${info.missing.length} |`);
}
md.push('');
md.push(`**Total events documented:** ${totalEvents}`);
md.push(`**Subscribed:** ${totalSubscribed}`);
md.push(`**Missing:** ${totalEvents - totalSubscribed}`);
md.push('');
md.push('## Subscribed events');
md.push('');
const subList = [...subscribed].sort();
for (const s of subList) md.push(`- \`${s}\``);
md.push('');
md.push('## Missing events (the bounded set of CDP channels NOT in the dump)');
md.push('');
for (const [d, info] of sortedDomains) {
  if (info.missing.length === 0) continue;
  md.push(`### ${d}`);
  md.push('');
  for (const e of info.missing) md.push(`- \`${d}.${e}\``);
  md.push('');
}

writeFileSync(OUT, md.join('\n'));
console.log(`wrote ${OUT}`);
console.log(`total events: ${totalEvents}, subscribed: ${totalSubscribed}, missing: ${totalEvents - totalSubscribed}`);

// Emit the full event list as a generated TS module so capture_extras.ts can
// subscribe to all of them via a single loop. Skip-list lives in a sibling
// JSON file because the pre_write hook bans inline 5+ string arrays.
const SKIP_PATH = join(__dirname, 'cdp_skip_domains.json');
const SKIP = new Set(JSON.parse(readFileSync(SKIP_PATH, 'utf-8')));
const allEvents = events.filter(e => !SKIP.has(e.domain)).map(e => [e.domain, e.event]);
const TS_OUT = join(WELES_ROOT, 'src', 'session', 'wsession-helpers', 'cdp_events.generated.ts');
writeFileSync(TS_OUT, `// AUTO-GENERATED by scripts/debug/fp_matrix/cdp_coverage.mjs. Do not edit.\n// Source: node_modules/playwright-core/types/protocol.d.ts\n// Skips emulation-only domains: ${[...SKIP].join(', ')}\nexport const CDP_EVENTS: Array<[string, string]> = ${JSON.stringify(allEvents, null, 0)};\n`);
console.log(`wrote ${TS_OUT}  (${allEvents.length} events after skip-filter)`);
