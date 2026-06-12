// Meta Marketing API: dedicated campaign/ad set/ad stack wrapper.
//
// SUBMIT=0 prints/validates requests. SUBMIT=1 mutates using META_ACCESS_TOKEN.
// Set RESOURCE=campaign|adset|ad|stack and ACTION=create|update|read|delete.

import {
  adAccountId,
  boolEnv,
  compactObject,
  graphRequest,
  microsFromUsd,
  parseJsonEnv,
  splitList,
  submitEnabled,
  withValidateOnly,
} from './_marketing_api.mjs';

const RESOURCE = (process.env.RESOURCE || process.env.META_RESOURCE || 'stack').toLowerCase();
const ACTION = (process.env.ACTION_KIND || process.env.META_ACTION || 'create').toLowerCase();
const SUBMIT = submitEnabled();

const CAMPAIGN_ID = process.env.CAMPAIGN_ID;
const AD_SET_ID = process.env.AD_SET_ID || process.env.ADSET_ID;
const AD_ID = process.env.AD_ID;
const CREATIVE_ID = process.env.CREATIVE_ID;

const campaignName = process.env.CAMPAIGN_NAME || `Wisent ${new Date().toISOString().slice(0, 19)}`;
const objective = process.env.CAMPAIGN_OBJECTIVE || 'OUTCOME_TRAFFIC';
const status = (process.env.STATUS || 'PAUSED').toUpperCase();
const specialAdCategories = parseJsonEnv('SPECIAL_AD_CATEGORIES', splitList(process.env.SPECIAL_AD_CATEGORIES || 'NONE'));

const campaignCreate = () => compactObject({
  name: campaignName,
  objective,
  status,
  special_ad_categories: specialAdCategories,
  buying_type: process.env.BUYING_TYPE,
  bid_strategy: process.env.CAMPAIGN_BID_STRATEGY || (RESOURCE === 'campaign' || process.env.CAMPAIGN_DAILY_BUDGET_USD || process.env.CAMPAIGN_LIFETIME_BUDGET_USD ? process.env.BID_STRATEGY : undefined),
  daily_budget: microsFromUsd(process.env.CAMPAIGN_DAILY_BUDGET_USD || (RESOURCE === 'campaign' ? process.env.DAILY_BUDGET_USD : undefined)),
  lifetime_budget: microsFromUsd(process.env.CAMPAIGN_LIFETIME_BUDGET_USD || (RESOURCE === 'campaign' ? process.env.LIFETIME_BUDGET_USD : undefined)),
  is_adset_budget_sharing_enabled: process.env.IS_ADSET_BUDGET_SHARING_ENABLED || (!process.env.CAMPAIGN_DAILY_BUDGET_USD && !process.env.CAMPAIGN_LIFETIME_BUDGET_USD ? false : undefined),
});

const targeting = () => parseJsonEnv('TARGETING_JSON', compactObject({
  geo_locations: parseJsonEnv('GEO_LOCATIONS_JSON', process.env.COUNTRIES ? { countries: splitList(process.env.COUNTRIES) } : undefined),
  age_min: process.env.AGE_MIN ? Number(process.env.AGE_MIN) : undefined,
  age_max: process.env.AGE_MAX ? Number(process.env.AGE_MAX) : undefined,
  genders: parseJsonEnv('GENDERS_JSON', process.env.GENDERS ? splitList(process.env.GENDERS).map(Number) : undefined),
  custom_audiences: parseJsonEnv('CUSTOM_AUDIENCES_JSON', process.env.CUSTOM_AUDIENCE_ID ? [{ id: process.env.CUSTOM_AUDIENCE_ID }] : undefined),
  excluded_custom_audiences: parseJsonEnv('EXCLUDED_CUSTOM_AUDIENCES_JSON'),
  publisher_platforms: process.env.PUBLISHER_PLATFORMS ? splitList(process.env.PUBLISHER_PLATFORMS) : undefined,
  facebook_positions: process.env.FACEBOOK_POSITIONS ? splitList(process.env.FACEBOOK_POSITIONS) : undefined,
  instagram_positions: process.env.INSTAGRAM_POSITIONS ? splitList(process.env.INSTAGRAM_POSITIONS) : undefined,
  audience_network_positions: process.env.AUDIENCE_NETWORK_POSITIONS ? splitList(process.env.AUDIENCE_NETWORK_POSITIONS) : undefined,
  messenger_positions: process.env.MESSENGER_POSITIONS ? splitList(process.env.MESSENGER_POSITIONS) : undefined,
}));

const promotedObject = () => parseJsonEnv('PROMOTED_OBJECT_JSON', compactObject({
  application_id: process.env.APP_ID,
  object_store_url: process.env.OBJECT_STORE_URL,
  page_id: process.env.PROMOTED_PAGE_ID || (boolEnv('PROMOTED_OBJECT_USES_PAGE', false) ? (process.env.PAGE_ID || process.env.FACEBOOK_PAGE_ID || process.env.META_FACEBOOK_PAGE_ID) : undefined),
  pixel_id: process.env.PIXEL_ID,
  custom_event_type: process.env.APP_EVENT || process.env.CUSTOM_EVENT_TYPE,
  product_catalog_id: process.env.CATALOG_ID,
  product_set_id: process.env.PRODUCT_SET_ID,
  whatsapp_phone_number: process.env.WHATSAPP_NUMBER,
}));

const adSetCreate = (campaignId = CAMPAIGN_ID) => compactObject({
  name: process.env.AD_SET_NAME || `${campaignName} ad set`,
  campaign_id: campaignId,
  status: process.env.AD_SET_STATUS || 'PAUSED',
  daily_budget: microsFromUsd(process.env.AD_SET_DAILY_BUDGET_USD || process.env.DAILY_BUDGET_USD),
  lifetime_budget: microsFromUsd(process.env.AD_SET_LIFETIME_BUDGET_USD || process.env.LIFETIME_BUDGET_USD),
  bid_amount: microsFromUsd(process.env.BID_AMOUNT_USD),
  bid_strategy: process.env.BID_STRATEGY || 'LOWEST_COST_WITHOUT_CAP',
  billing_event: process.env.BILLING_EVENT || 'IMPRESSIONS',
  optimization_goal: process.env.OPTIMIZATION_GOAL || 'LINK_CLICKS',
  destination_type: process.env.CAMPAIGN_DESTINATION || process.env.DESTINATION_TYPE,
  targeting: targeting(),
  promoted_object: promotedObject(),
  start_time: process.env.START_TIME,
  end_time: process.env.END_TIME,
});

const objectStorySpec = () => parseJsonEnv('OBJECT_STORY_SPEC_JSON', compactObject({
  page_id: process.env.PAGE_ID || process.env.FACEBOOK_PAGE_ID || process.env.META_FACEBOOK_PAGE_ID,
  instagram_actor_id: process.env.INSTAGRAM_ACTOR_ID,
  link_data: parseJsonEnv('LINK_DATA_JSON', process.env.DESTINATION_URL || process.env.FINAL_URL ? compactObject({
    link: process.env.DESTINATION_URL || process.env.FINAL_URL,
    message: process.env.PRIMARY_TEXT,
    name: process.env.HEADLINE,
    description: process.env.DESCRIPTION,
    call_to_action: process.env.CALL_TO_ACTION_TYPE ? {
      type: process.env.CALL_TO_ACTION_TYPE,
      value: compactObject({
        link: process.env.DESTINATION_URL || process.env.FINAL_URL,
        app_link: process.env.APP_LINK,
        page: process.env.CALL_TO_ACTION_PAGE_ID,
        whatsapp_number: process.env.WHATSAPP_NUMBER,
      }),
    } : undefined,
    image_hash: process.env.IMAGE_HASH,
    child_attachments: parseJsonEnv('CHILD_ATTACHMENTS_JSON'),
  }) : undefined),
  template_data: parseJsonEnv('TEMPLATE_DATA_JSON'),
  video_data: parseJsonEnv('VIDEO_DATA_JSON'),
}));

const creativeCreate = () => compactObject({
  name: process.env.CREATIVE_NAME || process.env.AD_NAME || `${campaignName} creative`,
  object_story_spec: objectStorySpec(),
  asset_feed_spec: parseJsonEnv('ASSET_FEED_SPEC_JSON'),
  product_set_id: process.env.PRODUCT_SET_ID,
  url_tags: process.env.URL_PARAMS,
});

const adCreate = (adSetId = AD_SET_ID, creativeId = CREATIVE_ID) => compactObject({
  name: process.env.AD_NAME || `${campaignName} ad`,
  adset_id: adSetId,
  creative: creativeId ? { creative_id: creativeId } : parseJsonEnv('CREATIVE_JSON'),
  status: process.env.AD_STATUS || 'PAUSED',
  tracking_specs: parseJsonEnv('TRACKING_SPECS_JSON'),
});

async function createResource(resource) {
  if (resource === 'campaign') return graphRequest('POST', `/${adAccountId()}/campaigns`, withValidateOnly(campaignCreate()), { label: 'meta-ads-api-campaign' });
  if (resource === 'adset') return graphRequest('POST', `/${adAccountId()}/adsets`, withValidateOnly(adSetCreate()), { label: 'meta-ads-api-adset' });
  if (resource === 'creative') return graphRequest('POST', `/${adAccountId()}/adcreatives`, withValidateOnly(creativeCreate()), { label: 'meta-ads-api-creative' });
  if (resource === 'ad') return graphRequest('POST', `/${adAccountId()}/ads`, withValidateOnly(adCreate()), { label: 'meta-ads-api-ad' });
  throw new Error(`unsupported create RESOURCE=${resource}`);
}

async function updateResource(resource) {
  const fields = parseJsonEnv('UPDATE_JSON', compactObject({
    name: process.env.CAMPAIGN_NAME || process.env.AD_SET_NAME || process.env.AD_NAME,
    status: process.env.STATUS || process.env.AD_SET_STATUS || process.env.AD_STATUS,
    bid_strategy: process.env.BID_STRATEGY,
    daily_budget: microsFromUsd(process.env.DAILY_BUDGET_USD),
    lifetime_budget: microsFromUsd(process.env.LIFETIME_BUDGET_USD),
    targeting: process.env.TARGETING_JSON ? targeting() : undefined,
  }));
  const id = resource === 'campaign' ? CAMPAIGN_ID : resource === 'adset' ? AD_SET_ID : resource === 'ad' ? AD_ID : CREATIVE_ID;
  if (!id) throw new Error(`${resource.toUpperCase()} id required for update`);
  return graphRequest('POST', `/${id}`, withValidateOnly(fields), { label: `meta-ads-api-${resource}-update` });
}

async function readResource(resource) {
  const id = resource === 'campaign' ? CAMPAIGN_ID : resource === 'adset' ? AD_SET_ID : resource === 'ad' ? AD_ID : CREATIVE_ID;
  const fields = process.env.FIELDS || 'id,name,status,effective_status,created_time,updated_time';
  if (id) return graphRequest('GET', `/${id}`, { fields }, { dryRun: !SUBMIT && !boolEnv('LIVE_READ', false), label: `meta-ads-api-${resource}-read` });
  return graphRequest('GET', `/${adAccountId()}/${resource === 'adset' ? 'adsets' : resource === 'creative' ? 'adcreatives' : `${resource}s`}`, { fields, limit: process.env.LIMIT || 50 }, { dryRun: !SUBMIT && !boolEnv('LIVE_READ', false), label: `meta-ads-api-${resource}-list` });
}

async function deleteResource(resource) {
  const id = resource === 'campaign' ? CAMPAIGN_ID : resource === 'adset' ? AD_SET_ID : resource === 'ad' ? AD_ID : CREATIVE_ID;
  if (!id) throw new Error(`${resource.toUpperCase()} id required for delete`);
  return graphRequest('DELETE', `/${id}`, {}, { label: `meta-ads-api-${resource}-delete` });
}

async function createStack() {
  if (!SUBMIT) {
    const campaign = campaignCreate();
    const adset = adSetCreate('<campaign_id>');
    const creative = creativeCreate();
    const ad = adCreate('<adset_id>', '<creative_id>');
    console.log('[meta-ads-api-stack] SUBMIT=0 dry run');
    console.log(JSON.stringify({ campaign, adset, creative, ad }, null, 2).slice(0, 20000));
    console.log('PASS: Meta Ads API stack dry run completed');
    return;
  }
  const campaign = await graphRequest('POST', `/${adAccountId()}/campaigns`, campaignCreate(), { label: 'meta-ads-api-campaign', submit: true });
  const campaignId = campaign.id;
  const adset = await graphRequest('POST', `/${adAccountId()}/adsets`, adSetCreate(campaignId), { label: 'meta-ads-api-adset', submit: true });
  const creative = await graphRequest('POST', `/${adAccountId()}/adcreatives`, creativeCreate(), { label: 'meta-ads-api-creative', submit: true });
  const ad = await graphRequest('POST', `/${adAccountId()}/ads`, adCreate(adset.id, creative.id), { label: 'meta-ads-api-ad', submit: true });
  console.log(`PASS: Meta Ads API stack created campaign=${campaignId} adset=${adset.id} creative=${creative.id} ad=${ad.id}`);
}

try {
  if (RESOURCE === 'stack') {
    if (ACTION !== 'create') throw new Error('RESOURCE=stack supports ACTION=create only');
    await createStack();
  } else if (ACTION === 'create') await createResource(RESOURCE);
  else if (ACTION === 'update') await updateResource(RESOURCE);
  else if (ACTION === 'read' || ACTION === 'list') await readResource(RESOURCE);
  else if (ACTION === 'delete') await deleteResource(RESOURCE);
  else throw new Error(`unsupported ACTION=${ACTION}`);
  if (RESOURCE !== 'stack') console.log(`PASS: Meta Ads API ${ACTION} ${RESOURCE} completed`);
} catch (e) {
  console.log('FAIL:', e.message?.slice(0, 2000));
  process.exit(1);
}
