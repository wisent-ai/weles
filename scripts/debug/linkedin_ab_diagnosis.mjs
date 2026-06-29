// LinkedIn A/B automated diagnosis: real Google Chrome (baseline) vs Weles
// Chromium (subject) on the same proxy + persona. Captures early/final JS + TLS
// fingerprints, the createAccount response, and page state, then produces a
// structured report that identifies why Weles is being detected.
//
// Usage:
//   npm run build
//   node --env-file=.env scripts/debug/linkedin_ab_diagnosis.mjs
//
// Env overrides:
//   CHROME_BIN                        real Chrome binary (default macOS path)
//   LINKEDIN_REGISTER_PROXY           proxy request string or URL
//   LINKEDIN_PROXY_COUNTRY            2-letter country hint (default US)
//   AB_HEADLESS=1                     run both browsers headless (not recommended)
//   AB_STOP_AFTER_CREATE_ACCOUNT=0    continue past createAccount (may hit email verification)

import { chromium } from 'playwright';
import { WSession } from '../../dist/session/wsession.js';
import { generatePersona } from '../../dist/browser/persona.js';
import { FP_SCRIPT, NETWORK_FP_URL, parseNetworkFingerprint } from '../../dist/diagnostics/fingerprint_probe.js';
import { analyze } from '../../dist/diagnostics/fingerprint_analyzer.js';
import { humanFill } from '../../dist/human/keyboard.js';
import { humanClickLocator, humanIdlePause } from '../../dist/human/mouse.js';
import { runRecordingsDir, runId } from '../../dist/session/run-recordings.js';
import { resolveProxy } from '../../dist/proxy/config.js';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { mkdtempSync } from 'node:fs';

const CHROME_BIN = process.env.CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
if (!existsSync(CHROME_BIN)) {
  throw new Error(`Real Chrome binary not found at ${CHROME_BIN}. Set CHROME_BIN.`);
}
if (/Chrome for Testing/i.test(CHROME_BIN)) {
  throw new Error(`Refusing Chrome for Testing as a real-browser baseline: ${CHROME_BIN}`);
}

const PROXY_REQUEST = process.env.LINKEDIN_REGISTER_PROXY || process.env.LINKEDIN_PROXY || process.env.PROXY_URL || 'isp decodo us';
const COUNTRY = process.env.LINKEDIN_PROXY_COUNTRY || process.env.WELES_PROXY_COUNTRY || 'US';
const HEADLESS = process.env.AB_HEADLESS === '1';
const STOP_AFTER_CREATE_ACCOUNT = process.env.AB_STOP_AFTER_CREATE_ACCOUNT !== '0';

const ts = new Date().toISOString().replace(/[:.]/g, '-');
process.env.WELES_RUN_ID = `linkedin_ab_${ts}`;
const OUT_DIR = runRecordingsDir('linkedin_ab_diagnosis');
mkdirSync(OUT_DIR, { recursive: true });
const DIAG_OUT = join(OUT_DIR, `linkedin_ab_diagnosis_${ts}.json`);

function hash(value) {
  if (!value) return null;
  return createHash('sha256').update(String(value)).digest('hex').slice(0, 16);
}

function safeRequestedProxy(value) {
  const raw = String(value ?? '');
  return /^(https?:|socks)/i.test(raw) ? '[url-form]' : raw.slice(0, 80);
}

async function captureFingerprint(page, label) {
  await page.goto('about:blank', { waitUntil: 'domcontentloaded', timeout: 15000 });
  const js = await page.evaluate(FP_SCRIPT);
  await page.goto(NETWORK_FP_URL, { waitUntil: 'domcontentloaded', timeout: 25000 });
  const raw = await page.evaluate(() => document.body.innerText || document.body.textContent || '');
  const network = parseNetworkFingerprint(raw);
  return {
    capturedAt: new Date().toISOString(),
    label,
    js,
    network,
  };
}

function classifyOutcome({ createAccount, pageState, cookies }) {
  const url = pageState?.url || '';
  const bodyText = pageState?.bodyTextSample || '';
  const haystack = [url, pageState?.title || '', bodyText, ...(pageState?.iframes || []).map((f) => `${f.src} ${f.title}`)].join(' ');
  const challengeUrl = createAccount?.challengeUrl || '';

  if (/feed|onboarding|m\/welcome/.test(url)) {
    return { outcome: 'pass', kind: 'registration_accepted', detail: 'Redirected to logged-in surface.' };
  }
  if (challengeUrl || /captcha|recaptcha|arkose|Security verification|quick security check|challengeIframe|challenge-dialog/.test(haystack)) {
    return { outcome: 'challenge', kind: 'captcha_gauntlet', detail: 'createAccount returned a challengeUrl or challenge UI is visible.' };
  }
  if (/verify|email-verification|email_verification|checkpoint/.test(url)) {
    return { outcome: 'verification', kind: 'email_or_phone_verification', detail: 'Reached a verification gate.' };
  }
  if (/signup\/?$|signup\/api/.test(url)) {
    return { outcome: 'rejected', kind: 'silent_rejection', detail: 'URL stayed on /signup — likely silent rejection.' };
  }
  return { outcome: 'unknown', kind: 'unknown', detail: 'Could not classify final state.' };
}

async function capturePageState(page) {
  return page.evaluate(() => {
    const visible = (el) => {
      if (!el) return false;
      const s = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      return s.display !== 'none' && s.visibility !== 'hidden' && Number(s.opacity || 1) > 0 && r.width > 0 && r.height > 0;
    };
    return {
      url: location.href,
      title: document.title,
      pageKey: document.querySelector('meta[name="pageKey"]')?.getAttribute('content') || '',
      dataIsBot: document.querySelector('meta#config')?.getAttribute('data-is-bot') || '',
      bodyTextSample: (document.body?.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 1200),
      challengeDialog: !!document.querySelector('#challenge-dialog, .challenge-dialog'),
      iframes: [...document.querySelectorAll('iframe')].map((f) => ({
        src: f.src || '',
        title: f.title || '',
        name: f.name || '',
        visible: visible(f),
        width: f.getBoundingClientRect().width,
        height: f.getBoundingClientRect().height,
      })).slice(0, 30),
    };
  });
}

async function runWeles({ persona, proxy }) {
  const out = { source: 'weles', error: null, exitIp: null, early: null, final: null, createAccount: null, pageState: null, cookies: [] };
  const s = await WSession.start({
    label: 'linkedin_ab_weles',
    proxy: PROXY_REQUEST,
    targetHost: 'www.linkedin.com',
    platform: 'linkedin',
    os: 'macos',
    browser: 'chromium',
    persona,
    headless: HEADLESS,
  });
  try {
    out.exitIp = s.proxyConfig?.exit_ip || null;
    out.identity = { emailHash: hash(s.identity.email), handleHash: hash(s.identity.username) };
    out.rawIdentity = s.identity;
    out.early = await captureFingerprint(s.page, 'weles-early');

    await s.page.goto('https://www.linkedin.com/signup', { waitUntil: 'domcontentloaded', timeout: 45000 });
    await humanIdlePause('deliberate');

    const emailLoc = s.page.locator('input[name="email-address"], input#email-address, input[type="email"]').first();
    const pwdLoc = s.page.locator('input[name="password"], input#password, input[type="password"]').first();
    await humanFill(s.page, emailLoc, s.identity.email);
    await humanIdlePause('short');
    await humanFill(s.page, pwdLoc, s.identity.password);
    await humanIdlePause('deliberate');

    const verifyPasswordResP = s.page.waitForResponse((r) => /\/signup\/api\/verifyPassword/.test(r.url()), { timeout: 20000 }).catch(() => null);
    await humanClickLocator(s.page, s.page.locator('button:has-text("Agree & Join"), button[type="submit"], button#join-form-submit').first());
    const verifyPasswordRes = await verifyPasswordResP;
    out.verifyPassword = { status: verifyPasswordRes?.status?.() ?? null, url: verifyPasswordRes?.url?.() ?? null };
    await humanIdlePause('long');

    const firstLoc = s.page.locator('input[name="first-name"], input#first-name').filter({ visible: true }).first();
    const lastLoc = s.page.locator('input[name="last-name"], input#last-name').filter({ visible: true }).first();
    const hasFirst = await firstLoc.count().catch(() => 0);
    const hasLast = await lastLoc.count().catch(() => 0);

    if (hasFirst && hasLast) {
      await humanFill(s.page, firstLoc, s.identity.firstName);
      await humanIdlePause('short');
      await humanFill(s.page, lastLoc, s.identity.lastName);
      await humanIdlePause('deliberate');

      const createAccountResP = s.page.waitForResponse((r) => /\/signup\/api\/cors\/createAccount/.test(r.url()), { timeout: 20000 }).catch(() => null);
      await humanClickLocator(s.page, s.page.locator('button:has-text("Continue"), button[type="submit"], button#join-form-submit').first());
      const createAccountRes = await createAccountResP;
      let body = '';
      try { body = createAccountRes ? await createAccountRes.text() : ''; } catch {}
      out.createAccount = {
        status: createAccountRes?.status?.() ?? null,
        url: createAccountRes?.url?.() ?? null,
        bodyText: body.slice(0, 3000),
        challengeUrl: (() => { try { return JSON.parse(body)?.challengeUrl || ''; } catch { return ''; } })(),
      };
      await humanIdlePause('long');
    }

    out.pageState = await capturePageState(s.page);
    out.cookies = await s.ctx.cookies().catch(() => []);
    out.final = await captureFingerprint(s.page, 'weles-final');
  } catch (e) {
    out.error = String(e?.message ?? e);
    try { out.pageState = await capturePageState(s.page); } catch {}
    try { out.cookies = await s.ctx.cookies().catch(() => []); } catch {}
  }
  try { await s.close(); } catch {}
  return out;
}

async function runChrome({ persona, proxy, identity }) {
  const out = { source: 'chrome', error: null, exitIp: null, early: null, final: null, createAccount: null, pageState: null, cookies: [] };
  const userDataDir = mkdtempSync(join(tmpdir(), 'linkedin-ab-chrome-'));
  const browser = await chromium.launch({
    executablePath: CHROME_BIN,
    headless: HEADLESS,
    proxy: { server: proxy.server, username: proxy.username, password: proxy.password },
    args: ['--no-first-run', '--no-default-browser-check', '--lang=en-US'],
    ignoreDefaultArgs: ['--enable-automation'],
  });
  try {
    const ctx = await browser.newContext({
      locale: persona.language,
      timezoneId: persona.timezone,
      viewport: { width: persona.screen.width, height: persona.screen.height },
      deviceScaleFactor: persona.screen.dpr,
    });
    const page = await ctx.newPage();
    page.setDefaultTimeout(30000);
    page.setDefaultNavigationTimeout(45000);

    try {
      const ipRes = await ctx.request.get('https://api.ipify.org', { timeout: 10000 });
      if (ipRes.ok()) out.exitIp = (await ipRes.text()).trim();
    } catch {}

    out.early = await captureFingerprint(page, 'chrome-early');

    await page.goto('https://www.linkedin.com/signup', { waitUntil: 'domcontentloaded', timeout: 45000 });
    await humanIdlePause('deliberate');

    await humanFill(page, page.locator('input[name="email-address"], input#email-address, input[type="email"]').first(), identity.email);
    await humanIdlePause('short');
    await humanFill(page, page.locator('input[name="password"], input#password, input[type="password"]').first(), identity.password);
    await humanIdlePause('deliberate');

    const verifyPasswordResP = page.waitForResponse((r) => /\/signup\/api\/verifyPassword/.test(r.url()), { timeout: 20000 }).catch(() => null);
    await humanClickLocator(page, page.locator('button:has-text("Agree & Join"), button[type="submit"], button#join-form-submit').first());
    out.verifyPassword = { status: (await verifyPasswordResP)?.status?.() ?? null };
    await humanIdlePause('long');

    const firstLoc = page.locator('input[name="first-name"], input#first-name').filter({ visible: true }).first();
    const lastLoc = page.locator('input[name="last-name"], input#last-name').filter({ visible: true }).first();
    const hasFirst = await firstLoc.count().catch(() => 0);
    const hasLast = await lastLoc.count().catch(() => 0);

    if (hasFirst && hasLast) {
      await humanFill(page, firstLoc, identity.firstName);
      await humanIdlePause('short');
      await humanFill(page, lastLoc, identity.lastName);
      await humanIdlePause('deliberate');

      const createAccountResP = page.waitForResponse((r) => /\/signup\/api\/cors\/createAccount/.test(r.url()), { timeout: 20000 }).catch(() => null);
      await humanClickLocator(page, page.locator('button:has-text("Continue"), button[type="submit"], button#join-form-submit').first());
      const createAccountRes = await createAccountResP;
      let body = '';
      try { body = createAccountRes ? await createAccountRes.text() : ''; } catch {}
      out.createAccount = {
        status: createAccountRes?.status?.() ?? null,
        url: createAccountRes?.url?.() ?? null,
        bodyText: body.slice(0, 3000),
        challengeUrl: (() => { try { return JSON.parse(body)?.challengeUrl || ''; } catch { return ''; } })(),
      };
      await humanIdlePause('long');
    }

    out.pageState = await capturePageState(page);
    out.cookies = await ctx.cookies().catch(() => []);
    out.final = await captureFingerprint(page, 'chrome-final');
  } catch (e) {
    out.error = String(e?.message ?? e);
  }
  try { await browser.close(); } catch {}
  return out;
}

function summarizeFindings(report) {
  return report.findings.slice(0, 20).map((f) => ({
    rank: f.id,
    severity: f.severity,
    category: f.category,
    message: f.message,
    evidence: f.evidence,
  }));
}

function buildVerdict(weles, chrome, earlyReport, finalReport) {
  const wOutcome = classifyOutcome(weles);
  const cOutcome = classifyOutcome(chrome);
  const suspects = [];

  if (cOutcome.outcome === 'pass' && wOutcome.outcome !== 'pass') {
    suspects.push('browser_fingerprint_or_behavior');
  }
  if (cOutcome.outcome === 'challenge' && wOutcome.outcome === 'challenge') {
    suspects.push('proxy_ip_reputation');
    suspects.push('shared_behavior_velocity');
  }
  if (weles.exitIp && chrome.exitIp && weles.exitIp !== chrome.exitIp) {
    suspects.push('proxy_exit_ip_mismatch');
  }
  if (earlyReport.summary.riskScore > 0) {
    suspects.push(...earlyReport.findings.filter((f) => f.severity !== 'info').map((f) => f.id));
  }
  if (finalReport.summary.riskScore > earlyReport.summary.riskScore) {
    suspects.push('late_drift_after_linkedin_interaction');
  }

  const uniqueSuspects = [...new Set(suspects)];
  let verdict = 'inconclusive';
  let recommendation = 'Re-run with a different proxy and compare outcomes.';
  if (cOutcome.outcome === 'pass' && wOutcome.outcome !== 'pass') {
    verdict = 'weles_detected';
    recommendation = 'Chrome passes on the same proxy — the cause is browser/behavior, not IP. Fix the top fingerprint findings before re-running.';
  } else if (cOutcome.outcome === 'challenge' && wOutcome.outcome === 'challenge') {
    verdict = 'proxy_or_environment_detected';
    recommendation = 'Both browsers hit a challenge on this proxy. The IP/ASN or behavior velocity is flagged. Try a different exit IP or residential proxy before fingerprint tuning.';
  } else if (wOutcome.outcome === 'pass') {
    verdict = 'weles_passed';
    recommendation = 'Weles passed on this run.';
  }
  return { verdict, recommendation, suspects: uniqueSuspects };
}

async function main() {
  console.log(`[ab-diagnosis] out=${OUT_DIR}`);
  console.log(`[ab-diagnosis] proxy=${safeRequestedProxy(PROXY_REQUEST)} country=${COUNTRY} headless=${HEADLESS}`);

  const persona = generatePersona({ country: COUNTRY, os: 'macos', browser: 'chromium' });
  const proxy = await resolveProxy(PROXY_REQUEST, 'www.linkedin.com', persona);
  if (!proxy) throw new Error(`proxy_unavailable: ${PROXY_REQUEST}`);
  console.log(`[ab-diagnosis] resolved proxy exit_ip=${proxy.exit_ip || 'unknown'} server=${proxy.server}`);

  // Run Weles first so we can borrow its generated identity for Chrome.
  const weles = await runWeles({ persona, proxy });
  if (!weles.rawIdentity) throw new Error('weles did not generate identity');
  const chrome = await runChrome({ persona, proxy, identity: weles.rawIdentity });

  const earlyReport = analyze(weles.early, chrome.early);
  const finalReport = analyze(weles.final, chrome.final);

  const verdict = buildVerdict(weles, chrome, earlyReport, finalReport);

  const report = {
    capturedAt: new Date().toISOString(),
    runId: runId(),
    proxy: {
      requested: safeRequestedProxy(PROXY_REQUEST),
      server: proxy.server,
      exitIp: proxy.exit_ip || null,
      chromeObservedExitIp: chrome.exitIp,
      welesObservedExitIp: weles.exitIp,
    },
    persona: {
      os: persona.os,
      browser: persona.browser,
      chromeVersion: persona.chromeVersion,
      screen: persona.screen,
      timezone: persona.timezone,
      language: persona.language,
    },
    chrome: {
      outcome: classifyOutcome(chrome),
      exitIp: chrome.exitIp,
      error: chrome.error,
      verifyPassword: chrome.verifyPassword,
      createAccount: chrome.createAccount,
      pageState: chrome.pageState,
      hasLiAtCookie: chrome.cookies.some((c) => c.name === 'li_at' && c.value),
      fingerprintSummary: {
        earlyNetwork: { ja4: chrome.early?.network?.ja4, peetprint: chrome.early?.network?.peetprint_hash, akamaiH2: chrome.early?.network?.akamaiH2 },
        finalNetwork: { ja4: chrome.final?.network?.ja4, peetprint: chrome.final?.network?.peetprint_hash, akamaiH2: chrome.final?.network?.akamaiH2 },
      },
    },
    weles: {
      outcome: classifyOutcome(weles),
      exitIp: weles.exitIp,
      error: weles.error,
      verifyPassword: weles.verifyPassword,
      createAccount: weles.createAccount,
      pageState: weles.pageState,
      hasLiAtCookie: weles.cookies.some((c) => c.name === 'li_at' && c.value),
      fingerprintSummary: {
        earlyNetwork: { ja4: weles.early?.network?.ja4, peetprint: weles.early?.network?.peetprint_hash, akamaiH2: weles.early?.network?.akamaiH2 },
        finalNetwork: { ja4: weles.final?.network?.ja4, peetprint: weles.final?.network?.peetprint_hash, akamaiH2: weles.final?.network?.akamaiH2 },
      },
    },
    analysis: {
      early: { summary: earlyReport.summary, findings: summarizeFindings(earlyReport) },
      final: { summary: finalReport.summary, findings: summarizeFindings(finalReport) },
    },
    verdict,
  };

  writeFileSync(DIAG_OUT, JSON.stringify(report, null, 2));
  console.log('');
  console.log('=== LinkedIn A/B Diagnosis ===');
  console.log(`Chrome outcome: ${report.chrome.outcome.outcome} (${report.chrome.outcome.kind})`);
  console.log(`Weles  outcome: ${report.weles.outcome.outcome} (${report.weles.outcome.kind})`);
  console.log(`Early risk: ${report.analysis.early.summary.riskScore} (critical=${report.analysis.early.summary.critical} warning=${report.analysis.early.summary.warning})`);
  console.log(`Final risk: ${report.analysis.final.summary.riskScore} (critical=${report.analysis.final.summary.critical} warning=${report.analysis.final.summary.warning})`);
  console.log(`Verdict: ${verdict.verdict}`);
  console.log(`Report: ${DIAG_OUT}`);
  console.log('Top suspects:', verdict.suspects.join(', '));
  console.log('Recommendation:', verdict.recommendation);
}

main().catch((e) => {
  console.error(`[ab-diagnosis] fatal: ${e?.message ?? e}`);
  process.exitCode = 1;
});
