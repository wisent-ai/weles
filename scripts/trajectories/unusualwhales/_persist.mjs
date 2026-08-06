// Shared persistence helper for market-data scrape trajectories.
// Trading Tools owns storage and rows; Weles sends one authenticated,
// body-bound ingest request and never receives Trading Tools credentials.

import { createHash, createHmac } from 'node:crypto';
import fs from 'node:fs';

const INGEST_PATH_SUFFIX = '/v1/ingest/stock-context';
const CALLER_ID = 'weles';
const MIN_SECRET_BYTES = Number('32');

function requireEnv(name) {
  const value = String(process.env[name] || '').trim();
  if (!value) throw new Error(`missing env ${name}`);
  return value;
}

function ingestConfig() {
  const rawUrl = requireEnv('TRADING_TOOLS_INGEST_URL');
  const token = requireEnv('TRADING_TOOLS_INGEST_TOKEN');
  const hmacSecret = requireEnv('TRADING_TOOLS_INGEST_HMAC_SECRET');
  if (Buffer.byteLength(token) < MIN_SECRET_BYTES) {
    throw new Error('TRADING_TOOLS_INGEST_TOKEN must contain at least 32 bytes');
  }
  if (Buffer.byteLength(hmacSecret) < MIN_SECRET_BYTES) {
    throw new Error('TRADING_TOOLS_INGEST_HMAC_SECRET must contain at least 32 bytes');
  }
  if (token === hmacSecret) {
    throw new Error('Trading Tools ingest bearer and HMAC secret must be distinct');
  }
  for (const siblingName of ['WELES_STADO_OBJECT_API_TOKEN', 'WELES_STADO_MODEL_ROUTER_TOKEN']) {
    const sibling = String(process.env[siblingName] || '').trim();
    if (sibling && (sibling === token || sibling === hmacSecret)) {
      throw new Error(`Trading Tools ingest credentials must be distinct from ${siblingName}`);
    }
  }
  let endpoint;
  try {
    endpoint = new URL(rawUrl);
  } catch {
    throw new Error('TRADING_TOOLS_INGEST_URL must be a valid URL');
  }
  const loopback = endpoint.hostname === 'localhost' || endpoint.hostname === '127.0.0.1'
    || endpoint.hostname === '::1' || endpoint.hostname === '[::1]';
  if (endpoint.protocol !== 'https:' && !(endpoint.protocol === 'http:' && loopback)) {
    throw new Error('TRADING_TOOLS_INGEST_URL must use HTTPS, except for authenticated loopback HTTP');
  }
  if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash
    || !endpoint.pathname.endsWith(INGEST_PATH_SUFFIX)) {
    throw new Error(`TRADING_TOOLS_INGEST_URL must be a credential-free endpoint ending ${INGEST_PATH_SUFFIX}`);
  }
  return { endpoint: endpoint.toString(), token, hmacSecret };
}

function screenshotBody(screenshotPath) {
  if (!screenshotPath || !fs.existsSync(screenshotPath)) return undefined;
  const stat = fs.statSync(screenshotPath);
  if (!stat.isFile() || !stat.size) return undefined;
  return {
    content_type: 'image/png',
    base64: fs.readFileSync(screenshotPath).toString('base64'),
  };
}

async function ingestStockContext(body) {
  const config = ingestConfig();
  const serialized = JSON.stringify(body);
  const timestamp = String(Math.floor(Date.now() / Number('1000')));
  const bodyDigest = createHash('sha256').update(serialized, 'utf8').digest('hex');
  const signature = createHmac('sha256', config.hmacSecret)
    .update(`${CALLER_ID}:${timestamp}:${bodyDigest}`, 'utf8')
    .digest('hex');
  const response = await fetch(config.endpoint, {
    method: 'POST',
    redirect: 'error',
    headers: {
      Authorization: `Bearer ${config.token}`,
      'Content-Type': 'application/json',
      'x-agent-id': CALLER_ID,
      'x-agent-timestamp': timestamp,
      'x-agent-signature': signature,
    },
    body: serialized,
  });
  const responseText = await response.text();
  if (response.status !== Number('201')) {
    throw new Error(`Trading Tools stock-context ingest failed (${response.status}): ${responseText.slice(0, Number('500'))}`);
  }
  let stored;
  try {
    stored = JSON.parse(responseText);
  } catch {
    throw new Error('Trading Tools stock-context ingest returned invalid JSON');
  }
  if (!stored || typeof stored.id !== 'string' || !stored.id) {
    throw new Error('Trading Tools stock-context ingest returned no row id');
  }
  if (stored.screenshot_uri != null
    && (typeof stored.screenshot_uri !== 'string' || !stored.screenshot_uri.startsWith('stado://trading-tools/stock-context/'))) {
    throw new Error('Trading Tools stock-context ingest returned an invalid screenshot URI');
  }
  return stored;
}

/**
 * Persist a scrape result through the authenticated Trading Tools ingest API.
 *
 * @param {object} params
 * @param {string} params.ticker - uppercase ticker
 * @param {string} params.page - overview|flow|darkpool|gex|chart
 * @param {string} [params.tab] - optional sub-tab label (chart.mjs)
 * @param {object} params.data - scraped data payload
 * @param {string} [params.screenshotPath] - local PNG included in the ingest
 * @param {object} [params.metadata] - extra metadata
 * @returns {Promise<{id: string, screenshot_object_key: string|null, screenshot_uri: string|null, captured_at?: string}>}
 */
export async function persistContext({ ticker, page, tab, data, screenshotPath, metadata }) {
  if (!ticker) throw new Error('persistContext: ticker required');
  if (!page) throw new Error('persistContext: page required');

  const body = {
    ticker,
    page,
    data: data ?? {},
    metadata: metadata ?? {},
  };
  if (tab) body.tab = tab;
  const screenshot = screenshotBody(screenshotPath);
  if (screenshot) body.screenshot = screenshot;

  return await ingestStockContext(body);
}
