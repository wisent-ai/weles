#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const OUT_DIR = 'recordings/audits';

const FILES = [
  'src/session/wsession.ts',
  'src/capture/complete_network.ts',
  'src/capture/capture.ts',
  'src/worker/poll.ts',
  'src/worker/upload-artifacts.ts',
  'src/vision/analyze.ts',
  'src/captcha/recaptcha.ts',
  'scripts/trajectories/linkedin_register.mjs',
  '../wisent-content-platform/src/middleware.ts',
  '../wisent-content-platform/src/app/(dashboard)/(social)/(main)/accounts/[id]/actions/[log_id]/page.tsx',
  '../wisent-content-platform/src/lib/data/supabase/admin.ts',
  '../wisent-enterprise/middleware.ts',
  '../wisent-enterprise/app/api/weles/latest-success/route.ts',
  '../wisent-enterprise/app/weles/artifacts.ts',
  '../wisent-enterprise/app/weles/[rowId]/page.tsx',
  '../wisent-enterprise/app/weles/diff/page.tsx',
  '../wisent-enterprise/lib/supabase/content-platform.ts',
];

const CHECKS = [
  {
    id: 'complete_network_redaction',
    severity: 'good_with_sensitive_residuals',
    requirement: 'complete_network.ndjson should capture request/response diagnostics without raw secret headers and without page scripts',
    patterns: [/SECRET_HEADER_RE/, /SECRET_BODY_KEY_RE/, /redactHeaders/, /summarizePostData/, /Network\.getResponseBody/, /complete_network\.ndjson/, /page_visible:\s*false/],
  },
  {
    id: 'legacy_response_body_capture',
    severity: 'high_local_sensitive',
    requirement: 'legacy network capture should be understood because it writes response body excerpts',
    patterns: [/capturedResponses/, /responseBodies/, /getResponseBody/, /resp\.text\(\)\)\.slice\(0,\s*8192\)/, /session_responses_/, /network\.ndjson/],
  },
  {
    id: 'local_cookie_storage_capture_api',
    severity: 'high_if_used',
    requirement: 'diagnostic APIs must not dump cookies/localStorage unexpectedly',
    patterns: [/document\.cookie/, /localStorage/, /captureEnvironment/, /environment_\$\{timestamp\(\)\}\.json/],
  },
  {
    id: 'session_meta_result_import',
    severity: 'good',
    requirement: 'session_meta should be imported into account_action_logs result instead of depending on artifact upload',
    patterns: [/session_meta\.json/, /readSessionMeta/, /result\.session\s*=\s*sessionMeta/, /result\.ban_signal\s*=\s*banSignal/],
  },
  {
    id: 'artifact_upload_scope',
    severity: 'medium',
    requirement: 'uploaded artifacts should be capped and categorized',
    patterns: [/KIND_BY_EXT/, /CAPS/, /screenshots:\s*10/, /video:\s*1/, /dom:\s*1/, /logs:\s*4/, /extname/, /uploadOne/],
  },
  {
    id: 'diagnostic_log_upload_priority',
    severity: 'good_required_for_linkedin',
    requirement: 'diagnostic logs required for LinkedIn root-cause analysis should win upload caps',
    patterns: [/artifactPriority/, /complete_network\.ndjson/, /network\.ndjson/, /session_console_/, /application\/x-ndjson/],
  },
  {
    id: 'artifact_private_refs',
    severity: 'good_current_default',
    requirement: 'artifact refs should be private by default unless explicitly configured public',
    patterns: [/WELES_ARTIFACT_PUBLIC_URLS/, /recordings:\/\//, /object\/public/, /createSignedUrl/],
  },
  {
    id: 'page_visible_diagnostics_gates',
    severity: 'critical_if_enabled',
    requirement: 'page-visible diagnostic hooks must be explicit opt-in and visible in session metadata',
    patterns: [/WELES_ALLOW_UNSAFE_PAGE_INSTRUMENTATION/, /browser_visible_diagnostics/, /pageInstrumentation/, /passkeyStub/, /arkoseCapture/, /authFetchCapture/, /codecShim/, /chrome147Stubs/],
  },
  {
    id: 'screenshot_dom_video_volume',
    severity: 'medium',
    requirement: 'screenshots, DOM dumps, and video are not page-visible but affect CPU/timing and storage volume',
    patterns: [/recordVideo/, /page\.screenshot/, /_saveDom/, /page\.content/, /\.webm/, /before_/, /after_/, /error_/],
  },
  {
    id: 'reporting_ui_signing',
    severity: 'good_if_bucket_private',
    requirement: 'reporting UIs should resolve stored refs through signed URLs rather than exposing public object URLs',
    patterns: [/createSignedUrl/, /signedArtifactUrl/, /signedArtifactList/, /resolveArtifacts/, /PUBLIC_RECORDINGS_MARKER/],
  },
  {
    id: 'reporting_access_control_surface',
    severity: 'requires_periodic_review',
    requirement: 'reporting UIs use service-role/admin clients, so access control must be enforced by authenticated app routes and should not be inferred from RLS',
    patterns: [/createAdminClient/, /createContentPlatformAdminClient/, /SERVICE_ROLE_KEY/, /service_role/i, /notFound\(\)/, /\.eq\("id", rowId\)/, /\.eq\('id', log_id\)/, /auth\.getUser/, /admin_users/],
  },
  {
    id: 'reporting_api_auth_gate',
    severity: 'good_if_session_cookie_required',
    requirement: 'API routes that expose signed artifact URLs or redacted run diagnostics should require an authenticated console session because Enterprise middleware skips /api',
    patterns: [/middleware\s+skips\s+\/api/, /auth\.getUser/, /unauthorized/, /resolveArtifactUrls/, /redactForDisplay/],
  },
  {
    id: 'local_recording_pruning',
    severity: 'partial_retention',
    requirement: 'worker-local recordings should have pruning for high-volume screenshots/vision captures',
    patterns: [/pruneRecordings/, /recordingsBudget/, /WELES_RECORDINGS_MAX_BYTES/],
  },
  {
    id: 'storage_artifact_retention_policy',
    severity: 'missing_if_absent',
    requirement: 'uploaded recordings bucket artifacts should have explicit retention/lifecycle/delete policy separate from signed URL expiry',
    patterns: [/recordings.*retention/i, /retention.*recordings/i, /storage.*remove\(/i, /delete.*recordings/i, /lifecycle.*recordings/i],
  },
];

function read(path) {
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
}

function readJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}

function latestAudit(prefix) {
  if (!existsSync(OUT_DIR)) return null;
  const names = readdirSync(OUT_DIR).filter((name) => name.startsWith(prefix) && name.endsWith('.json')).sort();
  const name = names.at(-1);
  if (!name) return null;
  const path = join(OUT_DIR, name);
  return { path, json: readJson(path) };
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

function has(text, pattern) {
  pattern.lastIndex = 0;
  return pattern.test(text);
}

const sources = Object.fromEntries(FILES.map((file) => [file, read(file)]));
const findings = CHECKS.map((check) => {
  const hitsByFile = {};
  for (const [file, text] of Object.entries(sources)) {
    if (!text) continue;
    const hits = lineHits(text, check.patterns);
    if (hits.length) hitsByFile[file] = hits;
  }
  return {
    id: check.id,
    severity: check.severity,
    requirement: check.requirement,
    present: Object.keys(hitsByFile).length > 0,
    hits_by_file: hitsByFile,
  };
});

const wsession = sources['src/session/wsession.ts'];
const upload = sources['src/worker/upload-artifacts.ts'];
const completeNetwork = sources['src/capture/complete_network.ts'];
const capture = sources['src/capture/capture.ts'];
const cpPage = sources['../wisent-content-platform/src/app/(dashboard)/(social)/(main)/accounts/[id]/actions/[log_id]/page.tsx'];
const cpMiddleware = sources['../wisent-content-platform/src/middleware.ts'];
const enterpriseMiddleware = sources['../wisent-enterprise/middleware.ts'];
const enterpriseLatestSuccessApi = sources['../wisent-enterprise/app/api/weles/latest-success/route.ts'];
const enterpriseArtifacts = sources['../wisent-enterprise/app/weles/artifacts.ts'];
const enterprisePage = sources['../wisent-enterprise/app/weles/[rowId]/page.tsx'];
const enterpriseContentPlatformClient = sources['../wisent-enterprise/lib/supabase/content-platform.ts'];
const cpAdmin = sources['../wisent-content-platform/src/lib/data/supabase/admin.ts'];
const storageAudit = latestAudit('recordings_storage_audit_');

const risks = [];
if (has(capture, /document\.cookie/) || has(capture, /localStorage/)) {
  risks.push({
    id: 'unused_capture_environment_sensitive_dump',
    severity: 'high_if_called',
    evidence: 'Capture.captureEnvironment() reads document.cookie and localStorage and writes environment_<ts>.json.',
    linkedin_relevance: 'Not used by current linkedin_register path, but unsafe if added to diagnostics because it executes page JS and stores cookies/storage.',
  });
}
if (has(wsession, /resp\.text\(\)\)\.slice\(0,\s*8192\)/) || has(capture, /Network\.getResponseBody/)) {
  risks.push({
    id: 'legacy_response_body_local_storage',
    severity: 'medium',
    evidence: 'Legacy capturedResponses and Capture.save() can write response body excerpts locally.',
    linkedin_relevance: 'Not page-visible, but sensitive on disk; retention should be explicit. Uploaded network.ndjson currently contains response body excerpts.',
  });
}
if (!has(upload, /\.json['"]:\s*['"]logs/) && has(wsession, /session_meta\.json/)) {
  risks.push({
    id: 'json_diagnostics_not_artifact_uploaded',
    severity: 'low_operational',
    evidence: 'upload-artifacts only uploads png/jpg/webm/mp4/html/ndjson/log; session_meta.json and ban_signal.json are imported into row result, not uploaded as logs.',
    linkedin_relevance: 'Not LinkedIn-visible; operationally means the row result is the source of truth for those JSON diagnostics.',
  });
}
if (has(upload, /WELES_ARTIFACT_PUBLIC_URLS/) && has(upload, /object\/public/)) {
  risks.push({
    id: 'public_artifact_escape_hatch',
    severity: 'medium_if_enabled',
    evidence: 'WELES_ARTIFACT_PUBLIC_URLS=1 switches artifact refs back to public object URLs.',
    linkedin_relevance: 'Not page-visible to LinkedIn, but should remain disabled for sensitive run diagnostics.',
  });
}
if (!has(upload, /artifactPriority/) || !has(upload, /complete_network\.ndjson/) || !has(upload, /network\.ndjson/)) {
  risks.push({
    id: 'diagnostic_log_upload_priority_missing',
    severity: 'high_operational',
    evidence: 'upload-artifacts does not explicitly prioritize complete_network.ndjson and network.ndjson under the logs cap.',
    linkedin_relevance: 'A post-hardening run could capture the right evidence locally but fail production row analysis because required logs were not uploaded.',
  });
}
if (has(wsession, /_saveDom/) && has(wsession, /page\.content/)) {
  risks.push({
    id: 'dom_dump_sensitive_form_state',
    severity: 'medium',
    evidence: 'WSession saves before/after/error DOM HTML around actions.',
    linkedin_relevance: 'Not page-visible, but may store typed form state or challenge markup locally/uploaded as HTML under dom cap.',
  });
}
if (has(completeNetwork, /redactHeaders/) && has(completeNetwork, /summarizeBody/) && has(completeNetwork, /page_visible:\s*false/)) {
  risks.push({
    id: 'complete_network_capture_not_page_visible',
    severity: 'good',
    evidence: 'complete_network capture uses CDP Network events, redacts secret headers/body fields, hashes bodies, and marks capture errors page_visible=false.',
    linkedin_relevance: 'Collection should not expose page globals/scripts; residual risk is timing/CPU and sensitive redacted excerpts in private storage.',
  });
}
if (has(cpPage, /createSignedUrl/) && has(enterpriseArtifacts, /createSignedUrl/)) {
  risks.push({
    id: 'content_enterprise_signed_url_rendering',
    severity: 'good',
    evidence: 'Content Platform and Enterprise artifact views resolve storage refs with createSignedUrl().',
    linkedin_relevance: 'Reporting UI access is not LinkedIn-visible; this supports private artifact refs for operator review.',
  });
}
if (storageAudit?.json?.bucket?.public === false) {
  risks.push({
    id: 'recordings_bucket_private',
    severity: 'good',
    evidence: `Latest storage audit ${storageAudit.path} reports storage.buckets.public=false for recordings and file_size_limit=${storageAudit.json.bucket.file_size_limit ?? 'unknown'}.`,
    linkedin_relevance: 'Not LinkedIn-visible; this supports private artifact refs and signed URL rendering for operator review.',
  });
}
const cpDashboardGuarded =
  has(cpMiddleware, /auth\.getUser/) &&
  has(cpMiddleware, /admin_users/) &&
  has(cpMiddleware, /not_authorized/) &&
  has(cpPage, /log\.account_id\s*!==\s*id/);
const enterpriseWelesGuarded =
  has(enterpriseMiddleware, /auth\.getUser/) &&
  has(enterpriseMiddleware, /!user/) &&
  has(enterprisePage, /\.eq\("id",\s*rowId\)/) &&
  has(enterprisePage, /notFound\(\)/);
const enterpriseApiGuarded =
  has(enterpriseLatestSuccessApi, /auth\.getUser/) &&
  has(enterpriseLatestSuccessApi, /unauthorized/) &&
  has(enterpriseLatestSuccessApi, /resolveArtifactUrls/) &&
  has(enterpriseLatestSuccessApi, /redactForDisplay/);
if (cpDashboardGuarded) {
  risks.push({
    id: 'content_platform_reporting_admin_guarded',
    severity: 'good',
    evidence: 'Content Platform middleware requires Supabase auth, checks admin_users, and the action detail page rejects rows whose account_id does not match the account route id.',
    linkedin_relevance: 'Not LinkedIn-visible; this bounds operator access to Content Platform diagnostic reporting despite service-role reads in the server page.',
  });
}
if (enterpriseWelesGuarded || enterpriseApiGuarded) {
  risks.push({
    id: 'enterprise_reporting_session_guarded',
    severity: enterpriseWelesGuarded && enterpriseApiGuarded ? 'good_with_scope_review' : 'partial',
    evidence: [
      enterpriseWelesGuarded ? 'Enterprise Weles pages are behind middleware auth and row detail 404s on missing account_action_logs id.' : 'Enterprise Weles page auth guard was not fully proven.',
      enterpriseApiGuarded ? 'Enterprise /api/weles/latest-success requires an authenticated console session before returning redacted diagnostics and signed artifact URLs.' : 'Enterprise latest-success API auth guard was not fully proven.',
    ],
    linkedin_relevance: 'Not LinkedIn-visible; row-specific authorization beyond a logged-in Enterprise console user was not proven by this audit and should remain a periodic access-control review item.',
  });
}
if (!findings.find((f) => f.id === 'storage_artifact_retention_policy')?.present) {
  const objects = storageAudit?.json?.objects_aggregate;
  risks.push({
    id: 'storage_artifact_retention_policy_not_found',
    severity: 'high_operational',
    evidence: objects
      ? `No explicit uploaded-recordings retention/lifecycle/delete policy was found. Latest storage audit reports ${objects.object_count} recordings objects, ${objects.total_bytes} bytes, ${objects.older_than_7d} objects older than 7d, and ${objects.linkedin_register_older_than_7d} linkedin_register objects older than 7d. Signed URL expiry is access expiry, not object retention.`
      : 'No explicit uploaded-recordings bucket retention/lifecycle/delete policy was found in the audited Weles, Content Platform, or Enterprise diagnostics/reporting paths. Signed URL expiry is access expiry, not object retention.',
    linkedin_relevance: 'Not page-visible, but sensitive screenshots, DOM, video, and redacted network diagnostics can accumulate and expand blast radius after failures.',
  });
}
if (storageAudit?.json?.storage_policies?.storage_objects_policy_count === 0) {
  risks.push({
    id: 'recordings_storage_no_user_rls_policy',
    severity: 'requires_periodic_review',
    evidence: `Latest storage audit ${storageAudit.path} found 0 pg_policies rows for storage.objects/storage.buckets. Access therefore depends on service-role upload/reporting code plus signed URLs, not user-level storage RLS policies.`,
    linkedin_relevance: 'Not LinkedIn-visible; relevant to diagnostics blast radius and operator access review.',
  });
}
if ((has(cpAdmin, /SUPABASE_SERVICE_ROLE_KEY/) || has(enterpriseContentPlatformClient, /SERVICE_ROLE_KEY/)) && (has(cpPage, /account_action_logs/) || has(enterprisePage, /account_action_logs/))) {
  risks.push({
    id: 'reporting_uses_service_role_clients',
    severity: cpDashboardGuarded && enterpriseWelesGuarded && enterpriseApiGuarded ? 'requires_periodic_review' : 'requires_app_auth_review',
    evidence: cpDashboardGuarded && enterpriseWelesGuarded && enterpriseApiGuarded
      ? 'Service-role/admin clients are used for account_action_logs/artifacts, but audited reporting surfaces are guarded by Content Platform admin middleware, Enterprise session middleware, or explicit Enterprise API auth.'
      : 'Content Platform and Enterprise server pages read account_action_logs/artifacts with service-role/admin Supabase clients and not every audited reporting surface had a proven app auth guard.',
    linkedin_relevance: cpDashboardGuarded && enterpriseWelesGuarded && enterpriseApiGuarded
      ? 'Not LinkedIn-visible. RLS is still bypassed in reporting paths, so keep periodic review for Enterprise role/row scope and signed URL handling.'
      : 'Not LinkedIn-visible, but RLS is bypassed in these reporting paths; access control depends on app authentication/authorization outside this audit.',
  });
}
if (has(enterprisePage, /byte-by-byte|full headers|utf8 body|base64 body/i)) {
  risks.push({
    id: 'enterprise_network_capture_label_stale',
    severity: 'low_operational',
    evidence: 'Enterprise Weles detail page describes network capture as byte-by-byte/full headers/utf8 body/base64 body, while current Weles complete_network capture redacts headers and stores body hashes/excerpts.',
    linkedin_relevance: 'Not page-visible; operator UI should not imply raw body capture when the production recorder intentionally stores redacted diagnostics.',
  });
}

const report = {
  generated_at: new Date().toISOString(),
  scope: 'Weles diagnostics capture, upload, Content Platform/Enterprise rendering references',
  note: 'This audits storage/reporting/capture code paths, not LinkedIn itself. It does not fetch artifact bodies.',
  files: FILES.map((file) => ({ file, exists: !!sources[file] })),
  external_evidence: {
    recordings_storage_audit: storageAudit ? {
      path: storageAudit.path,
      bucket_private: storageAudit.json?.bucket?.public === false,
      object_count: storageAudit.json?.objects_aggregate?.object_count ?? null,
      total_bytes: storageAudit.json?.objects_aggregate?.total_bytes ?? null,
      older_than_7d: storageAudit.json?.objects_aggregate?.older_than_7d ?? null,
      linkedin_register_objects: storageAudit.json?.objects_aggregate?.linkedin_register_objects ?? null,
      explicit_retention_or_lifecycle_policy_found: storageAudit.json?.conclusion?.explicit_retention_or_lifecycle_policy_found ?? null,
      storage_objects_policy_count: storageAudit.json?.storage_policies?.storage_objects_policy_count ?? null,
    } : null,
  },
  findings,
  risks,
  conclusion: {
    page_visible_debug_collection: 'mostly_gated_off_by_default',
    uploaded_artifact_model: 'private_refs_by_default_with_public_escape_hatch',
    storage_bucket_evidence: storageAudit ? {
      bucket_private: storageAudit.json?.bucket?.public === false,
      file_size_limit: storageAudit.json?.bucket?.file_size_limit ?? null,
      explicit_storage_rls_policies_found: storageAudit.json?.conclusion?.explicit_storage_rls_policies_found ?? null,
      explicit_retention_or_lifecycle_policy_found: storageAudit.json?.conclusion?.explicit_retention_or_lifecycle_policy_found ?? null,
      object_count: storageAudit.json?.objects_aggregate?.object_count ?? null,
      total_bytes: storageAudit.json?.objects_aggregate?.total_bytes ?? null,
    } : null,
    sensitive_residuals: [
      'legacy network.ndjson response body excerpts',
      'session_responses_<ts>.json local response body storage',
      'before/after/error DOM HTML',
      'screenshots/video',
      'unused captureEnvironment cookie/localStorage dump API',
    ],
    decisive_next_check: 'After a post-hardening production run, verify result.session.browser_visible_diagnostics flags are false, result.artifacts refs are recordings://, logs include complete_network.ndjson and network.ndjson, and no unexpected .json body dumps are uploaded.',
    reporting_access_control_evidence: {
      content_platform_detail: cpDashboardGuarded ? 'auth + admin_users middleware + account_id/log_id route consistency proven by static audit' : 'not fully proven',
      enterprise_weles_pages: enterpriseWelesGuarded ? 'authenticated Enterprise session required by middleware; row-specific authorization beyond logged-in console user not proven' : 'not fully proven',
      enterprise_latest_success_api: enterpriseApiGuarded ? 'explicit authenticated Enterprise session required because /api is skipped by middleware' : 'not fully proven',
    },
    unresolved_access_control_checks: [
      'Review Enterprise role/row scoping if Weles diagnostics should be limited to a subset of logged-in console users.',
      'Define retention/lifecycle policy for recordings bucket objects and worker-local recordings.',
    ],
  },
};

mkdirSync(OUT_DIR, { recursive: true });
const outPath = join(OUT_DIR, `diagnostics_pipeline_audit_${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
writeFileSync(outPath, JSON.stringify(report, null, 2));
console.log(JSON.stringify({
  outPath,
  finding_count: findings.filter((f) => f.present).length,
  risk_ids: risks.map((r) => r.id),
  missing_files: report.files.filter((f) => !f.exists).map((f) => f.file),
  conclusion: report.conclusion,
}, null, 2));
