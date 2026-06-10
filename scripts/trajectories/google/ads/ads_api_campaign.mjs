// Google Ads REST API: validate or create a complete Search campaign.
//
// Env:
//   GOOGLE_ADS_CUSTOMER_ID       required
//   GOOGLE_ADS_DEVELOPER_TOKEN   required
//   GOOGLE_ADS_ACCESS_TOKEN      optional; falls back to `gcloud auth print-access-token`
//   GOOGLE_ADS_LOGIN_CUSTOMER_ID optional manager account id
//   GOOGLE_ADS_API_VERSION       optional, default v24
//   CAMPAIGN_NAME                optional, defaults to timestamped name
//   AD_GROUP_NAME                optional
//   AD_NAME                      optional
//   DAILY_BUDGET_USD             optional, default 10
//   FINAL_URL                    required unless DESTINATION_URL is set
//   HEADLINES                    optional pipe-separated responsive-search headlines
//   DESCRIPTIONS                 optional pipe-separated responsive-search descriptions
//   KEYWORDS                     optional comma-separated keywords
//   CPC_BID_USD                  optional ad group CPC bid
//   SUBMIT                       must be "1" to create resources. Default is validateOnly.

import { customerId, googleAdsMutate, microsFromUsd } from './_api.mjs';

const cid = customerId();
const submit = process.env.SUBMIT === '1';
const campaignName = process.env.CAMPAIGN_NAME || `Wisent Search ${new Date().toISOString().slice(0, 19)}`;
const adGroupName = process.env.AD_GROUP_NAME || process.env.AD_SET_NAME || `${campaignName} ad group`;
const adName = process.env.AD_NAME || `${campaignName} responsive search ad`;
const finalUrl = process.env.FINAL_URL || process.env.DESTINATION_URL;
const budgetUsd = process.env.DAILY_BUDGET_USD || '10';
const cpcBidUsd = process.env.CPC_BID_USD;
const keywords = (process.env.KEYWORDS || 'wisent ai,representation engineering,ai observability')
  .split(',')
  .map((v) => v.trim())
  .filter(Boolean);

const headlineTexts = (process.env.HEADLINES || process.env.HEADLINE || 'Wisent AI|Representation Engineering|AI With Character')
  .split('|')
  .map((v) => v.trim())
  .filter(Boolean)
  .slice(0, 15);
const descriptionTexts = (process.env.DESCRIPTIONS || process.env.DESCRIPTION || 'Build, inspect, and steer AI behavior with Wisent.|Representation engineering tools for production AI teams.')
  .split('|')
  .map((v) => v.trim())
  .filter(Boolean)
  .slice(0, 4);

if (!finalUrl) {
  console.log('FAIL: FINAL_URL or DESTINATION_URL required');
  process.exit(1);
}
if (headlineTexts.length < 3) {
  console.log('FAIL: responsive search ad needs at least 3 headlines');
  process.exit(1);
}
if (descriptionTexts.length < 2) {
  console.log('FAIL: responsive search ad needs at least 2 descriptions');
  process.exit(1);
}
if (!keywords.length) {
  console.log('FAIL: at least one keyword required');
  process.exit(1);
}

const budgetResource = `customers/${cid}/campaignBudgets/-1`;
const campaignResource = `customers/${cid}/campaigns/-2`;
const adGroupResource = `customers/${cid}/adGroups/-3`;

const mutateOperations = [
  {
    campaignBudgetOperation: {
      create: {
        resourceName: budgetResource,
        name: `${campaignName} budget ${Date.now()}`,
        amountMicros: microsFromUsd(budgetUsd),
        deliveryMethod: 'STANDARD',
        explicitlyShared: false,
      },
    },
  },
  {
    campaignOperation: {
      create: {
        resourceName: campaignResource,
        name: campaignName,
        status: 'PAUSED',
        advertisingChannelType: 'SEARCH',
        campaignBudget: budgetResource,
        manualCpc: {},
        networkSettings: {
          targetGoogleSearch: true,
          targetSearchNetwork: true,
          targetContentNetwork: false,
          targetPartnerSearchNetwork: false,
        },
        containsEuPoliticalAdvertising: 'DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING',
      },
    },
  },
  {
    adGroupOperation: {
      create: {
        resourceName: adGroupResource,
        name: adGroupName,
        campaign: campaignResource,
        status: 'ENABLED',
        type: 'SEARCH_STANDARD',
        ...(cpcBidUsd ? { cpcBidMicros: microsFromUsd(cpcBidUsd) } : {}),
      },
    },
  },
  ...keywords.map((keyword) => ({
    adGroupCriterionOperation: {
      create: {
        adGroup: adGroupResource,
        status: 'ENABLED',
        keyword: {
          text: keyword,
          matchType: process.env.KEYWORD_MATCH_TYPE || 'BROAD',
        },
      },
    },
  })),
  {
    adGroupAdOperation: {
      create: {
        adGroup: adGroupResource,
        status: 'PAUSED',
        ad: {
          name: adName,
          finalUrls: [finalUrl],
          responsiveSearchAd: {
            headlines: headlineTexts.map((text) => ({ text })),
            descriptions: descriptionTexts.map((text) => ({ text })),
          },
        },
      },
    },
  },
];

try {
  console.log(`[google-ads-api-campaign] customer=${cid} submit=${submit} campaign=${JSON.stringify(campaignName)}`);
  const json = await googleAdsMutate(cid, mutateOperations, { validateOnly: !submit });
  console.log(JSON.stringify(json, null, 2).slice(0, 20000));
  if (submit) {
    console.log(`PASS: Google Ads Search campaign created paused (${campaignName})`);
  } else {
    console.log(`PASS: Google Ads Search campaign validateOnly completed (${campaignName})`);
  }
} catch (e) {
  console.log('FAIL:', e.message?.slice(0, 1600));
  process.exit(1);
}
