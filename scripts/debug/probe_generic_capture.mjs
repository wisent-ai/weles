// Manual probe of the generic_capture / generic_accessibility_audit contract:
// route resolution, the env payload dispatch produces, and every refusal
// sentence. Run: node scripts/debug/probe_generic_capture.mjs
import { paramsToEnv, resolveTrajectory } from '../../dist/worker/dispatch.js';
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runRecordingsDir } from '../../dist/session/run-recordings.js';

const good = {
  batch: 'landing-2026-08-19',
  site_slug: '04-linear',
  source_url: 'https://linear.app/',
  axis: 'composition',
  viewport: { width: 1440, height: 1000, device_scale_factor: 1 },
  full_page: false,
  steps: [{ op: 'wait_selector', value: 'main' }, { op: 'scroll', value: '1200' }],
  record_seconds: 0,
  artifact_prefix: 'stado://weles-captures/landing-2026-08-19/04-linear/composition/',
};

const capturePath = resolveTrajectory('generic_capture');
const auditPath = resolveTrajectory('generic_accessibility_audit');
console.log('route generic_capture             =', capturePath);
console.log('route generic_accessibility_audit =', auditPath);
console.log('env  generic_capture              =', JSON.stringify(paramsToEnv(good, 'generic_capture', capturePath)));
console.log('env  generic_accessibility_audit  =', JSON.stringify(paramsToEnv({
  batch: good.batch, site_slug: good.site_slug, source_url: good.source_url,
  viewport: good.viewport,
  artifact_prefix: 'stado://weles-captures/landing-2026-08-19/04-linear/accessibility/',
}, 'generic_accessibility_audit', auditPath)));

const refusals = [
  ['unknown axis', { ...good, axis: 'vibes' }],
  ['missing source_url', { ...good, source_url: undefined }],
  ['unknown step op', { ...good, steps: [{ op: 'teleport', value: 'x' }] }],
  ['record_seconds over 120', { ...good, record_seconds: 121 }],
  ['artifact_prefix outside namespace', { ...good, artifact_prefix: 'stado://weles/landing/04-linear/' }],
  ['artifact_prefix without trailing slash', { ...good, artifact_prefix: 'stado://weles-captures/landing/04-linear' }],
  ['bad viewport', { ...good, viewport: { width: 10, height: 1000 } }],
  ['bad device scale factor', { ...good, viewport: { width: 1440, height: 1000, device_scale_factor: 9 } }],
  ['missing batch', { ...good, batch: undefined }],
];
for (const [name, params] of refusals) {
  try {
    paramsToEnv(params, 'generic_capture', capturePath);
    console.log(`NO REFUSAL for ${name}`);
  } catch (error) {
    console.log(`refusal ${name}: ${error.message}`);
  }
}
for (const [name, params] of [
  ['audit missing source_url', { batch: good.batch, site_slug: good.site_slug, viewport: good.viewport, artifact_prefix: 'stado://weles-captures/a/b/' }],
  ['audit prefix outside namespace', { batch: good.batch, site_slug: good.site_slug, source_url: good.source_url, viewport: good.viewport, artifact_prefix: 'stado://weles/a/b/' }],
]) {
  try {
    paramsToEnv(params, 'generic_accessibility_audit', auditPath);
    console.log(`NO REFUSAL for ${name}`);
  } catch (error) {
    console.log(`refusal ${name}: ${error.message}`);
  }
}

// The upload half, exercised against a loopback stand-in for the Stado product
// object API: the exact URI the action addresses, and the fact that a rejected
// upload fails the action instead of passing silently.
const observed = [];
let rejectNext = false;
const server = createServer((request, response) => {
  const uri = new URL(request.url, 'http://127.0.0.1').searchParams.get('uri');
  observed.push({ method: request.method, uri, contentType: request.headers['content-type'] });
  request.resume();
  request.on('end', () => {
    if (rejectNext) { response.writeHead(503).end('object store unavailable'); return; }
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ uri }));
  });
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
process.env.STADO_API_URL = `http://127.0.0.1:${server.address().port}`;
process.env.WELES_STADO_OBJECT_API_TOKEN = 'probe-token-with-at-least-32-bytes-of-length';
const { captureKeyPrefix, fileAttribution, pngPixelSize, uploadCaptureObject } = await import('../trajectories/_shared/capture-runtime.mjs');

const keyPrefix = captureKeyPrefix(good.artifact_prefix);
console.log('key prefix                        =', keyPrefix);
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAUAAAAECAYAAABGYNriAAAAFElEQVR4nGP4z8Dwn4GBgYGBgQEAHkoDpAF6cwAAAABJRU5ErkJggg==', 'base64');
const pngPath = join(mkdtempSync(join(runRecordingsDir('probe_generic_capture'), 'still-')), 'probe.png');
writeFileSync(pngPath, png);
const attribution = fileAttribution(pngPath);
console.log('png pixel size                    =', JSON.stringify(pngPixelSize(attribution.buffer)));
console.log('png attribution                   =', JSON.stringify({ bytes: attribution.bytes, sha256: attribution.sha256 }));
console.log('upload still                      =', await uploadCaptureObject(keyPrefix, 'probe.png', attribution.buffer, 'image/png'));
console.log('upload sidecar                    =', await uploadCaptureObject(keyPrefix, 'probe.png.json', '{}', 'application/json'));
rejectNext = true;
try {
  await uploadCaptureObject(keyPrefix, 'probe.png', attribution.buffer, 'image/png');
  console.log('NO REFUSAL for a rejected upload');
} catch (error) {
  console.log(`refusal rejected upload: ${error.message}`);
}
try {
  await uploadCaptureObject('landing/../escape/', 'probe.png', attribution.buffer, 'image/png');
  console.log('NO REFUSAL for a traversing key');
} catch (error) {
  console.log(`refusal traversing key: ${error.message}`);
}
console.log('observed requests                 =', JSON.stringify(observed));
server.close();
