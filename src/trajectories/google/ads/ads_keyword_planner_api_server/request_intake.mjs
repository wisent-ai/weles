// What arrives on the wire and what counts as a request: the JSON envelope this
// facade writes back, the size-capped body it is willing to read, the token it
// demands before doing any work, and the two request shapes it accepts — a bare
// keyword volume check and a keyword report brief that names a product.

import { ALLOW_UNAUTH, API_TOKEN, BODY_LIMIT_BYTES, SESSION } from './service_settings.mjs';

export function json(res, status, body) {
  const text = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(text),
  });
  res.end(text);
}

export function readJsonBody(req) {
  return new Promise((resolveBody, rejectBody) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > BODY_LIMIT_BYTES) {
        rejectBody(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        resolveBody(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch (error) {
        rejectBody(new Error(`invalid JSON body: ${error?.message || error}`));
      }
    });
    req.on('error', rejectBody);
  });
}

export function authorized(req) {
  if (ALLOW_UNAUTH) return true;
  if (!API_TOKEN) return false;
  const header = String(req.headers.authorization || '');
  if (header === `Bearer ${API_TOKEN}`) return true;
  const apiKey = String(req.headers['x-api-key'] || '');
  return apiKey === API_TOKEN;
}

export function parseKeywords(value) {
  if (Array.isArray(value)) return [...new Set(value.map((item) => String(item || '').trim()).filter(Boolean))];
  return [...new Set(String(value || '').split(/[\n,]+/).map((item) => item.trim()).filter(Boolean))];
}

export function normalizeCustomerId(value) {
  return String(value || '').replace(/\D/g, '');
}

export function safeSlug(value) {
  return String(value || 'keywords').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80) || 'keywords';
}

export function normalizeKeyword(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

export function validateReportRequest(body) {
  const customerId = normalizeCustomerId(body.customerId || body.customer_id || body.googleAdsCustomerId);
  if (!customerId) throw new Error('customerId required');
  const seedKeywords = parseKeywords(body.seedKeywords || body.seeds || body.keywords || body.keyword)
    .map(normalizeKeyword)
    .filter(Boolean);
  const subject = String(body.subject || body.product || body.niche || body.brief || body.landingPage || body.url || '').trim();
  if (!subject && !seedKeywords.length) throw new Error('subject/product/brief or seedKeywords required');


  return {
    customerId,
    subject,
    product: String(body.product || '').trim(),
    niche: String(body.niche || '').trim(),
    audience: String(body.audience || body.targetAudience || '').trim(),
    landingPage: String(body.landingPage || body.url || '').trim(),
    goal: String(body.goal || 'Find paid search opportunities with real Google Ads Keyword Planner metrics.').trim(),
    seedKeywords,
    session: String(body.session || SESSION),
  };
}

export function validateRequest(body) {
  const customerId = normalizeCustomerId(body.customerId || body.customer_id || body.googleAdsCustomerId);
  const keywords = parseKeywords(body.keywords || body.keyword);
  if (!customerId) throw new Error('customerId required');
  if (!keywords.length) throw new Error('keywords required');
  return {
    customerId,
    keywords,
    session: String(body.session || SESSION),
  };
}
