#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const OUT_DIR = 'recordings/audits';

const FILES = [
  'scripts/trajectories/linkedin_register.mjs',
  'src/agent/loop.ts',
  'src/agent/tools.ts',
  'src/session/wsession.ts',
  'src/human/mouse.ts',
  'src/human/keyboard.ts',
  'src/human/select.ts',
  'src/captcha/detect.ts',
  'src/captcha/recaptcha.ts',
  'src/captcha/solver.ts',
  'src/async_api.ts',
];

const CHECKS = [
  {
    id: 'cdp_keyboard',
    severity: 'high',
    description: 'Typing uses CDP Input.dispatchKeyEvent; native patch must prove debugger provenance is removed.',
    patterns: [/Input\.dispatchKeyEvent/g],
  },
  {
    id: 'playwright_mouse',
    severity: 'medium',
    description: 'Clicks/movement use Playwright mouse APIs unless native cliclick path is explicitly selected.',
    patterns: [/page\.mouse\.(?:move|click)/g, /\.mouse\.(?:move|click)/g],
  },
  {
    id: 'locator_click',
    severity: 'medium',
    description: 'Some dropdown/captcha actions use Playwright locator/element clicks, not OS-level events.',
    patterns: [/\.locator\([^)]*\).*?\.click\(/g, /\.click\(\{[^}]*force:\s*true/g, /await\s+el\.click\(/g, /await\s+verifyEl\.click\(/g],
  },
  {
    id: 'page_evaluate_action',
    severity: 'medium',
    description: 'Action code executes page.evaluate for DOM probing or direct DOM mutation/clicks.',
    patterns: [/page\.evaluate/g, /frame\.evaluate/g, /bframe\.evaluate/g],
  },
  {
    id: 'js_dispatched_events',
    severity: 'high',
    description: 'Some paths dispatch DOM events or call element.click() in page context; these can be isTrusted=false.',
    patterns: [/dispatchEvent\(/g, /\.click\(\)/g, /requestSubmit\(/g],
  },
  {
    id: 'captcha_postmessage_or_token',
    severity: 'high',
    description: 'Captcha handling can inject tokens or postMessage challenge completion instead of human challenge interaction.',
    patterns: [/postMessage\(/g, /challenge-complete/g, /g-recaptcha-response/g, /captcha_key/g, /octocaptcha:solved/g],
  },
  {
    id: 'page_visible_init_script',
    severity: 'high',
    description: 'Optional page-visible instrumentation/stubs must remain disabled for LinkedIn unless explicitly needed.',
    patterns: [/addInitScript/g, /navigator\.credentials\.get/g, /__arkoseData/g, /__weles/g, /window\.fetch=function/g],
  },
  {
    id: 'high_frequency_diagnostics',
    severity: 'low',
    description: 'Agent loop and WSession capture screenshots/DOM around actions; not page-visible but high-volume diagnostics.',
    patterns: [/screenshot/g, /_saveDom/g, /content\(\)/g],
  },
];

function readLines(path) {
  if (!existsSync(path)) return null;
  return readFileSync(path, 'utf8').split(/\n/);
}

function findMatches(lines, pattern) {
  const hits = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    pattern.lastIndex = 0;
    if (pattern.test(line)) hits.push({ line: i + 1, text: line.trim().slice(0, 240) });
  }
  return hits;
}

function historySurface() {
  const path = 'recordings/linkedin_register/loop_history.json';
  if (!existsSync(path)) return null;
  try {
    const history = JSON.parse(readFileSync(path, 'utf8'));
    if (!Array.isArray(history)) return null;
    const counts = {};
    for (const h of history) counts[h?.tool ?? 'unknown'] = (counts[h?.tool ?? 'unknown'] ?? 0) + 1;
    return {
      path,
      steps: history.length,
      tool_counts: Object.fromEntries(Object.entries(counts).sort((a, b) => String(a[0]).localeCompare(String(b[0])))),
      last_steps: history.slice(-15).map((h, idx) => ({
        idx: Math.max(0, history.length - 15) + idx,
        tool: h?.tool ?? null,
        args_keys: h?.args && typeof h.args === 'object' ? Object.keys(h.args).sort() : [],
        result: typeof h?.result === 'string' ? h.result.slice(0, 160) : h?.result ?? null,
        error: typeof h?.error === 'string' ? h.error.slice(0, 160) : null,
      })),
    };
  } catch (e) {
    return { path, error: String(e?.message ?? e).slice(0, 200) };
  }
}

const fileData = {};
for (const file of FILES) fileData[file] = readLines(file);

const findings = [];
for (const check of CHECKS) {
  const byFile = [];
  for (const [file, lines] of Object.entries(fileData)) {
    if (!lines) continue;
    const hits = check.patterns.flatMap((pattern) => findMatches(lines, pattern));
    if (hits.length) byFile.push({ file, hits });
  }
  if (byFile.length) {
    findings.push({
      id: check.id,
      severity: check.severity,
      description: check.description,
      files: byFile,
      hit_count: byFile.reduce((sum, f) => sum + f.hits.length, 0),
    });
  }
}

const linkedinPath = readLines('scripts/trajectories/linkedin_register.mjs') ?? [];
const passkeyExplicit = linkedinPath.some((line) => /passkeyStub\s*:\s*true/.test(line));
const arkoseExplicit = linkedinPath.some((line) => /arkoseCapture\s*:\s*true/.test(line));
const authFetchExplicit = linkedinPath.some((line) => /authFetchCapture\s*:\s*true/.test(line));
const pageVisibleGuardBlocks = [
  'WELES_PASSKEY_STUB',
  'WELES_ARKOSE_CAPTURE',
  'WELES_AUTH_FETCH_CAPTURE',
  'WELES_CODEC_SHIM',
  'WELES_ENABLE_CHROME147_STUBS',
].every((key) => linkedinPath.some((line) => line.includes(key)))
  && linkedinPath.some((line) => line.includes('page_visible_optional_stubs_off'));
const jsClickDisabled = linkedinPath.some((line) => /disabledTools\s*:\s*\[[^\]]*['"]js_click['"]/.test(line));
const interactiveCaptchaOnly = linkedinPath.some((line) => /captchaMutationPolicy\s*:\s*['"]interactive_only['"]/.test(line));
const pageVisibleEnvEnabled = [
  'WELES_ENABLE_CHROME147_STUBS',
  'WELES_CODEC_SHIM',
  'WELES_PASSKEY_STUB',
  'WELES_ARKOSE_CAPTURE',
  'WELES_AUTH_FETCH_CAPTURE',
].some((key) => process.env[key] === '1' || process.env[key]?.toLowerCase() === 'true')
  || ((process.env.WELES_INSTRUMENT === '1' || process.env.WELES_INSTRUMENT?.toLowerCase() === 'true')
    && (process.env.WELES_ALLOW_UNSAFE_PAGE_INSTRUMENTATION === '1' || process.env.WELES_ALLOW_UNSAFE_PAGE_INSTRUMENTATION?.toLowerCase() === 'true'));

function activeHighFindings(allFindings) {
  const active = [];
  const latent = [];
  for (const finding of allFindings.filter((f) => f.severity === 'high')) {
    if (finding.id === 'page_visible_init_script' && !passkeyExplicit && !arkoseExplicit && !authFetchExplicit && !pageVisibleEnvEnabled) {
      latent.push({ id: finding.id, reason: pageVisibleGuardBlocks
        ? 'page-visible helpers exist but linkedin_register safety gate blocks their env flags before session start'
        : 'page-visible helpers exist but are not enabled by linkedin_register or current env' });
      continue;
    }
    if (finding.id === 'js_dispatched_events' && jsClickDisabled) {
      latent.push({ id: finding.id, reason: 'js_click is disabled for linkedin_register; remaining page-context clicks are shared fallback code or blocked captcha fallback' });
      continue;
    }
    if (finding.id === 'captcha_postmessage_or_token' && interactiveCaptchaOnly) {
      latent.push({ id: finding.id, reason: 'linkedin_register uses captchaMutationPolicy=interactive_only, blocking token assignment, fetch resubmit, and postMessage completion' });
      continue;
    }
    active.push(finding.id);
  }
  return { active, latent };
}

const classifiedHigh = activeHighFindings(findings);

const report = {
  generated_at: new Date().toISOString(),
  scope: 'linkedin_register action, humanization, and captcha static audit',
  entrypoint: 'scripts/trajectories/linkedin_register.mjs',
  linkedin_register_options: {
    explicit_passkey_stub_enabled: passkeyExplicit,
    explicit_arkose_capture_enabled: arkoseExplicit,
    explicit_auth_fetch_capture_enabled: authFetchExplicit,
    linkedin_register_blocks_page_visible_helper_env: pageVisibleGuardBlocks,
    js_click_disabled: jsClickDisabled,
    captcha_mutation_policy: interactiveCaptchaOnly ? 'interactive_only' : 'allow',
    current_env_page_visible_helpers_enabled: pageVisibleEnvEnabled,
    note: 'False here means the trajectory does not explicitly enable these page-visible helpers; env flags can still enable them at runtime and are recorded in session_meta.json.',
  },
  observed_loop_history: historySurface(),
  findings,
  high_findings: findings.filter((f) => f.severity === 'high').map((f) => f.id),
  active_high_findings: classifiedHigh.active,
  latent_high_findings: classifiedHigh.latent,
  summary: {
    active_high_findings: classifiedHigh.active,
    latent_high_findings: classifiedHigh.latent,
    has_cdp_keyboard: findings.some((f) => f.id === 'cdp_keyboard'),
    has_playwright_mouse: findings.some((f) => f.id === 'playwright_mouse'),
    has_js_dom_event_paths: findings.some((f) => f.id === 'js_dispatched_events') && !jsClickDisabled,
    has_captcha_token_or_postmessage_paths: findings.some((f) => f.id === 'captcha_postmessage_or_token') && !interactiveCaptchaOnly,
    has_page_visible_init_script_risk: findings.some((f) => f.id === 'page_visible_init_script') && (passkeyExplicit || arkoseExplicit || authFetchExplicit || pageVisibleEnvEnabled),
    native_input_patch_source_required: true,
  },
  next_required_evidence: [
    'Source review of Chromium InputHandler::HandleMouseEvent movement_x/y stamping and keyboard event provenance patches.',
    'Runtime event-sequence capture comparing OS-user input, Playwright/CDP input, and Weles native patched input on the same form.',
    'LinkedIn post-hardening run with complete_network.ndjson and loop_history.json to correlate final challenge state with the exact tools used.',
  ],
};

mkdirSync(OUT_DIR, { recursive: true });
const outPath = join(OUT_DIR, `linkedin_action_surface_audit_${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
writeFileSync(outPath, JSON.stringify(report, null, 2));
console.log(JSON.stringify({
  outPath,
  finding_count: findings.length,
  high_findings: findings.filter((f) => f.severity === 'high').map((f) => f.id),
  active_high_findings: report.summary.active_high_findings,
  latent_high_findings: report.summary.latent_high_findings,
  summary: report.summary,
}, null, 2));
