// Google Ads REST API: read campaign performance with GAQL.
//
// Env:
//   GOOGLE_ADS_CUSTOMER_ID      required
//   GOOGLE_ADS_DEVELOPER_TOKEN  required
//   GOOGLE_ADS_ACCESS_TOKEN     optional; falls back to `gcloud auth print-access-token`
//   GOOGLE_ADS_LOGIN_CUSTOMER_ID optional manager account id
//   GOOGLE_ADS_API_VERSION      optional, default v24
//   GOOGLE_ADS_QUERY            optional GAQL query
//   DATE_PRESET                 optional when using default query, default LAST_7_DAYS
//   CAMPAIGN_ID                 optional filter when using default query

import { customerId, googleAdsPost } from './_api.mjs';

const cid = customerId();
const datePreset = process.env.DATE_PRESET || 'LAST_7_DAYS';
const campaignFilter = process.env.CAMPAIGN_ID ? ` AND campaign.id = ${String(process.env.CAMPAIGN_ID).replace(/\D/g, '')}` : '';
const query = process.env.GOOGLE_ADS_QUERY || `
  SELECT
    campaign.id,
    campaign.name,
    campaign.status,
    metrics.impressions,
    metrics.clicks,
    metrics.cost_micros,
    metrics.conversions,
    metrics.conversions_value,
    segments.date
  FROM campaign
  WHERE segments.date DURING ${datePreset}${campaignFilter}
  ORDER BY segments.date DESC
  LIMIT 1000
`;

try {
  console.log(`[google-ads-performance] customer=${cid} query=${query.replace(/\s+/g, ' ').trim()}`);
  const json = await googleAdsPost(`/customers/${cid}/googleAds:searchStream`, { query });
  console.log(JSON.stringify(json, null, 2).slice(0, 20000));
  console.log('PASS: Google Ads performance read completed');
} catch (e) {
  console.log('FAIL:', e.message?.slice(0, 1200));
  process.exit(1);
}
