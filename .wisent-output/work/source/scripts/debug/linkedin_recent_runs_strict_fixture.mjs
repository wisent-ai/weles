#!/usr/bin/env node
// Generates a synthetic recent-runs fixture for the strict post-hardening gate.
// Does not touch Supabase or LinkedIn.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const OUT_DIR = 'recordings/audits';

const now = new Date().toISOString();
const completeSession = {
  host_runtime: { platform: 'linux', release: '6.8.0', arch: 'x64', node: 'v22.0.0' },
  browser_version: '147.0.7727.108',
  chromium_path: '/opt/weles/chromium-147/Chromium',
  persona: {
    os: 'macos',
    browser: 'chromium',
    language: 'en-US',
    locale: 'en-US',
    timezone: 'America/New_York',
    platform: 'MacIntel',
    platformVersion: '15.6.1',
  },
  launch_metadata: {
    actual_command_line: {
      available: true,
      args: ['Chromium', '--weles-fingerprint=<redacted>'],
      profile_state: {
        user_data_dir_present: true,
        root_entry_count: 18,
        default_profile_exists: true,
        default_entry_count: 42,
        local_state_exists: true,
        preferences_exists: true,
        first_run_sentinel_exists: false,
        extension_state_present: false,
        cache_state_present: true,
        profile_created_ago_ms: 45000,
        profile_modified_ago_ms: 2000,
        profile_likely_fresh: false,
      },
    },
    actual_process_tree: { available: true, processes: [{ pid: 1234, command: 'Chromium', args: ['Chromium'] }] },
    actual_command_line_risk_buckets: { weles_native: ['--weles-fingerprint=<redacted>'] },
  },
  startup_fingerprint_probe: {
    navigator: { platform: 'MacIntel', language: 'en-US' },
    intl: { timezone: 'America/New_York' },
    webgl: { vendor: 'Google Inc.', renderer: 'ANGLE Metal Renderer' },
  },
  proxy_quality: {
    ok: true,
    inferred_ip_class: 'residential_or_isp',
    ip_intel: { country_code: 'US', timezone: 'America/New_York', connection: { asn: 7922, org: 'Comcast Cable Communications LLC' } },
    proxy: {
      ref_hash: 'proxyref22222222',
      endpoint_hash: 'endpoint11111111',
      sticky_id_hash: 'sticky1111111111',
    },
    risks: [],
  },
  complete_network_capture: {
    enabled: true,
    page_visible: false,
    event_count: 300,
    body_count: 12,
    error_count: 0,
    capture_surface: 'cdp_network_events',
    network_evidence: {
      request_order_count: 80,
      request_header_order_hint_count: 20,
      response_header_order_hint_count: 18,
      category_counts: [{ value: 'signup', count: 8 }, { value: 'challenge', count: 2 }],
      set_cookie_names: [{ value: 'bcookie', count: 1 }, { value: 'JSESSIONID', count: 1 }],
      redirects: [{ status: 302, from: 'www.linkedin.com/signup', to: 'www.linkedin.com/checkpoint/challenge/<id>' }],
      endpoints: {
        signup: ['GET www.linkedin.com/signup'],
        challenge: ['302 www.linkedin.com/checkpoint/challenge/<id>'],
        reporting: ['POST www.linkedin.com/li/track'],
        api: ['200 www.linkedin.com/voyager/api/<fixture>'],
      },
      body_safety: {
        sensitive_body_excerpt_count: 0,
        redacted_body_excerpt_count: 1,
        max_body_bytes: 4096,
      },
    },
  },
  browser_visible_diagnostics: {
    page_instrumentation: false,
    passkey_stub: false,
    arkose_capture: false,
    auth_fetch_capture: false,
    codec_shim: false,
    chrome147_stubs: false,
  },
  action_diagnostics: {
    page_visible: false,
    counters: {
      'action.start': 7,
      'action.ok': 5,
      'action.error': 1,
      'diagnostics.screenshot': 14,
      'diagnostics.dom_snapshot': 14,
      'action.cdp_keyboard': 4,
      'captcha.solver_path': 1,
    },
    recent: [],
  },
  current_url: '<redacted>',
  current_url_hash: '0123456789abcdef',
  page_closed: true,
  closed_at: now,
};

const completeRow = {
  id: '11111111-1111-4111-8111-111111111111',
  account_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  action: 'linkedin_register',
  platform: 'linkedin',
  params: { proxy_url_override: 'redacted-by-audit', target: 'fixture' },
  status: 'failed',
  started_at: now,
  completed_at: now,
  claimed_by: 'fixture-worker',
  error: 'captcha challenge fixture',
  result: {
    run: {
      worker_id: 'fixture-worker',
      exit_code: 1,
      trajectory_path: 'scripts/trajectories/linkedin_register.mjs',
      params_keys: ['proxy_url_override', 'target'],
      worker_env: {
        keys_checked: ['LINKEDIN_REGISTER_PROXY', 'LINKEDIN_PROXY_KIND', 'WELES_PROXY_COUNTRY', 'WELES_EXPECTED_TIMEZONE', 'WELES_EXPECTED_LANGUAGE', 'WELES_CLIENT_HINTS_PLATFORM_VERSION'],
        values: {
          LINKEDIN_REGISTER_PROXY: 'http://<redacted>@proxy.example/...',
          LINKEDIN_PROXY_KIND: 'dedicated',
          WELES_PROXY_COUNTRY: 'US',
          WELES_EXPECTED_TIMEZONE: 'America/New_York',
          WELES_EXPECTED_LANGUAGE: 'en-US',
          WELES_CLIENT_HINTS_PLATFORM_VERSION: '15.6.1',
        },
        flags: {
          WELES_INSTRUMENT: false,
          WELES_ALLOW_UNSAFE_PAGE_INSTRUMENTATION: false,
          WELES_PASSKEY_STUB: false,
          WELES_ARKOSE_CAPTURE: false,
          WELES_AUTH_FETCH_CAPTURE: false,
          WELES_CODEC_SHIM: false,
          WELES_ENABLE_CHROME147_STUBS: false,
          WELES_DISABLE_COMPLETE_NETWORK_CAPTURE: false,
          WELES_ARTIFACT_PUBLIC_URLS: false,
          WELES_ALLOW_REGISTER_STORAGE_INJECTION: false,
          WELES_ALLOW_LINKEDIN_DIRECT: false,
          WELES_ALLOW_LINKEDIN_RESIDENTIAL: false,
          WELES_ALLOW_LINKEDIN_UNDECLARED_PROXY: false,
        },
        params_proxy_override_present: true,
        proxy_refs: {
          LINKEDIN_REGISTER_PROXY: {
            present: true,
            ref_hash: 'proxyref11111111',
            endpoint_hash: 'endpoint11111111',
          },
          params_proxy_url_override: {
            present: true,
            ref_hash: 'proxyref22222222',
            endpoint_hash: 'endpoint11111111',
          },
        },
        selected_proxy_ref: {
          source: 'params.proxy_url_override',
          ref_hash: 'proxyref22222222',
          endpoint_hash: 'endpoint11111111',
        },
        expected: {
          proxy_country: 'US',
          timezone: 'America/New_York',
          language: 'en-US',
          platform_version: '15.6.1',
          architecture: 'arm',
        },
      },
    },
    versions: {
      weles_package_version: '0.4.0',
      weles_git_commit: 'fixturecommit',
      weles_git_dirty: true,
      trajectory_sha256: 'fixture',
    },
    session: completeSession,
    ban_signal: {
      healthy: false,
      signal: 'cold_identity_challenge',
      details: { final_url: '<redacted>', captured_response_count: 120 },
    },
    artifacts: {
      screenshots: ['recordings://linkedin_register/11111111/after_001.png'],
      video: 'recordings://linkedin_register/11111111/linkedin_register.webm',
      dom: ['recordings://linkedin_register/11111111/after_001_dom.html'],
      logs: [
        'recordings://linkedin_register/11111111/complete_network.ndjson',
        'recordings://linkedin_register/11111111/network.ndjson',
        'recordings://linkedin_register/11111111/session_console.log',
      ],
    },
  },
};

const incompleteRow = {
  id: '22222222-2222-4222-8222-222222222222',
  account_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  action: 'linkedin_register',
  platform: 'linkedin',
  params: {},
  status: 'failed',
  started_at: now,
  completed_at: now,
  claimed_by: 'fixture-worker',
  error: 'missing capture fixture',
  result: {
    session: { browser_version: '147.0.7727.108' },
    ban_signal: { healthy: false, signal: 'action_failed' },
    artifacts: {
      screenshots: ['https://example.supabase.co/storage/v1/object/public/recordings/linkedin_register/old.png'],
      logs: ['https://example.supabase.co/storage/v1/object/public/recordings/linkedin_register/network.ndjson'],
    },
  },
};

mkdirSync(OUT_DIR, { recursive: true });
const outPath = join(OUT_DIR, 'linkedin_recent_runs_strict_fixture_rows.json');
writeFileSync(outPath, JSON.stringify([completeRow, incompleteRow], null, 2));
console.log(JSON.stringify({ outPath, rows: 2, complete_row_id: completeRow.id, incomplete_row_id: incompleteRow.id }, null, 2));
