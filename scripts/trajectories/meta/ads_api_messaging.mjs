// Meta Marketing API: Messenger/WhatsApp destination ad stack create wrapper.

import { compactObject, graphRequest, parseJsonEnv, submitEnabled, withValidateOnly, adAccountId, microsFromUsd } from './_marketing_api.mjs';

const destination = (process.env.CAMPAIGN_DESTINATION || process.env.DESTINATION_TYPE || 'messenger').toLowerCase();
const campaignName = process.env.CAMPAIGN_NAME || `Wisent Messaging ${new Date().toISOString().slice(0, 19)}`;
const campaignId = process.env.CAMPAIGN_ID;
const adsetId = process.env.AD_SET_ID || process.env.ADSET_ID;
const creativeId = process.env.CREATIVE_ID;

function promotedObject() {
  return compactObject({
    page_id: process.env.PAGE_ID || process.env.FACEBOOK_PAGE_ID || process.env.META_FACEBOOK_PAGE_ID,
    whatsapp_phone_number: process.env.WHATSAPP_NUMBER,
    application_id: process.env.APP_ID,
  });
}

function creativePayload() {
  const ctaType = destination === 'whatsapp' ? 'WHATSAPP_MESSAGE' : 'MESSAGE_PAGE';
  return compactObject({
    name: process.env.CREATIVE_NAME || `${campaignName} creative`,
    object_story_spec: parseJsonEnv('OBJECT_STORY_SPEC_JSON', {
      page_id: process.env.PAGE_ID || process.env.FACEBOOK_PAGE_ID || process.env.META_FACEBOOK_PAGE_ID,
      link_data: compactObject({
        link: process.env.DESTINATION_URL || process.env.FINAL_URL || 'https://www.facebook.com',
        message: process.env.PRIMARY_TEXT,
        name: process.env.HEADLINE,
        call_to_action: {
          type: process.env.CALL_TO_ACTION_TYPE || ctaType,
          value: compactObject({
            app_destination: destination === 'messenger' ? 'MESSENGER' : undefined,
            whatsapp_number: process.env.WHATSAPP_NUMBER,
          }),
        },
        image_hash: process.env.IMAGE_HASH,
      }),
    }),
  });
}


try {
  if (!['messenger', 'whatsapp'].includes(destination)) throw new Error('CAMPAIGN_DESTINATION must be messenger or whatsapp');
  if (!submitEnabled()) throw new Error('SUBMIT=1 required to create Meta messaging stack');
  const campaign = await graphRequest('POST', `/${adAccountId()}/campaigns`, { name: campaignName, objective: process.env.CAMPAIGN_OBJECTIVE || 'OUTCOME_ENGAGEMENT', status: 'PAUSED', special_ad_categories: parseJsonEnv('SPECIAL_AD_CATEGORIES', ['NONE']) }, { submit: true, label: 'meta-ads-api-messaging-campaign' });
  const adset = await graphRequest('POST', `/${adAccountId()}/adsets`, withValidateOnly({ name: process.env.AD_SET_NAME || `${campaignName} ad set`, campaign_id: campaign.id, billing_event: process.env.BILLING_EVENT || 'IMPRESSIONS', optimization_goal: process.env.OPTIMIZATION_GOAL || 'CONVERSATIONS', destination_type: destination.toUpperCase(), daily_budget: microsFromUsd(process.env.DAILY_BUDGET_USD), targeting: parseJsonEnv('TARGETING_JSON', { geo_locations: { countries: ['US'] } }), promoted_object: promotedObject(), status: 'PAUSED' }, { submit: true }), { submit: true, label: 'meta-ads-api-messaging-adset' });
  const creative = await graphRequest('POST', `/${adAccountId()}/adcreatives`, creativePayload(), { submit: true, label: 'meta-ads-api-messaging-creative' });
  const ad = await graphRequest('POST', `/${adAccountId()}/ads`, { name: process.env.AD_NAME || `${campaignName} ad`, adset_id: adset.id, creative: { creative_id: creative.id }, status: 'PAUSED' }, { submit: true, label: 'meta-ads-api-messaging-ad' });
  console.log(`PASS: Meta messaging stack created campaign=${campaign.id} adset=${adset.id} creative=${creative.id} ad=${ad.id}`);
  console.log('PASS: Meta messaging API completed');
} catch (e) {
  console.log('FAIL:', e.message?.slice(0, 1600));
  process.exit(1);
}
