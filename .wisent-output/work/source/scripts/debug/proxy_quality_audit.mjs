#!/usr/bin/env node
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveProxy } from '../../dist/proxy/config.js';
import { auditProxyQuality } from '../../dist/proxy/quality.js';

const OUT_DIR = 'recordings/audits';

const proxySpec = process.argv[2]
  ?? process.env.LINKEDIN_REGISTER_PROXY
  ?? process.env.WELES_LINKEDIN_PROXY
  ?? process.env.PROXY_URL
  ?? 'direct';

const expected = {
  country: process.env.LINKEDIN_PROXY_COUNTRY ?? process.env.WELES_PROXY_COUNTRY ?? undefined,
  timezone: process.env.WELES_EXPECTED_TIMEZONE ?? undefined,
  language: process.env.WELES_EXPECTED_LANGUAGE ?? undefined,
};

const proxy = await resolveProxy(proxySpec);
const report = await auditProxyQuality(proxy, expected);
report.proxy_spec = proxySpec.startsWith('http') ? '<url>' : proxySpec;
report.expected = expected;
report.linkedin_relevance = {
  direct_equals_exit: report.direct_equals_exit,
  inferred_ip_class: report.inferred_ip_class,
  country_matches_expected: report.coherence?.country_matches_expected ?? null,
  country_matches_language_region: report.coherence?.country_matches_language_region ?? null,
  timezone_matches_expected: report.coherence?.timezone_matches_expected ?? null,
  likely_risks: [
    report.direct_equals_exit ? 'proxy_not_used_or_direct_leak' : null,
    report.inferred_ip_class === 'datacenter' ? 'datacenter_ip_class' : null,
    report.coherence?.country_matches_expected === false ? 'country_mismatch' : null,
    report.coherence?.country_matches_language_region === false ? 'language_country_mismatch' : null,
    report.coherence?.timezone_matches_expected === false ? 'timezone_mismatch' : null,
  ].filter(Boolean),
};

mkdirSync(OUT_DIR, { recursive: true });
const outPath = join(OUT_DIR, `proxy_quality_audit_${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
writeFileSync(outPath, JSON.stringify(report, null, 2));

console.log(JSON.stringify({
  outPath,
  proxy_spec: report.proxy_spec,
  exit_ip: report.exit_ip_probe?.ip ?? null,
  direct_ip: report.direct_ip_probe?.ip ?? null,
  direct_equals_exit: report.direct_equals_exit,
  inferred_ip_class: report.inferred_ip_class,
  country: report.ip_intel?.country_code ?? null,
  asn: report.ip_intel?.connection?.asn ?? null,
  org: report.ip_intel?.connection?.org ?? report.ip_intel?.connection?.isp ?? null,
  risks: report.linkedin_relevance.likely_risks,
}, null, 2));
