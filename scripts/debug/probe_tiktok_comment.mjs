import { getSocialAccount, resolveAccountSession } from '../../dist/utils/credentials.js';
import { WSession } from '../../dist/session/wsession.js';
import { humanClickLocator, humanIdlePause } from '../../dist/human/mouse.js';

const acct = await getSocialAccount('tiktok');
if (!acct) { console.log('FAIL: no account'); process.exit(1); }
const { proxyUrl, persona } = await resolveAccountSession(acct);
const s = await WSession.start({ label: 'probe_comment', proxy: proxyUrl, persona });

const stored = (acct.metadata?.cookies ?? []).filter(c => /tiktok\.com/.test(c.domain ?? ''));
await s.ctx.addCookies(stored.map(c => ({ ...c, path: c.path || '/' })));

await s.goto('https://www.tiktok.com/@tiktok');
await humanIdlePause('long');

// Find first video link
const firstVideo = s.page.locator('a[href*="/video/"]').first();
await firstVideo.waitFor({ state: 'visible', timeout: 30000 });
const href = await firstVideo.getAttribute('href');
console.log(`[probe] first video: ${href}`);

// Click it via humanClickLocator (same as tiktok_like)
await humanClickLocator(s.page, firstVideo);
await s.page.waitForURL(/\/video\/\d+/, { timeout: 15000 }).catch(() => {
  console.log('[probe] URL did not change — TikTok may have opened video as overlay');
});
await humanIdlePause('long');

// Probe the comment icon
const commentIconInfo = await s.page.evaluate(() => {
  const icons = Array.from(document.querySelectorAll('[data-e2e*="comment"]')).map(el => ({
    e2e: el.getAttribute('data-e2e'),
    tag: el.tagName,
    text: (el.textContent || '').trim().slice(0, 40),
    visible: el.offsetParent !== null && el.getBoundingClientRect().width > 0,
  }));
  return icons;
}).catch(() => []);
console.log(`[probe] comment e2e elements: ${JSON.stringify(commentIconInfo)}`);

// Click the comment icon via humanClickLocator
const commentIcon = s.page.locator('[data-e2e="comment-icon"], [data-e2e="browse-comment-icon"]').filter({ visible: true }).first();
if (await commentIcon.count()) {
  await humanClickLocator(s.page, commentIcon);
  await humanIdlePause('deliberate');
} else {
  console.log('[probe] no comment icon found');
}

// Probe comment input after clicking comment icon
const commentInputInfo = await s.page.evaluate(() => {
  const inputs = Array.from(document.querySelectorAll('[data-e2e*="comment-input"], [data-e2e*="comment-post"], div[contenteditable="true"], div[role="textbox"], div.DraftEditor-editorContainer')).map(el => ({
    e2e: el.getAttribute('data-e2e'),
    tag: el.tagName,
    cls: (el.className || '').toString().slice(0, 80),
    role: el.getAttribute('role'),
    contentEditable: el.getAttribute('contenteditable'),
    placeholder: el.getAttribute('placeholder'),
    ariaLabel: el.getAttribute('aria-label'),
    visible: el.offsetParent !== null && el.getBoundingClientRect().width > 0,
    rect: { w: Math.round(el.getBoundingClientRect().width), h: Math.round(el.getBoundingClientRect().height) },
  }));
  // Also check for any comment-related elements
  const allCommentEls = Array.from(document.querySelectorAll('[data-e2e]')).filter(el => /comment/i.test(el.getAttribute('data-e2e') || '')).map(el => ({
    e2e: el.getAttribute('data-e2e'),
    tag: el.tagName,
    visible: el.offsetParent !== null && el.getBoundingClientRect().width > 0,
  }));
  // Check for textarea elements too
  const textareas = Array.from(document.querySelectorAll('textarea')).map(el => ({
    name: el.name, placeholder: el.placeholder, cls: (el.className || '').toString().slice(0, 60),
    visible: el.offsetParent !== null && el.getBoundingClientRect().width > 0,
  }));
  // Check for any input[type="text"] elements
  const textInputs = Array.from(document.querySelectorAll('input[type="text"]')).map(el => ({
    name: el.name, placeholder: el.placeholder, cls: (el.className || '').toString().slice(0, 60),
    visible: el.offsetParent !== null && el.getBoundingClientRect().width > 0,
  }));
  // Scroll the comment panel to the bottom and re-check
  const commentPanel = document.querySelector('[data-e2e="search-comment-container"]');
  if (commentPanel) {
    commentPanel.scrollTop = commentPanel.scrollHeight;
  }
  return { inputs, allCommentEls, textareas, textInputs };
}).catch(() => ({ inputs: [], allCommentEls: [], textareas: [], textInputs: [] }));
console.log(`[probe] comment input info: ${JSON.stringify(commentInputInfo)}`);

// Wait and re-probe after scroll
await humanIdlePause('deliberate');
const reprobe = await s.page.evaluate(() => {
  const inputs = Array.from(document.querySelectorAll('[data-e2e*="comment-input"], [data-e2e*="comment-post"], div[contenteditable="true"], div[role="textbox"], div.DraftEditor-editorContainer, textarea, input[type="text"]')).map(el => ({
    e2e: el.getAttribute('data-e2e'),
    tag: el.tagName,
    role: el.getAttribute('role'),
    contentEditable: el.getAttribute('contenteditable'),
    placeholder: el.getAttribute('placeholder'),
    ariaLabel: el.getAttribute('aria-label'),
    visible: el.offsetParent !== null && el.getBoundingClientRect().width > 0,
    rect: { x: Math.round(el.getBoundingClientRect().x), y: Math.round(el.getBoundingClientRect().y), w: Math.round(el.getBoundingClientRect().width), h: Math.round(el.getBoundingClientRect().height) },
  }));
  // Also check the entire bottom of the comment panel for any interactive elements
  const commentPanel = document.querySelector('[data-e2e="search-comment-container"]');
  let bottomEls = [];
  if (commentPanel) {
    const panelRect = commentPanel.getBoundingClientRect();
    const bottomY = panelRect.y + panelRect.height - 150;
    bottomEls = Array.from(commentPanel.querySelectorAll('*')).filter(el => {
      const r = el.getBoundingClientRect();
      return r.y > bottomY && r.width > 20 && r.height > 20 && el.offsetParent !== null;
    }).slice(0, 20).map(el => ({
      tag: el.tagName, e2e: el.getAttribute('data-e2e'), cls: (el.className || '').toString().slice(0, 60),
      role: el.getAttribute('role'), contentEditable: el.getAttribute('contenteditable'),
      text: (el.textContent || '').trim().slice(0, 30),
    }));
  }
  return { inputs, bottomEls };
}).catch(() => ({ inputs: [], bottomEls: [] }));
console.log(`[probe] reprobe after scroll: ${JSON.stringify(reprobe)}`);

await s.screenshot('comment_probe').catch(() => {});
await s.close();
