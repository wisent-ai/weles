// What the Apple Ads API page and the local key files say about the API client setup.
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DIAG_DIR, PRIVATE_KEY_PATH, PUBLIC_KEY_PATH } from './settings.mjs';

export function extractValuesNearLabels(text) {
  const compact = String(text || '').replace(/\s+/g, ' ').trim();
  const patterns = {
    clientId: /Client ID\s*[:\-]?\s*([A-Za-z0-9._-]{6,})/i,
    teamId: /Team ID\s*[:\-]?\s*([A-Z0-9]{6,})/i,
    keyId: /Key ID\s*[:\-]?\s*([A-Z0-9]{6,})/i,
  };
  const out = {};
  for (const [key, pattern] of Object.entries(patterns)) {
    const match = compact.match(pattern);
    if (match?.[1]) out[key] = match[1];
  }
  return out;
}

export function summarizeAppleArtifacts(pageState, localState) {
  const frames = Array.isArray(pageState?.frames) ? pageState.frames : [];
  const frameText = frames.map((frame) => frame.text || '').join('\n');
  const text = [pageState?.text || '', frameText].join('\n');
  const values = extractValuesNearLabels(text);
  const buttons = [
    ...(pageState?.buttons || []),
    ...frames.flatMap((frame) => frame.buttons || []),
  ].filter(Boolean);

  const hasCredentialLabels = /Client ID|Team ID|Key ID/i.test(text);
  const hasApiSurface = /API|Public Key|Generate API client|Campaign Management API/i.test(text);
  const hasCreateButton = buttons.some((button) => /Generate API client|Create API client|Add API client|Generate/i.test(button));

  return {
    hasExistingAppleAdsApiClient: hasCredentialLabels,
    hasAppleAdsApiSurface: hasApiSurface,
    canGenerateApiClient: hasCreateButton || /Public Key/i.test(text),
    extracted: values,
    local: localState,
    matchedButtons: buttons.filter((button) => /API|Client|Key|Generate|Create|Public Key/i.test(button)).slice(0, 40),
    textMatches: {
      clientId: /Client ID/i.test(text),
      teamId: /Team ID/i.test(text),
      keyId: /Key ID/i.test(text),
      publicKey: /Public Key/i.test(text),
      generateApiClient: /Generate API client|Create API client|Add API client/i.test(text),
    },
  };
}

export async function inspectExistingAppleAdsApi(page, pageState) {
  const localState = {
    publicKeyPath: PUBLIC_KEY_PATH,
    hasPublicKey: existsSync(PUBLIC_KEY_PATH),
    privateKeyPath: PRIVATE_KEY_PATH,
    hasPrivateKey: existsSync(PRIVATE_KEY_PATH),
    env: {
      hasClientId: Boolean(process.env.ASC_ADS_CLIENT_ID),
      hasTeamId: Boolean(process.env.ASC_ADS_TEAM_ID),
      hasKeyId: Boolean(process.env.ASC_ADS_KEY_ID),
      hasOrgId: Boolean(process.env.ASC_ADS_ORG_ID),
      hasPrivateKeyPath: Boolean(process.env.ASC_ADS_PRIVATE_KEY_PATH),
    },
  };

  const domState = await page.evaluate(() => {
    const norm = (value) => String(value || '').replace(/\s+/g, ' ').trim();
    const visible = (el) => Boolean(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
    const rows = Array.from(document.querySelectorAll('tr, [role="row"], li, section, article'))
      .filter(visible)
      .map((el) => norm(el.innerText || el.textContent))
      .filter((text) => /API|Client|Team ID|Key ID|Public Key|Generate|Create/i.test(text))
      .slice(0, 120);
    const controls = Array.from(document.querySelectorAll('button, [role="button"], a'))
      .filter(visible)
      .map((el) => ({
        text: norm(el.innerText || el.textContent || el.getAttribute('aria-label')),
        href: el.href || '',
      }))
      .filter((item) => /API|Client|Key|Generate|Create|Public Key/i.test(`${item.text} ${item.href}`))
      .slice(0, 120);
    return { rows, controls };
  }).catch((error) => ({ error: error.message, rows: [], controls: [] }));

  const summary = {
    ...summarizeAppleArtifacts(pageState, localState),
    dom: domState,
    url: pageState?.url || page.url?.() || '',
    title: pageState?.title || '',
  };
  const outPath = join(DIAG_DIR, 'apple_ads_api_existing.json');
  writeFileSync(outPath, JSON.stringify(summary, null, 2));
  console.log(`[apple-ads-api-setup] existing_api json=${outPath}`);
  console.log(`[apple-ads-api-setup] existing_api ${JSON.stringify({
    hasExistingAppleAdsApiClient: summary.hasExistingAppleAdsApiClient,
    hasAppleAdsApiSurface: summary.hasAppleAdsApiSurface,
    canGenerateApiClient: summary.canGenerateApiClient,
    extracted: summary.extracted,
    local: summary.local,
  }, null, 2)}`);
  return summary;
}
