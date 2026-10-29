// What counts as a Keyword Planner request: the two request shapes it
// accepts — a bare keyword volume check and a keyword report brief that names
// a product. Callers are admitted, bodies read and answers written by the
// API's shared exchange (`src/worker/weles-api-server/http-exchange.mjs`). The
// customer id and keywords are read by the shared request readers
// (`../request.mjs`); a field a request does not carry stays absent.

import { SESSION } from './service_settings.mjs';
import { customerIdOf, keywordsOf, squash } from '../request.mjs';

/** A file-name fragment of `value`: lowercase letters and digits joined by dashes. */
export function safeSlug(value) {
  return value
    .toLowerCase()
    .replace(/[^a-z\d]+/g, '-')
    .replace(/^-|-$/g, '');
}

/** One keyword with its whitespace squashed; anything but text is refused. */
export function normalizeKeyword(value) {
  if (typeof value !== 'string')
    throw new Error(`keyword ${JSON.stringify(value)} is not text`);
  return squash(value);
}

/** The first of `values` that is non-blank text, trimmed; null when none is. */
function statedField(...values) {
  const found = values.find(
    (value) => typeof value === 'string' && value.trim(),
  );
  return found ? found.trim() : null;
}

function requestCustomer(body) {
  return customerIdOf(
    body.customerId || body.customer_id || body.googleAdsCustomerId,
    'the request (customerId)',
  );
}

export function validateReportRequest(body) {
  const customerId = requestCustomer(body);
  const seeds =
    body.seedKeywords || body.seeds || body.keywords || body.keyword;
  const seedKeywords = seeds
    ? keywordsOf(seeds, 'the request (seedKeywords)')
    : [];
  const subject = statedField(
    body.subject,
    body.product,
    body.niche,
    body.brief,
    body.landingPage,
    body.url,
  );
  if (!subject && !seedKeywords.length)
    throw new Error('subject/product/brief or seedKeywords required');

  return {
    customerId,
    subject,
    product: statedField(body.product),
    niche: statedField(body.niche),
    audience: statedField(body.audience, body.targetAudience),
    landingPage: statedField(body.landingPage, body.url),
    goal: statedField(body.goal),
    seedKeywords,
    session: requestSession(body),
  };
}

export function validateRequest(body) {
  return {
    customerId: requestCustomer(body),
    keywords: keywordsOf(
      body.keywords || body.keyword,
      'the request (keywords)',
    ),
    session: requestSession(body),
  };
}

// The keeper session whose signed-in browser runs the planner: the request's
// own, or the one this process was configured with; with neither it is refused.
function requestSession(body) {
  if (body.session) return String(body.session);
  if (SESSION) return SESSION;
  throw new Error(
    'session required: name the keeper session (weles keeper) that holds the Google Ads login, in the request or as SESSION / GOOGLE_ADS_KEEPER_SESSION',
  );
}
