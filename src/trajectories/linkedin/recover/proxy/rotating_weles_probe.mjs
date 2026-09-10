/**
 * Browser-level Weles probe for rotating LinkedIn signup exits.
 *
 * This does not submit account data. It samples sticky rotating proxy sessions,
 * launches Weles with each proxy URL, opens /signup, and classifies whether the
 * browser sees a usable signup form or a challenge page.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { WSession } from '../../../../../dist/session/wsession.js';
import { verifyExitCountry, verifyExitReputation } from '../../../../../dist/proxy/policy.js';
import { INCLUDE, OUT, PROBE_OS, SAMPLES_PER_PROVIDER, STOP_AFTER_SUBMIT, SUBMIT_CANDIDATE, TARGET_CC, WORK } from './rotating_weles_probe/settings.mjs';
import { buildStickyAuth, fetchRows, hash, includeRow, providerKey, proxyUrlFor, sampleExitIp } from './rotating_weles_probe/proxies.mjs';
import { classifySummary, summarizeSignup } from './rotating_weles_probe/page.mjs';
import { submitSignupCandidate } from './rotating_weles_probe/submit.mjs';

const rows = fetchRows().filter(includeRow);
const startedAt = new Date().toISOString();
const results = [];
let submitted = false;

console.log(`[wprobe] providers=${rows.length} samples=${SAMPLES_PER_PROVIDER} cc=${TARGET_CC} submit=${SUBMIT_CANDIDATE} os=${PROBE_OS}`);

for (const row of rows) {
  if (submitted && STOP_AFTER_SUBMIT) break;
  const baseUser = row.username;
  const basePass = row.password;

  for (let i = 0; i < SAMPLES_PER_PROVIDER; i++) {
    if (submitted && STOP_AFTER_SUBMIT) break;
    const sessId = Math.floor(Math.random() * 9000000 + 1000000);
    const auth = buildStickyAuth(row, baseUser, basePass, sessId, TARGET_CC);
    const proxyUrl = proxyUrlFor(row, auth.username, auth.password);
    const exitIp = sampleExitIp(proxyUrl);
    const geo = exitIp ? await verifyExitCountry(exitIp, TARGET_CC) : { result: 'unknown' };
    const reputation = exitIp ? await verifyExitReputation(exitIp).catch(() => ({ result: 'unknown' })) : { result: 'unknown' };
    const item = {
      provider: providerKey(row),
      display_name: row.display_name,
      endpoint: { host: row.proxy_host, port: String(row.proxy_port) },
      sticky_hash: hash(sessId),
      proxy_user_hash: hash(auth.username),
      exit_ip: exitIp || null,
      exit_ip_hash: hash(exitIp),
      geo,
      reputation,
      browser: null,
      error: null,
    };

    let s;
    try {
      s = await WSession.start({
        label: 'linkedin_rotating_weles_probe',
        proxy: proxyUrl,
        browser: 'chromium',
        os: PROBE_OS,
        headless: true,
        pageDiagnostics: false,
        targetHost: 'https://www.linkedin.com/signup',
        platform: 'linkedin',
      });
      let gotoError = '';
      await s.page.goto('https://www.linkedin.com/signup', { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch((e) => { gotoError = String(e?.message ?? e).slice(0, 200); });
      await s.page.waitForTimeout(2500).catch(() => {});
      const summary = await summarizeSignup(s.page);
      const classification = classifySummary(summary);
      item.browser = { ...classification, goto_error: gotoError, summary };
      if (SUBMIT_CANDIDATE && classification.result === 'form' && !submitted) {
        console.log(`[wprobe] submitting form candidate provider=${row.display_name} exit=${exitIp || '?'}`);
        item.submit = await submitSignupCandidate(s);
        submitted = true;
      }
      console.log(`[wprobe] ${row.display_name} sample=${i + 1}/${SAMPLES_PER_PROVIDER} exit=${exitIp || '?'} geo=${geo.result} rep=${reputation.result} browser=${classification.result}${classification.signal ? `:${classification.signal}` : ''}${item.submit ? ` submit=${item.submit.result}` : ''}`);
    } catch (e) {
      item.error = String(e?.message ?? e).slice(0, 300);
      console.log(`[wprobe] ${row.display_name} sample=${i + 1}/${SAMPLES_PER_PROVIDER} exit=${exitIp || '?'} error=${item.error}`);
    } finally {
      await s?.close?.().catch(() => {});
    }
    results.push(item);
  }
}

const formCandidates = results.filter((r) => r.browser?.result === 'form');
const submitAttempts = results.filter((r) => r.submit?.attempted);
const submitResultCounts = submitAttempts.reduce((acc, r) => {
  const key = r.submit?.result || 'unknown';
  acc[key] = (acc[key] || 0) + 1;
  return acc;
}, {});
const summary = {
  started_at: startedAt,
  completed_at: new Date().toISOString(),
  samples_per_provider: SAMPLES_PER_PROVIDER,
  target_country: TARGET_CC,
  probe_os: PROBE_OS,
  submit_candidate: SUBMIT_CANDIDATE,
  stop_after_submit: STOP_AFTER_SUBMIT,
  include: [...INCLUDE],
  provider_count: rows.length,
  sample_count: results.filter((r) => !r.skipped).length,
  form_candidate_count: formCandidates.length,
  submit_attempt_count: submitAttempts.length,
  submit_result_counts: submitResultCounts,
  form_candidates: formCandidates.map((r) => ({
    provider: r.provider,
    display_name: r.display_name,
    endpoint: r.endpoint,
    exit_ip: r.exit_ip,
    geo: r.geo,
    reputation: r.reputation,
    sticky_hash: r.sticky_hash,
  })),
  results,
};

writeFileSync(join(OUT, 'rotating_weles_probe.json'), JSON.stringify(summary, null, 2));
writeFileSync(join(WORK, 'latest.json'), JSON.stringify(summary, null, 2));

if (formCandidates.length) {
  console.log(`PASS: browser form candidates=${formCandidates.length} submit_attempts=${submitAttempts.length}`);
} else {
  console.log('FAIL: no browser form candidates');
  process.exitCode = 2;
}
