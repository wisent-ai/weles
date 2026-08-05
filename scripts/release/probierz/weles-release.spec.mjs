import { test, expect, chromium, firefox, request as playwrightRequest } from '@playwright/test';
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';

const manifestPath = process.env.PROBIERZ_BUILD_PATH;
if (!manifestPath) throw new Error('PROBIERZ_BUILD_PATH must name the deployment manifest');
const manifestBytes = await readFile(manifestPath);
const manifest = JSON.parse(manifestBytes.toString('utf8'));
const manifestSha256 = createHash('sha256').update(manifestBytes).digest('hex');

async function requireExecutable(name) {
  const path = process.env[name]?.trim();
  if (!path) throw new Error(`${name} is required`);
  const metadata = await stat(path);
  if (!metadata.isFile()) throw new Error(`${name} is not a regular file`);
  return path;
}

test('web candidate reports the exact deployment contract', async ({ request }) => {
  const response = await request.get('/api/v1/version');
  expect(response.ok()).toBe(true);
  const version = await response.json();
  expect(version.schema).toBe('weles.version.v1');
  expect(version.service).toBe('weles-web');
  expect(version.sourceRevision).toBe(manifest.web.sourceRevision);
  if (version.deploymentManifestSha256 !== null) {
    expect(version.deploymentManifestSha256).toBe(manifestSha256);
  }
  expect(version.database.schemaVersion).toBe(manifest.database.schemaVersion);
  expect(new Set(version.apiSchemas)).toEqual(new Set(manifest.web.apiSchemas));
});

test('worker candidate reports the exact deployment contract', async () => {
  const workerUrl = process.env.WELES_WORKER_URL?.trim();
  const token = process.env.WELES_WORKER_API_TOKEN?.trim();
  if (!workerUrl) throw new Error('WELES_WORKER_URL is required');
  if (!token) throw new Error('WELES_WORKER_API_TOKEN is required');
  const context = await playwrightRequest.newContext({
    baseURL: workerUrl,
    extraHTTPHeaders: { Authorization: `Bearer ${token}` },
  });
  try {
    const health = await context.get('/healthz');
    expect(health.ok()).toBe(true);
    expect((await health.json()).ok).toBe(true);
    const response = await context.get('/worker/version');
    expect(response.ok()).toBe(true);
    const version = await response.json();
    expect(version.ok).toBe(true);
    expect(version.identity.release.deployment_manifest_sha256).toBe(manifestSha256);
    expect(version.identity.release.source_revision).toBe(manifest.worker.sourceRevision);
    expect(version.identity.release.worker_version).toBe(manifest.worker.version);
    expect(version.identity.release.database_schema_version).toBe(manifest.database.schemaVersion);
    expect(new Set(version.identity.release.api_schemas)).toEqual(new Set(manifest.web.apiSchemas));
  } finally {
    await context.dispose();
  }
});

test('Chromium candidate launches from the installed exact path', async ({}, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium', 'one launch proves the candidate executable');
  const executablePath = await requireExecutable('WELES_CHROMIUM_BIN');
  const browser = await chromium.launch({ executablePath, headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent('<title>weles-release-probe</title>');
    await expect(page).toHaveTitle('weles-release-probe');
    expect(await page.evaluate(() => navigator.userAgent.length)).toBeGreaterThan(0);
  } finally {
    await browser.close();
  }
});

test('Firefox candidate launches from the installed exact path', async ({}, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium', 'one launch proves the candidate executable');
  const executablePath = await requireExecutable('WELES_FIREFOX_BIN');
  const browser = await firefox.launch({ executablePath, headless: true });
  try {
    const page = await browser.newPage({ viewport: null });
    await page.setContent('<title>weles-release-probe</title>');
    await expect(page).toHaveTitle('weles-release-probe');
    expect(await page.evaluate(() => navigator.userAgent.length)).toBeGreaterThan(0);
  } finally {
    await browser.close();
  }
});
