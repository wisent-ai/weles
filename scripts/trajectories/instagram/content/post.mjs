/**
 * Instagram original-post trajectory. Unlike text-only platforms, IG requires
 * a media attachment — we generate one via the content-platform's /api/worker/
 * media/image route (ComfyUI), then drive the Create-post flow on
 * instagram.com to upload + caption + share.
 *
 * Organic vs promote is controlled by env POST_PROMOTE (same as other posts).
 * The generated image prompt pulls from the character's niche so the media
 * matches the persona visually.
 */
import { getSocialAccount, resolveAccountSession } from '../../../../dist/utils/credentials.js';
import { WSession } from '../../../../dist/session/wsession.js';
import { execute } from '../../../../dist/agent/loop.js';
import { detectInstagramBanSignals } from '../../../../dist/platforms/instagram/ban_signals.js';
import { generatePost } from '../../_shared/llm.mjs';
import { generateImageFile } from '../../_shared/media.mjs';
import { writeFileSync, mkdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { checkReachable } from '../../_shared/action-runner.mjs';

const ACTION = process.env.POST_PROMOTE === '1' ? 'post_promote' : 'post';

async function fetchSupabase(path) {
  const url = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
  if (!url || !key) return null;
  const r = await fetch(`${url}/rest/v1/${path}`, { headers: { apikey: key, Authorization: `Bearer ${key}` } });
  return r.ok ? r.json() : null;
}

const acct = await getSocialAccount('instagram');
if (!acct) { console.log('FAIL: no active instagram account'); process.exit(1); }

const rows = await fetchSupabase(`character_social_accounts?social_account_id=eq.${acct.id}&select=characters(id,name,bio,personality,niche,promoted_product_id,promotion_config)&limit=1`);
const character = rows?.[0]?.characters;
if (!character) { console.log('FAIL: no character linked'); process.exit(1); }

let product = null;
if (ACTION === 'post_promote') {
  const productId = process.env.PRODUCT_ID || character.promoted_product_id;
  if (!productId) { console.log('FAIL: no product configured for post_promote'); process.exit(1); }
  const pr = await fetchSupabase(`products?id=eq.${productId}&select=name,description,url&limit=1`);
  product = pr?.[0] ?? null;
  if (!product) { console.log('FAIL: product not found'); process.exit(1); }
}

const personaCtx = { name: character.name, bio: character.bio, personality: character.personality, niche: character.niche };
const caption = process.env.SVC_TEXT || await generatePost({ persona: personaCtx, surface: 'instagram', product });
console.log(`[instagram:${ACTION}] caption: ${caption.slice(0, 120)}...`);

// Image prompt — niche-driven aesthetic, no product overlay (captions do the promo).
const imagePrompt = process.env.IMAGE_PROMPT || `${character.niche ?? 'casual lifestyle'} photo, authentic amateur aesthetic, natural lighting, mobile phone camera, candid composition, no text or logos`;
const imagePath = await generateImageFile({
  prompt: imagePrompt,
  width: 1024, height: 1024,
  character_id: character.id, account_id: acct.id,
});
console.log(`[instagram:${ACTION}] image file: ${imagePath}`);

const { proxyUrl, persona } = await resolveAccountSession(acct);
const s = await WSession.start({ label: `instagram_${ACTION}`, proxy: proxyUrl, persona });
let banSignal = null;
try {
  const cookies = (acct.metadata?.cookies ?? []).filter(c => (c.domain ?? '').includes('instagram.com'));
  if (cookies.length) await s.ctx.addCookies(cookies).catch(() => {});
  await s.goto('https://www.instagram.com/');
  checkReachable(s, 'instagram');
  await s.page.waitForTimeout(4000);
  const loggedOut = await s.page.evaluate(() => /\/accounts\/login/.test(location.pathname));
  if (loggedOut) throw new Error('not_logged_in: cookies stale — needs instagram_login refresh');

  // The Create modal is behind a "+" icon in the left nav. Agent drives it.
  const goal = `You are on instagram.com logged in as ${acct.username}. Do the following in order:\n1. Find the "Create" button in the left sidebar (plus icon, labelled "Create"). Click it. A "Create new post" dropdown may appear — if so, click "Post".\n2. A file-picker dialog opens. The image file at ${imagePath} will be attached programmatically by the test harness — you do NOT need to click select-from-computer; instead wait for the image preview to appear in the modal.\n3. Click "Next" on the crop/filter step to skip to caption step.\n4. Click "Next" on the filter step (do not apply a filter).\n5. Click the caption textarea (labelled "Write a caption...") and type exactly: ${caption}\n6. Click the "Share" button at the top-right of the modal.\nAfter the modal closes and the feed shows the new post, done(value="posted"). Do NOT navigate() manually.`;

  // Pre-hook: attach the file to any input[type=file] that appears. Playwright
  // can chain setInputFiles before the element exists via fileChooser event.
  s.page.on('filechooser', async (chooser) => {
    try { await chooser.setFiles(imagePath); console.log(`[instagram] filechooser accepted ${imagePath}`); }
    catch (e) { console.log(`[instagram] filechooser err: ${e.message?.slice(0, 80)}`); }
  });

  const result = await execute(s, goal, {}); // no flow cache — caption is per-tick
  banSignal = await detectInstagramBanSignals(s.page, s.capturedResponses).catch(() => null);
  console.log(`[ban-signal] ${banSignal?.signal}  PASS: ${result.value}`);
} catch (e) {
  banSignal = await detectInstagramBanSignals(s.page, s.capturedResponses).catch(() => null);
  console.log(`[ban-signal] ${banSignal?.signal}  FAIL: ${e.message?.slice(0, 200)}`);
  process.exitCode = 1;
} finally {
  if (banSignal) { try { const dir = join(process.cwd(), 'recordings', `instagram_${ACTION}`); mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, 'ban_signal.json'), JSON.stringify({ account_id: acct.id, username: acct.username, action: `instagram_${ACTION}`, character: character.name, product: product?.name, ...banSignal, ts: new Date().toISOString() }, null, 2)); } catch {} }
  try { unlinkSync(imagePath); } catch {}
  await s.close();
}
