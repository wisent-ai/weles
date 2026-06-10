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
//   SUBMIT                      must be "1" to set ENABLED.

import { customerId, googleAdsPost, microsFromUsd } from './_api.mjs';

const cid = customerId();
const campaignResourceName = process.env.CAMPAIGN_RESOURCE_NAME
  || (process.env.CAMPAIGN_ID ? `customers/${cid}/campaigns/${String(process.env.CAMPAIGN_ID).replace(/\D/g, '')}` : null);
const campaignName = process.env.CAMPAIGN_NAME;
const status = process.env.STATUS?.toUpperCase();
const submit = process.env.SUBMIT === '1';
const updateMask = process.env.UPDATE_MASK;

if (!campaignResourceName) {
  console.log('FAIL: CAMPAIGN_ID or CAMPAIGN_RESOURCE_NAME required');
  process.exit(1);
}
if (status === 'ENABLED' && !submit) {
  console.log('FAIL: refusing to enable campaign without SUBMIT=1');
  process.exit(1);
}

try {
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
  }

  if (!masks.length && !process.env.DAILY_BUDGET_USD) {
    console.log('FAIL: nothing to update; set CAMPAIGN_NAME, STATUS, or DAILY_BUDGET_USD');
    process.exit(1);
  }
  console.log(`PASS: Google Ads campaign update completed (${campaignResourceName})`);
} catch (e) {
  console.log('FAIL:', e.message?.slice(0, 1200));
  process.exit(1);
}
