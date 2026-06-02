#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const PATCH_DIR = process.env.WELES_CHROMIUM_PATCH_DIR
  ?? '../wisent-content-platform/scripts/chromium-arm64';
const OUT_DIR = 'recordings/audits';

const FILES = {
  diff: join(PATCH_DIR, 'weles-patches.diff'),
  checklist: join(PATCH_DIR, 'patches/PATCH_CHECKLIST.md'),
  header: join(PATCH_DIR, 'patches/weles_fingerprint_config.h'),
  config: join(PATCH_DIR, 'patches/weles_fingerprint_config.cc'),
  buildLog: join(PATCH_DIR, 'build.log'),
};

const SURFACES = [
  {
    id: 'command_line_config',
    objective: 'command-line handling and --weles-fingerprint side effects',
    patterns: [/kWelesFingerprint/, /weles-fingerprint/, /GetSwitchValuePath/, /GetSwitchValueASCII/, /json-or-path/, /ReadFileToString/, /JSONReader/],
  },
  {
    id: 'navigator_user_agent',
    objective: 'navigator/userAgentData override implementation',
    patterns: [/NavigatorBase::userAgent/, /NavigatorBase::GetUserAgentMetadata/, /NavigatorUA/, /NavigatorUAData/, /userAgentData/, /brand_version_list/, /ch_brand/, /platformVersion/, /GetUserAgentMetadata/, /GetUserAgentInternal/],
  },
  {
    id: 'navigator_core',
    objective: 'navigator platform/vendor/language/hardware/deviceMemory/screen overrides',
    patterns: [/navigator_platform/, /navigator_vendor/, /navigator_language/, /navigator_languages/, /hardwareConcurrency/, /deviceMemory/, /screen_width/, /Screen::/, /DOMWindow::/],
  },
  {
    id: 'webgl',
    objective: 'WebGL unmasked vendor/renderer override',
    patterns: [/webgl_unmasked/, /WebGLRenderingContextBase::getParameter/, /kUnmaskedRendererWebgl/, /kUnmaskedVendorWebgl/],
  },
  {
    id: 'canvas',
    objective: 'canvas patches',
    patterns: [/canvas_seed/, /NoiseCanvasPixmap/, /EncodeImage/, /ToDataURL/, /image_data_buffer/],
  },
  {
    id: 'audio',
    objective: 'audio patches',
    patterns: [/audio_seed/, /ApplyWelesAudioNoise/, /AudioBuffer::getChannelData/, /RealtimeAnalyser/, /WelesNoiseAt/],
  },
  {
    id: 'media_codecs_plugins',
    objective: 'media codecs/plugins/mime surface',
    patterns: [/mimeTypes/, /plugins/, /PluginArray/, /media_feeds/, /flash_embed/, /codec|canPlayType/i],
  },
  {
    id: 'webrtc',
    objective: 'WebRTC/IP leak patches',
    patterns: [/webrtc_ip/, /webrtcIp/, /P2P/, /candidate/, /IPAddress/, /real machine IP/, /never leaked via WebRTC/],
  },
  {
    id: 'tls_http2_alps',
    objective: 'TLS/HTTP2/ALPS behavior',
    patterns: [/HTTP2|http2|ALPS|alps|application_settings|proxy.*fingerprinting|user_agent header|HttpRequestHeaders/i],
  },
  {
    id: 'host_debug_side_effects',
    objective: 'host-side debug writes and markers',
    patterns: [/WELES_DEBUG/, /fopen/, /fprintf/, /weles_debug\.log/, /weles_brands\.log/, /\/tmp\/weles_brands\.log/, /\/Users\/lukaszbartoszcze/],
  },
];

function read(path) {
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
}

function lineHits(text, patterns, limit = 80) {
  const lines = text.split(/\n/);
  const hits = [];
  for (let i = 0; i < lines.length; i++) {
    for (const pattern of patterns) {
      pattern.lastIndex = 0;
      if (pattern.test(lines[i])) {
        hits.push({ line: i + 1, text: lines[i].trim().slice(0, 260) });
        break;
      }
    }
    if (hits.length >= limit) break;
  }
  return hits;
}

function changedFiles(diff) {
  return [...diff.matchAll(/^diff --git a\/(.+?) b\/(.+)$/gm)].map((m) => m[2]).sort();
}

function has(text, pattern) {
  pattern.lastIndex = 0;
  return pattern.test(text);
}

const texts = Object.fromEntries(Object.entries(FILES).map(([k, path]) => [k, read(path)]));
const combined = [texts.diff, texts.checklist, texts.header, texts.config, texts.buildLog].join('\n');

const surfaces = SURFACES.map((surface) => {
  const hitsBySource = {};
  for (const [source, text] of Object.entries(texts)) {
    const hits = lineHits(text, surface.patterns);
    if (hits.length) hitsBySource[source] = hits;
  }
  return {
    id: surface.id,
    objective: surface.objective,
    present: Object.keys(hitsBySource).length > 0,
    hits_by_source: hitsBySource,
  };
});

const risks = [];
if (has(combined, /WELES_DEBUG|weles_debug\.log|weles_brands\.log|\/tmp\/weles_brands\.log/)) {
  risks.push({
    id: 'native_debug_writes',
    severity: 'critical',
    evidence: 'Patch diff contains native fopen/fprintf debug writes and hardcoded local/tmp paths.',
    linkedin_relevance: 'Not directly JS-readable, but can change timing and proves the shipped native surface is not production-clean.',
  });
}
if (has(texts.buildLog, /cfg->webrtc_ip|String::FromUtf8/)) {
  risks.push({
    id: 'webrtc_patch_compile_error',
    severity: 'critical',
    evidence: 'build.log contains compile errors around cfg->webrtc_ip and String::FromUtf8.',
    linkedin_relevance: 'Available patch dump is not proof of a successfully built WebRTC/IP-leak patch.',
  });
}
if (has(texts.config, /GetSwitchValuePath/) && has(texts.diff, /json-or-path|GetSwitchValueASCII/)) {
  risks.push({
    id: 'command_line_parser_generation_mismatch',
    severity: 'high',
    evidence: 'Standalone config parser expects --weles-fingerprint=<path>; big diff contains a later json-or-path parser.',
    linkedin_relevance: 'Exact shipped behavior is ambiguous without source/commit. Wrong parser mode can leave the native spoof disabled or inconsistent.',
  });
}
if (!has(texts.header, /webrtc_ip/) && has(texts.diff, /webrtc_ip|webrtcIp/)) {
  risks.push({
    id: 'schema_mismatch_webrtc_ip',
    severity: 'high',
    evidence: 'Standalone header lacks webrtc_ip while big diff and build log reference it.',
    linkedin_relevance: 'WebRTC leak behavior cannot be trusted from checked-in standalone patch files.',
  });
}
if (has(texts.diff, /canvas_seed|NoiseCanvasPixmap/) || has(texts.checklist, /Canvas noise/)) {
  risks.push({
    id: 'canvas_noise_fingerprint_risk',
    severity: 'medium',
    evidence: 'Patch applies deterministic canvas pixel noise when configured.',
    linkedin_relevance: 'If noise is enabled, repeated canvas hashes may be stable per session but differ from real Chrome/GPU output. Current Weles JS side intentionally avoids canvas noise.',
  });
}
if (has(texts.diff, /audio_seed|ApplyWelesAudioNoise/)) {
  risks.push({
    id: 'audio_noise_fingerprint_risk',
    severity: 'medium',
    evidence: 'Patch applies deterministic WebAudio sample/analyser noise when configured.',
    linkedin_relevance: 'If enabled, may avoid stock audio fingerprint but can create non-Chrome numeric artifacts unless compared to a real Chrome baseline.',
  });
}

const report = {
  generated_at: new Date().toISOString(),
  patch_dir: PATCH_DIR,
  files: FILES,
  changed_files: changedFiles(texts.diff),
  surfaces,
  coverage: Object.fromEntries(surfaces.map((s) => [s.id, s.present])),
  risks,
  conclusion: {
    source_completeness: 'incomplete_or_mixed_generation',
    can_call_shipped_binary_source_reviewed: false,
    why: [
      'The available patch directory contains standalone config files, a large diff, checklist prose, and build logs that do not all agree.',
      'The exact source tree/commit used to build chromium-147.0.7727.108-weles.1 remains missing.',
      'Installed bundle scans still show native debug/path markers, so the shipped binary cannot be treated as clean.',
    ],
  },
};

mkdirSync(OUT_DIR, { recursive: true });
const outPath = join(OUT_DIR, `chromium_patch_semantics_audit_${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
writeFileSync(outPath, JSON.stringify(report, null, 2));
console.log(JSON.stringify({
  outPath,
  surfaces_present: Object.entries(report.coverage).filter(([, present]) => present).map(([id]) => id),
  risk_ids: risks.map((r) => r.id),
  changed_file_count: report.changed_files.length,
  source_completeness: report.conclusion.source_completeness,
}, null, 2));
