// Meta Marketing API: lead generation form wrapper.

import { compactObject, graphRequest, parseJsonEnv, submitEnabled, withValidateOnly } from './_marketing_api.mjs';

const ACTION = (process.env.ACTION_KIND || process.env.META_ACTION || 'create').toLowerCase();
const PAGE_ID = process.env.PAGE_ID || process.env.FACEBOOK_PAGE_ID || process.env.META_FACEBOOK_PAGE_ID;
const FORM_ID = process.env.LEAD_FORM_ID || process.env.FORM_ID;

function payload() {
  return compactObject({
    name: process.env.LEAD_FORM_NAME || process.env.NAME,
    locale: process.env.LOCALE || 'en_US',
    privacy_policy: parseJsonEnv('PRIVACY_POLICY_JSON', process.env.PRIVACY_POLICY_URL ? { url: process.env.PRIVACY_POLICY_URL } : undefined),
    questions: parseJsonEnv('QUESTIONS_JSON'),
    follow_up_action_url: process.env.FOLLOW_UP_ACTION_URL,
    context_card: parseJsonEnv('CONTEXT_CARD_JSON'),
    thank_you_page: parseJsonEnv('THANK_YOU_PAGE_JSON'),
    block_display_for_non_targeted_viewer: process.env.BLOCK_NON_TARGETED_VIEWER,
  });
}

try {
  if (ACTION === 'create') {
    if (!PAGE_ID) throw new Error('PAGE_ID or META_FACEBOOK_PAGE_ID required');
    await graphRequest('POST', `/${PAGE_ID}/leadgen_forms`, withValidateOnly(payload(), { validateOnly: false }), { label: 'meta-ads-api-lead-form' });
  } else if (ACTION === 'read' || ACTION === 'list') {
    const path = FORM_ID ? `/${FORM_ID}` : `/${PAGE_ID}/leadgen_forms`;
    await graphRequest('GET', path, { fields: process.env.FIELDS || 'id,name,status,locale,leads_count,created_time', limit: process.env.LIMIT || 50 }, { dryRun: !submitEnabled() && process.env.LIVE_READ !== '1', label: 'meta-ads-api-lead-form-read' });
  } else if (ACTION === 'update') {
    if (!FORM_ID) throw new Error('LEAD_FORM_ID or FORM_ID required for update');
    await graphRequest('POST', `/${FORM_ID}`, withValidateOnly(payload(), { validateOnly: false }), { label: 'meta-ads-api-lead-form-update' });
  } else {
    throw new Error(`unsupported ACTION=${ACTION}`);
  }
  console.log(`PASS: Meta lead form API ${ACTION} completed`);
} catch (e) {
  console.log('FAIL:', e.message?.slice(0, 1600));
  process.exit(1);
}
