/**
 * New-reddit (www.reddit.com) comment submission atoms.
 * SPA transition, media engagement, hovercard dwell, composer submit.
 * All interactions use human atoms. Zero raw page.mouse.click,
 * zero page.evaluate(fetch), zero dispatchEvent.
 */
import { humanClick, humanClickLocator, humanHoverDwell, humanScroll, humanIdlePause, humanMove } from '../../../../dist/human/mouse.js';
import { humanType } from '../../../../dist/human/keyboard.js';
import { findComposerPart } from './comment_composer.mjs';

export { findComposerPart };

/** Navigate from feed to post via SPA click (preserves JS state). */
export async function spaTransitionToPost(page, postUrlWww) {
  const currentUrl = page.url();
  const postId = postUrlWww.split('/comments/')[1]?.split('/')[0] || '';
  if (currentUrl.includes('/comments/') && currentUrl.includes(postId)) {
    console.log(`[comment] already on target post page`);
    return;
  }
  const href = postUrlWww.replace('https://www.reddit.com', '');
  const postLink = page.locator(`a[href*="${href}"]`).filter({ visible: true }).first();
  if (await postLink.count()) {
    console.log(`[comment] clicking post link from feed (SPA transition)`);
    await humanClickLocator(page, postLink);
    await page.waitForTimeout(3000 + Math.floor(Math.random() * 2000));
    console.log(`[comment] SPA click done — url=${page.url().slice(0, 80)}`);
    return;
  }
  console.log(`[comment] post link not visible — scrolling feed`);
  await humanScroll(page, 800 + Math.floor(Math.random() * 600), 2).catch(() => {});
  await page.waitForTimeout(2000);
  const postLink2 = page.locator(`a[href*="${href}"]`).filter({ visible: true }).first();
  if (await postLink2.count()) {
    await humanClickLocator(page, postLink2);
    await page.waitForTimeout(3000 + Math.floor(Math.random() * 2000));
    return;
  }
  console.log(`[comment] post not in feed — falling back to goto (cold load)`);
  await page.goto(postUrlWww, { waitUntil: 'domcontentloaded' });
}

/** Click play on media posts and dwell 5-10s. */
export async function engageMedia(page) {
  console.log(`[comment] media post — engaging with content`);
  const playBtn = page.locator('button[aria-label="Play"], shreddit-player button, .play-button, button[data-click-id="play"]').first();
  if (await playBtn.count().catch(() => 0)) {
    await humanClickLocator(page, playBtn).catch(() => {});
  }
  await page.waitForTimeout(5000 + Math.floor(Math.random() * 5000));
}

/** Dwell on post page: 15-25s boot + 2x username hover + scroll. */
export async function dwellOnPostPage(page) {
  await humanIdlePause('deliberate');
  await page.waitForTimeout(15000 + Math.floor(Math.random() * 10000));
  const hovered1 = await humanHoverDwell(
    page,
    page.locator('a[href^="/user/"]').filter({ visible: true }).first(),
    { minMs: 3500, maxMs: 6500 },
  ).catch(() => false);
  console.log(`[hover] post-author dwell ${hovered1 ? 'fired' : 'skipped'}`);
  await humanScroll(page, 800 + Math.floor(Math.random() * 600), 3).catch(() => {});
  await page.waitForTimeout(3000 + Math.floor(Math.random() * 2000));
  try {
    const userLinks = await page.locator('a[href^="/user/"]').filter({ visible: true }).all().catch(() => []);
    if (userLinks.length > 1) {
      const hovered2 = await humanHoverDwell(page, userLinks[1], { minMs: 2500, maxMs: 4500 }).catch(() => false);
      console.log(`[hover] commenter dwell ${hovered2 ? 'fired' : 'skipped'}`);
    }
  } catch {}
  await page.waitForTimeout(3000 + Math.floor(Math.random() * 2000));
}

/**
 * Expand shreddit-composer, type comment, click submit.
 * Returns created-comment metadata or null.
 */
export async function submitNewRedditComment(page, commentBody, capturedResponses, extractCommentFn) {
  const composerLocator = page.locator('shreddit-composer').first();
  await composerLocator.scrollIntoViewIfNeeded().catch(() => {});
  await humanIdlePause('short');
  const viewportH = await page.evaluate(() => window.innerHeight).catch(() => 1440);

  let editable = null;
  for (let i = 0; i < 6; i++) {
    editable = await page.evaluate(findComposerPart, 'editable').catch(() => null);
    if (editable && editable.y >= 0 && editable.y <= viewportH) break;
    editable = null;
    const placeholder = await page.evaluate(findComposerPart, 'placeholder').catch(() => null);
    if (placeholder && placeholder.y >= 0 && placeholder.y <= viewportH) {
      console.log(`[diag] clicking placeholder at (${placeholder.x}, ${placeholder.y})`);
      await humanClick(page, placeholder.x, placeholder.y);
      await page.waitForTimeout(1500);
      const expanded = await page.evaluate(findComposerPart, 'editable').catch(() => null);
      if (expanded && expanded.y >= 0 && expanded.y <= viewportH) {
        editable = expanded;
        console.log(`[comment] composer expanded → editable: ${JSON.stringify(editable)}`);
        break;
      }
      editable = placeholder;
      console.log(`[comment] composer didn't expose editable; using placeholder`);
      break;
    }
    await humanIdlePause('deliberate');
  }
  console.log(`[comment] new-reddit editable probe: ${JSON.stringify(editable)}`);
  if (!editable) throw new Error('new-reddit composer editable not found');

  // Focus the RTE editable before typing. Without this, humanType keystrokes
  // land on whatever activeElement is, which after a placeholder click is the
  // <faceplate-textarea-input> wrapper, not the RTE <div contenteditable=true>.
  // Result: RTE input listener never fires → no EvaluateCommentAutomationsByPostId,
  // no recaptchaToken in submit body, comment auto-removed within a minute.
  // Verified by diff harness: A handoff fired EvalCommentAutomations on each
  // keystroke (commentBody:"that" at t=11565ms); B trajectory fired 0.
  await humanClick(page, editable.x, editable.y);
  await page.waitForTimeout(400 + Math.floor(Math.random() * 300));
  console.log(`[diag] before humanType len=${commentBody.length}`);
  await humanType(page, commentBody);
  console.log(`[diag] after humanType — url=${page.url()} closed=${page.isClosed()}`);

  const bodyLanded = await page.evaluate((needle) => {
    const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
    const want = norm(needle).slice(0, 50);
    if (!want) return false;
    if (norm(document.body.innerText).includes(want)) return true;
    for (const sc of document.querySelectorAll('shreddit-composer')) {
      const root = sc.shadowRoot ?? sc;
      const queue = [root];
      while (queue.length) {
        const n = queue.shift();
        if (!n) continue;
        if (n.nodeType === Node.ELEMENT_NODE) {
          if (norm(n.textContent).includes(want)) return true;
          if (typeof n.value === 'string' && norm(n.value).includes(want)) return true;
          if (n.shadowRoot) queue.push(n.shadowRoot);
          if (n.children) queue.push(...n.children);
        }
      }
    }
    return false;
  }, commentBody).catch(() => false);
  console.log(`[diag] body-landed-in-dom=${bodyLanded}`);

  await humanIdlePause('short');
  await humanMove(page, editable.x + Math.floor(Math.random() * 40), editable.y + Math.floor(Math.random() * 20));
  console.log(`[diag] after jitter — about to probe submit`);

  let submit = null;
  for (let i = 0; i < 8; i++) {
    submit = await page.evaluate(findComposerPart, 'submit').catch(() => null);
    if (submit) break;
    await page.waitForTimeout(750);
  }
  console.log(`[comment] new-reddit submit probe: ${JSON.stringify(submit)}`);
  if (!submit) throw new Error('new-reddit composer submit button not found');

  await humanClick(page, submit.x, submit.y);
  console.log('[comment] submitted via new-reddit shreddit-composer submit button');

  let createdComment = null;
  for (let i = 0; i < 12; i++) {
    await page.waitForTimeout(1000);
    if (capturedResponses && extractCommentFn) {
      const fromResponse = [...capturedResponses]
        .reverse()
        .filter(r => r.status >= 200 && r.status < 300 && /\/svc\/shreddit\/t3_[a-z0-9]+\/create-comment/i.test(r.url))
        .map(r => extractCommentFn(r.body, commentBody))
        .find(Boolean);
      if (fromResponse) { createdComment = fromResponse; break; }
    }
    const fromDom = await page.evaluate((body) => {
      const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
      const needle = norm(body).slice(0, 80);
      for (const el of document.querySelectorAll('shreddit-comment')) {
        if (needle && !norm(el.textContent).includes(needle)) continue;
        const permalink = el.getAttribute('permalink') || '';
        const thingId = el.getAttribute('thingid') || el.getAttribute('thingId') || '';
        const id = (thingId.match(/^t1_([a-z0-9]+)$/i) || [])[1] || '';
        const linkId = (permalink.match(/\/comments\/([a-z0-9]+)\//i) || [])[1] || '';
        if (permalink || id) return { permalink, id, linkId };
      }
      return null;
    }, commentBody).catch(() => null);
    if (fromDom) { createdComment = fromDom; break; }
  }
  console.log(`[comment] new-reddit created-comment probe: ${JSON.stringify(createdComment)}`);
  return createdComment;
}

/** Verify comment visibility across Reddit's visibility planes. */
export async function verifyCommentVisibility(page, { realHandle, commentBody, commentPermalink, proxyConfig }) {
  let inUserListing = false;
  let inPostThread = false;
  let publicAboutStatus = 0;
  let inAuthListing = false;

  if (!realHandle) return { inUserListing, inPostThread, publicAboutStatus, inAuthListing, verdict: 'no_handle' };

  // User listing
  for (let i = 0; i < 12; i++) {
    await new Promise(r => setTimeout(r, 5000));
    const resp = await page.context().request.get(
      `https://old.reddit.com/user/${encodeURIComponent(realHandle)}/comments/.json?limit=15&sort=new`,
      { headers: { 'Accept': 'application/json' }, ignoreHTTPSErrors: true, timeout: 15000 },
    ).catch(() => null);
    if (!resp) continue;
    const txt = await resp.text();
    if (!txt.includes(commentBody)) continue;
    try {
      const j = JSON.parse(txt);
      const child = (j?.data?.children ?? []).find(c => typeof c?.data?.body === 'string' && c.data.body.includes(commentBody));
      if (child) { inUserListing = true; break; }
    } catch {}
  }

  // About status
  const aboutResp = await page.context().request.get(
    `https://old.reddit.com/user/${encodeURIComponent(realHandle)}/about.json`,
    { headers: { 'Accept': 'application/json' }, ignoreHTTPSErrors: true, timeout: 15000 },
  ).catch(() => null);
  publicAboutStatus = aboutResp ? aboutResp.status() : 0;

  // Auth listing
  try {
    const authResp = await page.context().request.get(
      `https://www.reddit.com/user/${encodeURIComponent(realHandle)}/comments/.json?limit=15&sort=new`,
      { headers: { 'Accept': 'application/json' }, ignoreHTTPSErrors: true, timeout: 15000 },
    ).catch(() => null);
    if (authResp) {
      const authData = await authResp.json().catch(() => null);
      inAuthListing = (authData?.data?.children ?? []).some(c => typeof c?.data?.body === 'string' && c.data.body.includes(commentBody));
    }
  } catch {}

  // Unauth post-thread probe
  if (commentPermalink) {
    await new Promise(r => setTimeout(r, 8000));
    const { request: pwRequest } = await import('playwright');
    const unauthCtx = await pwRequest.newContext({
      extraHTTPHeaders: { Accept: 'application/json' },
      ignoreHTTPSErrors: true,
      ...(proxyConfig?.server && { proxy: { server: proxyConfig.server, username: proxyConfig.username, password: proxyConfig.password } }),
    });
    const permaResp = await unauthCtx.get(
      `https://www.reddit.com${commentPermalink.replace(/\/$/, '')}.json`,
      { timeout: 15000 },
    ).catch(() => null);
    if (permaResp) {
      try {
        const j = JSON.parse(await permaResp.text());
        const tree = Array.isArray(j) ? j[1] : null;
        const collect = (children) => {
          const acc = [];
          for (const c of (children || [])) {
            if (c?.data?.body && c.data.body.includes(commentBody)) acc.push(c.data);
            if (c?.data?.replies?.data?.children) acc.push(...collect(c.data.replies.data.children));
          }
          return acc;
        };
        inPostThread = collect(tree?.data?.children).length > 0;
      } catch {}
    }
    await unauthCtx.dispose().catch(() => {});
  }

  let verdict;
  const accepted = inUserListing || inAuthListing;
  if (publicAboutStatus === 404) verdict = 'shadowbanned';
  else if (inPostThread && accepted) verdict = 'PASS';
  else if (accepted && !inPostThread) verdict = 'shadow_removed';
  else if (inAuthListing && !inUserListing) verdict = 'rate_limited_or_filtered';
  else verdict = 'rejected';

  return { inUserListing, inPostThread, publicAboutStatus, inAuthListing, verdict };
}

/** Post-submit browsing: dwell on subreddit for 2-3 min to avoid delayed shadow-removal. */
export async function postSubmitBrowse(page) {
  console.log(`[post-submit] browsing subreddit for 2-3 min before close`);
  await humanIdlePause('deliberate');
  await humanScroll(page, 600 + Math.floor(Math.random() * 400), 2).catch(() => {});
  await page.waitForTimeout(8000 + Math.floor(Math.random() * 4000));
  const postLinks = await page.locator('a[data-click-id="body"], a[href*="/comments/"]').filter({ visible: true }).all().catch(() => []);
  if (postLinks.length > 1) {
    const idx = 1 + Math.floor(Math.random() * Math.min(postLinks.length - 1, 4));
    console.log(`[post-submit] clicking another post (#${idx})`);
    await humanClickLocator(page, postLinks[idx]).catch(() => {});
    await page.waitForTimeout(10000 + Math.floor(Math.random() * 8000));
    await humanScroll(page, 400 + Math.floor(Math.random() * 600), 3).catch(() => {});
    await page.waitForTimeout(15000 + Math.floor(Math.random() * 10000));
    const authorLink = page.locator('a[href^="/user/"]').filter({ visible: true }).first();
    await humanHoverDwell(page, authorLink, { minMs: 2500, maxMs: 4500 }).catch(() => false);
    await page.waitForTimeout(5000 + Math.floor(Math.random() * 5000));
    await humanScroll(page, 300 + Math.floor(Math.random() * 400), 2).catch(() => {});
  }
  await page.waitForTimeout(20000 + Math.floor(Math.random() * 15000));
  console.log(`[post-submit] browse phase done`);
}
