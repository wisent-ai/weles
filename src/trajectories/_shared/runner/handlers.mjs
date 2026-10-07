// Per-action dispatchers receive the prepared session and context and return
// resultValue. Mutations stay on the session; no other state is shared across
// actions.

import {
  generateOrganicComment,
  generatePromoteComment,
  generatePost,
} from '../content/llm.mjs';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  humanIdlePause,
  humanScrollPage,
} from '../../../../dist/human/mouse.js';
import { runRecordingsDir } from '../../../../dist/session/run-recordings.js';

const REQUIRE_APPROVAL = process.env.REQUIRE_PROMOTE_APPROVAL !== '0';

async function genComment({
  character,
  product,
  variant,
  surfaceLabel,
  postTitle,
  postBody,
}) {
  const persona = {
    name: character.name,
    bio: character.bio,
    personality: character.personality,
    niche: character.niche,
  };
  const post = { surface: surfaceLabel, title: postTitle, body: postBody };
  if (product)
    return generatePromoteComment({
      persona,
      post,
      product: {
        name: product.name,
        description: product.description,
        variant,
      },
    });
  return generateOrganicComment({ persona, post });
}

// cfg.scrolls and cfg.dwellMs are the declared observation's: how many
// viewports are read and the idle read time after each, in milliseconds.
// Every browse trajectory passes its declaration's values; a caller without
// one is refused rather than given a count nobody declared.
export async function handleBrowse(s, cfg) {
  const scrolls = cfg.scrolls;
  if (
    !Number.isSafeInteger(scrolls) ||
    Math.sign(scrolls) === -Math.sign(Number.MAX_VALUE)
  ) {
    throw new Error(
      `browse needs the declared observation's scroll count, got ${JSON.stringify(scrolls ?? null)}`,
    );
  }
  for (let i = 0; i < scrolls; i++) {
    await humanScrollPage(s.page, 'down');
    await humanIdlePause(cfg.dwellMs ?? 'deliberate');
  }
  return `scrolled ${scrolls}x`;
}

export async function handlePost(s, cfg, ctx) {
  const { acct, character, product, preapprovedText, label, feed } = ctx;
  let text = preapprovedText;
  if (!text) {
    if (!character)
      throw new Error(
        'no character — cannot LLM-generate post without persona',
      );
    const personaCtx = {
      name: character.name,
      bio: character.bio,
      personality: character.personality,
      niche: character.niche,
    };
    text = await generatePost({
      persona: personaCtx,
      surface: cfg.platform,
      product: product ?? undefined,
    });
    console.log(`[post-text] ${text}...`);
  }
  if (cfg.action === 'post_promote' && REQUIRE_APPROVAL && !preapprovedText) {
    const dir = runRecordingsDir(label);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'pending_review.json'),
      JSON.stringify(
        {
          account_id: acct.id,
          username: acct.username,
          action: label,
          surface_label:
            typeof cfg.surfaceLabel === 'function'
              ? cfg.surfaceLabel(acct, feed)
              : cfg.surfaceLabel,
          product: product ? { name: product.name } : null,
          variant: (
            process.env.VARIANT ||
            character?.promotion_config?.variant ||
            'mention'
          ).toLowerCase(),
          post_text: text,
          ts: new Date().toISOString(),
        },
        null,
        2,
      ),
    );
    console.log('PASS: pending_review (approval required, not posted)');
    return 'pending_review';
  }
  if (typeof cfg.submitPost !== 'function')
    throw new Error(
      `cfg.submitPost not provided for ${cfg.platform} ${cfg.action}`,
    );
  await cfg.submitPost(s, text);
  return 'posted';
}

export async function handleComment(s, cfg, ctx) {
  const {
    acct,
    character,
    product,
    preapprovedText,
    label,
    feed,
    targetedMode,
  } = ctx;
  const surfaceLabel =
    typeof cfg.surfaceLabel === 'function'
      ? cfg.surfaceLabel(acct, feed)
      : (cfg.surfaceLabel ?? feed);
  const picked = await (cfg.pickPost?.(s).catch((e) => {
    console.log(`[${label}] pickPost failed: ${e.message}`);
    return { postTitle: '', postBody: '' };
  }) ?? Promise.resolve({ postTitle: '', postBody: '' }));
  const postTitle =
    picked.postTitle ||
    `post on ${typeof surfaceLabel === 'function' ? surfaceLabel(acct, feed) : surfaceLabel || cfg.platform}`;
  const postBody = picked.postBody || '';
  let text = preapprovedText;
  if (!text) {
    text = await genComment({
      character,
      product,
      variant: (
        process.env.VARIANT ||
        character?.promotion_config?.variant ||
        'mention'
      ).toLowerCase(),
      surfaceLabel,
      postTitle,
      postBody,
    });
    console.log(`[comment-text] ${text}...`);
  } else {
    console.log(
      `[preapproved] using operator-reviewed text (${text.length} chars)`,
    );
  }
  if (cfg.action === 'promote' && REQUIRE_APPROVAL && !preapprovedText) {
    const dir = runRecordingsDir(label);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'pending_review.json'),
      JSON.stringify(
        {
          account_id: acct.id,
          username: acct.username,
          action: label,
          post_url: targetedMode ? feed : null,
          surface_label: surfaceLabel,
          post_title: postTitle,
          post_body: postBody || '',
          character: character
            ? { name: character.name, niche: character.niche }
            : null,
          product: product ? { name: product.name } : null,
          variant: (
            process.env.VARIANT ||
            character?.promotion_config?.variant ||
            'mention'
          ).toLowerCase(),
          comment_text: text,
          ts: new Date().toISOString(),
        },
        null,
        2,
      ),
    );
    console.log('PASS: pending_review (approval required, not submitted)');
    return 'pending_review';
  }
  const submitter =
    targetedMode && typeof cfg.submitTargetedComment === 'function'
      ? cfg.submitTargetedComment
      : cfg.submitComment;
  if (typeof submitter !== 'function')
    throw new Error(
      `cfg.submitComment not provided for ${cfg.platform} ${cfg.action}`,
    );
  await submitter(s, text);
  return 'commented';
}
