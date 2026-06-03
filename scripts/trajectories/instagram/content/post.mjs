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
import { humanType } from '../../../../dist/human/keyboard.js';
import { humanClickLocator, humanIdlePause } from '../../../../dist/human/mouse.js';
import { detectInstagramBanSignals } from '../../../../dist/platforms/instagram/ban_signals.js';
import { generatePost } from '../../_shared/llm.mjs';
import { generateImageFile } from '../../_shared/media.mjs';
import { writeFileSync, mkdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { checkReachable } from '../../_shared/action-runner.mjs';
import { runRecordingsDir } from '../../../../dist/session/run-recordings.js';

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
  await humanIdlePause('deliberate');
  const loggedOut = await s.page.evaluate(() => /\/accounts\/login/.test(location.pathname));
  if (loggedOut) throw new Error('not_logged_in: cookies stale — needs instagram_login refresh');

  // Hook filechooser: the Create modal calls input[type=file].click() once
  // we click "Select from computer" — Playwright catches the dialog event
  // and we feed it the generated image path directly.
  s.page.on('filechooser', async (chooser) => {
    try { await chooser.setFiles(imagePath); console.log(`[instagram] filechooser accepted ${imagePath}`); }
    catch (e) { console.log(`[instagram] filechooser err: ${e.message?.slice(0, 80)}`); }
  });

  // 1. Click "Create" in left sidebar (svg aria-label="New post").
  const createBtn = s.page.locator('a[href="#"]:has(svg[aria-label="New post"]), div[role="button"]:has(svg[aria-label="New post"]), a:has-text("Create"):has(svg)').filter({ visible: true }).first();
  await createBtn.waitFor({ state: 'visible' });
  await humanClickLocator(s.page, createBtn);
  await humanIdlePause('short');
  // Some IG variants split into "Post / Reel / Story" submenu.
  const postSubmenu = s.page.locator('a:has-text("Post"), div[role="menuitem"]:has-text("Post"), span:has-text("Post")').filter({ visible: true }).first();
  if (await postSubmenu.isVisible({ timeout: 1500 }).catch(() => false)) {
    await humanClickLocator(s.page, postSubmenu);
    await humanIdlePause('short');
  }
  // 2. Click "Select from computer" inside the Create modal — triggers
  //    filechooser, our hook above attaches the image path.
  const selectBtn = s.page.locator('div[role="dialog"] button:has-text("Select from computer"), [role="dialog"] button:has-text("Select from device")').filter({ visible: true }).first();
  await selectBtn.waitFor({ state: 'visible' });
  await humanClickLocator(s.page, selectBtn);
  // Wait for crop/preview step — image rendered in modal.
  await s.page.locator('div[role="dialog"] img[alt*="image" i], div[role="dialog"] canvas, div[role="dialog"] [style*="background-image"]').first().waitFor({ state: 'visible', timeout: 30000 });
  await humanIdlePause('short');
  // 3. Next (crop) → 4. Next (filter)
  for (let step = 0; step < 2; step++) {
    const next = s.page.locator('div[role="dialog"] button:has-text("Next"), div[role="dialog"] [role="button"]:has-text("Next"), div[role="dialog"] div[role="button"]:has-text("Next")').filter({ visible: true }).first();
    await next.waitFor({ state: 'visible', timeout: 15000 });
    await humanClickLocator(s.page, next);
    await humanIdlePause('short');
  }
  // 5. Fill caption textarea.
  const captionBox = s.page.locator('div[role="dialog"] textarea[aria-label*="caption" i], div[role="dialog"] div[contenteditable="true"][aria-label*="caption" i], div[role="dialog"] textarea').filter({ visible: true }).first();
  await captionBox.waitFor({ state: 'visible' });
  await humanClickLocator(s.page, captionBox);
  await humanType(s.page, caption);
  await humanIdlePause('short');
  // 6. Share.
  const shareBtn = s.page.locator('div[role="dialog"] button:has-text("Share"), div[role="dialog"] [role="button"]:has-text("Share"), div[role="dialog"] div[role="button"]:has-text("Share")').filter({ visible: true }).first();
  await shareBtn.waitFor({ state: 'visible' });
  await humanClickLocator(s.page, shareBtn);
  // Wait for the share to complete — modal closes and "Your post has been shared" appears or modal is gone.
  await s.page.waitForFunction(() => !document.querySelector('div[role="dialog"] button:has-text("Share")') || /Your post has been shared/i.test(document.body.innerText), { timeout: 60000 }).catch(() => {});
  await humanIdlePause('deliberate');
  banSignal = await detectInstagramBanSignals(s.page, s.capturedResponses).catch(() => null);
  console.log(`[ban-signal] ${banSignal?.signal}  PASS: posted`);
} catch (e) {
  banSignal = e.banSignal ?? await detectInstagramBanSignals(s.page, s.capturedResponses).catch(() => null);
  console.log(`[ban-signal] ${banSignal?.signal}  FAIL: ${e.message?.slice(0, 200)}`);
  process.exitCode = 1;
} finally {
  if (banSignal) { try { const dir = runRecordingsDir(`instagram_${ACTION}`); mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, 'ban_signal.json'), JSON.stringify({ account_id: acct.id, username: acct.username, action: `instagram_${ACTION}`, character: character.name, product: product?.name, ...banSignal, ts: new Date().toISOString() }, null, 2)); } catch {} }
  try { unlinkSync(imagePath); } catch {}
  await s.close();
}
