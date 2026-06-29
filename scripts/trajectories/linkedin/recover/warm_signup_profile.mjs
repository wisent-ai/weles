/**
 * Build a warm guest LinkedIn profile for a later linkedin_register attempt.
 *
 * This does not submit signup data. It visits public LinkedIn surfaces on a
 * persistent Weles profile, scrolls lightly, then lands on /signup so cookies,
 * localStorage, service workers, and LinkedIn/Google scoring telemetry are no
 * longer first-touch cold when linkedin_register reuses the same profile.
 */
import { WSession } from '../../../../dist/session/wsession.js';
import { humanIdlePause, humanScroll } from '../../../../dist/human/mouse.js';
import { runRecordingsDir } from '../../../../dist/session/run-recordings.js';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const requestedProxy = process.env.LINKEDIN_REGISTER_PROXY ?? process.env.LINKEDIN_PROXY ?? process.env.PROXY_URL ?? 'isp decodo us';
const HEADLESS = process.env.HEADLESS === '1' || process.env.WELES_HEADLESS === '1' || process.env.LINKEDIN_WARM_HEADLESS === '1';
const WARM_BROWSER = process.env.LINKEDIN_WARM_BROWSER || 'chromium';
const WARM_OS = process.env.LINKEDIN_WARM_OS || 'windows';
const profileDir = process.env.LINKEDIN_REGISTER_WARM_PROFILE_DIR ||
  join(process.cwd(), '.work', 'linkedin_register_warm', new Date().toISOString().replace(/[:.]/g, '-'));
const urls = String(process.env.LINKEDIN_WARM_URLS || [
  'https://www.linkedin.com/',
  'https://www.linkedin.com/jobs/search/?keywords=software%20engineer&location=United%20States',
  'https://www.linkedin.com/company/linkedin/',
  'https://www.linkedin.com/pulse/',
].join(','))
  .split(',')
  .map((u) => u.trim())
  .filter(Boolean)
  .map((u) => new URL(u, 'https://www.linkedin.com/').toString())
  .filter((u) => /(^|\.)linkedin\.com$/i.test(new URL(u).hostname));

function safeProxy(value = '') {
  const raw = String(value ?? '');
  return /^(https?:|socks)/i.test(raw) ? '[url-form]' : raw.slice(0, 80);
}

function buildProxyReplayUrl(cfg = {}) {
  if (!cfg?.server) return '';
  try {
    const u = new URL(cfg.server);
    if (cfg.username) u.username = encodeURIComponent(cfg.username);
    if (cfg.password) u.password = encodeURIComponent(cfg.password);
    return u.toString();
  } catch {
    return '';
  }
}

function visibleSummaryScript(stage) {
  return {
    stage,
    url: location.href,
    title: document.title,
    page_key: document.querySelector('meta[name="pageKey"]')?.getAttribute('content') || '',
    body_text_sample: (document.body?.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 500),
    signup_ready: Boolean(document.querySelector('input[name="email-address"], input#email-address, input[type="email"]')) &&
      Boolean(document.querySelector('input[name="password"], input#password, input[type="password"]')),
    iframes: Array.from(document.querySelectorAll('iframe')).map((f) => ({
      title: f.title,
      src: f.src.slice(0, 240),
      width: Math.round(f.getBoundingClientRect().width),
      height: Math.round(f.getBoundingClientRect().height),
    })).slice(0, 20),
    cookie_count: document.cookie ? document.cookie.split(';').filter(Boolean).length : 0,
  };
}

const outDir = runRecordingsDir('linkedin_register_warm');
mkdirSync(outDir, { recursive: true });
mkdirSync(profileDir, { recursive: true });
mkdirSync(join(process.cwd(), '.work', 'linkedin_register_warm'), { recursive: true });

console.log(`[warm-signup] proxy request: ${safeProxy(requestedProxy)}`);
console.log(`[warm-signup] profile dir: ${profileDir}`);
console.log(`[warm-signup] urls: ${urls.length}`);

let s;
const transitions = [];
try {
  s = await WSession.start({
    label: 'linkedin_register_warm',
    proxy: requestedProxy,
    // Do not set targetHost here. linkedin targetHost triggers the cold
    // /signup curl preflight, but this trajectory's purpose is to warm a
    // profile before judging signup readiness.
    headless: HEADLESS,
    browser: WARM_BROWSER,
    os: WARM_OS,
    userDataDir: profileDir,
    pageDiagnostics: false,
  });

  for (const url of urls) {
    try {
      await s.runStep(`warm_${transitions.length}`, async () => {
        await s.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
        return `warmed ${s.page.url()}`;
      });
      await humanScroll(s.page, 900, 3).catch(() => {});
      await humanIdlePause('deliberate');
      transitions.push(await s.page.evaluate(visibleSummaryScript, `warm_${transitions.length}`).catch((e) => ({
        stage: `warm_${transitions.length}`,
        url: s.page.url(),
        error: String(e?.message ?? e).slice(0, 200),
      })));
    } catch (e) {
      transitions.push({ stage: `warm_${transitions.length}`, url, error: String(e?.message ?? e).slice(0, 240) });
      console.log(`[warm-signup] skip ${url}: ${String(e?.message ?? e).slice(0, 120)}`);
    }
  }

  await s.runStep('warm_signup_landing', async () => {
    await s.page.goto('https://www.linkedin.com/signup', { waitUntil: 'domcontentloaded', timeout: 45_000 });
    return `signup ${s.page.url()}`;
  });
  await humanScroll(s.page, 400, 2).catch(() => {});
  await humanIdlePause('deliberate');
  const signup = await s.page.evaluate(visibleSummaryScript, 'signup_landing').catch((e) => ({
    stage: 'signup_landing',
    url: s.page.url(),
    error: String(e?.message ?? e).slice(0, 200),
  }));

  const storage = await s.ctx.storageState().catch(() => ({ cookies: [], origins: [] }));
  const proxyReplayUrl = buildProxyReplayUrl(s.proxyConfig);
  const warmManifest = {
    schema: 'linkedin_register_warm_profile.v1',
    created_at: new Date().toISOString(),
    profile_dir: profileDir,
    persona: s.personaConfig ?? null,
    proxy_replay: {
      url: proxyReplayUrl,
      server: s.proxyConfig?.server ?? null,
      username_present: Boolean(s.proxyConfig?.username),
      password_present: Boolean(s.proxyConfig?.password),
    },
    proxy_metadata: {
      exit_ip: s.proxyConfig?.exit_ip ?? null,
      provider: s.proxyConfig?.provider ?? null,
      proxy_type: s.proxyConfig?.proxy_type ?? null,
      country: s.proxyConfig?.country ?? null,
      platform: s.proxyConfig?.platform ?? null,
      sticky_session_id: s.proxyConfig?.sticky_session_id ?? null,
      sticky_hash: s.proxyConfig?.sticky_hash ?? null,
      exit_reputation: s.proxyConfig?.exit_reputation ?? null,
    },
  };
  writeFileSync(join(profileDir, 'warm_manifest.json'), JSON.stringify(warmManifest, null, 2));
  const summary = {
    created_at: new Date().toISOString(),
    profile_dir: profileDir,
    proxy_request: safeProxy(requestedProxy),
    manifest_path: join(profileDir, 'warm_manifest.json'),
    persona: s.personaConfig ?? null,
    proxy: {
      server_present: Boolean(s.proxyConfig?.server),
      exit_ip: s.proxyConfig?.exit_ip ?? null,
      provider: s.proxyConfig?.provider ?? null,
      proxy_type: s.proxyConfig?.proxy_type ?? null,
      country: s.proxyConfig?.country ?? null,
      sticky_session_id: s.proxyConfig?.sticky_session_id ?? null,
      sticky_hash: s.proxyConfig?.sticky_hash ?? null,
    },
    transitions,
    signup,
    storage: {
      cookie_count: Array.isArray(storage.cookies) ? storage.cookies.length : 0,
      linkedin_cookie_count: Array.isArray(storage.cookies) ? storage.cookies.filter((c) => /linkedin\.com$/.test(c.domain ?? '')).length : 0,
      origin_count: Array.isArray(storage.origins) ? storage.origins.length : 0,
      origins: Array.isArray(storage.origins) ? storage.origins.map((o) => o.origin).slice(0, 20) : [],
    },
    next_register_env: {
      LINKEDIN_REGISTER_WARM_PROFILE_DIR: profileDir,
      LINKEDIN_REGISTER_ALLOW_WARMED_SIGNUP_EXIT: '1',
      LINKEDIN_REGISTER_DEFAULT_PREWARM: '1',
      HEADLESS: HEADLESS ? '1' : '0',
      WELES_INPUT: 'cdp',
    },
  };
  writeFileSync(join(outDir, 'warm_signup_profile.json'), JSON.stringify(summary, null, 2));
  writeFileSync(join(process.cwd(), '.work', 'linkedin_register_warm', 'latest.json'), JSON.stringify(summary, null, 2));
  console.log(`PASS: warm signup profile ready -> ${profileDir}`);
  console.log(`[warm-signup] summary -> ${join(outDir, 'warm_signup_profile.json')}`);
} catch (e) {
  console.log(`FAIL: ${String(e?.message ?? e).slice(0, 240)}`);
  process.exitCode = 1;
} finally {
  await s?.close?.().catch(() => {});
}
