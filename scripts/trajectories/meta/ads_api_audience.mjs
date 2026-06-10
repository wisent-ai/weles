// Meta Marketing API: custom audience and lookalike audience wrapper.

import { adAccountId, compactObject, graphRequest, parseJsonEnv, submitEnabled, withValidateOnly } from './_marketing_api.mjs';

const ACTION = (process.env.ACTION_KIND || process.env.META_ACTION || 'create').toLowerCase();
const AUDIENCE_ID = process.env.AUDIENCE_ID || process.env.CUSTOM_AUDIENCE_ID;
const subtype = (process.env.AUDIENCE_SUBTYPE || (process.env.LOOKALIKE_SOURCE_ID ? 'LOOKALIKE' : 'CUSTOM')).toUpperCase();

function payload() {
  return compactObject({
    name: process.env.AUDIENCE_NAME || process.env.NAME,
    description: process.env.DESCRIPTION,
    subtype,
    customer_file_source: process.env.CUSTOMER_FILE_SOURCE || (subtype === 'CUSTOM' ? 'USER_PROVIDED_ONLY' : undefined),
    rule: parseJsonEnv('AUDIENCE_RULE_JSON'),
    retention_days: process.env.RETENTION_DAYS ? Number(process.env.RETENTION_DAYS) : undefined,
    lookalike_spec: parseJsonEnv('LOOKALIKE_SPEC_JSON', process.env.LOOKALIKE_SOURCE_ID ? compactObject({
      type: process.env.LOOKALIKE_TYPE || 'similarity',
      ratio: process.env.LOOKALIKE_RATIO ? Number(process.env.LOOKALIKE_RATIO) : undefined,
      country: process.env.LOOKALIKE_COUNTRY || process.env.COUNTRY,
      origin: [{ id: process.env.LOOKALIKE_SOURCE_ID }],
    }) : undefined),
  });
}

try {
  if (ACTION === 'create') {
    await graphRequest('POST', `/${adAccountId()}/customaudiences`, withValidateOnly(payload(), { validateOnly: false }), { label: 'meta-ads-api-audience' });
  } else if (ACTION === 'update') {
    if (!AUDIENCE_ID) throw new Error('AUDIENCE_ID or CUSTOM_AUDIENCE_ID required for update');
    await graphRequest('POST', `/${AUDIENCE_ID}`, withValidateOnly(payload(), { validateOnly: false }), { label: 'meta-ads-api-audience-update' });
  } else if (ACTION === 'read' || ACTION === 'list') {
    const path = AUDIENCE_ID ? `/${AUDIENCE_ID}` : `/${adAccountId()}/customaudiences`;
    await graphRequest('GET', path, { fields: process.env.FIELDS || 'id,name,subtype,description,delivery_status,operation_status,time_created', limit: process.env.LIMIT || 50 }, { dryRun: !submitEnabled() && process.env.LIVE_READ !== '1', label: 'meta-ads-api-audience-read' });
  } else if (ACTION === 'delete') {
    if (!AUDIENCE_ID) throw new Error('AUDIENCE_ID or CUSTOM_AUDIENCE_ID required for delete');
    await graphRequest('DELETE', `/${AUDIENCE_ID}`, {}, { label: 'meta-ads-api-audience-delete' });
  } else {
    throw new Error(`unsupported ACTION=${ACTION}`);
  }
  console.log(`PASS: Meta audience API ${ACTION} completed`);
} catch (e) {
  console.log('FAIL:', e.message?.slice(0, 1600));
  process.exit(1);
}
