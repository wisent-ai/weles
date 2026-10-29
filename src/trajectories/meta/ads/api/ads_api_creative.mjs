// Meta Marketing API: creative asset upload and ad creative wrapper.

import {
  adAccountId,
  compactObject,
  graphRequest,
  graphUpload,
  parseJsonEnv,
  submitEnabled,
  withValidateOnly,
} from './marketing_api.mjs';
import { statedChoice } from '../../../_shared/inputs/stated.mjs';

const CREATIVE_ID = process.env.CREATIVE_ID;

function objectStorySpec() {
  return parseJsonEnv(
    'OBJECT_STORY_SPEC_JSON',
    compactObject({
      page_id:
        process.env.PAGE_ID ||
        process.env.FACEBOOK_PAGE_ID ||
        process.env.META_FACEBOOK_PAGE_ID,
      instagram_actor_id: process.env.INSTAGRAM_ACTOR_ID,
      link_data:
        process.env.DESTINATION_URL || process.env.FINAL_URL
          ? compactObject({
              link: process.env.DESTINATION_URL || process.env.FINAL_URL,
              message: process.env.PRIMARY_TEXT,
              name: process.env.HEADLINE,
              description: process.env.DESCRIPTION,
              image_hash: process.env.IMAGE_HASH,
              call_to_action: process.env.CALL_TO_ACTION_TYPE
                ? {
                    type: process.env.CALL_TO_ACTION_TYPE,
                    value: compactObject({
                      link:
                        process.env.DESTINATION_URL || process.env.FINAL_URL,
                      whatsapp_number: process.env.WHATSAPP_NUMBER,
                      app_link: process.env.APP_LINK,
                    }),
                  }
                : undefined,
            })
          : undefined,
      video_data: parseJsonEnv('VIDEO_DATA_JSON'),
      template_data: parseJsonEnv('TEMPLATE_DATA_JSON'),
    }),
  );
}

function creativePayload() {
  return compactObject({
    // A creative is named only when the caller names it; Meta names an
    // unnamed one itself, and the ad's name is not borrowed for it.
    name: process.env.CREATIVE_NAME,
    object_story_spec: objectStorySpec(),
    asset_feed_spec: parseJsonEnv('ASSET_FEED_SPEC_JSON'),
    product_set_id: process.env.PRODUCT_SET_ID,
    url_tags: process.env.URL_PARAMS,
  });
}

async function uploadImage() {
  if (!process.env.IMAGE_PATH) throw new Error('IMAGE_PATH required');
  await graphUpload(
    `/${adAccountId()}/adimages`,
    {},
    'filename',
    process.env.IMAGE_PATH,
    { label: 'meta-ads-api-image' },
  );
}

async function uploadVideo() {
  if (!process.env.VIDEO_PATH) throw new Error('VIDEO_PATH required');
  await graphUpload(
    `/${adAccountId()}/advideos`,
    compactObject({
      title: process.env.VIDEO_TITLE,
      description: process.env.DESCRIPTION,
    }),
    'source',
    process.env.VIDEO_PATH,
    { label: 'meta-ads-api-video' },
  );
}

async function readCreative() {
  const path = CREATIVE_ID
    ? `/${CREATIVE_ID}`
    : `/${adAccountId()}/adcreatives`;
  await graphRequest(
    'GET',
    path,
    { fields: process.env.FIELDS, limit: process.env.LIMIT },
    {
      execute: submitEnabled() || process.env.LIVE_READ === '1',
      label: 'meta-ads-api-creative-read',
    },
  );
}

// What each ACTION does to each RESOURCE; `upload` names the same create for
// media, and `list` is a read without a creative id.
const RESOURCES = {
  image: { create: uploadImage, upload: uploadImage },
  video: { create: uploadVideo, upload: uploadVideo },
  creative: {
    async create() {
      await graphRequest(
        'POST',
        `/${adAccountId()}/adcreatives`,
        withValidateOnly(creativePayload()),
        { label: 'meta-ads-api-creative' },
      );
    },
    read: readCreative,
    list: readCreative,
    async delete() {
      if (!CREATIVE_ID) throw new Error('CREATIVE_ID required for delete');
      await graphRequest(
        'DELETE',
        `/${CREATIVE_ID}`,
        {},
        { label: 'meta-ads-api-creative-delete' },
      );
    },
  },
};

const resource = statedChoice(
  ['RESOURCE'],
  RESOURCES,
  'the creative object acted on',
);
const actions = RESOURCES[resource];
const action = statedChoice(
  ['ACTION_KIND', 'META_ACTION'],
  actions,
  `what is done with the ${resource}`,
);
await actions[action]();
console.log(`PASS: Meta creative API ${action} ${resource} completed`);
