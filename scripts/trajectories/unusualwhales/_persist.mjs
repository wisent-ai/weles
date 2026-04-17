// Shared persistence helper for UW scrape trajectories.
// Uploads screenshot PNG to GCS (via gcloud storage cp) and inserts a row into
// the Supabase stock_context table via REST. Both scrape.mjs and chart.mjs use
// this after a successful scrape to populate the shared cache consumed by the
// Rust trading-tools agent.

import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

const GCS_BUCKET = 'wisent-stock-context';

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`missing env ${name}`);
  return v;
}

function isoStamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function uploadScreenshot(ticker, page, screenshotPath) {
  if (!screenshotPath || !fs.existsSync(screenshotPath)) {
    return { key: null, url: null };
  }
  const stat = fs.statSync(screenshotPath);
  if (!stat.isFile() || stat.size === 0) {
    return { key: null, url: null };
  }
  const key = `${ticker}/${page}/${isoStamp()}.png`;
  const gsUrl = `gs://${GCS_BUCKET}/${key}`;
  const res = spawnSync('gcloud', ['storage', 'cp', screenshotPath, gsUrl], {
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
  });
  if (res.status !== 0) {
    throw new Error(`gcloud storage cp failed (${res.status}): ${res.stderr || res.stdout}`);
  }
  return { key, url: gsUrl };
}

async function insertRow(row) {
  const base = requireEnv('SUPABASE_URL').replace(/\/$/, '');
  const key = requireEnv('SUPABASE_SERVICE_ROLE_KEY');
  const endpoint = `${base}/rest/v1/stock_context`;
  const resp = await fetch(endpoint, {
    method: 'POST',
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    },
    body: JSON.stringify(row),
  });
  const text = await resp.text();
  if (!resp.ok) {
    throw new Error(`supabase insert failed: ${resp.status} ${text}`);
  }
  const arr = JSON.parse(text);
  if (!Array.isArray(arr) || arr.length === 0) {
    throw new Error(`supabase insert returned unexpected body: ${text}`);
  }
  return arr[0];
}

/**
 * Persist a scrape result to GCS + Supabase.
 *
 * @param {object} params
 * @param {string} params.ticker - uppercase ticker
 * @param {string} params.page - overview|flow|darkpool|gex|chart
 * @param {string} [params.tab] - optional sub-tab label (chart.mjs)
 * @param {object} params.data - scraped data jsonb payload
 * @param {string} [params.screenshotPath] - local PNG path to upload
 * @param {object} [params.metadata] - extra jsonb metadata
 * @returns {Promise<{id: string, gcs_key: string|null, gcs_url: string|null}>}
 */
export async function persistContext({ ticker, page, tab, data, screenshotPath, metadata }) {
  if (!ticker) throw new Error('persistContext: ticker required');
  if (!page) throw new Error('persistContext: page required');

  const { key: gcsKey, url: gcsUrl } = uploadScreenshot(ticker, page, screenshotPath);

  const row = {
    ticker,
    page,
    data: data ?? {},
    metadata: metadata ?? {},
  };
  if (tab) row.tab = tab;
  if (gcsKey) row.screenshot_gcs_key = gcsKey;
  if (gcsUrl) row.screenshot_gcs_url = gcsUrl;

  const inserted = await insertRow(row);
  return { id: inserted.id, gcs_key: gcsKey, gcs_url: gcsUrl };
}
