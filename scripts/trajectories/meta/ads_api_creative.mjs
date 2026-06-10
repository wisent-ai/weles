// Meta Marketing API: creative asset upload and ad creative wrapper.

import { adAccountId, compactObject, graphRequest, graphUpload, parseJsonEnv, submitEnabled, withValidateOnly } from './_marketing_api.mjs';

const RESOURCE = (process.env.RESOURCE || 'creative').toLowerCase();
const ACTION = (process.env.ACTION_KIND || process.env.META_ACTION || 'create').toLowerCase();
const CREATIVE_ID = process.env.CREATIVE_ID;

function objectStorySpec() {
  return parseJsonEnv('OBJECT_STORY_SPEC_JSON', compactObject({
    page_id: process.env.PAGE_ID || process.env.FACEBOOK_PAGE_ID || process.env.META_FACEBOOK_PAGE_ID,
    instagram_actor_id: process.env.INSTAGRAM_ACTOR_ID,
    link_data: process.env.DESTINATION_URL || process.env.FINAL_URL ? compactObject({
      link: process.env.DESTINATION_URL || process.env.FINAL_URL,
      message: process.env.PRIMARY_TEXT,
      name: process.env.HEADLINE,
      description: process.env.DESCRIPTION,
      image_hash: process.env.IMAGE_HASH,
      call_to_action: process.env.CALL_TO_ACTION_TYPE ? {
        type: process.env.CALL_TO_ACTION_TYPE,
        value: compactObject({
          link: process.env.DESTINATION_URL || process.env.FINAL_URL,
          whatsapp_number: process.env.WHATSAPP_NUMBER,
          app_link: process.env.APP_LINK,
        }),
      } : undefined,
    }) : undefined,
    video_data: parseJsonEnv('VIDEO_DATA_JSON'),
    template_data: parseJsonEnv('TEMPLATE_DATA_JSON'),
  }));
}

function creativePayload() {
  return compactObject({
    name: process.env.CREATIVE_NAME || process.env.AD_NAME,
    object_story_spec: objectStorySpec(),
    asset_feed_spec: parseJsonEnv('ASSET_FEED_SPEC_JSON'),
    product_set_id: process.env.PRODUCT_SET_ID,
    url_tags: process.env.URL_PARAMS,
  });
}

try {
  if (RESOURCE === 'image') {
    if (ACTION !== 'create' && ACTION !== 'upload') throw new Error('RESOURCE=image supports ACTION=create/upload');
    if (!process.env.IMAGE_PATH) throw new Error('IMAGE_PATH required');
    await graphUpload(`/${adAccountId()}/adimages`, {}, 'filename', process.env.IMAGE_PATH, { label: 'meta-ads-api-image' });
  } else if (RESOURCE === 'video') {
    if (ACTION !== 'create' && ACTION !== 'upload') throw new Error('RESOURCE=video supports ACTION=create/upload');
    if (!process.env.VIDEO_PATH) throw new Error('VIDEO_PATH required');
    await graphUpload(`/${adAccountId()}/advideos`, compactObject({ title: process.env.VIDEO_TITLE, description: process.env.DESCRIPTION }), 'source', process.env.VIDEO_PATH, { label: 'meta-ads-api-video' });
  } else if (RESOURCE === 'creative') {
    if (ACTION === 'create') {
      await graphRequest('POST', `/${adAccountId()}/adcreatives`, withValidateOnly(creativePayload()), { label: 'meta-ads-api-creative' });
    } else if (ACTION === 'read' || ACTION === 'list') {
      const path = CREATIVE_ID ? `/${CREATIVE_ID}` : `/${adAccountId()}/adcreatives`;
      await graphRequest('GET', path, { fields: process.env.FIELDS || 'id,name,status,object_story_spec,effective_object_story_id', limit: process.env.LIMIT || 50 }, { dryRun: !submitEnabled() && process.env.LIVE_READ !== '1', label: 'meta-ads-api-creative-read' });
    } else if (ACTION === 'delete') {
      if (!CREATIVE_ID) throw new Error('CREATIVE_ID required for delete');
      await graphRequest('DELETE', `/${CREATIVE_ID}`, {}, { label: 'meta-ads-api-creative-delete' });
    } else {
      throw new Error(`unsupported creative ACTION=${ACTION}`);
    }
  } else {
    throw new Error('RESOURCE must be creative, image, or video');
  }
  console.log(`PASS: Meta creative API ${ACTION} ${RESOURCE} completed`);
} catch (e) {
  console.log('FAIL:', e.message?.slice(0, 1600));
  process.exit(1);
}
