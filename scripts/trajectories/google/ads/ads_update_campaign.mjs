// Google Ads REST API: update an existing campaign and optionally its budget.
//
// Env:
//   GOOGLE_ADS_CUSTOMER_ID      required
//   GOOGLE_ADS_DEVELOPER_TOKEN  required
//   GOOGLE_ADS_ACCESS_TOKEN     optional; falls back to `gcloud auth print-access-token`
//   GOOGLE_ADS_LOGIN_CUSTOMER_ID optional manager account id
//   GOOGLE_ADS_API_VERSION      optional, default v24
//   CAMPAIGN_ID                 required unless CAMPAIGN_RESOURCE_NAME is set
//   CAMPAIGN_RESOURCE_NAME      optional full customers/<id>/campaigns/<id>
//   CAMPAIGN_NAME               optional new name
//   STATUS                      optional PAUSED | ENABLED | REMOVED
//   UPDATE_MASK                 optional explicit mask; otherwise inferred
//   DAILY_BUDGET_USD            optional; requires CAMPAIGN_BUDGET_ID or CAMPAIGN_BUDGET_RESOURCE_NAME
//   CAMPAIGN_BUDGET_ID          optional budget id
//   CAMPAIGN_BUDGET_RESOURCE_NAME optional full customers/<id>/campaignBudgets/<id>
//   AD_GROUP_ID                 optional ad group id for ad group updates
//   AD_GROUP_RESOURCE_NAME      optional full customers/<id>/adGroups/<id>
//   AD_GROUP_NAME               optional new ad group name
//   AD_GROUP_STATUS             optional ENABLED | PAUSED | REMOVED
//   CPC_BID_USD                 optional ad group CPC bid
//   AD_ID                       optional ad id for ad updates
//   AD_GROUP_AD_RESOURCE_NAME   optional full customers/<id>/adGroupAds/<ad_group>~<ad>
//   AD_STATUS                   optional ENABLED | PAUSED | REMOVED
//   SUBMIT                      must be "1" to set ENABLED.

import { customerId, googleAdsPost, microsFromUsd } from './_api.mjs';

const cid = customerId();
const campaignResourceName = process.env.CAMPAIGN_RESOURCE_NAME
  || (process.env.CAMPAIGN_ID ? `customers/${cid}/campaigns/${String(process.env.CAMPAIGN_ID).replace(/\D/g, '')}` : null);
const campaignName = process.env.CAMPAIGN_NAME;
const status = process.env.STATUS?.toUpperCase();
const adGroupStatus = process.env.AD_GROUP_STATUS?.toUpperCase();
const adStatus = process.env.AD_STATUS?.toUpperCase();
const submit = process.env.SUBMIT === '1';
const updateMask = process.env.UPDATE_MASK;

const hasBudgetTarget = !!process.env.DAILY_BUDGET_USD;
const hasAdGroupTarget = !!(process.env.AD_GROUP_ID || process.env.AD_GROUP_RESOURCE_NAME);
const hasAdTarget = !!(process.env.AD_ID || process.env.AD_GROUP_AD_RESOURCE_NAME);

if (!campaignResourceName && !hasBudgetTarget && !hasAdGroupTarget && !hasAdTarget) {
  console.log('FAIL: set a campaign, budget, ad group, or ad target');
  process.exit(1);
}
if (status === 'ENABLED' && !submit) {
  console.log('FAIL: refusing to enable campaign without SUBMIT=1');
  process.exit(1);
}
if ((adGroupStatus === 'ENABLED' || adStatus === 'ENABLED') && !submit) {
  console.log('FAIL: refusing to enable ad group/ad without SUBMIT=1');
  process.exit(1);
}

try {
  let didUpdate = false;
  if (campaignResourceName) {
    const campaignUpdate = { resourceName: campaignResourceName };
    const masks = [];
    if (campaignName) { campaignUpdate.name = campaignName; masks.push('name'); }
    if (status) { campaignUpdate.status = status; masks.push('status'); }
    if (masks.length) {
      const body = {
        operations: [{ update: campaignUpdate, updateMask: updateMask || masks.join(',') }],
        partialFailure: false,
      };
      console.log(`[google-ads-update] campaign ${campaignResourceName} mask=${body.operations[0].updateMask}`);
      const json = await googleAdsPost(`/customers/${cid}/campaigns:mutate`, body);
      console.log(JSON.stringify(json, null, 2).slice(0, 12000));
      didUpdate = true;
    }
  } else if (campaignName || status || updateMask) {
    console.log('FAIL: campaign fields require CAMPAIGN_ID or CAMPAIGN_RESOURCE_NAME');
    process.exit(1);
  }

  if (process.env.DAILY_BUDGET_USD) {
    const budgetResourceName = process.env.CAMPAIGN_BUDGET_RESOURCE_NAME
      || (process.env.CAMPAIGN_BUDGET_ID ? `customers/${cid}/campaignBudgets/${String(process.env.CAMPAIGN_BUDGET_ID).replace(/\D/g, '')}` : null);
    if (!budgetResourceName) {
      console.log('FAIL: DAILY_BUDGET_USD requires CAMPAIGN_BUDGET_ID or CAMPAIGN_BUDGET_RESOURCE_NAME');
      process.exit(1);
    }
    const body = {
      operations: [{
        update: { resourceName: budgetResourceName, amountMicros: microsFromUsd(process.env.DAILY_BUDGET_USD) },
        updateMask: 'amount_micros',
      }],
      partialFailure: false,
    };
    console.log(`[google-ads-update] budget ${budgetResourceName} amount=${process.env.DAILY_BUDGET_USD} USD`);
    const json = await googleAdsPost(`/customers/${cid}/campaignBudgets:mutate`, body);
    console.log(JSON.stringify(json, null, 2).slice(0, 12000));
    didUpdate = true;
  }

  if (process.env.AD_GROUP_ID || process.env.AD_GROUP_RESOURCE_NAME) {
    const adGroupResourceName = process.env.AD_GROUP_RESOURCE_NAME
      || `customers/${cid}/adGroups/${String(process.env.AD_GROUP_ID).replace(/\D/g, '')}`;
    const adGroupUpdate = { resourceName: adGroupResourceName };
    const adGroupMasks = [];
    if (process.env.AD_GROUP_NAME) { adGroupUpdate.name = process.env.AD_GROUP_NAME; adGroupMasks.push('name'); }
    if (adGroupStatus) { adGroupUpdate.status = adGroupStatus; adGroupMasks.push('status'); }
    if (process.env.CPC_BID_USD) { adGroupUpdate.cpcBidMicros = microsFromUsd(process.env.CPC_BID_USD); adGroupMasks.push('cpc_bid_micros'); }
    if (adGroupMasks.length) {
      const body = {
        operations: [{ update: adGroupUpdate, updateMask: adGroupMasks.join(',') }],
        partialFailure: false,
      };
      console.log(`[google-ads-update] ad group ${adGroupResourceName} mask=${body.operations[0].updateMask}`);
      const json = await googleAdsPost(`/customers/${cid}/adGroups:mutate`, body);
      console.log(JSON.stringify(json, null, 2).slice(0, 12000));
      didUpdate = true;
    }
  }

  if (process.env.AD_ID || process.env.AD_GROUP_AD_RESOURCE_NAME) {
    const adGroupAdResourceName = process.env.AD_GROUP_AD_RESOURCE_NAME
      || (process.env.AD_GROUP_ID && process.env.AD_ID
        ? `customers/${cid}/adGroupAds/${String(process.env.AD_GROUP_ID).replace(/\D/g, '')}~${String(process.env.AD_ID).replace(/\D/g, '')}`
        : null);
    if (!adGroupAdResourceName) {
      console.log('FAIL: AD_ID updates require AD_GROUP_ID or AD_GROUP_AD_RESOURCE_NAME');
      process.exit(1);
    }
    if (adStatus) {
      const body = {
        operations: [{ update: { resourceName: adGroupAdResourceName, status: adStatus }, updateMask: 'status' }],
        partialFailure: false,
      };
      console.log(`[google-ads-update] ad ${adGroupAdResourceName} status=${adStatus}`);
      const json = await googleAdsPost(`/customers/${cid}/adGroupAds:mutate`, body);
      console.log(JSON.stringify(json, null, 2).slice(0, 12000));
      didUpdate = true;
    }
  }

  if (!didUpdate) {
    console.log('FAIL: nothing to update; set campaign, budget, ad group, or ad fields');
    process.exit(1);
  }
  console.log(`PASS: Google Ads update completed (${campaignResourceName || 'resource-level target'})`);
} catch (e) {
  console.log('FAIL:', e.message?.slice(0, 1200));
  process.exit(1);
}
