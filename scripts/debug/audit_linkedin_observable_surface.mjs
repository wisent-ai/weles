#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, statSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const OUT_DIR = 'recordings/audits';

const FILES = [
  'scripts/trajectories/linkedin_register.mjs',
  'src/async_api.ts',
  'src/session/wsession.ts',
  'src/proxy/quality.ts',
  'src/cdp/launcher.ts',
  'src/browser/api.ts',
  'src/browser/persona.ts',
  'src/fingerprint.ts',
  'src/scripts/automation.js',
  'src/scripts/navigator.js',
  'src/scripts/chrome147_stubs.js',
  'src/scripts/codec_shim.js',
  'src/diagnostics/property_trap.js',
  'src/human/mouse.ts',
  'src/human/keyboard.ts',
  'src/human/select.ts',
  'src/captcha/detect.ts',
  'src/captcha/recaptcha.ts',
  'scripts/debug/action_event_probe.mjs',
  'scripts/debug/audit_chromium_patch_semantics.mjs',
];

const CHECKS = [
  {
    id: 'optional_chrome147_init_stubs',
    severity: 'high',
    why_linkedin_cares: 'When enabled, adds page-visible globals/descriptors. If Weles Chromium is truly Chrome 147-compatible natively, extra stubs can become a differential signal.',
    patterns: [/chrome147StubsEnabled\(/, /context\.addInitScript\(readFileSync\(stubPath/, /Object\.defineProperty\(window,\s*'Sanitizer'/],
  },
  {
    id: 'optional_page_instrumentation',
    severity: 'critical_if_enabled',
    why_linkedin_cares: 'Property traps, fetch hooks, Arkose observers, and passkey stubs patch page APIs or create window properties.',
    patterns: [/WELES_ALLOW_UNSAFE_PAGE_INSTRUMENTATION/, /property_trap\.js/, /navigator\.credentials\.get=function/, /window\.__arkoseData/, /window\.fetch=function/, /__weles_form_data/, /__inst_flush/],
  },
  {
    id: 'playwright_launch_profile',
    severity: 'high',
    why_linkedin_cares: 'Remote debugging, temporary profiles, recordVideo, no-first-run, disabled automation blink feature, and sterile background state can differ from real user Chrome.',
    patterns: [/remote-debugging/, /mkdtempSync\(join\(tmpdir\(\), 'weles-'/, /recordVideo/, /--no-first-run/, /--disable-blink-features=AutomationControlled/, /ignoreDefaultArgs/, /--use-mock-keychain/, /--password-store=basic/, /actual_command_line/, /actual_command_line_risk_buckets/],
  },
  {
    id: 'native_fingerprint_flag',
    severity: 'critical',
    why_linkedin_cares: 'The native --weles-fingerprint implementation is the core unknown. A malformed parser, schema mismatch, debug marker, or command-line-visible side effect can fingerprint the browser.',
    patterns: [/--weles-fingerprint=/, /toCppConfig/, /WELES_CLIENT_HINTS_PLATFORM_VERSION/, /fingerprint_config_keys/, /weles-patches\.diff/, /command_line_parser_generation_mismatch/, /schema_mismatch_webrtc_ip/],
  },
  {
    id: 'js_fingerprint_overrides',
    severity: 'high_if_used_on_linkedin',
    why_linkedin_cares: 'JS shims override navigator, permissions, chrome.runtime, plugins, screen/window, and media surfaces. Custom Chromium path intentionally avoids most of these; fallback/stock path still uses them.',
    patterns: [/Object\.defineProperty\(Navigator\.prototype/, /navigator\.permissions\.query/, /chrome\.runtime/, /Navigator\.prototype,\s*'plugins'/, /Navigator\.prototype,\s*'mimeTypes'/, /__welesDefine/],
  },
  {
    id: 'synthetic_action_events',
    severity: 'high',
    why_linkedin_cares: 'CDP/Playwright/page-context events can differ from OS/user-originated input in isTrusted, timing, focus, key repeat, composition, pointer metadata, and movement provenance.',
    patterns: [/Input\.dispatchKeyEvent/, /page\.mouse\.(?:move|click)/, /page\.evaluate/, /dispatchEvent\(/, /\.click\(\)/, /requestSubmit\(/],
  },
  {
    id: 'captcha_challenge_side_effects',
    severity: 'high_if_reached',
    why_linkedin_cares: 'Challenge helpers can inject tokens, force-click iframes, or post challenge completion messages. Even if not LinkedIn-specific, accidental use can create impossible event sequences.',
    patterns: [/g-recaptcha-response/, /challenge-complete/, /postMessage\(/, /captcha_key/, /force:\s*true/, /window\.__arkoseData/],
  },
  {
    id: 'diagnostics_not_page_visible',
    severity: 'medium',
    why_linkedin_cares: 'CDP network capture and screenshots are not directly page-visible, but video/DOM/screenshot frequency can affect timing, CPU, memory, and CDP traffic.',
    patterns: [/completeNetworkCaptureEnabled/, /attachCompleteNetworkCapture/, /Network\.getResponseBody/, /page\.screenshot/, /_saveDom/, /recordVideo/],
  },
  {
    id: 'proxy_host_coherence_metadata',
    severity: 'medium',
    why_linkedin_cares: 'LinkedIn can compare IP geo, timezone, language, platformVersion, WebGL, screen, and account/session history. Metadata collection must prove these line up per production run.',
    patterns: [/probeExitIp/, /auditProxyQuality/, /lookupIpIntel/, /inferred_ip_class/, /startupFingerprintProbe/, /LINKEDIN_PROXY_COUNTRY/, /WELES_PROXY_COUNTRY/, /platformVersion/, /timezone/, /Accept-Language/, /--lang=/],
  },
];

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function readLines(path) {
  if (!existsSync(path)) return null;
  return readFileSync(path, 'utf8').split(/\n/);
}

function matches(lines, pattern) {
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    pattern.lastIndex = 0;
    if (pattern.test(lines[i])) out.push({ line: i + 1, text: lines[i].trim().slice(0, 260) });
  }
  return out;
}

function resolveChromium() {
  const candidates = [];
  if (process.env.CHROMIUM_PATH) candidates.push(process.env.CHROMIUM_PATH);
  const roots = [
    process.env.WELES_CHROMIUM_DIR,
    join(process.env.HOME ?? '', '.local/share/weles-chromium'),
    join(process.cwd(), '../chromium-build/src/out/Weles/Chromium.app/Contents/MacOS/Chromium'),
  ].filter(Boolean);
  for (const root of roots) {
    if (root.endsWith('/Chromium') || root.endsWith('/chrome')) candidates.push(root);
    else {
      try {
        for (const version of readdirSync(root).sort().reverse()) {
          candidates.push(join(root, version, 'Chromium.app/Contents/MacOS/Chromium'));
          candidates.push(join(root, version, 'chromium/chrome'));
        }
      } catch {}
    }
  }
  return candidates.find((p) => existsSync(p)) ?? null;
}

function nativeMarkers(binaryPath) {
  if (!binaryPath) return { binary_path: null, scanned: false, markers: [] };
  const markers = ['WELES_DEBUG', 'weles_debug.log', 'weles_brands.log', '/tmp/weles_brands.log', '/Users/lukaszbartoszcze', 'weles-fingerprint', 'webrtcIp'];
  const appRoot = binaryPath.includes('.app/Contents/MacOS/')
    ? binaryPath.slice(0, binaryPath.indexOf('.app/Contents/MacOS/') + '.app'.length)
    : binaryPath;
  const files = [];
  const walk = (p, depth = 0) => {
    if (depth > 7 || files.length > 80) return;
    let s;
    try { s = statSync(p); } catch { return; }
    if (s.isFile() && s.size > 1024 * 1024) files.push(p);
    else if (s.isDirectory()) {
      for (const name of readdirSync(p)) walk(join(p, name), depth + 1);
    }
  };
  walk(appRoot);
  const found = new Map();
  for (const file of files) {
    let text = '';
    try { text = execFileSync('strings', [file], { encoding: 'utf8', maxBuffer: 24 * 1024 * 1024 }); } catch { continue; }
    for (const marker of markers) {
      if (text.includes(marker)) {
        if (!found.has(marker)) found.set(marker, []);
        found.get(marker).push(file);
      }
    }
  }
  return {
    binary_path: binaryPath,
    app_root: appRoot,
    scanned: true,
    file_count: files.length,
    sha256: existsSync(binaryPath) ? sha256(binaryPath) : null,
    markers: [...found.entries()].map(([marker, files]) => ({ marker, files: [...new Set(files)].slice(0, 5) })),
  };
}

const fileLines = Object.fromEntries(FILES.map((file) => [file, readLines(file)]));
const findings = [];
for (const check of CHECKS) {
  const files = [];
  for (const [file, lines] of Object.entries(fileLines)) {
    if (!lines) continue;
    const hits = check.patterns.flatMap((pattern) => matches(lines, pattern));
    if (hits.length) files.push({ file, hits });
  }
  if (files.length) findings.push({ ...check, files, hit_count: files.reduce((n, f) => n + f.hits.length, 0) });
}

const linkedinEntrypoint = readFileSync('scripts/trajectories/linkedin_register.mjs', 'utf8');
const binaryPath = resolveChromium();
const native = nativeMarkers(binaryPath);
const report = {
  generated_at: new Date().toISOString(),
  question: 'What can LinkedIn observe that could cause linkedin_register to be flagged?',
  entrypoint: 'scripts/trajectories/linkedin_register.mjs',
  linkedin_runtime_defaults: {
    requires_explicit_proxy: /requires LINKEDIN_REGISTER_PROXY/.test(linkedinEntrypoint),
    refuses_generic_residential_by_default: /refuses generic residential proxy/.test(linkedinEntrypoint),
    inject_storage_false: /injectStorage:\s*false/.test(linkedinEntrypoint),
    persona_os: (linkedinEntrypoint.match(/os:\s*'([^']+)'/) ?? [])[1] ?? null,
    persona_browser: (linkedinEntrypoint.match(/browser:\s*'([^']+)'/) ?? [])[1] ?? null,
  },
  native_chromium: native,
  findings,
  likely_flagging_hypotheses_ranked: [
    {
      rank: 1,
      hypothesis: 'Native Weles Chromium binary/patch is dirty or divergent from real Chrome 147.',
      evidence: native.markers.length
        ? 'Installed bundle contains Weles/debug markers in native strings; source repo for the exact build is not visible.'
        : 'Exact C++ source/rebuild provenance is still missing; --weles-fingerprint behavior is unverified.',
      next_evidence: 'Rebuild a clean weles.2 from reviewed source and compare against real Chrome 147 with the same proxy/persona.',
    },
    {
      rank: 2,
      hypothesis: 'Launch/profile automation differs from a normal Chrome user.',
      evidence: 'Playwright launch still uses remote debugging/profile control and creates a fresh automation profile; recordVideo/CDP capture may add timing/CPU pressure. New session metadata records the OS-observed process command line and classifies risky launch buckets.',
      next_evidence: 'Inspect actual_command_line and actual_command_line_risk_buckets from a production linkedin_register session_meta.json.',
    },
    {
      rank: 3,
      hypothesis: 'Page-visible compatibility stubs or optional diagnostics alter the JS surface.',
      evidence: 'Chrome 147 stubs, unsafe traps, fetch hooks, passkey stubs, codec shims, and Arkose hooks are page-visible when enabled; future runs must prove they are off in session_meta unless intentionally tested.',
      next_evidence: 'For every failed LinkedIn run, verify session_meta browser_visible_diagnostics and run a pre-navigation own-property/prototype descriptor diff against real Chrome 147.',
    },
    {
      rank: 4,
      hypothesis: 'Input/challenge event sequence is not human enough.',
      evidence: 'Typing uses CDP key events; mouse defaults to Playwright; select/captcha helpers include page.evaluate/dispatchEvent/postMessage fallback paths.',
      next_evidence: 'Compare event traces on a controlled form for real user input vs Weles linkedin_register actions.',
    },
    {
      rank: 5,
      hypothesis: 'Cold identity/proxy reputation and persona/IP mismatch dominate some failures.',
      evidence: 'linkedin_register now records proxy summary, exit IP, IP intelligence, inferred IP class, direct-vs-exit comparison, host, persona, and startup fingerprint, but recent production rows predate full metadata.',
      next_evidence: 'Run new production attempts with complete_network.ndjson, session_meta.json, ban_signal.json, proxy ASN/geo/class, and sticky id hash.',
    },
  ],
};

mkdirSync(OUT_DIR, { recursive: true });
const outPath = join(OUT_DIR, `linkedin_observable_surface_audit_${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
writeFileSync(outPath, JSON.stringify(report, null, 2));
console.log(JSON.stringify({
  outPath,
  finding_count: findings.length,
  critical_or_high: findings.filter((f) => /^critical|high/.test(f.severity)).map((f) => f.id),
  native_markers: native.markers.map((m) => m.marker),
  ranked_hypotheses: report.likely_flagging_hypotheses_ranked.map((h) => `${h.rank}. ${h.hypothesis}`),
}, null, 2));
