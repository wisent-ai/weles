import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runRecordingsDir } from '../../../dist/session/run-recordings.js';
import { runSemanticScholarKeyFollowup } from '../../../dist/secrets/semantic-scholar-followup.js';

const sourceActionLogId = process.env.SOURCE_ACTION_LOG_ID || process.env.source_action_log_id || process.env.SEMANTIC_SCHOLAR_SOURCE_ACTION_LOG_ID || '';
const attemptRaw = process.env.ATTEMPT || process.env.attempt || '0';
const attempt = Number.parseInt(attemptRaw, 10) || 0;
const tenantId = process.env.SEMANTIC_SCHOLAR_TENANT_ID || null;

const result = await runSemanticScholarKeyFollowup(sourceActionLogId || undefined, attempt, tenantId);
const dir = runRecordingsDir(process.env.ACTION_LOG_ID || 'semanticscholar_key_followup', process.env.ACTION || 'semanticscholar_key_followup');
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, 'service_action_result.json'), JSON.stringify({ semantic_scholar_key_followup: result }, null, 2));

if (!['pending', 'validated'].includes(result.status)) {
  console.error(`FAIL: ${result.status}: ${result.reason}`);
  process.exit(1);
}

console.log(JSON.stringify({
  status: result.status,
  validated: result.validated,
  service_credential_id: 'service_credential_id' in result ? result.service_credential_id : undefined,
  next_scheduled_at: 'next_scheduled_at' in result ? result.next_scheduled_at : undefined,
}));
