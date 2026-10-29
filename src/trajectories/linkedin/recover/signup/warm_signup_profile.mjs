/**
 * Build a warm guest LinkedIn profile for a later linkedin_register attempt.
 *
 * This does not submit signup data. It visits the public LinkedIn pages the
 * caller names on a persistent Weles profile, scrolls lightly, then lands on
 * /signup so cookies, localStorage, service workers, and LinkedIn/Google
 * scoring telemetry are no longer first-touch cold when linkedin_register
 * reuses the same profile. Headless or not is the session's own
 * WELES_HEADLESS switch.
 */
import { WSession } from '../../../../../dist/session/wsession.js';
import { humanScrollPage } from '../../../../../dist/human/mouse.js';
import { runRecordingsDir } from '../../../../../dist/session/run-recordings.js';
import { exitStatusFor } from '../../../../../dist/cli/usage.js';
import { runOutputPath } from '#run-output';
import { statedText } from '../../../_shared/inputs/stated.mjs';
import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// The manifests are indented two spaces, as they have always been written.
const JSON_INDENT = '  ';

// The exit, browser and operating system the warm profile presents are the
// caller's; the register run that reuses the profile must present the same.
const requestedProxy = statedText(
  ['LINKEDIN_REGISTER_PROXY', 'LINKEDIN_PROXY', 'PROXY_URL'],
  'the proxy (URL or provider filter) the warm profile browses through',
);
const WARM_BROWSER = statedText(
  ['LINKEDIN_WARM_BROWSER'],
  'the browser engine the warm profile presents (chromium or firefox)',
);
const WARM_OS = statedText(
  ['LINKEDIN_WARM_OS'],
  'the operating system the warm profile presents (windows, macos or linux)',
);
// The public LinkedIn pages to warm the profile on, comma separated; a page
// off linkedin.com is dropped.
const urls = statedText(
  ['LINKEDIN_WARM_URLS'],
  'the public LinkedIn pages, comma separated, the warm profile visits before /signup',
)
  .split(',')
  .map((u) => u.trim())
  .filter(Boolean)
  .map((u) => new URL(u, 'https://www.linkedin.com/').toString())
  .filter((u) => /(^|\.)linkedin\.com$/i.test(new URL(u).hostname));
// The profile lives in Weles' own state beside the other reused profiles,
// never inside the checkout.
const profileDir =
  process.env.LINKEDIN_REGISTER_WARM_PROFILE_DIR ||
  join(
    homedir(),
    '.weles',
    'browser_profiles',
    'linkedin_register_warm',
    new Date().toISOString().replace(/[:.]/g, '-'),
  );

function causeOf(error) {
  return error instanceof Error ? error.message : String(error);
}

/** A proxy request as it may be logged: a URL form is never printed. */
function safeProxy(value) {
  return /^(https?:|socks)/i.test(value) ? '[url-form]' : value;
}

/** The proxy URL a later register run replays, with the session's credentials. */
function proxyReplayUrl(cfg) {
  if (!cfg?.server) return undefined;
  const u = new URL(cfg.server);
  if (cfg.username) u.username = encodeURIComponent(cfg.username);
  if (cfg.password) u.password = encodeURIComponent(cfg.password);
  return u.toString();
}

function visibleSummaryScript(stage) {
  return {
    stage,
    url: location.href,
    title: document.title,
    page_key: document
      .querySelector('meta[name="pageKey"]')
      ?.getAttribute('content'),
    body_text_sample: document.body?.innerText.replace(/\s+/g, ' ').trim(),
    signup_ready:
      Boolean(
        document.querySelector(
          'input[name="email-address"], input#email-address, input[type="email"]',
        ),
      ) &&
      Boolean(
        document.querySelector(
          'input[name="password"], input#password, input[type="password"]',
        ),
      ),
    iframes: Array.from(document.querySelectorAll('iframe')).map((f) => ({
      title: f.title,
      src: f.src,
      width: Math.round(f.getBoundingClientRect().width),
      height: Math.round(f.getBoundingClientRect().height),
    })),
    cookie_count: document.cookie.split(';').filter(Boolean).length,
  };
}

const outDir = runRecordingsDir('linkedin_register_warm');
mkdirSync(outDir, { recursive: true });
mkdirSync(profileDir, { recursive: true });
const latestFile = runOutputPath('linkedin_register_warm', 'latest.json');
mkdirSync(join(latestFile, '..'), { recursive: true });

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
    browser: WARM_BROWSER,
    os: WARM_OS,
    userDataDir: profileDir,
    pageDiagnostics: false,
  });

  // A page that cannot be warmed or summarized is recorded with its cause
  // and the walk goes on to the next one.
  for (const url of urls) {
    const stage = `warm_${transitions.length}`;
    try {
      await s.runStep(stage, async () => {
        await s.page.goto(url, { waitUntil: 'domcontentloaded' });
        return `warmed ${s.page.url()}`;
      });
      await humanScrollPage(s.page, 'down');
      transitions.push(await s.page.evaluate(visibleSummaryScript, stage));
    } catch (e) {
      transitions.push({ stage, url, error: causeOf(e) });
      console.log(`[warm-signup] skip ${url}: ${causeOf(e)}`);
    }
  }

  await s.runStep('warm_signup_landing', async () => {
    await s.page.goto('https://www.linkedin.com/signup', {
      waitUntil: 'domcontentloaded',
    });
    return `signup ${s.page.url()}`;
  });
  await humanScrollPage(s.page, 'down');
  const signup = await s.page.evaluate(visibleSummaryScript, 'signup_landing');

  const storage = await s.ctx.storageState();
  const proxy = s.proxyConfig;
  const manifestPath = join(profileDir, 'warm_manifest.json');
  const warmManifest = {
    schema: 'linkedin_register_warm_profile.v1',
    created_at: new Date().toISOString(),
    profile_dir: profileDir,
    persona: s.personaConfig,
    proxy_replay: {
      url: proxyReplayUrl(proxy),
      server: proxy?.server,
      username_present: Boolean(proxy?.username),
      password_present: Boolean(proxy?.password),
    },
    proxy_metadata: {
      exit_ip: proxy?.exit_ip,
      provider: proxy?.provider,
      proxy_type: proxy?.proxy_type,
      country: proxy?.country,
      platform: proxy?.platform,
      sticky_session_id: proxy?.sticky_session_id,
      sticky_hash: proxy?.sticky_hash,
      exit_reputation: proxy?.exit_reputation,
    },
  };
  writeFileSync(manifestPath, JSON.stringify(warmManifest, null, JSON_INDENT));
  const summary = {
    created_at: new Date().toISOString(),
    profile_dir: profileDir,
    proxy_request: safeProxy(requestedProxy),
    manifest_path: manifestPath,
    persona: s.personaConfig,
    proxy: {
      server_present: Boolean(proxy?.server),
      exit_ip: proxy?.exit_ip,
      provider: proxy?.provider,
      proxy_type: proxy?.proxy_type,
      country: proxy?.country,
      sticky_session_id: proxy?.sticky_session_id,
      sticky_hash: proxy?.sticky_hash,
    },
    transitions,
    signup,
    storage: {
      cookie_count: storage.cookies.length,
      linkedin_cookie_count: storage.cookies.filter((c) =>
        c.domain.endsWith('linkedin.com'),
      ).length,
      origin_count: storage.origins.length,
      origins: storage.origins.map((o) => o.origin),
    },
    // The register run reuses this profile when it is named: naming it is
    // what lets that run accept the warmed exit, and the switch below is
    // turned on for it to skip its own prewarm.
    next_register_env: { LINKEDIN_REGISTER_WARM_PROFILE_DIR: profileDir },
    next_register_switches: ['LINKEDIN_REGISTER_DEFAULT_PREWARM'],
  };
  const summaryPath = join(outDir, 'warm_signup_profile.json');
  writeFileSync(summaryPath, JSON.stringify(summary, null, JSON_INDENT));
  writeFileSync(latestFile, JSON.stringify(summary, null, JSON_INDENT));
  console.log(`PASS: warm signup profile ready -> ${profileDir}`);
  console.log(`[warm-signup] summary -> ${summaryPath}`);
} catch (e) {
  console.log(`FAIL: ${causeOf(e)}`);
  process.exitCode = exitStatusFor(e);
} finally {
  // A failed close loses the network log, final dump and video, so it is
  // the run's error, not something to pass over.
  if (s) await s.close();
}
