/**
 * Shared action runner. Drives browse / organic_comment / promote across
 * every platform from a per-platform config.
 *
 * Config shape:
 *   platform:       string ('twitter' | 'instagram' | ...)
 *   action:         'browse' | 'organic_comment' | 'promote'
 *   feedUrl:        string | () => string — the landing URL for this action
 *   scrolls:        number — how many idle scrolls for browse
 *   banDetector:    async (page, responses) => BanSignal
 *   commentGoal:    string — prompt text for the agent loop when action is comment/promote
 *
 * Reads character + product context from the DB as needed. Writes
 * recordings/<platform>_<action>/ban_signal.json.
 */
import { getSocialAccount, resolveAccountSession } from '../../../dist/utils/credentials.js';
import { WSession } from '../../../dist/session/wsession.js';
import { execute } from '../../../dist/agent/loop.js';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

async function fetchSupabase(path) {
  const url = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
  if (!url || !key) return null;
  const r = await fetch(`${url}/rest/v1/${path}`, { headers: { apikey: key, Authorization: `Bearer ${key}` } });
  if (!r.ok) return null;
  return r.json();
}

async function genComment({ character, product, variant, surfaceLabel, postTitle, postBody, maxTokens }) {
  const sys = [
    { type: 'text', text: `You are ${character.name}. Bio: ${character.bio ?? ''}. Personality: ${character.personality ?? ''}. Niche: ${character.niche ?? ''}. You write like a real person — informal, lowercase-friendly, no marketing language. Don't start with "Wow"/"Great post". Don't sign your messages.`, cache_control: { type: 'ephemeral' } },
    product
      ? { type: 'text', text: `You use ${product.name} (${product.description ?? ''}). Write a 1-3 sentence comment relevant to the post that authentically reflects your experience. Do NOT sound like an advertisement. Do NOT use phrases like "highly recommend", "game changer", "you should try", or "perfect for". ${variant === 'link' ? 'If a link feels natural you may include a brief reference.' : 'Mention the product by name only.'}` }
      : { type: 'text', text: 'Write a 1-2 sentence reaction to the post. Do not reference any products, brands, or services.' },
  ];
  const r = await fetch(process.env.LLM_API_URL || 'https://api.wisentmedia.com/api/llm/messages', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'claude-sonnet-4-5-20250929', max_tokens: maxTokens ?? 200,
      system: sys,
      messages: [{ role: 'user', content: `[${surfaceLabel}] ${postTitle}${postBody ? `\n\n${postBody.slice(0, 600)}` : ''}` }],
    }),
  });
  if (!r.ok) throw new Error(`LLM ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const data = await r.json();
  const text = (data.content?.find(b => b.type === 'text')?.text || '').trim();
  if (!text) throw new Error('LLM returned empty content');
  return text;
}

export async function runAction(cfg) {
  const acct = await getSocialAccount(cfg.platform);
  if (!acct) { console.log(`FAIL: no active ${cfg.platform} account`); process.exit(1); }

  let character = null, product = null;
  if (cfg.action !== 'browse') {
    const rows = await fetchSupabase(`character_social_accounts?social_account_id=eq.${acct.id}&select=characters(name,bio,personality,niche,handle,promoted_product_id,promotion_config)&limit=1`);
    character = rows?.[0]?.characters ?? null;
    if (!character) { console.log('FAIL: no character linked'); process.exit(1); }
  }
  if (cfg.action === 'promote') {
    const productId = process.env.PRODUCT_ID || character?.promoted_product_id;
    if (!productId) { console.log('FAIL: no product configured'); process.exit(1); }
    const pr = await fetchSupabase(`products?id=eq.${productId}&select=name,description&limit=1`);
    product = pr?.[0] ?? null;
    if (!product) { console.log('FAIL: product not found'); process.exit(1); }
  }
  console.log(`[${cfg.platform}:${cfg.action}] acct=${acct.username}${character ? ` character=${character.name}` : ''}${product ? ` product=${product.name}` : ''}`);

  const { proxyUrl, persona } = await resolveAccountSession(acct);
  const label = `${cfg.platform}_${cfg.action}`;
  const s = await WSession.start({ label, proxy: proxyUrl, persona });
  let banSignal = null;
  let resultValue = null;
  try {
    const feed = typeof cfg.feedUrl === 'function' ? cfg.feedUrl(acct.username) : cfg.feedUrl;
    await s.goto(feed);

    if (cfg.action === 'browse') {
      for (let i = 0; i < (cfg.scrolls ?? 6); i++) {
        await s.page.evaluate(() => window.scrollBy(0, window.innerHeight * (0.6 + Math.random() * 0.6)));
        await s.page.waitForTimeout(900 + Math.floor(Math.random() * 1400));
      }
      resultValue = `scrolled ${cfg.scrolls ?? 6}x`;
    } else {
      // Comment / promote path — LLM generates text and agent loop submits.
      const surfaceLabel = typeof cfg.surfaceLabel === 'function' ? cfg.surfaceLabel(acct, feed) : (cfg.surfaceLabel ?? feed);
      const { postTitle, postBody } = await (cfg.pickPost?.(s) ?? Promise.resolve({ postTitle: '', postBody: '' }));
      const text = await genComment({
        character, product,
        variant: (process.env.VARIANT || character?.promotion_config?.variant || 'mention').toLowerCase(),
        surfaceLabel, postTitle, postBody,
        maxTokens: cfg.action === 'promote' ? 240 : 160,
      });
      console.log(`[comment-text] ${text.slice(0, 140)}...`);
      const goal = cfg.commentGoal(text);
      const r = await execute(s, goal, { flowName: label });
      resultValue = r.value;
    }
    banSignal = await cfg.banDetector(s.page, s.capturedResponses).catch(() => null);
    console.log(`[ban-signal] ${banSignal?.signal}`);
    console.log(`PASS: ${resultValue}`);
  } catch (e) {
    banSignal = await cfg.banDetector(s.page, s.capturedResponses).catch(() => null);
    if (banSignal) console.log(`[ban-signal] ${banSignal.signal}`);
    console.log('FAIL:', e.message?.slice(0, 200));
    process.exitCode = 1;
  } finally {
    if (banSignal) {
      try {
        const dir = join(process.cwd(), 'recordings', label);
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, 'ban_signal.json'), JSON.stringify({ account_id: acct.id, username: acct.username, action: label, ...banSignal, ts: new Date().toISOString() }, null, 2));
      } catch (e) { console.log('[ban-signal] persist err:', e.message); }
    }
    await s.close();
  }
}
