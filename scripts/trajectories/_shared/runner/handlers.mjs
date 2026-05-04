// Per-action dispatchers extracted from _shared/action-runner.mjs 2026-05-04
// to bring that file under the 300-line cap so it can adopt
// _shared/linkedin/auth-gate.mjs's runAuthGate (which supports
// cfg.inlineRelogin). Each dispatcher receives the prepared session +
// context and returns resultValue. Mutations stay on s; nothing else is
// shared cross-action.

import { generateOrganicComment, generatePromoteComment, generatePost } from '../llm.mjs';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const REQUIRE_APPROVAL = process.env.REQUIRE_PROMOTE_APPROVAL !== '0';

async function genComment({ character, product, variant, surfaceLabel, postTitle, postBody }) {
  const persona = { name: character.name, bio: character.bio, personality: character.personality, niche: character.niche };
  const post = { surface: surfaceLabel, title: postTitle, body: postBody };
  if (product) return generatePromoteComment({ persona, post, product: { name: product.name, description: product.description, variant } });
  return generateOrganicComment({ persona, post });
}

export async function handleBrowse(s, cfg) {
  for (let i = 0; i < (cfg.scrolls ?? 6); i++) {
    await s.page.evaluate(() => window.scrollBy(0, window.innerHeight * (0.6 + Math.random() * 0.6)));
    await s.page.waitForTimeout(900 + Math.floor(Math.random() * 1400));
  }
  return `scrolled ${cfg.scrolls ?? 6}x`;
}

export async function handlePost(s, cfg, ctx) {
  const { acct, character, product, preapprovedText, label, feed } = ctx;
  let text = preapprovedText;
  if (!text) {
    if (!character) throw new Error('no character — cannot LLM-generate post without persona');
    const personaCtx = { name: character.name, bio: character.bio, personality: character.personality, niche: character.niche };
    text = await generatePost({ persona: personaCtx, surface: cfg.platform, product: product ?? undefined });
    console.log(`[post-text] ${text.slice(0, 140)}...`);
  }
  if (cfg.action === 'post_promote' && REQUIRE_APPROVAL && !preapprovedText) {
    const dir = join(process.cwd(), 'recordings', label);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'pending_review.json'), JSON.stringify({
      account_id: acct.id, username: acct.username, action: label,
      surface_label: typeof cfg.surfaceLabel === 'function' ? cfg.surfaceLabel(acct, feed) : cfg.surfaceLabel,
      product: product ? { name: product.name } : null,
      variant: (process.env.VARIANT || character?.promotion_config?.variant || 'mention').toLowerCase(),
      post_text: text, ts: new Date().toISOString(),
    }, null, 2));
    console.log('PASS: pending_review (approval required, not posted)');
    return 'pending_review';
  }
  if (typeof cfg.submitPost !== 'function') throw new Error(`cfg.submitPost not provided for ${cfg.platform} ${cfg.action}`);
  await cfg.submitPost(s, text);
  return 'posted';
}

export async function handleComment(s, cfg, ctx) {
  const { acct, character, product, preapprovedText, label, feed, targetedMode } = ctx;
  const surfaceLabel = typeof cfg.surfaceLabel === 'function' ? cfg.surfaceLabel(acct, feed) : (cfg.surfaceLabel ?? feed);
  const picked = await (cfg.pickPost?.(s).catch((e) => { console.log(`[${label}] pickPost failed: ${e.message?.slice(0, 80)}`); return { postTitle: '', postBody: '' }; }) ?? Promise.resolve({ postTitle: '', postBody: '' }));
  const postTitle = picked.postTitle || `post on ${typeof surfaceLabel === 'function' ? surfaceLabel(acct, feed) : (surfaceLabel || cfg.platform)}`;
  const postBody = picked.postBody || '';
  let text = preapprovedText;
  if (!text) {
    text = await genComment({ character, product, variant: (process.env.VARIANT || character?.promotion_config?.variant || 'mention').toLowerCase(), surfaceLabel, postTitle, postBody });
    console.log(`[comment-text] ${text.slice(0, 140)}...`);
  } else {
    console.log(`[preapproved] using operator-reviewed text (${text.length} chars)`);
  }
  if (cfg.action === 'promote' && REQUIRE_APPROVAL && !preapprovedText) {
    const dir = join(process.cwd(), 'recordings', label);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'pending_review.json'), JSON.stringify({
      account_id: acct.id, username: acct.username, action: label,
      post_url: targetedMode ? feed : null, surface_label: surfaceLabel,
      post_title: postTitle, post_body: (postBody || '').slice(0, 600),
      character: character ? { name: character.name, niche: character.niche } : null,
      product: product ? { name: product.name } : null,
      variant: (process.env.VARIANT || character?.promotion_config?.variant || 'mention').toLowerCase(),
      comment_text: text, ts: new Date().toISOString(),
    }, null, 2));
    console.log('PASS: pending_review (approval required, not submitted)');
    return 'pending_review';
  }
  const submitter = targetedMode && typeof cfg.submitTargetedComment === 'function' ? cfg.submitTargetedComment : cfg.submitComment;
  if (typeof submitter !== 'function') throw new Error(`cfg.submitComment not provided for ${cfg.platform} ${cfg.action}`);
  await submitter(s, text);
  return 'commented';
}
